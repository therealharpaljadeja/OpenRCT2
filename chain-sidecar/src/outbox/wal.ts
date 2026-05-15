import {open, type FileHandle, stat, truncate} from "node:fs/promises";
import {existsSync} from "node:fs";
import {dirname} from "node:path";
import {mkdir} from "node:fs/promises";
import {log as defaultLog, type Logger} from "../log.js";
import {parseEvent, serializeEvent, type OutboxEvent, type OutboxEventWithoutSeq} from "./types.js";

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
///
/// Size cap (plan §10): the writer caps the WAL at `maxBytes` (default 500 MB). When the
/// next append would push past the cap, the writer truncates the file in-place and keeps
/// going. The reader's `stat.size < readOffset` branch (`reader.ts`) detects the shrink and
/// resets its byte cursor to 0, so the truncation is invisible to event flow modulo the
/// inevitable loss of any unconsumed events that were past the cap. We log a warn + bump a
/// counter so operators can see when this happens; in normal operation it shouldn't.
///
/// Why truncate-in-place rather than rotate-to-`.1`: the reader is keyed off a single
/// stable path. A roll-to-numbered-archive scheme would either require the reader to chase
/// archive files (much more state) or accept the same loss-of-tail behavior as truncation.
/// Truncation is simpler and the consumer-side handling already exists.

export const DEFAULT_MAX_BYTES = 500 * 1024 * 1024;
/// Hard upper bound. 4 GiB is well past anything we'd want to hold in a single WAL on any
/// reasonable filesystem; the cap exists so a fat-finger config doesn't accidentally let the
/// disk fill.
export const MAX_MAX_BYTES = 4 * 1024 * 1024 * 1024;

export interface OutboxWriterOptions {
    /// Soft cap in bytes. The writer truncates when the next append would push past this.
    /// Default 500 MB per plan §10.
    maxBytes?: number;
    log?: Logger;
}

export interface OutboxWriterStats {
    path: string;
    appendCount: number;
    nextSeq: number;
    currentSize: number;
    maxBytes: number;
    /// Times the writer truncated due to maxBytes. Surfaced via `outbox.status` so
    /// `rctctl chain status` flags rotation-driven event loss.
    rotations: number;
}

export class OutboxWriter {
    readonly #path: string;
    readonly #maxBytes: number;
    readonly #log: Logger;
    #fh: FileHandle | undefined;
    #nextSeq = 0;
    #appendCount = 0;
    #currentSize = 0;
    #rotations = 0;

    constructor(path: string, opts: OutboxWriterOptions = {}) {
        const maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES;
        validateMaxBytes(maxBytes);
        this.#path = path;
        this.#maxBytes = maxBytes;
        this.#log = (opts.log ?? defaultLog).child({outbox: path});
    }

    /// Opens the WAL. If the file already exists, scans it once to recover the next sequence
    /// number — this is what lets a relaunched producer keep the seq monotonic without
    /// coordinating with the consumer.
    async open(): Promise<void> {
        if (this.#fh) throw new Error(`OutboxWriter already open: ${this.#path}`);
        await mkdir(dirname(this.#path), {recursive: true}).catch(() => undefined);
        if (existsSync(this.#path)) {
            this.#nextSeq = await scanLastSeq(this.#path);
            const st = await stat(this.#path);
            this.#currentSize = st.size;
        } else {
            this.#currentSize = 0;
        }
        this.#fh = await open(this.#path, "a");
    }

    /// Append an event. The writer assigns `seq` so callers can't accidentally collide;
    /// pass `Omit<OutboxEvent, "seq">`. Returns the assigned seq for test/log correlation.
    ///
    /// If the resulting on-disk size would exceed `maxBytes`, the WAL is truncated *before*
    /// the new event is written — so the post-rotation file always contains at least the
    /// triggering event (rather than rotating away a freshly-written line).
    async append(event: OutboxEventWithoutSeq): Promise<number> {
        if (!this.#fh) throw new Error(`OutboxWriter not open: ${this.#path}`);
        const seq = this.#nextSeq++;
        const full = {...event, seq} as OutboxEvent;
        const wire = serializeEvent(full);
        const wireBytes = Buffer.byteLength(wire, "utf8");
        if (this.#currentSize + wireBytes > this.#maxBytes) {
            await this.#rotate();
        }
        await this.#fh.write(wire);
        this.#currentSize += wireBytes;
        this.#appendCount++;
        return seq;
    }

    appendCount(): number {
        return this.#appendCount;
    }

    nextSeq(): number {
        return this.#nextSeq;
    }

    currentSize(): number {
        return this.#currentSize;
    }

    rotations(): number {
        return this.#rotations;
    }

    stats(): OutboxWriterStats {
        return {
            path: this.#path,
            appendCount: this.#appendCount,
            nextSeq: this.#nextSeq,
            currentSize: this.#currentSize,
            maxBytes: this.#maxBytes,
            rotations: this.#rotations,
        };
    }

    async close(): Promise<void> {
        if (!this.#fh) return;
        await this.#fh.close();
        this.#fh = undefined;
    }

    // --------------------------------------------------------------------------------------

    /// Truncate the WAL in place and re-open in append mode. Safe to call mid-flight; the
    /// reader detects `stat.size < readOffset` next tick and resets its byte cursor to 0.
    /// We close the fd first so `truncate(path, 0)` doesn't race with an in-flight write
    /// from the same handle (POSIX makes this well-defined but Windows doesn't).
    async #rotate(): Promise<void> {
        if (!this.#fh) return;
        await this.#fh.close();
        await truncate(this.#path, 0);
        this.#fh = await open(this.#path, "a");
        this.#currentSize = 0;
        this.#rotations++;
        // Note: `nextSeq` is NOT reset. Seq is monotonic across rotations — the consumer
        // uses byte offsets for cursor tracking and seq purely for sanity / debug. Resetting
        // would create false "duplicate seq" alerts after a rotation.
        this.#log.warn(
            {path: this.#path, maxBytes: this.#maxBytes, rotations: this.#rotations},
            "WAL rotated (truncated) due to size cap — reader will detect shrink + reset",
        );
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

function validateMaxBytes(n: number): void {
    if (!Number.isInteger(n) || n < 1024 || n > MAX_MAX_BYTES) {
        throw new Error(`maxBytes must be an integer in [1024, ${MAX_MAX_BYTES}], got ${n}`);
    }
}
