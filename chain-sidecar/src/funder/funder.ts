import {encodeFunctionData, type Hex, type PublicClient, type WalletClient} from "viem";
import {DISPERSE_ABI, PARK_TOKEN_ABI, PARK_TREASURY_ABI} from "../chain/abis.js";
import {submitAndConfirm} from "../chain/clients.js";
import {log as defaultLog, type Logger} from "../log.js";

/// Funder (plan §2.3 / §4.4 / M3.5).
///
/// Coalesces incoming `GUEST_ENTRY` events into a sliding window and fans PARK out to N guests
/// in a single chain tx. The path is:
///
///   ownerEOA → ParkTreasury.execute(disperse, 0,
///                Disperse.disperseToken(parkToken, addrs, amts))
///
/// The treasury holds the operating PARK (minted there at park launch by M2.5). Wrapping
/// `disperseToken` in `treasury.execute` makes the treasury appear as `msg.sender` to Disperse,
/// so its `transferFrom(msg.sender, addrs[i], amts[i])` succeeds without the deployer having
/// to hold PARK directly. A one-time `treasury.execute(parkToken, approve(disperse, MAX))`
/// at funder boot enables that path; idempotent if re-run, so we don't bother with state
/// tracking.
///
/// Why a separate window from the batcher: this is low-volume admin (a few hundred entries/s
/// at peak), runs at a slower cadence than guest spends, and a different gas profile. Keeping
/// the queue policy independent makes both easier to reason about.
///
/// Backpressure: oldest-drop on a bounded buffer, mirroring `Batcher`. Plan §10 caps outbox
/// depth far above any realistic park; if the funder still falls behind, it's the canary —
/// the `droppedEntries` counter trips long before any user-visible failure.

/// What the funder accepts. Address comes from `GuestAddressCache.addressOf(hdIndex)` (M2.3);
/// amount is the guest's pocket cash from `GUEST_ENTRY.cash` parsed as a bigint.
export interface FunderEntry {
    address: `0x${string}`;
    amount: bigint;
}

export type FunderFlushReason = "size" | "age" | "manual" | "stop";

export interface FunderOptions {
    walletClient: WalletClient;
    publicClient: PublicClient;
    treasury: `0x${string}`;
    parkToken: `0x${string}`;
    disperse: `0x${string}`;
    /// Defaults match plan §4.4 ("every 200 ms": collects up to 200 new addresses").
    maxSize?: number;
    maxAgeMs?: number;
    /// Drop-oldest threshold for the active buffer. Default 5 000 — generous; a park spawning
    /// 5 000 guests/s would be unusual even under stress mode.
    maxQueuedEntries?: number;
    /// Allowance value pushed at start(). Defaults to a max-uint256 — the treasury approves the
    /// disperse contract once and never re-approves. Tests can pin a smaller value.
    allowance?: bigint;
    log?: Logger;
    /// Injectable timing primitives for tests.
    now?: () => number;
    setTimeout?: typeof setTimeout;
    clearTimeout?: typeof clearTimeout;
}

export const DEFAULT_FUNDER_MAX_SIZE = 200;
export const DEFAULT_FUNDER_MAX_AGE_MS = 200;
export const DEFAULT_FUNDER_MAX_QUEUED = 5_000;
export const DEFAULT_FUNDER_ALLOWANCE = (1n << 256n) - 1n;
/// Reasonable upper bounds — a window > 1024 risks a single tx exceeding a Monad block budget;
/// > 60 s window-age is well past "draining" territory.
const FUNDER_MAX_SIZE_LIMIT = 1024;
const FUNDER_MAX_AGE_LIMIT_MS = 60_000;

