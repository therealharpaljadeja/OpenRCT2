#!/usr/bin/env node
import {parseArgs} from "./config.js";
import {RpcServer} from "./ipc/server.js";
import {registerCoreHandlers} from "./ipc/handlers.js";
import {log} from "./log.js";

/// Sidecar entrypoint. Boots the JSON-RPC server, registers built-in handlers, and waits
/// for SIGINT/SIGTERM. Subsequent milestones plug additional subsystems (batcher, relayers,
/// funder, venue mirror) into the same server object.
async function main(): Promise<void> {
    let config;
    try {
        config = parseArgs(process.argv.slice(2));
    } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        process.stderr.write(`${msg}\n`);
        process.exit(2);
    }

    const server = new RpcServer(config.socketPath);
    registerCoreHandlers(server, config);

    await server.listen();
    log.info(
        {
            socket: config.socketPath,
            chainId: config.deployments.chainId,
            settlementBatcher: config.deployments.demoPark.settlementBatcher,
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
