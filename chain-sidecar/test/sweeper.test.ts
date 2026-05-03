import {test} from "node:test";
import assert from "node:assert/strict";
import {decodeFunctionData, type Hex, type PublicClient, type WalletClient} from "viem";
import type {LocalAccount} from "viem/accounts";
import {PARK_TOKEN_ABI, PARK_TREASURY_ABI} from "../src/chain/abis.js";
import {deriveGuest} from "../src/derive/index.js";
import {permitDomain, recoverPermitSigner} from "../src/permits/index.js";
import {Sweeper, type SweeperOptions} from "../src/sweeper/index.js";

/// Pinned in-test addresses. Don't matter beyond syntactic validity, but pinning makes
/// calldata-decode assertions stable.
const OWNER: `0x${string}` = "0x000000000000000000000000000000000000aaaa";
const TREASURY: `0x${string}` = "0x000000000000000000000000000000000000bbbb";
const PARK_TOKEN: `0x${string}` = "0x000000000000000000000000000000000000cccc";
const TEST_CHAIN_ID = 10143;
const TEST_MNEMONIC = "test test test test test test test test test test test junk";

interface SentTx {
    to: `0x${string}`;
    data: Hex;
    value: bigint;
}

/// Mock harness: balances + nonces are looked up by lower-cased address. Counters track how
/// many times each contract function was called so tests can assert on read patterns.
function makeMocks(initial: {
    balances?: Record<string, bigint>;
    nonces?: Record<string, bigint>;
} = {}): {
    walletClient: WalletClient;
    publicClient: PublicClient;
    sent: SentTx[];
    setBalance: (addr: `0x${string}`, n: bigint) => void;
    setNonce: (addr: `0x${string}`, n: bigint) => void;
    reads: {balanceOf: number; nonces: number};
} {
    const sent: SentTx[] = [];
    const balances = new Map<string, bigint>();
    const nonces = new Map<string, bigint>();
    for (const [k, v] of Object.entries(initial.balances ?? {})) balances.set(k.toLowerCase(), v);
    for (const [k, v] of Object.entries(initial.nonces ?? {})) nonces.set(k.toLowerCase(), v);

    let counter = 0;
    const reads = {balanceOf: 0, nonces: 0};

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
        async readContract(args: {functionName: string; args: readonly unknown[]}): Promise<bigint> {
            const [addr] = args.args as [`0x${string}`];
            const key = addr.toLowerCase();
            if (args.functionName === "balanceOf") {
                reads.balanceOf++;
                return balances.get(key) ?? 0n;
            }
            if (args.functionName === "nonces") {
                reads.nonces++;
                return nonces.get(key) ?? 0n;
            }
            throw new Error(`unexpected readContract: ${args.functionName}`);
        },
    } as unknown as PublicClient;

    return {
        walletClient,
        publicClient,
        sent,
        setBalance: (addr, n) => balances.set(addr.toLowerCase(), n),
        setNonce: (addr, n) => nonces.set(addr.toLowerCase(), n),
        reads,
    };
}

