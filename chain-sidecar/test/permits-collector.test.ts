import {test} from "node:test";
import assert from "node:assert/strict";
import {decodeFunctionData, type Hex, type PublicClient, type WalletClient} from "viem";
import {PARK_TOKEN_ABI, PARK_TREASURY_ABI} from "../src/chain/abis.js";
import {deriveGuest} from "../src/derive/index.js";
import {
    PermitCollector,
    permitDomain,
    signPermit,
    type PermitCollectorOptions,
    type SignedPermit,
} from "../src/permits/index.js";

const TEST_MNEMONIC = "test test test test test test test test test test test junk";
const OWNER: `0x${string}` = "0x000000000000000000000000000000000000aaaa";
const TREASURY: `0x${string}` = "0x000000000000000000000000000000000000bbbb";
const PARK_TOKEN: `0x${string}` = "0x000000000000000000000000000000000000cccc";
const BATCHER: `0x${string}` = "0x000000000000000000000000000000000000dddd";
const TEST_CHAIN_ID = 10143;

interface SentTx {
    to: `0x${string}`;
    data: Hex;
    value: bigint;
}

function makeMocks(): {walletClient: WalletClient; publicClient: PublicClient; sent: SentTx[]} {
    const sent: SentTx[] = [];
    let counter = 0;
    const walletClient = {
        account: {address: OWNER, type: "json-rpc"},
        chain: null,
        async sendTransaction(args: {to: `0x${string}`; data: Hex; value: bigint}): Promise<Hex> {
            sent.push({to: args.to, data: args.data, value: args.value});
            counter++;
            return (`0x${counter.toString(16).padStart(64, "0")}`) as Hex;
        },
    } as unknown as WalletClient;
    const publicClient = {
        // M3.13 — the collector waits for receipt + checks status. Default to "success".
        async waitForTransactionReceipt(args: {hash: Hex}): Promise<{
            status: "success" | "reverted";
            blockNumber: bigint;
            gasUsed: bigint;
            transactionHash: Hex;
        }> {
            return {status: "success", blockNumber: 1n, gasUsed: 0n, transactionHash: args.hash};
        },
    } as unknown as PublicClient;
    return {walletClient, publicClient, sent};
}

function makeCollector(extra: Partial<PermitCollectorOptions> = {}): {
    collector: PermitCollector;
    sent: SentTx[];
    advance: (ms: number) => void;
} {
    const mocks = makeMocks();
    let t = 1_000;
    const timers = new Set<{at: number; cb: () => void}>();
    const setT = ((cb: () => void, ms: number) => {
        const handle = {at: t + ms, cb};
        timers.add(handle);
        return handle as unknown as ReturnType<typeof setTimeout>;
    }) as unknown as typeof setTimeout;
    const clearT = ((handle: ReturnType<typeof setTimeout>) => {
        timers.delete(handle as unknown as {at: number; cb: () => void});
    }) as unknown as typeof clearTimeout;
    const collector = new PermitCollector({
        walletClient: mocks.walletClient,
        publicClient: mocks.publicClient,
        treasury: TREASURY,
        parkToken: PARK_TOKEN,
        now: () => t,
        setTimeout: setT,
        clearTimeout: clearT,
        ...extra,
    });
    return {
        collector,
        sent: mocks.sent,
        advance(ms: number) {
            t += ms;
            const fired = [...timers].filter((h) => h.at <= t);
            for (const h of fired) {
                timers.delete(h);
                h.cb();
            }
        },
    };
}

async function makeSignedPermit(idx = 0, deadline = 1_900_000_000n): Promise<SignedPermit> {
    const guest = deriveGuest(TEST_MNEMONIC, idx);
    const domain = permitDomain(TEST_CHAIN_ID, PARK_TOKEN);
    return signPermit(guest.account, domain, {
        owner: guest.address,
        spender: BATCHER,
        value: (1n << 256n) - 1n,
        nonce: 0n,
        deadline,
    });
}

test("constructor rejects bad address / missing account", () => {
    const {walletClient, publicClient} = makeMocks();
    assert.throws(
        () =>
            new PermitCollector({
                walletClient,
                publicClient,
                treasury: "0x" as `0x${string}`,
                parkToken: PARK_TOKEN,
            }),
        /20-byte hex/,
    );
    const noAccount = {...walletClient, account: undefined} as unknown as WalletClient;
    assert.throws(
        () =>
            new PermitCollector({
                walletClient: noAccount,
                publicClient,
                treasury: TREASURY,
                parkToken: PARK_TOKEN,
            }),
        /missing account/,
    );
});