export interface FunderStats {
    queueDepth: number;
    maxSize: number;
    maxAgeMs: number;
    maxQueuedEntries: number;
    started: boolean;
    stopped: boolean;
    /// Last successful approval tx; null until `start()` succeeds.
    approvalTx: Hex | null;
    /// Counters since boot.
    accepted: number;
    flushedEntries: number;
    flushedBatches: number;
    droppedEntries: number;
    rpcErrors: number;
    /// Average dispersal-batch fill (`flushedEntries / flushedBatches`) — a rolling indicator
    /// of how often we hit the size flush vs the age flush.
    avgBatchFill: number;
    /// Last batch's submit→confirm latency in ms (from wall-clock around the writeContract).
    lastFlushLatencyMs: number | null;
    flushReasonCounts: Record<FunderFlushReason, number>;
    inFlightBatches: number;
}

/// Sliding-window accumulator that funds entering guests in batches.
export class Funder {
    readonly #walletClient: WalletClient;
    readonly #publicClient: PublicClient;
    readonly #treasury: `0x${string}`;
    readonly #parkToken: `0x${string}`;
    readonly #disperse: `0x${string}`;
    readonly #log: Logger;
    readonly #now: () => number;
    readonly #setTimeout: typeof setTimeout;
    readonly #clearTimeout: typeof clearTimeout;

    #maxSize: number;
    #maxAgeMs: number;
    #maxQueuedEntries: number;
    readonly #allowance: bigint;

    #addrs: `0x${string}`[] = [];
    #amts: bigint[] = [];
    #acceptedAt: number[] = [];
    #ageTimer: ReturnType<typeof setTimeout> | undefined;
    readonly #pending = new Set<Promise<void>>();

    #started = false;
    #stopped = false;
    #approvalTx: Hex | null = null;

