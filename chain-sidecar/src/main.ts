#!/usr/bin/env node
import {parseArgs} from "./config.js";
import {relayerPool} from "./derive/index.js";
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
    const relayerPoolHandle = new RelayerPool({relayers, submitter, log});
    const batcher = new Batcher({sink: relayerPoolHandle.sink, log});

    const runtime: SidecarRuntime = {
        config,
        keystoreCreatedAt: unlocked.createdAt,
        keystoreCreated,
        relayers,
        guestCache,
        batcher,
        relayerPool: relayerPoolHandle,
    };
    if (outboxReader) runtime.outboxReader = outboxReader;
    if (balances) runtime.balances = balances;
    if (faucet) runtime.faucet = faucet;
    if (topup) runtime.topup = topup;
    if (funder) runtime.funder = funder;

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
    if (outboxReader) {
        // Dispatch by event kind. Each subsystem owns its own kinds; unhandled kinds are
        // logged at debug level — at full throughput we don't want a noisy line per event,
        // and the relevant counters live on each subsystem's `stats()`.
        await outboxReader.start((event: OutboxEvent) => {
            switch (event.kind) {
                case "GUEST_ENTRY": {
                    if (!funder) {
                        log.debug({event}, "GUEST_ENTRY received but funder disabled");
                        break;
                    }
                    let address: `0x${string}`;
                    try {
                        address = guestCache.addressOf(event.hdIndex);
                    } catch (err) {
                        log.warn({err, event}, "GUEST_ENTRY: address derivation failed");
                        break;
                    }
                    let amount: bigint;
                    try {
                        amount = BigInt(event.cash);
                    } catch (err) {
                        log.warn({err, cash: event.cash, event}, "GUEST_ENTRY: invalid cash decimal");
                        break;
                    }
                    funder.accept({address, amount});
                    break;
                }
                // M3.6 (permit), M3.7 (sweep), M3.8 (venue mirror), M3.x (spend) will plug
                // their own handlers here. Today these branches just log at debug.
                case "GUEST_SPEND":
                case "GUEST_EXIT":
                case "VENUE_REGISTERED":
                case "VENUE_RENAMED":
                case "VENUE_REMOVED":
                    log.debug({event}, "outbox event (no handler yet)");
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
