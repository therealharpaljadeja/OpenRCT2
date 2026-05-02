import type {Hex} from "viem";
import {log as defaultLog, type Logger} from "../log.js";
import type {SpendAuth} from "./sign.js";

/// Batch accumulator (plan §4.2 / M3.2).
///
/// The hot path that turns a stream of pre-signed `SpendAuth`s into `SettlementBatcher.settle`
/// payloads. Pure FIFO collector with two independent flush triggers — size and age — and one
/// configurable backpressure valve.
///
/// Why pre-signed input: signing is M3.1 (`sign.ts`); this milestone is the queue + flush
/// policy, kept deliberately thin so it's easy to reason about. The wiring layer that turns
/// `GUEST_SPEND` outbox events into `accept(...)` calls — derive key, build auth, sign, push —
/// lands in M3.5/M4.4. By splitting "produce a SignedAuth" from "decide when to ship it",
/// neither side has to know about the other's policies.
///
/// Sink contract: `flush()` calls `sink(batch)` and tracks the returned promise. The sink is
/// fire-and-forget from the batcher's perspective — we record completion + errors, but a slow
/// sink does *not* block `accept()`. M3.3's relayer pool will be the real sink and is the
/// thing that actually applies backpressure (its bounded internal queue), so duplicating
/// per-relayer logic here would just hide it.

export const DEFAULT_BATCH_MAX_SIZE = 256;
export const DEFAULT_BATCH_MAX_AGE_MS = 200;
/// Per plan §4.2: "if the unflushed-auth queue grows beyond N (e.g. 50k), drop oldest auths".
/// The default is the plan's example. The cap covers only auths still in the active batch;
/// auths that have been flushed and handed to the sink no longer count (they're its problem).
export const DEFAULT_MAX_QUEUED_AUTHS = 50_000;
/// Hard upper bound on `maxSize`. The contract has no per-call limit, but a 100M-gas Monad
/// block at ~43k gas/auth tops out around 2.3k auths/tx; we leave a safety margin.
export const MAX_BATCH_MAX_SIZE = 1024;

/// One off-chain payload + its 65-byte signature, ready to be sliced into the two parallel
/// arrays `SettlementBatcher.settle(auths, sigs)` expects.
export interface SignedAuth {
    auth: SpendAuth;
    signature: Hex;
}

/// Why we flushed. Surfaces in metrics so we can tell at a glance whether the park is
/// throughput-bound (mostly `"size"`) or trickling (mostly `"age"`).
export type FlushReason = "size" | "age" | "manual" | "stop";

/// What the sink receives. `id` is assigned by the batcher and is monotonic across the
/// process lifetime — handy for relayer logs and for correlating with on-chain receipts.
/// `firstAcceptedAt` and `flushedAt` are the inputs to the latency histogram M3.9 will
/// compute (queueing latency = flushedAt − firstAcceptedAt; the relayer adds tx latency on
/// top). They're carried on the batch itself so the sink doesn't need a parallel timing
/// store.
export interface Batch {
    id: number;
    auths: readonly SpendAuth[];
    sigs: readonly Hex[];
    firstAcceptedAt: number;
    flushedAt: number;
    reason: FlushReason;
}

/// Sink return shape — empty for now. The relayer pool will populate `txHash` etc. in M3.3.
/// We keep an interface (rather than `void`) so adding fields later doesn't change the
/// signature.
export interface SinkResult {
    txHash?: Hex;
}

export type BatchSink = (batch: Batch) => Promise<SinkResult>;

export interface BatcherOptions {
    sink: BatchSink;
    /// Both have generous defaults; runtime tuning happens via `updateConfig()` (plan §5.4).
    maxSize?: number;
    maxAgeMs?: number;
    /// Drop-oldest threshold for the active (unflushed) buffer.
    maxQueuedAuths?: number;
    log?: Logger;
    /// Injectable timer/clock for tests. Production code uses `Date.now` + the global timer.
    now?: () => number;
    setTimeout?: typeof setTimeout;
    clearTimeout?: typeof clearTimeout;
}

