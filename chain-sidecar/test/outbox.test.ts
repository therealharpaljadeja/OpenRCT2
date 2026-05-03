import {test} from "node:test";
import assert from "node:assert/strict";
import {appendFile, mkdtemp, readFile, rm, stat, writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {
    OutboxReader,
    OutboxWriter,
    parseEvent,
    serializeEvent,
    loadCursor,
    saveCursor,
    type OutboxEvent,
} from "../src/outbox/index.js";

async function tmpDir(): Promise<{dir: string; cleanup: () => Promise<void>}> {
    const dir = await mkdtemp(join(tmpdir(), "rct2-outbox-test-"));
    return {dir, cleanup: () => rm(dir, {recursive: true, force: true})};
}

function sleep(ms: number): Promise<void> {
    return new Promise((r) => setTimeout(r, ms));
}

/// Spin until `predicate()` returns true, or fail after `timeoutMs`. Used by the polling
/// tests because the reader is event-driven (no callback to await directly).
async function waitFor(predicate: () => boolean, timeoutMs = 2000, intervalMs = 10): Promise<void> {
    const start = Date.now();
    while (!predicate()) {
        if (Date.now() - start > timeoutMs) throw new Error(`timeout waiting for condition (${timeoutMs}ms)`);
        await sleep(intervalMs);
    }
}

// ----------------------------------------------------------------------------
// types.ts — parser
// ----------------------------------------------------------------------------

test("parseEvent accepts every kind", () => {
    const cases: OutboxEvent[] = [
        {seq: 0, ts: 1, kind: "GUEST_ENTRY", guestId: 1, hdIndex: 0, cash: "1000"},
        {seq: 1, ts: 2, kind: "GUEST_SPEND", guestId: 1, venueId: 7, amount: "12", category: 1, gameTick: 5000},
        {seq: 2, ts: 3, kind: "GUEST_EXIT", guestId: 1, hdIndex: 1},
        {seq: 3, ts: 4, kind: "VENUE_REGISTERED", venueId: 7, venueKind: 1, name: "Coaster", objectType: "rct2.ride.wmouse"},
        {seq: 4, ts: 5, kind: "VENUE_RENAMED", venueId: 7, newName: "New Name"},
        {seq: 5, ts: 6, kind: "VENUE_REMOVED", venueId: 7},
    ];
    for (const c of cases) {
        const r = parseEvent(JSON.stringify(c));
        assert.equal(r.ok, true);
        if (r.ok) assert.deepEqual(r.event, c);
    }
});

test("parseEvent rejects malformed lines without throwing", () => {
    const bad = [
        "not json",
        "[]",
        "null",
        "42",
        '{"seq": -1, "ts": 1, "kind": "GUEST_EXIT", "guestId": 1}',
        '{"seq": 0, "ts": "x", "kind": "GUEST_EXIT", "guestId": 1}',
        '{"seq": 0, "ts": 1, "kind": "FUTURE_KIND"}',
        '{"seq": 0, "ts": 1, "kind": "GUEST_SPEND", "guestId": 1}', // missing fields
    ];
    for (const line of bad) {
        const r = parseEvent(line);
        assert.equal(r.ok, false, `expected reject for: ${line}`);
    }
});

test("serializeEvent + parseEvent round-trip", () => {
    const event: OutboxEvent = {
        seq: 99,
        ts: 1714668000000,
        kind: "GUEST_SPEND",
        guestId: 42,
        venueId: 8,
        amount: "1234567890123456789",
        category: 2,
        gameTick: 100000,
    };
    const wire = serializeEvent(event);
    assert.ok(wire.endsWith("\n"), "must end with newline");
    const r = parseEvent(wire.slice(0, -1));
    assert.ok(r.ok);
    if (r.ok) assert.deepEqual(r.event, event);
});

// ----------------------------------------------------------------------------
// cursor.ts
// ----------------------------------------------------------------------------

test("loadCursor returns ZERO when file is missing", async () => {
    const {dir, cleanup} = await tmpDir();
    try {
        const cursor = await loadCursor(join(dir, "missing.cursor"));
        assert.deepEqual(cursor, {offset: 0, lastSeq: -1, updatedAt: 0});
    } finally {
        await cleanup();
    }
});

test("saveCursor + loadCursor round-trip", async () => {
    const {dir, cleanup} = await tmpDir();
    try {
        const path = join(dir, "x.cursor");
        await saveCursor(path, {offset: 1234, lastSeq: 10, updatedAt: 5_000});
        const got = await loadCursor(path);
        assert.deepEqual(got, {offset: 1234, lastSeq: 10, updatedAt: 5_000});
    } finally {
        await cleanup();
    }
});

test("loadCursor falls back to ZERO on corrupt file", async () => {
    const {dir, cleanup} = await tmpDir();
    try {
        const path = join(dir, "corrupt.cursor");
        await writeFile(path, "not json");
        const got = await loadCursor(path);
        assert.deepEqual(got, {offset: 0, lastSeq: -1, updatedAt: 0});
    } finally {
        await cleanup();
    }
});

// ----------------------------------------------------------------------------
// wal.ts — OutboxWriter
// ----------------------------------------------------------------------------

test("OutboxWriter assigns monotonic seq starting at 0", async () => {
    const {dir, cleanup} = await tmpDir();
    try {
        const w = new OutboxWriter(join(dir, "out.wal"));
        await w.open();
        const a = await w.append({ts: 1, kind: "GUEST_EXIT", guestId: 1, hdIndex: 1});
        const b = await w.append({ts: 2, kind: "GUEST_EXIT", guestId: 2, hdIndex: 2});
        const c = await w.append({ts: 3, kind: "GUEST_EXIT", guestId: 3, hdIndex: 3});
        await w.close();
        assert.equal(a, 0);
        assert.equal(b, 1);
        assert.equal(c, 2);
    } finally {
        await cleanup();
    }
});

test("OutboxWriter resumes seq after reopen on existing WAL", async () => {
    const {dir, cleanup} = await tmpDir();
    try {
        const path = join(dir, "out.wal");
        const w1 = new OutboxWriter(path);
        await w1.open();
        await w1.append({ts: 1, kind: "GUEST_EXIT", guestId: 1, hdIndex: 1});
        await w1.append({ts: 2, kind: "GUEST_EXIT", guestId: 2, hdIndex: 2});
        await w1.close();

        const w2 = new OutboxWriter(path);
        await w2.open();
        const seq = await w2.append({ts: 3, kind: "GUEST_EXIT", guestId: 3, hdIndex: 3});
        await w2.close();
        assert.equal(seq, 2, "next seq should pick up where seq=1 left off");
    } finally {
        await cleanup();
    }
});

test("OutboxWriter produces NDJSON parseable line-by-line", async () => {
    const {dir, cleanup} = await tmpDir();
    try {
        const path = join(dir, "out.wal");
        const w = new OutboxWriter(path);
        await w.open();
        await w.append({ts: 1, kind: "GUEST_ENTRY", guestId: 1, hdIndex: 0, cash: "100"});
        await w.append({ts: 2, kind: "GUEST_SPEND", guestId: 1, venueId: 5, amount: "10", category: 0, gameTick: 1});
        await w.close();
        const raw = await readFile(path, "utf8");
        const lines = raw.split("\n").filter((l) => l.length > 0);
        assert.equal(lines.length, 2);
        for (const line of lines) {
            const r = parseEvent(line);
            assert.ok(r.ok, `line failed to parse: ${line}`);
        }
    } finally {
        await cleanup();
    }
});

// ----------------------------------------------------------------------------
// reader.ts — OutboxReader
// ----------------------------------------------------------------------------

test("OutboxReader drains existing events into the handler", async () => {
    const {dir, cleanup} = await tmpDir();
    try {
        const wal = join(dir, "out.wal");
        const cursor = join(dir, "out.cursor");
        const w = new OutboxWriter(wal);
        await w.open();
        for (let i = 0; i < 5; i++) {
            await w.append({ts: i, kind: "GUEST_EXIT", guestId: i, hdIndex: i});
        }
        await w.close();

        const seen: OutboxEvent[] = [];
        const reader = new OutboxReader({walPath: wal, cursorPath: cursor, pollIntervalMs: 5, persistEveryN: 1});
        await reader.start((e) => {
            seen.push(e);
        });
        await waitFor(() => seen.length === 5);
        await reader.stop();
        assert.equal(seen.length, 5);
        assert.deepEqual(
            seen.map((e) => e.seq),
            [0, 1, 2, 3, 4],
        );
    } finally {
        await cleanup();
    }
});

test("OutboxReader sees events appended after start (live tail)", async () => {
    const {dir, cleanup} = await tmpDir();
    try {
        const wal = join(dir, "out.wal");
        const cursor = join(dir, "out.cursor");

        const seen: OutboxEvent[] = [];
        const reader = new OutboxReader({walPath: wal, cursorPath: cursor, pollIntervalMs: 5, persistEveryN: 1});
        await reader.start((e) => {
            seen.push(e);
        });

        const w = new OutboxWriter(wal);
        await w.open();
        for (let i = 0; i < 3; i++) {
            await w.append({ts: i, kind: "GUEST_EXIT", guestId: i, hdIndex: i});
        }
        await w.close();
        await waitFor(() => seen.length === 3);

        const w2 = new OutboxWriter(wal);
        await w2.open();
        await w2.append({ts: 99, kind: "GUEST_EXIT", guestId: 99, hdIndex: 99});
        await w2.close();
        await waitFor(() => seen.length === 4);

        await reader.stop();
        assert.equal(seen[3]?.kind, "GUEST_EXIT");
        assert.equal((seen[3] as {guestId: number}).guestId, 99);
    } finally {
        await cleanup();
    }
});

test("OutboxReader resumes from cursor across stop/start", async () => {
    const {dir, cleanup} = await tmpDir();
    try {
        const wal = join(dir, "out.wal");
        const cursor = join(dir, "out.cursor");
        const w = new OutboxWriter(wal);
        await w.open();
        for (let i = 0; i < 4; i++) await w.append({ts: i, kind: "GUEST_EXIT", guestId: i, hdIndex: i});
        await w.close();

        const first: OutboxEvent[] = [];
        const r1 = new OutboxReader({walPath: wal, cursorPath: cursor, pollIntervalMs: 5, persistEveryN: 1});
        await r1.start((e) => {
            first.push(e);
        });
        await waitFor(() => first.length === 4);
        await r1.stop();

        // Append 2 more events after first reader has stopped + persisted cursor.
        const w2 = new OutboxWriter(wal);
        await w2.open();
        await w2.append({ts: 100, kind: "GUEST_EXIT", guestId: 100, hdIndex: 100});
        await w2.append({ts: 101, kind: "GUEST_EXIT", guestId: 101, hdIndex: 101});
        await w2.close();

        const second: OutboxEvent[] = [];
        const r2 = new OutboxReader({walPath: wal, cursorPath: cursor, pollIntervalMs: 5, persistEveryN: 1});
        await r2.start((e) => {
            second.push(e);
        });
        await waitFor(() => second.length === 2);
        await r2.stop();
        assert.deepEqual(
            second.map((e) => e.seq),
            [4, 5],
            "second reader sees only the new events, not the 4 from before",
        );
    } finally {
        await cleanup();
    }
});

test("OutboxReader does not advance cursor past a failing handler", async () => {
    const {dir, cleanup} = await tmpDir();
    try {
        const wal = join(dir, "out.wal");
        const cursor = join(dir, "out.cursor");
        const w = new OutboxWriter(wal);
        await w.open();
        await w.append({ts: 1, kind: "GUEST_EXIT", guestId: 1, hdIndex: 1});
        await w.append({ts: 2, kind: "GUEST_EXIT", guestId: 2, hdIndex: 2});
        await w.close();

        // Handler throws on seq=1 a few times before letting it through.
        let attemptsAtSeq1 = 0;
        const seen: OutboxEvent[] = [];
        const reader = new OutboxReader({
            walPath: wal,
            cursorPath: cursor,
            pollIntervalMs: 5,
            persistEveryN: 1,
        });
        await reader.start((e) => {
            if (e.seq === 1 && attemptsAtSeq1 < 2) {
                attemptsAtSeq1++;
                throw new Error("simulated failure");
            }
            seen.push(e);
        });
        await waitFor(() => seen.length === 2, 3000);
        await reader.stop();
        assert.equal(attemptsAtSeq1, 2, "handler retried twice before succeeding");
        assert.deepEqual(seen.map((e) => e.seq), [0, 1]);
        assert.equal(reader.stats().handlerErrors, 2);
    } finally {
        await cleanup();
    }
});

test("OutboxReader skips malformed lines and bumps parseErrors counter", async () => {
    const {dir, cleanup} = await tmpDir();
    try {
        const wal = join(dir, "out.wal");
        const cursor = join(dir, "out.cursor");
        // Hand-craft a WAL with a good line, a malformed line, then another good line.
        await writeFile(
            wal,
            [
                JSON.stringify({seq: 0, ts: 1, kind: "GUEST_EXIT", guestId: 1, hdIndex: 1}),
                "this is garbage",
                JSON.stringify({seq: 1, ts: 2, kind: "GUEST_EXIT", guestId: 2, hdIndex: 2}),
            ].join("\n") + "\n",
        );

        const seen: OutboxEvent[] = [];
        const reader = new OutboxReader({walPath: wal, cursorPath: cursor, pollIntervalMs: 5, persistEveryN: 1});
        await reader.start((e) => {
            seen.push(e);
        });
        await waitFor(() => seen.length === 2);
        await reader.stop();
        assert.equal(reader.stats().parseErrors, 1);
        assert.deepEqual(
            seen.map((e) => (e as {guestId: number}).guestId),
            [1, 2],
        );
    } finally {
        await cleanup();
    }
});

test("OutboxReader handles partial trailing line (writer mid-write)", async () => {
    const {dir, cleanup} = await tmpDir();
    try {
        const wal = join(dir, "out.wal");
        const cursor = join(dir, "out.cursor");
        // Write event 0 fully + the prefix of event 1 (no trailing newline).
        const goodLine = JSON.stringify({seq: 0, ts: 1, kind: "GUEST_EXIT", guestId: 1, hdIndex: 1}) + "\n";
        const partial = '{"seq":1,"ts":2,"kind":"GUEST_EXIT","guestId":2,"hdIndex":';
        await writeFile(wal, goodLine + partial);

        const seen: OutboxEvent[] = [];
        const reader = new OutboxReader({walPath: wal, cursorPath: cursor, pollIntervalMs: 5, persistEveryN: 1});
        await reader.start((e) => {
            seen.push(e);
        });
        await waitFor(() => seen.length === 1);

        // Now finish the partial line — the reader should pick it up on the next tick.
        await appendFile(wal, '2}\n');
        await waitFor(() => seen.length === 2);
        await reader.stop();
        assert.equal(seen.length, 2);
    } finally {
        await cleanup();
    }
});

test("OutboxReader cursor reflects total bytes consumed", async () => {
    const {dir, cleanup} = await tmpDir();
    try {
        const wal = join(dir, "out.wal");
        const cursor = join(dir, "out.cursor");
        const w = new OutboxWriter(wal);
        await w.open();
        await w.append({ts: 1, kind: "GUEST_EXIT", guestId: 1, hdIndex: 1});
        await w.append({ts: 2, kind: "GUEST_EXIT", guestId: 2, hdIndex: 2});
        await w.close();

        const expectedSize = (await stat(wal)).size;
        let count = 0;
        const reader = new OutboxReader({walPath: wal, cursorPath: cursor, pollIntervalMs: 5, persistEveryN: 1});
        await reader.start(() => {
            count++;
        });
        await waitFor(() => count === 2);
        await reader.stop();
        const persisted = await loadCursor(cursor);
        assert.equal(persisted.offset, expectedSize, "cursor should equal total WAL bytes after full drain");
        assert.equal(persisted.lastSeq, 1);
    } finally {
        await cleanup();
    }
});

test("OutboxReader survives UTF-8 multibyte chars in venue names", async () => {
    const {dir, cleanup} = await tmpDir();
    try {
        const wal = join(dir, "out.wal");
        const cursor = join(dir, "out.cursor");
        const w = new OutboxWriter(wal);
        await w.open();
        await w.append({ts: 1, kind: "VENUE_REGISTERED", venueId: 1, venueKind: 1, name: "Café 🎢", objectType: "rct2.ride.wmouse"});
        await w.close();

        const seen: OutboxEvent[] = [];
        const reader = new OutboxReader({walPath: wal, cursorPath: cursor, pollIntervalMs: 5, persistEveryN: 1});
        await reader.start((e) => {
            seen.push(e);
        });
        await waitFor(() => seen.length === 1);
        await reader.stop();
        assert.equal((seen[0] as {name: string}).name, "Café 🎢");
    } finally {
        await cleanup();
    }
});

test("OutboxReader recovers when WAL shrinks below cursor (rotation)", async () => {
    const {dir, cleanup} = await tmpDir();
    try {
        const wal = join(dir, "out.wal");
        const cursor = join(dir, "out.cursor");
        const w = new OutboxWriter(wal);
        await w.open();
        for (let i = 0; i < 3; i++) await w.append({ts: i, kind: "GUEST_EXIT", guestId: i, hdIndex: i});
        await w.close();

        const seen: OutboxEvent[] = [];
        const reader = new OutboxReader({walPath: wal, cursorPath: cursor, pollIntervalMs: 5, persistEveryN: 1});
        await reader.start((e) => {
            seen.push(e);
        });
        await waitFor(() => seen.length === 3);

        // Simulate rotation: replace the WAL with a fresh, smaller one.
        await writeFile(wal, JSON.stringify({seq: 0, ts: 100, kind: "GUEST_EXIT", guestId: 99, hdIndex: 99}) + "\n");
        await waitFor(() => seen.length === 4, 3000);
        await reader.stop();
        assert.equal((seen[3] as {guestId: number}).guestId, 99);
    } finally {
        await cleanup();
    }
});
