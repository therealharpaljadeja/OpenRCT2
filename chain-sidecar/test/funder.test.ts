import {test} from "node:test";
import assert from "node:assert/strict";
import {decodeFunctionData, type Hex, type PublicClient, type WalletClient} from "viem";
import {DISPERSE_ABI, PARK_TOKEN_ABI, PARK_TREASURY_ABI} from "../src/chain/abis.js";
import {Funder, DEFAULT_FUNDER_ALLOWANCE, type FunderOptions} from "../src/funder/index.js";

/// Pinned in-test addresses. Don't matter beyond syntactic validity, but pinning makes
/// calldata-decode assertions stable.
const OWNER: `0x${string}` = "0x000000000000000000000000000000000000aaaa";
const TREASURY: `0x${string}` = "0x000000000000000000000000000000000000bbbb";
const PARK_TOKEN: `0x${string}` = "0x000000000000000000000000000000000000cccc";
const DISPERSE: `0x${string}` = "0x000000000000000000000000000000000000dddd";
const G1: `0x${string}` = "0x0000000000000000000000000000000000000001";
const G2: `0x${string}` = "0x0000000000000000000000000000000000000002";
const G3: `0x${string}` = "0x0000000000000000000000000000000000000003";

interface SentTx {
    to: `0x${string}`;
    data: Hex;
    value: bigint;
}

function makeMocks(currentAllowance = 0n): {
    walletClient: WalletClient;
    publicClient: PublicClient;
    sent: SentTx[];
    nextHash: () => Hex;
    setAllowance: (n: bigint) => void;
} {
    const sent: SentTx[] = [];
    let counter = 0;
    let allowance = currentAllowance;
    const nextHash = (): Hex => {
        counter++;
        return (`0x${counter.toString(16).padStart(64, "0")}`) as Hex;
    };
    const walletClient = {
        account: {address: OWNER, type: "json-rpc"},
        chain: null,
        async sendTransaction(args: {to: `0x${string}`; data: Hex; value: bigint}): Promise<Hex> {
            sent.push({to: args.to, data: args.data, value: args.value});
            return nextHash();
        },
    } as unknown as WalletClient;
    const publicClient = {
        async readContract(args: {functionName: string}): Promise<bigint> {
            if (args.functionName === "allowance") return allowance;
            throw new Error(`unexpected readContract: ${args.functionName}`);
        },
    } as unknown as PublicClient;
    return {
        walletClient,
        publicClient,
        sent,
        nextHash,
        setAllowance: (n) => {
            allowance = n;
        },
    };
}