test("size-trigger: fills maxSize then ships an executeBatch tx with N permit calls", async () => {
    const {collector, sent} = makeCollector({maxSize: 2});
    const p0 = await makeSignedPermit(0);
    const p1 = await makeSignedPermit(1);
    collector.accept(p0);
    collector.accept(p1);
    await new Promise((r) => setImmediate(r));
    assert.equal(sent.length, 1);
    assert.equal(sent[0]!.to.toLowerCase(), TREASURY.toLowerCase());

    // Outer is executeBatch(targets, values, datas).
    const outer = decodeFunctionData({abi: PARK_TREASURY_ABI, data: sent[0]!.data});
    assert.equal(outer.functionName, "executeBatch");
    const [targets, values, datas] = outer.args as [
        readonly `0x${string}`[],
        readonly bigint[],
        readonly Hex[],
    ];
    assert.equal(targets.length, 2);
    assert.equal(values.length, 2);
    assert.equal(datas.length, 2);
    for (const t of targets) assert.equal(t.toLowerCase(), PARK_TOKEN.toLowerCase());
    for (const v of values) assert.equal(v, 0n);

    // Each inner data should decode as parkToken.permit(owner, spender, value, deadline, v, r, s).
    for (const [i, signed] of [[0, p0], [1, p1]] as const) {
        const inner = decodeFunctionData({abi: PARK_TOKEN_ABI, data: datas[i]!});
        assert.equal(inner.functionName, "permit");
        const [owner, spender, value, deadline, v, r, s] = inner.args as [
            `0x${string}`,
            `0x${string}`,
            bigint,
            bigint,
            number,
            Hex,
            Hex,
        ];
        assert.equal(owner.toLowerCase(), signed.args.owner.toLowerCase());
        assert.equal(spender.toLowerCase(), signed.args.spender.toLowerCase());
        assert.equal(value, signed.args.value);
        assert.equal(deadline, signed.args.deadline);
        assert.equal(v, signed.v);
        assert.equal(r, signed.r);
        assert.equal(s, signed.s);
    }

    const stats = collector.stats();
    assert.equal(stats.flushedBatches, 1);
    assert.equal(stats.flushedPermits, 2);
    assert.equal(stats.flushReasonCounts.size, 1);
    assert.equal(stats.queueDepth, 0);
});

test("age-trigger: flushes after maxAgeMs even when below maxSize", async () => {
    const {collector, sent, advance} = makeCollector({maxSize: 100, maxAgeMs: 200});
    const p0 = await makeSignedPermit(0);
    collector.accept(p0);
    advance(199);
    assert.equal(sent.length, 0);
    advance(2);
    await new Promise((r) => setImmediate(r));
    assert.equal(sent.length, 1);
    assert.equal(collector.stats().flushReasonCounts.age, 1);
});

test("manual flush() ships the buffered permits", async () => {
    const {collector, sent} = makeCollector({maxSize: 100});
    collector.accept(await makeSignedPermit(0));
    collector.flush();
    await new Promise((r) => setImmediate(r));
    assert.equal(sent.length, 1);
    assert.equal(collector.stats().flushReasonCounts.manual, 1);
});

test("stop() drains pending permits and rejects further accepts", async () => {
    const {collector, sent} = makeCollector({maxSize: 100});
    collector.accept(await makeSignedPermit(0));
    collector.accept(await makeSignedPermit(1));
    await collector.stop();
    assert.equal(sent.length, 1);
    assert.equal(collector.stats().flushReasonCounts.stop, 1);
    collector.accept(await makeSignedPermit(2));
    assert.equal(collector.stats().droppedPermits, 1);
});

test("backpressure: oldest dropped past maxQueuedPermits", async () => {
    const {collector} = makeCollector({maxSize: 100, maxQueuedPermits: 1});
    collector.accept(await makeSignedPermit(0));
    collector.accept(await makeSignedPermit(1));
    const stats = collector.stats();
    assert.equal(stats.queueDepth, 1);
    assert.equal(stats.droppedPermits, 1);
});

test("rpc errors increment rpcErrors and don't poison the queue", async () => {
    const sent: SentTx[] = [];
    let calls = 0;
    const wallet = {
        account: {address: OWNER, type: "json-rpc"},
        chain: null,
        async sendTransaction(): Promise<Hex> {
            calls++;
            // Both attempts fail — we want to confirm the error is counted, not retried.
            throw new Error("rpc: server unavailable");
        },
    } as unknown as WalletClient;
    const {publicClient} = makeMocks();
    const collector = new PermitCollector({
        walletClient: wallet,
        publicClient,
        treasury: TREASURY,
        parkToken: PARK_TOKEN,
        maxSize: 1,
    });
    collector.accept(await makeSignedPermit(0));
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    assert.equal(collector.stats().rpcErrors, 1);
    assert.equal(collector.stats().flushedBatches, 1);
    assert.equal(collector.stats().flushedPermits, 1);
    assert.equal(calls, 1);
    assert.equal(sent.length, 0);
});

test("avgBatchFill = flushedPermits / flushedBatches", async () => {
    const {collector} = makeCollector({maxSize: 2});
    collector.accept(await makeSignedPermit(0));
    collector.accept(await makeSignedPermit(1));
    await new Promise((r) => setImmediate(r));
    collector.accept(await makeSignedPermit(2));
    collector.flush();
    await new Promise((r) => setImmediate(r));
    const s = collector.stats();
    assert.equal(s.flushedBatches, 2);
    assert.equal(s.flushedPermits, 3);
    assert.equal(s.avgBatchFill, 1.5);
});
