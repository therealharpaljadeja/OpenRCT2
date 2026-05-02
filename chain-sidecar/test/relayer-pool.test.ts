import {test} from "node:test";
import assert from "node:assert/strict";
import type {Hex} from "viem";
import {relayerPool, type DerivedAccount} from "../src/derive/index.js";
import {RelayerPool, type RelayerSubmitter, type SubmitArgs, type SubmitResult} from "../src/relayers/index.js";
import type {Batch} from "../src/batcher/index.js";
import type {SpendAuth} from "../src/batcher/sign.js";

const TEST_MNEMONIC = "test test test test test test test test test test test junk";

/// Build a small fake batch — relayer-pool tests only care about routing, not signature
/// content, so most fields are placeholders.
let batchSeq = 1;
function fakeBatch(authCount = 1): Batch {
    const auth: SpendAuth = {
        from: "0x0000000000000000000000000000000000000000",
        venueId: 0,
        category: 0,
        amount: 0n,
        nonce: 0n,
        deadline: 0n,
        gameTick: 0n,
    };
    const auths: SpendAuth[] = Array(authCount).fill(auth);
    const sigs: Hex[] = Array(authCount).fill("0x" + "ab".repeat(65) as Hex);
    return {
        id: batchSeq++,
        auths,
        sigs,
        firstAcceptedAt: 0,
        flushedAt: 0,
        reason: "manual",
    };
}

/// Submitter mock that records every call (in submission order, with the relayer address +
/// nonce used) and gates resolution on a manual switch — lets tests assert on round-robin
/// distribution and queueing without timing-sensitive sleeps.
interface MockSubmitter extends RelayerSubmitter {
    readonly calls: Array<{address: `0x${string}`; nonce: number; batchId: number}>;
    readonly fetchCalls: Array<`0x${string}`>;
    /// Count of currently in-flight `submit` calls — i.e. how many parked promises haven't
    /// yet been released.
    readonly inFlight: () => number;
    /// Release the oldest parked submit with a successful result.
    resolveOldest: (result?: Partial<SubmitResult>) => void;
    /// Release the oldest parked submit with an error (caller picks the message).
    rejectOldest: (msg: string) => void;
    /// Toggle: if true, `submit` resolves immediately. If false, parks until released.
    autoResolve: boolean;
    /// Programmable per-relayer nonce returned by `fetchNonce`. Maps lower-cased addr → n.
    nonces: Map<string, number>;
}

function makeMockSubmitter(): MockSubmitter {
    const calls: Array<{address: `0x${string}`; nonce: number; batchId: number}> = [];
    const fetchCalls: Array<`0x${string}`> = [];
    const parked: Array<{
        resolve: (r: SubmitResult) => void;
        reject: (e: Error) => void;
    }> = [];
    const nonces = new Map<string, number>();
    const submitter: MockSubmitter = {
        calls,
        fetchCalls,
        inFlight: () => parked.length,
        autoResolve: true,
        nonces,
        async submit(args: SubmitArgs): Promise<SubmitResult> {
            calls.push({address: args.account.address, nonce: args.nonce, batchId: args.batch.id});
            if (submitter.autoResolve) {
                return {
                    txHash: ("0x" + args.batch.id.toString(16).padStart(64, "0")) as Hex,
                    blockNumber: BigInt(args.batch.id),
                    gasUsed: 0n,
                    latencyMs: 1,
                };
            }
            return new Promise<SubmitResult>((resolve, reject) => {
                parked.push({resolve, reject});
            });
        },
        async fetchNonce(addr: `0x${string}`): Promise<number> {
            fetchCalls.push(addr);
            return nonces.get(addr.toLowerCase()) ?? 0;
        },
        resolveOldest(result: Partial<SubmitResult> = {}): void {
            const w = parked.shift();
            if (!w) throw new Error("no parked submit to resolve");
            w.resolve({
                txHash: ("0x" + "11".repeat(32)) as Hex,
                blockNumber: 1n,
                gasUsed: 0n,
                latencyMs: 1,
                ...result,
            });
        },
        rejectOldest(msg: string): void {
            const w = parked.shift();
            if (!w) throw new Error("no parked submit to reject");
            w.reject(new Error(msg));
        },
    };
    return submitter;
}

