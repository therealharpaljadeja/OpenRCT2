#!/usr/bin/env node
import {writeFileSync} from "node:fs";
import * as path from "node:path";
import {parseArgs} from "./config.js";
import {
    deriveGuest,
    operatorPool,
    relayerPool,
    OPERATOR_FUNDER,
    OPERATOR_PERMITS,
    OPERATOR_SWEEPER,
} from "./derive/index.js";
import {GuestAddressCache} from "./derive/cache.js";
import {RpcServer} from "./ipc/server.js";
import {registerCoreHandlers, type SidecarRuntime} from "./ipc/handlers.js";
import {KeystoreError, loadOrCreateKeystoreFile} from "./keystore/index.js";
import {log} from "./log.js";
import {OutboxReader} from "./outbox/index.js";
import {
    authorizeOperators,
    createBalanceReader,
    createFaucetWriter,
    FAUCET_ABI,
    FaucetReserveTopUp,
    makeFaucetOwnerClient,
    makeOperatorClient,
    makePublicClient,
    parkLaunchSetup,
    RelayerTopUp,
    type BalanceReader,
    type FaucetWriter,
} from "./chain/index.js";
import {Batcher, SpendDispatcher, SpendNonceTracker, spendAuthDomain} from "./batcher/index.js";
import {RelayerPool, createNoopSubmitter, createViemSubmitter, type RelayerSubmitter} from "./relayers/index.js";
import {Funder} from "./funder/index.js";
import {PermitCollector, permitDomain, signPermit} from "./permits/index.js";
import {Sweeper} from "./sweeper/index.js";
import {VenueMirror} from "./venues/index.js";
import {applyEpoch, formatEpoch, generateEpoch, MAX_GAME_ID} from "./venues/epoch.js";
import {MetricsAggregator} from "./metrics/index.js";
import {SpendRateLimiter} from "./ratelimit/index.js";
import type {OutboxEvent} from "./outbox/index.js";

