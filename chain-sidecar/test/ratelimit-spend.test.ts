import {test} from "node:test";
import assert from "node:assert/strict";
import {
    DEFAULT_PER_GUEST_AUTH_PER_SEC,
    MAX_PER_GUEST_AUTH_PER_SEC,
    SpendRateLimiter,
} from "../src/ratelimit/index.js";

/// Build a limiter with an injected clock so tests are deterministic.
function makeClock(start = 1_000_000): {now: () => number; advance: (ms: number) => void; set: (ms: number) => void} {
    let t = start;
    return {
        now: () => t,
        advance: (ms) => {
            t += ms;
        },
        set: (ms) => {
            t = ms;
        },
    };
}

test("default is 10/sec/guest (plan §10)", () => {
    assert.equal(DEFAULT_PER_GUEST_AUTH_PER_SEC, 10);
});

test("constructor rejects non-finite / non-positive / above-cap rates", () => {
    assert.throws(() => new SpendRateLimiter({maxAuthPerSecond: 0}), /must be in \(0, 10000\]/);
    assert.throws(() => new SpendRateLimiter({maxAuthPerSecond: -1}), /must be in/);
    assert.throws(() => new SpendRateLimiter({maxAuthPerSecond: Number.NaN}), /must be in/);
    assert.throws(() => new SpendRateLimiter({maxAuthPerSecond: Number.POSITIVE_INFINITY}), /must be in/);
    assert.throws(
        () => new SpendRateLimiter({maxAuthPerSecond: MAX_PER_GUEST_AUTH_PER_SEC + 1}),
        /must be in/,
    );
});

test("first burst up to maxAuthPerSecond passes; next request fails", () => {
    const clock = makeClock();
    const rl = new SpendRateLimiter({maxAuthPerSecond: 10, now: clock.now});
    for (let i = 0; i < 10; i++) {
        assert.equal(rl.consume(7), true, `consume #${i} should pass on a fresh bucket`);
    }
    assert.equal(rl.consume(7), false, "11th consume in the same instant must fail");
    const s = rl.stats();
    assert.equal(s.accepted, 10);
    assert.equal(s.rejected, 1);
    assert.equal(s.guestsTracked, 1);
});

test("bucket refills at the configured rate", () => {
    const clock = makeClock();
    const rl = new SpendRateLimiter({maxAuthPerSecond: 10, now: clock.now});
    for (let i = 0; i < 10; i++) rl.consume(1); // empty bucket
    assert.equal(rl.consume(1), false);
    // 100 ms later: 10/sec × 0.1 = 1 token.
    clock.advance(100);
    assert.equal(rl.consume(1), true);
    assert.equal(rl.consume(1), false, "only one token refilled");
    // Another 1 second: bucket should refill to ceiling (10), not beyond.
    clock.advance(1_000);
    for (let i = 0; i < 10; i++) {
        assert.equal(rl.consume(1), true, `post-refill consume #${i} should pass`);
    }
    assert.equal(rl.consume(1), false, "refill is capped at maxAuthPerSecond");
});

test("buckets are isolated per guest", () => {
    const clock = makeClock();
    const rl = new SpendRateLimiter({maxAuthPerSecond: 3, now: clock.now});
    for (let i = 0; i < 3; i++) assert.equal(rl.consume(1), true);
    assert.equal(rl.consume(1), false);
    // Guest 2 has its own bucket — must not be affected by guest 1's exhaustion.
    for (let i = 0; i < 3; i++) assert.equal(rl.consume(2), true);
    assert.equal(rl.consume(2), false);
    assert.equal(rl.stats().guestsTracked, 2);
});

test("consume() with non-integer / negative hdIndex rejects + counts", () => {
    const rl = new SpendRateLimiter({maxAuthPerSecond: 5});
    assert.equal(rl.consume(-1), false);
    assert.equal(rl.consume(1.5), false);
    // Garbage doesn't allocate a bucket.
    assert.equal(rl.stats().guestsTracked, 0);
    assert.equal(rl.stats().rejected, 2);
    assert.equal(rl.stats().accepted, 0);
});

test("forget() drops the bucket so the map doesn't grow unbounded", () => {
    const clock = makeClock();
    const rl = new SpendRateLimiter({maxAuthPerSecond: 5, now: clock.now});
    rl.consume(1);
    rl.consume(2);
    rl.consume(3);
    assert.equal(rl.stats().guestsTracked, 3);
    rl.forget(2);
    assert.equal(rl.stats().guestsTracked, 2);
    // forget is idempotent.
    rl.forget(2);
    assert.equal(rl.stats().guestsTracked, 2);
    // After forgetting, the next consume re-allocates a fresh full bucket — old usage is gone.
    for (let i = 0; i < 5; i++) assert.equal(rl.consume(2), true);
});