function setupPool(opts: {n: number; submitter: RelayerSubmitter; maxQueuedBatches?: number}): {
    pool: RelayerPool;
    relayers: DerivedAccount[];
} {
    const relayers = relayerPool(TEST_MNEMONIC, opts.n);
    const pool = new RelayerPool({
        relayers,
        submitter: opts.submitter,
        ...(opts.maxQueuedBatches !== undefined ? {maxQueuedBatches: opts.maxQueuedBatches} : {}),
    });
    return {pool, relayers};
}

test("constructor rejects an empty relayer set", () => {
    const submitter = makeMockSubmitter();
    assert.throws(
        () => new RelayerPool({relayers: [], submitter}),
        /at least one relayer/,
    );
});

test("constructor rejects negative / non-integer maxQueuedBatches", () => {
    const submitter = makeMockSubmitter();
    const relayers = relayerPool(TEST_MNEMONIC, 2);
    assert.throws(
        () => new RelayerPool({relayers, submitter, maxQueuedBatches: -1}),
        /maxQueuedBatches/,
    );
    assert.throws(
        () => new RelayerPool({relayers, submitter, maxQueuedBatches: 1.5}),
        /maxQueuedBatches/,
    );
});

test("round-robin: 8 sequential batches across 4 relayers each hit a different EOA in order", async () => {
    const submitter = makeMockSubmitter();
    const {pool, relayers} = setupPool({n: 4, submitter});
    // Auto-resolve in order; sequential awaits guarantee deterministic round-robin.
    for (let i = 0; i < 8; i++) await pool.sink(fakeBatch());
    // First 4 calls cycle through addresses 0..3, then again 0..3.
    const expected = [0, 1, 2, 3, 0, 1, 2, 3].map((i) => relayers[i]!.address);
    assert.deepEqual(
        submitter.calls.map((c) => c.address),
        expected,
    );
});

test("per-relayer nonce sequences are monotonic and independent", async () => {
    const submitter = makeMockSubmitter();
    // Each relayer starts at a different on-chain nonce so we can prove the pool isn't
    // sharing state across them.
    const relayers = relayerPool(TEST_MNEMONIC, 3);
    submitter.nonces.set(relayers[0]!.address.toLowerCase(), 10);
    submitter.nonces.set(relayers[1]!.address.toLowerCase(), 20);
    submitter.nonces.set(relayers[2]!.address.toLowerCase(), 30);
    const pool = new RelayerPool({relayers, submitter});

    // 3 cycles × 3 relayers = 9 submits.
    for (let i = 0; i < 9; i++) await pool.sink(fakeBatch());

    // Group calls by address and verify nonce sequence is the relayer's seed + 0,1,2.
    const byAddr = new Map<string, number[]>();
    for (const c of submitter.calls) {
        const key = c.address.toLowerCase();
        if (!byAddr.has(key)) byAddr.set(key, []);
        byAddr.get(key)!.push(c.nonce);
    }
    assert.deepEqual(byAddr.get(relayers[0]!.address.toLowerCase()), [10, 11, 12]);
    assert.deepEqual(byAddr.get(relayers[1]!.address.toLowerCase()), [20, 21, 22]);
    assert.deepEqual(byAddr.get(relayers[2]!.address.toLowerCase()), [30, 31, 32]);
});

test("first use of each relayer triggers exactly one fetchNonce call", async () => {
    const submitter = makeMockSubmitter();
    const {pool, relayers} = setupPool({n: 3, submitter});
    for (let i = 0; i < 9; i++) await pool.sink(fakeBatch());
    // Three relayers × one prime each, no extra fetches under happy-path submits.
    assert.equal(submitter.fetchCalls.length, 3);
    const addrs = new Set(submitter.fetchCalls.map((a) => a.toLowerCase()));
    assert.equal(addrs.size, 3);
    for (const r of relayers) assert.ok(addrs.has(r.address.toLowerCase()));
});

