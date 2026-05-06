import type {PublicClient, WalletClient} from "viem";
import {log as rootLog, type Logger} from "../log.js";
import type {BalanceReader} from "./balances.js";
import {confirmTx} from "./clients.js";

/// Keeps the Faucet contract's MON reserve topped up from the deployer's EOA.
///
/// Pipeline shape:
///   Deployer EOA  ──(plain MON send via receive())──>  Faucet contract
///   Faucet contract  ──(dripMon, by RelayerTopUp)──>  Relayers / operators
///   Relayers  ──(SettlementBatcher.settle)──>  on-chain GuestSpend
///
/// RelayerTopUp keeps relayers funded out of the *Faucet contract* balance. This loop
/// keeps the *Faucet contract* funded out of the *deployer EOA*. As long as the deployer
/// has MON, the whole pipeline self-heals; the only failure mode worth alarming on is the
/// deployer itself running dry.
export interface FaucetReserveTopUpOptions {
    faucet: `0x${string}`;
    /// Wallet client signing as the deployer (= `Faucet.owner()`). The bound account funds
    /// the refill transactions and pays gas. Must already match the on-chain owner — the
    /// boot-time owner check catches misconfigurations before this loop ever runs.
    deployerWalletClient: WalletClient;
    publicClient: PublicClient;
    balances: BalanceReader;
    /// If the Faucet contract balance falls below this, refill it.
    lowWater: bigint;
    /// Refill bring the Faucet up to this. Must be > lowWater.
    target: bigint;
    /// Hard floor on the deployer's MON balance. We never refill the Faucet if doing so
    /// would push the deployer below this. When the deployer is *already* below this floor
    /// we emit a CRITICAL log every tick and skip refills entirely — the only signal the
    /// human operator needs to manually fund the deployer from the testnet faucet.
    deployerCriticalFloor: bigint;
    /// Poll cadence. Default 30 s — refill is a slow safety net, not the hot path.
    intervalMs?: number;
    log?: Logger;
}

export interface FaucetReserveTopUpStats {
    running: boolean;
    lastCheckedAt: number;
    lastFaucetBalance: string;
    lastDeployerBalance: string;
    deployerAddress: `0x${string}` | null;
    refillTxCount: number;
    lastRefillTx?: `0x${string}`;
    /// True iff the deployer is currently below `deployerCriticalFloor`. Surfaces in
    /// `chain.faucetReserve.status` so the in-game terminal can show a banner.
    deployerCritical: boolean;
    errors: number;
}

const DEFAULT_INTERVAL_MS = 30_000;

export class FaucetReserveTopUp {
    readonly #faucet: `0x${string}`;
    readonly #wallet: WalletClient;
    readonly #publicClient: PublicClient;
    readonly #balances: BalanceReader;
    readonly #lowWater: bigint;
    readonly #target: bigint;
    readonly #floor: bigint;
    readonly #intervalMs: number;
    readonly #log: Logger;
    #running = false;
    #stopWanted = false;
    #stats: FaucetReserveTopUpStats;
    #loopDone: Promise<void> | undefined;

