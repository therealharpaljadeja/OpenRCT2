import type {SidecarConfig} from "../config.js";
import type {DerivedAccount} from "../derive/index.js";
import type {GuestAddressCache} from "../derive/cache.js";
import type {OutboxReader} from "../outbox/index.js";
import type {BalanceReader, FaucetWriter, RelayerTopUp} from "../chain/index.js";
import {parkLaunchSetup} from "../chain/index.js";
import {ErrorCode, RpcError} from "./protocol.js";
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
    /// Guest HD address cache (M2.3). Owns the only in-process reference to the master
    /// mnemonic outside the keystore module itself; addresses are looked up here so the
    /// game-facing IPC and the future batcher can share one source of truth.
    guestCache: GuestAddressCache;
    /// Outbox reader (M2.4). `undefined` when no `--outbox` was passed — the sidecar still
    /// boots fine without a producer, useful for unit tests and ahead-of-game-launch ops.
    outboxReader?: OutboxReader;
    /// On-chain plumbing (M2.5). All three are present together when `--rpc-url` and a
    /// faucet-owner key are supplied; otherwise the sidecar runs in offline mode and
    /// `chain.balances` / `chain.faucet.drip` return InvalidRequest.
    balances?: BalanceReader;
    faucet?: FaucetWriter;
    topup?: RelayerTopUp;
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
        guestCache: runtime.guestCache.stats(),
    });

    const guestAddress: Handler = (params) => {
        const idx = readIndex(params);
        return {index: idx, address: runtime.guestCache.addressOf(idx)};
    };

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
    // Game uses this on `SpawnGuest` to look up the guest's onchain address by HD index
    // (plan §5.1, §5.3 `GuestEntered`). Cheap after first call thanks to the cache.
    server.register("guest.address", guestAddress);
    // M2.4: outbox drain status — `rctctl chain status` will eventually surface this. Returns
    // `{enabled: false}` when no `--outbox` was configured so callers can branch cleanly.
    server.register("outbox.status", () =>
        runtime.outboxReader ? {enabled: true, ...runtime.outboxReader.stats()} : {enabled: false},
    );
    // M2.5 — on-chain plumbing. Same pattern as outbox.status: callers always get a defined
    // shape and can branch on `enabled`.
    server.register("chain.balances", async () => {
        if (!runtime.balances) return {enabled: false};
        const treasury = runtime.config.deployments.demoPark.treasury;
        const relayerAddrs = runtime.relayers.map((r) => r.address);
        const [treasuryPark, relayerMon] = await Promise.all([
            runtime.balances.parkBalance(treasury),
            runtime.balances.nativeBalances(relayerAddrs),
        ]);
        return {
            enabled: true,
            treasury: {address: treasury, parkWei: treasuryPark.toString()},
            relayers: relayerAddrs.map((address, i) => ({
                index: i,
                address,
                monWei: relayerMon[i]!.toString(),
            })),
        };
    });
    server.register("chain.topup.status", () => {
        if (!runtime.topup) return {enabled: false};
        const s = runtime.topup.stats();
        return {enabled: true, ...s};
    });
    server.register("chain.faucet.drip", async () => {
        if (!runtime.faucet || !runtime.topup) {
            throw new RpcError(
                ErrorCode.InvalidRequest,
                "chain.faucet.drip requires --rpc-url and a faucet-owner key",
            );
        }
        // Park-launch flow: drip the standing PARK quota into treasury, then ask the top-up
        // loop to fire a single tick so any under-water relayers come up to target now (not
        // at the next interval).
        const result = await parkLaunchSetup(runtime.faucet, {
            treasury: runtime.config.deployments.demoPark.treasury,
            relayers: runtime.relayers.map((r) => r.address),
            parkAmount: runtime.config.parkLaunchWei,
            monPerRelayer: runtime.config.monTargetWei,
        });
        return {
            parkTx: result.parkTx,
            monTx: result.monTx,
            parkAmountWei: runtime.config.parkLaunchWei.toString(),
            monPerRelayerWei: runtime.config.monTargetWei.toString(),
        };
    });
}

/// Pulls a non-negative integer `index` out of either an object-form (`{index: N}`) or a
/// positional-form (`[N]`) JSON-RPC params payload. Throws an RpcError with InvalidParams
/// (-32602) so the server reports a clean "bad params" response rather than a generic 500.
function readIndex(params: unknown): number {
    let raw: unknown;
    if (Array.isArray(params)) raw = params[0];
    else if (params && typeof params === "object" && "index" in params) {
        raw = (params as {index: unknown}).index;
    } else {
        throw new RpcError(ErrorCode.InvalidParams, "guest.address requires { index } or [index]");
    }
    if (typeof raw !== "number" || !Number.isInteger(raw) || raw < 0) {
        throw new RpcError(
            ErrorCode.InvalidParams,
            `guest.address: index must be a non-negative integer, got ${String(raw)}`,
        );
    }
    return raw;
}

export interface KeystoreStatus {
    path: string;
    createdAt: string;
    createdThisBoot: boolean;
    relayerCount: number;
    relayers: ReadonlyArray<{index: number; address: `0x${string}`; path: string}>;
    guestPathPrefix: string;
    guestCache: {size: number; hits: number; misses: number};
}

/// Bumped manually when the wire protocol or methods change. The status handler exposes it so
/// rctctl can refuse to talk to a sidecar from a future milestone.
export const SIDECAR_VERSION = "0.1.0";
