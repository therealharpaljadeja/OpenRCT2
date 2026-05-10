import {
    BaseError,
    ContractFunctionRevertedError,
    getCreate2Address,
    keccak256,
    pad,
    type Hex,
    type PublicClient,
    type WalletClient,
} from "viem";
import {VENUE_REGISTRY_ABI} from "../chain/abis.js";
import {confirmTx} from "../chain/clients.js";
import {log as defaultLog, type Logger} from "../log.js";

/// VenueMirror (plan §3.1 / §4.5 / M3.8).
///
/// Drains `VENUE_REGISTERED` / `VENUE_RENAMED` / `VENUE_REMOVED` outbox events and submits one
/// admin tx per event to `VenueRegistry`. Low-volume — rides aren't placed at high frequency,
/// so we don't batch (the funder's window cadence makes no sense for a few placements per
/// minute). Strict ordering matters within a single venueId though: if a rename and a remove
/// land in the same window, the rename must hit chain first or the remove sees stale state.
///
/// Local cache: every accepted event also updates an in-memory `venueId → CachedVenue` map.
/// `lookup(venueId)` is the lookup the spend batcher (M3.x) will call to attach the venue's
/// `kind` and `subAccount` to each `SpendAuth` without a chain read on the hot path. The
/// `subAccount` is computed locally via CREATE2 (`registry, bytes32(id), keccak256("")`) to
/// match `VenueRegistry.subAccountOf`; verified once at boot against the chain via
/// `hydrateFromChain()` if enabled.
///
/// Idempotency: a duplicate `VENUE_REGISTERED` (re-emit after a sidecar restart that doesn't
/// roll the cursor back far enough) reverts with `AlreadyRegistered`; a `VENUE_RENAMED` for an
/// unregistered id reverts with `NotRegistered`; a `VENUE_REMOVED` for an inactive venue
/// reverts with `AlreadyInactive`. We map each of those to a `skipped*` counter rather than
/// `rpcErrors` — the producer is correct, the chain is just ahead of us.

export type VenueKind = 0 | 1 | 2 | 3 | 4 | 5; // ParkEntrance / Ride / Shop / Stall / Facility / ATM

export interface CachedVenue {
    id: number;
    kind: VenueKind;
    name: string;
    objectType: string;
    subAccount: `0x${string}`;
    active: boolean;
}

export type VenueMirrorEvent =
    | {kind: "register"; venueId: number; venueKind: number; name: string; objectType: string}
    | {kind: "rename"; venueId: number; newName: string}
    | {kind: "remove"; venueId: number};

export interface VenueMirrorOptions {
    walletClient: WalletClient;
    publicClient: PublicClient;
    venueRegistry: `0x${string}`;
    /// Drop-oldest cap on the queue. Default 1024 — venue events are sparse; if we ever pile up
    /// past this, something's badly wrong and the producer should slow down anyway.
    maxQueuedEvents?: number;
    log?: Logger;
    now?: () => number;
}

export const DEFAULT_VENUE_MIRROR_MAX_QUEUED = 1024;
const VENUE_MIRROR_MAX_QUEUED_LIMIT = 1_000_000;

export interface VenueMirrorStats {
    queueDepth: number;
    cacheSize: number;
    /// Boot-state counters since `start()`.
    accepted: number;
    submitted: number;
    /// Events the chain rejected with one of `AlreadyRegistered` / `NotRegistered` /
    /// `AlreadyInactive` — i.e. the chain is already in the post-event state. Counted
    /// separately from `rpcErrors` because they're recoverable / expected on cursor replay.
    skippedAlreadyApplied: number;
    droppedEvents: number;
    rpcErrors: number;
    lastTxHash: Hex | null;
    lastSubmitLatencyMs: number | null;
    eventCounts: {register: number; rename: number; remove: number};
    started: boolean;
    stopped: boolean;
    /// In-flight tx (the worker is mid-write). 0 or 1; we serialize submission.
    inFlight: number;
}

/// Empty-init-code hash, mirrors `VenueRegistry.SUBACCOUNT_INIT_CODE_HASH`. Pinned here so we
/// can compute sub-accounts locally without a chain read.
export const SUBACCOUNT_INIT_CODE_HASH: Hex = keccak256("0x");

