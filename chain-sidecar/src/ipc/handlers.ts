import type {SidecarConfig} from "../config.js";
import type {DerivedAccount} from "../derive/index.js";
import type {RpcServer, Handler} from "./server.js";

/// Runtime state needed by the JSON-RPC handlers. Built once at sidecar boot and threaded
/// into the registration calls below — keeps handlers free of module-level globals so each
/// sidecar instance is isolated (matters for tests and for any future "two parks per host"
/// scenario).
export interface SidecarRuntime {
    config: SidecarConfig;
    keystoreCreatedAt: string;
    /// Whether the keystore was freshly generated on this boot vs loaded from disk. Used by
    /// the in-game UI to nudge the operator to back up the encrypted file the first time.
    keystoreCreated: boolean;
    relayers: readonly DerivedAccount[];
}

/// Handlers that exist from M2.1+ onward. As later milestones land — batcher, venue mirror,
/// metrics — they each add their own handlers via `RpcServer.register(...)`.
export function registerCoreHandlers(server: RpcServer, runtime: SidecarRuntime): void {
    const startedAt = new Date();

    const keystoreStatus = (): KeystoreStatus => ({
        path: runtime.config.keystorePath,
        createdAt: runtime.keystoreCreatedAt,
        createdThisBoot: runtime.keystoreCreated,
        relayerCount: runtime.relayers.length,
        // Addresses only — never the private keys, never the mnemonic. The keystore is the
        // only thing on disk that can recover those, and it stays at rest.
        relayers: runtime.relayers.map((r, i) => ({index: i, address: r.address, path: r.path})),
        guestPathPrefix: "m/44'/60'/0'/0",
    });

    const status: Handler = () => ({
        ok: true,
        version: SIDECAR_VERSION,
        startedAt: startedAt.toISOString(),
        uptimeSeconds: Math.floor((Date.now() - startedAt.getTime()) / 1000),
        socket: runtime.config.socketPath,
        deployments: {
            path: runtime.config.deploymentsPath,
            chainId: runtime.config.deployments.chainId,
            startBlock: runtime.config.deployments.startBlock,
            settlementBatcher: runtime.config.deployments.demoPark.settlementBatcher,
        },
        keystore: keystoreStatus(),
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
    server.register("keystore.status", () => keystoreStatus());
}

export interface KeystoreStatus {
    path: string;
    createdAt: string;
    createdThisBoot: boolean;
    relayerCount: number;
    relayers: ReadonlyArray<{index: number; address: `0x${string}`; path: string}>;
    guestPathPrefix: string;
}

/// Bumped manually when the wire protocol or methods change. The status handler exposes it so
/// rctctl can refuse to talk to a sidecar from a future milestone.
export const SIDECAR_VERSION = "0.1.0";