test("nonce-too-low error triggers fetchNonce + retry on the same relayer", async () => {
    const submitter = makeMockSubmitter();
    const {pool, relayers} = setupPool({n: 1, submitter});
    submitter.nonces.set(relayers[0]!.address.toLowerCase(), 5);

    submitter.autoResolve = false;
    const sinkP = pool.sink(fakeBatch());
    // First submit parks; reject with a nonce error.
    while (submitter.inFlight() === 0) await new Promise((r) => setImmediate(r));
    submitter.rejectOldest("nonce too low");
    // Pool refreshes and retries — second submit is parked. Bump the chain nonce so the
    // second attempt picks up the corrected value.
    submitter.nonces.set(relayers[0]!.address.toLowerCase(), 7);
    while (submitter.inFlight() === 0) await new Promise((r) => setImmediate(r));
    submitter.resolveOldest();
    await sinkP;

    assert.equal(submitter.calls.length, 2, "two submit attempts (failed + retry)");
    assert.equal(submitter.calls[0]!.nonce, 5, "first attempt used the primed nonce");
    assert.equal(submitter.calls[1]!.nonce, 7, "retry used the freshly-fetched nonce");
    const stats = pool.stats();
    assert.equal(stats.relayers[0]!.nonceRefreshes, 1);
    assert.equal(stats.relayers[0]!.errors, 1);
    assert.equal(stats.relayers[0]!.submitted, 1);
});

test("non-nonce errors do not trigger a refresh and surface to the caller", async () => {
    const submitter = makeMockSubmitter();
    const {pool} = setupPool({n: 1, submitter});
    submitter.autoResolve = false;
    const sinkP = pool.sink(fakeBatch());
    while (submitter.inFlight() === 0) await new Promise((r) => setImmediate(r));
    submitter.rejectOldest("revert: VenueInactive");
    await assert.rejects(sinkP, /VenueInactive/);
    const stats = pool.stats();
    assert.equal(stats.relayers[0]!.errors, 1);
    assert.equal(stats.relayers[0]!.nonceRefreshes, 0);
    // 1 prime-fetch only — no error-driven refresh.
    assert.equal(submitter.fetchCalls.length, 1);
});

test("retry path is single-shot — nonce error on the retry surfaces", async () => {
    const submitter = makeMockSubmitter();
    const {pool} = setupPool({n: 1, submitter});
    submitter.autoResolve = false;
    const sinkP = pool.sink(fakeBatch());
    while (submitter.inFlight() === 0) await new Promise((r) => setImmediate(r));
    submitter.rejectOldest("nonce too low");
    while (submitter.inFlight() === 0) await new Promise((r) => setImmediate(r));
    submitter.rejectOldest("already known");
    await assert.rejects(sinkP, /already known/);
    const stats = pool.stats();
    assert.equal(stats.relayers[0]!.errors, 2);
    assert.equal(stats.relayers[0]!.nonceRefreshes, 1, "only one refresh — no infinite loop");
});

test("queueing: when all relayers are busy, sink waits for a free one", async () => {
    const submitter = makeMockSubmitter();
    const {pool, relayers} = setupPool({n: 2, submitter});
    submitter.autoResolve = false;

    const p1 = pool.sink(fakeBatch());
    const p2 = pool.sink(fakeBatch());
    while (submitter.inFlight() < 2) await new Promise((r) => setImmediate(r));
    assert.equal(pool.stats().busy, 2);
    assert.equal(pool.stats().queuedBatches, 0);

    // Third call queues (no free relayer).
    const p3 = pool.sink(fakeBatch());
    await new Promise((r) => setImmediate(r));
    assert.equal(pool.stats().queuedBatches, 1);

    // Release the first relayer; the queued batch should kick off on it.
    submitter.resolveOldest();
    await p1;
    while (submitter.inFlight() < 2) await new Promise((r) => setImmediate(r));
    assert.equal(pool.stats().queuedBatches, 0);
    submitter.resolveOldest();
    submitter.resolveOldest();
    await Promise.all([p2, p3]);

    assert.equal(submitter.calls.length, 3);
    // Two distinct addresses used (round-robin across the 2-relayer pool).
    const addrs = new Set(submitter.calls.map((c) => c.address.toLowerCase()));
    assert.equal(addrs.size, 2);
    for (const r of relayers) assert.ok(addrs.has(r.address.toLowerCase()));
});