/// Compute the deterministic CREATE2 sub-account for a venue id. Matches
/// `VenueRegistry.subAccountOf` byte-for-byte — verify with a single `subAccountOf` chain read
/// against the deployed registry on first boot if you're paranoid.
export function subAccountOf(registry: `0x${string}`, venueId: number): `0x${string}` {
    if (!Number.isInteger(venueId) || venueId < 0 || venueId > 0xffff_ffff) {
        throw new Error(`subAccountOf: venueId out of uint32 range: ${venueId}`);
    }
    // bytes32(uint256(id)) — left-pad the id to 32 bytes.
    const salt = pad(`0x${venueId.toString(16)}` as Hex, {size: 32});
    return getCreate2Address({from: registry, salt, bytecodeHash: SUBACCOUNT_INIT_CODE_HASH});
}

export class VenueMirror {
    readonly #walletClient: WalletClient;
    readonly #publicClient: PublicClient;
    readonly #venueRegistry: `0x${string}`;
    readonly #log: Logger;
    readonly #now: () => number;
    readonly #maxQueuedEvents: number;

    readonly #cache = new Map<number, CachedVenue>();
    #queue: VenueMirrorEvent[] = [];
    #worker: Promise<void> | undefined;
    #inFlight = 0;
    #started = false;
    #stopped = false;
    /// Resolved when the worker has fully drained the queue. Only set while a worker is alive.
    #idleResolvers: Array<() => void> = [];

    #accepted = 0;
    #submitted = 0;
    #skippedAlreadyApplied = 0;
    #droppedEvents = 0;
    #rpcErrors = 0;
    #lastTxHash: Hex | null = null;
    #lastSubmitLatencyMs: number | null = null;
    readonly #eventCounts = {register: 0, rename: 0, remove: 0};

    constructor(opts: VenueMirrorOptions) {
        if (!opts.walletClient.account) {
            throw new Error("VenueMirror: walletClient missing account — pass a key-bound client");
        }
        if (!/^0x[0-9a-fA-F]{40}$/.test(opts.venueRegistry)) {
            throw new Error(`VenueMirror.venueRegistry is not a 20-byte hex address: ${opts.venueRegistry}`);
        }
        const maxQueued = opts.maxQueuedEvents ?? DEFAULT_VENUE_MIRROR_MAX_QUEUED;
        if (!Number.isInteger(maxQueued) || maxQueued < 1 || maxQueued > VENUE_MIRROR_MAX_QUEUED_LIMIT) {
            throw new Error(
                `VenueMirror.maxQueuedEvents must be an integer in [1, ${VENUE_MIRROR_MAX_QUEUED_LIMIT}], got ${maxQueued}`,
            );
        }
        this.#walletClient = opts.walletClient;
        this.#publicClient = opts.publicClient;
        this.#venueRegistry = opts.venueRegistry;
        this.#log = (opts.log ?? defaultLog).child({mod: "venues"});
        this.#now = opts.now ?? Date.now;
        this.#maxQueuedEvents = maxQueued;
    }

