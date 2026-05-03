import {log as defaultLog, type Logger} from "../log.js";

/// MetricsAggregator (plan §4.6 / M3.9).
///
/// Pulls submit→confirm events from the relayer pool, tracks them in two ring buffers
/// (timestamps for rate computation, latencies for percentile computation), and exposes a
/// `snapshot()` that the IPC layer joins with instantaneous gauges from the rest of the
/// subsystems (batcher queue depth, funder drops, relayer-pool busy count, …) to render the
/// `chain.throughput` surface.
///
/// Why ring buffers, not exact counters: rates over the last 60 s require us to forget old
/// events; percentiles require the raw distribution, not a running average. Both want
/// bounded memory. A single-pass scan over the buffer at snapshot time keeps the hot-path
/// `record*` methods O(1) and the slow-path `snapshot()` O(buffer size) — fine because the
/// IPC caller is rctctl (~1 Hz) or the in-game treasury window (~2 Hz).
///
/// Latency model: `result.latencyMs` from the relayer's submit covers the *chain* part
/// (sign → eth_sendRawTransactionSync → receipt). The batcher already stamps a queueing
/// latency on each Batch via `flushedAt − firstAcceptedAt`, so end-to-end latency for a
/// guest spend is approximately `(flushedAt − firstAcceptedAt) + result.latencyMs`. We
/// surface the chain-part percentile here because it's the metric the demo wants to brag
/// about ("Monad confirmed 5000 sigs in 1.2s"); the queueing latency is recoverable from
/// `chain.batch.status.lastFlushLatencyMs` when needed.

export interface MetricsRecorder {
    recordTxSuccess(authCount: number, latencyMs: number): void;
    recordTxFailure(): void;
    recordDroppedAuths(n: number): void;
}

export interface MetricsAggregatorOptions {
    /// Window for rate computation. Default 60 s — long enough that brief flushes don't drop
    /// to zero, short enough that a real slowdown shows up immediately. Latency percentiles
    /// use the same window.
    windowMs?: number;
    /// Cap on samples retained in the latency ring buffer. Bigger = more accurate p99 at the
    /// cost of memory; default 4096 covers 60 s × ~70 tx/s with headroom.
    maxLatencySamples?: number;
    log?: Logger;
    now?: () => number;
}

export const DEFAULT_METRICS_WINDOW_MS = 60_000;
export const DEFAULT_MAX_LATENCY_SAMPLES = 4096;

/// What the aggregator returns. Joined with subsystem gauges in the IPC handler — keep this
/// shape primitive-only (numbers + nulls) so the JSON-RPC layer doesn't trip on bigints.
export interface ThroughputSnapshot {
    /// Wall-clock time of the snapshot (ms since epoch). Useful for the in-game treasury
    /// window to detect a stale sidecar.
    now: number;
    windowMs: number;
    /// Submission throughput.
    txPerSecond: number;
    authPerSecond: number;
    /// Successful tx count over the window.
    txInWindow: number;
    /// Successful auth count over the window.
    authInWindow: number;
    /// Latency percentiles (chain-part only, ms). `null` when no samples are in the window —
    /// callers should render that as "—" rather than 0 so the absence is honest.
    latencyMs: {p50: number | null; p95: number | null; p99: number | null};
    /// Batch fill stats over the window.
    batchFill: {avg: number | null; max: number | null};
    /// Lifetime counters since process start. Useful for "did the demo just produce 1 M
    /// auths in 30 minutes" without integrating windowed rates.
    totalTxSubmitted: number;
    totalAuthSubmitted: number;
    totalTxFailed: number;
    totalDroppedAuths: number;
}

interface TxSample {
    at: number;
    authCount: number;
    latencyMs: number;
}

export class MetricsAggregator implements MetricsRecorder {
    readonly #log: Logger;
    readonly #now: () => number;
    readonly #windowMs: number;
    readonly #maxSamples: number;

    /// Ring-buffer of recent successful submissions. Bounded by both `windowMs` (ages out
    /// during snapshot) and `maxSamples` (oldest dropped on push).
    readonly #samples: TxSample[] = [];
    /// Lifetime totals. Never reset; kept as primitive numbers so JSON-RPC is happy.
    #totalTxSubmitted = 0;
    #totalAuthSubmitted = 0;
    #totalTxFailed = 0;
    #totalDroppedAuths = 0;

