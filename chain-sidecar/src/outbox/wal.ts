import {open, type FileHandle} from "node:fs/promises";
import {existsSync} from "node:fs";
import {dirname} from "node:path";
import {mkdir} from "node:fs/promises";
import {parseEvent, serializeEvent, type OutboxEvent} from "./types.js";

/// Append-only WAL writer. The real producer is the game's background outbox-writer thread
/// (M4.1); this TypeScript implementation is the test producer + a future home for any
/// sidecar-internal events (e.g. a control-plane "park-side admin" event) that don't
/// originate in the game tick.
///
/// Single-writer assumption: only one OutboxWriter (or its game-side equivalent) opens a
/// given WAL path at a time. POSIX append-mode writes serialize on a single FD, so
/// concurrent writes from one process are safe; cross-process concurrent writers would
/// need O_APPEND + atomicity guarantees which we don't promise. The reader is independent.
///
/// Crash safety: each `append` triggers a single `write()` syscall; we don't fsync per event
/// because the durability target is "the consumer caught up" (cursor in the reader), not
/// "every event is on platter". A crashed sidecar/game just resumes from the cursor — events
/// already in the page cache will be flushed by the OS.
export class OutboxWriter {
    #fh: FileHandle | undefined;
    #nextSeq = 0;
    #appendCount = 0;

    constructor(private readonly path: string) {}

    /// Opens the WAL. If the file already exists, scans it once to recover the next sequence
    /// number — this is what lets a relaunched producer keep the seq monotonic without
    /// coordinating with the consumer.
    async open(): Promise<void> {
        if (this.#fh) throw new Error(`OutboxWriter already open: ${this.path}`);
        await mkdir(dirname(this.path), {recursive: true}).catch(() => undefined);
        if (existsSync(this.path)) {
            this.#nextSeq = await scanLastSeq(this.path);
        }
        this.#fh = await open(this.path, "a");
    }

    /// Append an event. The writer assigns `seq` so callers can't accidentally collide;
    /// pass `Omit<OutboxEvent, "seq">`. Returns the assigned seq for test/log correlation.
    async append(event: Omit<OutboxEvent, "seq">): Promise<number> {
        if (!this.#fh) throw new Error(`OutboxWriter not open: ${this.path}`);
        const seq = this.#nextSeq++;
        const full = {...event, seq} as OutboxEvent;
        await this.#fh.write(serializeEvent(full));
        this.#appendCount++;
        return seq;
    }

    appendCount(): number {
        return this.#appendCount;
    }

    nextSeq(): number {
        return this.#nextSeq;
    }

    async close(): Promise<void> {
        if (!this.#fh) return;
        await this.#fh.close();
        this.#fh = undefined;
    }
}

/// Scan an existing WAL once to find the highest seq + 1. Used by `OutboxWriter.open` to
/// resume monotonicity after a producer restart. We tolerate trailing garbage / partial
/// lines (the last line may have been mid-write when a previous process died).
async function scanLastSeq(path: string): Promise<number> {
    const fh = await open(path, "r");
    try {
        let highest = -1;
        const stream = fh.createReadStream({encoding: "utf8"});
        let buf = "";
        for await (const chunk of stream) {
            buf += chunk;
            for (;;) {
                const nl = buf.indexOf("\n");
                if (nl < 0) break;
                const line = buf.slice(0, nl);
                buf = buf.slice(nl + 1);
                if (line.length === 0) continue;
                const r = parseEvent(line);
                if (r.ok && r.event.seq > highest) highest = r.event.seq;
            }
        }
        return highest + 1;
    } finally {
        await fh.close();
    }
}
