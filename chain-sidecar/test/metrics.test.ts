import {test} from "node:test";
import assert from "node:assert/strict";
import {MetricsAggregator} from "../src/metrics/index.js";

/// Injectable clock harness so the tests don't drift on a slow CI box. Returns a `now()`
/// function the aggregator reads + an `advance(ms)` for moving wall clock forward.
function clock(start = 1_000_000_000_000): {now: () => number; advance: (ms: number) => void; set: (t: number) => void} {
    let t = start;
    return {now: () => t, advance: (ms) => (t += ms), set: (next) => (t = next)};
}

test("constructor rejects out-of-range knobs", () => {
    assert.throws(() => new MetricsAggregator({windowMs: 0}), /windowMs/);
    assert.throws(() => new MetricsAggregator({windowMs: 500}), /windowMs/);
    assert.throws(() => new MetricsAggregator({maxLatencySamples: 0}), /maxLatencySamples/);
    assert.throws(() => new MetricsAggregator({maxLatencySamples: 8}), /maxLatencySamples/);
});

test("empty window: snapshot returns null percentiles, zero rates", () => {
    const c = clock();
    const m = new MetricsAggregator({now: c.now});
    const s = m.snapshot();
    assert.equal(s.txPerSecond, 0);
    assert.equal(s.authPerSecond, 0);
    assert.equal(s.txInWindow, 0);
    assert.equal(s.authInWindow, 0);
    assert.equal(s.latencyMs.p50, null, "null, not 0 — distinguishes 'quiet' from 'fast'");
    assert.equal(s.latencyMs.p95, null);
    assert.equal(s.latencyMs.p99, null);
    assert.equal(s.batchFill.avg, null);
    assert.equal(s.batchFill.max, null);
});

test("rate math: tx/s and auth/s computed over windowMs", () => {
    const c = clock();
    const m = new MetricsAggregator({windowMs: 10_000, now: c.now});
    // Submit 5 txs spaced 1s apart, 100 auths each.
    for (let i = 0; i < 5; i++) {
        m.recordTxSuccess(100, 50);
        c.advance(1_000);
    }
    const s = m.snapshot();
    // 5 tx in a 10s window = 0.5 tx/s; 500 auths = 50 auth/s.
    assert.equal(s.txInWindow, 5);
    assert.equal(s.authInWindow, 500);
    assert.equal(s.txPerSecond, 0.5);
    assert.equal(s.authPerSecond, 50);
});

test("window aging: samples older than windowMs are excluded", () => {
    const c = clock();
    const m = new MetricsAggregator({windowMs: 5_000, now: c.now});
    // Three old txs, then advance past the window, then three new.
    for (let i = 0; i < 3; i++) m.recordTxSuccess(10, 100);
    c.advance(10_000);
    for (let i = 0; i < 3; i++) m.recordTxSuccess(20, 200);
    const s = m.snapshot();
    assert.equal(s.txInWindow, 3, "only the recent batch is in the window");
    assert.equal(s.authInWindow, 60, "60 = 3 × 20");
    // Lifetime totals still include everyone.
    assert.equal(s.totalTxSubmitted, 6);
    assert.equal(s.totalAuthSubmitted, 90, "30 (old) + 60 (new) = 90");
});

test("percentiles: nearest-rank, sorted across the window", () => {
    const c = clock();
    const m = new MetricsAggregator({now: c.now});
    // Latencies: 1, 2, 3, ..., 100. p50 = 50, p95 = 95, p99 = 99.
    for (let i = 1; i <= 100; i++) m.recordTxSuccess(1, i);
    const s = m.snapshot();
    assert.equal(s.latencyMs.p50, 50);
    assert.equal(s.latencyMs.p95, 95);
    assert.equal(s.latencyMs.p99, 99);
});

test("percentiles: single sample reflects in all three", () => {
    const c = clock();
    const m = new MetricsAggregator({now: c.now});
    m.recordTxSuccess(1, 42);
    const s = m.snapshot();
    assert.equal(s.latencyMs.p50, 42);
    assert.equal(s.latencyMs.p95, 42);
    assert.equal(s.latencyMs.p99, 42);
});

test("percentiles: out-of-order arrivals don't matter", () => {
    const c = clock();
    const m = new MetricsAggregator({now: c.now});
    const arrivals = [50, 1, 99, 75, 25, 10, 95, 90, 5, 100];
    for (const lat of arrivals) m.recordTxSuccess(1, lat);
    const s = m.snapshot();
    assert.ok(s.latencyMs.p50 !== null && s.latencyMs.p50 >= 25, "p50 lands in the middle");
    assert.ok(s.latencyMs.p95 !== null && s.latencyMs.p95 >= 95, "p95 reflects upper tail");
});