    /// Optional one-time cache hydration from chain. Useful after a sidecar restart so the
    /// batcher's hot-path lookups don't return `undefined` until the WAL has been re-played.
    /// Skipped at boot in tests; M3.10 may wire this on the production path.
    async hydrateFromChain(): Promise<number> {
        const count = (await this.#publicClient.readContract({
            address: this.#venueRegistry,
            abi: VENUE_REGISTRY_ABI,
            functionName: "venueCount",
        })) as bigint;
        const n = Number(count);
        for (let i = 0; i < n; i++) {
            const id = (await this.#publicClient.readContract({
                address: this.#venueRegistry,
                abi: VENUE_REGISTRY_ABI,
                functionName: "venueIdAt",
                args: [BigInt(i)],
            })) as number;
            const v = (await this.#publicClient.readContract({
                address: this.#venueRegistry,
                abi: VENUE_REGISTRY_ABI,
                functionName: "venues",
                args: [id],
            })) as readonly [number, number, string, string, `0x${string}`, bigint, boolean];
            this.#cache.set(id, {
                id: v[0],
                kind: clampKind(v[1]),
                name: v[2],
                objectType: v[3],
                subAccount: v[4],
                active: v[6],
            });
        }
        this.#log.info({count: n}, "venues: cache hydrated from chain");
        return n;
    }

    start(): void {
        if (this.#started) return;
        if (this.#stopped) throw new Error("VenueMirror: already stopped");
        this.#started = true;
    }

    accept(event: VenueMirrorEvent): void {
        if (this.#stopped) {
            this.#droppedEvents++;
            this.#log.warn({event}, "venues.accept after stop — dropping");
            return;
        }
        if (!Number.isInteger(event.venueId) || event.venueId < 0 || event.venueId > 0xffff_ffff) {
            this.#droppedEvents++;
            this.#log.warn({event}, "venues.accept got non-uint32 venueId — dropping");
            return;
        }
        if (event.kind === "register") {
            if (!Number.isInteger(event.venueKind) || event.venueKind < 0 || event.venueKind > 5) {
                this.#droppedEvents++;
                this.#log.warn({event}, "venues.accept register: venueKind out of [0,5] — dropping");
                return;
            }
        }
        this.#queue.push(event);
        this.#accepted++;

        // Oldest-drop backpressure. Venue events are sparse — hitting this is a producer bug.
        while (this.#queue.length > this.#maxQueuedEvents) {
            this.#queue.shift();
            this.#droppedEvents++;
        }
        this.#ensureWorker();
    }

    /// Returns the cached venue or `undefined`. Used by the spend batcher (M3.x) to attach
    /// `kind` and `subAccount` to each `SpendAuth` without a chain read.
    lookup(venueId: number): CachedVenue | undefined {
        return this.#cache.get(venueId);
    }

    /// Drop every cached venue. Used on a session-change: every entry is keyed by chain
    /// venue id `(epoch << 16) | gameId`, and the new session has a different epoch, so
    /// no cached entry will ever be queried again. Pending in-flight register/rename/
    /// remove ops continue to apply to the chain (they target the *previous* epoch's
    /// chainIds, which are still valid on the long-lived registry); they just won't
    /// re-populate this cache. Counters are preserved.
    clearCache(): void {
        this.#cache.clear();
    }

    /// All currently-cached venues, in insertion order. The IPC `chain.venues.list` reads from
    /// this; rctctl will later expose it as a table.
    list(): CachedVenue[] {
        return [...this.#cache.values()];
    }

    /// Resolves once the queue is empty AND no tx is in flight. Tests use this to await the
    /// worker without sleeping; production callers might use it on shutdown.
    async drain(): Promise<void> {
        if (this.#queue.length === 0 && this.#inFlight === 0) return;
        return new Promise((resolve) => this.#idleResolvers.push(resolve));
    }

    async stop(): Promise<void> {
        if (this.#stopped) return;
        this.#stopped = true;
        // Let the worker drain whatever's queued, then exit naturally.
        if (this.#worker) await this.#worker.catch(() => undefined);
    }

    stats(): VenueMirrorStats {
        return {
            queueDepth: this.#queue.length,
            cacheSize: this.#cache.size,
            accepted: this.#accepted,
            submitted: this.#submitted,
            skippedAlreadyApplied: this.#skippedAlreadyApplied,
            droppedEvents: this.#droppedEvents,
            rpcErrors: this.#rpcErrors,
            lastTxHash: this.#lastTxHash,
            lastSubmitLatencyMs: this.#lastSubmitLatencyMs,
            eventCounts: {...this.#eventCounts},
            started: this.#started,
            stopped: this.#stopped,
            inFlight: this.#inFlight,
        };
    }

    // ---- internals ----

    #ensureWorker(): void {
        if (this.#worker !== undefined) return;
        this.#worker = (async () => {
            try {
                while (this.#queue.length > 0) {
                    const next = this.#queue.shift()!;
                    await this.#processOne(next);
                }
            } finally {
                this.#worker = undefined;
                if (this.#queue.length === 0 && this.#inFlight === 0) {
                    const resolvers = this.#idleResolvers.splice(0);
                    for (const r of resolvers) r();
                }
            }
        })();
    }

    async #processOne(event: VenueMirrorEvent): Promise<void> {
        this.#inFlight++;
        const startedAt = this.#now();
        try {
            const tx = await this.#sendCall(event);
            this.#lastTxHash = tx;
            this.#lastSubmitLatencyMs = this.#now() - startedAt;
            this.#submitted++;
            this.#applyToCache(event);
            this.#eventCounts[event.kind]++;
            this.#log.debug(
                {tx, kind: event.kind, venueId: event.venueId, latencyMs: this.#lastSubmitLatencyMs},
                "venues: event submitted",
            );
        } catch (err) {
            if (isAlreadyAppliedError(err)) {
                this.#skippedAlreadyApplied++;
                // Best-effort: still update the cache so subsequent lookups are correct. The
                // chain has the post-event state already, the local cache shouldn't lag.
                this.#applyToCache(event);
                this.#eventCounts[event.kind]++;
                this.#log.info({event}, "venues: event already applied on-chain — cache updated");
            } else {
                this.#rpcErrors++;
                this.#log.error({err, event}, "venues: event submit failed");
            }
        } finally {
            this.#inFlight--;
            if (this.#queue.length === 0 && this.#inFlight === 0) {
                const resolvers = this.#idleResolvers.splice(0);
                for (const r of resolvers) r();
            }
        }
    }

    #applyToCache(event: VenueMirrorEvent): void {
        switch (event.kind) {
            case "register": {
                const sub = subAccountOf(this.#venueRegistry, event.venueId);
                this.#cache.set(event.venueId, {
                    id: event.venueId,
                    kind: clampKind(event.venueKind),
                    name: event.name,
                    objectType: event.objectType,
                    subAccount: sub,
                    active: true,
                });
                break;
            }
            case "rename": {
                const v = this.#cache.get(event.venueId);
                if (v) v.name = event.newName;
                break;
            }
            case "remove": {
                const v = this.#cache.get(event.venueId);
                if (v) v.active = false;
                break;
            }
        }
    }

    /// M3.15 — submit via `simulateContract → writeContract + confirmTx`. The simulate step
    /// catches the three idempotent reverts (`AlreadyRegistered` / `NotRegistered` /
    /// `AlreadyInactive`) as a structured `ContractFunctionRevertedError`, which
    /// `isAlreadyAppliedError` walks to classify them as `skippedAlreadyApplied` rather than
    /// `rpcErrors`. Execution-time reverts (the chain accepted the tx, executed it, reverted)
    /// surface from `confirmTx` as a generic Error and bump `rpcErrors` — exactly the M3.13
    /// silent-revert fix the other write paths got.
    async #sendCall(event: VenueMirrorEvent): Promise<Hex> {
        const account = this.#walletClient.account!;
        const chain = this.#walletClient.chain ?? undefined;
        const opName = `venue.${event.kind}`;
        // Each branch builds a viem `simulateContract` arg shape with the function-specific
        // tuple. Typed via `Parameters<...>[0]` casts at the call site — the abi-narrowed
        // overloads in viem make a single typed `simulateArgs` variable too tight to express
        // across three different functions, and the cost (lose compile-time arg-tuple
        // checking on three string-literal call sites) is dwarfed by the contract test suite.
        let txHash: Hex;
        switch (event.kind) {
            case "register": {
                const {request} = await this.#publicClient.simulateContract({
                    address: this.#venueRegistry,
                    abi: VENUE_REGISTRY_ABI,
                    functionName: "register",
                    args: [event.venueId, event.venueKind, event.name, event.objectType],
                    account,
                    chain,
                });
                txHash = await this.#walletClient.writeContract(request);
                break;
            }
            case "rename": {
                const {request} = await this.#publicClient.simulateContract({
                    address: this.#venueRegistry,
                    abi: VENUE_REGISTRY_ABI,
                    functionName: "rename",
                    args: [event.venueId, event.newName],
                    account,
                    chain,
                });
                txHash = await this.#walletClient.writeContract(request);
                break;
            }
            case "remove": {
                const {request} = await this.#publicClient.simulateContract({
                    address: this.#venueRegistry,
                    abi: VENUE_REGISTRY_ABI,
                    functionName: "remove",
                    args: [event.venueId],
                    account,
                    chain,
                });
                txHash = await this.#walletClient.writeContract(request);
                break;
            }
        }
        await confirmTx({publicClient: this.#publicClient, txHash, opName});
        return txHash;
    }
}

/// Recognise the contract's three "no-op" reverts. Walks viem's error chain to find a
/// `ContractFunctionRevertedError` and matches the error name. Falls back to string scan for
/// nodes that surface only the message.
function isAlreadyAppliedError(err: unknown): boolean {
    const names = new Set(["AlreadyRegistered", "NotRegistered", "AlreadyInactive"]);
    if (err instanceof BaseError) {
        const reverted = err.walk((e) => e instanceof ContractFunctionRevertedError) as
            | ContractFunctionRevertedError
            | undefined;
        if (reverted?.data?.errorName && names.has(reverted.data.errorName)) return true;
    }
    const msg = err instanceof Error ? err.message : String(err);
    for (const n of names) if (msg.includes(n)) return true;
    return false;
}

function clampKind(k: number): VenueKind {
    if (!Number.isInteger(k) || k < 0 || k > 5) {
        throw new Error(`VenueKind out of [0,5]: ${k}`);
    }
    return k as VenueKind;
}
