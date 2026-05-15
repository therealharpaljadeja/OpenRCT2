import type {PublicClient} from "viem";
import {SETTLEMENT_BATCHER_ABI} from "../chain/abis.js";

/// Per-guest signature-nonce tracker (M3.11 / plan §2.4).
///
/// `SettlementBatcher.sigNonces[guest]` is a uint64 monotonic counter incremented by 1 per
/// accepted `SpendAuth`. The first auth from a fresh guest must use nonce 0; the second nonce
/// 1; and so on. A duplicate or skipped nonce reverts the *whole* batch with `BadNonce` — so
/// the dispatcher MUST hand the batcher consecutive nonces per guest, in order.
///
/// Two ways a guest's first call lands at a non-zero nonce:
///   1. Sidecar restart against a chain with already-applied auths from this guest (rare in
///      stress mode — fresh mnemonic gets us fresh guests).
///   2. The batch a previous incarnation submitted landed on-chain after our cursor had been
///      advanced past it (we re-derive the *same* HD index on restart).
/// Both are handled identically: on first call for an address, read `sigNonces[address]` from
/// chain. After that, increment locally — the sidecar is the only writer, no other process is
/// stepping on the counter.
///
/// Concurrency: the M2.4 outbox reader is sequential — `next()` is never called concurrently
/// for the same address by today's wiring. We still wrap the fetch path in a per-address
/// promise so a future "fan out signing across worker threads" doesn't silently double-issue
/// nonce 0 from two parallel first-touches.

export interface SpendNonceTrackerChainOptions {
    publicClient: PublicClient;
    settlementBatcher: `0x${string}`;
}

export interface SpendNonceTrackerTestOptions {
    /// Override the on-chain read for tests. Returns the current `sigNonces[address]` value.
    fetchInitialNonce: (address: `0x${string}`) => Promise<bigint>;
}

export type SpendNonceTrackerOptions = SpendNonceTrackerChainOptions | SpendNonceTrackerTestOptions;

export class SpendNonceTracker {
    readonly #fetchInitial: (address: `0x${string}`) => Promise<bigint>;
    readonly #nonces = new Map<`0x${string}`, bigint>();
    /// Pending first-touch fetches keyed by lower-cased address. A second caller for the same
    /// address shares the in-flight promise rather than firing a duplicate chain read.
    readonly #initialFetches = new Map<`0x${string}`, Promise<bigint>>();
    /// M3.12 — addresses whose local cache is stale and must be re-fetched from chain on the
    /// next `next()` call. Populated by `invalidate()` after a batch terminal failure: the
    /// auths in that batch never landed, but the local counter has already advanced, so any
    /// subsequent spend from those guests would hit `BadNonce` until the chain catches up.
    /// We don't decrement (race-unsafe with concurrent batches per guest); we re-fetch.
    readonly #stale = new Set<`0x${string}`>();
    #fetches = 0;
    #invalidations = 0;

    constructor(opts: SpendNonceTrackerOptions) {
        if ("fetchInitialNonce" in opts) {
            this.#fetchInitial = opts.fetchInitialNonce;
        } else {
            const {publicClient, settlementBatcher} = opts;
            if (!/^0x[0-9a-fA-F]{40}$/.test(settlementBatcher)) {
                throw new Error(
                    `SpendNonceTracker: settlementBatcher is not a 20-byte hex address: ${settlementBatcher}`,
                );
            }
            this.#fetchInitial = async (addr) => {
                const n = (await publicClient.readContract({
                    address: settlementBatcher,
                    abi: SETTLEMENT_BATCHER_ABI,
                    functionName: "sigNonces",
                    args: [addr],
                })) as bigint;
                return n;
            };
        }
    }

    /// Return the next nonce for `address` and atomically advance the local counter. On first
    /// touch, fetches the current chain-side value (which is 0 for fresh guests).
    ///
    /// If the address has been `invalidate()`d since its last `next()`, the cached value is
    /// dropped and re-fetched from chain. M3.12 — protects against the cascade where a batch
    /// fails terminally, the chain didn't move, but the local counter did.
    async next(address: `0x${string}`): Promise<bigint> {
        const key = address.toLowerCase() as `0x${string}`;
        if (this.#stale.has(key)) {
            this.#nonces.delete(key);
            this.#stale.delete(key);
        }
        let n = this.#nonces.get(key);
        if (n === undefined) {
            let pending = this.#initialFetches.get(key);
            if (!pending) {
                this.#fetches++;
                pending = this.#fetchInitial(address);
                this.#initialFetches.set(key, pending);
                // Cleanup chain: settle removes the in-flight entry. We swallow the
                // rejection on this branch (the original `await pending` below propagates
                // it to the caller) — otherwise we'd surface the same error twice and
                // trigger an unhandledRejection.
                pending.then(
                    () => this.#initialFetches.delete(key),
                    () => this.#initialFetches.delete(key),
                );
            }
            // Don't poison the local cache on a transient RPC error; next call retries.
            n = await pending;
            // A concurrent caller may have already populated + advanced the counter while we
            // were awaiting the fetch. If so, take their value; if not, seed with the chain's.
            const concurrent = this.#nonces.get(key);
            n = concurrent ?? n;
        }
        this.#nonces.set(key, n + 1n);
        return n;
    }

    /// Drop an address from the cache. Used on `GUEST_EXIT` so the map doesn't grow unbounded
    /// across long-running parks. Idempotent.
    forget(address: `0x${string}`): void {
        const key = address.toLowerCase() as `0x${string}`;
        this.#nonces.delete(key);
        this.#stale.delete(key);
    }

    /// Drop every cached nonce. Used on a session-change: every guest under the new
    /// session derives to a different address, so the old map is just dead entries.
    /// First-touch fetches re-populate as the new session's spends flow in.
    clear(): void {
        this.#nonces.clear();
        this.#stale.clear();
        // Pending in-flight initial fetches are left alone — they'll resolve, attempt
        // to seed the (now-cleared) map, and naturally race with whatever the new
        // session's first call kicks off. Either value is correct because the address
        // they fetched for either matches the current session (no-op) or doesn't (the
        // entry is unused). This is rare under the new-game flow because the WAL is
        // truncated at the same boundary so nothing's mid-fetch.
    }

    /// Mark addresses as stale — the next `next(addr)` re-fetches `sigNonces[addr]` from
    /// chain instead of using the local cache. M3.12: called by the relayer pool's terminal-
    /// failure handler when a batch's auths can't land but the local counter has already
    /// advanced. Cheap (Set inserts); idempotent. Addresses not in the cache are still added
    /// to `#stale` so a same-tick `next()` after the invalidate re-fetches.
    invalidate(addresses: Iterable<`0x${string}`>): void {
        let n = 0;
        for (const addr of addresses) {
            const key = addr.toLowerCase() as `0x${string}`;
            this.#stale.add(key);
            n++;
        }
        if (n > 0) this.#invalidations += n;
    }

    /// Read-without-advance — the value the *next* call to `next()` will return. Used by tests
    /// and by the metrics surface; production callers should always go through `next()`.
    peek(address: `0x${string}`): bigint | undefined {
        return this.#nonces.get(address.toLowerCase() as `0x${string}`);
    }

    stats(): {size: number; fetches: number; invalidations: number; stale: number} {
        return {
            size: this.#nonces.size,
            fetches: this.#fetches,
            invalidations: this.#invalidations,
            stale: this.#stale.size,
        };
    }
}