test("queue cap rejects the next sink() with a stats-counted rejection", async () => {
    const submitter = makeMockSubmitter();
    const {pool} = setupPool({n: 1, submitter, maxQueuedBatches: 1});
    submitter.autoResolve = false;

    // Fill the only relayer.
    const p1 = pool.sink(fakeBatch());
    while (submitter.inFlight() === 0) await new Promise((r) => setImmediate(r));
    // Fill the only queue slot.
    const p2 = pool.sink(fakeBatch());
    await new Promise((r) => setImmediate(r));
    assert.equal(pool.stats().queuedBatches, 1);
    // Third sink should reject immediately.
    await assert.rejects(pool.sink(fakeBatch()), /queue full/);
    assert.equal(pool.stats().totalQueueRejections, 1);

    submitter.resolveOldest();
    await p1;
    while (submitter.inFlight() === 0) await new Promise((r) => setImmediate(r));
    submitter.resolveOldest();
    await p2;
});

test("stop() rejects pending waiters but lets in-flight submits drain", async () => {
    const submitter = makeMockSubmitter();
    const {pool} = setupPool({n: 1, submitter});
    submitter.autoResolve = false;
    const inFlight = pool.sink(fakeBatch());
    while (submitter.inFlight() === 0) await new Promise((r) => setImmediate(r));
    const queued = pool.sink(fakeBatch());
    await new Promise((r) => setImmediate(r));
    await pool.stop();
    await assert.rejects(queued, /stopped before assignment/);
    submitter.resolveOldest();
    await inFlight;
    assert.equal(pool.stats().stopped, true);
});

test("sink rejects new work after stop()", async () => {
    const submitter = makeMockSubmitter();
    const {pool} = setupPool({n: 2, submitter});
    await pool.stop();
    await assert.rejects(pool.sink(fakeBatch()), /stopped/);
});

test("stats(): aggregate counters reflect per-relayer counters", async () => {
    const submitter = makeMockSubmitter();
    const {pool} = setupPool({n: 2, submitter});
    for (let i = 0; i < 4; i++) await pool.sink(fakeBatch());
    const s = pool.stats();
    assert.equal(s.size, 2);
    assert.equal(s.totalSubmitted, 4);
    assert.equal(s.totalErrors, 0);
    assert.equal(s.totalNonceRefreshes, 0);
    // Each relayer should record its last tx.
    for (const r of s.relayers) {
        assert.match(r.lastTxHash ?? "", /^0x[0-9a-f]{64}$/);
        assert.equal(r.lastLatencyMs, 1);
    }
});

test("stats() does not leak the HDAccount or any signing material", async () => {
    const submitter = makeMockSubmitter();
    const {pool} = setupPool({n: 2, submitter});
    await pool.sink(fakeBatch());
    const s = pool.stats();
    for (const r of s.relayers) {
        // Only the address-and-counters shape expected — anything else (e.g. an `account`
        // or `privateKey` field) would be a leak.
        const allowedKeys = new Set([
            "index",
            "address",
            "nonce",
            "busy",
            "submitted",
            "errors",
            "nonceRefreshes",
            "lastLatencyMs",
            "lastTxHash",
        ]);
        for (const key of Object.keys(r)) {
            assert.ok(allowedKeys.has(key), `relayer stats leak: unexpected key '${key}'`);
        }
    }
});

test("pool sink shape matches BatchSink (assignable to {sink: BatchSink})", async () => {
    const submitter = makeMockSubmitter();
    const {pool} = setupPool({n: 1, submitter});
    // Compile-time check: this would fail tsc if the shape drifted.
    const _check: (b: Batch) => Promise<{txHash?: Hex}> = pool.sink;
    void _check;
    // And a runtime use of it via the same signature the batcher will use.
    const result = await pool.sink(fakeBatch());
    assert.match(result.txHash ?? "", /^0x[0-9a-f]{64}$/);
});