test("updateConfig() applies to future refills, doesn't strand existing tokens", () => {
    const clock = makeClock();
    const rl = new SpendRateLimiter({maxAuthPerSecond: 10, now: clock.now});
    rl.consume(1); // bucket has 9
    rl.updateConfig(5);
    // The existing bucket still has 9 tokens — they were earned under the higher rate. We
    // allow the guest to spend them down rather than confiscating mid-flight.
    for (let i = 0; i < 9; i++) assert.equal(rl.consume(1), true);
    assert.equal(rl.consume(1), false);
    // After a full second the bucket caps at the new ceiling, not the old one.
    clock.advance(10_000);
    for (let i = 0; i < 5; i++) assert.equal(rl.consume(1), true);
    assert.equal(rl.consume(1), false, "ceiling is the new (lower) maxAuthPerSecond");
});

test("updateConfig() rejects out-of-range input", () => {
    const rl = new SpendRateLimiter({maxAuthPerSecond: 10});
    assert.throws(() => rl.updateConfig(0));
    assert.throws(() => rl.updateConfig(-1));
    assert.throws(() => rl.updateConfig(MAX_PER_GUEST_AUTH_PER_SEC + 1));
    assert.throws(() => rl.updateConfig(Number.NaN));
});

test("stats reflects accepted + rejected + guestsTracked accurately", () => {
    const clock = makeClock();
    const rl = new SpendRateLimiter({maxAuthPerSecond: 2, now: clock.now});
    rl.consume(1);
    rl.consume(1);
    rl.consume(1); // reject
    rl.consume(2);
    rl.consume(2);
    rl.consume(2); // reject
    const s = rl.stats();
    assert.equal(s.maxAuthPerSecond, 2);
    assert.equal(s.accepted, 4);
    assert.equal(s.rejected, 2);
    assert.equal(s.guestsTracked, 2);
});

test("clock going backwards does not refill (and does not crash)", () => {
    // Pathological: somebody sets the wall clock backwards. We don't refill on a negative
    // delta — a guest who burned their bucket pre-skew shouldn't suddenly have tokens just
    // because `Date.now()` jumped back.
    const clock = makeClock(1_000_000);
    const rl = new SpendRateLimiter({maxAuthPerSecond: 5, now: clock.now});
    for (let i = 0; i < 5; i++) rl.consume(1);
    assert.equal(rl.consume(1), false);
    clock.set(900_000); // jump back 100 s
    assert.equal(rl.consume(1), false, "no spurious refill on backwards clock");
});

test("a steady-rate stream stays at-or-near the configured throughput", () => {
    // Drive the limiter at exactly the configured rate for 10 seconds. The first second
    // burns the burst (10 acceptances). Each subsequent second's worth of attempts gets
    // exactly the refill rate through. Total acceptances over 10s @ 10 attempts/sec at the
    // configured 10/sec rate is just "everything passes".
    const clock = makeClock();
    const rl = new SpendRateLimiter({maxAuthPerSecond: 10, now: clock.now});
    let accepted = 0;
    for (let s = 0; s < 10; s++) {
        for (let i = 0; i < 10; i++) {
            if (rl.consume(1)) accepted++;
            clock.advance(100); // 10 attempts evenly spread across the second
        }
    }
    // 100 attempts at 10/sec for 10s — every one passes. (Burst absorbs the first 10
    // before any refill; subsequent ones come at the refill rate.)
    assert.equal(accepted, 100);
});

test("a 2× over-rate stream is throttled to the configured rate (steady-state)", () => {
    // Drive at 20 attempts/sec against a 10/sec limit. After the initial burst we should
    // see roughly 1 accept per 100 ms — i.e. ~half the attempts succeed.
    const clock = makeClock();
    const rl = new SpendRateLimiter({maxAuthPerSecond: 10, now: clock.now});
    let accepted = 0;
    let rejected = 0;
    for (let s = 0; s < 5; s++) {
        for (let i = 0; i < 20; i++) {
            if (rl.consume(1)) accepted++;
            else rejected++;
            clock.advance(50);
        }
    }
    // 5 seconds × 20 attempts = 100. At 10/sec the limiter passes ≈ initial 10 burst + 10×5
    // refill = 60. Allow ±2 for fractional-token edge cases.
    assert.ok(accepted >= 58 && accepted <= 62, `expected ~60 accepted, got ${accepted}`);
    assert.equal(accepted + rejected, 100);
});
