#!/usr/bin/env node
import {parseArgs} from "./config.js";
import {relayerPool} from "./derive/index.js";
import {GuestAddressCache} from "./derive/cache.js";
import {RpcServer} from "./ipc/server.js";
import {registerCoreHandlers, type SidecarRuntime} from "./ipc/handlers.js";
import {KeystoreError, loadOrCreateKeystoreFile} from "./keystore/index.js";
import {log} from "./log.js";

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

    const runtime: SidecarRuntime = {
        config,
        keystoreCreatedAt: unlocked.createdAt,
        keystoreCreated,
        relayers,
        guestCache,
    };

    const server = new RpcServer(config.socketPath);
    registerCoreHandlers(server, runtime);

    await server.listen();
    log.info(
        {
            socket: config.socketPath,
            chainId: config.deployments.chainId,
            settlementBatcher: config.deployments.demoPark.settlementBatcher,
            relayers: relayers.length,
        },
        "sidecar ready",
    );

    const shutdown = async (signal: string): Promise<void> => {
        log.info({signal}, "shutting down");
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
