import type {HDAccount} from "viem/accounts";
import type {Batch, BatchSink, SinkResult} from "../batcher/index.js";
import type {DerivedAccount} from "../derive/index.js";
import {log as defaultLog, type Logger} from "../log.js";
import {isNonceError, type RelayerSubmitter} from "./submitter.js";

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
    /// Counters since boot.
    submitted: number;
    errors: number;
    nonceRefreshes: number;
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
    log?: Logger;
}

export const DEFAULT_MAX_QUEUED_BATCHES = 64;

export interface RelayerStats {
    index: number;
    address: `0x${string}`;
    nonce: number | null;
    busy: boolean;
    submitted: number;
    errors: number;
    nonceRefreshes: number;
    lastLatencyMs: number | null;
    lastTxHash: `0x${string}` | null;
}

export interface RelayerPoolStats {
    size: number;
    busy: number;
    free: number;
    queuedBatches: number;
    maxQueuedBatches: number;
    totalSubmitted: number;
    totalErrors: number;
    totalNonceRefreshes: number;
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

    /// Round-robin starting cursor. Only consulted when at least one relayer is free; if all
    /// are busy we go via the waiter queue instead.
    #cursor = 0;
    /// FIFO of batches awaiting a relayer.
    readonly #waiters: Waiter[] = [];
    #queueRejections = 0;
    #stopped = false;

    constructor(opts: RelayerPoolOptions) {
        if (opts.relayers.length === 0) {
            throw new Error("RelayerPool: needs at least one relayer");
        }
        this.#submitter = opts.submitter;
        this.#log = (opts.log ?? defaultLog).child({mod: "relayer-pool"});
        this.#maxQueuedBatches = opts.maxQueuedBatches ?? DEFAULT_MAX_QUEUED_BATCHES;
        if (!Number.isInteger(this.#maxQueuedBatches) || this.#maxQueuedBatches < 0) {
            throw new Error(`maxQueuedBatches must be a non-negative integer, got ${this.#maxQueuedBatches}`);
        }
        this.#relayers = opts.relayers.map((r, i) => ({
            index: i,
            address: r.address,
            account: r.account,
            nonce: null,
            busy: false,
            submitted: 0,
            errors: 0,
            nonceRefreshes: 0,
            lastLatencyMs: null,
            lastTxHash: null,
        }));
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
        let totalSubmitted = 0;
        let totalErrors = 0;
        let totalNonceRefreshes = 0;
        const relayers: RelayerStats[] = this.#relayers.map((r) => {
            if (r.busy) busy++;
            totalSubmitted += r.submitted;
            totalErrors += r.errors;
            totalNonceRefreshes += r.nonceRefreshes;
            return {
                index: r.index,
                address: r.address,
                nonce: r.nonce,
                busy: r.busy,
                submitted: r.submitted,
                errors: r.errors,
                nonceRefreshes: r.nonceRefreshes,
                lastLatencyMs: r.lastLatencyMs,
                lastTxHash: r.lastTxHash,
            };
        });
        return {
            size: this.#relayers.length,
            busy,
            free: this.#relayers.length - busy,
            queuedBatches: this.#waiters.length,
            maxQueuedBatches: this.#maxQueuedBatches,
            totalSubmitted,
            totalErrors,
            totalNonceRefreshes,
            totalQueueRejections: this.#queueRejections,
            relayers,
            stopped: this.#stopped,
        };
    }

    /// Capture for tests / diagnostics — internal accounts (with signing capability) are
    /// *not* exposed; only the address-and-counters view via `stats()`.

    // ---- internals ----

    /// Pick a free relayer (round-robin) or queue. The returned index has its `busy` flag
    /// set to true; the caller must release.
    #acquire(): Promise<number> {
        const n = this.#relayers.length;
        for (let i = 0; i < n; i++) {
            const idx = (this.#cursor + i) % n;
            const r = this.#relayers[idx]!;
            if (!r.busy) {
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
    #release(idx: number): void {
        const r = this.#relayers[idx]!;
        const next = this.#waiters.shift();
        if (next) {
            // r.busy stays true; the waiter inherits it.
            next.resolve(idx);
        } else {
            r.busy = false;
        }
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
                return {txHash: result.txHash};
            } catch (err) {
                r.errors++;
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
                throw err;
            }
        }
    }
}
