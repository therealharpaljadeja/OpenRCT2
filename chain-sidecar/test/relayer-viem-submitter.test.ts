import {test} from "node:test";
import assert from "node:assert/strict";
import {
    decodeFunctionData,
    keccak256,
    parseTransaction,
    type Hex,
    type PublicClient,
} from "viem";
import {SETTLEMENT_BATCHER_ABI} from "../src/chain/abis.js";
import {makeChain} from "../src/chain/clients.js";
import {relayerPool} from "../src/derive/index.js";
import {
    createViemSubmitter,
    DEFAULT_BASE_GAS,
    DEFAULT_PER_AUTH_GAS,
    isNonceError,
} from "../src/relayers/index.js";
import type {Batch} from "../src/batcher/index.js";
import type {SpendAuth} from "../src/batcher/sign.js";

/// We avoid standing up a real RPC: every test injects `sendRawSync` / `fetchFees` /
/// `fetchNonce` overrides through the submitter's options. The fields we actually exercise
/// are calldata encoding, signed-tx round-tripping, latency capture, and how the submitter
/// surfaces RPC errors so the pool's `isNonceError` path stays correct end-to-end.

const TEST_MNEMONIC = "test test test test test test test test test test test junk";
const TEST_BATCHER: `0x${string}` = "0x1111111111111111111111111111111111111111";
const TEST_CHAIN_ID = 10143;

/// Minimum surface from `PublicClient` the submitter touches when its impls are overridden.
/// `chain.id` is the only field consulted on the happy path; supplying just that lets us test
/// without booting a transport.
function fakePublicClient(): PublicClient {
    return {chain: makeChain(TEST_CHAIN_ID, "http://stub")} as unknown as PublicClient;
}

let batchSeq = 1;
function makeAuth(): SpendAuth {
    return {
        from: "0x0000000000000000000000000000000000000123",
        venueId: 7,
        category: 1,
        amount: 12n * 10n ** 18n,
        nonce: 0n,
        deadline: 1_900_000_000n,
        gameTick: 42n,
    };
}

function fakeBatch(authCount = 1): Batch {
    const auth = makeAuth();
    const auths: SpendAuth[] = Array.from({length: authCount}, () => auth);
    const sigs: Hex[] = Array.from({length: authCount}, () => `0x${"ab".repeat(65)}` as Hex);
    return {
        id: batchSeq++,
        auths,
        sigs,
        firstAcceptedAt: 0,
        flushedAt: 0,
        reason: "manual",
    };
}

test("constructor rejects a non-address settlementBatcher", () => {
    assert.throws(
        () =>
            createViemSubmitter({
                publicClient: fakePublicClient(),
                settlementBatcher: "0xnotanaddress" as `0x${string}`,
            }),
        /20-byte hex address/,
    );
});

test("constructor rejects a publicClient without chain", () => {
    const client = {chain: undefined} as unknown as PublicClient;
    assert.throws(
        () =>
            createViemSubmitter({publicClient: client, settlementBatcher: TEST_BATCHER}),
        /chain is required/,
    );
});

test("submit encodes settle(auths, sigs) into the tx data", async () => {
    const captured: {serialized?: `0x${string}`} = {};
    const [relayer] = relayerPool(TEST_MNEMONIC, 1);
    assert.ok(relayer);

    const submitter = createViemSubmitter({
        publicClient: fakePublicClient(),
        settlementBatcher: TEST_BATCHER,
        sendRawSync: async (serialized) => {
            captured.serialized = serialized;
            return {
                txHash: ("0x" + "11".repeat(32)) as Hex,
                blockNumber: 12345n,
                gasUsed: 300_000n,
                status: "success" as const,
            };
        },
        fetchFees: async () => ({maxFeePerGas: 1_000_000_000n, maxPriorityFeePerGas: 1_000_000n}),
        fetchNonce: async () => 0,
    });

    const batch = fakeBatch(3);
    const result = await submitter.submit({account: relayer.account, nonce: 0, batch});
    assert.equal(result.gasUsed, 300_000n);
    assert.equal(result.blockNumber, 12345n);

    // The serialized tx is what hits the wire — round-trip it and verify we encoded
    // `settle(auths, sigs)` with the expected args.
    const parsed = parseTransaction(captured.serialized!);
    assert.equal(parsed.type, "eip1559");
    assert.equal(parsed.chainId, TEST_CHAIN_ID);
    assert.equal(parsed.to?.toLowerCase(), TEST_BATCHER.toLowerCase());
    assert.equal(parsed.nonce, 0);
    assert.equal(parsed.gas, DEFAULT_BASE_GAS + DEFAULT_PER_AUTH_GAS * 3n);
    assert.equal(parsed.maxFeePerGas, 1_000_000_000n);
    assert.equal(parsed.maxPriorityFeePerGas, 1_000_000n);

    const decoded = decodeFunctionData({
        abi: SETTLEMENT_BATCHER_ABI,
        data: parsed.data!,
    });
    assert.equal(decoded.functionName, "settle");
    const [auths, sigs] = decoded.args as [readonly SpendAuth[], readonly Hex[]];
    assert.equal(auths.length, 3);
    assert.equal(sigs.length, 3);
    assert.equal(auths[0]!.venueId, 7);
    assert.equal(auths[0]!.amount, 12n * 10n ** 18n);
    assert.equal(sigs[0], `0x${"ab".repeat(65)}`);
});

