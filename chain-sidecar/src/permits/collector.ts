import {encodeFunctionData, type Hex, type WalletClient} from "viem";
import {PARK_TOKEN_ABI, PARK_TREASURY_ABI} from "../chain/abis.js";
import {log as defaultLog, type Logger} from "../log.js";
import type {SignedPermit} from "./sign.js";

/// PermitCollector (plan §2.3 / M3.6).
///
/// Buffers per-guest EIP-2612 permit signatures and submits them in batched txs. Each permit
/// is encoded as `parkToken.permit(owner, spender, value, deadline, v, r, s)` and the N
/// permits go on the wire wrapped in `treasury.executeBatch(targets, values, datas)` — all
/// targets are `parkToken`, all values are 0, datas are the N permit calldatas. msg.sender
/// becomes the treasury inside each call, but `permit` doesn't gate on msg.sender (it just
/// recovers the signer from the sig), so this is fine.
///
/// Why piggy-back on `treasury.executeBatch` rather than Multicall3 / a dedicated permit
/// batcher: it's already deployed (M1) and the same wallet client M3.5 uses for the funder
/// can drive it. Adds zero on-chain surface.
///
/// Race with the first GUEST_SPEND: if a spend's `settle` tx lands before the corresponding
/// permit, `transferFrom` reverts because allowance is still 0. For v1 we accept that — the
/// 200 ms permit window is short, the relayer pool's settle latency is comparable, and a
/// handful of opening reverts don't break the demo. M3.10 will add a spend-gate that holds a
/// SpendAuth in the batcher queue until its guest's permit is confirmed.
///
/// Same flush trigger / backpressure shape as M3.5's Funder — keeps both surfaces predictable.

export type PermitFlushReason = "size" | "age" | "manual" | "stop";

export interface PermitCollectorOptions {
    walletClient: WalletClient;
    treasury: `0x${string}`;
    parkToken: `0x${string}`;
    /// Defaults match plan §4.4 (200 entries / 200 ms) so the funder + permit windows run on
    /// the same cadence; on a happy boot, both flushes settle within ~one block of each other.
    maxSize?: number;
    maxAgeMs?: number;
    /// Drop-oldest cap on the active buffer.
    maxQueuedPermits?: number;
    log?: Logger;
    now?: () => number;
    setTimeout?: typeof setTimeout;
    clearTimeout?: typeof clearTimeout;
}

export const DEFAULT_PERMIT_MAX_SIZE = 200;
export const DEFAULT_PERMIT_MAX_AGE_MS = 200;
export const DEFAULT_PERMIT_MAX_QUEUED = 5_000;
const PERMIT_MAX_SIZE_LIMIT = 1024;
const PERMIT_MAX_AGE_LIMIT_MS = 60_000;

export interface PermitCollectorStats {
    queueDepth: number;
    maxSize: number;
    maxAgeMs: number;
    maxQueuedPermits: number;
    stopped: boolean;
    accepted: number;
    flushedPermits: number;
    flushedBatches: number;
    droppedPermits: number;
    rpcErrors: number;
    avgBatchFill: number;
    lastFlushLatencyMs: number | null;
    flushReasonCounts: Record<PermitFlushReason, number>;
    inFlightBatches: number;
}

export class PermitCollector {
    readonly #walletClient: WalletClient;
    readonly #treasury: `0x${string}`;
    readonly #parkToken: `0x${string}`;
    readonly #log: Logger;
    readonly #now: () => number;
    readonly #setTimeout: typeof setTimeout;
    readonly #clearTimeout: typeof clearTimeout;

    #maxSize: number;
    #maxAgeMs: number;
    #maxQueuedPermits: number;

    #queue: SignedPermit[] = [];
    #acceptedAt: number[] = [];
    #ageTimer: ReturnType<typeof setTimeout> | undefined;
    readonly #pending = new Set<Promise<void>>();

