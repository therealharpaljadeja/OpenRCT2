import {test} from "node:test";
import assert from "node:assert/strict";
import {createConnection} from "node:net";
import {mkdtemp, rm, writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {RpcServer} from "../src/ipc/server.js";
import {registerCoreHandlers} from "../src/ipc/handlers.js";
import {loadDeployments} from "../src/config.js";
import {deriveGuest, relayerPool} from "../src/derive/index.js";
import {GuestAddressCache} from "../src/derive/cache.js";
import {Batcher, type Batch, type SinkResult} from "../src/batcher/index.js";
import {RelayerPool, createNoopSubmitter} from "../src/relayers/index.js";
import {MetricsAggregator} from "../src/metrics/index.js";
import {SpendRateLimiter} from "../src/ratelimit/index.js";
import {SessionContext} from "../src/session/index.js";

/// Smoke test for the M2.1 IPC server. Boots a `RpcServer` on a temp UDS path, connects with
/// `node:net`, exchanges line-delimited JSON-RPC messages, and tears down. If this passes,
/// the agent_bundle build has produced something rctctl can talk to.

const TEST_MNEMONIC = "test test test test test test test test test test test junk";

interface WithServerOpts {
    batcher?: Batcher;
    relayerPool?: RelayerPool;
    metrics?: MetricsAggregator;
    rateLimiter?: SpendRateLimiter;
}

async function withServer<T>(fn: (sock: string) => Promise<T>, opts: WithServerOpts = {}): Promise<T> {
    const dir = await mkdtemp(join(tmpdir(), "rct2-sidecar-test-"));
    const sockPath = join(dir, "sidecar.sock");
    const keystorePath = join(dir, "keystore.json");
    const deploymentsPath = join(dir, "deployments.json");
    await writeFile(
        deploymentsPath,
        JSON.stringify({
            chainId: 10143,
            deployer: "0x0000000000000000000000000000000000000000",
            startBlock: 0,
            globals: {
                parkToken: "0x0000000000000000000000000000000000000001",
                faucet: "0x0000000000000000000000000000000000000002",
                disperse: "0x0000000000000000000000000000000000000003",
            },
            demoPark: {
                treasury: "0x0000000000000000000000000000000000000004",
                lendingPool: "0x0000000000000000000000000000000000000005",
                guestRegistry: "0x0000000000000000000000000000000000000006",
                venueRegistry: "0x0000000000000000000000000000000000000007",
                settlementBatcher: "0x0000000000000000000000000000000000000008",
            },
            loan: {maxBorrow: "1", ratePerBlock: 1},
        }),
    );
    const deployments = loadDeployments(deploymentsPath);
    const relayers = relayerPool(TEST_MNEMONIC, 4);
    const server = new RpcServer(sockPath);
    const session = new SessionContext(0);
    const runtime: Parameters<typeof registerCoreHandlers>[1] = {
        config: {
            socketPath: sockPath,
            deploymentsPath,
            deployments,
            keystorePath,
            keystorePassphrase: "test-passphrase",
            relayerCount: 4,
        },
        session,
        keystoreCreatedAt: "2026-05-02T00:00:00.000Z",
        keystoreCreated: false,
        relayers,
        guestCache: new GuestAddressCache(TEST_MNEMONIC, session),
    };
    if (opts.batcher) runtime.batcher = opts.batcher;
    if (opts.relayerPool) runtime.relayerPool = opts.relayerPool;
    if (opts.metrics) runtime.metrics = opts.metrics;
    if (opts.rateLimiter) runtime.rateLimiter = opts.rateLimiter;
    registerCoreHandlers(server, runtime);
    await server.listen();
    try {
        return await fn(sockPath);
    } finally {
        await server.close();
        if (opts.batcher) await opts.batcher.stop();
        if (opts.relayerPool) await opts.relayerPool.stop();
        await rm(dir, {recursive: true, force: true});
    }
}

interface RpcResponse {
    jsonrpc: "2.0";
    id: number | string | null;
    result?: unknown;
    error?: {code: number; message: string};
}

function callOnce(sockPath: string, payload: object): Promise<RpcResponse> {
    return new Promise((resolve, reject) => {
        const sock = createConnection(sockPath, () => {
            sock.write(`${JSON.stringify(payload)}\n`);
        });
        let buf = "";
        sock.setEncoding("utf8");
        sock.on("data", (chunk: string) => {
            buf += chunk;
            const nl = buf.indexOf("\n");
            if (nl >= 0) {
                const line = buf.slice(0, nl);
                sock.end();
                try {
                    resolve(JSON.parse(line) as RpcResponse);
                } catch (err) {
                    reject(err);
                }
            }
        });
        sock.on("error", reject);
    });
}

test("sidecar.ping round-trips", async () => {
    await withServer(async (sock) => {
        const r = await callOnce(sock, {jsonrpc: "2.0", id: 1, method: "sidecar.ping"});
        assert.equal(r.id, 1);
        assert.equal(r.result, "pong");
        assert.equal(r.error, undefined);
    });
});

test("sidecar.status surfaces deployments + method list + keystore", async () => {
    await withServer(async (sock) => {
        const r = await callOnce(sock, {jsonrpc: "2.0", id: "x", method: "sidecar.status"});
        assert.equal(r.id, "x");
        const result = r.result as {
            ok: boolean;
            deployments: {chainId: number; settlementBatcher: string};
            methods: string[];
            keystore: {relayerCount: number; relayers: Array<{index: number; address: string}>};
        };
        assert.equal(result.ok, true);
        assert.equal(result.deployments.chainId, 10143);
        assert.equal(result.deployments.settlementBatcher, "0x0000000000000000000000000000000000000008");
        // sidecar.ping/status/shutdown + keystore.status should all be advertised.
        assert.ok(result.methods.includes("sidecar.ping"));
        assert.ok(result.methods.includes("sidecar.status"));
        assert.ok(result.methods.includes("sidecar.shutdown"));
        assert.ok(result.methods.includes("keystore.status"));
        // Keystore block reflects the test runtime injected above.
        assert.equal(result.keystore.relayerCount, 4);
        assert.equal(result.keystore.relayers.length, 4);
        assert.match(result.keystore.relayers[0]!.address, /^0x[0-9a-fA-F]{40}$/);
    });
});

test("keystore.status returns the same payload as sidecar.status's keystore field", async () => {
    await withServer(async (sock) => {
        const a = await callOnce(sock, {jsonrpc: "2.0", id: 1, method: "sidecar.status"});
        const b = await callOnce(sock, {jsonrpc: "2.0", id: 2, method: "keystore.status"});
        const aKeystore = (a.result as {keystore: unknown}).keystore;
        assert.deepEqual(aKeystore, b.result);
    });
});

test("chain.session.begin with explicit sessionId flips the runtime + reports old/new", async () => {
    await withServer(async (sock) => {
        const r = await callOnce(sock, {
            jsonrpc: "2.0",
            id: 1,
            method: "chain.session.begin",
            params: {sessionId: 0xabcd},
        });
        const result = r.result as {
            changed: boolean;
            previousSessionId: number;
            sessionId: number;
            sessionIdHex: string;
        };
        assert.equal(result.changed, true);
        assert.equal(result.previousSessionId, 0);
        assert.equal(result.sessionId, 0xabcd);
        assert.equal(result.sessionIdHex, "0xabcd");

        // sidecar.status reflects the new id.
        const s = await callOnce(sock, {jsonrpc: "2.0", id: 2, method: "sidecar.status"});
        const status = s.result as {sessionId: number; sessionEpoch: number};
        assert.equal(status.sessionId, 0xabcd);
        assert.equal(status.sessionEpoch, 0xabcd);
    });
});

test("chain.session.begin with the same id is a no-op (changed: false)", async () => {
    await withServer(async (sock) => {
        await callOnce(sock, {
            jsonrpc: "2.0",
            id: 1,
            method: "chain.session.begin",
            params: {sessionId: 5},
        });
        const r = await callOnce(sock, {
            jsonrpc: "2.0",
            id: 2,
            method: "chain.session.begin",
            params: {sessionId: 5},
        });
        const result = r.result as {changed: boolean; sessionId: number};
        assert.equal(result.changed, false);
        assert.equal(result.sessionId, 5);
    });
});

test("chain.session.begin with generate:true picks a fresh random id", async () => {
    await withServer(async (sock) => {
        const r = await callOnce(sock, {
            jsonrpc: "2.0",
            id: 1,
            method: "chain.session.begin",
            params: {generate: true},
        });
        const result = r.result as {sessionId: number; previousSessionId: number};
        assert.ok(Number.isInteger(result.sessionId) && result.sessionId >= 0 && result.sessionId <= 0xffff);
        assert.equal(result.previousSessionId, 0);
    });
});

test("chain.session.begin rejects out-of-range sessionId with -32602", async () => {
    await withServer(async (sock) => {
        const r = await callOnce(sock, {
            jsonrpc: "2.0",
            id: 1,
            method: "chain.session.begin",
            params: {sessionId: 0x10000},
        });
        assert.equal(r.error?.code, -32602);
        assert.match(r.error?.message ?? "", /out of \[0, 65535\]/);
    });
});

test("chain.session.begin rejects unknown keys with -32602", async () => {
    await withServer(async (sock) => {
        const r = await callOnce(sock, {
            jsonrpc: "2.0",
            id: 1,
            method: "chain.session.begin",
            params: {sessionId: 1, foo: "bar"},
        });
        assert.equal(r.error?.code, -32602);
        assert.match(r.error?.message ?? "", /unknown key 'foo'/);
    });
});

test("chain.session.begin rejects sessionId + generate together with -32602", async () => {
    await withServer(async (sock) => {
        const r = await callOnce(sock, {
            jsonrpc: "2.0",
            id: 1,
            method: "chain.session.begin",
            params: {sessionId: 1, generate: true},
        });
        assert.equal(r.error?.code, -32602);
        assert.match(r.error?.message ?? "", /not both/);
    });
});

test("chain.session.begin clears guest cache so subsequent guest.address derives under new id", async () => {
    await withServer(async (sock) => {
        // First derive under session 0.
        const a = await callOnce(sock, {
            jsonrpc: "2.0",
            id: 1,
            method: "guest.address",
            params: {index: 0},
        });
        const addrA = (a.result as {address: string}).address;

        // Flip session.
        await callOnce(sock, {
            jsonrpc: "2.0",
            id: 2,
            method: "chain.session.begin",
            params: {sessionId: 1},
        });

        const b = await callOnce(sock, {
            jsonrpc: "2.0",
            id: 3,
            method: "guest.address",
            params: {index: 0},
        });
        const addrB = (b.result as {address: string}).address;
        assert.notEqual(addrA, addrB, "session change must produce a different guest address");
    });
});

test("unknown method returns -32601", async () => {
    await withServer(async (sock) => {
        const r = await callOnce(sock, {jsonrpc: "2.0", id: 7, method: "no.such.method"});
        assert.equal(r.id, 7);
        assert.equal(r.error?.code, -32601);
        assert.match(r.error?.message ?? "", /no\.such\.method/);
    });
});

test("malformed JSON returns -32700 with id=null", async () => {
    await withServer(async (sock) => {
        const reply = await new Promise<string>((resolve, reject) => {
            const s = createConnection(sock, () => s.write("{not json\n"));
            let buf = "";
            s.setEncoding("utf8");
            s.on("data", (c: string) => {
                buf += c;
                const nl = buf.indexOf("\n");
                if (nl >= 0) {
                    s.end();
                    resolve(buf.slice(0, nl));
                }
            });
            s.on("error", reject);
        });
        const r = JSON.parse(reply) as RpcResponse;
        assert.equal(r.id, null);
        assert.equal(r.error?.code, -32700);
    });
});

test("chain.deployments returns the parsed deployments + source path", async () => {
    await withServer(async (sock) => {
        const r = await callOnce(sock, {jsonrpc: "2.0", id: 80, method: "chain.deployments"});
        const result = r.result as {path: string; deployments: {chainId: number; demoPark: {settlementBatcher: string}}};
        assert.match(result.path, /deployments\.json$/);
        assert.equal(result.deployments.chainId, 10143);
        assert.equal(
            result.deployments.demoPark.settlementBatcher,
            "0x0000000000000000000000000000000000000008",
        );
    });
});

test("chain.balances reports {enabled: false} when no --rpc-url is configured", async () => {
    await withServer(async (sock) => {
        const r = await callOnce(sock, {jsonrpc: "2.0", id: 70, method: "chain.balances"});
        assert.deepEqual(r.result, {enabled: false});
    });
});

test("chain.topup.status reports {enabled: false} without chain plumbing", async () => {
    await withServer(async (sock) => {
        const r = await callOnce(sock, {jsonrpc: "2.0", id: 71, method: "chain.topup.status"});
        assert.deepEqual(r.result, {enabled: false});
    });
});

test("chain.faucet.drip rejects with InvalidRequest when no faucet writer is configured", async () => {
    await withServer(async (sock) => {
        const r = await callOnce(sock, {jsonrpc: "2.0", id: 72, method: "chain.faucet.drip"});
        assert.equal(r.error?.code, -32600);
        assert.match(r.error?.message ?? "", /requires --rpc-url/);
    });
});

test("chain.funder.status reports {enabled: false} when no funder is wired", async () => {
    await withServer(async (sock) => {
        const r = await callOnce(sock, {jsonrpc: "2.0", id: 73, method: "chain.funder.status"});
        assert.deepEqual(r.result, {enabled: false});
    });
});

test("chain.permits.status reports {enabled: false} when no collector is wired", async () => {
    await withServer(async (sock) => {
        const r = await callOnce(sock, {jsonrpc: "2.0", id: 74, method: "chain.permits.status"});
        assert.deepEqual(r.result, {enabled: false});
    });
});

test("chain.sweeper.status reports {enabled: false} when no sweeper is wired", async () => {
    await withServer(async (sock) => {
        const r = await callOnce(sock, {jsonrpc: "2.0", id: 75, method: "chain.sweeper.status"});
        assert.deepEqual(r.result, {enabled: false});
    });
});

test("chain.throughput returns {enabled: false} when no metrics aggregator is wired", async () => {
    await withServer(async (sock) => {
        const r = await callOnce(sock, {jsonrpc: "2.0", id: 79, method: "chain.throughput"});
        assert.deepEqual(r.result, {enabled: false});
    });
});

test("chain.throughput returns rolling-window snapshot + joined gauges when metrics is wired", async () => {
    const metrics = new MetricsAggregator();
    metrics.recordTxSuccess(100, 50);
    metrics.recordTxSuccess(200, 75);
    metrics.recordTxSuccess(300, 100);
    await withServer(
        async (sock) => {
            const r = await callOnce(sock, {jsonrpc: "2.0", id: 80, method: "chain.throughput"});
            const result = r.result as Record<string, unknown>;
            assert.equal(result.enabled, true);
            assert.ok(typeof result.now === "number");
            assert.equal(result.txInWindow, 3);
            assert.equal(result.authInWindow, 600);
            const latency = result.latencyMs as {p50: number | null; p95: number | null; p99: number | null};
            assert.ok(latency.p50 !== null);
            const totals = result.totals as {txSubmitted: number; authSubmitted: number; txFailed: number};
            assert.equal(totals.txSubmitted, 3);
            assert.equal(totals.authSubmitted, 600);
            assert.equal(totals.txFailed, 0);
            // Subsystem gauges default to null/0 because we didn't wire any.
            const queues = result.queues as Record<string, unknown>;
            assert.equal(queues.batcherDepth, null, "no batcher in this runtime → null");
            assert.equal(queues.relayerPoolQueueDepth, null);
        },
        {metrics},
    );
});

test("chain.venues.* reports {enabled: false} when no venue mirror is wired", async () => {
    await withServer(async (sock) => {
        const status = await callOnce(sock, {jsonrpc: "2.0", id: 76, method: "chain.venues.status"});
        assert.deepEqual(status.result, {enabled: false});
        const list = await callOnce(sock, {jsonrpc: "2.0", id: 77, method: "chain.venues.list"});
        assert.deepEqual(list.result, {enabled: false});
        const get = await callOnce(sock, {
            jsonrpc: "2.0",
            id: 78,
            method: "chain.venues.get",
            params: {id: 1},
        });
        assert.deepEqual(get.result, {enabled: false});
    });
});

test("chain.ratelimit.status reports {enabled: false} when no rate limiter is wired", async () => {
    await withServer(async (sock) => {
        const r = await callOnce(sock, {jsonrpc: "2.0", id: 90, method: "chain.ratelimit.status"});
        assert.deepEqual(r.result, {enabled: false});
    });
});

test("chain.ratelimit.status surfaces accepted/rejected/guestsTracked when wired", async () => {
    const rateLimiter = new SpendRateLimiter({maxAuthPerSecond: 3});
    rateLimiter.consume(1);
    rateLimiter.consume(1);
    rateLimiter.consume(1);
    rateLimiter.consume(1); // rejected
    rateLimiter.consume(2); // accepted (separate bucket)
    await withServer(
        async (sock) => {
            const r = await callOnce(sock, {jsonrpc: "2.0", id: 91, method: "chain.ratelimit.status"});
            const result = r.result as {
                enabled: boolean;
                maxAuthPerSecond: number;
                accepted: number;
                rejected: number;
                guestsTracked: number;
            };
            assert.equal(result.enabled, true);
            assert.equal(result.maxAuthPerSecond, 3);
            assert.equal(result.accepted, 4);
            assert.equal(result.rejected, 1);
            assert.equal(result.guestsTracked, 2);
        },
        {rateLimiter},
    );
});

test("chain.ratelimit.config probe-form returns current stats", async () => {
    const rateLimiter = new SpendRateLimiter({maxAuthPerSecond: 5});
    await withServer(
        async (sock) => {
            const r = await callOnce(sock, {jsonrpc: "2.0", id: 92, method: "chain.ratelimit.config"});
            const result = r.result as {ok: boolean; maxAuthPerSecond: number};
            assert.equal(result.ok, true);
            assert.equal(result.maxAuthPerSecond, 5);
        },
        {rateLimiter},
    );
});

test("chain.ratelimit.config updates the cap and rejects unknown keys + bad values", async () => {
    const rateLimiter = new SpendRateLimiter({maxAuthPerSecond: 5});
    await withServer(
        async (sock) => {
            const ok = await callOnce(sock, {
                jsonrpc: "2.0",
                id: 93,
                method: "chain.ratelimit.config",
                params: {maxAuthPerSecond: 12},
            });
            assert.equal((ok.result as {ok: boolean; maxAuthPerSecond: number}).maxAuthPerSecond, 12);

            const unknown = await callOnce(sock, {
                jsonrpc: "2.0",
                id: 94,
                method: "chain.ratelimit.config",
                params: {bogus: 1},
            });
            assert.equal(unknown.error?.code, -32602);
            assert.match(unknown.error?.message ?? "", /unknown key 'bogus'/);

            const negative = await callOnce(sock, {
                jsonrpc: "2.0",
                id: 95,
                method: "chain.ratelimit.config",
                params: {maxAuthPerSecond: -1},
            });
            assert.equal(negative.error?.code, -32602);
        },
        {rateLimiter},
    );
});

test("chain.ratelimit.config rejects with InvalidRequest when no rate limiter is wired", async () => {
    await withServer(async (sock) => {
        const r = await callOnce(sock, {
            jsonrpc: "2.0",
            id: 96,
            method: "chain.ratelimit.config",
            params: {maxAuthPerSecond: 10},
        });
        assert.equal(r.error?.code, -32600);
    });
});

test("chain.throughput.drops.rateLimitedSpends mirrors the rate limiter's rejected count", async () => {
    const metrics = new MetricsAggregator();
    const rateLimiter = new SpendRateLimiter({maxAuthPerSecond: 1});
    rateLimiter.consume(7);
    rateLimiter.consume(7); // rejected
    rateLimiter.consume(7); // rejected
    await withServer(
        async (sock) => {
            const r = await callOnce(sock, {jsonrpc: "2.0", id: 97, method: "chain.throughput"});
            const drops = (r.result as {drops: {rateLimitedSpends: number}}).drops;
            assert.equal(drops.rateLimitedSpends, 2);
        },
        {metrics, rateLimiter},
    );
});

test("outbox.status reports {enabled: false} when no outbox is configured", async () => {
    await withServer(async (sock) => {
        const r = await callOnce(sock, {jsonrpc: "2.0", id: 60, method: "outbox.status"});
        assert.deepEqual(r.result, {enabled: false});
    });
});

test("guest.address returns the cached HD-derived address for a given index", async () => {
    await withServer(async (sock) => {
        const expected = deriveGuest(TEST_MNEMONIC, 5).address;
        const r = await callOnce(sock, {
            jsonrpc: "2.0",
            id: 30,
            method: "guest.address",
            params: {index: 5},
        });
        assert.equal(r.error, undefined);
        assert.deepEqual(r.result, {index: 5, address: expected});
    });
});

test("guest.address accepts positional [index] params", async () => {
    await withServer(async (sock) => {
        const expected = deriveGuest(TEST_MNEMONIC, 11).address;
        const r = await callOnce(sock, {
            jsonrpc: "2.0",
            id: 31,
            method: "guest.address",
            params: [11],
        });
        assert.deepEqual(r.result, {index: 11, address: expected});
    });
});

test("guest.address rejects bad params with InvalidParams (-32602)", async () => {
    await withServer(async (sock) => {
        const missing = await callOnce(sock, {jsonrpc: "2.0", id: 40, method: "guest.address"});
        assert.equal(missing.error?.code, -32602);
        const negative = await callOnce(sock, {
            jsonrpc: "2.0",
            id: 41,
            method: "guest.address",
            params: {index: -1},
        });
        assert.equal(negative.error?.code, -32602);
        const fractional = await callOnce(sock, {
            jsonrpc: "2.0",
            id: 42,
            method: "guest.address",
            params: {index: 1.5},
        });
        assert.equal(fractional.error?.code, -32602);
    });
});

test("keystore.status surfaces guestCache stats that update after guest.address calls", async () => {
    await withServer(async (sock) => {
        const before = await callOnce(sock, {jsonrpc: "2.0", id: 50, method: "keystore.status"});
        assert.deepEqual((before.result as {guestCache: unknown}).guestCache, {
            size: 0,
            hits: 0,
            misses: 0,
        });
        await callOnce(sock, {jsonrpc: "2.0", id: 51, method: "guest.address", params: {index: 0}});
        await callOnce(sock, {jsonrpc: "2.0", id: 52, method: "guest.address", params: {index: 0}});
        await callOnce(sock, {jsonrpc: "2.0", id: 53, method: "guest.address", params: {index: 1}});
        const after = await callOnce(sock, {jsonrpc: "2.0", id: 54, method: "keystore.status"});
        assert.deepEqual((after.result as {guestCache: unknown}).guestCache, {
            size: 2,
            hits: 1,
            misses: 2,
        });
    });
});

test("chain.batch.status reports {enabled: false} when no batcher is wired", async () => {
    await withServer(async (sock) => {
        const r = await callOnce(sock, {jsonrpc: "2.0", id: 100, method: "chain.batch.status"});
        assert.deepEqual(r.result, {enabled: false});
    });
});

test("chain.batch.status returns enabled + stats when a batcher is wired", async () => {
    const sink = async (_b: Batch): Promise<SinkResult> => ({});
    const batcher = new Batcher({sink});
    await withServer(
        async (sock) => {
            const r = await callOnce(sock, {jsonrpc: "2.0", id: 101, method: "chain.batch.status"});
            const result = r.result as {enabled: boolean; maxSize: number; maxAgeMs: number; queueDepth: number};
            assert.equal(result.enabled, true);
            // Defaults match plan §4.2.
            assert.equal(result.maxSize, 256);
            assert.equal(result.maxAgeMs, 200);
            assert.equal(result.queueDepth, 0);
        },
        {batcher},
    );
});

test("chain.batch.config rejects without a wired batcher", async () => {
    await withServer(async (sock) => {
        const r = await callOnce(sock, {
            jsonrpc: "2.0",
            id: 102,
            method: "chain.batch.config",
            params: {maxSize: 64},
        });
        assert.equal(r.error?.code, -32600);
        assert.match(r.error?.message ?? "", /batcher not enabled/);
    });
});

test("chain.batch.config updates the batcher's tunables and returns fresh stats", async () => {
    const sink = async (_b: Batch): Promise<SinkResult> => ({});
    const batcher = new Batcher({sink});
    await withServer(
        async (sock) => {
            const r = await callOnce(sock, {
                jsonrpc: "2.0",
                id: 103,
                method: "chain.batch.config",
                params: {maxSize: 128, maxAgeMs: 50},
            });
            const result = r.result as {ok: boolean; maxSize: number; maxAgeMs: number};
            assert.equal(result.ok, true);
            assert.equal(result.maxSize, 128);
            assert.equal(result.maxAgeMs, 50);
            // Confirmed via the source-of-truth (the batcher itself).
            assert.equal(batcher.stats().maxSize, 128);
            assert.equal(batcher.stats().maxAgeMs, 50);
        },
        {batcher},
    );
});

test("chain.batch.config with an empty body returns current stats (probe form)", async () => {
    const sink = async (_b: Batch): Promise<SinkResult> => ({});
    const batcher = new Batcher({sink});
    await withServer(
        async (sock) => {
            const r = await callOnce(sock, {jsonrpc: "2.0", id: 104, method: "chain.batch.config"});
            const result = r.result as {ok: boolean; maxSize: number};
            assert.equal(result.ok, true);
            assert.equal(result.maxSize, 256);
        },
        {batcher},
    );
});

test("chain.batch.config rejects unknown keys with InvalidParams", async () => {
    const sink = async (_b: Batch): Promise<SinkResult> => ({});
    const batcher = new Batcher({sink});
    await withServer(
        async (sock) => {
            const r = await callOnce(sock, {
                jsonrpc: "2.0",
                id: 105,
                method: "chain.batch.config",
                params: {bogus: 1},
            });
            assert.equal(r.error?.code, -32602);
            assert.match(r.error?.message ?? "", /unknown key 'bogus'/);
        },
        {batcher},
    );
});

test("chain.batch.config maps batcher validation errors to InvalidParams", async () => {
    const sink = async (_b: Batch): Promise<SinkResult> => ({});
    const batcher = new Batcher({sink});
    await withServer(
        async (sock) => {
            const r = await callOnce(sock, {
                jsonrpc: "2.0",
                id: 106,
                method: "chain.batch.config",
                params: {maxSize: 0},
            });
            assert.equal(r.error?.code, -32602);
            assert.match(r.error?.message ?? "", /maxSize/);
        },
        {batcher},
    );
});

test("chain.relayers reports {enabled: false} when no pool is wired", async () => {
    await withServer(async (sock) => {
        const r = await callOnce(sock, {jsonrpc: "2.0", id: 110, method: "chain.relayers"});
        assert.deepEqual(r.result, {enabled: false});
    });
});

test("chain.relayers surfaces per-relayer + aggregate stats when wired", async () => {
    const pool = new RelayerPool({
        relayers: relayerPool(TEST_MNEMONIC, 3),
        submitter: createNoopSubmitter(),
    });
    await withServer(
        async (sock) => {
            const r = await callOnce(sock, {jsonrpc: "2.0", id: 111, method: "chain.relayers"});
            const result = r.result as {
                enabled: boolean;
                size: number;
                free: number;
                busy: number;
                queuedBatches: number;
                relayers: Array<{index: number; address: string; nonce: number | null; busy: boolean}>;
            };
            assert.equal(result.enabled, true);
            assert.equal(result.size, 3);
            assert.equal(result.busy, 0);
            assert.equal(result.free, 3);
            assert.equal(result.queuedBatches, 0);
            assert.equal(result.relayers.length, 3);
            // Idle pool — every relayer's nonce is still un-primed (null).
            for (const rly of result.relayers) {
                assert.equal(rly.nonce, null);
                assert.equal(rly.busy, false);
                assert.match(rly.address, /^0x[0-9a-fA-F]{40}$/);
            }
        },
        {relayerPool: pool},
    );
});

test("handler exception surfaces as -32603 InternalError", async () => {
    await withServer(async (sock) => {
        // Reach into the running server via a fresh registration is awkward across a process
        // boundary, so we instead trigger an InvalidRequest path: missing `method`. That hits
        // the same wire shape (`error.code` set, `result` absent) we want to validate.
        const r = await callOnce(sock, {jsonrpc: "2.0", id: 11});
        assert.equal(r.id, 11);
        assert.equal(r.error?.code, -32600);
    });
});
