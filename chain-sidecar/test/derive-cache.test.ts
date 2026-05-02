import {test} from "node:test";
import assert from "node:assert/strict";
import {deriveGuest} from "../src/derive/index.js";
import {GuestAddressCache} from "../src/derive/cache.js";

const TEST_MNEMONIC = "test test test test test test test test test test test junk";

test("addressOf returns the same address as deriveGuest for the same index", () => {
    const cache = new GuestAddressCache(TEST_MNEMONIC);
    const direct = deriveGuest(TEST_MNEMONIC, 7).address;
    assert.equal(cache.addressOf(7), direct);
});

test("addressOf is stable across repeated lookups (hits the cache)", () => {
    const cache = new GuestAddressCache(TEST_MNEMONIC);
    const first = cache.addressOf(3);
    const second = cache.addressOf(3);
    assert.equal(first, second);
    const stats = cache.stats();
    assert.equal(stats.size, 1);
    assert.equal(stats.hits, 1);
    assert.equal(stats.misses, 1);
});

test("hit/miss counters distinguish first vs subsequent lookups", () => {
    const cache = new GuestAddressCache(TEST_MNEMONIC);
    cache.addressOf(0); // miss
    cache.addressOf(1); // miss
    cache.addressOf(0); // hit
    cache.addressOf(0); // hit
    cache.addressOf(2); // miss
    const s = cache.stats();
    assert.equal(s.misses, 3);
    assert.equal(s.hits, 2);
    assert.equal(s.size, 3);
});

test("peek does not derive or count as a miss", () => {
    const cache = new GuestAddressCache(TEST_MNEMONIC);
    assert.equal(cache.peek(42), undefined);
    assert.equal(cache.has(42), false);
    assert.equal(cache.stats().size, 0);
    assert.equal(cache.stats().misses, 0);
    assert.equal(cache.stats().hits, 0);
});

test("warmup pre-populates a range without later derivation", () => {
    const cache = new GuestAddressCache(TEST_MNEMONIC);
    cache.warmup([0, 1, 2, 3, 4]);
    assert.equal(cache.size(), 5);
    // After warmup, every lookup in [0..4] is a hit.
    cache.addressOf(0);
    cache.addressOf(4);
    const s = cache.stats();
    assert.equal(s.misses, 5, "five misses from the warmup itself");
    assert.equal(s.hits, 2);
});

test("clear resets storage and counters but keeps the cache usable", () => {
    const cache = new GuestAddressCache(TEST_MNEMONIC);
    cache.addressOf(10);
    cache.addressOf(10);
    assert.equal(cache.size(), 1);
    cache.clear();
    assert.equal(cache.size(), 0);
    assert.deepEqual(cache.stats(), {size: 0, hits: 0, misses: 0});
    // Still works after clear — mnemonic is retained.
    const after = cache.addressOf(10);
    assert.equal(after, deriveGuest(TEST_MNEMONIC, 10).address);
});

test("addressOf rejects negative or non-integer indices", () => {
    const cache = new GuestAddressCache(TEST_MNEMONIC);
    assert.throws(() => cache.addressOf(-1), /invalid index/);
    assert.throws(() => cache.addressOf(1.5), /invalid index/);
});

test("constructor rejects empty mnemonic", () => {
    assert.throws(() => new GuestAddressCache(""), /non-empty/);
    // @ts-expect-error - testing runtime guard
    assert.throws(() => new GuestAddressCache(undefined), /non-empty/);
});

test("two caches with the same mnemonic produce identical addresses for the same index", () => {
    const a = new GuestAddressCache(TEST_MNEMONIC);
    const b = new GuestAddressCache(TEST_MNEMONIC);
    for (const i of [0, 1, 17, 999]) {
        assert.equal(a.addressOf(i), b.addressOf(i));
    }
});
