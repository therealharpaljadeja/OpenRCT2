import type {HDAccount} from "viem/accounts";
import type {Batch, BatchSink, SinkResult} from "../batcher/index.js";
import type {DerivedAccount} from "../derive/index.js";
import {log as defaultLog, type Logger} from "../log.js";
import type {MetricsRecorder} from "../metrics/index.js";
import {isInsufficientBalanceError, isNonceError, type RelayerSubmitter} from "./submitter.js";

/// Relayer pool (plan §4.3 / M3.3).
///
/// Owns N treasury-funded EOAs (derived in M2.2 at `m/44'/60'/0'/1/<idx>`), assigns batches
/// round-robin, holds per-relayer monotonic nonces, refreshes from chain on `nonce too low`
/// / `already known`, and queues batches when every relayer is in flight.
///
/// Concurrency model — one in-flight tx per relayer. This isn't artificial: with Monad's
/// `eth_sendRawTransactionSync` (M3.4), each relayer's sync call gates the next nonce, so
/// a second concurrent send for the same EOA would just queue at the node. Owning the
/// gating in-process means we get exact round-robin distribution and accurate stats
/// instead of "however the node decided to schedule them".

/// Per-relayer state. Public-shape is what `chain.relayers` exposes; internal mutation is
/// tightly scoped to `submit` / `acquire` / `release`.
interface RelayerHandle {
    index: number;
    address: `0x${string}`;
    /// Signing account derived in M2.2. Held internally and only ever passed *down* to the
    /// submitter; never surfaces in `stats()` (no key material in JSON-RPC output).
    account: HDAccount;
    /// Next nonce to use. `null` means "not yet primed from chain"; first use triggers a
    /// `submitter.fetchNonce(...)` call.
    nonce: number | null;
    busy: boolean;
    /// M3.12 — "this relayer's MON dropped below what the next tx needs". Set when a submit
    /// fails with `isInsufficientBalanceError`; cleared by `markRelayerReady(idx)` (which
    /// the topup loop calls after a successful drip). While set, `acquire()` skips this
    /// relayer; if every relayer is low-balance, batches queue as if every relayer were busy.
    lowBalance: boolean;
    /// Counters since boot.
    submitted: number;
    errors: number;
    nonceRefreshes: number;
    /// M3.12 — count of times this relayer was flagged low-balance.
    lowBalanceEvents: number;
    lastLatencyMs: number | null;
    lastTxHash: `0x${string}` | null;
}

export interface RelayerPoolOptions {
    relayers: readonly DerivedAccount[];
    submitter: RelayerSubmitter;
    /// Cap on batches waiting for a free relayer. When exceeded, `sink(batch)` rejects so
    /// the batcher's `sinkErrors` counter ticks — surfaced upstream as the signal to grow
    /// the pool / batch size (plan §4.3). Default 64; rough heuristic of "enough headroom
    /// for a couple of round-trip latencies × N relayers".
    maxQueuedBatches?: number;
    /// Optional M3.9 sink for tx/auth events. When present, the pool calls
    /// `metrics.recordTxSuccess(authCount, latencyMs)` after each successful submit and
    /// `metrics.recordTxFailure()` on the final failure (after the one-shot nonce-refresh
    /// retry). Absent in unit tests that only care about the round-robin / nonce semantics.
    metrics?: MetricsRecorder;
    /// M3.12 — invoked when a relayer's submit fails with `isInsufficientBalanceError`. The
    /// pool has already marked the relayer offline (subsequent acquires skip it); the
    /// callback's job is to *unblock* it — typically by asking the topup loop to fire
    /// immediately rather than waiting for its next polling tick. The relayer comes back
    /// online via `markRelayerReady(idx)` after the topup completes.
    onRelayerInsufficientBalance?: (idx: number, address: `0x${string}`) => void;
    /// M3.12 — invoked after a batch's terminal failure (i.e. the one-shot nonce-refresh
    /// retry also failed, OR a non-recoverable error like `InsufficientBalance`). The
    /// caller is expected to invalidate any per-guest state that assumed the batch would
    /// land — e.g. the spend pipeline's `SpendNonceTracker`, whose local sigNonces have
    /// advanced even though chain hasn't moved.
    onTerminalFailure?: (batch: Batch, err: unknown) => void;
    log?: Logger;
}

