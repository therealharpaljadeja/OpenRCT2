import {test} from "node:test";
import assert from "node:assert/strict";
import {encodeAbiParameters, keccak256, concat, toHex, type Hex} from "viem";
import {deriveGuest} from "../src/derive/index.js";
import {
    PARK_PERMIT_DOMAIN_NAME,
    PARK_PERMIT_DOMAIN_VERSION,
    permitDomain,
    hashPermit,
    signPermit,
    recoverPermitSigner,
    type PermitArgs,
} from "../src/permits/index.js";

const TEST_MNEMONIC = "test test test test test test test test test test test junk";
const TEST_PARK_TOKEN: `0x${string}` = "0x2222222222222222222222222222222222222222";
const TEST_BATCHER: `0x${string}` = "0x3333333333333333333333333333333333333333";
const TEST_CHAIN_ID = 10143;

function makeArgs(overrides: Partial<PermitArgs> = {}): PermitArgs {
    const guest = deriveGuest(TEST_MNEMONIC, 0);
    return {
        owner: guest.address,
        spender: TEST_BATCHER,
        value: (1n << 256n) - 1n,
        nonce: 0n,
        deadline: 1_900_000_000n,
        ...overrides,
    };
}

/// Reconstruct the EIP-712 digest from first principles. If `hashPermit` ever drifts from the
/// contract — wrong field order, wrong type string, wrong domain name — this catches it
/// without needing live RPC. Mirrors `ERC20Permit._hashTypedDataV4` byte-for-byte.
function manualPermitDigest(args: PermitArgs): Hex {
    const PERMIT_TYPEHASH = keccak256(
        toHex("Permit(address owner,address spender,uint256 value,uint256 nonce,uint256 deadline)"),
    );
    const structHash = keccak256(
        encodeAbiParameters(
            [
                {type: "bytes32"},
                {type: "address"},
                {type: "address"},
                {type: "uint256"},
                {type: "uint256"},
                {type: "uint256"},
            ],
            [PERMIT_TYPEHASH, args.owner, args.spender, args.value, args.nonce, args.deadline],
        ),
    );
    const EIP712_DOMAIN_TYPEHASH = keccak256(
        toHex("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
    );
    const domainSep = keccak256(
        encodeAbiParameters(
            [
                {type: "bytes32"},
                {type: "bytes32"},
                {type: "bytes32"},
                {type: "uint256"},
                {type: "address"},
            ],
            [
                EIP712_DOMAIN_TYPEHASH,
                keccak256(toHex(PARK_PERMIT_DOMAIN_NAME)),
                keccak256(toHex(PARK_PERMIT_DOMAIN_VERSION)),
                BigInt(TEST_CHAIN_ID),
                TEST_PARK_TOKEN,
            ],
        ),
    );
    return keccak256(concat(["0x1901", domainSep, structHash]));
}

test("hashPermit matches a hand-rolled keccak digest (catches ABI/domain drift)", () => {
    const domain = permitDomain(TEST_CHAIN_ID, TEST_PARK_TOKEN);
    const args = makeArgs();
    assert.equal(hashPermit(domain, args), manualPermitDigest(args));
});

test("hashPermit changes when any field flips", () => {
    const domain = permitDomain(TEST_CHAIN_ID, TEST_PARK_TOKEN);
    const base = makeArgs();
    const baseHash = hashPermit(domain, base);
    for (const variant of [
        makeArgs({value: base.value - 1n}),
        makeArgs({nonce: 1n}),
        makeArgs({deadline: base.deadline + 1n}),
        makeArgs({spender: "0x4444444444444444444444444444444444444444"}),
    ]) {
        assert.notEqual(hashPermit(domain, variant), baseHash);
    }
    // Domain (chainId / verifyingContract) also participates.
    assert.notEqual(hashPermit(permitDomain(2, TEST_PARK_TOKEN), base), baseHash);
    assert.notEqual(
        hashPermit(permitDomain(TEST_CHAIN_ID, "0x4444444444444444444444444444444444444444"), base),
        baseHash,
    );
});

test("signPermit produces a recoverable v/r/s split", async () => {
    const domain = permitDomain(TEST_CHAIN_ID, TEST_PARK_TOKEN);
    const guest = deriveGuest(TEST_MNEMONIC, 0);
    const args = makeArgs();
    const signed = await signPermit(guest.account, domain, args);
    // v in {27, 28} for legacy permit (split via parseSignature).
    assert.ok(signed.v === 27 || signed.v === 28, `expected legacy v in {27,28}, got ${signed.v}`);
    assert.match(signed.r, /^0x[0-9a-f]{64}$/);
    assert.match(signed.s, /^0x[0-9a-f]{64}$/);
    // Original 65-byte sig recovers to the signer.
    const recovered = await recoverPermitSigner(domain, args, signed.signature);
    assert.equal(recovered.toLowerCase(), guest.address.toLowerCase());
});

test("signPermit rejects when account != args.owner", async () => {
    const domain = permitDomain(TEST_CHAIN_ID, TEST_PARK_TOKEN);
    const guest0 = deriveGuest(TEST_MNEMONIC, 0);
    const guest1 = deriveGuest(TEST_MNEMONIC, 1);
    const args = makeArgs({owner: guest1.address});
    await assert.rejects(() => signPermit(guest0.account, domain, args), /cannot sign for owner/);
});

test("signPermit rejects out-of-range fields", async () => {
    const domain = permitDomain(TEST_CHAIN_ID, TEST_PARK_TOKEN);
    const guest = deriveGuest(TEST_MNEMONIC, 0);
    const u256Max = (1n << 256n) - 1n;
    await assert.rejects(
        () => signPermit(guest.account, domain, makeArgs({value: u256Max + 1n})),
        /out of uint256 range/,
    );
    await assert.rejects(
        () => signPermit(guest.account, domain, makeArgs({nonce: -1n})),
        /out of uint256 range/,
    );
});

test("permitDomain rejects non-positive chainIds + bad addresses", () => {
    assert.throws(() => permitDomain(0, TEST_PARK_TOKEN), /positive integer/);
    assert.throws(() => permitDomain(TEST_CHAIN_ID, "0xnope" as `0x${string}`), /20-byte hex/);
});

test("two distinct guests produce distinct sigs over the same args (cross-guest isolation)", async () => {
    const domain = permitDomain(TEST_CHAIN_ID, TEST_PARK_TOKEN);
    const g0 = deriveGuest(TEST_MNEMONIC, 0);
    const g1 = deriveGuest(TEST_MNEMONIC, 1);
    const a = await signPermit(g0.account, domain, makeArgs({owner: g0.address}));
    const b = await signPermit(g1.account, domain, makeArgs({owner: g1.address}));
    assert.notEqual(a.signature, b.signature);
});
