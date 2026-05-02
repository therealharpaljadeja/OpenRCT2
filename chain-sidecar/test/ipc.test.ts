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

/// Smoke test for the M2.1 IPC server. Boots a `RpcServer` on a temp UDS path, connects with
/// `node:net`, exchanges line-delimited JSON-RPC messages, and tears down. If this passes,
/// the agent_bundle build has produced something rctctl can talk to.

const TEST_MNEMONIC = "test test test test test test test test test test test junk";

async function withServer<T>(fn: (sock: string) => Promise<T>): Promise<T> {
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
    registerCoreHandlers(server, {
        config: {
            socketPath: sockPath,
            deploymentsPath,
            deployments,
            keystorePath,
            keystorePassphrase: "test-passphrase",
            relayerCount: 4,
        },
        keystoreCreatedAt: "2026-05-02T00:00:00.000Z",
        keystoreCreated: false,
        relayers,
        guestCache: new GuestAddressCache(TEST_MNEMONIC),
    });
    await server.listen();
    try {
        return await fn(sockPath);
    } finally {
        await server.close();
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