function makeSweeper(extra: Partial<SweeperOptions> = {}, mocksOverride?: ReturnType<typeof makeMocks>): {
    sweeper: Sweeper;
    sent: SentTx[];
    advance: (ms: number) => void;
    reads: {balanceOf: number; nonces: number};
    setBalance: (addr: `0x${string}`, n: bigint) => void;
} {
    const mocks = mocksOverride ?? makeMocks();
    let t = 1_000_000_000_000;
    const timers = new Set<{at: number; cb: () => void}>();
    const setT = ((cb: () => void, ms: number) => {
        const handle = {at: t + ms, cb};
        timers.add(handle);
        return handle as unknown as ReturnType<typeof setTimeout>;
    }) as unknown as typeof setTimeout;
    const clearT = ((handle: ReturnType<typeof setTimeout>) => {
        timers.delete(handle as unknown as {at: number; cb: () => void});
    }) as unknown as typeof clearTimeout;
    const sweeper = new Sweeper({
        walletClient: mocks.walletClient,
        publicClient: mocks.publicClient,
        treasury: TREASURY,
        parkToken: PARK_TOKEN,
        permitDomain: permitDomain(TEST_CHAIN_ID, PARK_TOKEN),
        deriveAccount: (idx) => deriveGuest(TEST_MNEMONIC, idx).account,
        now: () => t,
        setTimeout: setT,
        clearTimeout: clearT,
        ...extra,
    });
    return {
        sweeper,
        sent: mocks.sent,
        reads: mocks.reads,
        setBalance: mocks.setBalance,
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

/// Decode `treasury.executeBatch(targets, values, datas)` and return all three.
function decodeExecuteBatch(outer: Hex): {
    targets: readonly `0x${string}`[];
    values: readonly bigint[];
    datas: readonly Hex[];
} {
    const exec = decodeFunctionData({abi: PARK_TREASURY_ABI, data: outer});
    assert.equal(exec.functionName, "executeBatch");
    const [targets, values, datas] = exec.args as [
        readonly `0x${string}`[],
        readonly bigint[],
        readonly Hex[],
    ];
    return {targets, values, datas};
}

test("constructor rejects bad addresses / missing account", () => {
    const mocks = makeMocks();
    assert.throws(
        () =>
            new Sweeper({
                walletClient: mocks.walletClient,
                publicClient: mocks.publicClient,
                treasury: "0xzzz" as `0x${string}`,
                parkToken: PARK_TOKEN,
                permitDomain: permitDomain(TEST_CHAIN_ID, PARK_TOKEN),
                deriveAccount: (idx) => deriveGuest(TEST_MNEMONIC, idx).account,
            }),
        /20-byte hex/,
    );
    const noAccount = {...mocks.walletClient, account: undefined} as unknown as WalletClient;
    assert.throws(
        () =>
            new Sweeper({
                walletClient: noAccount,
                publicClient: mocks.publicClient,
                treasury: TREASURY,
                parkToken: PARK_TOKEN,
                permitDomain: permitDomain(TEST_CHAIN_ID, PARK_TOKEN),
                deriveAccount: (idx) => deriveGuest(TEST_MNEMONIC, idx).account,
            }),
        /missing account/,
    );
});

test("constructor rejects out-of-range knobs", () => {
    const mocks = makeMocks();
    const baseOpts = {
        walletClient: mocks.walletClient,
        publicClient: mocks.publicClient,
        treasury: TREASURY,
        parkToken: PARK_TOKEN,
        permitDomain: permitDomain(TEST_CHAIN_ID, PARK_TOKEN),
        deriveAccount: (idx: number) => deriveGuest(TEST_MNEMONIC, idx).account,
    };
    assert.throws(() => new Sweeper({...baseOpts, maxSize: 0}), /Sweeper.maxSize/);
    assert.throws(() => new Sweeper({...baseOpts, maxAgeMs: 0}), /Sweeper.maxAgeMs/);
    assert.throws(() => new Sweeper({...baseOpts, maxQueuedExits: 0}), /maxQueuedExits/);
    assert.throws(() => new Sweeper({...baseOpts, permitDeadlineDays: 0}), /permitDeadlineDays/);
});

test("size-trigger: builds executeBatch with [permit, transferFrom] per non-zero-balance guest", async () => {
    const g0 = deriveGuest(TEST_MNEMONIC, 0);
    const g1 = deriveGuest(TEST_MNEMONIC, 1);
    const mocks = makeMocks({
        balances: {[g0.address]: 100n, [g1.address]: 250n},
        nonces: {[g0.address]: 1n, [g1.address]: 2n},
    });
    const {sweeper, sent} = makeSweeper({maxSize: 2}, mocks);
    sweeper.accept({hdIndex: 0, address: g0.address});
    sweeper.accept({hdIndex: 1, address: g1.address});
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));

    assert.equal(sent.length, 1);
    assert.equal(sent[0]!.to.toLowerCase(), TREASURY.toLowerCase());

    const {targets, values, datas} = decodeExecuteBatch(sent[0]!.data);
    // 2 guests × 2 calls (permit + transferFrom) = 4 entries.
    assert.equal(targets.length, 4);
    assert.equal(values.length, 4);
    assert.equal(datas.length, 4);
    for (const t of targets) assert.equal(t.toLowerCase(), PARK_TOKEN.toLowerCase());
    for (const v of values) assert.equal(v, 0n);

    // datas[0] = permit g0, datas[1] = transferFrom g0, etc. Ordering matters: permit_i must
    // precede transferFrom_i.
    for (const [i, g, balance, nonce] of [[0, g0, 100n, 1n], [2, g1, 250n, 2n]] as const) {
        const permitDecoded = decodeFunctionData({abi: PARK_TOKEN_ABI, data: datas[i]!});
        assert.equal(permitDecoded.functionName, "permit");
        const [owner, spender, value, deadline, v, r, s] = permitDecoded.args as [
            `0x${string}`,
            `0x${string}`,
            bigint,
            bigint,
            number,
            Hex,
            Hex,
        ];
        assert.equal(owner.toLowerCase(), g.address.toLowerCase());
        assert.equal(spender.toLowerCase(), TREASURY.toLowerCase());
        assert.equal(value, balance);
        assert.ok(deadline > 0n, "deadline should be positive");
        // Recover the signer to confirm the permit is valid for this guest.
        const recovered = await recoverPermitSigner(
            permitDomain(TEST_CHAIN_ID, PARK_TOKEN),
            {owner, spender, value, nonce, deadline},
            (`0x${r.slice(2)}${s.slice(2)}${v.toString(16).padStart(2, "0")}`) as Hex,
        );
        assert.equal(recovered.toLowerCase(), g.address.toLowerCase());

        const tfDecoded = decodeFunctionData({abi: PARK_TOKEN_ABI, data: datas[i + 1]!});
        assert.equal(tfDecoded.functionName, "transferFrom");
        const [from, to, amt] = tfDecoded.args as [`0x${string}`, `0x${string}`, bigint];
        assert.equal(from.toLowerCase(), g.address.toLowerCase());
        assert.equal(to.toLowerCase(), TREASURY.toLowerCase());
        assert.equal(amt, balance);
    }

    const stats = sweeper.stats();
    assert.equal(stats.flushedBatches, 1);
    assert.equal(stats.flushedExits, 2);
    assert.equal(stats.zeroBalanceExits, 0);
    assert.equal(stats.flushReasonCounts.size, 1);
    assert.equal(stats.queueDepth, 0);
});

