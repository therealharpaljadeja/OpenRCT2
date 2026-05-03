import {encodeFunctionData, type Hex, type PublicClient, type WalletClient} from "viem";
import type {LocalAccount} from "viem/accounts";
import {PARK_TOKEN_ABI, PARK_TREASURY_ABI} from "../chain/abis.js";
import {log as defaultLog, type Logger} from "../log.js";
import {signPermit, type PermitDomain} from "../permits/sign.js";

/// Sweeper (plan §2.3 / §4.4 / M3.7).
///
/// On `GUEST_EXIT`, returns the guest's remaining PARK balance to the treasury. The plan calls
/// for "a single `transferFrom` (their permit is still valid)" — but the entry-time permit
/// grants the *SettlementBatcher* allowance, not the treasury. There's no sweep entrypoint on
/// the deployed batcher, so v1 takes a slightly different path: at exit we sign a *fresh*
/// EIP-2612 permit with `spender = treasury`, then submit:
///
///   ownerEOA → ParkTreasury.executeBatch(
///       [parkToken, parkToken, ...],
///       [0, 0, ...],
///       [permit(g_i, treasury, bal_i, ...), transferFrom(g_i, treasury, bal_i), ...]
///   )
///
/// Treasury becomes msg.sender to ParkToken on each calldata; the permit grants treasury
/// allowance, the transferFrom drains it, allowance is consumed, balance flows back. We pack
/// up to N (permit, transferFrom) pairs per tx, same shape as M3.5's funder / M3.6's permit
/// collector — sliding window, oldest-drop backpressure, IPC stats. Order within executeBatch
/// matters (permit_i must come before transferFrom_i); we interleave.
///
/// Race with concurrent spend: a SpendAuth that lands between our `balanceOf` read and the
/// sweep tx will reduce the guest's balance, causing the sweep `transferFrom` to revert and
/// roll back the entire executeBatch. v1 accepts this: exits are slow relative to spend; one
/// failed sweep just bumps `rpcErrors` and the guest's residue stays unswept until a future
/// reconcile. M3.10 will add proper retry-with-rebal logic; for now we log loud.
///
/// Why a fresh permit per exit (not a second permit at entry): exits are sparse compared to
/// entries, so reading one extra `nonces(...)` per exit is cheap; entry-time signing volume
/// already does ~N permits per second under load, doubling that to support a future sweep is
/// avoidable.

/// Buffered exit event. `hdIndex` is needed so the sweeper can derive the guest's HDAccount
/// and sign the new permit; `address` is the cached address the rest of the sidecar uses.
export interface SweeperEntry {
    hdIndex: number;
    address: `0x${string}`;
}

export type SweeperFlushReason = "size" | "age" | "manual" | "stop";

export interface SweeperOptions {
    walletClient: WalletClient;
    publicClient: PublicClient;
    treasury: `0x${string}`;
    parkToken: `0x${string}`;
    /// EIP-712 domain matching ParkToken's `ERC20Permit("Park")` constructor. Reuses the same
    /// domain object PermitCollector uses for entry permits; sweep permits sign under the same
    /// domain, just with a different `spender` (treasury vs SettlementBatcher).
    permitDomain: PermitDomain;
    /// Resolves an `hdIndex` to the guest's `LocalAccount` so the sweeper can sign on their
    /// behalf. Injected so tests can mock (and so production can decide whether to derive
    /// on-demand vs cache HDAccounts).
    deriveAccount: (hdIndex: number) => LocalAccount;
    /// Days from now to use as the permit's `deadline`. The sweep tx is expected to land within
    /// the next batch (~200 ms), so even a 1-day deadline is plenty — but matching M3.6's
    /// 30-day default keeps operator knobs symmetric.
    permitDeadlineDays?: number;
    /// Window cadence — defaults match the funder / permit collector so all three windows
    /// settle on adjacent blocks.
    maxSize?: number;
    maxAgeMs?: number;
    /// Drop-oldest cap on the active buffer.
    maxQueuedExits?: number;
    log?: Logger;
    /// Injectable timing primitives for tests.
    now?: () => number;
    setTimeout?: typeof setTimeout;
    clearTimeout?: typeof clearTimeout;
}

