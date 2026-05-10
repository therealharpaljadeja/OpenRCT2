import {test} from "node:test";
import assert from "node:assert/strict";
import {
    MAX_SESSION_ID,
    SessionContext,
    formatSessionId,
    generateSessionId,
    validateSessionId,
} from "../src/session/index.js";

test("validateSessionId accepts the full uint16 range and rejects out-of-range / non-integer", () => {
    assert.equal(validateSessionId(0), 0);
    assert.equal(validateSessionId(1), 1);
    assert.equal(validateSessionId(MAX_SESSION_ID), MAX_SESSION_ID);
    assert.throws(() => validateSessionId(-1), /out of \[0, 65535\]/);
    assert.throws(() => validateSessionId(MAX_SESSION_ID + 1), /out of \[0, 65535\]/);
    assert.throws(() => validateSessionId(1.5), /out of \[0, 65535\]/);
    assert.throws(() => validateSessionId(NaN), /out of \[0, 65535\]/);
});

test("generateSessionId returns a uint16", () => {
    for (let i = 0; i < 100; i++) {
        const id = generateSessionId();
        assert.ok(Number.isInteger(id) && id >= 0 && id <= MAX_SESSION_ID, `bad id ${id}`);
    }
});

test("formatSessionId pads to 4 hex digits", () => {
    assert.equal(formatSessionId(0), "0x0000");
    assert.equal(formatSessionId(1), "0x0001");
    assert.equal(formatSessionId(0xabcd), "0xabcd");
    assert.equal(formatSessionId(MAX_SESSION_ID), "0xffff");
});

test("SessionContext exposes the same value as sessionId and epoch (16-bit width)", () => {
    const s = new SessionContext(0xabcd);
    assert.equal(s.sessionId, 0xabcd);
    assert.equal(s.epoch, 0xabcd);
});

test("SessionContext rejects out-of-range initial id", () => {
    assert.throws(() => new SessionContext(-1), /out of \[0, 65535\]/);
    assert.throws(() => new SessionContext(MAX_SESSION_ID + 1), /out of \[0, 65535\]/);
});

test("change() returns false on no-op (same id) and skips subscribers", () => {
    const s = new SessionContext(7);
    let calls = 0;
    s.onChange(() => calls++);
    assert.equal(s.change(7), false);
    assert.equal(calls, 0);
});

test("change() fires subscribers in registration order with prev/next", () => {
    const s = new SessionContext(1);
    const seen: Array<[string, number, number]> = [];
    s.onChange((p, n) => seen.push(["a", p, n]));
    s.onChange((p, n) => seen.push(["b", p, n]));
    assert.equal(s.change(2), true);
    assert.deepEqual(seen, [["a", 1, 2], ["b", 1, 2]]);
});

test("change() rejects out-of-range id without mutating state or firing subscribers", () => {
    const s = new SessionContext(1);
    let calls = 0;
    s.onChange(() => calls++);
    assert.throws(() => s.change(MAX_SESSION_ID + 1), /out of \[0, 65535\]/);
    assert.equal(s.sessionId, 1);
    assert.equal(calls, 0);
});

test("change() propagates a thrown subscriber so the IPC layer can fail loudly", () => {
    const s = new SessionContext(1);
    s.onChange(() => {
        throw new Error("boom");
    });
    assert.throws(() => s.change(2), /boom/);
});