test("zero-balance guests are skipped (no tx, counter bumps)", async () => {
    const g0 = deriveGuest(TEST_MNEMONIC, 0);
    const mocks = makeMocks({
        balances: {[g0.address]: 0n},
        nonces: {[g0.address]: 0n},
    });
    const {sweeper, sent} = makeSweeper({maxSize: 1}, mocks);
    sweeper.accept({hdIndex: 0, address: g0.address});
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));

    assert.equal(sent.length, 0, "no tx when everyone in the window is broke");
    const stats = sweeper.stats();
    assert.equal(stats.flushedBatches, 1, "we still attempted the batch");
    assert.equal(stats.flushedExits, 0);
    assert.equal(stats.zeroBalanceExits, 1);
});

test("mixed window: zero + non-zero guests share one tx with only the non-zero entries", async () => {
    const g0 = deriveGuest(TEST_MNEMONIC, 0);
    const g1 = deriveGuest(TEST_MNEMONIC, 1);
    const mocks = makeMocks({
        balances: {[g0.address]: 0n, [g1.address]: 50n},
        nonces: {[g0.address]: 0n, [g1.address]: 0n},
    });
    const {sweeper, sent} = makeSweeper({maxSize: 2}, mocks);
    sweeper.accept({hdIndex: 0, address: g0.address});
    sweeper.accept({hdIndex: 1, address: g1.address});
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));

    assert.equal(sent.length, 1);
    const {datas} = decodeExecuteBatch(sent[0]!.data);
    assert.equal(datas.length, 2, "exactly one (permit, transferFrom) pair for the funded guest");
    const stats = sweeper.stats();
    assert.equal(stats.flushedExits, 1);
    assert.equal(stats.zeroBalanceExits, 1);
});

test("age-trigger: flushes after maxAgeMs even below maxSize", async () => {
    const g0 = deriveGuest(TEST_MNEMONIC, 0);
    const mocks = makeMocks({balances: {[g0.address]: 1n}});
    const {sweeper, sent, advance} = makeSweeper({maxSize: 100, maxAgeMs: 200}, mocks);
    sweeper.accept({hdIndex: 0, address: g0.address});
    advance(199);
    assert.equal(sent.length, 0);
    advance(2);
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    assert.equal(sent.length, 1);
    assert.equal(sweeper.stats().flushReasonCounts.age, 1);
});

test("manual flush() ships whatever is queued", async () => {
    const g0 = deriveGuest(TEST_MNEMONIC, 0);
    const mocks = makeMocks({balances: {[g0.address]: 7n}});
    const {sweeper, sent} = makeSweeper({maxSize: 100}, mocks);
    sweeper.accept({hdIndex: 0, address: g0.address});
    sweeper.flush();
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    assert.equal(sent.length, 1);
    assert.equal(sweeper.stats().flushReasonCounts.manual, 1);
});

test("flush() on empty buffer is a no-op", async () => {
    const {sweeper, sent} = makeSweeper();
    sweeper.flush();
    assert.equal(sent.length, 0);
    assert.equal(sweeper.stats().flushedBatches, 0);
});