export const DEFAULT_SWEEPER_MAX_SIZE = 200;
export const DEFAULT_SWEEPER_MAX_AGE_MS = 200;
export const DEFAULT_SWEEPER_MAX_QUEUED = 5_000;
export const DEFAULT_SWEEPER_PERMIT_DEADLINE_DAYS = 30;
const SWEEPER_MAX_SIZE_LIMIT = 1024;
const SWEEPER_MAX_AGE_LIMIT_MS = 60_000;
const SWEEPER_MAX_DEADLINE_DAYS = 365;

export interface SweeperStats {
    queueDepth: number;
    maxSize: number;
    maxAgeMs: number;
    maxQueuedExits: number;
    stopped: boolean;
    /// Counters since boot.
    accepted: number;
    /// Exits actually swept (i.e. balance > 0 at flush time, sign+send didn't error).
    flushedExits: number;
    /// Exits with zero balance — no tx needed. Counted separately so a busy park doesn't look
    /// like a stalled sweeper just because most guests leave broke.
    zeroBalanceExits: number;
    flushedBatches: number;
    droppedExits: number;
    rpcErrors: number;
    /// Average sweep-batch fill (`flushedExits / flushedBatches`).
    avgBatchFill: number;
    lastFlushLatencyMs: number | null;
    flushReasonCounts: Record<SweeperFlushReason, number>;
    inFlightBatches: number;
}

/// Sliding-window sweeper. See module docstring for the on-chain path.
export class Sweeper {
    readonly #walletClient: WalletClient;
    readonly #publicClient: PublicClient;
    readonly #treasury: `0x${string}`;
    readonly #parkToken: `0x${string}`;
    readonly #permitDomain: PermitDomain;
    readonly #deriveAccount: (hdIndex: number) => LocalAccount;
    readonly #permitDeadlineDays: number;
    readonly #log: Logger;
    readonly #now: () => number;
    readonly #setTimeout: typeof setTimeout;
    readonly #clearTimeout: typeof clearTimeout;

    #maxSize: number;
    #maxAgeMs: number;
    #maxQueuedExits: number;

    #queue: SweeperEntry[] = [];
    #acceptedAt: number[] = [];
    #ageTimer: ReturnType<typeof setTimeout> | undefined;
    readonly #pending = new Set<Promise<void>>();