export const DEFAULT_MAX_QUEUED_BATCHES = 64;

export interface RelayerStats {
    index: number;
    address: `0x${string}`;
    nonce: number | null;
    busy: boolean;
    /// M3.12 — `true` while the relayer is locked out for low MON. Cleared by
    /// `markRelayerReady` (the topup callback). Surfaces in `chain.relayers` so operators
    /// can see at a glance which relayers are awaiting refill.
    lowBalance: boolean;
    submitted: number;
    errors: number;
    nonceRefreshes: number;
    lowBalanceEvents: number;
    lastLatencyMs: number | null;
    lastTxHash: `0x${string}` | null;
}

export interface RelayerPoolStats {
    size: number;
    busy: number;
    free: number;
    /// M3.12 — relayers currently flagged low-balance (subset of `size - busy`, but they
    /// don't count as "free" for routing purposes).
    lowBalance: number;
    queuedBatches: number;
    maxQueuedBatches: number;
    totalSubmitted: number;
    totalErrors: number;
    totalNonceRefreshes: number;
    totalLowBalanceEvents: number;
    /// M3.12 — count of terminal failures (the one-shot retry didn't help OR the error is
    /// non-recoverable). One bump per failed batch, regardless of the retry path taken.
    totalTerminalFailures: number;
    totalQueueRejections: number;
    relayers: RelayerStats[];
    stopped: boolean;
}

interface Waiter {
    /// Resolve with the index of the just-freed relayer. The waiter inherits its busy=true
    /// state (we don't release-then-reacquire — that would race a sibling waiter).
    resolve: (idx: number) => void;
    reject: (err: Error) => void;
}

/// Pool with a `BatchSink`-shaped `sink` that plugs straight into M3.2's `Batcher`.
export class RelayerPool {
    readonly #relayers: RelayerHandle[];
    readonly #submitter: RelayerSubmitter;
    readonly #log: Logger;
    readonly #maxQueuedBatches: number;
    readonly #metrics: MetricsRecorder | undefined;
    readonly #onRelayerInsufficientBalance: ((idx: number, address: `0x${string}`) => void) | undefined;
    readonly #onTerminalFailure: ((batch: Batch, err: unknown) => void) | undefined;

    /// Round-robin starting cursor. Only consulted when at least one relayer is free; if all
    /// are busy we go via the waiter queue instead.
    #cursor = 0;
    /// FIFO of batches awaiting a relayer.
    readonly #waiters: Waiter[] = [];
    #queueRejections = 0;
    #terminalFailures = 0;
    #stopped = false;