function makeFunder(extra: Partial<FunderOptions> = {}): {
    funder: Funder;
    sent: SentTx[];
    setAllowance: (n: bigint) => void;
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
    const funder = new Funder({
        walletClient: mocks.walletClient,
        publicClient: mocks.publicClient,
        treasury: TREASURY,
        parkToken: PARK_TOKEN,
        disperse: DISPERSE,
        now: () => t,
        setTimeout: setT,
        clearTimeout: clearT,
        ...extra,
    });
    return {
        funder,
        sent: mocks.sent,
        setAllowance: mocks.setAllowance,
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

/// Decode `treasury.execute(target, value, data)` and then the inner call. Returns
/// `{target, value, innerName, innerArgs}`.
function decodeExecute(outer: Hex): {
    target: `0x${string}`;
    value: bigint;
    innerName: string;
    innerArgs: readonly unknown[];
} {
    const exec = decodeFunctionData({abi: PARK_TREASURY_ABI, data: outer});
    assert.equal(exec.functionName, "execute");
    const [target, value, innerData] = exec.args as [`0x${string}`, bigint, Hex];
    // Try the two ABIs the funder produces — approve (PARK_TOKEN_ABI) at start, disperseToken
    // (DISPERSE_ABI) on flush.
    try {
        const decoded = decodeFunctionData({abi: PARK_TOKEN_ABI, data: innerData});
        return {target, value, innerName: decoded.functionName, innerArgs: decoded.args ?? []};
    } catch {
        const decoded = decodeFunctionData({abi: DISPERSE_ABI, data: innerData});
        return {target, value, innerName: decoded.functionName, innerArgs: decoded.args ?? []};
    }
}

test("constructor rejects malformed addresses", () => {
    const mocks = makeMocks();
    assert.throws(
        () =>
            new Funder({
                walletClient: mocks.walletClient,
                publicClient: mocks.publicClient,
                treasury: "0xzzz" as `0x${string}`,
                parkToken: PARK_TOKEN,
                disperse: DISPERSE,
            }),
        /20-byte hex address/,
    );
});

test("constructor rejects walletClient without account", () => {
    const mocks = makeMocks();
    const noAccount = {...mocks.walletClient, account: undefined} as unknown as WalletClient;
    assert.throws(
        () =>
            new Funder({
                walletClient: noAccount,
                publicClient: mocks.publicClient,
                treasury: TREASURY,
                parkToken: PARK_TOKEN,
                disperse: DISPERSE,
            }),
        /missing account/,
    );
});

test("start() sends the approve when current allowance is below target", async () => {
    const {funder, sent} = makeFunder();
    await funder.start();
    assert.equal(sent.length, 1);
    const decoded = decodeExecute(sent[0]!.data);
    assert.equal(decoded.target.toLowerCase(), PARK_TOKEN.toLowerCase());
    assert.equal(decoded.value, 0n);
    assert.equal(decoded.innerName, "approve");
    const [spender, amount] = decoded.innerArgs as [`0x${string}`, bigint];
    assert.equal(spender.toLowerCase(), DISPERSE.toLowerCase());
    assert.equal(amount, DEFAULT_FUNDER_ALLOWANCE);
    assert.match(funder.stats().approvalTx ?? "", /^0x[0-9a-f]{64}$/);
});

test("start() skips approve when allowance is already adequate", async () => {
    const mocks = makeMocks(DEFAULT_FUNDER_ALLOWANCE);
    const funder = new Funder({
        walletClient: mocks.walletClient,
        publicClient: mocks.publicClient,
        treasury: TREASURY,
        parkToken: PARK_TOKEN,
        disperse: DISPERSE,
    });
    await funder.start();
    assert.equal(mocks.sent.length, 0, "no approval tx when allowance is already maxed");
    assert.equal(funder.stats().approvalTx, null);
    assert.equal(funder.stats().started, true);
});

test("start() is idempotent — second call is a no-op", async () => {
    const {funder, sent} = makeFunder();
    await funder.start();
    await funder.start();
    assert.equal(sent.length, 1, "approve tx posted exactly once across two start() calls");
});

test("size-trigger: filling maxSize flushes a disperseToken tx", async () => {
    const {funder, sent} = makeFunder({maxSize: 3});
    await funder.start(); // approve at index 0
    funder.accept({address: G1, amount: 1n});
    funder.accept({address: G2, amount: 2n});
    funder.accept({address: G3, amount: 3n});
    // Allow the parked sink to settle.
    await new Promise((r) => setImmediate(r));
    assert.equal(sent.length, 2, "approve + one disperse tx");
    const decoded = decodeExecute(sent[1]!.data);
    assert.equal(decoded.target.toLowerCase(), DISPERSE.toLowerCase());
    assert.equal(decoded.innerName, "disperseToken");
    const [token, addrs, amts] = decoded.innerArgs as [
        `0x${string}`,
        readonly `0x${string}`[],
        readonly bigint[],
    ];
    assert.equal(token.toLowerCase(), PARK_TOKEN.toLowerCase());
    assert.deepEqual(
        [...addrs].map((a) => a.toLowerCase()),
        [G1, G2, G3].map((a) => a.toLowerCase()),
    );
    assert.deepEqual([...amts], [1n, 2n, 3n]);
    const stats = funder.stats();
    assert.equal(stats.flushedBatches, 1);
    assert.equal(stats.flushedEntries, 3);
    assert.equal(stats.flushReasonCounts.size, 1);
    assert.equal(stats.queueDepth, 0);
});

test("age-trigger: buffer flushes after maxAgeMs even below maxSize", async () => {
    const {funder, sent, advance} = makeFunder({maxSize: 100, maxAgeMs: 200});
    await funder.start();
    funder.accept({address: G1, amount: 5n});
    advance(199); // not yet
    assert.equal(sent.length, 1, "no flush until age elapses");
    advance(2); // crosses 200ms threshold
    await new Promise((r) => setImmediate(r));
    assert.equal(sent.length, 2);
    assert.equal(funder.stats().flushReasonCounts.age, 1);
});

test("manual flush() ships whatever is queued", async () => {
    const {funder, sent} = makeFunder({maxSize: 100});
    await funder.start();
    funder.accept({address: G1, amount: 1n});
    funder.flush();
    await new Promise((r) => setImmediate(r));
    assert.equal(sent.length, 2);
    assert.equal(funder.stats().flushReasonCounts.manual, 1);
});

test("flush() on an empty buffer is a no-op", async () => {
    const {funder, sent} = makeFunder();
    await funder.start();
    funder.flush();
    assert.equal(sent.length, 1, "still just the approve");
});

test("stop() drains pending entries and rejects further accepts", async () => {
    const {funder, sent} = makeFunder({maxSize: 100});
    await funder.start();
    funder.accept({address: G1, amount: 1n});
    funder.accept({address: G2, amount: 2n});
    await funder.stop();
    assert.equal(sent.length, 2, "stop flushed the buffered batch");
    assert.equal(funder.stats().flushReasonCounts.stop, 1);
    funder.accept({address: G3, amount: 3n});
    assert.equal(funder.stats().droppedEntries, 1, "post-stop accept is dropped");
});

test("backpressure: oldest entries dropped once active buffer exceeds maxQueuedEntries", async () => {
    // Pin maxQueuedEntries < maxSize so we hit the eviction path before a size flush. (The
    // funder doesn't enforce any relationship between the two, so this is fine.)
    const {funder} = makeFunder({maxSize: 100, maxQueuedEntries: 2});
    await funder.start();
    funder.accept({address: G1, amount: 1n});
    funder.accept({address: G2, amount: 2n});
    funder.accept({address: G3, amount: 3n});
    const stats = funder.stats();
    assert.equal(stats.queueDepth, 2);
    assert.equal(stats.droppedEntries, 1);
});

test("negative amount is dropped with a counter bump (defensive against producer bugs)", async () => {
    const {funder} = makeFunder();
    await funder.start();
    funder.accept({address: G1, amount: -1n});
    assert.equal(funder.stats().queueDepth, 0);
    assert.equal(funder.stats().droppedEntries, 1);
});

test("rpc errors increment rpcErrors and don't crash the queue", async () => {
    const mocks = makeMocks();
    let calls = 0;
    const wallet = {
        ...mocks.walletClient,
        account: mocks.walletClient.account!,
        async sendTransaction(): Promise<Hex> {
            calls++;
            // First call is the approve — let it succeed. Subsequent (the dispersal) fails.
            if (calls === 1) return ("0x" + "11".repeat(32)) as Hex;
            throw new Error("rpc: server unavailable");
        },
    } as unknown as WalletClient;
    const funder = new Funder({
        walletClient: wallet,
        publicClient: mocks.publicClient,
        treasury: TREASURY,
        parkToken: PARK_TOKEN,
        disperse: DISPERSE,
        maxSize: 1,
    });
    await funder.start();
    funder.accept({address: G1, amount: 1n});
    // Wait for the in-flight dispersal to settle.
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    assert.equal(funder.stats().rpcErrors, 1);
    assert.equal(funder.stats().flushedBatches, 1, "we *attempted* one batch");
    assert.equal(funder.stats().flushedEntries, 1);
});

test("stats shape: avgBatchFill = flushedEntries / flushedBatches", async () => {
    const {funder} = makeFunder({maxSize: 2});
    await funder.start();
    funder.accept({address: G1, amount: 1n});
    funder.accept({address: G2, amount: 2n});
    await new Promise((r) => setImmediate(r));
    funder.accept({address: G3, amount: 3n});
    funder.flush();
    await new Promise((r) => setImmediate(r));
    const s = funder.stats();
    assert.equal(s.flushedBatches, 2);
    assert.equal(s.flushedEntries, 3);
    assert.equal(s.avgBatchFill, 1.5);
});
