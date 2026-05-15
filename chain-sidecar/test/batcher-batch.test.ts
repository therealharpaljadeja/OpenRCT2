import {test} from "node:test";
import assert from "node:assert/strict";
import type {Hex} from "viem";
import {
    Batcher,
    DEFAULT_BATCH_MAX_SIZE,
    DEFAULT_BATCH_MAX_AGE_MS,
    type Batch,
    type SignedAuth,
    type SinkResult,
} from "../src/batcher/batch.js";
import type {SpendAuth} from "../src/batcher/sign.js";

/// Minimal `SignedAuth` factory — these tests don't exercise sign/verify (that's
/// `batcher-sign.test.ts`); they only care that the queue moves the right tuples around.
/// The address space is arbitrary but stable across this file.
function makeItem(i: number): SignedAuth {
    const auth: SpendAuth = {
        from: ("0x" + (i + 1).toString(16).padStart(40, "0")) as `0x${string}`,
        venueId: i % 100,
        category: 1,
        amount: BigInt(1000 + i),
        nonce: 0n,
        deadline: 1_900_000_000n,
        gameTick: BigInt(i),
    };
    const signature = ("0x" + i.toString(16).padStart(130, "0")) as Hex;
    return {auth, signature};
}

/// Programmable fake clock + timer scheduler. The real-timer surface (`Date.now` +
/// `setTimeout`) is opaque inside `node --test`, and any `await sleep(N)` is flaky on busy
/// CI. Injecting these means age-flush behaviour is *exactly* reproducible.
class FakeTime {
    #now = 0;
    /// Pending timers, sorted by absolute fire time. Keep them as objects (rather than the
    /// host timer API) so `unref()` is a no-op and so we can drain deterministically.
    readonly #timers: Array<{at: number; cb: () => void; cancelled: boolean; unref: () => void}> = [];

    now = (): number => this.#now;

