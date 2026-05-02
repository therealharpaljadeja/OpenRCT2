import {test} from "node:test";
import assert from "node:assert/strict";
import {encodeAbiParameters, keccak256, concat, toHex, type Hex} from "viem";
import {deriveGuest} from "../src/derive/index.js";
import {
    SPEND_AUTH_DOMAIN_NAME,
    SPEND_AUTH_DOMAIN_VERSION,
    spendAuthDomain,
    hashSpendAuth,
    signSpendAuth,
    recoverSpendAuthSigner,
    type SpendAuth,
} from "../src/batcher/sign.js";

/// Same canonical Hardhat / Foundry mnemonic the rest of the suite uses; lets a curious human
/// double-check signatures with `cast` if anything looks off.
const TEST_MNEMONIC = "test test test test test test test test test test test junk";

/// Arbitrary-but-pinned fake deployment values. The signer doesn't reach the network, so the
/// address just needs to be syntactically valid; pinning it makes hash assertions stable.
const TEST_BATCHER: `0x${string}` = "0x1111111111111111111111111111111111111111";
const TEST_CHAIN_ID = 10143; // Monad testnet (current at time of writing); not network-bound here.

function makeAuth(overrides: Partial<SpendAuth> = {}): SpendAuth {
    const guest = deriveGuest(TEST_MNEMONIC, 0);
    return {
        from: guest.address,
        venueId: 7,
        category: 1,
        amount: 12_000000000000000000n, // 12 PARK at 18 decimals
        nonce: 0n,
        deadline: 1_900_000_000n, // year 2030, well in the future
        gameTick: 42n,
        ...overrides,
    };
}