    constructor(opts: MetricsAggregatorOptions = {}) {
        const windowMs = opts.windowMs ?? DEFAULT_METRICS_WINDOW_MS;
        const maxSamples = opts.maxLatencySamples ?? DEFAULT_MAX_LATENCY_SAMPLES;
        if (!Number.isInteger(windowMs) || windowMs < 1_000 || windowMs > 3_600_000) {
            throw new Error(`MetricsAggregator.windowMs must be an integer in [1000, 3600000], got ${windowMs}`);
        }
        if (!Number.isInteger(maxSamples) || maxSamples < 16 || maxSamples > 1_000_000) {
            throw new Error(
                `MetricsAggregator.maxLatencySamples must be an integer in [16, 1000000], got ${maxSamples}`,
            );
        }
        this.#log = (opts.log ?? defaultLog).child({mod: "metrics"});
        this.#now = opts.now ?? Date.now;
        this.#windowMs = windowMs;
        this.#maxSamples = maxSamples;
    }

    /// Hot-path: O(1) push + amortised O(1) trim. Called by the relayer pool after each
    /// successful settle. Negative or non-finite inputs are ignored — never poison the
    /// buffer with NaNs that a downstream sort would propagate.
    recordTxSuccess(authCount: number, latencyMs: number): void {
        if (!Number.isFinite(authCount) || authCount < 0) {
            this.#log.warn({authCount}, "metrics.recordTxSuccess: ignoring non-finite/negative authCount");
            return;
        }
        if (!Number.isFinite(latencyMs) || latencyMs < 0) {
            this.#log.warn({latencyMs}, "metrics.recordTxSuccess: ignoring non-finite/negative latencyMs");
            return;
        }
        this.#samples.push({at: this.#now(), authCount, latencyMs});
        // Cap on samples — drop oldest. We do this independent of windowMs so an explosion
        // of submissions doesn't blow up memory before the next snapshot trims by age.
        while (this.#samples.length > this.#maxSamples) this.#samples.shift();
        this.#totalTxSubmitted++;
        this.#totalAuthSubmitted += authCount;
    }

    recordTxFailure(): void {
        this.#totalTxFailed++;
    }

    recordDroppedAuths(n: number): void {
        if (!Number.isFinite(n) || n < 0) return;
        this.#totalDroppedAuths += n;
    }

    /// Compute the snapshot. Trims any sample older than `windowMs` first so subsequent
    /// percentile / rate math works on the live window only. Returns deterministic shape —
    /// `null` is used for "no samples", never `0`, so callers can distinguish "quiet" from
    /// "stalled".
    snapshot(): ThroughputSnapshot {
        const now = this.#now();
        const cutoff = now - this.#windowMs;
        // Trim old samples in place (cheap shift loop — JS arrays are amortised O(1) on
        // shift for small leading-removal patterns; far cheaper than rebuilding).
        while (this.#samples.length > 0 && this.#samples[0]!.at < cutoff) this.#samples.shift();

        const inWindow = this.#samples;
        const txInWindow = inWindow.length;
        let authInWindow = 0;
        let maxFill = 0;
        for (const s of inWindow) {
            authInWindow += s.authCount;
            if (s.authCount > maxFill) maxFill = s.authCount;
        }
        const windowSeconds = this.#windowMs / 1000;
        const txPerSecond = txInWindow / windowSeconds;
        const authPerSecond = authInWindow / windowSeconds;
        const avgFill = txInWindow === 0 ? null : authInWindow / txInWindow;
        const maxFillReturn = txInWindow === 0 ? null : maxFill;

        const latencyMs = computePercentiles(inWindow);

        return {
            now,
            windowMs: this.#windowMs,
            txPerSecond,
            authPerSecond,
            txInWindow,
            authInWindow,
            latencyMs,
            batchFill: {avg: avgFill, max: maxFillReturn},
            totalTxSubmitted: this.#totalTxSubmitted,
            totalAuthSubmitted: this.#totalAuthSubmitted,
            totalTxFailed: this.#totalTxFailed,
            totalDroppedAuths: this.#totalDroppedAuths,
        };
    }

    /// Sample count currently in the buffer (post-trim during snapshot). Useful for tests.
    sampleCount(): number {
        return this.#samples.length;
    }
}

/// Empty-window-safe percentile compute. Returns nulls when no samples to avoid lying about
/// a 0ms latency. Sort is O(n log n); n is bounded by `maxLatencySamples` so this is fine
/// at the IPC cadences we serve.
function computePercentiles(samples: readonly TxSample[]): {
    p50: number | null;
    p95: number | null;
    p99: number | null;
} {
    if (samples.length === 0) return {p50: null, p95: null, p99: null};
    const sorted = samples.map((s) => s.latencyMs).sort((a, b) => a - b);
    return {
        p50: percentile(sorted, 0.5),
        p95: percentile(sorted, 0.95),
        p99: percentile(sorted, 0.99),
    };
}

/// Nearest-rank percentile on a pre-sorted ascending array. `q ∈ (0, 1]`.
function percentile(sorted: readonly number[], q: number): number {
    const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil(q * sorted.length) - 1));
    return sorted[idx]!;
}