    #stopped = false;
    #accepted = 0;
    #flushedExits = 0;
    #zeroBalanceExits = 0;
    #flushedBatches = 0;
    #droppedExits = 0;
    #rpcErrors = 0;
    #lastFlushLatencyMs: number | null = null;
    readonly #flushReasonCounts: Record<SweeperFlushReason, number> = {
        size: 0,
        age: 0,
        manual: 0,
        stop: 0,
    };

    constructor(opts: SweeperOptions) {
        if (!opts.walletClient.account) {
            throw new Error("Sweeper: walletClient missing account — pass a key-bound client");
        }
        for (const [k, v] of [
            ["treasury", opts.treasury],
            ["parkToken", opts.parkToken],
        ] as const) {
            if (!/^0x[0-9a-fA-F]{40}$/.test(v)) {
                throw new Error(`Sweeper.${k} is not a 20-byte hex address: ${v}`);
            }
        }
        const maxSize = opts.maxSize ?? DEFAULT_SWEEPER_MAX_SIZE;
        const maxAgeMs = opts.maxAgeMs ?? DEFAULT_SWEEPER_MAX_AGE_MS;
        const maxQueuedExits = opts.maxQueuedExits ?? DEFAULT_SWEEPER_MAX_QUEUED;
        const permitDeadlineDays = opts.permitDeadlineDays ?? DEFAULT_SWEEPER_PERMIT_DEADLINE_DAYS;
        validateMaxSize(maxSize);
        validateMaxAgeMs(maxAgeMs);
        validateMaxQueued(maxQueuedExits);
        validateDeadlineDays(permitDeadlineDays);

        this.#walletClient = opts.walletClient;
        this.#publicClient = opts.publicClient;
        this.#treasury = opts.treasury;
        this.#parkToken = opts.parkToken;
        this.#permitDomain = opts.permitDomain;
        this.#deriveAccount = opts.deriveAccount;
        this.#permitDeadlineDays = permitDeadlineDays;
        this.#log = (opts.log ?? defaultLog).child({mod: "sweeper"});
        this.#now = opts.now ?? Date.now;
        this.#setTimeout = opts.setTimeout ?? setTimeout;
        this.#clearTimeout = opts.clearTimeout ?? clearTimeout;
        this.#maxSize = maxSize;
        this.#maxAgeMs = maxAgeMs;
        this.#maxQueuedExits = maxQueuedExits;
    }

    accept(entry: SweeperEntry): void {
        if (this.#stopped) {
            this.#droppedExits++;
            this.#log.warn({entry}, "sweeper.accept after stop — dropping");
            return;
        }
        if (!Number.isInteger(entry.hdIndex) || entry.hdIndex < 0) {
            this.#droppedExits++;
            this.#log.warn({entry}, "sweeper.accept got non-integer hdIndex — dropping");
            return;
        }
        if (!/^0x[0-9a-fA-F]{40}$/.test(entry.address)) {
            this.#droppedExits++;
            this.#log.warn({entry}, "sweeper.accept got malformed address — dropping");
            return;
        }
        const at = this.#now();
        this.#queue.push(entry);
        this.#acceptedAt.push(at);
        this.#accepted++;

        while (this.#queue.length > this.#maxQueuedExits) {
            this.#queue.shift();
            this.#acceptedAt.shift();
            this.#droppedExits++;
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

    stats(): SweeperStats {
        return {
            queueDepth: this.#queue.length,
            maxSize: this.#maxSize,
            maxAgeMs: this.#maxAgeMs,
            maxQueuedExits: this.#maxQueuedExits,
            stopped: this.#stopped,
            accepted: this.#accepted,
            flushedExits: this.#flushedExits,
            zeroBalanceExits: this.#zeroBalanceExits,
            flushedBatches: this.#flushedBatches,
            droppedExits: this.#droppedExits,
            rpcErrors: this.#rpcErrors,
            avgBatchFill: this.#flushedBatches === 0 ? 0 : this.#flushedExits / this.#flushedBatches,
            lastFlushLatencyMs: this.#lastFlushLatencyMs,
            flushReasonCounts: {...this.#flushReasonCounts},
            inFlightBatches: this.#pending.size,
        };
    }

    // ---- internals ----

    #flushNow(reason: SweeperFlushReason): void {
        if (this.#queue.length === 0) return;
        if (this.#ageTimer !== undefined) {
            this.#clearTimeout(this.#ageTimer);
            this.#ageTimer = undefined;
        }
        const queue = this.#queue;
        this.#queue = [];
        this.#acceptedAt = [];

        this.#flushedBatches++;
        this.#flushReasonCounts[reason]++;
        const startedAt = this.#now();

        let p!: Promise<void>;
        p = (async () => {
            try {
                const built = await this.#buildSweepCalldatas(queue);
                if (built.signedExits === 0) {
                    // Everyone in this window left broke — no tx to send. Counter still reflects
                    // the batch attempt for parity with the funder; lastFlushLatencyMs gets the
                    // read-only path's time.
                    this.#lastFlushLatencyMs = this.#now() - startedAt;
                    this.#log.debug(
                        {count: queue.length, reason, latencyMs: this.#lastFlushLatencyMs},
                        "sweeper: window had zero net balance — no tx",
                    );
                    return;
                }
                const tx = await this.#sendTreasuryCall(built.calldata);
                this.#flushedExits += built.signedExits;
                this.#lastFlushLatencyMs = this.#now() - startedAt;
                this.#log.debug(
                    {
                        tx,
                        signed: built.signedExits,
                        zero: built.zeroBalance,
                        reason,
                        latencyMs: this.#lastFlushLatencyMs,
                    },
                    "sweeper: window flushed",
                );
            } catch (err) {
                this.#rpcErrors++;
                this.#log.error({err, count: queue.length, reason}, "sweeper: window flush failed");
            } finally {
                this.#pending.delete(p);
            }
        })();
        this.#pending.add(p);
    }

    /// Read every guest's `(balance, nonce)`, drop the broke ones, sign permits for the rest,
    /// and build a single `treasury.executeBatch` calldata. Returns the calldata + how many
    /// exits made it in. Throws on any RPC / signing error so the caller bumps `rpcErrors`.
    async #buildSweepCalldatas(
        entries: SweeperEntry[],
    ): Promise<{calldata: Hex; signedExits: number; zeroBalance: number}> {
        // Parallel fan-out: one balanceOf + one nonces per guest. publicClient is connection-
        // pooled by viem so this scales linearly with relayer-pool RPC concurrency.
        const reads = await Promise.all(
            entries.map(async (e) => {
                const [balance, nonce] = await Promise.all([
                    this.#publicClient.readContract({
                        address: this.#parkToken,
                        abi: PARK_TOKEN_ABI,
                        functionName: "balanceOf",
                        args: [e.address],
                    }) as Promise<bigint>,
                    this.#publicClient.readContract({
                        address: this.#parkToken,
                        abi: PARK_TOKEN_ABI,
                        functionName: "nonces",
                        args: [e.address],
                    }) as Promise<bigint>,
                ]);
                return {entry: e, balance, nonce};
            }),
        );

        const targets: `0x${string}`[] = [];
        const values: bigint[] = [];
        const datas: Hex[] = [];
        let zeroBalance = 0;
        const deadline = BigInt(Math.floor(this.#now() / 1000)) + BigInt(this.#permitDeadlineDays) * 86_400n;

        for (const r of reads) {
            if (r.balance === 0n) {
                zeroBalance++;
                this.#zeroBalanceExits++;
                continue;
            }
            const account = this.#deriveAccount(r.entry.hdIndex);
            if (account.address.toLowerCase() !== r.entry.address.toLowerCase()) {
                // hdIndex / address mismatch — producer bug. Don't sweep.
                this.#droppedExits++;
                this.#log.warn(
                    {hdIndex: r.entry.hdIndex, claimed: r.entry.address, derived: account.address},
                    "sweeper: hdIndex address mismatch — dropping",
                );
                continue;
            }
            const signed = await signPermit(account, this.#permitDomain, {
                owner: r.entry.address,
                spender: this.#treasury,
                value: r.balance,
                nonce: r.nonce,
                deadline,
            });
            // Interleave [permit_i, transferFrom_i] so each guest's permit lands before its
            // transferFrom inside executeBatch's sequential calldata loop.
            targets.push(this.#parkToken, this.#parkToken);
            values.push(0n, 0n);
            datas.push(
                encodeFunctionData({
                    abi: PARK_TOKEN_ABI,
                    functionName: "permit",
                    args: [
                        signed.args.owner,
                        signed.args.spender,
                        signed.args.value,
                        signed.args.deadline,
                        signed.v,
                        signed.r,
                        signed.s,
                    ],
                }),
                encodeFunctionData({
                    abi: PARK_TOKEN_ABI,
                    functionName: "transferFrom",
                    args: [r.entry.address, this.#treasury, r.balance],
                }),
            );
        }

        const calldata = encodeFunctionData({
            abi: PARK_TREASURY_ABI,
            functionName: "executeBatch",
            args: [targets, values, datas],
        });
        return {calldata, signedExits: targets.length / 2, zeroBalance};
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
    if (!Number.isInteger(n) || n < 1 || n > SWEEPER_MAX_SIZE_LIMIT) {
        throw new Error(`Sweeper.maxSize must be an integer in [1, ${SWEEPER_MAX_SIZE_LIMIT}], got ${n}`);
    }
}
function validateMaxAgeMs(n: number): void {
    if (!Number.isInteger(n) || n < 1 || n > SWEEPER_MAX_AGE_LIMIT_MS) {
        throw new Error(`Sweeper.maxAgeMs must be an integer in [1, ${SWEEPER_MAX_AGE_LIMIT_MS}], got ${n}`);
    }
}
function validateMaxQueued(n: number): void {
    if (!Number.isInteger(n) || n < 1 || n > 1_000_000) {
        throw new Error(`Sweeper.maxQueuedExits must be an integer in [1, 1000000], got ${n}`);
    }
}
function validateDeadlineDays(n: number): void {
    if (!Number.isInteger(n) || n < 1 || n > SWEEPER_MAX_DEADLINE_DAYS) {
        throw new Error(`Sweeper.permitDeadlineDays must be an integer in [1, ${SWEEPER_MAX_DEADLINE_DAYS}], got ${n}`);
    }
}