/// Re-implement the on-chain hash from first principles. If `hashSpendAuth` ever drifts from
/// the contract — wrong field order, wrong type string, wrong domain name — this test catches
/// it without needing a live RPC. Mirrors `SettlementBatcher._hashTypedDataV4` byte-for-byte.
function expectedDigest(auth: SpendAuth, chainId: number, verifyingContract: `0x${string}`): Hex {
    const SPEND_AUTH_TYPEHASH = keccak256(
        toHex(
            "SpendAuth(address from,uint32 venueId,uint8 category,uint256 amount,uint64 nonce,uint64 deadline,uint64 gameTick)",
        ),
    );
    const DOMAIN_TYPEHASH = keccak256(
        toHex("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
    );
    const structHash = keccak256(
        encodeAbiParameters(
            [
                {type: "bytes32"},
                {type: "address"},
                {type: "uint32"},
                {type: "uint8"},
                {type: "uint256"},
                {type: "uint64"},
                {type: "uint64"},
                {type: "uint64"},
            ],
            [
                SPEND_AUTH_TYPEHASH,
                auth.from,
                auth.venueId,
                auth.category,
                auth.amount,
                auth.nonce,
                auth.deadline,
                auth.gameTick,
            ],
        ),
    );
    const domainSeparator = keccak256(
        encodeAbiParameters(
            [{type: "bytes32"}, {type: "bytes32"}, {type: "bytes32"}, {type: "uint256"}, {type: "address"}],
            [
                DOMAIN_TYPEHASH,
                keccak256(toHex(SPEND_AUTH_DOMAIN_NAME)),
                keccak256(toHex(SPEND_AUTH_DOMAIN_VERSION)),
                BigInt(chainId),
                verifyingContract,
            ],
        ),
    );
    return keccak256(concat(["0x1901", domainSeparator, structHash]));
}

test("hashSpendAuth matches the on-chain typed-data hash exactly", () => {
    const domain = spendAuthDomain(TEST_CHAIN_ID, TEST_BATCHER);
    const auth = makeAuth();
    const ours = hashSpendAuth(domain, auth);
    const theirs = expectedDigest(auth, TEST_CHAIN_ID, TEST_BATCHER);
    assert.equal(ours, theirs);
});

test("hashSpendAuth changes when any field changes", () => {
    const domain = spendAuthDomain(TEST_CHAIN_ID, TEST_BATCHER);
    const base = makeAuth();
    const baseHash = hashSpendAuth(domain, base);

    // Each mutation flips at least one byte of the digest. If two of these collided we'd have a
    // genuine encoding bug (or a keccak collision; we'd take the keccak collision over the bug).
    const mutants: Array<Partial<SpendAuth>> = [
        {venueId: 8},
        {category: 2},
        {amount: base.amount + 1n},
        {nonce: 1n},
        {deadline: base.deadline + 1n},
        {gameTick: 43n},
    ];
    const describe = (m: Partial<SpendAuth>): string =>
        Object.entries(m).map(([k, v]) => `${k}=${typeof v === "bigint" ? `${v}n` : String(v)}`).join(",");
    for (const m of mutants) {
        const h = hashSpendAuth(domain, makeAuth(m));
        assert.notEqual(h, baseHash, `mutation {${describe(m)}} did not change digest`);
    }
});

test("signSpendAuth produces a recoverable signature for the guest", async () => {
    const guest = deriveGuest(TEST_MNEMONIC, 0);
    const domain = spendAuthDomain(TEST_CHAIN_ID, TEST_BATCHER);
    const auth = makeAuth({from: guest.address});

    const sig = await signSpendAuth(guest.account, domain, auth);
    assert.match(sig, /^0x[0-9a-f]{130}$/, "expected a 65-byte hex signature");

    const recovered = await recoverSpendAuthSigner(domain, auth, sig);
    assert.equal(recovered.toLowerCase(), guest.address.toLowerCase());
});

test("signing the same auth twice yields the same signature (deterministic ECDSA via RFC 6979)", async () => {
    const guest = deriveGuest(TEST_MNEMONIC, 0);
    const domain = spendAuthDomain(TEST_CHAIN_ID, TEST_BATCHER);
    const auth = makeAuth({from: guest.address});

    const a = await signSpendAuth(guest.account, domain, auth);
    const b = await signSpendAuth(guest.account, domain, auth);
    assert.equal(a, b);
});

test("different guests produce different signatures and recover to themselves", async () => {
    const g0 = deriveGuest(TEST_MNEMONIC, 0);
    const g1 = deriveGuest(TEST_MNEMONIC, 1);
    const domain = spendAuthDomain(TEST_CHAIN_ID, TEST_BATCHER);

    const auth0 = makeAuth({from: g0.address});
    const auth1 = makeAuth({from: g1.address});

    const sig0 = await signSpendAuth(g0.account, domain, auth0);
    const sig1 = await signSpendAuth(g1.account, domain, auth1);
    assert.notEqual(sig0, sig1);

    assert.equal((await recoverSpendAuthSigner(domain, auth0, sig0)).toLowerCase(), g0.address.toLowerCase());
    assert.equal((await recoverSpendAuthSigner(domain, auth1, sig1)).toLowerCase(), g1.address.toLowerCase());
});

test("signSpendAuth refuses when account.address ≠ auth.from", async () => {
    // The contract would reject this with `BadSignature`; we'd rather fail before touching the
    // batch queue so the diagnostic points at the producer, not the chain.
    const g0 = deriveGuest(TEST_MNEMONIC, 0);
    const g1 = deriveGuest(TEST_MNEMONIC, 1);
    const domain = spendAuthDomain(TEST_CHAIN_ID, TEST_BATCHER);
    const auth = makeAuth({from: g1.address});

    await assert.rejects(() => signSpendAuth(g0.account, domain, auth), /cannot sign for from=/);
});

test("hashSpendAuth changes when the domain (chainId or verifying contract) changes", () => {
    const auth = makeAuth();
    const a = hashSpendAuth(spendAuthDomain(TEST_CHAIN_ID, TEST_BATCHER), auth);
    const b = hashSpendAuth(spendAuthDomain(TEST_CHAIN_ID + 1, TEST_BATCHER), auth);
    const c = hashSpendAuth(
        spendAuthDomain(TEST_CHAIN_ID, "0x2222222222222222222222222222222222222222"),
        auth,
    );
    assert.notEqual(a, b, "different chainId must change the digest");
    assert.notEqual(a, c, "different verifyingContract must change the digest");
});

test("spendAuthDomain validates inputs", () => {
    assert.throws(() => spendAuthDomain(0, TEST_BATCHER), /chainId/);
    assert.throws(() => spendAuthDomain(-1, TEST_BATCHER), /chainId/);
    assert.throws(() => spendAuthDomain(1.5, TEST_BATCHER), /chainId/);
    assert.throws(
        () => spendAuthDomain(TEST_CHAIN_ID, "0xnope" as `0x${string}`),
        /verifyingContract/,
    );
    assert.throws(
        () => spendAuthDomain(TEST_CHAIN_ID, "0x1111" as `0x${string}`),
        /verifyingContract/,
    );
});

test("hashSpendAuth rejects out-of-range fields", () => {
    const domain = spendAuthDomain(TEST_CHAIN_ID, TEST_BATCHER);
    assert.throws(() => hashSpendAuth(domain, makeAuth({venueId: -1})), /venueId/);
    assert.throws(() => hashSpendAuth(domain, makeAuth({venueId: 0x1_0000_0000})), /venueId/);
    assert.throws(() => hashSpendAuth(domain, makeAuth({category: 256})), /category/);
    assert.throws(() => hashSpendAuth(domain, makeAuth({amount: -1n})), /amount/);
    assert.throws(() => hashSpendAuth(domain, makeAuth({nonce: 1n << 64n})), /nonce/);
    assert.throws(() => hashSpendAuth(domain, makeAuth({deadline: 1n << 64n})), /deadline/);
    assert.throws(() => hashSpendAuth(domain, makeAuth({gameTick: -1n})), /gameTick/);
    assert.throws(
        () => hashSpendAuth(domain, makeAuth({from: "0xnope" as `0x${string}`})),
        /from/,
    );
});

test("uint64 fields can hit the boundary value (2^64 - 1) without throwing", async () => {
    // Sanity: these are inclusive bounds, not strict-less-than. Game-tick rolling over is the
    // realistic case where we'd brush the upper edge.
    const guest = deriveGuest(TEST_MNEMONIC, 0);
    const domain = spendAuthDomain(TEST_CHAIN_ID, TEST_BATCHER);
    const u64Max = (1n << 64n) - 1n;
    const auth = makeAuth({
        from: guest.address,
        nonce: u64Max,
        deadline: u64Max,
        gameTick: u64Max,
    });
    const sig = await signSpendAuth(guest.account, domain, auth);
    assert.equal(
        (await recoverSpendAuthSigner(domain, auth, sig)).toLowerCase(),
        guest.address.toLowerCase(),
    );
});