test("batchFill: avg and max over the window", () => {
    const c = clock();
    const m = new MetricsAggregator({now: c.now});
    m.recordTxSuccess(100, 10);
    m.recordTxSuccess(200, 20);
    m.recordTxSuccess(300, 30);
    const s = m.snapshot();
    assert.equal(s.batchFill.avg, 200, "(100+200+300)/3 = 200");
    assert.equal(s.batchFill.max, 300);
});

test("maxLatencySamples cap: oldest dropped on push past cap", () => {
    const c = clock();
    const m = new MetricsAggregator({now: c.now, maxLatencySamples: 16});
    for (let i = 0; i < 100; i++) m.recordTxSuccess(1, i);
    assert.equal(m.sampleCount(), 16, "buffer never exceeds the cap");
    // Lifetime total still accurate.
    assert.equal(m.snapshot().totalTxSubmitted, 100);
});

test("recordTxFailure increments only the failed counter", () => {
    const c = clock();
    const m = new MetricsAggregator({now: c.now});
    m.recordTxSuccess(10, 100);
    m.recordTxFailure();
    m.recordTxFailure();
    const s = m.snapshot();
    assert.equal(s.totalTxSubmitted, 1, "failures don't count as submissions");
    assert.equal(s.totalTxFailed, 2);
    assert.equal(s.txInWindow, 1, "failures stay out of the rate window");
});

test("recordDroppedAuths is cumulative, ignored when negative / non-finite", () => {
    const c = clock();
    const m = new MetricsAggregator({now: c.now});
    m.recordDroppedAuths(5);
    m.recordDroppedAuths(10);
    m.recordDroppedAuths(-3); // ignored
    m.recordDroppedAuths(NaN); // ignored
    const s = m.snapshot();
    assert.equal(s.totalDroppedAuths, 15);
});

test("non-finite / negative inputs to recordTxSuccess are ignored, not crashed on", () => {
    const c = clock();
    const m = new MetricsAggregator({now: c.now});
    m.recordTxSuccess(-1, 100);
    m.recordTxSuccess(10, -1);
    m.recordTxSuccess(NaN, 100);
    m.recordTxSuccess(10, NaN);
    m.recordTxSuccess(Infinity, 100);
    const s = m.snapshot();
    assert.equal(s.totalTxSubmitted, 0);
    assert.equal(s.txInWindow, 0);
    assert.equal(s.latencyMs.p50, null);
});

test("snapshot.now reflects injected clock; windowMs surfaces", () => {
    const c = clock(1_700_000_000_000);
    const m = new MetricsAggregator({windowMs: 30_000, now: c.now});
    const s = m.snapshot();
    assert.equal(s.now, 1_700_000_000_000);
    assert.equal(s.windowMs, 30_000);
});

test("snapshot is non-mutating: subsequent snapshots match if no new events", () => {
    const c = clock();
    const m = new MetricsAggregator({now: c.now});
    for (let i = 0; i < 10; i++) m.recordTxSuccess(50, 75);
    const a = m.snapshot();
    const b = m.snapshot();
    assert.deepEqual(a, b, "snapshot doesn't mutate the buffer");
});

test("rolling window: continuous trickle holds steady rate", () => {
    const c = clock();
    const m = new MetricsAggregator({windowMs: 10_000, now: c.now});
    // Steady 10 tx/s for 30s — expect ~10 tx/s once the window fills.
    for (let i = 0; i < 300; i++) {
        m.recordTxSuccess(50, 100);
        c.advance(100); // 100ms gap = 10 tx/s
    }
    const s = m.snapshot();
    // At steady state with a 10s window, we'd expect ~100 samples (10 tx/s × 10s).
    assert.ok(s.txInWindow >= 95 && s.txInWindow <= 100, `expected ~100 in window, got ${s.txInWindow}`);
    assert.ok(s.txPerSecond >= 9.5 && s.txPerSecond <= 10, `expected ~10 tx/s, got ${s.txPerSecond}`);
});

test("burst then quiet: rate drops as window ages out", () => {
    const c = clock();
    const m = new MetricsAggregator({windowMs: 10_000, now: c.now});
    for (let i = 0; i < 50; i++) m.recordTxSuccess(100, 200);
    const a = m.snapshot();
    assert.equal(a.txInWindow, 50);
    // Advance past the window — everything should age out.
    c.advance(20_000);
    const b = m.snapshot();
    assert.equal(b.txInWindow, 0);
    assert.equal(b.txPerSecond, 0);
    assert.equal(b.totalTxSubmitted, 50, "lifetime total preserved");
});