test("stop() drains pending exits and rejects further accepts", async () => {
    const g0 = deriveGuest(TEST_MNEMONIC, 0);
    const g1 = deriveGuest(TEST_MNEMONIC, 1);
    const g2 = deriveGuest(TEST_MNEMONIC, 2);
    const mocks = makeMocks({
        balances: {[g0.address]: 1n, [g1.address]: 2n, [g2.address]: 3n},
    });
    const {sweeper, sent} = makeSweeper({maxSize: 100}, mocks);
    sweeper.accept({hdIndex: 0, address: g0.address});
    sweeper.accept({hdIndex: 1, address: g1.address});
    await sweeper.stop();
    assert.equal(sent.length, 1, "stop flushed the buffered batch");
    assert.equal(sweeper.stats().flushReasonCounts.stop, 1);

    sweeper.accept({hdIndex: 2, address: g2.address});
    assert.equal(sweeper.stats().droppedExits, 1, "post-stop accept is dropped");
});

test("backpressure: oldest exits dropped past maxQueuedExits", () => {
    const g0 = deriveGuest(TEST_MNEMONIC, 0);
    const g1 = deriveGuest(TEST_MNEMONIC, 1);
    const g2 = deriveGuest(TEST_MNEMONIC, 2);
    const {sweeper} = makeSweeper({maxSize: 100, maxQueuedExits: 2});
    sweeper.accept({hdIndex: 0, address: g0.address});
    sweeper.accept({hdIndex: 1, address: g1.address});
    sweeper.accept({hdIndex: 2, address: g2.address});
    const stats = sweeper.stats();
    assert.equal(stats.queueDepth, 2);
    assert.equal(stats.droppedExits, 1);
});

test("malformed input is dropped with a counter bump", () => {
    const {sweeper} = makeSweeper();
    sweeper.accept({hdIndex: -1, address: "0x0000000000000000000000000000000000000000"});
    sweeper.accept({hdIndex: 0, address: "0xnotahex" as `0x${string}`});
    const stats = sweeper.stats();
    assert.equal(stats.queueDepth, 0);
    assert.equal(stats.droppedExits, 2);
});

test("hdIndex / address mismatch is dropped (producer bug guard)", async () => {
    const g0 = deriveGuest(TEST_MNEMONIC, 0);
    const mocks = makeMocks({balances: {[g0.address]: 100n}});
    const {sweeper, sent} = makeSweeper({maxSize: 1}, mocks);
    // Claim a different address than the one hdIndex=0 derives to. The mock will report a
    // balance for the *claimed* address, but the sweeper guards by comparing derived vs claimed.
    const liarAddr: `0x${string}` = "0x000000000000000000000000000000000000ffff";
    mocks.setBalance(liarAddr, 100n);
    sweeper.accept({hdIndex: 0, address: liarAddr});
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    // Window had one entry, hit the mismatch path, no tx sent (everyone else was zero).
    assert.equal(sent.length, 0);
    const stats = sweeper.stats();
    assert.equal(stats.flushedBatches, 1);
    assert.equal(stats.flushedExits, 0);
    assert.equal(stats.droppedExits, 1);
});

test("rpc errors increment rpcErrors and don't crash the queue", async () => {
    const g0 = deriveGuest(TEST_MNEMONIC, 0);
    const wallet = {
        account: {address: OWNER, type: "json-rpc"},
        chain: null,
        async sendTransaction(): Promise<Hex> {
            throw new Error("rpc: server unavailable");
        },
    } as unknown as WalletClient;
    const publicClient = {
        async readContract(args: {functionName: string}): Promise<bigint> {
            if (args.functionName === "balanceOf") return 1n;
            if (args.functionName === "nonces") return 0n;
            throw new Error(`unexpected: ${args.functionName}`);
        },
    } as unknown as PublicClient;
    const sweeper = new Sweeper({
        walletClient: wallet,
        publicClient,
        treasury: TREASURY,
        parkToken: PARK_TOKEN,
        permitDomain: permitDomain(TEST_CHAIN_ID, PARK_TOKEN),
        deriveAccount: (idx) => deriveGuest(TEST_MNEMONIC, idx).account,
        maxSize: 1,
    });
    sweeper.accept({hdIndex: 0, address: g0.address});
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    const stats = sweeper.stats();
    assert.equal(stats.rpcErrors, 1);
    assert.equal(stats.flushedBatches, 1);
    assert.equal(stats.flushedExits, 0, "tx failed; we don't claim the exit was swept");
});

