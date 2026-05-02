import type {SidecarConfig} from "../config.js";
import type {RpcServer, Handler} from "./server.js";

/// Handlers that exist from M2.1 onward. As later milestones land — batcher, relayer pool,
/// venue mirror — they each add their own handlers via `RpcServer.register(...)`.
export function registerCoreHandlers(server: RpcServer, config: SidecarConfig): void {
    const startedAt = new Date();

    const status: Handler = () => ({
        ok: true,
        version: SIDECAR_VERSION,
        startedAt: startedAt.toISOString(),
        uptimeSeconds: Math.floor((Date.now() - startedAt.getTime()) / 1000),
        socket: config.socketPath,
        deployments: {
            path: config.deploymentsPath,
            chainId: config.deployments.chainId,
            startBlock: config.deployments.startBlock,
            settlementBatcher: config.deployments.demoPark.settlementBatcher,
        },
        // Surfacing the registered method list lets `rctctl chain status` print "n/14 ready"
        // as the surface fills in across milestones, without having to update rctctl in lockstep.
        methods: server.methods(),
    });

    const ping: Handler = () => "pong";

    const shutdown: Handler = async (_params, ctx) => {
        ctx.log.info("rpc shutdown requested");
        // Defer the actual close so we can flush the response back to the caller first.
        setImmediate(() => {
            void ctx.server.close().then(() => process.exit(0));
        });
        return {ok: true};
    };

    server.register("sidecar.status", status);
    server.register("sidecar.ping", ping);
    server.register("sidecar.shutdown", shutdown);
}

/// Bumped manually when the wire protocol or methods change. The status handler exposes it so
/// rctctl can refuse to talk to a sidecar from a future milestone.
export const SIDECAR_VERSION = "0.1.0";