    #stopped = false;
    #accepted = 0;
    #flushedPermits = 0;
    #flushedBatches = 0;
    #droppedPermits = 0;
    #rpcErrors = 0;
    #lastFlushLatencyMs: number | null = null;
    readonly #flushReasonCounts: Record<PermitFlushReason, number> = {
        size: 0,
        age: 0,
        manual: 0,
        stop: 0,
    };

    constructor(opts: PermitCollectorOptions) {
        if (!opts.walletClient.account) {
            throw new Error("PermitCollector: walletClient missing account — pass a key-bound client");
        }
        for (const [k, v] of [
            ["treasury", opts.treasury],
            ["parkToken", opts.parkToken],
        ] as const) {
            if (!/^0x[0-9a-fA-F]{40}$/.test(v)) {
                throw new Error(`PermitCollector.${k} is not a 20-byte hex address: ${v}`);
            }
        }
        const maxSize = opts.maxSize ?? DEFAULT_PERMIT_MAX_SIZE;
        const maxAgeMs = opts.maxAgeMs ?? DEFAULT_PERMIT_MAX_AGE_MS;
        const maxQueuedPermits = opts.maxQueuedPermits ?? DEFAULT_PERMIT_MAX_QUEUED;
        validateMaxSize(maxSize);
        validateMaxAgeMs(maxAgeMs);
        validateMaxQueued(maxQueuedPermits);

        this.#walletClient = opts.walletClient;
        this.#treasury = opts.treasury;
        this.#parkToken = opts.parkToken;
        this.#log = (opts.log ?? defaultLog).child({mod: "permits"});
        this.#now = opts.now ?? Date.now;
        this.#setTimeout = opts.setTimeout ?? setTimeout;
        this.#clearTimeout = opts.clearTimeout ?? clearTimeout;
        this.#maxSize = maxSize;
        this.#maxAgeMs = maxAgeMs;
        this.#maxQueuedPermits = maxQueuedPermits;
    }

    accept(permit: SignedPermit): void {
        if (this.#stopped) {
            this.#droppedPermits++;
            this.#log.warn({owner: permit.args.owner}, "permits.accept after stop — dropping");
            return;
        }
        const at = this.#now();
        this.#queue.push(permit);
        this.#acceptedAt.push(at);
        this.#accepted++;

        while (this.#queue.length > this.#maxQueuedPermits) {
            this.#queue.shift();
            this.#acceptedAt.shift();
            this.#droppedPermits++;
        }

        if (this.#queue.length >= this.#maxSize) {
            this.#flushNow("size");
            return;
        }
        if (this.#queue.length === 1) this.#armAgeTimer();
    }

    flush(): void {
        if (this.#queue.length > 0) this.#flushNow("manual");
    }

    async stop(): Promise<void> {
        if (this.#stopped) return;
        this.#stopped = true;
        if (this.#ageTimer !== undefined) {
            this.#clearTimeout(this.#ageTimer);
            this.#ageTimer = undefined;
        }
        if (this.#queue.length > 0) this.#flushNow("stop");
        await Promise.allSettled([...this.#pending]);
    }

    stats(): PermitCollectorStats {
        return {
            queueDepth: this.#queue.length,
            maxSize: this.#maxSize,
            maxAgeMs: this.#maxAgeMs,
            maxQueuedPermits: this.#maxQueuedPermits,
            stopped: this.#stopped,
            accepted: this.#accepted,
            flushedPermits: this.#flushedPermits,
            flushedBatches: this.#flushedBatches,
            droppedPermits: this.#droppedPermits,
            rpcErrors: this.#rpcErrors,
            avgBatchFill: this.#flushedBatches === 0 ? 0 : this.#flushedPermits / this.#flushedBatches,
            lastFlushLatencyMs: this.#lastFlushLatencyMs,
            flushReasonCounts: {...this.#flushReasonCounts},
            inFlightBatches: this.#pending.size,
        };
    }

    // ---- internals ----

    #flushNow(reason: PermitFlushReason): void {
        if (this.#queue.length === 0) return;
        if (this.#ageTimer !== undefined) {
            this.#clearTimeout(this.#ageTimer);
            this.#ageTimer = undefined;
        }
        const queue = this.#queue;
        this.#queue = [];
        this.#acceptedAt = [];

        this.#flushedBatches++;
        this.#flushedPermits += queue.length;
        this.#flushReasonCounts[reason]++;
        const startedAt = this.#now();

        // Build N permit calldatas and pack them through executeBatch. All targets are
        // parkToken; all values are 0. Treasury becomes msg.sender to parkToken on each call,
        // which is a no-op for permit (signature is what authorizes the approval).
        const targets: `0x${string}`[] = new Array(queue.length).fill(this.#parkToken);
        const values: bigint[] = new Array(queue.length).fill(0n);
        const datas: Hex[] = queue.map((p) =>
            encodeFunctionData({
                abi: PARK_TOKEN_ABI,
                functionName: "permit",
                args: [p.args.owner, p.args.spender, p.args.value, p.args.deadline, p.v, p.r, p.s],
            }),
        );
        const outer = encodeFunctionData({
            abi: PARK_TREASURY_ABI,
            functionName: "executeBatch",
            args: [targets, values, datas],
        });

        let p!: Promise<void>;
        p = (async () => {
            try {
                const tx = await this.#sendTreasuryCall(outer);
                this.#lastFlushLatencyMs = this.#now() - startedAt;
                this.#log.debug(
                    {tx, count: queue.length, reason, latencyMs: this.#lastFlushLatencyMs},
                    "permits: window flushed",
                );
            } catch (err) {
                this.#rpcErrors++;
                this.#log.error({err, count: queue.length, reason}, "permits: window flush failed");
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
            if (this.#queue.length > 0) this.#flushNow("age");
        }, remaining);
        const t = this.#ageTimer as unknown as {unref?: () => void};
        if (t && typeof t.unref === "function") t.unref();
    }

    async #sendTreasuryCall(data: Hex): Promise<Hex> {
        const account = this.#walletClient.account!;
        const chain = this.#walletClient.chain ?? null;
        return this.#walletClient.sendTransaction({
            account,
            chain,
            to: this.#treasury,
            data,
            value: 0n,
        });
    }
}

function validateMaxSize(n: number): void {
    if (!Number.isInteger(n) || n < 1 || n > PERMIT_MAX_SIZE_LIMIT) {
        throw new Error(`PermitCollector.maxSize must be an integer in [1, ${PERMIT_MAX_SIZE_LIMIT}], got ${n}`);
    }
}
function validateMaxAgeMs(n: number): void {
    if (!Number.isInteger(n) || n < 1 || n > PERMIT_MAX_AGE_LIMIT_MS) {
        throw new Error(`PermitCollector.maxAgeMs must be an integer in [1, ${PERMIT_MAX_AGE_LIMIT_MS}], got ${n}`);
    }
}
function validateMaxQueued(n: number): void {
    if (!Number.isInteger(n) || n < 1 || n > 1_000_000) {
        throw new Error(`PermitCollector.maxQueuedPermits must be an integer in [1, 1000000], got ${n}`);
    }
}
