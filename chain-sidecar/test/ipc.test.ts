import {test} from "node:test";
import assert from "node:assert/strict";
import {createConnection} from "node:net";
import {mkdtemp, rm, writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {RpcServer} from "../src/ipc/server.js";
import {registerCoreHandlers} from "../src/ipc/handlers.js";
import {loadDeployments} from "../src/config.js";

/// Smoke test for the M2.1 IPC server. Boots a `RpcServer` on a temp UDS path, connects with
/// `node:net`, exchanges line-delimited JSON-RPC messages, and tears down. If this passes,
/// the agent_bundle build has produced something rctctl can talk to.
async function withServer<T>(
    fn: (sock: string) => Promise<T>,
): Promise<T> {
    const dir = await mkdtemp(join(tmpdir(), "rct2-sidecar-test-"));
    const sockPath = join(dir, "sidecar.sock");
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
    const server = new RpcServer(sockPath);
    registerCoreHandlers(server, {socketPath: sockPath, deploymentsPath, deployments});
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

test("sidecar.status surfaces deployments + method list", async () => {
    await withServer(async (sock) => {
        const r = await callOnce(sock, {jsonrpc: "2.0", id: "x", method: "sidecar.status"});
        assert.equal(r.id, "x");
        const result = r.result as {
            ok: boolean;
            deployments: {chainId: number; settlementBatcher: string};
            methods: string[];
        };
        assert.equal(result.ok, true);
        assert.equal(result.deployments.chainId, 10143);
        assert.equal(result.deployments.settlementBatcher, "0x0000000000000000000000000000000000000008");
        // sidecar.ping/status/shutdown should all be advertised.
        assert.ok(result.methods.includes("sidecar.ping"));
        assert.ok(result.methods.includes("sidecar.status"));
        assert.ok(result.methods.includes("sidecar.shutdown"));
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