export interface BatcherStats {
    /// Items currently buffered (waiting on size/age flush).
    queueDepth: number;
    maxSize: number;
    maxAgeMs: number;
    maxQueuedAuths: number;
    /// Sink calls in progress (flushed but not yet resolved).
    inFlightBatches: number;
    /// Counters since boot.
    accepted: number;
    flushed: number;
    flushedAuths: number;
    droppedAuths: number;
    sinkErrors: number;
    /// Histogram-friendly accumulators. `flushed > 0` ⇒ averages are meaningful.
    avgBatchFill: number;
    /// Last flush's queueing latency (ms) — flushedAt − firstAcceptedAt. Useful as a smoke
    /// signal during dev; real percentiles come in M3.9.
    lastFlushLatencyMs: number | null;
    flushReasonCounts: Record<FlushReason, number>;
}

/// FIFO accumulator with size/age flush triggers and oldest-drop backpressure.
export class Batcher {
    readonly #sink: BatchSink;
    readonly #log: Logger;
    readonly #now: () => number;
    readonly #setTimeout: typeof setTimeout;
    readonly #clearTimeout: typeof clearTimeout;

    #maxSize: number;
    #maxAgeMs: number;
    #maxQueuedAuths: number;

    /// Active buffer, parallel arrays so the sink can hand them straight to viem
    /// `writeContract({args: [auths, sigs]})` without re-shuffling. `acceptedAt` tracks per-
    /// item arrival times so an age-flush triggered by the *oldest* item, not the newest.
    #auths: SpendAuth[] = [];
    #sigs: Hex[] = [];
    #acceptedAt: number[] = [];

    /// Single age-timer keyed off the first item in the buffer. Re-armed on every flush.
    #ageTimer: ReturnType<typeof setTimeout> | undefined;

    /// Async sink calls in flight; `stop()` awaits this set to drain cleanly.
    readonly #pending = new Set<Promise<void>>();