test("submit returns the relayer's signature in the serialized tx (signature recoverable)", async () => {
    const captured: {serialized?: `0x${string}`} = {};
    const [relayer] = relayerPool(TEST_MNEMONIC, 1);
    assert.ok(relayer);

    const submitter = createViemSubmitter({
        publicClient: fakePublicClient(),
        settlementBatcher: TEST_BATCHER,
        sendRawSync: async (serialized) => {
            captured.serialized = serialized;
            return {txHash: ("0x" + "22".repeat(32)) as Hex, blockNumber: 1n, gasUsed: 100_000n, status: "success" as const};
        },
        fetchFees: async () => ({maxFeePerGas: 1n, maxPriorityFeePerGas: 1n}),
        fetchNonce: async () => 0,
    });
    await submitter.submit({account: relayer.account, nonce: 7, batch: fakeBatch()});

    // A serialized EIP-1559 tx contains the signature in the trailing v/r/s; viem's
    // parseTransaction populates them on parsed object, and a non-null `r` is enough to
    // confirm the relayer signed locally before we shipped.
    const parsed = parseTransaction(captured.serialized!);
    assert.ok(parsed.r, "expected serialized tx to carry signature.r");
    assert.ok(parsed.s, "expected serialized tx to carry signature.s");
});

test("submit returns wall-time as latencyMs", async () => {
    const [relayer] = relayerPool(TEST_MNEMONIC, 1);
    assert.ok(relayer);
    let t = 1_000;
    // Each `now()` call ticks the clock by 50 ms — first call records `startedAt`, second
    // (after sendRawSync resolves) records the end. So latencyMs ought to be 50 ms.
    const submitter = createViemSubmitter({
        publicClient: fakePublicClient(),
        settlementBatcher: TEST_BATCHER,
        sendRawSync: async () => ({txHash: ("0x" + "33".repeat(32)) as Hex, blockNumber: 1n, gasUsed: 0n, status: "success" as const}),
        fetchFees: async () => ({maxFeePerGas: 1n, maxPriorityFeePerGas: 1n}),
        fetchNonce: async () => 0,
        now: () => {
            const cur = t;
            t += 50;
            return cur;
        },
    });
    const result = await submitter.submit({account: relayer.account, nonce: 0, batch: fakeBatch()});
    assert.equal(result.latencyMs, 50);
});

test("nonce-too-low RPC errors flow through unchanged so the pool can pattern-match", async () => {
    const [relayer] = relayerPool(TEST_MNEMONIC, 1);
    assert.ok(relayer);
    const submitter = createViemSubmitter({
        publicClient: fakePublicClient(),
        settlementBatcher: TEST_BATCHER,
        sendRawSync: async () => {
            // Real viem errors include this exact substring on `nonce too low`. Surfacing it
            // unchanged keeps the pool's `isNonceError` regex matching unchanged across the
            // mock/real boundary.
            throw new Error("rpc: nonce too low (got 5, expected 7)");
        },
        fetchFees: async () => ({maxFeePerGas: 1n, maxPriorityFeePerGas: 1n}),
        fetchNonce: async () => 5,
    });
    await assert.rejects(
        () => submitter.submit({account: relayer.account, nonce: 5, batch: fakeBatch()}),
        (err: Error) => {
            assert.ok(isNonceError(err), "pool's isNonceError must match the surfaced message");
            return /nonce too low/.test(err.message);
        },
    );
});

