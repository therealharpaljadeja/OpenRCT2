import {test} from "node:test";
import assert from "node:assert/strict";
import {mkdtempSync, readFileSync, rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {createServer, type Server} from "node:net";
import {OutboxWriter} from "../src/outbox/wal.js";
import {parseEvent} from "../src/outbox/types.js";
import {StressGenerator} from "../src/stress/generator.js";

/// Stress harness (M3.11). Tests assert the harness produces valid outbox events at the
/// requested rate without manhandling the rate budget. We deliberately don't test against
/// chain — the harness's contract is "write correct WAL events at rate R" and nothing more.

function tmpWal(): {path: string; cleanup: () => void} {
    const dir = mkdtempSync(join(tmpdir(), "rct2-stress-test-"));
    const path = join(dir, "stress.wal");
    return {path, cleanup: () => rmSync(dir, {recursive: true, force: true})};
}

function readEvents(path: string): unknown[] {
    const raw = readFileSync(path, "utf8");
    if (raw.length === 0) return [];
    return raw
        .split("\n")
        .filter((l) => l.length > 0)
        .map((l) => {
            const r = parseEvent(l);
            if (!r.ok) throw new Error(`failed to parse: ${l} (${r.error})`);
            return r.event;
        });
}

test("rejects out-of-range constructor args", () => {
    const {path, cleanup} = tmpWal();
    const writer = new OutboxWriter(path);
    try {
        assert.throws(() => new StressGenerator({writer, guests: 0, venues: 1, rate: 1, durationSeconds: 0}));
        assert.throws(() => new StressGenerator({writer, guests: 1, venues: 0, rate: 1, durationSeconds: 0}));
        assert.throws(() => new StressGenerator({writer, guests: 1, venues: 1, rate: 0, durationSeconds: 0}));
        assert.throws(() => new StressGenerator({writer, guests: 1, venues: 1, rate: -1, durationSeconds: 0}));
        assert.throws(
            () => new StressGenerator({writer, guests: 1, venues: 1, rate: 1, durationSeconds: -1}),
        );
    } finally {
        cleanup();
    }
});

test("bootstrap emits one VENUE_REGISTERED per venue id and one GUEST_ENTRY per guest", async () => {
    const {path, cleanup} = tmpWal();
    const writer = new OutboxWriter(path);
    await writer.open();
    try {
        const gen = new StressGenerator({
            writer,
            guests: 5,
            venues: 3,
            rate: 100,
            durationSeconds: 0.05, // ~5 ticks at 10ms — small spend trail for parser sanity
        });
        const stats = await gen.run();
        await writer.close();
        const events = readEvents(path);
        const venues = events.filter((e: any) => e.kind === "VENUE_REGISTERED");
        const entries = events.filter((e: any) => e.kind === "GUEST_ENTRY");
        const spends = events.filter((e: any) => e.kind === "GUEST_SPEND");
        assert.equal(venues.length, 3);
        assert.equal(entries.length, 5);
        assert.deepEqual(
            venues.map((v: any) => v.venueId).sort((a: number, b: number) => a - b),
            [1, 2, 3],
        );
        assert.deepEqual(
            entries.map((e: any) => e.hdIndex).sort((a: number, b: number) => a - b),
            [0, 1, 2, 3, 4],
        );
        // Stats line up with the file contents.
        assert.equal(stats.venuesRegistered, 3);
        assert.equal(stats.entries, 5);
        assert.equal(stats.spends, spends.length);
    } finally {
        cleanup();
    }
});

test("skipBootstrap skips venue + entry events", async () => {
    const {path, cleanup} = tmpWal();
    const writer = new OutboxWriter(path);
    await writer.open();
    try {
        const gen = new StressGenerator({
            writer,
            guests: 3,
            venues: 2,
            rate: 100,
            durationSeconds: 0.05,
            skipBootstrap: true,
        });
        await gen.run();
        await writer.close();
        const events = readEvents(path);
        const nonSpends = events.filter((e: any) => e.kind !== "GUEST_SPEND");
        assert.equal(nonSpends.length, 0, "no bootstrap events when --no-bootstrap");
        const spends = events.filter((e: any) => e.kind === "GUEST_SPEND");
        assert.ok(spends.length > 0);
    } finally {
        cleanup();
    }
});

test("each GUEST_SPEND has a valid hdIndex/venueId/amount/category/gameTick", async () => {
    const {path, cleanup} = tmpWal();
    const writer = new OutboxWriter(path);
    await writer.open();
    try {
        const gen = new StressGenerator({
            writer,
            guests: 4,
            venues: 5,
            rate: 200,
            durationSeconds: 0.1,
            skipBootstrap: true,
        });
        await gen.run();
        await writer.close();
        const events = readEvents(path) as any[];
        for (const e of events) {
            if (e.kind !== "GUEST_SPEND") continue;
            assert.ok(e.hdIndex >= 0 && e.hdIndex < 4);
            assert.ok(e.guestId >= 0 && e.guestId < 4);
            assert.ok(e.venueId >= 1 && e.venueId <= 5, `venueId: ${e.venueId}`);
            assert.ok(typeof e.amount === "string" && /^\d+$/.test(e.amount));
            assert.ok(BigInt(e.amount) >= 10n ** 18n);
            assert.equal(e.category, 1);
            assert.ok(Number.isInteger(e.gameTick) && e.gameTick > 0);
        }
    } finally {
        cleanup();
    }
});

test("achieved rate is in the right ballpark (within a generous tolerance)", async () => {
    const {path, cleanup} = tmpWal();
    const writer = new OutboxWriter(path);
    await writer.open();
    try {
        const targetRate = 500;
        const durationSeconds = 1;
        const gen = new StressGenerator({
            writer,
            guests: 10,
            venues: 5,
            rate: targetRate,
            durationSeconds,
            skipBootstrap: true,
        });
        const stats = await gen.run();
        await writer.close();
        const achieved = (stats.spends * 1000) / stats.elapsedMs;
        // Expect within ±25% of target. CI is noisy, the harness is timer-based, and the
        // first-tick warmup eats a few percent — wider than tight tolerance is the safe
        // choice for a non-flaky check.
        assert.ok(
            achieved > targetRate * 0.75 && achieved < targetRate * 1.25,
            `achieved rate ${achieved.toFixed(0)} far from target ${targetRate}`,
        );
    } finally {
        cleanup();
    }
});

test("seq is monotonic across all emitted events", async () => {
    const {path, cleanup} = tmpWal();
    const writer = new OutboxWriter(path);
    await writer.open();
    try {
        const gen = new StressGenerator({
            writer,
            guests: 3,
            venues: 2,
            rate: 100,
            durationSeconds: 0.1,
        });
        await gen.run();
        await writer.close();
        const events = readEvents(path) as any[];
        for (let i = 0; i < events.length; i++) {
            assert.equal(events[i].seq, i, `seq[${i}] = ${events[i].seq}`);
        }
    } finally {
        cleanup();
    }
});

test("stop() interrupts the spend loop", async () => {
    const {path, cleanup} = tmpWal();
    const writer = new OutboxWriter(path);
    await writer.open();
    try {
        const gen = new StressGenerator({
            writer,
            guests: 2,
            venues: 2,
            rate: 100,
            durationSeconds: 60, // would run for 60s if we didn't stop it
            skipBootstrap: true,
        });
        const runP = gen.run();
        // After ~50ms, ask the generator to stop.
        setTimeout(() => gen.stop(), 50);
        const stats = await runP;
        await writer.close();
        // Should be well short of the 60s budget.
        assert.ok(stats.elapsedMs < 1000, `expected fast exit; elapsed=${stats.elapsedMs}ms`);
    } finally {
        cleanup();
    }
});

test("0-duration without bootstrap exits without spends", async () => {
    const {path, cleanup} = tmpWal();
    const writer = new OutboxWriter(path);
    await writer.open();
    try {
        // We need a small finite duration here; durationSeconds=0 means unbounded.
        // A duration of 0.001 forces zero or near-zero ticks.
        const gen = new StressGenerator({
            writer,
            guests: 1,
            venues: 1,
            rate: 100,
            durationSeconds: 0.001,
            skipBootstrap: true,
        });
        const stats = await gen.run();
        await writer.close();
        // With the rate budget so small, only the very first tick is allowed to fire.
        // That's at most rate*tickMs/1000 = 1 spend. Allow up to a couple for timing slop.
        assert.ok(stats.spends <= 2, `unexpected spend count: ${stats.spends}`);
    } finally {
        cleanup();
    }
});

test("bootstrap respects writer.append seq monotonicity even on re-open", async () => {
    const {path, cleanup} = tmpWal();
    {
        const writer = new OutboxWriter(path);
        await writer.open();
        const gen = new StressGenerator({
            writer,
            guests: 2,
            venues: 1,
            rate: 100,
            durationSeconds: 0.05,
        });
        await gen.run();
        await writer.close();
    }
    // Re-open the same WAL; the writer's seq should resume past the last value, so the
    // newly-appended events get strictly higher seqs than the old ones.
    {
        const writer = new OutboxWriter(path);
        await writer.open();
        const gen = new StressGenerator({
            writer,
            guests: 1,
            venues: 1,
            rate: 100,
            durationSeconds: 0.05,
            skipBootstrap: true,
        });
        await gen.run();
        await writer.close();
    }
    const events = readEvents(path) as any[];
    for (let i = 1; i < events.length; i++) {
        assert.ok(events[i].seq > events[i - 1].seq, `seq monotonic at index ${i}`);
    }
    cleanup();
});

// ---- M3.12 / Fix 3 — bootstrap waits for venue mirror cache ----

/// Spin a tiny line-delimited JSON-RPC server on a UDS that exposes a single
/// `chain.venues.status` method whose `cacheSize` advances on a programmable schedule.
/// Lets us assert that the harness *waits* until the count is reached and *doesn't* wait
/// forever when the count never lands.
function startMockSidecar(opts: {
    cacheSizeAt: (elapsedMs: number) => number;
    enabled?: boolean;
}): Promise<{socketPath: string; server: Server; close: () => Promise<void>}> {
    const dir = mkdtempSync(join(tmpdir(), "rct2-stress-mock-sidecar-"));
    const socketPath = join(dir, "sidecar.sock");
    const start = Date.now();
    return new Promise((resolve, reject) => {
        const server = createServer((sock) => {
            sock.setEncoding("utf8");
            let buf = "";
            sock.on("data", (chunk: string | Buffer) => {
                buf += typeof chunk === "string" ? chunk : chunk.toString("utf8");
                for (;;) {
                    const nl = buf.indexOf("\n");
                    if (nl < 0) break;
                    const line = buf.slice(0, nl);
                    buf = buf.slice(nl + 1);
                    if (!line) continue;
                    let req: {id?: number; method: string} | null = null;
                    try {
                        req = JSON.parse(line) as {id?: number; method: string};
                    } catch {
                        continue;
                    }
                    if (req.method === "chain.venues.status") {
                        const elapsed = Date.now() - start;
                        const result = opts.enabled === false
                            ? {enabled: false}
                            : {enabled: true, cacheSize: opts.cacheSizeAt(elapsed)};
                        const reply = {jsonrpc: "2.0", id: req.id, result};
                        sock.write(`${JSON.stringify(reply)}\n`);
                    } else {
                        const reply = {jsonrpc: "2.0", id: req.id, error: {code: -32601, message: "unknown"}};
                        sock.write(`${JSON.stringify(reply)}\n`);
                    }
                }
            });
        });
        server.listen(socketPath, () =>
            resolve({
                socketPath,
                server,
                close: () => new Promise<void>((r) => {
                    server.close(() => {
                        rmSync(dir, {recursive: true, force: true});
                        r();
                    });
                }),
            }),
        );
        server.on("error", reject);
    });
}

test("M3.12: bootstrap waits for the venue mirror cache to reach expected count", async () => {
    const wal = tmpWal();
    let pollCount = 0;
    const mock = await startMockSidecar({
        cacheSizeAt: () => {
            // First two polls return 0; thereafter, all 3 venues land.
            pollCount++;
            return pollCount <= 2 ? 0 : 3;
        },
    });
    try {
        const writer = new OutboxWriter(wal.path);
        await writer.open();
        const gen = new StressGenerator({
            writer,
            guests: 2,
            venues: 3,
            rate: 100,
            durationSeconds: 0.05,
            sidecarSocket: mock.socketPath,
            bootstrapWaitSecs: 5,
        });
        const stats = await gen.run();
        await writer.close();
        assert.equal(stats.venuesRegistered, 3);
        assert.ok(pollCount >= 3, `expected at least 3 polls, saw ${pollCount}`);
    } finally {
        await mock.close();
        wal.cleanup();
    }
});

test("M3.12: bootstrap proceeds (not crashes) when sidecar is offline (enabled=false)", async () => {
    const wal = tmpWal();
    const mock = await startMockSidecar({cacheSizeAt: () => 0, enabled: false});
    try {
        const writer = new OutboxWriter(wal.path);
        await writer.open();
        const gen = new StressGenerator({
            writer,
            guests: 1,
            venues: 1,
            rate: 100,
            durationSeconds: 0.05,
            sidecarSocket: mock.socketPath,
            bootstrapWaitSecs: 1,
        });
        // Should not throw — the wait fails (sidecar offline), generator logs + proceeds.
        const stats = await gen.run();
        await writer.close();
        // Bootstrap wrote the events; spend loop ran briefly.
        assert.equal(stats.venuesRegistered, 1);
        assert.equal(stats.entries, 1);
    } finally {
        await mock.close();
        wal.cleanup();
    }
});

test("M3.12: bootstrap waits up to bootstrapWaitSecs and proceeds on timeout", async () => {
    const wal = tmpWal();
    // Cache never reaches the expected count.
    const mock = await startMockSidecar({cacheSizeAt: () => 0});
    try {
        const writer = new OutboxWriter(wal.path);
        await writer.open();
        const start = Date.now();
        const gen = new StressGenerator({
            writer,
            guests: 1,
            venues: 5,
            rate: 100,
            durationSeconds: 0.05,
            sidecarSocket: mock.socketPath,
            bootstrapWaitSecs: 0.6, // 600 ms
        });
        const stats = await gen.run();
        await writer.close();
        const elapsedMs = Date.now() - start;
        // Wait should be ~600 ms (timeout) + a small handful of ms for setup. Generous CI bound.
        assert.ok(elapsedMs >= 500, `expected ≥ 500ms wait, got ${elapsedMs}`);
        assert.ok(elapsedMs < 5_000, `wait should not run forever; got ${elapsedMs}`);
        // Generator continued to write spends after the timeout.
        assert.ok(stats.spends > 0);
    } finally {
        await mock.close();
        wal.cleanup();
    }
});

test("M3.12: bootstrap with sidecarSocket but bootstrapWaitSecs=0 skips the wait", async () => {
    const wal = tmpWal();
    let pollCount = 0;
    const mock = await startMockSidecar({
        cacheSizeAt: () => {
            pollCount++;
            return 0;
        },
    });
    try {
        const writer = new OutboxWriter(wal.path);
        await writer.open();
        const gen = new StressGenerator({
            writer,
            guests: 1,
            venues: 1,
            rate: 100,
            durationSeconds: 0.05,
            sidecarSocket: mock.socketPath,
            bootstrapWaitSecs: 0,
        });
        await gen.run();
        await writer.close();
        assert.equal(pollCount, 0, "bootstrapWaitSecs=0 must skip polling entirely");
    } finally {
        await mock.close();
        wal.cleanup();
    }
});

test("M3.12: skipBootstrap mode never polls (no socket interaction)", async () => {
    const wal = tmpWal();
    let pollCount = 0;
    const mock = await startMockSidecar({
        cacheSizeAt: () => {
            pollCount++;
            return 99;
        },
    });
    try {
        const writer = new OutboxWriter(wal.path);
        await writer.open();
        const gen = new StressGenerator({
            writer,
            guests: 1,
            venues: 1,
            rate: 100,
            durationSeconds: 0.05,
            skipBootstrap: true,
            sidecarSocket: mock.socketPath,
            bootstrapWaitSecs: 5,
        });
        await gen.run();
        await writer.close();
        assert.equal(pollCount, 0, "no bootstrap = no venue wait");
    } finally {
        await mock.close();
        wal.cleanup();
    }
});