    #accepted = 0;
    #flushedEntries = 0;
    #flushedBatches = 0;
    #droppedEntries = 0;
    #rpcErrors = 0;
    #lastFlushLatencyMs: number | null = null;
    readonly #flushReasonCounts: Record<FunderFlushReason, number> = {
        size: 0,
        age: 0,
        manual: 0,
        stop: 0,
    };

    constructor(opts: FunderOptions) {
        if (!opts.walletClient.account) {
            throw new Error("Funder: walletClient missing account — pass a key-bound client");
        }
        for (const [k, v] of [
            ["treasury", opts.treasury],
            ["parkToken", opts.parkToken],
            ["disperse", opts.disperse],
        ] as const) {
            if (!/^0x[0-9a-fA-F]{40}$/.test(v)) {
                throw new Error(`Funder.${k} is not a 20-byte hex address: ${v}`);
            }
        }
        const maxSize = opts.maxSize ?? DEFAULT_FUNDER_MAX_SIZE;
        const maxAgeMs = opts.maxAgeMs ?? DEFAULT_FUNDER_MAX_AGE_MS;
        const maxQueuedEntries = opts.maxQueuedEntries ?? DEFAULT_FUNDER_MAX_QUEUED;
        validateMaxSize(maxSize);
        validateMaxAgeMs(maxAgeMs);
        validateMaxQueuedEntries(maxQueuedEntries);

        this.#walletClient = opts.walletClient;
        this.#publicClient = opts.publicClient;
        this.#treasury = opts.treasury;
        this.#parkToken = opts.parkToken;
        this.#disperse = opts.disperse;
        this.#log = (opts.log ?? defaultLog).child({mod: "funder"});
        this.#now = opts.now ?? Date.now;
        this.#setTimeout = opts.setTimeout ?? setTimeout;
        this.#clearTimeout = opts.clearTimeout ?? clearTimeout;
        this.#maxSize = maxSize;
        this.#maxAgeMs = maxAgeMs;
        this.#maxQueuedEntries = maxQueuedEntries;
        this.#allowance = opts.allowance ?? DEFAULT_FUNDER_ALLOWANCE;
    }

    /// One-time setup: ensure the treasury's allowance to Disperse is at least the configured
    /// value. Idempotent — re-running while already maxed just wastes one tx; we *do* skip the
    /// approve when an on-chain read shows allowance is already at or above target, so a
    /// crash-restart of the sidecar doesn't burn extra MON.
    async start(): Promise<void> {
        if (this.#started) return;
        if (this.#stopped) throw new Error("Funder: already stopped");

        const current = (await this.#publicClient.readContract({
            address: this.#parkToken,
            abi: PARK_TOKEN_ABI,
            functionName: "allowance",
            args: [this.#treasury, this.#disperse],
        })) as bigint;
        if (current >= this.#allowance) {
            this.#log.info(
                {treasury: this.#treasury, disperse: this.#disperse, current: current.toString()},
                "funder: allowance already adequate, skipping approval",
            );
            this.#approvalTx = null;
            this.#started = true;
            return;
        }

        // Two-hop encoding: inner = parkToken.approve(disperse, allowance);
        // outer = treasury.execute(parkToken, 0, inner). Treasury becomes msg.sender to PARK.
        const inner = encodeFunctionData({
            abi: PARK_TOKEN_ABI,
            functionName: "approve",
            args: [this.#disperse, this.#allowance],
        });
        const outer = encodeFunctionData({
            abi: PARK_TREASURY_ABI,
            functionName: "execute",
            args: [this.#parkToken, 0n, inner],
        });
        const tx = await this.#sendTreasuryCall(outer);
        this.#approvalTx = tx;
        this.#started = true;
        this.#log.info(
            {tx, allowance: this.#allowance.toString(), treasury: this.#treasury, disperse: this.#disperse},
            "funder: approval tx confirmed",
        );
    }

    /// Push one entry into the funding window. Synchronous; the actual chain write happens via
    /// the sink path on flush.
    accept(entry: FunderEntry): void {
        if (this.#stopped) {
            this.#droppedEntries++;
            this.#log.warn({entry}, "funder.accept after stop — dropping");
            return;
        }
        if (entry.amount < 0n) {
            // Defensive: a negative amount would overflow uint256 in calldata. Producer bug.
            this.#droppedEntries++;
            this.#log.warn({entry}, "funder.accept got negative amount — dropping");
            return;
        }
        const at = this.#now();
        this.#addrs.push(entry.address);
        this.#amts.push(entry.amount);
        this.#acceptedAt.push(at);
        this.#accepted++;

        // Oldest-drop backpressure on the active buffer; mirrors Batcher.
        while (this.#addrs.length > this.#maxQueuedEntries) {
            this.#addrs.shift();
            this.#amts.shift();
            this.#acceptedAt.shift();
            this.#droppedEntries++;
        }

        if (this.#addrs.length >= this.#maxSize) {
            this.#flushNow("size");
            return;
        }
        if (this.#addrs.length === 1) {
            this.#armAgeTimer();
        }
    }

    flush(): void {
        if (this.#addrs.length > 0) this.#flushNow("manual");
    }

    async stop(): Promise<void> {
        if (this.#stopped) return;
        this.#stopped = true;
        if (this.#ageTimer !== undefined) {
            this.#clearTimeout(this.#ageTimer);
            this.#ageTimer = undefined;
        }
        if (this.#addrs.length > 0) this.#flushNow("stop");
        await Promise.allSettled([...this.#pending]);
    }

    stats(): FunderStats {
        return {
            queueDepth: this.#addrs.length,
            maxSize: this.#maxSize,
            maxAgeMs: this.#maxAgeMs,
            maxQueuedEntries: this.#maxQueuedEntries,
            started: this.#started,
            stopped: this.#stopped,
            approvalTx: this.#approvalTx,
            accepted: this.#accepted,
            flushedEntries: this.#flushedEntries,
            flushedBatches: this.#flushedBatches,
            droppedEntries: this.#droppedEntries,
            rpcErrors: this.#rpcErrors,
            avgBatchFill: this.#flushedBatches === 0 ? 0 : this.#flushedEntries / this.#flushedBatches,
            lastFlushLatencyMs: this.#lastFlushLatencyMs,
            flushReasonCounts: {...this.#flushReasonCounts},
            inFlightBatches: this.#pending.size,
        };
    }

    // ---- internals ----

    #flushNow(reason: FunderFlushReason): void {
        if (this.#addrs.length === 0) return;
        if (this.#ageTimer !== undefined) {
            this.#clearTimeout(this.#ageTimer);
            this.#ageTimer = undefined;
        }
        const addrs = this.#addrs;
        const amts = this.#amts;
        // Reset before the chain call so the buffer is clean for new accepts during sink.
        this.#addrs = [];
        this.#amts = [];
        this.#acceptedAt = [];

        this.#flushedBatches++;
        this.#flushedEntries += addrs.length;
        this.#flushReasonCounts[reason]++;
        const startedAt = this.#now();

        const inner = encodeFunctionData({
            abi: DISPERSE_ABI,
            functionName: "disperseToken",
            args: [this.#parkToken, addrs, amts],
        });
        const outer = encodeFunctionData({
            abi: PARK_TREASURY_ABI,
            functionName: "execute",
            args: [this.#disperse, 0n, inner],
        });

        let p!: Promise<void>;
        p = (async () => {
            try {
                const tx = await this.#sendTreasuryCall(outer);
                this.#lastFlushLatencyMs = this.#now() - startedAt;
                this.#log.debug(
                    {tx, count: addrs.length, reason, latencyMs: this.#lastFlushLatencyMs},
                    "funder: window flushed",
                );
            } catch (err) {
                this.#rpcErrors++;
                this.#log.error({err, count: addrs.length, reason}, "funder: window flush failed");
            } finally {
                this.#pending.delete(p);
            }
        })();
        this.#pending.add(p);
    }

    #armAgeTimer(): void {
        if (this.#ageTimer !== undefined) this.#clearTimeout(this.#ageTimer);
        const oldest = this.#acceptedAt[0]!;
        const remaining = Math.max(0, this.#maxAgeMs - (this.#now() - oldest));
        this.#ageTimer = this.#setTimeout(() => {
            this.#ageTimer = undefined;
            if (this.#addrs.length > 0) this.#flushNow("age");
        }, remaining);
        const t = this.#ageTimer as unknown as {unref?: () => void};
        if (t && typeof t.unref === "function") t.unref();
    }

    /// Submits a single `treasury.execute(...)` tx via the wallet client. We don't `simulate`
    /// here — the calldata is generated by us, the inner call is well-typed, and a simulation
    /// round-trip per window would double the chain load. Errors propagate; the caller bumps
    /// the RPC-error counter. M3.13 + M3.16 — `submitAndConfirm` wraps `sendTransaction` +
    /// receipt-status check + retry on Monad's "Signer had insufficient balance" mempool-lag
    /// error class so the funder's first window-flush (when the operator EOA is freshly
    /// funded) doesn't fail on the RPC node's stale view of the operator's balance.
    async #sendTreasuryCall(data: Hex): Promise<Hex> {
        return submitAndConfirm({
            walletClient: this.#walletClient,
            publicClient: this.#publicClient,
            request: {to: this.#treasury, data, value: 0n},
            opName: "funder.treasury.execute",
            log: this.#log,
        });
    }
}

function validateMaxSize(n: number): void {
    if (!Number.isInteger(n) || n < 1 || n > FUNDER_MAX_SIZE_LIMIT) {
        throw new Error(`Funder.maxSize must be an integer in [1, ${FUNDER_MAX_SIZE_LIMIT}], got ${n}`);
    }
}
function validateMaxAgeMs(n: number): void {
    if (!Number.isInteger(n) || n < 1 || n > FUNDER_MAX_AGE_LIMIT_MS) {
        throw new Error(`Funder.maxAgeMs must be an integer in [1, ${FUNDER_MAX_AGE_LIMIT_MS}], got ${n}`);
    }
}
function validateMaxQueuedEntries(n: number): void {
    if (!Number.isInteger(n) || n < 1 || n > 1_000_000) {
        throw new Error(`Funder.maxQueuedEntries must be an integer in [1, 1000000], got ${n}`);
    }
}
