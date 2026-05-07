import type {SidecarConfig} from "../config.js";
import type {DerivedAccount} from "../derive/index.js";
import type {GuestAddressCache} from "../derive/cache.js";
import type {OutboxReader} from "../outbox/index.js";
import type {BalanceReader, FaucetReserveTopUp, FaucetWriter, RelayerTopUp} from "../chain/index.js";
import {parkLaunchSetup} from "../chain/index.js";
import type {Batcher, SpendDispatcher, SpendNonceTracker} from "../batcher/index.js";
import type {RelayerPool} from "../relayers/index.js";
import type {Funder} from "../funder/index.js";
import type {PermitCollector} from "../permits/index.js";
import type {Sweeper} from "../sweeper/index.js";
import type {VenueMirror} from "../venues/index.js";
import type {MetricsAggregator} from "../metrics/index.js";
import type {SpendRateLimiter} from "../ratelimit/index.js";
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
    /// Auto-topup loop that keeps the Faucet contract's MON balance funded out of the
    /// deployer EOA. Surfaces deployer-low alarms via `chain.faucetReserve.status` so the
    /// in-game terminal can show a banner before the pipeline stalls.
    faucetReserve?: FaucetReserveTopUp;
    /// Chain head at sidecar boot. The indexer launcher (`scripts/start-indexer.sh`)
    /// reads this — either from the on-disk file or via `chain.indexer.config` — so its
    /// `start_block` matches the sidecar's session boundary and pre-session events from
    /// previous epochs don't pollute the index.
    indexerStartBlock?: bigint;
    /// Directory containing the `indexer-start-block` file (the sidecar's chain workspace
    /// — same dir as the outbox WAL). Surfaced via IPC so external tools don't have to
    /// rediscover the workspace.
    indexerChainDir?: string;
    /// Batch accumulator (M3.2). Always present; runs idle until M3.5 wires the funder /
    /// outbox to feed it and M3.3 swaps the no-op sink for the relayer pool.
    batcher?: Batcher;
    /// Relayer pool (M3.3). The batcher's sink in production. M3.4 swaps the submitter for
    /// the viem-backed `eth_sendRawTransactionSync` impl without changing this wiring.
    relayerPool?: RelayerPool;
    /// Funder (M3.5). Present together with the chain plumbing — the deployer key drives
    /// `treasury.execute(disperse, disperseToken(...))` per window. Returns `{enabled: false}`
    /// over IPC when offline.
    funder?: Funder;
    /// Permit collector (M3.6). Buffers EIP-2612 permit sigs at GUEST_ENTRY and submits them
    /// in `treasury.executeBatch([parkToken.permit(...)] × N)` calls so the SettlementBatcher
    /// has unlimited PARK allowance from each guest before the first GUEST_SPEND.
    permits?: PermitCollector;
    /// Sweeper (M3.7). Buffers `GUEST_EXIT` events and returns each guest's residual PARK
    /// balance to the treasury via batched `[permit, transferFrom]` pairs. Returns
    /// `{enabled: false}` over IPC when offline.
    sweeper?: Sweeper;
    /// Venue mirror (M3.8). Submits one tx per `VENUE_*` event and caches the venue table
    /// locally so the spend batcher can resolve `venueId → kind / subAccount` without a
    /// chain read on the hot path.
    venueMirror?: VenueMirror;
    /// Metrics aggregator (M3.9). Always present (no chain dependency); the relayer pool
    /// pumps tx/auth events into it so `chain.throughput` returns live rolling-window rates
    /// + latency percentiles.
    metrics?: MetricsAggregator;
    /// Per-guest spend rate limiter (M3.10). Always present; the GUEST_SPEND dispatcher
    /// consults it before any signing work and drops over-cap spends with a counter bump.
    rateLimiter?: SpendRateLimiter;
    /// Per-guest signature-nonce tracker (M3.11). Present together with the chain plumbing
    /// — first-touch fetch reads `SettlementBatcher.sigNonces[guest]` from chain. The
    /// dispatcher reserves the next nonce here on every accepted GUEST_SPEND.
    spendNonces?: SpendNonceTracker;
    /// GUEST_SPEND → SpendAuth → Batcher hot path (M3.11). Present when chain plumbing is
    /// configured; the outbox dispatcher routes every GUEST_SPEND through `handle()`.
    spendDispatcher?: SpendDispatcher;
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
    // M2.6 — runtime view of `deployments.json`. The sidecar is the single source of truth
    // at runtime: game, rctctl, indexer all want the addresses, and asking the sidecar
    // means a future per-park-CREATE2 amendment lands on every consumer at once.
    server.register("chain.deployments", () => ({
        path: runtime.config.deploymentsPath,
        deployments: runtime.config.deployments,
    }));
    // M3.2 — batch accumulator. Read-only `chain.batch.status` plus a write-side
    // `chain.batch.config` so operators (and `rctctl chain batch config`) can tune the
    // size/age/queue knobs without restarting the sidecar.
    server.register("chain.batch.status", () =>
        runtime.batcher ? {enabled: true, ...runtime.batcher.stats()} : {enabled: false},
    );
    // M3.3 — relayer pool stats. Per-relayer nonce / busy / counters / last-tx hash, plus
    // pool aggregates (busy/free, queued, totals). Drives `rctctl chain relayers` and the
    // in-game treasury window's relayer-health line.
    server.register("chain.relayers", () =>
        runtime.relayerPool ? {enabled: true, ...runtime.relayerPool.stats()} : {enabled: false},
    );
    // M3.5 — funder status. `approvalTx` is the one-time approval the funder posted at boot;
    // null until `start()` lands (or if the existing allowance was already adequate, in which
    // case we skipped the approve). Counters mirror Batcher's surface.
    server.register("chain.funder.status", () => {
        if (!runtime.funder) return {enabled: false};
        const s = runtime.funder.stats();
        return {
            enabled: true,
            ...s,
            // Stringify bigints / hex so the JSON-RPC layer doesn't trip on them.
            approvalTx: s.approvalTx,
        };
    });
    // M3.6 — permit collector status. Same shape as the funder: `{enabled: false}` offline,
    // counters + queue depth + flush-reason histogram online.
    server.register("chain.permits.status", () =>
        runtime.permits ? {enabled: true, ...runtime.permits.stats()} : {enabled: false},
    );
    // M3.7 — sweeper status. Same shape, with two extra counters (`zeroBalanceExits` so a
    // park full of broke guests doesn't look like a stalled sweeper).
    server.register("chain.sweeper.status", () =>
        runtime.sweeper ? {enabled: true, ...runtime.sweeper.stats()} : {enabled: false},
    );
    // M3.8 — venue mirror status + lookup helpers. `chain.venues.list` returns the cached
    // table so rctctl / the in-game treasury window can render it without re-reading the
    // chain; `chain.venues.get` is the single-id form used by `rctctl chain venue --id <vid>`.
    server.register("chain.venues.status", () =>
        runtime.venueMirror ? {enabled: true, ...runtime.venueMirror.stats()} : {enabled: false},
    );
    server.register("chain.venues.list", () => {
        if (!runtime.venueMirror) return {enabled: false};
        return {enabled: true, venues: runtime.venueMirror.list()};
    });
    server.register("chain.venues.get", (params) => {
        if (!runtime.venueMirror) return {enabled: false};
        const id = readVenueId(params);
        const v = runtime.venueMirror.lookup(id);
        return v ? {enabled: true, venue: v} : {enabled: true, venue: null};
    });
    // M3.9 — `chain.throughput` is the headline rctctl command (plan §6 Read). Joins the
    // metrics aggregator's rolling-window snapshot with instantaneous gauges from every
    // subsystem so a single call gives operators / the in-game treasury window everything
    // they need: rates, latency percentiles, queue depths, drops, RPC errors. Always
    // returns `{enabled: true}` because the aggregator is wired unconditionally — even on
    // a dry boot with no chain plumbing, the rates are zero rather than the surface absent.
    server.register("chain.throughput", () => {
        if (!runtime.metrics) return {enabled: false};
        const snap = runtime.metrics.snapshot();
        const batchStats = runtime.batcher?.stats();
        const poolStats = runtime.relayerPool?.stats();
        const outboxStats = runtime.outboxReader?.stats();
        const funderStats = runtime.funder?.stats();
        const permitStats = runtime.permits?.stats();
        const sweeperStats = runtime.sweeper?.stats();
        const venueStats = runtime.venueMirror?.stats();
        const rateStats = runtime.rateLimiter?.stats();
        const dispatchStats = runtime.spendDispatcher?.stats();
        return {
            enabled: true,
            now: snap.now,
            windowMs: snap.windowMs,
            txPerSecond: snap.txPerSecond,
            authPerSecond: snap.authPerSecond,
            txInWindow: snap.txInWindow,
            authInWindow: snap.authInWindow,
            latencyMs: snap.latencyMs,
            batchFill: snap.batchFill,
            totals: {
                txSubmitted: snap.totalTxSubmitted,
                authSubmitted: snap.totalAuthSubmitted,
                txFailed: snap.totalTxFailed,
                droppedAuthsFromMetrics: snap.totalDroppedAuths,
            },
            queues: {
                /// Auths waiting for the next batch flush.
                batcherDepth: batchStats?.queueDepth ?? null,
                /// Batches waiting for a free relayer.
                relayerPoolQueueDepth: poolStats?.queuedBatches ?? null,
                /// Outbox events processed since boot — useful for "is the producer alive"
                /// trending; the WAL depth isn't tracked server-side, so this is the closest
                /// proxy we have here.
                outboxProcessed: outboxStats?.processed ?? null,
                /// Per-subsystem queue depths (low-volume admin paths).
                funderDepth: funderStats?.queueDepth ?? null,
                permitsDepth: permitStats?.queueDepth ?? null,
                sweeperDepth: sweeperStats?.queueDepth ?? null,
                venueMirrorDepth: venueStats?.queueDepth ?? null,
            },
            drops: {
                /// Auth-side drops authoritatively counted by the batcher (oldest-drop on
                /// active buffer overflow).
                batcherAuths: batchStats?.droppedAuths ?? 0,
                funderEntries: funderStats?.droppedEntries ?? 0,
                permits: permitStats?.droppedPermits ?? 0,
                sweeperExits: sweeperStats?.droppedExits ?? 0,
                venueEvents: venueStats?.droppedEvents ?? 0,
                /// Spends rejected by the M3.10 per-guest rate limiter — pre-batcher drops.
                /// A non-zero counter signals one or more runaway guests at the cap.
                rateLimitedSpends: rateStats?.rejected ?? 0,
                /// M3.11 dispatcher drops, broken out by reason. Mostly zero in healthy
                /// operation; non-zero `unknownVenue` flags a venue-mirror lag, `nonceErrors`
                /// flags chain-RPC trouble during the first-touch nonce fetch.
                dispatcherUnknownVenue: dispatchStats?.droppedUnknownVenue ?? 0,
                dispatcherInactiveVenue: dispatchStats?.droppedInactiveVenue ?? 0,
                dispatcherAddressDerivation: dispatchStats?.droppedAddressDerivation ?? 0,
                dispatcherMalformed: dispatchStats?.droppedMalformed ?? 0,
            },
            errors: {
                /// Per-subsystem error counters. Each is incremented on a failed RPC /
                /// chain call; non-zero values are the signal to look at the logs.
                batcherSinkErrors: batchStats?.sinkErrors ?? 0,
                relayerPoolErrors: poolStats?.totalErrors ?? 0,
                relayerPoolNonceRefreshes: poolStats?.totalNonceRefreshes ?? 0,
                relayerPoolQueueRejections: poolStats?.totalQueueRejections ?? 0,
                funderRpc: funderStats?.rpcErrors ?? 0,
                permitsRpc: permitStats?.rpcErrors ?? 0,
                sweeperRpc: sweeperStats?.rpcErrors ?? 0,
                venueMirrorRpc: venueStats?.rpcErrors ?? 0,
                venueMirrorSkippedAlreadyApplied: venueStats?.skippedAlreadyApplied ?? 0,
                /// M3.11 dispatcher chain/sign errors. Distinct from the relayer pool's
                /// errors because they happen *before* a batch is built.
                dispatcherSignErrors: dispatchStats?.signErrors ?? 0,
                dispatcherNonceErrors: dispatchStats?.nonceErrors ?? 0,
            },
            relayers: poolStats
                ? {
                      size: poolStats.size,
                      busy: poolStats.busy,
                      free: poolStats.free,
                  }
                : null,
        };
    });
    server.register("chain.batch.config", (params) => {
        if (!runtime.batcher) {
            throw new RpcError(ErrorCode.InvalidRequest, "chain.batch.config: batcher not enabled");
        }
        const patch = readBatchConfigPatch(params);
        if (Object.keys(patch).length === 0) {
            // Returning current stats on an empty patch makes this a useful "what's the
            // current config?" probe — operators don't have to remember a separate verb.
            return {ok: true, ...runtime.batcher.stats()};
        }
        try {
            runtime.batcher.updateConfig(patch);
        } catch (err) {
            // Validator throws plain Errors; surface as a clean InvalidParams instead of a 500.
            throw new RpcError(ErrorCode.InvalidParams, err instanceof Error ? err.message : String(err));
        }
        return {ok: true, ...runtime.batcher.stats()};
    });
    // M3.11 — GUEST_SPEND dispatcher status. Surfaces the per-reason drop histogram and the
    // sig-nonce tracker stats so a stress run can see exactly where events went: dropped vs
    // signed vs sink-error. Returns `{enabled: false}` offline (matches the rest of the
    // chain-* surface).
    // Auto-topup loop that keeps the Faucet contract funded out of the deployer EOA.
    // The `deployerCritical` flag is the operational signal worth watching: when it flips
    // true, the operator must fund the deployer manually from the Monad testnet faucet or
    // the whole settle pipeline will eventually stall as the Faucet drains.
    server.register("chain.faucetReserve.status", () =>
        runtime.faucetReserve ? {enabled: true, ...runtime.faucetReserve.stats()} : {enabled: false},
    );
    // Indexer config — start block + chain workspace + the four contract addresses the
    // indexer needs. Lets `scripts/start-indexer.sh` (and any future rctctl helper) launch
    // an Envio session aligned to this sidecar's epoch without re-deriving anything.
    server.register("chain.indexer.config", () => {
        if (runtime.indexerStartBlock === undefined) return {enabled: false};
        return {
            enabled: true,
            startBlock: runtime.indexerStartBlock.toString(),
            chainDir: runtime.indexerChainDir ?? null,
            chainId: runtime.config.deployments.chainId,
            contracts: {
                venueRegistry: runtime.config.deployments.demoPark.venueRegistry,
                settlementBatcher: runtime.config.deployments.demoPark.settlementBatcher,
                guestRegistry: runtime.config.deployments.demoPark.guestRegistry,
                lendingPool: runtime.config.deployments.demoPark.lendingPool,
            },
        };
    });
    // Park earnings — one-shot summary the in-game agent uses to brief the human.
    // Aggregates per-venue PARK balances (each venue's CREATE2 sub-account is its lifetime
    // revenue ledger), the treasury operating budget, and the deployer's MON backstop.
    // Activity counters and pipeline-health are surfaced inline so the agent can decide
    // whether to flag any operational issues alongside the revenue numbers.
    //
    // PARK locked in venue sub-accounts is by design (contract has no withdraw path) — the
    // total here reads as "what the park has earned, ever, since this session's epoch."
    server.register("chain.parkEarnings", async (params) => {
        if (!runtime.balances || !runtime.venueMirror) return {enabled: false};
        // Optional `all: boolean` flag — when omitted, the byVenue list is sliced to the
        // top 5 by balance so the agent's terse rendering doesn't drown in noise. The
        // totals and per-kind breakdown always reflect the full venue set.
        const showAll = params && typeof params === "object" && (params as {all?: boolean}).all === true;
        const venues = runtime.venueMirror.list();
        const treasury = runtime.config.deployments.demoPark.treasury;

        // One round-trip per balance — viem batches into a single HTTP call thanks to the
        // shared transport. Even for 100 venues this is well under one block of latency.
        const subAccountBalances = await Promise.all(
            venues.map((v) => runtime.balances!.parkBalance(v.subAccount)),
        );
        const treasuryBalance = await runtime.balances.parkBalance(treasury);

        // VenueKind enum: 0 ParkEntrance / 1 Ride / 2 Shop / 3 Stall / 4 Facility / 5 ATM.
        // Match the Solidity ordering exactly so callers can index by kind without lookup.
        const kindLabels = ["parkEntrance", "ride", "shop", "stall", "facility", "atm"] as const;
        const byKindWei: Record<string, bigint> = Object.fromEntries(kindLabels.map((k) => [k, 0n]));
        const byKindCount: Record<string, number> = Object.fromEntries(kindLabels.map((k) => [k, 0]));
        let totalRevenue = 0n;
        const byVenue = venues.map((v, i) => {
            const bal = subAccountBalances[i]!;
            totalRevenue += bal;
            const label = kindLabels[v.kind] ?? "unknown";
            byKindWei[label] = (byKindWei[label] ?? 0n) + bal;
            byKindCount[label] = (byKindCount[label] ?? 0) + 1;
            return {
                id: v.id,
                name: v.name,
                kind: v.kind,
                kindLabel: label,
                subAccount: v.subAccount,
                balanceWei: bal.toString(),
                active: v.active,
            };
        });
        // Sort descending by revenue so the top-N renderer just slices the head.
        byVenue.sort((a, b) => {
            const ax = BigInt(a.balanceWei);
            const bx = BigInt(b.balanceWei);
            return bx > ax ? 1 : bx < ax ? -1 : 0;
        });

        // Activity from the spend dispatcher's counters. `signed` is the count that
        // reached the batcher (and on-chain absent revert); the dropped* family is
        // pre-batcher rejections broken out by reason.
        const dispatch = runtime.spendDispatcher?.stats();
        const dropped = dispatch
            ? dispatch.droppedRateLimited
                + dispatch.droppedUnknownVenue
                + dispatch.droppedInactiveVenue
                + dispatch.droppedAddressDerivation
                + dispatch.droppedMalformed
            : 0;

        // Pipeline health pulled from the faucet-reserve loop's stats. The headline signal
        // is `deployerCritical` — once that flips the whole settle path stalls in minutes.
        const reserve = runtime.faucetReserve?.stats();
        const alerts: string[] = [];
        if (reserve?.deployerCritical) alerts.push("deployer EOA below critical floor — fund from testnet faucet");

        return {
            enabled: true,
            totalRevenueWei: totalRevenue.toString(),
            treasuryWei: treasuryBalance.toString(),
            deployerWei: reserve?.lastDeployerBalance ?? "0",
            faucetWei: reserve?.lastFaucetBalance ?? "0",
            venueCount: venues.length,
            byKindWei: Object.fromEntries(Object.entries(byKindWei).map(([k, v]) => [k, v.toString()])),
            byKindCount,
            // Slice top-5 by default. The full list ships when `params.all === true` so a
            // big park doesn't bury the renderer in dozens of low-balance rows.
            byVenue: showAll ? byVenue : byVenue.slice(0, 5),
            byVenueTotal: byVenue.length,
            activity: dispatch
                ? {
                      accepted: dispatch.accepted,
                      signed: dispatch.signed,
                      dropped,
                      droppedReasons: {
                          rateLimited: dispatch.droppedRateLimited,
                          unknownVenue: dispatch.droppedUnknownVenue,
                          inactiveVenue: dispatch.droppedInactiveVenue,
                          addressDerivation: dispatch.droppedAddressDerivation,
                          malformed: dispatch.droppedMalformed,
                      },
                  }
                : null,
            pipeline: {
                healthy: alerts.length === 0,
                alerts,
            },
        };
    });
    server.register("chain.spend.status", () => {
        if (!runtime.spendDispatcher) return {enabled: false};
        const dispatch = runtime.spendDispatcher.stats();
        const nonceStats = runtime.spendNonces?.stats() ?? {size: 0, fetches: 0};
        return {
            enabled: true,
            dispatcher: dispatch,
            nonces: nonceStats,
        };
    });
    // M3.10 — per-guest spend rate cap. Always-on (no chain dependency).
    server.register("chain.ratelimit.status", () =>
        runtime.rateLimiter ? {enabled: true, ...runtime.rateLimiter.stats()} : {enabled: false},
    );
    server.register("chain.ratelimit.config", (params) => {
        if (!runtime.rateLimiter) {
            throw new RpcError(ErrorCode.InvalidRequest, "chain.ratelimit.config: rate limiter not enabled");
        }
        const next = readRateLimitPatch(params);
        if (next === undefined) {
            // Empty / probe form — return current stats so operators don't need a separate
            // verb to "what's the current cap?".
            return {ok: true, ...runtime.rateLimiter.stats()};
        }
        try {
            runtime.rateLimiter.updateConfig(next);
        } catch (err) {
            throw new RpcError(ErrorCode.InvalidParams, err instanceof Error ? err.message : String(err));
        }
        return {ok: true, ...runtime.rateLimiter.stats()};
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

/// Pull a uint32 venue id out of the JSON-RPC params (object or positional form).
function readVenueId(params: unknown): number {
    let raw: unknown;
    if (Array.isArray(params)) raw = params[0];
    else if (params && typeof params === "object" && "id" in params) {
        raw = (params as {id: unknown}).id;
    } else {
        throw new RpcError(ErrorCode.InvalidParams, "chain.venues.get requires { id } or [id]");
    }
    if (typeof raw !== "number" || !Number.isInteger(raw) || raw < 0 || raw > 0xffff_ffff) {
        throw new RpcError(
            ErrorCode.InvalidParams,
            `chain.venues.get: id must be a uint32, got ${String(raw)}`,
        );
    }
    return raw;
}

/// Pull `{maxSize?, maxAgeMs?, maxQueuedAuths?}` out of the JSON-RPC params. All keys are
/// optional; unknown keys cause an `InvalidParams` so a typo doesn't silently no-op. We do
/// the type-narrowing here (rather than in the batcher) so the batcher's `updateConfig` can
/// throw on semantic violations (range, integer-ness) and we map those to InvalidParams.
function readBatchConfigPatch(params: unknown): {
    maxSize?: number;
    maxAgeMs?: number;
    maxQueuedAuths?: number;
} {
    if (params === undefined || params === null) return {};
    if (typeof params !== "object" || Array.isArray(params)) {
        throw new RpcError(ErrorCode.InvalidParams, "chain.batch.config requires a JSON object body");
    }
    const obj = params as Record<string, unknown>;
    const out: {maxSize?: number; maxAgeMs?: number; maxQueuedAuths?: number} = {};
    const allowed = new Set(["maxSize", "maxAgeMs", "maxQueuedAuths"]);
    for (const k of Object.keys(obj)) {
        if (!allowed.has(k)) {
            throw new RpcError(
                ErrorCode.InvalidParams,
                `chain.batch.config: unknown key '${k}' (allowed: ${[...allowed].join(", ")})`,
            );
        }
        const v = obj[k];
        if (v === undefined) continue;
        if (typeof v !== "number") {
            throw new RpcError(ErrorCode.InvalidParams, `chain.batch.config.${k} must be a number`);
        }
        out[k as "maxSize" | "maxAgeMs" | "maxQueuedAuths"] = v;
    }
    return out;
}

/// Pull `{maxAuthPerSecond?}` out of the JSON-RPC params. Empty body → undefined (probe).
/// Unknown keys → InvalidParams (typo doesn't silently no-op).
function readRateLimitPatch(params: unknown): number | undefined {
    if (params === undefined || params === null) return undefined;
    if (typeof params !== "object" || Array.isArray(params)) {
        throw new RpcError(ErrorCode.InvalidParams, "chain.ratelimit.config requires a JSON object body");
    }
    const obj = params as Record<string, unknown>;
    const allowed = new Set(["maxAuthPerSecond"]);
    for (const k of Object.keys(obj)) {
        if (!allowed.has(k)) {
            throw new RpcError(
                ErrorCode.InvalidParams,
                `chain.ratelimit.config: unknown key '${k}' (allowed: ${[...allowed].join(", ")})`,
            );
        }
    }
    if (obj.maxAuthPerSecond === undefined) return undefined;
    if (typeof obj.maxAuthPerSecond !== "number") {
        throw new RpcError(ErrorCode.InvalidParams, "chain.ratelimit.config.maxAuthPerSecond must be a number");
    }
    return obj.maxAuthPerSecond;
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