test("read errors (balanceOf revert) bump rpcErrors", async () => {
    const g0 = deriveGuest(TEST_MNEMONIC, 0);
    const wallet = {
        account: {address: OWNER, type: "json-rpc"},
        chain: null,
        async sendTransaction(): Promise<Hex> {
            return ("0x" + "ab".repeat(32)) as Hex;
        },
    } as unknown as WalletClient;
    const publicClient = {
        async readContract(): Promise<bigint> {
            throw new Error("rpc: read failed");
        },
    } as unknown as PublicClient;
    const sweeper = new Sweeper({
        walletClient: wallet,
        publicClient,
        treasury: TREASURY,
        parkToken: PARK_TOKEN,
        permitDomain: permitDomain(TEST_CHAIN_ID, PARK_TOKEN),
        deriveAccount: (idx) => deriveGuest(TEST_MNEMONIC, idx).account,
        maxSize: 1,
    });
    sweeper.accept({hdIndex: 0, address: g0.address});
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    assert.equal(sweeper.stats().rpcErrors, 1);
});

test("avgBatchFill = flushedExits / flushedBatches", async () => {
    const g0 = deriveGuest(TEST_MNEMONIC, 0);
    const g1 = deriveGuest(TEST_MNEMONIC, 1);
    const g2 = deriveGuest(TEST_MNEMONIC, 2);
    const mocks = makeMocks({
        balances: {[g0.address]: 1n, [g1.address]: 2n, [g2.address]: 3n},
    });
    const {sweeper} = makeSweeper({maxSize: 2}, mocks);
    sweeper.accept({hdIndex: 0, address: g0.address});
    sweeper.accept({hdIndex: 1, address: g1.address});
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    sweeper.accept({hdIndex: 2, address: g2.address});
    sweeper.flush();
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    const s = sweeper.stats();
    assert.equal(s.flushedBatches, 2);
    assert.equal(s.flushedExits, 3);
    assert.equal(s.avgBatchFill, 1.5);
});

test("uses the on-chain nonce when signing each permit", async () => {
    // If a guest already incremented their permit nonce (e.g. they re-permitted at some point),
    // the sweep permit must use that nonce or the chain rejects with InvalidSigner. Validate by
    // recovering the signer against the SAME nonce we read from the public client.
    const g0 = deriveGuest(TEST_MNEMONIC, 0);
    const expectedNonce = 7n;
    const mocks = makeMocks({
        balances: {[g0.address]: 100n},
        nonces: {[g0.address]: expectedNonce},
    });
    const {sweeper, sent} = makeSweeper({maxSize: 1}, mocks);
    sweeper.accept({hdIndex: 0, address: g0.address});
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    assert.equal(sent.length, 1);
    const {datas} = decodeExecuteBatch(sent[0]!.data);
    const permit = decodeFunctionData({abi: PARK_TOKEN_ABI, data: datas[0]!});
    const [owner, spender, value, deadline, v, r, s] = permit.args as [
        `0x${string}`,
        `0x${string}`,
        bigint,
        bigint,
        number,
        Hex,
        Hex,
    ];
    const recovered = await recoverPermitSigner(
        permitDomain(TEST_CHAIN_ID, PARK_TOKEN),
        {owner, spender, value, nonce: expectedNonce, deadline},
        (`0x${r.slice(2)}${s.slice(2)}${v.toString(16).padStart(2, "0")}`) as Hex,
    );
    assert.equal(recovered.toLowerCase(), g0.address.toLowerCase(), "permit signed at the on-chain nonce");
    // Sanity: recovery against a *different* nonce should not match.
    const mismatched = await recoverPermitSigner(
        permitDomain(TEST_CHAIN_ID, PARK_TOKEN),
        {owner, spender, value, nonce: 0n, deadline},
        (`0x${r.slice(2)}${s.slice(2)}${v.toString(16).padStart(2, "0")}`) as Hex,
    );
    assert.notEqual(mismatched.toLowerCase(), g0.address.toLowerCase());
});

test("custom deriveAccount lets tests inject mock accounts (independent of mnemonic)", async () => {
    // Verify the deriveAccount injection actually flows through to signing. We pass a derive
    // function that returns guest 5 regardless of hdIndex; the signed permit must come from
    // guest 5's key.
    const g5 = deriveGuest(TEST_MNEMONIC, 5);
    const mocks = makeMocks({balances: {[g5.address]: 42n}});
    const sweeper = new Sweeper({
        walletClient: mocks.walletClient,
        publicClient: mocks.publicClient,
        treasury: TREASURY,
        parkToken: PARK_TOKEN,
        permitDomain: permitDomain(TEST_CHAIN_ID, PARK_TOKEN),
        deriveAccount: (_idx: number): LocalAccount => g5.account,
        maxSize: 1,
    });
    sweeper.accept({hdIndex: 999, address: g5.address});
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    assert.equal(mocks.sent.length, 1);
});