    constructor(opts: RelayerPoolOptions) {
        if (opts.relayers.length === 0) {
            throw new Error("RelayerPool: needs at least one relayer");
        }
        this.#submitter = opts.submitter;
        this.#log = (opts.log ?? defaultLog).child({mod: "relayer-pool"});
        this.#maxQueuedBatches = opts.maxQueuedBatches ?? DEFAULT_MAX_QUEUED_BATCHES;
        this.#metrics = opts.metrics;
        this.#onRelayerInsufficientBalance = opts.onRelayerInsufficientBalance;
        this.#onTerminalFailure = opts.onTerminalFailure;
        if (!Number.isInteger(this.#maxQueuedBatches) || this.#maxQueuedBatches < 0) {
            throw new Error(`maxQueuedBatches must be a non-negative integer, got ${this.#maxQueuedBatches}`);
        }
        this.#relayers = opts.relayers.map((r, i) => ({
            index: i,
            address: r.address,
            account: r.account,
            nonce: null,
            busy: false,
            lowBalance: false,
            submitted: 0,
            errors: 0,
            nonceRefreshes: 0,
            lowBalanceEvents: 0,
            lastLatencyMs: null,
            lastTxHash: null,
        }));
    }

    /// M3.12 — clear a relayer's low-balance flag so future batches can route to it. Called
    /// by the topup loop after a successful drip lands on chain. If a waiter is queued, it's
    /// woken up and given this relayer immediately (matches the existing `#release` path).
    /// Idempotent: harmless to call on a relayer that wasn't flagged.
    markRelayerReady(idx: number): void {
        if (idx < 0 || idx >= this.#relayers.length) {
            throw new Error(`markRelayerReady: idx ${idx} out of range [0, ${this.#relayers.length})`);
        }
        const r = this.#relayers[idx]!;
        if (!r.lowBalance) return;
        r.lowBalance = false;
        // If this relayer was idle (not busy) but was being skipped due to lowBalance, hand it
        // to the longest-waiting queued batch the way `#release` does. We mirror that path
        // exactly so a waiter's resolution always means "you've got an acquired relayer".
        if (!r.busy) {
            const next = this.#waiters.shift();
            if (next) {
                r.busy = true;
                next.resolve(idx);
            }
        }
        this.#log.info({idx, address: r.address}, "relayer marked ready (topup completed)");
    }

    /// `BatchSink` shape — bound to `this` so callers can pass `pool.sink` directly into the
    /// batcher's `sink` option without juggling closures.
    readonly sink: BatchSink = async (batch: Batch): Promise<SinkResult> => {
        if (this.#stopped) throw new Error("RelayerPool: stopped");
        const relayerIdx = await this.#acquire();
        try {
            return await this.#submitWith(relayerIdx, batch);
        } finally {
            this.#release(relayerIdx);
        }
    };

    /// Drain. Rejects any batches still waiting for a relayer (their auths are dropped —
    /// this is the same loss model as an unflushed batcher buffer at shutdown). In-flight
    /// submissions are awaited via the natural promise chains; callers should `await` any
    /// outstanding `sink(...)` promises themselves before calling `stop()` if they care.
    async stop(): Promise<void> {
        if (this.#stopped) return;
        this.#stopped = true;
        const err = new Error("RelayerPool: stopped before assignment");
        const waiters = this.#waiters.splice(0);
        for (const w of waiters) w.reject(err);
    }

    stats(): RelayerPoolStats {
        let busy = 0;
        let lowBalance = 0;
        let totalSubmitted = 0;
        let totalErrors = 0;
        let totalNonceRefreshes = 0;
        let totalLowBalanceEvents = 0;
        const relayers: RelayerStats[] = this.#relayers.map((r) => {
            if (r.busy) busy++;
            if (r.lowBalance) lowBalance++;
            totalSubmitted += r.submitted;
            totalErrors += r.errors;
            totalNonceRefreshes += r.nonceRefreshes;
            totalLowBalanceEvents += r.lowBalanceEvents;
            return {
                index: r.index,
                address: r.address,
                nonce: r.nonce,
                busy: r.busy,
                lowBalance: r.lowBalance,
                submitted: r.submitted,
                errors: r.errors,
                nonceRefreshes: r.nonceRefreshes,
                lowBalanceEvents: r.lowBalanceEvents,
                lastLatencyMs: r.lastLatencyMs,
                lastTxHash: r.lastTxHash,
            };
        });
        return {
            size: this.#relayers.length,
            busy,
            free: this.#relayers.length - busy - lowBalance,
            lowBalance,
            queuedBatches: this.#waiters.length,
            maxQueuedBatches: this.#maxQueuedBatches,
            totalSubmitted,
            totalErrors,
            totalNonceRefreshes,
            totalLowBalanceEvents,
            totalTerminalFailures: this.#terminalFailures,
            totalQueueRejections: this.#queueRejections,
            relayers,
            stopped: this.#stopped,
        };
    }

    /// Capture for tests / diagnostics — internal accounts (with signing capability) are
    /// *not* exposed; only the address-and-counters view via `stats()`.

    // ---- internals ----

    /// Pick a free, ready (non-low-balance) relayer (round-robin) or queue. The returned
    /// index has its `busy` flag set to true; the caller must release.
    #acquire(): Promise<number> {
        const n = this.#relayers.length;
        for (let i = 0; i < n; i++) {
            const idx = (this.#cursor + i) % n;
            const r = this.#relayers[idx]!;
            // M3.12 — skip low-balance relayers; they'll be re-eligible once
            // `markRelayerReady(idx)` is called by the topup loop.
            if (!r.busy && !r.lowBalance) {
                r.busy = true;
                this.#cursor = (idx + 1) % n;
                return Promise.resolve(idx);
            }
        }
        if (this.#waiters.length >= this.#maxQueuedBatches) {
            this.#queueRejections++;
            return Promise.reject(
                new Error(
                    `relayer pool queue full (${this.#waiters.length}/${this.#maxQueuedBatches})`,
                ),
            );
        }
        return new Promise<number>((resolve, reject) => {
            this.#waiters.push({resolve, reject});
        });
    }

    /// Release a relayer. If a waiter is queued, hand it this just-freed slot instead of
    /// flipping `busy` back — preserves round-robin "fair share" without a release-then-
    /// reacquire race.
    ///
    /// M3.12: don't hand a low-balance relayer to a waiter. Two ways `lowBalance` can be set
    /// before release: the submit failed mid-flight (we set the flag in `#submitWith` before
    /// throwing), or the topup loop somehow flagged it externally. Either way, a waiter
    /// shouldn't get a relayer it can't actually use.
    #release(idx: number): void {
        const r = this.#relayers[idx]!;
        if (!r.lowBalance) {
            const next = this.#waiters.shift();
            if (next) {
                // r.busy stays true; the waiter inherits it.
                next.resolve(idx);
                return;
            }
        }
        r.busy = false;
    }

    /// Sign + submit with the given relayer; manages the local nonce and the one-retry
    /// `fetchNonce`-on-error path (plan §4.3).
    async #submitWith(idx: number, batch: Batch): Promise<SinkResult> {
        const r = this.#relayers[idx]!;
        if (r.nonce === null) {
            r.nonce = await this.#submitter.fetchNonce(r.address);
        }

        let attempt = 0;
        // Hard-capped retry: one nonce refresh + retry. If that also fails we give up; the
        // batcher's `sinkErrors` increments and the batch's auths are dropped (M3.10 will
        // add WAL-replay so they're recoverable across a sidecar restart). Looping forever
        // here would mask a real chain problem behind apparent silence.
        while (true) {
            try {
                const result = await this.#submitter.submit({
                    account: r.account,
                    nonce: r.nonce,
                    batch,
                });
                r.nonce++;
                r.submitted++;
                r.lastLatencyMs = result.latencyMs;
                r.lastTxHash = result.txHash;
                this.#metrics?.recordTxSuccess(batch.auths.length, result.latencyMs);
                return {txHash: result.txHash};
            } catch (err) {
                r.errors++;
                // M3.12 — insufficient balance: not retryable on the same relayer (chain has
                // no MON to pay our gas), no nonce refresh helps. Mark offline + notify the
                // topup loop so it can fire immediately, and surface as terminal failure.
                if (isInsufficientBalanceError(err)) {
                    r.lowBalance = true;
                    r.lowBalanceEvents++;
                    this.#log.warn(
                        {relayer: r.address, idx, batchId: batch.id, err},
                        "relayer marked low-balance; topup will refill",
                    );
                    try {
                        this.#onRelayerInsufficientBalance?.(idx, r.address);
                    } catch (cbErr) {
                        // Don't let a misbehaving callback poison the failure path.
                        this.#log.error({cbErr}, "onRelayerInsufficientBalance callback threw");
                    }
                    this.#terminalFailures++;
                    this.#metrics?.recordTxFailure();
                    this.#fireTerminalFailure(batch, err);
                    throw err;
                }
                if (attempt++ < 1 && isNonceError(err)) {
                    const fresh = await this.#submitter.fetchNonce(r.address);
                    r.nonce = fresh;
                    r.nonceRefreshes++;
                    this.#log.warn(
                        {relayer: r.address, freshNonce: fresh, batchId: batch.id, err},
                        "relayer nonce refreshed after submit error",
                    );
                    continue;
                }
                this.#log.error(
                    {relayer: r.address, batchId: batch.id, attempt, err},
                    "relayer submit failed; surfacing to batcher",
                );
                this.#terminalFailures++;
                this.#metrics?.recordTxFailure();
                this.#fireTerminalFailure(batch, err);
                throw err;
            }
        }
    }

    /// One-shot terminal-failure callback dispatch. Wrapped so a misbehaving consumer can't
    /// take the relayer pool down with it (e.g. the spend pipeline's nonce-tracker.invalidate
    /// throws). M3.12.
    #fireTerminalFailure(batch: Batch, err: unknown): void {
        if (!this.#onTerminalFailure) return;
        try {
            this.#onTerminalFailure(batch, err);
        } catch (cbErr) {
            this.#log.error({cbErr, batchId: batch.id}, "onTerminalFailure callback threw");
        }
    }
}