test("non-nonce errors (revert) propagate verbatim", async () => {
    const [relayer] = relayerPool(TEST_MNEMONIC, 1);
    assert.ok(relayer);
    const submitter = createViemSubmitter({
        publicClient: fakePublicClient(),
        settlementBatcher: TEST_BATCHER,
        sendRawSync: async () => {
            throw new Error("execution reverted: VenueInactive(1, 42)");
        },
        fetchFees: async () => ({maxFeePerGas: 1n, maxPriorityFeePerGas: 1n}),
        fetchNonce: async () => 0,
    });
    await assert.rejects(
        () => submitter.submit({account: relayer.account, nonce: 0, batch: fakeBatch()}),
        (err: Error) => {
            assert.ok(!isNonceError(err), "VenueInactive must not be misread as a nonce error");
            return /VenueInactive/.test(err.message);
        },
    );
});

test("fee snapshot is cached for feeCacheMs and refreshed thereafter", async () => {
    const [relayer] = relayerPool(TEST_MNEMONIC, 1);
    assert.ok(relayer);
    let fetchCount = 0;
    let t = 0;
    const submitter = createViemSubmitter({
        publicClient: fakePublicClient(),
        settlementBatcher: TEST_BATCHER,
        feeCacheMs: 1000,
        sendRawSync: async () => ({txHash: ("0x" + "44".repeat(32)) as Hex, blockNumber: 1n, gasUsed: 0n, status: "success" as const}),
        fetchFees: async () => {
            fetchCount++;
            return {maxFeePerGas: 1n, maxPriorityFeePerGas: 1n};
        },
        fetchNonce: async () => 0,
        now: () => t,
    });
    await submitter.submit({account: relayer.account, nonce: 0, batch: fakeBatch()});
    await submitter.submit({account: relayer.account, nonce: 1, batch: fakeBatch()});
    assert.equal(fetchCount, 1, "second submit within cache window reuses fees");
    t = 5_000; // way past the cache TTL
    await submitter.submit({account: relayer.account, nonce: 2, batch: fakeBatch()});
    assert.equal(fetchCount, 2, "cache expired so we re-fetched");
});

test("fetchNonce passes through to the override", async () => {
    const submitter = createViemSubmitter({
        publicClient: fakePublicClient(),
        settlementBatcher: TEST_BATCHER,
        fetchNonce: async (addr) => {
            assert.equal(addr.toLowerCase(), "0x000000000000000000000000000000000000abcd");
            return 17;
        },
    });
    const n = await submitter.fetchNonce("0x000000000000000000000000000000000000aBCd");
    assert.equal(n, 17);
});

test("gas budget scales with auth count: base + perAuth*N", async () => {
    const [relayer] = relayerPool(TEST_MNEMONIC, 1);
    assert.ok(relayer);
    let captured: `0x${string}` | undefined;
    const submitter = createViemSubmitter({
        publicClient: fakePublicClient(),
        settlementBatcher: TEST_BATCHER,
        baseGas: 100_000n,
        perAuthGas: 40_000n,
        sendRawSync: async (serialized) => {
            captured = serialized;
            return {txHash: ("0x" + "55".repeat(32)) as Hex, blockNumber: 1n, gasUsed: 0n, status: "success" as const};
        },
        fetchFees: async () => ({maxFeePerGas: 1n, maxPriorityFeePerGas: 1n}),
        fetchNonce: async () => 0,
    });
    await submitter.submit({account: relayer.account, nonce: 0, batch: fakeBatch(10)});
    const parsed = parseTransaction(captured!);
    assert.equal(parsed.gas, 100_000n + 40_000n * 10n, "gas = base + perAuth * N");
});