    setTimeout = ((cb: () => void, ms?: number) => {
        const t = {at: this.#now + (ms ?? 0), cb, cancelled: false, unref: () => {}};
        this.#timers.push(t);
        this.#timers.sort((a, b) => a.at - b.at);
        return t as unknown as ReturnType<typeof setTimeout>;
    }) as unknown as typeof setTimeout;

    clearTimeout = ((handle: ReturnType<typeof setTimeout> | undefined) => {
        if (!handle) return;
        const t = handle as unknown as {cancelled: boolean};
        t.cancelled = true;
    }) as unknown as typeof clearTimeout;

    /// Move time forward by `ms`, firing any timers that come due. Fires in order.
    advance(ms: number): void {
        const target = this.#now + ms;
        while (this.#timers.length > 0 && this.#timers[0]!.at <= target) {
            const t = this.#timers.shift()!;
            this.#now = t.at;
            if (!t.cancelled) t.cb();
        }
        this.#now = target;
    }
}

/// Sink stub that records every batch it receives. Default success; can be configured to
/// throw to exercise the error path.
function recordingSink(): {
    sink: (batch: Batch) => Promise<SinkResult>;
    received: Batch[];
    failNext: (err: Error) => void;
    resolveOldest: () => void;
    pending: number;
} {
    const received: Batch[] = [];
    let failures: Error[] = [];
    /// Sink calls park here when the test wants to assert on `inFlightBatches`. Each entry
    /// is a `resolve` for one outstanding promise.
    const parked: Array<() => void> = [];
    let parkNext = false;

    const api = {
        received,
        failNext: (err: Error) => failures.push(err),
        resolveOldest: () => {
            const r = parked.shift();
            if (r) r();
        },
        get pending() {
            return parked.length;
        },
        sink: async (batch: Batch): Promise<SinkResult> => {
            if (failures.length > 0) {
                const err = failures.shift()!;
                throw err;
            }
            received.push(batch);
            if (parkNext) {
                await new Promise<void>((resolve) => parked.push(resolve));
            }
            return {};
        },
        parkNextN: (n: number) => {
            parkNext = true;
            // After n parks the rest run-through. We do this via a counter override.
            let left = n;
            const orig = api.sink;
            api.sink = async (batch: Batch) => {
                if (left-- > 0) {
                    return orig(batch);
                }
                received.push(batch);
                return {};
            };
        },
    };
    return api;
}

test("flushes when active batch reaches maxSize", async () => {
    const sink = recordingSink();
    const time = new FakeTime();
    const b = new Batcher({
        sink: sink.sink,
        maxSize: 4,
        maxAgeMs: 1000,
        now: time.now,
        setTimeout: time.setTimeout,
        clearTimeout: time.clearTimeout,
    });

    for (let i = 0; i < 4; i++) b.accept(makeItem(i));
    // Flush is fire-and-forget; flush itself happened synchronously, but the sink awaits a
    // microtask. One tick is enough to settle a synchronous-success sink.
    await new Promise((r) => setImmediate(r));

    assert.equal(sink.received.length, 1);
    assert.equal(sink.received[0]!.auths.length, 4);
    assert.equal(sink.received[0]!.reason, "size");
    assert.equal(b.stats().queueDepth, 0);
    assert.equal(b.stats().flushReasonCounts.size, 1);
});

test("flushes when oldest item ages past maxAgeMs", async () => {
    const sink = recordingSink();
    const time = new FakeTime();
    const b = new Batcher({
        sink: sink.sink,
        maxSize: 100,
        maxAgeMs: 200,
        now: time.now,
        setTimeout: time.setTimeout,
        clearTimeout: time.clearTimeout,
    });

    b.accept(makeItem(0));
    time.advance(150); // not yet
    b.accept(makeItem(1)); // newer item; timer is anchored to item 0
    time.advance(60); // total elapsed 210ms since item 0
    await new Promise((r) => setImmediate(r));

    assert.equal(sink.received.length, 1);
    assert.equal(sink.received[0]!.auths.length, 2);
    assert.equal(sink.received[0]!.reason, "age");
    assert.equal(b.stats().flushReasonCounts.age, 1);
});

test("age timer is reset after a flush — second batch ages from its own first item", async () => {
    const sink = recordingSink();
    const time = new FakeTime();
    const b = new Batcher({
        sink: sink.sink,
        maxSize: 100,
        maxAgeMs: 100,
        now: time.now,
        setTimeout: time.setTimeout,
        clearTimeout: time.clearTimeout,
    });

    b.accept(makeItem(0));
    time.advance(100);
    await new Promise((r) => setImmediate(r));
    assert.equal(sink.received.length, 1);

    b.accept(makeItem(1));
    time.advance(50); // not yet — would have flushed if the timer had carried over
    assert.equal(sink.received.length, 1);
    time.advance(50);
    await new Promise((r) => setImmediate(r));
    assert.equal(sink.received.length, 2);
});

test("manual flush works and is no-op on empty queue", async () => {
    const sink = recordingSink();
    const time = new FakeTime();
    const b = new Batcher({
        sink: sink.sink,
        maxSize: 100,
        maxAgeMs: 1000,
        now: time.now,
        setTimeout: time.setTimeout,
        clearTimeout: time.clearTimeout,
    });

    b.flush(); // empty — no-op
    assert.equal(sink.received.length, 0);

    b.accept(makeItem(0));
    b.accept(makeItem(1));
    b.flush();
    await new Promise((r) => setImmediate(r));
    assert.equal(sink.received.length, 1);
    assert.equal(sink.received[0]!.reason, "manual");
});

test("stop() drains pending items as one final batch and awaits the sink", async () => {
    const sink = recordingSink();
    const time = new FakeTime();
    const b = new Batcher({
        sink: sink.sink,
        maxSize: 100,
        maxAgeMs: 1000,
        now: time.now,
        setTimeout: time.setTimeout,
        clearTimeout: time.clearTimeout,
    });
    b.accept(makeItem(0));
    b.accept(makeItem(1));
    b.accept(makeItem(2));

    await b.stop();
    assert.equal(sink.received.length, 1);
    assert.equal(sink.received[0]!.reason, "stop");
    // Late accepts after stop are dropped, not queued.
    b.accept(makeItem(3));
    assert.equal(b.stats().droppedAuths, 1);
    assert.equal(b.stats().queueDepth, 0);
});

test("stop() without buffered items is a clean no-op (no extra batch)", async () => {
    const sink = recordingSink();
    const b = new Batcher({sink: sink.sink, maxSize: 4, maxAgeMs: 100});
    await b.stop();
    assert.equal(sink.received.length, 0);
});

test("backpressure: oldest items are dropped when queue exceeds maxQueuedAuths", () => {
    const sink = recordingSink();
    const time = new FakeTime();
    // Don't let size-flush fire; we want to accumulate past the cap.
    const b = new Batcher({
        sink: sink.sink,
        maxSize: 1000,
        maxAgeMs: 60_000,
        maxQueuedAuths: 5,
        now: time.now,
        setTimeout: time.setTimeout,
        clearTimeout: time.clearTimeout,
    });
    for (let i = 0; i < 8; i++) b.accept(makeItem(i));
    const stats = b.stats();
    assert.equal(stats.queueDepth, 5);
    assert.equal(stats.droppedAuths, 3);
    // Verify FIFO eviction: the first 3 (gameTick 0..2) are gone; we kept 3..7.
    b.flush();
    // Flush is sync-enqueue; one immediate microtask lets the sink run.
    return new Promise<void>((resolve) => {
        setImmediate(() => {
            assert.equal(sink.received.length, 1);
            const ticks = sink.received[0]!.auths.map((a) => Number(a.gameTick));
            assert.deepEqual(ticks, [3, 4, 5, 6, 7]);
            resolve();
        });
    });
});

test("sink errors are counted and don't poison the buffer", async () => {
    const sink = recordingSink();
    const time = new FakeTime();
    const b = new Batcher({
        sink: sink.sink,
        maxSize: 2,
        maxAgeMs: 1000,
        now: time.now,
        setTimeout: time.setTimeout,
        clearTimeout: time.clearTimeout,
    });
    sink.failNext(new Error("boom"));
    b.accept(makeItem(0));
    b.accept(makeItem(1)); // triggers size flush; sink rejects
    await new Promise((r) => setImmediate(r));
    // Allow the rejected promise to settle.
    await new Promise((r) => setImmediate(r));
    assert.equal(b.stats().sinkErrors, 1);
    // Buffer remains clean — failed batch was already removed before sink ran.
    assert.equal(b.stats().queueDepth, 0);

    // Next batch should succeed.
    b.accept(makeItem(2));
    b.accept(makeItem(3));
    await new Promise((r) => setImmediate(r));
    assert.equal(sink.received.length, 1);
});

test("auths and sigs arrive at the sink in 1:1 acceptance order", async () => {
    const sink = recordingSink();
    const time = new FakeTime();
    const b = new Batcher({
        sink: sink.sink,
        maxSize: 5,
        maxAgeMs: 1000,
        now: time.now,
        setTimeout: time.setTimeout,
        clearTimeout: time.clearTimeout,
    });
    for (let i = 0; i < 5; i++) b.accept(makeItem(i));
    await new Promise((r) => setImmediate(r));
    const batch = sink.received[0]!;
    assert.equal(batch.auths.length, 5);
    assert.equal(batch.sigs.length, 5);
    for (let i = 0; i < 5; i++) {
        assert.equal(batch.auths[i]!.gameTick, BigInt(i));
        assert.equal(batch.sigs[i], makeItem(i).signature);
    }
});

test("updateConfig: shrinking maxSize below the buffer triggers an immediate size-flush", async () => {
    const sink = recordingSink();
    const time = new FakeTime();
    const b = new Batcher({
        sink: sink.sink,
        maxSize: 100,
        maxAgeMs: 60_000,
        now: time.now,
        setTimeout: time.setTimeout,
        clearTimeout: time.clearTimeout,
    });
    for (let i = 0; i < 10; i++) b.accept(makeItem(i));
    assert.equal(b.stats().queueDepth, 10);
    b.updateConfig({maxSize: 4});
    await new Promise((r) => setImmediate(r));
    assert.equal(sink.received.length, 1);
    assert.equal(sink.received[0]!.auths.length, 10);
    assert.equal(sink.received[0]!.reason, "size");
});

test("updateConfig validates inputs", () => {
    const sink = recordingSink();
    const b = new Batcher({sink: sink.sink, maxSize: 4, maxAgeMs: 100});
    assert.throws(() => b.updateConfig({maxSize: 0}), /maxSize/);
    assert.throws(() => b.updateConfig({maxSize: 1.5}), /maxSize/);
    assert.throws(() => b.updateConfig({maxAgeMs: 0}), /maxAgeMs/);
    assert.throws(() => b.updateConfig({maxAgeMs: 60_001}), /maxAgeMs/);
    assert.throws(() => b.updateConfig({maxQueuedAuths: 0}), /maxQueuedAuths/);
    assert.throws(() => b.updateConfig({maxQueuedAuths: 1.5}), /maxQueuedAuths/);
    assert.throws(() => b.updateConfig({maxQueuedAuths: 1_000_001}), /maxQueuedAuths/);
});

test("constructor validates inputs and rejects nonsense defaults", () => {
    const sink = recordingSink();
    assert.throws(() => new Batcher({sink: sink.sink, maxSize: 0}), /maxSize/);
    assert.throws(() => new Batcher({sink: sink.sink, maxSize: 2000}), /maxSize/);
    assert.throws(() => new Batcher({sink: sink.sink, maxAgeMs: 0}), /maxAgeMs/);
    assert.throws(
        () => new Batcher({sink: sink.sink, maxQueuedAuths: 0}),
        /maxQueuedAuths/,
    );
});

test("stats track running counters: accepted, flushed, flushedAuths, dropped, avgFill", async () => {
    const sink = recordingSink();
    const time = new FakeTime();
    const b = new Batcher({
        sink: sink.sink,
        maxSize: 3,
        maxAgeMs: 60_000,
        now: time.now,
        setTimeout: time.setTimeout,
        clearTimeout: time.clearTimeout,
    });
    // Three full batches → 9 accepted, 3 flushed, avg fill = 3.
    for (let i = 0; i < 9; i++) b.accept(makeItem(i));
    await new Promise((r) => setImmediate(r));
    const s = b.stats();
    assert.equal(s.accepted, 9);
    assert.equal(s.flushed, 3);
    assert.equal(s.flushedAuths, 9);
    assert.equal(s.droppedAuths, 0);
    assert.equal(s.avgBatchFill, 3);
    assert.equal(s.flushReasonCounts.size, 3);
});

test("default config matches plan §4.2 (256 / 200 / 50_000)", () => {
    assert.equal(DEFAULT_BATCH_MAX_SIZE, 256);
    assert.equal(DEFAULT_BATCH_MAX_AGE_MS, 200);
    const sink = recordingSink();
    const b = new Batcher({sink: sink.sink});
    const s = b.stats();
    assert.equal(s.maxSize, 256);
    assert.equal(s.maxAgeMs, 200);
    assert.equal(s.maxQueuedAuths, 50_000);
});

test("lastFlushLatencyMs reflects queueing time of the most recent batch", async () => {
    const sink = recordingSink();
    const time = new FakeTime();
    const b = new Batcher({
        sink: sink.sink,
        maxSize: 100,
        maxAgeMs: 200,
        now: time.now,
        setTimeout: time.setTimeout,
        clearTimeout: time.clearTimeout,
    });
    b.accept(makeItem(0));
    time.advance(80);
    b.accept(makeItem(1));
    time.advance(120); // total 200ms → age flush
    await new Promise((r) => setImmediate(r));
    // Oldest item entered at t=0; flushed at t=200.
    assert.equal(b.stats().lastFlushLatencyMs, 200);
});

test("batch ids are monotonic across flushes", async () => {
    const sink = recordingSink();
    const time = new FakeTime();
    const b = new Batcher({
        sink: sink.sink,
        maxSize: 1,
        maxAgeMs: 60_000,
        now: time.now,
        setTimeout: time.setTimeout,
        clearTimeout: time.clearTimeout,
    });
    for (let i = 0; i < 5; i++) b.accept(makeItem(i));
    await new Promise((r) => setImmediate(r));
    const ids = sink.received.map((b) => b.id);
    assert.deepEqual(ids, [1, 2, 3, 4, 5]);
});

test("inFlightBatches grows while a sink call is parked and stop() awaits them", async () => {
    const sink = recordingSink();
    const time = new FakeTime();
    // Sink that resolves only when the test pulls the lever.
    let releaseSecond!: () => void;
    const sinkFn = async (batch: Batch): Promise<SinkResult> => {
        sink.received.push(batch);
        if (batch.id === 1) {
            await new Promise<void>((r) => (releaseSecond = r));
        }
        return {};
    };
    const b = new Batcher({
        sink: sinkFn,
        maxSize: 2,
        maxAgeMs: 60_000,
        now: time.now,
        setTimeout: time.setTimeout,
        clearTimeout: time.clearTimeout,
    });
    b.accept(makeItem(0));
    b.accept(makeItem(1)); // size flush; sink parks
    await new Promise((r) => setImmediate(r));
    assert.equal(b.stats().inFlightBatches, 1);

    // stop() flushes nothing new but must wait for the parked sink to resolve before returning.
    let stopped = false;
    const stopP = b.stop().then(() => {
        stopped = true;
    });
    await new Promise((r) => setImmediate(r));
    assert.equal(stopped, false, "stop() must not resolve while a sink is in flight");
    releaseSecond();
    await stopP;
    assert.equal(stopped, true);
    assert.equal(b.stats().inFlightBatches, 0);
});
