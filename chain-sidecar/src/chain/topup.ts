import {log as rootLog, type Logger} from "../log.js";
import type {BalanceReader} from "./balances.js";
import type {FaucetWriter} from "./faucet.js";

export interface RelayerTopUpOptions {
    relayers: readonly `0x${string}`[];
    /// If a relayer's MON falls below this, top it up. A conservative low-water leaves
    /// enough headroom that a single batch tx can't drain a relayer mid-flight.
    lowWater: bigint;
    /// Bring under-threshold relayers up to this balance. Must be > lowWater.
    target: bigint;
    /// How often to re-check balances. Plan §4.3 expects `eth_sendRawTransactionSync` calls
    /// to succeed within ~1 block, so 30s of latency is fine — top-up is a slow safety net,
    /// not the hot path.
    intervalMs?: number;
    log?: Logger;
}

export interface RelayerTopUpStats {
    running: boolean;
    /// Wall-clock of the most recent successful balance check (ms since epoch).
    lastCheckedAt: number;
    /// How many relayers needed a refill on the most recent tick.
    lastRefilled: number;
    /// Cumulative count of ticks where `dripMon` was issued.
    refillTxCount: number;
    /// Cumulative count of relayer-tops (each refill tx may cover multiple relayers).
    refillRelayerCount: number;
    /// Last refill's tx hash (`undefined` if no refill has happened yet).
    lastRefillTx?: `0x${string}`;
    /// The most recent observed balances, address → wei. Surfaces in `chain.topup.status`.
    lastBalances: Record<`0x${string}`, string>;
    errors: number;
}

const DEFAULT_INTERVAL_MS = 30_000;

/// Periodic loop: every `intervalMs`, read each relayer's MON balance, and if any are below
/// `lowWater`, fire a single `dripMon` to bring the under-threshold subset up to `target`.
///
/// Sequential / batched: we never fire concurrent `dripMon`s — the faucet owner's nonce
/// would race. One `Promise<void>` worth of work per tick.
///
/// Why batch the refill: §4.3 of the plan keeps the per-EOA nonce sequence the bottleneck
/// for the relayer pool. The faucet owner's nonce is its own sequence; we still want to
/// minimize tx count there to leave block budget for `settle` calls.
export class RelayerTopUp {
    readonly #balances: BalanceReader;
    readonly #faucet: FaucetWriter;
    readonly #relayers: readonly `0x${string}`[];
    readonly #lowWater: bigint;
    readonly #target: bigint;
    readonly #intervalMs: number;
    readonly #log: Logger;
    #running = false;
    #stopWanted = false;
    #stats: RelayerTopUpStats;
    #loopDone: Promise<void> | undefined;

    constructor(balances: BalanceReader, faucet: FaucetWriter, opts: RelayerTopUpOptions) {
        if (opts.target <= opts.lowWater) {
            throw new Error(`RelayerTopUp: target (${opts.target}) must exceed lowWater (${opts.lowWater})`);
        }
        if (opts.relayers.length === 0) throw new Error("RelayerTopUp: empty relayer list");
        this.#balances = balances;
        this.#faucet = faucet;
        this.#relayers = opts.relayers;
        this.#lowWater = opts.lowWater;
        this.#target = opts.target;
        this.#intervalMs = opts.intervalMs ?? DEFAULT_INTERVAL_MS;
        this.#log = (opts.log ?? rootLog).child({topup: "relayer"});
        this.#stats = {
            running: false,
            lastCheckedAt: 0,
            lastRefilled: 0,
            refillTxCount: 0,
            refillRelayerCount: 0,
            lastBalances: {},
            errors: 0,
        };
    }

    start(): void {
        if (this.#running) throw new Error("RelayerTopUp already running");
        this.#running = true;
        this.#stopWanted = false;
        this.#stats.running = true;
        this.#log.info(
            {
                relayers: this.#relayers.length,
                lowWater: this.#lowWater.toString(),
                target: this.#target.toString(),
                intervalMs: this.#intervalMs,
            },
            "relayer top-up loop starting",
        );
        this.#loopDone = this.#loop();
    }

    async stop(): Promise<void> {
        if (!this.#running) return;
        this.#stopWanted = true;
        await this.#loopDone;
        this.#running = false;
        this.#stats.running = false;
        this.#log.info({stats: this.#statsForLog()}, "relayer top-up loop stopped");
    }

    /// Run a single check now — returns whether any refill was issued. Used by tests and by
    /// the `chain.faucet.drip` JSON-RPC handler so the operator can force a top-up without
    /// waiting for the next interval.
    async tickOnce(): Promise<boolean> {
        return this.#tick();
    }

    stats(): RelayerTopUpStats {
        return {
            ...this.#stats,
            lastBalances: {...this.#stats.lastBalances},
        };
    }

    // --------------------------------------------------------------------------------------

    async #loop(): Promise<void> {
        while (!this.#stopWanted) {
            try {
                await this.#tick();
            } catch (err) {
                this.#stats.errors++;
                this.#log.error({err}, "relayer top-up tick failed");
            }
            // Bounded sleep that observes `stop()` quickly enough — break the wait into
            // 100ms chunks so shutdown isn't held up by a long interval.
            const deadline = Date.now() + this.#intervalMs;
            while (!this.#stopWanted && Date.now() < deadline) {
                await sleep(Math.min(100, deadline - Date.now()));
            }
        }
    }

    async #tick(): Promise<boolean> {
        const balances = await this.#balances.nativeBalances(this.#relayers);
        this.#stats.lastCheckedAt = Date.now();
        this.#stats.lastBalances = {};
        const under: {addr: `0x${string}`; need: bigint}[] = [];
        for (let i = 0; i < this.#relayers.length; i++) {
            const addr = this.#relayers[i]!;
            const bal = balances[i]!;
            this.#stats.lastBalances[addr] = bal.toString();
            if (bal < this.#lowWater) {
                under.push({addr, need: this.#target - bal});
            }
        }
        this.#stats.lastRefilled = under.length;
        if (under.length === 0) return false;

        const txHash = await this.#faucet.dripMon(
            under.map((u) => u.addr),
            under.map((u) => u.need),
        );
        this.#stats.refillTxCount++;
        this.#stats.refillRelayerCount += under.length;
        this.#stats.lastRefillTx = txHash;
        this.#log.info(
            {refilled: under.length, tx: txHash, addrs: under.map((u) => u.addr)},
            "relayer top-up issued",
        );
        return true;
    }

    #statsForLog(): Record<string, unknown> {
        const {lastBalances, ...rest} = this.#stats;
        return {...rest, balanceCount: Object.keys(lastBalances).length};
    }
}

function sleep(ms: number): Promise<void> {
    return new Promise((r) => setTimeout(r, ms));
}