    /// Counters / metrics surface.
    #nextBatchId = 1;
    #accepted = 0;
    #flushed = 0;
    #flushedAuths = 0;
    #droppedAuths = 0;
    #sinkErrors = 0;
    #lastFlushLatencyMs: number | null = null;
    readonly #flushReasonCounts: Record<FlushReason, number> = {
        size: 0,
        age: 0,
        manual: 0,
        stop: 0,
    };

    #stopped = false;

    constructor(opts: BatcherOptions) {
        this.#sink = opts.sink;
        this.#log = (opts.log ?? defaultLog).child({mod: "batcher"});
        this.#now = opts.now ?? Date.now;
        this.#setTimeout = opts.setTimeout ?? setTimeout;
        this.#clearTimeout = opts.clearTimeout ?? clearTimeout;

        const maxSize = opts.maxSize ?? DEFAULT_BATCH_MAX_SIZE;
        const maxAgeMs = opts.maxAgeMs ?? DEFAULT_BATCH_MAX_AGE_MS;
        const maxQueuedAuths = opts.maxQueuedAuths ?? DEFAULT_MAX_QUEUED_AUTHS;
        validateMaxSize(maxSize);
        validateMaxAgeMs(maxAgeMs);
        validateMaxQueuedAuths(maxQueuedAuths, maxSize);
        this.#maxSize = maxSize;
        this.#maxAgeMs = maxAgeMs;
        this.#maxQueuedAuths = maxQueuedAuths;
    }

    /// Push a signed auth. Synchronous: the only async work this method ever does is fire
    /// off a sink call, and we deliberately don't `await` it — `accept()` returning fast is
    /// what keeps the producer (game outbox drain) at line rate.
    accept(item: SignedAuth): void {
        if (this.#stopped) {
            // Late event after stop. Could enqueue, but that defeats the point of stop;
            // instead drop and count. Surfaces as a `dropped_auths` bump.
            this.#droppedAuths++;
            this.#log.warn({item}, "batcher.accept after stop — dropping");
            return;
        }
        const at = this.#now();
        this.#auths.push(item.auth);
        this.#sigs.push(item.signature);
        this.#acceptedAt.push(at);
        this.#accepted++;

        // Backpressure: if the *active buffer* exceeds the cap, evict from the front. The
        // alternative — refusing the new item — would be wrong: the freshest events are the
        // most relevant to a feed dapp / live HUD. Plan §4.2 specifies oldest-drop.
        while (this.#auths.length > this.#maxQueuedAuths) {
            this.#auths.shift();
            this.#sigs.shift();
            this.#acceptedAt.shift();
            this.#droppedAuths++;
        }

        if (this.#auths.length >= this.#maxSize) {
            this.#flushNow("size");
            return;
        }
        // First item in the buffer arms the age timer. Subsequent accepts within the same
        // window do nothing — the age window is anchored to the *oldest* item, so a steady
        // trickle still flushes after `maxAgeMs` even if it never reaches `maxSize`.
        if (this.#auths.length === 1) {
            this.#armAgeTimer();
        }
    }

    /// Operator-initiated flush. No-op if the buffer is empty.
    flush(): void {
        if (this.#auths.length > 0) this.#flushNow("manual");
    }

    /// Drain the buffer and wait for in-flight sink calls to settle. Idempotent.
    async stop(): Promise<void> {
        if (this.#stopped) return;
        this.#stopped = true;
        if (this.#ageTimer !== undefined) {
            this.#clearTimeout(this.#ageTimer);
            this.#ageTimer = undefined;
        }
        if (this.#auths.length > 0) this.#flushNow("stop");
        // Wait on a snapshot of pending — the sinks themselves remove from the set on settle.
        await Promise.allSettled([...this.#pending]);
    }

    /// Hot-tunable knobs (plan §5.4 `chain.batch.config`). Validated; throws on bad input so
    /// the IPC layer can map to a clean InvalidParams instead of accepting nonsense and
    /// stalling the queue at runtime.
    updateConfig(patch: {maxSize?: number; maxAgeMs?: number; maxQueuedAuths?: number}): void {
        const nextSize = patch.maxSize ?? this.#maxSize;
        const nextAge = patch.maxAgeMs ?? this.#maxAgeMs;
        const nextQueued = patch.maxQueuedAuths ?? this.#maxQueuedAuths;
        validateMaxSize(nextSize);
        validateMaxAgeMs(nextAge);
        validateMaxQueuedAuths(nextQueued, nextSize);
        this.#maxSize = nextSize;
        this.#maxAgeMs = nextAge;
        this.#maxQueuedAuths = nextQueued;
        // If the new size is smaller than the buffer, flush immediately so we don't sit on
        // a now-oversized batch. Same for queued-auths: shrink applies on next accept.
        if (this.#auths.length >= this.#maxSize && this.#auths.length > 0) {
            this.#flushNow("size");
        } else if (this.#auths.length > 0) {
            // Re-arm with the new age (still anchored to the oldest item).
            this.#armAgeTimer();
        }
    }

    stats(): BatcherStats {
        return {
            queueDepth: this.#auths.length,
            maxSize: this.#maxSize,
            maxAgeMs: this.#maxAgeMs,
            maxQueuedAuths: this.#maxQueuedAuths,
            inFlightBatches: this.#pending.size,
            accepted: this.#accepted,
            flushed: this.#flushed,
            flushedAuths: this.#flushedAuths,
            droppedAuths: this.#droppedAuths,
            sinkErrors: this.#sinkErrors,
            avgBatchFill: this.#flushed === 0 ? 0 : this.#flushedAuths / this.#flushed,
            lastFlushLatencyMs: this.#lastFlushLatencyMs,
            flushReasonCounts: {...this.#flushReasonCounts},
        };
    }

    // ---- internals ----

    #flushNow(reason: FlushReason): void {
        if (this.#auths.length === 0) return;
        if (this.#ageTimer !== undefined) {
            this.#clearTimeout(this.#ageTimer);
            this.#ageTimer = undefined;
        }
        const auths = this.#auths;
        const sigs = this.#sigs;
        const acceptedAt = this.#acceptedAt;
        // Reset state *before* the sink call so a sink that synchronously errors (or, more
        // realistically, a slow sink that triggers an `accept()` reentry) sees a clean buffer.
        this.#auths = [];
        this.#sigs = [];
        this.#acceptedAt = [];

        const flushedAt = this.#now();
        const firstAcceptedAt = acceptedAt[0]!;
        const batch: Batch = {
            id: this.#nextBatchId++,
            auths,
            sigs,
            firstAcceptedAt,
            flushedAt,
            reason,
        };

        this.#flushed++;
        this.#flushedAuths += auths.length;
        this.#flushReasonCounts[reason]++;
        this.#lastFlushLatencyMs = flushedAt - firstAcceptedAt;

        // Fire and track. We translate `Promise<SinkResult>` to `Promise<void>` for the
        // pending set so the type stays uniform.
        let p!: Promise<void>;
        p = (async () => {
            try {
                await this.#sink(batch);
            } catch (err) {
                this.#sinkErrors++;
                this.#log.error({err, batchId: batch.id, count: auths.length}, "batch sink failed");
            } finally {
                this.#pending.delete(p);
            }
        })();
        this.#pending.add(p);
    }

    #armAgeTimer(): void {
        if (this.#ageTimer !== undefined) this.#clearTimeout(this.#ageTimer);
        // Anchor on the *oldest* unflushed item. If the buffer was just primed with one new
        // item, oldest === newest, so this is `now + maxAgeMs`. If the buffer was already
        // populated when we got here (rare; only via re-arm in `updateConfig`), we shorten
        // the timer to honor that item's original deadline.
        const oldest = this.#acceptedAt[0]!;
        const remaining = Math.max(0, this.#maxAgeMs - (this.#now() - oldest));
        this.#ageTimer = this.#setTimeout(() => {
            this.#ageTimer = undefined;
            if (this.#auths.length > 0) this.#flushNow("age");
        }, remaining);
        // Don't keep the event loop alive on the age timer alone — sidecar shutdown should
        // not be blocked by an idle queue. `unref` is harmless when missing (custom timers in
        // tests).
        const t = this.#ageTimer as unknown as {unref?: () => void};
        if (t && typeof t.unref === "function") t.unref();
    }
}

function validateMaxSize(n: number): void {
    if (!Number.isInteger(n) || n < 1 || n > MAX_BATCH_MAX_SIZE) {
        throw new Error(`maxSize must be an integer in [1, ${MAX_BATCH_MAX_SIZE}], got ${n}`);
    }
}

function validateMaxAgeMs(n: number): void {
    if (!Number.isInteger(n) || n < 1 || n > 60_000) {
        throw new Error(`maxAgeMs must be an integer in [1, 60000], got ${n}`);
    }
}

function validateMaxQueuedAuths(n: number, _maxSize: number): void {
    if (!Number.isInteger(n) || n < 1 || n > 1_000_000) {
        throw new Error(`maxQueuedAuths must be an integer in [1, 1000000], got ${n}`);
    }
    // Deliberately *not* enforced relative to `maxSize`. Operators may set a tight cap to
    // prove backpressure behaviour in tests, or — more interestingly — to express "drop old
    // events rather than send them late" when the upstream is wedged. A configuration where
    // `maxQueuedAuths < maxSize` simply means size-flushes never fire and the queue is
    // bounded by eviction; that's a legitimate (if unusual) policy.
}
