#!/usr/bin/env node
import {parseArgs} from "./config.js";
import {deriveGuest, relayerPool} from "./derive/index.js";
import {GuestAddressCache} from "./derive/cache.js";
import {RpcServer} from "./ipc/server.js";
import {registerCoreHandlers, type SidecarRuntime} from "./ipc/handlers.js";
import {KeystoreError, loadOrCreateKeystoreFile} from "./keystore/index.js";
import {log} from "./log.js";
import {OutboxReader} from "./outbox/index.js";
import {
    createBalanceReader,
    createFaucetWriter,
    makeFaucetOwnerClient,
    makePublicClient,
    parkLaunchSetup,
    RelayerTopUp,
    type BalanceReader,
    type FaucetWriter,
} from "./chain/index.js";
import {Batcher} from "./batcher/index.js";
import {RelayerPool, createNoopSubmitter, createViemSubmitter, type RelayerSubmitter} from "./relayers/index.js";
import {Funder} from "./funder/index.js";
import {PermitCollector, permitDomain, signPermit} from "./permits/index.js";
import {Sweeper} from "./sweeper/index.js";
import {VenueMirror} from "./venues/index.js";
import {MetricsAggregator} from "./metrics/index.js";
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

    const relayers = relayerPool(unlocked.mnemonic, config.relayerCount);
    log.info(
        {
            count: relayers.length,
            addresses: relayers.map((r) => r.address),
        },
        "relayer pool derived",
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
    let funder: Funder | undefined;
    let permits: PermitCollector | undefined;
    let sweeper: Sweeper | undefined;
    let venueMirror: VenueMirror | undefined;
    let submitter: RelayerSubmitter;
    if (config.rpcUrl) {
        const publicClient = makePublicClient(config.deployments.chainId, config.rpcUrl);
        balances = createBalanceReader({
            publicClient,
            parkToken: config.deployments.globals.parkToken,
        });
        if (config.faucetOwnerKey) {
            const walletClient = makeFaucetOwnerClient(
                config.deployments.chainId,
                config.rpcUrl,
                config.faucetOwnerKey,
            );
            faucet = createFaucetWriter({
                walletClient,
                publicClient,
                faucetAddress: config.deployments.globals.faucet,
            });
            topup = new RelayerTopUp(balances, faucet, {
                relayers: relayers.map((r) => r.address),
                lowWater: config.monLowWaterWei,
                target: config.monTargetWei,
                intervalMs: config.topupIntervalMs,
            });
            // M3.5 — funder for entering guests. Same wallet client as the faucet writer
            // because the deployer key is also the treasury owner.
            funder = new Funder({
                walletClient,
                publicClient,
                treasury: config.deployments.demoPark.treasury,
                parkToken: config.deployments.globals.parkToken,
                disperse: config.deployments.globals.disperse,
                maxSize: config.funderWindowSize,
                maxAgeMs: config.funderWindowAgeMs,
                maxQueuedEntries: config.funderMaxQueued,
                log,
            });
            // M3.6 — permit collector. Same wallet client; the permit txs go through
            // `treasury.executeBatch([parkToken.permit(...)] × N)` so msg.sender is the
            // treasury (irrelevant to permit; the sig is what authorizes the approval).
            permits = new PermitCollector({
                walletClient,
                treasury: config.deployments.demoPark.treasury,
                parkToken: config.deployments.globals.parkToken,
                maxSize: config.permitsWindowSize,
                maxAgeMs: config.permitsWindowAgeMs,
                maxQueuedPermits: config.permitsMaxQueued,
                log,
            });
            // M3.8 — venue mirror. Drains VENUE_* events one tx at a time (low volume) into
            // VenueRegistry and caches venueId → kind / subAccount locally so the spend
            // batcher (M3.x) can attach the venue's till + kind without a chain read on the
            // hot path. Deployer is the registry's owner, so the same wallet client is fine.
            venueMirror = new VenueMirror({
                walletClient,
                publicClient,
                venueRegistry: config.deployments.demoPark.venueRegistry,
                maxQueuedEvents: config.venueMirrorMaxQueued,
                log,
            });
            // M3.7 — sweeper. On GUEST_EXIT, signs a fresh permit with spender=treasury (entry-
            // time permit went to SettlementBatcher; no sweep entrypoint there) and submits
            // [permit, transferFrom] pairs through `treasury.executeBatch`. Same wallet client.
            sweeper = new Sweeper({
                walletClient,
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
    const relayerPoolHandle = new RelayerPool({relayers, submitter, metrics, log});
    const batcher = new Batcher({sink: relayerPoolHandle.sink, log});

    const runtime: SidecarRuntime = {
        config,
        keystoreCreatedAt: unlocked.createdAt,
        keystoreCreated,
        relayers,
        guestCache,
        batcher,
        relayerPool: relayerPoolHandle,
        metrics,
    };
    if (outboxReader) runtime.outboxReader = outboxReader;
    if (balances) runtime.balances = balances;
    if (faucet) runtime.faucet = faucet;
    if (topup) runtime.topup = topup;
    if (funder) runtime.funder = funder;
    if (permits) runtime.permits = permits;
    if (sweeper) runtime.sweeper = sweeper;
    if (venueMirror) runtime.venueMirror = venueMirror;

    const server = new RpcServer(config.socketPath);
    registerCoreHandlers(server, runtime);

    await server.listen();
    if (funder) {
        // One-time approval at boot. If this fails, the funder won't accept entries — the
        // dispatcher below logs but does not crash the sidecar (other subsystems still work).
        try {
            await funder.start();
        } catch (err) {
            log.error({err}, "funder.start failed; entering guests will not be funded");
        }
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
                    if (permits && permitDom) {
                        // Sign the permit off-chain. nonce=0 holds for fresh guests; M3.7's
                        // sweeper signs a *separate* permit at exit (with spender=treasury)
                        // because the entry-time permit went to SettlementBatcher and the
                        // deployed batcher has no sweep entrypoint.
                        try {
                            const guestAccount = deriveGuest(unlocked.mnemonic, event.hdIndex);
                            const deadline = BigInt(Math.floor(Date.now() / 1000)) + permitDeadlineSecs;
                            const signed = await signPermit(guestAccount.account, permitDom, {
                                owner: address,
                                spender: batcherAddr,
                                value: permitValue,
                                nonce: 0n,
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
                case "VENUE_REGISTERED":
                    if (venueMirror) {
                        venueMirror.accept({
                            kind: "register",
                            venueId: event.venueId,
                            venueKind: event.venueKind,
                            name: event.name,
                            objectType: event.objectType,
                        });
                    } else {
                        log.debug({event}, "VENUE_REGISTERED (mirror not configured)");
                    }
                    break;
                case "VENUE_RENAMED":
                    if (venueMirror) {
                        venueMirror.accept({kind: "rename", venueId: event.venueId, newName: event.newName});
                    } else {
                        log.debug({event}, "VENUE_RENAMED (mirror not configured)");
                    }
                    break;
                case "VENUE_REMOVED":
                    if (venueMirror) {
                        venueMirror.accept({kind: "remove", venueId: event.venueId});
                    } else {
                        log.debug({event}, "VENUE_REMOVED (mirror not configured)");
                    }
                    break;
                // M3.x (spend) will plug its handler here. Today this branch just logs.
                case "GUEST_SPEND":
                    log.debug({event}, "GUEST_SPEND (batcher dispatcher not yet wired)");
                    break;
            }
        });
    }
    if (topup) topup.start();
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
        },
        "sidecar ready",
    );

    const shutdown = async (signal: string): Promise<void> => {
        log.info({signal}, "shutting down");
        // Order: outbox (producer) → batcher (sink-driver) → relayer pool (terminal sink) →
        // server. Top-up loop is independent of all of them.
        if (topup) await topup.stop().catch((err) => log.error({err}, "topup stop failed"));
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