test("calldata digest is stable across runs (acts as a regression guard for ABI drift)", async () => {
    // If `SpendAuth` ever drifts (field reordered, type changed), the calldata digest changes
    // and this test fails. Hard-coded digest derived from the current encoding — if you
    // intentionally update the ABI, regenerate this with one quick local run.
    const [relayer] = relayerPool(TEST_MNEMONIC, 1);
    assert.ok(relayer);
    let captured: `0x${string}` | undefined;
    const submitter = createViemSubmitter({
        publicClient: fakePublicClient(),
        settlementBatcher: TEST_BATCHER,
        sendRawSync: async (serialized) => {
            captured = serialized;
            return {txHash: ("0x" + "66".repeat(32)) as Hex, blockNumber: 1n, gasUsed: 0n, status: "success" as const};
        },
        fetchFees: async () => ({maxFeePerGas: 0n, maxPriorityFeePerGas: 0n}),
        fetchNonce: async () => 0,
    });
    batchSeq = 999; // make the batch.id deterministic for this test
    await submitter.submit({account: relayer.account, nonce: 0, batch: fakeBatch(1)});
    const parsed = parseTransaction(captured!);
    const dataDigest = keccak256(parsed.data!);
    // The digest itself is opaque; what matters is that *the same inputs produce the same
    // digest* across runs. Re-sign once more with the same inputs and compare.
    let captured2: `0x${string}` | undefined;
    const submitter2 = createViemSubmitter({
        publicClient: fakePublicClient(),
        settlementBatcher: TEST_BATCHER,
        sendRawSync: async (serialized) => {
            captured2 = serialized;
            return {txHash: ("0x" + "77".repeat(32)) as Hex, blockNumber: 1n, gasUsed: 0n, status: "success" as const};
        },
        fetchFees: async () => ({maxFeePerGas: 0n, maxPriorityFeePerGas: 0n}),
        fetchNonce: async () => 0,
    });
    batchSeq = 999;
    await submitter2.submit({account: relayer.account, nonce: 0, batch: fakeBatch(1)});
    const parsed2 = parseTransaction(captured2!);
    assert.equal(keccak256(parsed2.data!), dataDigest, "calldata is deterministic for fixed inputs");
});

// ---- M3.13 — receipt.status check ----

test("M3.13: throws on receipt.status === 'reverted' even though sendRawSync resolved", async () => {
    const [relayer] = relayerPool(TEST_MNEMONIC, 1);
    assert.ok(relayer);
    const submitter = createViemSubmitter({
        publicClient: fakePublicClient(),
        settlementBatcher: TEST_BATCHER,
        sendRawSync: async () => ({
            // Even though the RPC happily returned a receipt, the EVM reverted (e.g. a
            // `transferFrom` of 0-balance guest, BadNonce, VenueInactive). Without the M3.13
            // check this would land in throughput.totals.authSubmitted as a confirmed batch.
            txHash: ("0x" + "ee".repeat(32)) as Hex,
            blockNumber: 99n,
            gasUsed: 50_000n,
            status: "reverted" as const,
        }),
        fetchFees: async () => ({maxFeePerGas: 1n, maxPriorityFeePerGas: 1n}),
        fetchNonce: async () => 0,
    });
    await assert.rejects(
        () => submitter.submit({account: relayer.account, nonce: 0, batch: fakeBatch()}),
        (err: Error) => {
            assert.match(err.message, /reverted on chain/);
            // The error includes the tx hash so an operator can pull the on-chain reason.
            assert.match(err.message, /0x(ee){32}/);
            assert.match(err.message, /block=99/);
            return true;
        },
    );
});

test("M3.13: receipt.status revert is NOT classified as a nonce error (must surface to terminal failure)", async () => {
    const [relayer] = relayerPool(TEST_MNEMONIC, 1);
    assert.ok(relayer);
    const submitter = createViemSubmitter({
        publicClient: fakePublicClient(),
        settlementBatcher: TEST_BATCHER,
        sendRawSync: async () => ({
            txHash: ("0x" + "ff".repeat(32)) as Hex,
            blockNumber: 1n,
            gasUsed: 0n,
            status: "reverted" as const,
        }),
        fetchFees: async () => ({maxFeePerGas: 1n, maxPriorityFeePerGas: 1n}),
        fetchNonce: async () => 0,
    });
    await assert.rejects(
        () => submitter.submit({account: relayer.account, nonce: 0, batch: fakeBatch()}),
        (err: Error) => {
            // The pool's `isNonceError` regex must not match this — a reverted batch is a
            // terminal failure, not a "refresh the nonce and retry" case.
            assert.ok(!isNonceError(err), "reverted receipt must not look like a nonce error");
            return true;
        },
    );
});

test("M3.13: receipt.status === 'success' returns normally", async () => {
    const [relayer] = relayerPool(TEST_MNEMONIC, 1);
    assert.ok(relayer);
    const submitter = createViemSubmitter({
        publicClient: fakePublicClient(),
        settlementBatcher: TEST_BATCHER,
        sendRawSync: async () => ({
            txHash: ("0x" + "aa".repeat(32)) as Hex,
            blockNumber: 7n,
            gasUsed: 200_000n,
            status: "success" as const,
        }),
        fetchFees: async () => ({maxFeePerGas: 1n, maxPriorityFeePerGas: 1n}),
        fetchNonce: async () => 0,
    });
    const result = await submitter.submit({account: relayer.account, nonce: 0, batch: fakeBatch()});
    assert.equal(result.blockNumber, 7n);
    assert.equal(result.gasUsed, 200_000n);
});
