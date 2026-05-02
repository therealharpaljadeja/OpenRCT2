import {test} from "node:test";
import assert from "node:assert/strict";
import {
    DEFAULT_RELAYER_COUNT,
    MAX_RELAYER_COUNT,
    deriveGuest,
    deriveRelayer,
    relayerPool,
} from "../src/derive/index.js";

/// `test test test ... junk` is the canonical Hardhat / Foundry / Anvil mnemonic. Pinning to
/// it lets the addresses below double as cross-tool sanity vectors — anyone running
/// `cast wallet derive --mnemonic "..."` against the same path will get the same address.
const TEST_MNEMONIC = "test test test test test test test test test test test junk";

test("guest 0 matches the well-known Hardhat default address", () => {
    const g = deriveGuest(TEST_MNEMONIC, 0);
    // Hardhat's account #0 derived at m/44'/60'/0'/0/0 from this mnemonic.
    assert.equal(g.address, "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266");
    assert.equal(g.path, "m/44'/60'/0'/0/0");
});

test("guest derivation is deterministic and produces unique addresses across indices", () => {
    const a1 = deriveGuest(TEST_MNEMONIC, 0);
    const a2 = deriveGuest(TEST_MNEMONIC, 0);
    const b = deriveGuest(TEST_MNEMONIC, 1);
    assert.equal(a1.address, a2.address, "same index → same address");
    assert.notEqual(a1.address, b.address, "different index → different address");
});

test("relayer change-index 1 puts the address on a separate branch from guest", () => {
    const g0 = deriveGuest(TEST_MNEMONIC, 0);
    const r0 = deriveRelayer(TEST_MNEMONIC, 0);
    assert.notEqual(g0.address, r0.address);
    assert.equal(r0.path, "m/44'/60'/0'/1/0");
});

test("relayerPool yields N distinct accounts at indices 0..N-1", () => {
    const pool = relayerPool(TEST_MNEMONIC, DEFAULT_RELAYER_COUNT);
    assert.equal(pool.length, DEFAULT_RELAYER_COUNT);
    const seen = new Set<string>();
    for (let i = 0; i < pool.length; i++) {
        const r = pool[i]!;
        assert.equal(r.path, `m/44'/60'/0'/1/${i}`);
        assert.match(r.address, /^0x[0-9a-fA-F]{40}$/);
        assert.ok(!seen.has(r.address), `relayer ${i} address collides: ${r.address}`);
        seen.add(r.address);
    }
});

test("relayerPool rejects non-integer / out-of-range counts", () => {
    assert.throws(() => relayerPool(TEST_MNEMONIC, 0), /\[1, 32\]/);
    assert.throws(() => relayerPool(TEST_MNEMONIC, MAX_RELAYER_COUNT + 1), /\[1, 32\]/);
    assert.throws(() => relayerPool(TEST_MNEMONIC, 1.5), /\[1, 32\]/);
});

test("deriveGuest rejects negative index", () => {
    assert.throws(() => deriveGuest(TEST_MNEMONIC, -1), /invalid guest index/);
    assert.throws(() => deriveGuest(TEST_MNEMONIC, 0.5), /invalid guest index/);
});
