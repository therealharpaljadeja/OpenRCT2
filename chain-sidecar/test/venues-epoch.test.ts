import {test} from "node:test";
import assert from "node:assert/strict";
import {
    applyEpoch,
    epochFromChainId,
    formatEpoch,
    gameIdFromChainId,
    generateEpoch,
    MAX_EPOCH,
    MAX_GAME_ID,
} from "../src/venues/epoch.js";

test("applyEpoch composes epoch and gameId into the expected uint32", () => {
    assert.equal(applyEpoch(0, 1), 1);
    assert.equal(applyEpoch(1, 1), 0x00010001);
    assert.equal(applyEpoch(0xabcd, 0x0042), 0xabcd0042);
});

test("applyEpoch handles top-bit-set epochs (>= 0x8000) without sign-flip", () => {
    // The naive `(epoch << 16)` returns a negative int32 for epoch >= 0x8000; the implementation
    // uses multiplication to stay in the safe-integer range.
    const chainId = applyEpoch(0xffff, 0xffff);
    assert.equal(chainId, 0xffffffff);
    assert.ok(chainId > 0, "result should be a non-negative integer");
});

test("applyEpoch round-trips through gameIdFromChainId / epochFromChainId", () => {
    for (const [epoch, gameId] of [
        [0, 0],
        [1, 1],
        [0x1234, 0x5678],
        [0xffff, 0xffff],
    ] as const) {
        const chainId = applyEpoch(epoch, gameId);
        assert.equal(epochFromChainId(chainId), epoch);
        assert.equal(gameIdFromChainId(chainId), gameId);
    }
});

test("applyEpoch rejects out-of-range gameId / epoch", () => {
    assert.throws(() => applyEpoch(-1, 1));
    assert.throws(() => applyEpoch(MAX_EPOCH + 1, 1));
    assert.throws(() => applyEpoch(0, -1));
    assert.throws(() => applyEpoch(0, MAX_GAME_ID + 1));
    assert.throws(() => applyEpoch(0, 1.5));
});

test("generateEpoch returns a uint16", () => {
    for (let i = 0; i < 50; i++) {
        const e = generateEpoch();
        assert.ok(Number.isInteger(e), `epoch should be an integer, got ${e}`);
        assert.ok(e >= 0 && e <= MAX_EPOCH, `epoch out of range: ${e}`);
    }
});

test("formatEpoch produces a 4-digit hex prefix", () => {
    assert.equal(formatEpoch(0), "0x0000");
    assert.equal(formatEpoch(1), "0x0001");
    assert.equal(formatEpoch(0xabcd), "0xabcd");
    assert.equal(formatEpoch(MAX_EPOCH), "0xffff");
});

test("collision: same gameId across different epochs maps to distinct chainIds", () => {
    const a = applyEpoch(0x1111, 2);
    const b = applyEpoch(0x2222, 2);
    assert.notEqual(a, b);
    assert.equal(gameIdFromChainId(a), gameIdFromChainId(b));
    assert.notEqual(epochFromChainId(a), epochFromChainId(b));
});