/// Sidecar entrypoint. Boots the JSON-RPC server, unlocks (or creates) the encrypted master
/// mnemonic, derives the relayer pool, and waits for SIGINT/SIGTERM. Subsequent milestones
/// plug additional subsystems (batcher, relayers tx submission, funder, venue mirror) into
/// the same server object.
async function main(): Promise<void> {
    let config;
    try {
        config = parseArgs(process.argv.slice(2));
    } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        process.stderr.write(`${msg}\n`);
        process.exit(2);
    }

    let unlocked;
    let keystoreCreated;
    try {
        const result = await loadOrCreateKeystoreFile(config.keystorePath, config.keystorePassphrase);
        unlocked = result.unlocked;
        keystoreCreated = result.created;
    } catch (err) {
        const msg = err instanceof KeystoreError ? err.message : err instanceof Error ? err.message : String(err);
        log.error({err, path: config.keystorePath}, "keystore unlock failed");
        process.stderr.write(`${msg}\n`);
        process.exit(3);
    }

    if (keystoreCreated) {
        log.warn(
            {path: config.keystorePath},
            "created fresh keystore — back up the file (encryption only protects against passphrase-less access)",
        );
    }

    // Per-session venue id namespace. Translates `gameId → (epoch << 16) | gameId` at the
    // outbox-consumption boundary so the on-chain `VenueRegistry` never sees a colliding id
    // across sessions. See `venues/epoch.ts`.
    const sessionEpoch = config.sessionEpoch ?? generateEpoch();
    log.info(
        {epoch: sessionEpoch, epochHex: formatEpoch(sessionEpoch), overridden: config.sessionEpoch !== undefined},
        "session venue-id epoch resolved",
    );

    const relayers = relayerPool(unlocked.mnemonic, config.relayerCount);
    log.info(
        {
            count: relayers.length,
            addresses: relayers.map((r) => r.address),
        },
        "relayer pool derived",
    );

    // M3.14 — operator EOAs (one per high-volume admin subsystem). Derived here so they're
    // visible in the keystore status surface alongside relayers; authorized on chain (and
    // funded with MON) only when chain plumbing is configured below.
    const operators = operatorPool(unlocked.mnemonic);
    log.info(
        {
            funder: operators[OPERATOR_FUNDER]!.address,
            permits: operators[OPERATOR_PERMITS]!.address,
            sweeper: operators[OPERATOR_SWEEPER]!.address,
        },
        "operator pool derived",
    );

    const guestCache = new GuestAddressCache(unlocked.mnemonic);

    let outboxReader: OutboxReader | undefined;
    if (config.outboxPath && config.outboxCursorPath) {
        const opts: ConstructorParameters<typeof OutboxReader>[0] = {
            walPath: config.outboxPath,
            cursorPath: config.outboxCursorPath,
        };
        if (config.outboxPollIntervalMs !== undefined) opts.pollIntervalMs = config.outboxPollIntervalMs;
        outboxReader = new OutboxReader(opts);
    }

    let balances: BalanceReader | undefined;
    let faucet: FaucetWriter | undefined;
    let topup: RelayerTopUp | undefined;
    let faucetReserve: FaucetReserveTopUp | undefined;
    // Chain head at sidecar boot — persisted to <chainDir>/indexer-start-block and
    // surfaced via `chain.indexer.config` so the indexer can start exactly here.
    let indexerStartBlock: bigint | undefined;
    let indexerChainDir: string | undefined;
    let funder: Funder | undefined;
    let permits: PermitCollector | undefined;
    let sweeper: Sweeper | undefined;
    let venueMirror: VenueMirror | undefined;
    let nonces: SpendNonceTracker | undefined;
    let submitter: RelayerSubmitter;
    // M3.12 — declared early so topup's `onRelayerFunded` callback (constructed below) can
    // close over the same binding the pool is later assigned to. Both directions of the
    // pool ↔ topup wiring resolve lazily at callback fire-time.
    let relayerPoolHandle: RelayerPool | undefined;
    if (config.rpcUrl) {
        // M3.12 — batch + timeout knobs land here. Both clients share the same options so
        // sync tx submission and the read-side share the same HTTP transport policy.
        const clientOpts = {batch: config.rpcBatching, timeoutMs: config.rpcTimeoutMs};
        const publicClient = makePublicClient(config.deployments.chainId, config.rpcUrl, clientOpts);
        // Capture the chain head at boot so the indexer can pick up exactly this session's
        // events (anything earlier belongs to a previous epoch and shouldn't pollute the
        // index). Persisted to <chainDir>/indexer-start-block alongside the WAL so the
        // start-indexer.sh wrapper can find it without IPC, plus surfaced via
        // `chain.indexer.config` for tools that prefer the JSON-RPC route.
        try {
            const block = await publicClient.getBlockNumber();
            indexerStartBlock = block;
            if (config.outboxPath) {
                indexerChainDir = path.dirname(config.outboxPath);
                writeFileSync(path.join(indexerChainDir, "indexer-start-block"), String(block));
                log.info({block: block.toString(), dir: indexerChainDir}, "indexer start block captured");
            }
        } catch (err) {
            log.warn({err}, "indexer-start-block capture failed (head read errored)");
        }
        // M3.11 — per-guest sig-nonce tracker. Always paired with chain plumbing because the
        // first-touch fetch reads SettlementBatcher.sigNonces[guest]. Offline mode skips the
        // dispatcher entirely (see below), so an absent tracker is fine.
        nonces = new SpendNonceTracker({
            publicClient,
            settlementBatcher: config.deployments.demoPark.settlementBatcher,
        });
        balances = createBalanceReader({
            publicClient,
            parkToken: config.deployments.globals.parkToken,
        });
        if (config.faucetOwnerKey) {
            // Deployer-key wallet client. Used for: faucet writes (dripPark/dripMon),
            // venue-mirror admin (registry owner), and one-time operator authorization
            // (`treasury.addOperator` per operator EOA). After M3.14, NO LONGER used by
            // funder/permits/sweeper — those switched to dedicated operator EOAs.
            const walletClient = makeFaucetOwnerClient(
                config.deployments.chainId,
                config.rpcUrl,
                config.faucetOwnerKey,
                clientOpts,
            );
            faucet = createFaucetWriter({
                walletClient,
                publicClient,
                faucetAddress: config.deployments.globals.faucet,
            });

            // Boot-time owner check: the configured key must equal `Faucet.owner()`.
            // A mismatch means every onlyOwner call (dripMon, treasury.execute, venue
            // register/rename/remove) would revert with `OwnableUnauthorizedAccount`. The
            // failure mode without this check is misleading: the RPC reports "Signer had
            // insufficient balance" first because the operator wallet is also low, masking
            // the real auth problem. Fail fast so the operator points the keystore at the
            // right key before everything downstream tries to start.
            const configuredOwner = walletClient.account!.address as `0x${string}`;
            const onChainOwner = (await publicClient.readContract({
                address: config.deployments.globals.faucet,
                abi: FAUCET_ABI,
                functionName: "owner",
            })) as `0x${string}`;
            if (configuredOwner.toLowerCase() !== onChainOwner.toLowerCase()) {
                log.fatal(
                    {configuredOwner, onChainOwner, faucet: config.deployments.globals.faucet},
                    "FAUCET_OWNER_KEY does not match Faucet.owner() — every onlyOwner call would revert. "
                        + "Fix: load the deployer's private key (the address that ran Deploy.s.sol), or "
                        + "transfer ownership of Faucet/VenueRegistry/Treasury/ParkToken to the configured key.",
                );
                process.exit(2);
            }

            // Faucet-reserve auto-topup. Keeps the Faucet contract's MON above `lowWater`
            // by transferring from the deployer EOA (which is `Faucet.owner()` and the only
            // address authorized to drip out of it).
            //
            // Sizing: the relayer topup, when all 8 relayers + 3 operators are near-zero,
            // needs to drip ~11 × monTargetWei = 11 MON in a single dripMon call. lowWater
            // must comfortably exceed that or the Faucet bottoms out mid-cycle and dripMon
            // reverts with InsufficientMonBalance. 15 MON gives one cycle of margin; target
            // 30 MON gives two cycles between refills so transient spikes don't drain it.
            //
            // Critical floor: 0.5 MON kept on the deployer at all times so the deployer can
            // still afford the eventual `withdrawMon` / governance txs even if the auto-loop
            // gets confused. Below this, the loop alarms loudly and stops refilling.
            const oneMon = 1_000_000_000_000_000_000n;
            faucetReserve = new FaucetReserveTopUp({
                faucet: config.deployments.globals.faucet,
                deployerWalletClient: walletClient,
                publicClient,
                balances,
                lowWater: oneMon * 15n,
                target: oneMon * 30n,
                deployerCriticalFloor: oneMon / 2n,
                log,
            });
            // M3.14 — pre-build per-operator wallet clients so funder/permits/sweeper each
            // submit admin txs from their own EOA + nonce sequence (no contention with the
            // deployer key or each other).
            const funderOpClient = makeOperatorClient(
                config.deployments.chainId,
                config.rpcUrl,
                operators[OPERATOR_FUNDER]!.account,
                clientOpts,
            );
            const permitsOpClient = makeOperatorClient(
                config.deployments.chainId,
                config.rpcUrl,
                operators[OPERATOR_PERMITS]!.account,
                clientOpts,
            );
            const sweeperOpClient = makeOperatorClient(
                config.deployments.chainId,
                config.rpcUrl,
                operators[OPERATOR_SWEEPER]!.account,
                clientOpts,
            );
            // M3.14 — topup loop now also funds operators (same low-water/target as relayers
            // — admin txs cost roughly the same as settle txs). Concatenating the lists keeps
            // a single-tx-per-tick `dripMon` rather than two separate refill txs.
            const topupTargets = [
                ...relayers.map((r) => r.address),
                ...operators.map((o) => o.address),
            ];
            topup = new RelayerTopUp(balances, faucet, {
                relayers: topupTargets,
                lowWater: config.monLowWaterWei,
                target: config.monTargetWei,
                intervalMs: config.topupIntervalMs,
                // M3.12 — only the first `relayers.length` slots correspond to RelayerPool
                // indices. Operators occupy the tail of the list and have no pool slot to
                // clear; the early-out below avoids out-of-range `markRelayerReady` calls.
                onRelayerFunded: (idx, address) => {
                    if (idx < relayers.length) {
                        relayerPoolHandle?.markRelayerReady(idx);
                        log.info({idx, address}, "relayer topup landed; pool slot back online");
                    } else {
                        log.info({idx, address, role: "operator"}, "operator topup landed");
                    }
                },
                // When dripMon reverts with InsufficientMonBalance, ask the Faucet reserve
                // loop to refill from the deployer right now instead of waiting for its next
                // poll. Without this, a fast burst of relayer/operator drains can outpace
                // the 30 s reserve-loop interval and leave the pool stalled.
                onFaucetEmpty: () => {
                    faucetReserve?.requestImmediate();
                },
            });
            // M3.5 — funder for entering guests. M3.14 — submits as the funder operator,
            // not the deployer. The treasury was authorized at boot (see authorizeOperators
            // call below) to accept this address as a non-owner caller of `execute`.
            funder = new Funder({
                walletClient: funderOpClient,
                publicClient,
                treasury: config.deployments.demoPark.treasury,
                parkToken: config.deployments.globals.parkToken,
                disperse: config.deployments.globals.disperse,
                maxSize: config.funderWindowSize,
                maxAgeMs: config.funderWindowAgeMs,
                maxQueuedEntries: config.funderMaxQueued,
                log,
            });
            // M3.6 — permit collector. M3.14 — own operator EOA.
            permits = new PermitCollector({
                walletClient: permitsOpClient,
                publicClient,
                treasury: config.deployments.demoPark.treasury,
                parkToken: config.deployments.globals.parkToken,
                maxSize: config.permitsWindowSize,
                maxAgeMs: config.permitsWindowAgeMs,
                maxQueuedPermits: config.permitsMaxQueued,
                log,
            });
            // M3.8 — venue mirror. Stays on the deployer key — the registry is `Ownable`,
            // not multi-operator, and venue admin events are sparse so contention isn't an
            // issue. (M3.15 would add an `Operatable` analog if we want parallel admin here.)
            venueMirror = new VenueMirror({
                walletClient,
                publicClient,
                venueRegistry: config.deployments.demoPark.venueRegistry,
                maxQueuedEvents: config.venueMirrorMaxQueued,
                log,
            });
            // M3.7 — sweeper. M3.14 — own operator EOA. The inner permit-spender is the
            // treasury (unchanged); the outer `executeBatch` is now signed by the sweeper
            // operator instead of the deployer.
            sweeper = new Sweeper({
                walletClient: sweeperOpClient,
                publicClient,
                treasury: config.deployments.demoPark.treasury,
                parkToken: config.deployments.globals.parkToken,
                permitDomain: permitDomain(config.deployments.chainId, config.deployments.globals.parkToken),
                deriveAccount: (idx) => deriveGuest(unlocked.mnemonic, idx).account,
                permitDeadlineDays: config.permitDeadlineDays,
                maxSize: config.sweeperWindowSize,
                maxAgeMs: config.sweeperWindowAgeMs,
                maxQueuedExits: config.sweeperMaxQueued,
                log,
            });
            // M3.14 — authorize the three operator EOAs on Treasury. Idempotent: skips
            // already-authorized addresses with one chain read; submits at most three txs
            // on a fresh deployment. Failure here is fatal — without this, every funder /
            // permits / sweeper tx will revert with `NotOwnerOrOperator`.
            try {
                const results = await authorizeOperators({
                    walletClient,
                    publicClient,
                    treasury: config.deployments.demoPark.treasury,
                    operators: operators.map((o) => o.address),
                    log,
                });
                log.info(
                    {results: results.map((r) => ({address: r.address, authorized: r.authorized}))},
                    "operators authorized on Treasury",
                );
            } catch (err) {
                log.error({err}, "operator authorization failed — funder/permits/sweeper will revert");
                throw err;
            }
        }
        // M3.4 — real submitter when we have an RPC. Encodes `settle(...)`, signs locally with
        // the relayer's HDAccount, submits via Monad's `eth_sendRawTransactionSync` so the
        // round-trip *is* the submit→confirm latency.
        submitter = createViemSubmitter({
            publicClient,
            settlementBatcher: config.deployments.demoPark.settlementBatcher,
            log,
        });
    } else {
        // No RPC URL — fall back to the noop submitter so the batcher/pool wiring still
        // exercises end-to-end (useful in local dev + tests + headless boots).
        submitter = createNoopSubmitter({log});
    }
    // M3.9 — metrics aggregator. Always-on (no chain dependency); the relayer pool calls
    // `metrics.recordTx*` on each submit so the rolling-window rates / percentiles are live
    // even before any subsystem-specific gauges are wired into the snapshot.
    const metrics = new MetricsAggregator({log});
    relayerPoolHandle = new RelayerPool({
        relayers,
        submitter,
        metrics,
        log,
        // M3.12 — Fix C: when a relayer's MON dips below what the next tx needs, the pool
        // marks it offline; we ask the topup loop to fire immediately so the relayer comes
        // back online with low extra latency rather than waiting for the next polling tick.
        onRelayerInsufficientBalance: (idx, address) => {
            log.warn({idx, address}, "relayer low on MON — forcing refill");
            // Force-refill, not just immediate-tick: a real RPC `insufficient balance`
            // means the relayer can't afford one tx, which can sit above the configured
            // lowWater. The forced flag bypasses that comparison for this idx.
            topup?.markForcedRefill(idx);
        },
        // M3.12 — Fix 1: when a batch fails terminally, invalidate the local sigNonce cache
        // for every guest in the batch. The chain didn't move, but the dispatcher's local
        // counter did; without this, future spends from those guests revert with BadNonce
        // until the sidecar restarts. The relayer pool fires this *after* the one-shot
        // retry has been exhausted, so retryable nonce errors don't trigger it.
        onTerminalFailure: (batch) => {
            const addrs = batch.auths.map((a) => a.from);
            // De-dup so the same guest in N auths only counts once for stats purposes.
            const unique = new Set(addrs.map((a) => a.toLowerCase() as `0x${string}`));
            nonces?.invalidate(unique);
        },
    });
    const batcher = new Batcher({sink: relayerPoolHandle.sink, log});
    // M3.10 — per-guest spend rate cap. Always wired (no chain dependency); the GUEST_SPEND
    // dispatcher consults `consume(hdIndex)` and drops over-limit events with a counter
    // bump so a runaway guest can't dominate the batch (plan §10).
    const rateLimiter = new SpendRateLimiter({
        maxAuthPerSecond: config.rateLimitPerGuestAuthPerSec,
        log,
    });

    // M3.11 — GUEST_SPEND hot path. Only constructed when chain plumbing is present; the
    // tracker's first-touch fetch reads `sigNonces[guest]` via the public client and an
    // offline boot has nowhere to read from. The dispatcher's `handle()` is the new GUEST_SPEND
    // body inside the outbox dispatcher below.
    const spendDom = spendAuthDomain(
        config.deployments.chainId,
        config.deployments.demoPark.settlementBatcher,
    );
    const spendDispatcher = nonces
        ? new SpendDispatcher({
              batcher,
              venueMirror,
              rateLimiter,
              guestCache,
              nonces,
              domain: spendDom,
              deriveAccount: (idx) => deriveGuest(unlocked.mnemonic, idx).account,
              log,
          })
        : undefined;

    const runtime: SidecarRuntime = {
        config,
        keystoreCreatedAt: unlocked.createdAt,
        keystoreCreated,
        relayers,
        guestCache,
        batcher,
        relayerPool: relayerPoolHandle,
        metrics,
        rateLimiter,
    };
    if (outboxReader) runtime.outboxReader = outboxReader;
    if (balances) runtime.balances = balances;
    if (faucet) runtime.faucet = faucet;
    if (topup) runtime.topup = topup;
    if (faucetReserve) runtime.faucetReserve = faucetReserve;
    if (indexerStartBlock !== undefined) runtime.indexerStartBlock = indexerStartBlock;
    if (indexerChainDir !== undefined) runtime.indexerChainDir = indexerChainDir;
    if (funder) runtime.funder = funder;
    if (permits) runtime.permits = permits;
    if (sweeper) runtime.sweeper = sweeper;
    if (venueMirror) runtime.venueMirror = venueMirror;
    if (nonces) runtime.spendNonces = nonces;
    if (spendDispatcher) runtime.spendDispatcher = spendDispatcher;

    const server = new RpcServer(config.socketPath);
    registerCoreHandlers(server, runtime);

    await server.listen();
    // M3.14 — fund the operator EOAs *before* funder.start runs its one-time approval tx.
    // The operator addresses are brand-new on first boot (zero MON); without a forced
    // topup tick, the approval tx would fail with `Signer had insufficient balance` and
    // the funder would refuse to accept entries until something else triggered a refill.
    // Start the faucet-reserve loop *before* the relayer-topup loop so the Faucet contract
    // is guaranteed to have MON before `topup.tickOnce()` tries to drip out of it. The
    // pre-tick is awaited (with confirmTx) so the chain has actually credited the Faucet
    // before the next call lands.
    if (faucetReserve) {
        faucetReserve.start();
        try {
            await faucetReserve.tickOnce();
        } catch (err) {
            log.warn(
                {err},
                "faucet-reserve pre-tick failed; downstream topup may stall if Faucet is empty",
            );
        }
    }
    if (topup) {
        topup.start();
        try {
            await topup.tickOnce();
            // Mempool propagation race: even after the dripMon receipt arrives (M3.13's
            // confirmTx waited for it), the public RPC's mempool-validation path can still
            // see the recipient at zero balance for a few hundred ms. Empirically a 2 s
            // settle is more than enough on Monad testnet — admin path is one-shot at boot
            // so the latency is negligible.
            await new Promise<void>((r) => setTimeout(r, 2_000));
        } catch (err) {
            log.warn(
                {err},
                "topup pre-tick failed (Faucet empty?); funder.start will likely fail until Faucet is funded",
            );
        }
    }

    // Auto-launch: if the treasury has zero PARK at boot, fire parkLaunchSetup so the funder's
    // first window-flush has tokens to disperse. Without this, fresh deployments (or
    // post-redeploy state) silently revert with `CallFailed → ERC20InsufficientBalance`. Disable
    // with `--auto-launch off` if you'd rather drive the drip manually via `chain.faucet.drip`.
    if (config.autoLaunch && faucet && balances) {
        try {
            const treasury = config.deployments.demoPark.treasury;
            const current = await balances.parkBalance(treasury);
            if (current === 0n) {
                log.info(
                    {treasury, parkLaunchWei: config.parkLaunchWei.toString()},
                    "auto-launch: treasury PARK balance is zero — firing parkLaunchSetup",
                );
                const result = await parkLaunchSetup(faucet, {
                    treasury,
                    relayers: relayers.map((r) => r.address),
                    parkAmount: config.parkLaunchWei,
                    monPerRelayer: config.monTargetWei,
                });
                log.info(
                    {parkTx: result.parkTx, monTx: result.monTx},
                    "auto-launch: parkLaunchSetup confirmed; treasury funded",
                );
            } else {
                log.info(
                    {treasury, currentWei: current.toString()},
                    "auto-launch: treasury already funded — skipping",
                );
            }
        } catch (err) {
            log.error(
                {err},
                "auto-launch: parkLaunchSetup failed — funder will revert until you call chain.faucet.drip",
            );
        }
    } else if (!config.autoLaunch) {
        log.info("auto-launch disabled (--auto-launch off); call chain.faucet.drip to fund the treasury");
    }

    // M3.16 — note: `warmUpEOA` is still exported for tests + situational use (e.g. an
    // operator who returns from a long idle period might want to warm up before a flurry).
    // We *don't* call it at boot anymore: the proper fix is `submitAndConfirm`'s internal
    // retry-on-insufficient-balance, which lives in each subsystem's `#sendTreasuryCall`.
    // That handles the mempool-lag transparently per-flush rather than burning boot time
    // on a warm-up tx that's specific to one wallet-client and doesn't actually carry over.
    if (funder) {
        // One-time approval at boot. Monad's public RPC mempool-validation has an
        // unpredictable lag behind on-chain state — even after the dripMon receipt confirms
        // (M3.13's confirmTx waited for it), `eth_sendRawTransaction` can keep returning
        // "Signer had insufficient balance" for the operator EOA for tens of seconds while
        // RPC nodes gossip. Empirically a fresh wallet client + a few minutes of wait
        // recovers cleanly. We launch the approval in the background with a long retry
        // schedule (1m, 2m, 5m) so the foreground boot proceeds — funder.accept() gates on
        // `started` internally, so any GUEST_ENTRY events queue up until the approval lands.
        const isInsufficientBalance = (err: unknown): boolean => {
            const msg = err instanceof Error ? err.message : String(err);
            return /insufficient balance/i.test(msg);
        };
        const backoffs = [10_000, 30_000, 60_000, 120_000, 300_000];
        const startInBackground = async (): Promise<void> => {
            for (let attempt = 0; attempt <= backoffs.length; attempt++) {
                try {
                    await funder!.start();
                    log.info({attempt: attempt + 1}, "funder.start succeeded; guest funding online");
                    return;
                } catch (err) {
                    if (attempt < backoffs.length && isInsufficientBalance(err)) {
                        log.warn(
                            {err, attempt: attempt + 1, nextDelayMs: backoffs[attempt]},
                            "funder.start: insufficient balance — RPC mempool lag; retrying in background",
                        );
                        await new Promise<void>((r) => setTimeout(r, backoffs[attempt]));
                    } else {
                        log.error({err, attempt: attempt + 1}, "funder.start failed; guest funding offline");
                        return;
                    }
                }
            }
        };
        void startInBackground();
    }
    if (venueMirror) {
        venueMirror.start();
        // Best-effort cache hydration so the spend batcher's lookups work right away after a
        // restart, instead of waiting for the WAL to be re-played. A failure here doesn't
        // block boot; the WAL replay will eventually re-populate the cache anyway.
        try {
            await venueMirror.hydrateFromChain();
        } catch (err) {
            log.warn({err}, "venueMirror.hydrateFromChain failed; cache will rebuild from outbox events");
        }
    }
    if (outboxReader) {
        // Dispatch by event kind. Each subsystem owns its own kinds; unhandled kinds are
        // logged at debug level — at full throughput we don't want a noisy line per event,
        // and the relevant counters live on each subsystem's `stats()`.
        const permitDom = permits
            ? permitDomain(config.deployments.chainId, config.deployments.globals.parkToken)
            : undefined;
        const batcherAddr = config.deployments.demoPark.settlementBatcher;
        const permitDeadlineSecs = BigInt(config.permitDeadlineDays) * 86_400n;
        const permitValue = (1n << 256n) - 1n; // ∞ allowance

        await outboxReader.start(async (event: OutboxEvent) => {
            switch (event.kind) {
                case "GUEST_ENTRY": {
                    let address: `0x${string}`;
                    try {
                        address = guestCache.addressOf(event.hdIndex);
                    } catch (err) {
                        log.warn({err, event}, "GUEST_ENTRY: address derivation failed");
                        break;
                    }
                    if (funder) {
                        let amount: bigint;
                        try {
                            amount = BigInt(event.cash);
                        } catch (err) {
                            log.warn({err, cash: event.cash, event}, "GUEST_ENTRY: invalid cash decimal");
                            break;
                        }
                        funder.accept({address, amount});
                    }
                    if (permits && permitDom && balances) {
                        // Sign the permit off-chain. The entry-time path used to assume
                        // nonce=0 for "performance," but guest addresses are deterministic
                        // from the master mnemonic + hdIndex — once an address has been
                        // permitted (any prior session, or any hdIndex reuse) its on-chain
                        // nonce is > 0, and signing with 0 reverts with ERC2612InvalidSigner.
                        // Read the canonical nonce from chain before signing; one extra
                        // eth_call per entry, batched by viem's keep-alive transport.
                        try {
                            const guestAccount = deriveGuest(unlocked.mnemonic, event.hdIndex);
                            const deadline = BigInt(Math.floor(Date.now() / 1000)) + permitDeadlineSecs;
                            const onChainNonce = await balances.permitNonce(address);
                            const signed = await signPermit(guestAccount.account, permitDom, {
                                owner: address,
                                spender: batcherAddr,
                                value: permitValue,
                                nonce: onChainNonce,
                                deadline,
                            });
                            permits.accept(signed);
                        } catch (err) {
                            log.warn({err, event}, "GUEST_ENTRY: permit signing failed");
                        }
                    }
                    break;
                }
                case "GUEST_EXIT": {
                    // Drop the rate-limit bucket for this guest so the map doesn't grow
                    // unbounded across park sessions (plan §10 / M3.10). Idempotent + cheap.
                    rateLimiter.forget(event.hdIndex);
                    if (nonces) {
                        // Drop the sig-nonce cache entry as well. After exit the guest's
                        // address is dead; if a new guest *somehow* reuses the same hdIndex
                        // (M4.x guest-id recycling), we'd want a fresh chain read on first
                        // spend rather than serving the stale local count.
                        try {
                            const addr = guestCache.peek(event.hdIndex);
                            if (addr) nonces.forget(addr);
                        } catch {
                            // Address not cached — no nonce entry to drop. Safe to ignore.
                        }
                    }
                    if (!sweeper) {
                        log.debug({event}, "GUEST_EXIT (sweeper not configured)");
                        break;
                    }
                    let address: `0x${string}`;
                    try {
                        address = guestCache.addressOf(event.hdIndex);
                    } catch (err) {
                        log.warn({err, event}, "GUEST_EXIT: address derivation failed");
                        break;
                    }
                    sweeper.accept({hdIndex: event.hdIndex, address});
                    break;
                }
                case "VENUE_REGISTERED": {
                    // Translate game ride index → on-chain venue id. See `venues/epoch.ts`.
                    let chainVenueId: number;
                    try {
                        chainVenueId = applyEpoch(sessionEpoch, event.venueId);
                    } catch (err) {
                        log.warn({err, event, max: MAX_GAME_ID}, "VENUE_REGISTERED: gameId out of range — dropping");
                        break;
                    }
                    if (venueMirror) {
                        venueMirror.accept({
                            kind: "register",
                            venueId: chainVenueId,
                            venueKind: event.venueKind,
                            name: event.name,
                            objectType: event.objectType,
                        });
                    } else {
                        log.debug({event, chainVenueId}, "VENUE_REGISTERED (mirror not configured)");
                    }
                    break;
                }
                case "VENUE_RENAMED": {
                    let chainVenueId: number;
                    try {
                        chainVenueId = applyEpoch(sessionEpoch, event.venueId);
                    } catch (err) {
                        log.warn({err, event}, "VENUE_RENAMED: gameId out of range — dropping");
                        break;
                    }
                    if (venueMirror) {
                        venueMirror.accept({kind: "rename", venueId: chainVenueId, newName: event.newName});
                    } else {
                        log.debug({event, chainVenueId}, "VENUE_RENAMED (mirror not configured)");
                    }
                    break;
                }
                case "VENUE_REMOVED": {
                    let chainVenueId: number;
                    try {
                        chainVenueId = applyEpoch(sessionEpoch, event.venueId);
                    } catch (err) {
                        log.warn({err, event}, "VENUE_REMOVED: gameId out of range — dropping");
                        break;
                    }
                    if (venueMirror) {
                        venueMirror.accept({kind: "remove", venueId: chainVenueId});
                    } else {
                        log.debug({event, chainVenueId}, "VENUE_REMOVED (mirror not configured)");
                    }
                    break;
                }
                case "GUEST_SPEND": {
                    // M3.11 — full sign-and-push hot path. The dispatcher owns rate-limit
                    // consultation, venue lookup, address resolution, sig-nonce tracking,
                    // and EIP-712 signing. Without chain plumbing the dispatcher is absent
                    // and we still consult the rate limiter so the bucket map stays bounded.
                    if (!spendDispatcher) {
                        if (!rateLimiter.consume(event.hdIndex)) {
                            log.debug(
                                {hdIndex: event.hdIndex, guestId: event.guestId},
                                "GUEST_SPEND rate-limited (offline mode)",
                            );
                        }
                        break;
                    }
                    let chainVenueId: number;
                    try {
                        chainVenueId = applyEpoch(sessionEpoch, event.venueId);
                    } catch (err) {
                        log.warn({err, event}, "GUEST_SPEND: gameId out of range — dropping");
                        break;
                    }
                    await spendDispatcher.handle({...event, venueId: chainVenueId});
                    break;
                }
            }
        });
    }
    // (topup was started earlier so its pre-tick could fund the operators before funder.start)
    log.info(
        {
            socket: config.socketPath,
            chainId: config.deployments.chainId,
            settlementBatcher: config.deployments.demoPark.settlementBatcher,
            relayers: relayers.length,
            outbox: config.outboxPath ?? null,
            rpc: config.rpcUrl ?? null,
            faucetOwner: faucet ? "configured" : null,
            funder: funder ? "configured" : null,
            permits: permits ? "configured" : null,
            sweeper: sweeper ? "configured" : null,
            venueMirror: venueMirror ? "configured" : null,
            sessionEpoch: formatEpoch(sessionEpoch),
        },
        "sidecar ready",
    );

    const shutdown = async (signal: string): Promise<void> => {
        log.info({signal}, "shutting down");
        // Order: outbox (producer) → batcher (sink-driver) → relayer pool (terminal sink) →
        // server. Top-up loop is independent of all of them.
        if (topup) await topup.stop().catch((err) => log.error({err}, "topup stop failed"));
        if (faucetReserve)
            await faucetReserve.stop().catch((err) => log.error({err}, "faucet-reserve stop failed"));
        if (outboxReader) await outboxReader.stop().catch((err) => log.error({err}, "outbox stop failed"));
        if (funder) await funder.stop().catch((err) => log.error({err}, "funder stop failed"));
        if (permits) await permits.stop().catch((err) => log.error({err}, "permits stop failed"));
        if (sweeper) await sweeper.stop().catch((err) => log.error({err}, "sweeper stop failed"));
        if (venueMirror) await venueMirror.stop().catch((err) => log.error({err}, "venueMirror stop failed"));
        await batcher.stop().catch((err) => log.error({err}, "batcher stop failed"));
        await relayerPoolHandle.stop().catch((err) => log.error({err}, "relayer pool stop failed"));
        await server.close();
        process.exit(0);
    };
    process.on("SIGINT", () => void shutdown("SIGINT"));
    process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

main().catch((err) => {
    log.error({err}, "fatal");
    process.exit(1);
});