    constructor(opts: FaucetReserveTopUpOptions) {
        if (opts.target <= opts.lowWater) {
            throw new Error(`FaucetReserveTopUp: target (${opts.target}) must exceed lowWater (${opts.lowWater})`);
        }
        if (!opts.deployerWalletClient.account) {
            throw new Error("FaucetReserveTopUp: deployerWalletClient missing account");
        }
        this.#faucet = opts.faucet;
        this.#wallet = opts.deployerWalletClient;
        this.#publicClient = opts.publicClient;
        this.#balances = opts.balances;
        this.#lowWater = opts.lowWater;
        this.#target = opts.target;
        this.#floor = opts.deployerCriticalFloor;
        this.#intervalMs = opts.intervalMs ?? DEFAULT_INTERVAL_MS;
        this.#log = (opts.log ?? rootLog).child({mod: "faucet-reserve"});
        this.#stats = {
            running: false,
            lastCheckedAt: 0,
            lastFaucetBalance: "0",
            lastDeployerBalance: "0",
            deployerAddress: this.#wallet.account!.address as `0x${string}`,
            refillTxCount: 0,
            deployerCritical: false,
            errors: 0,
        };
    }

    start(): void {
        if (this.#running) throw new Error("FaucetReserveTopUp already running");
        this.#running = true;
        this.#stopWanted = false;
        this.#stats.running = true;
        this.#log.info(
            {
                faucet: this.#faucet,
                deployer: this.#wallet.account!.address,
                lowWater: this.#lowWater.toString(),
                target: this.#target.toString(),
                floor: this.#floor.toString(),
                intervalMs: this.#intervalMs,
            },
            "faucet-reserve loop starting",
        );
        this.#loopDone = this.#loop();
    }

    async stop(): Promise<void> {
        if (!this.#running) return;
        this.#stopWanted = true;
        await this.#loopDone;
        this.#running = false;
        this.#stats.running = false;
    }

    /// Single-shot tick. Returns true iff a refill tx was sent. Used at boot so the
    /// Faucet is filled before the first `RelayerTopUp.tickOnce()` tries to drip from it.
    async tickOnce(): Promise<boolean> {
        return this.#tick();
    }

    stats(): FaucetReserveTopUpStats {
        return {...this.#stats};
    }

    async #loop(): Promise<void> {
        while (!this.#stopWanted) {
            try {
                await this.#tick();
            } catch (err) {
                this.#stats.errors++;
                this.#log.error({err}, "faucet-reserve tick failed");
            }
            const deadline = Date.now() + this.#intervalMs;
            while (!this.#stopWanted && Date.now() < deadline) {
                await sleep(Math.min(200, deadline - Date.now()));
            }
        }
    }

    async #tick(): Promise<boolean> {
        const deployer = this.#wallet.account!.address as `0x${string}`;
        const balances = await this.#balances.nativeBalances([this.#faucet, deployer]);
        const faucetBal = balances[0]!;
        const deployerBal = balances[1]!;
        this.#stats.lastCheckedAt = Date.now();
        this.#stats.lastFaucetBalance = faucetBal.toString();
        this.#stats.lastDeployerBalance = deployerBal.toString();

        if (deployerBal < this.#floor) {
            // CRITICAL — deployer is the root of the funding chain. Once it's empty we can't
            // top the faucet, so RelayerTopUp will eventually drain it, then settle stalls.
            // We surface this every tick (not just on transition) because it's the *only*
            // condition that requires manual operator intervention.
            this.#stats.deployerCritical = true;
            this.#log.error(
                {
                    deployer,
                    deployerBal: deployerBal.toString(),
                    floor: this.#floor.toString(),
                    faucetBal: faucetBal.toString(),
                },
                "DEPLOYER OUT OF MON — fund the deployer EOA from the Monad testnet faucet; settle pipeline will stall once Faucet drains.",
            );
            return false;
        }
        this.#stats.deployerCritical = false;

        if (faucetBal >= this.#lowWater) return false;

        const need = this.#target - faucetBal;
        // Don't refill below the floor. If `need` is large and the deployer is mid-range
        // we send a smaller refill to preserve the floor reserve.
        const sendable = deployerBal - this.#floor;
        if (sendable <= 0n) {
            this.#log.warn(
                {deployerBal: deployerBal.toString(), floor: this.#floor.toString()},
                "faucet-reserve: deployer at floor — skipping refill",
            );
            return false;
        }
        const value = need < sendable ? need : sendable;

        const txHash = await this.#wallet.sendTransaction({
            account: this.#wallet.account!,
            chain: this.#wallet.chain ?? null,
            to: this.#faucet,
            value,
        });
        await confirmTx({publicClient: this.#publicClient, txHash, opName: "faucet-reserve.refill"});
        this.#stats.refillTxCount++;
        this.#stats.lastRefillTx = txHash;
        this.#log.info(
            {
                faucetBefore: faucetBal.toString(),
                refilledWei: value.toString(),
                tx: txHash,
            },
            "faucet-reserve: refilled Faucet from deployer",
        );
        return true;
    }
}

function sleep(ms: number): Promise<void> {
    return new Promise((r) => setTimeout(r, ms));
}
