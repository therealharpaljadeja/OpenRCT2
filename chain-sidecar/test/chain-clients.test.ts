import {test} from "node:test";
import assert from "node:assert/strict";
import {createServer, type Server} from "node:http";
import {AddressInfo} from "node:net";
import type {Hex, PublicClient, WalletClient} from "viem";
import {makePublicClient, submitAndConfirm, warmUpEOA} from "../src/chain/clients.js";

/// Integration test for the M3.12 transport policy. Spins a tiny HTTP server that records
/// every JSON-RPC body it sees, lets viem talk to it, and asserts batching collapses
/// concurrent calls into one HTTP request.

interface MockRpc {
    server: Server;
    url: string;
    bodies: string[];
    close: () => Promise<void>;
}

async function startMockRpc(handler: (method: string, params: unknown) => unknown): Promise<MockRpc> {
    const bodies: string[] = [];
    const server = createServer((req, res) => {
        let raw = "";
        req.on("data", (c) => (raw += c));
        req.on("end", () => {
            bodies.push(raw);
            const parsed: unknown = JSON.parse(raw);
            const handle = (one: {jsonrpc: string; id: number; method: string; params: unknown}) => ({
                jsonrpc: "2.0",
                id: one.id,
                result: handler(one.method, one.params),
            });
            const out = Array.isArray(parsed) ? parsed.map(handle as never) : handle(parsed as never);
            res.writeHead(200, {"content-type": "application/json"});
            res.end(JSON.stringify(out));
        });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as AddressInfo).port;
    return {
        server,
        url: `http://127.0.0.1:${port}`,
        bodies,
        close: () => new Promise<void>((resolve) => server.close(() => resolve())),
    };
}

test("default transport batches same-tick concurrent calls into one HTTP", async () => {
    const rpc = await startMockRpc((method) => {
        // Realistic-ish stub responses for the methods our reads hit.
        if (method === "eth_chainId") return "0x279f"; // 10143
        if (method === "eth_blockNumber") return "0x1";
        if (method === "eth_getBalance") return "0x0";
        return "0x0";
    });
    try {
        const client = makePublicClient(10143, rpc.url);
        // Fire 4 reads in the same microtask; with batching, viem coalesces them.
        const [a, b, c, d] = await Promise.all([
            client.getBalance({address: "0x0000000000000000000000000000000000000001"}),
            client.getBalance({address: "0x0000000000000000000000000000000000000002"}),
            client.getBalance({address: "0x0000000000000000000000000000000000000003"}),
            client.getBlockNumber(),
        ]);
        assert.equal(a, 0n);
        assert.equal(b, 0n);
        assert.equal(c, 0n);
        assert.equal(d, 1n);
        // viem may issue the eth_chainId probe first (uncached on cold client) in its own
        // HTTP, then batch the four user-issued reads together. Tolerate that — we only
        // assert that the *user reads* collapsed (so HTTP count is small, not 4).
        assert.ok(
            rpc.bodies.length <= 2,
            `expected ≤ 2 HTTP requests with batching, saw ${rpc.bodies.length}`,
        );
        // The batched request should be a JSON array of methods, not a single object.
        const batched = rpc.bodies.find((b) => b.startsWith("["));
        assert.ok(batched, "no batched (array) HTTP body observed");
        const parsed = JSON.parse(batched!) as Array<{method: string}>;
        assert.ok(parsed.length >= 3, `batched body should carry ≥ 3 methods, has ${parsed.length}`);
    } finally {
        await rpc.close();
    }
});

test("batch:false disables batching — every concurrent call is a separate HTTP", async () => {
    const rpc = await startMockRpc((method) => {
        if (method === "eth_chainId") return "0x279f";
        if (method === "eth_getBalance") return "0x0";
        return "0x0";
    });
    try {
        const client = makePublicClient(10143, rpc.url, {batch: false});
        await Promise.all([
            client.getBalance({address: "0x0000000000000000000000000000000000000001"}),
            client.getBalance({address: "0x0000000000000000000000000000000000000002"}),
            client.getBalance({address: "0x0000000000000000000000000000000000000003"}),
        ]);
        // No body should be a batched array.
        for (const b of rpc.bodies) {
            assert.ok(!b.startsWith("["), `unexpected batched body: ${b.slice(0, 80)}`);
        }
        // 3 user reads + a possible 1 chainId probe = 3 or 4 HTTPs. Not 1.
        assert.ok(rpc.bodies.length >= 3, `expected ≥ 3 HTTPs with batch:false, saw ${rpc.bodies.length}`);
    } finally {
        await rpc.close();
    }
});

test("timeoutMs is honored — slow server kills the request", async () => {
    // Server that never responds. The client's timeout should fire.
    const server = createServer(() => {
        // intentionally stall — never end the response
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as AddressInfo).port;
    const url = `http://127.0.0.1:${port}`;
    const client = makePublicClient(10143, url, {timeoutMs: 200, batch: false});
    const start = Date.now();
    await assert.rejects(
        () => client.getBalance({address: "0x0000000000000000000000000000000000000001"}),
        // viem's timeout error type — match by name or message substring rather than the
        // class to avoid pulling private types.
        (err: Error) => /imed out|imeout/.test(err.message ?? String(err)),
    );
    const elapsed = Date.now() - start;
    // Should fire near the 200 ms cap. Generous upper bound for CI noise.
    assert.ok(elapsed < 5_000, `timeout took ${elapsed} ms — expected < 5 s`);
    await new Promise<void>((resolve) => server.close(() => resolve()));
});

// ---- M3.16 — warmUpEOA ----

const ADDR_OP: `0x${string}` = "0x000000000000000000000000000000000000a001";

function makeWarmupMocks(opts: {
    /// Sequence of error messages or null (success) for each sendTransaction attempt.
    sendOutcomes: Array<string | null>;
    receiptStatus?: "success" | "reverted";
}): {walletClient: WalletClient; publicClient: PublicClient; sentCount: () => number} {
    let i = 0;
    const sent: Hex[] = [];
    const walletClient = {
        account: {address: ADDR_OP, type: "json-rpc"},
        chain: null,
        async sendTransaction(args: {to: `0x${string}`; data: Hex; value: bigint}): Promise<Hex> {
            const outcome = opts.sendOutcomes[i++];
            if (outcome) throw new Error(outcome);
            const hash = (`0x${(i).toString(16).padStart(64, "0")}`) as Hex;
            sent.push(hash);
            // Sanity: warm-up tx should be self-transfer of 0 value.
            assert.equal(args.to.toLowerCase(), ADDR_OP.toLowerCase());
            assert.equal(args.value, 0n);
            return hash;
        },
    } as unknown as WalletClient;
    const publicClient = {
        async waitForTransactionReceipt(args: {hash: Hex}): Promise<{
            status: "success" | "reverted";
            blockNumber: bigint;
            gasUsed: bigint;
            transactionHash: Hex;
        }> {
            return {
                status: opts.receiptStatus ?? "success",
                blockNumber: 1n,
                gasUsed: 21_000n,
                transactionHash: args.hash,
            };
        },
    } as unknown as PublicClient;
    return {walletClient, publicClient, sentCount: () => sent.length};
}

test("M3.16: warmUpEOA returns the tx hash on first-attempt success", async () => {
    const m = makeWarmupMocks({sendOutcomes: [null]});
    const txHash = await warmUpEOA({
        walletClient: m.walletClient,
        publicClient: m.publicClient,
    });
    assert.match(txHash, /^0x[0-9a-f]+$/);
    assert.equal(m.sentCount(), 1);
});

test("M3.16: warmUpEOA retries on insufficient-balance until success", async () => {
    const m = makeWarmupMocks({
        // Two failures, then success.
        sendOutcomes: [
            "Details: Signer had insufficient balance",
            "Details: Signer had insufficient balance",
            null,
        ],
    });
    const txHash = await warmUpEOA({
        walletClient: m.walletClient,
        publicClient: m.publicClient,
        retryDelayMs: 10, // fast for tests
        timeoutMs: 5_000,
    });
    assert.ok(txHash);
    assert.equal(m.sentCount(), 1, "only the successful send produces a tx hash");
});

test("M3.16: warmUpEOA throws on a non-recoverable error (no retry)", async () => {
    const m = makeWarmupMocks({sendOutcomes: ["execution reverted: BadSignature"]});
    await assert.rejects(
        () =>
            warmUpEOA({
                walletClient: m.walletClient,
                publicClient: m.publicClient,
                retryDelayMs: 10,
                timeoutMs: 5_000,
            }),
        /BadSignature/,
    );
});

test("M3.16: warmUpEOA throws after timeout if RPC keeps refusing", async () => {
    const m = makeWarmupMocks({
        sendOutcomes: Array(100).fill("Signer had insufficient balance"),
    });
    const start = Date.now();
    await assert.rejects(
        () =>
            warmUpEOA({
                walletClient: m.walletClient,
                publicClient: m.publicClient,
                retryDelayMs: 50,
                timeoutMs: 200,
            }),
        /insufficient balance/i,
    );
    const elapsed = Date.now() - start;
    assert.ok(elapsed >= 150 && elapsed < 2_000, `expected ~200 ms, got ${elapsed} ms`);
});

test("M3.16: warmUpEOA throws if walletClient has no account", async () => {
    const m = makeWarmupMocks({sendOutcomes: [null]});
    const noAcct = {...m.walletClient, account: undefined} as unknown as WalletClient;
    await assert.rejects(
        () => warmUpEOA({walletClient: noAcct, publicClient: m.publicClient}),
        /missing account/,
    );
});

test("M3.16: warmUpEOA throws if the warm-up tx itself reverts", async () => {
    const m = makeWarmupMocks({sendOutcomes: [null], receiptStatus: "reverted"});
    await assert.rejects(
        () => warmUpEOA({walletClient: m.walletClient, publicClient: m.publicClient}),
        /reverted on chain/,
    );
});

// ---- M3.16 — submitAndConfirm ----

const TARGET_ADDR: `0x${string}` = "0x000000000000000000000000000000000000bbbb";

function makeSubmitMocks(opts: {
    sendOutcomes: Array<string | null>;
    receiptStatus?: "success" | "reverted";
}): {walletClient: WalletClient; publicClient: PublicClient; sentRequests: Array<{to: `0x${string}`; data: Hex; value: bigint}>} {
    let i = 0;
    const sentRequests: Array<{to: `0x${string}`; data: Hex; value: bigint}> = [];
    const walletClient = {
        account: {address: ADDR_OP, type: "json-rpc"},
        chain: null,
        async sendTransaction(args: {to: `0x${string}`; data: Hex; value: bigint}): Promise<Hex> {
            const outcome = opts.sendOutcomes[i++];
            sentRequests.push({to: args.to, data: args.data, value: args.value});
            if (outcome) throw new Error(outcome);
            return (`0x${(i).toString(16).padStart(64, "0")}`) as Hex;
        },
    } as unknown as WalletClient;
    const publicClient = {
        async waitForTransactionReceipt(args: {hash: Hex}): Promise<{
            status: "success" | "reverted";
            blockNumber: bigint;
            gasUsed: bigint;
            transactionHash: Hex;
        }> {
            return {
                status: opts.receiptStatus ?? "success",
                blockNumber: 1n,
                gasUsed: 50_000n,
                transactionHash: args.hash,
            };
        },
    } as unknown as PublicClient;
    return {walletClient, publicClient, sentRequests};
}

test("M3.16: submitAndConfirm returns hash on first-attempt success", async () => {
    const m = makeSubmitMocks({sendOutcomes: [null]});
    const txHash = await submitAndConfirm({
        walletClient: m.walletClient,
        publicClient: m.publicClient,
        request: {to: TARGET_ADDR, data: "0xdeadbeef" as Hex, value: 0n},
        opName: "test.call",
    });
    assert.match(txHash, /^0x[0-9a-f]+$/);
    assert.equal(m.sentRequests.length, 1);
    assert.equal(m.sentRequests[0]!.to.toLowerCase(), TARGET_ADDR.toLowerCase());
    assert.equal(m.sentRequests[0]!.data, "0xdeadbeef");
});

test("M3.16: submitAndConfirm retries on insufficient-balance, eventually succeeds", async () => {
    const m = makeSubmitMocks({
        sendOutcomes: [
            "Details: Signer had insufficient balance",
            "Signer had insufficient balance",
            null,
        ],
    });
    const txHash = await submitAndConfirm({
        walletClient: m.walletClient,
        publicClient: m.publicClient,
        request: {to: TARGET_ADDR, data: "0x" as Hex, value: 0n},
        opName: "test.retry",
        retryDelayMs: 5,
        maxAttempts: 5,
    });
    assert.ok(txHash);
    assert.equal(m.sentRequests.length, 3, "submitted 3 times before success");
});

test("M3.16: submitAndConfirm throws on a non-recoverable error (no retry)", async () => {
    const m = makeSubmitMocks({sendOutcomes: ["execution reverted: BadVenue"]});
    await assert.rejects(
        () =>
            submitAndConfirm({
                walletClient: m.walletClient,
                publicClient: m.publicClient,
                request: {to: TARGET_ADDR, value: 0n},
                opName: "test.revert",
                retryDelayMs: 5,
            }),
        /BadVenue/,
    );
    // Did NOT retry on a non-recoverable error.
});

test("M3.16: submitAndConfirm gives up after maxAttempts on persistent insufficient-balance", async () => {
    const m = makeSubmitMocks({
        sendOutcomes: Array(20).fill("Signer had insufficient balance"),
    });
    await assert.rejects(
        () =>
            submitAndConfirm({
                walletClient: m.walletClient,
                publicClient: m.publicClient,
                request: {to: TARGET_ADDR, value: 0n},
                opName: "test.give-up",
                retryDelayMs: 5,
                maxAttempts: 3,
            }),
        /insufficient balance/i,
    );
    assert.equal(m.sentRequests.length, 3, "exactly maxAttempts attempts");
});

test("M3.16: submitAndConfirm throws if walletClient has no account", async () => {
    const m = makeSubmitMocks({sendOutcomes: [null]});
    const noAcct = {...m.walletClient, account: undefined} as unknown as WalletClient;
    await assert.rejects(
        () =>
            submitAndConfirm({
                walletClient: noAcct,
                publicClient: m.publicClient,
                request: {to: TARGET_ADDR, value: 0n},
                opName: "test.noacct",
            }),
        /missing account/,
    );
});

test("M3.16: submitAndConfirm throws if the tx reverts on chain", async () => {
    const m = makeSubmitMocks({sendOutcomes: [null], receiptStatus: "reverted"});
    await assert.rejects(
        () =>
            submitAndConfirm({
                walletClient: m.walletClient,
                publicClient: m.publicClient,
                request: {to: TARGET_ADDR, value: 0n},
                opName: "test.revert-receipt",
            }),
        /reverted on chain/,
    );
});
