import {open, type FileHandle, stat} from "node:fs/promises";
import {existsSync} from "node:fs";
import {StringDecoder} from "node:string_decoder";
import {log as rootLog, type Logger} from "../log.js";
import {parseEvent, type OutboxEvent} from "./types.js";
import {loadCursor, saveCursor, type Cursor} from "./cursor.js";

export type EventHandler = (event: OutboxEvent) => Promise<void> | void;

export interface OutboxReaderOptions {
    walPath: string;
    cursorPath: string;
    /// How often to re-stat the WAL when there's no new data. 50 ms is "fast enough" for the
    /// plan's ~200 ms batch flush cadence (M3.2) — the reader is never the bottleneck — and
    /// generates 20 stats/s of background load, which is nothing.
    pollIntervalMs?: number;
    /// Persist cursor every N successfully-handled events. Keeps the cursor file fresh
    /// without one fsync per event. On graceful shutdown we always flush.
    persistEveryN?: number;
    log?: Logger;
}

export interface OutboxReaderStats {
    walPath: string;
    cursorPath: string;
    running: boolean;
    cursor: Cursor;
    /// Events successfully delivered to the handler since start.
    processed: number;
    /// Lines that failed to parse — skipped, advanced past in the cursor.
    parseErrors: number;
    /// Times the handler threw — same line is retried on next tick.
    handlerErrors: number;
    /// `read()` syscalls performed. Mostly a sanity / debug counter.
    reads: number;
}

const DEFAULT_POLL_INTERVAL_MS = 50;
const DEFAULT_PERSIST_EVERY_N = 256;
const READ_CHUNK_BYTES = 64 * 1024;

/// Polls the on-disk WAL, parses NDJSON events, hands each one to a handler, and persists a
/// byte-offset cursor so the next boot resumes exactly where we left off.
///
/// **Sequential semantics.** The handler is awaited before the next event is delivered. If
/// it throws, the cursor doesn't advance — same line will be re-tried on the next poll
/// after a small backoff. This is intentional: the batcher (M3) is the thing that should
/// coalesce events, not the reader. A "fast" reader that drops events on handler failure
/// would break the durability story we just paid the WAL cost for.
///
/// **Cursor advances on acknowledgement, not on read.** We track two pointers:
///   - `readOffset` — bytes pulled from disk into the in-memory buffer. Internal-only.
///   - `cursor.offset` — bytes whose events have been *successfully handled*. Persisted.
/// A crash between `read()` and handler-success leaves the cursor pointing at the unhandled
/// event, so the next boot re-delivers it. That's the durability story we paid the WAL for.
///
/// **UTF-8 boundaries.** A read can land mid-multibyte (venue names contain café/🎢 in
/// real saves). `StringDecoder` buffers incomplete sequences across reads.
///
/// **Truncation / rotation.** If `stat.size < readOffset`, something rotated or truncated
/// the WAL. We log a warning and reset to offset 0 — replays from the start are safer than
/// skipping events whose disk position we just lost. WAL rotation policy (plan §10: cap at
/// 500 MB) is a future M3.10 task; for now we tolerate the case.
export class OutboxReader {
    readonly #walPath: string;
    readonly #cursorPath: string;
    readonly #pollIntervalMs: number;
    readonly #persistEveryN: number;
    readonly #log: Logger;
    #handler: EventHandler | undefined;
    #fh: FileHandle | undefined;
    #cursor: Cursor = {offset: 0, lastSeq: -1, updatedAt: 0};
    #readOffset = 0;
    #processed = 0;
    #parseErrors = 0;
    #handlerErrors = 0;
    #reads = 0;
    #since_persist = 0;
    #running = false;
    #stopWanted = false;
    #decoder = new StringDecoder("utf8");
    #buffer = "";
    /// Resolves when the read loop exits — used by `stop()` to await a clean shutdown.
    #loopDone: Promise<void> | undefined;

    constructor(opts: OutboxReaderOptions) {
        this.#walPath = opts.walPath;
        this.#cursorPath = opts.cursorPath;
        this.#pollIntervalMs = opts.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
        this.#persistEveryN = opts.persistEveryN ?? DEFAULT_PERSIST_EVERY_N;
        this.#log = (opts.log ?? rootLog).child({outbox: this.#walPath});
    }

    async start(handler: EventHandler): Promise<void> {
        if (this.#running) throw new Error("OutboxReader already running");
        this.#handler = handler;
        this.#cursor = await loadCursor(this.#cursorPath);
        this.#readOffset = this.#cursor.offset;
        this.#decoder = new StringDecoder("utf8");
        this.#buffer = "";
        this.#running = true;
        this.#stopWanted = false;
        this.#log.info({cursor: this.#cursor}, "outbox reader starting");
        // Detached loop — caller awaits `stop()` for clean shutdown.
        this.#loopDone = this.#loop();
    }

    async stop(): Promise<void> {
        if (!this.#running) return;
        this.#stopWanted = true;
        await this.#loopDone;
        if (this.#fh) {
            await this.#fh.close().catch(() => undefined);
            this.#fh = undefined;
        }
        await this.#flushCursor();
        this.#running = false;
        this.#log.info({stats: this.stats()}, "outbox reader stopped");
    }

    stats(): OutboxReaderStats {
        return {
            walPath: this.#walPath,
            cursorPath: this.#cursorPath,
            running: this.#running,
            cursor: {...this.#cursor},
            processed: this.#processed,
            parseErrors: this.#parseErrors,
            handlerErrors: this.#handlerErrors,
            reads: this.#reads,
        };
    }

    // --------------------------------------------------------------------------------------

    async #loop(): Promise<void> {
        while (!this.#stopWanted) {
            try {
                const advanced = await this.#tick();
                if (!advanced) await sleep(this.#pollIntervalMs);
            } catch (err) {
                this.#log.error({err}, "outbox reader tick failed");
                await sleep(this.#pollIntervalMs);
            }
        }
    }

    /// Returns true if any event was processed (so the loop can immediately try again rather
    /// than sleep — keeps the drain hot during a backlog).
    async #tick(): Promise<boolean> {
        if (!existsSync(this.#walPath)) return false;
        if (!this.#fh) {
            this.#fh = await open(this.#walPath, "r");
        }
        const st = await stat(this.#walPath);
        if (st.size < this.#readOffset) {
            this.#log.warn(
                {size: st.size, readOffset: this.#readOffset},
                "WAL shrunk under read offset — assuming rotation/truncation, resetting to 0",
            );
            this.#cursor = {offset: 0, lastSeq: -1, updatedAt: Date.now()};
            this.#readOffset = 0;
            this.#decoder = new StringDecoder("utf8");
            this.#buffer = "";
            await this.#fh.close();
            this.#fh = await open(this.#walPath, "r");
        }
        if (st.size === this.#readOffset && this.#buffer.length === 0) return false;

        const toRead = st.size - this.#readOffset;
        if (toRead > 0) {
            const buf = Buffer.allocUnsafe(Math.min(toRead, READ_CHUNK_BYTES));
            const {bytesRead} = await this.#fh.read(buf, 0, buf.length, this.#readOffset);
            this.#reads++;
            if (bytesRead > 0) {
                this.#buffer += this.#decoder.write(buf.subarray(0, bytesRead));
                this.#readOffset += bytesRead;
            }
        }

        let processedThisTick = false;
        for (;;) {
            const nl = this.#buffer.indexOf("\n");
            if (nl < 0) break;
            const line = this.#buffer.slice(0, nl);
            // Byte length of the line *plus* the trailing `\n`. That's what we advance the
            // cursor by once the handler acks the event.
            const lineByteLen = Buffer.byteLength(line, "utf8") + 1;
            this.#buffer = this.#buffer.slice(nl + 1);
            if (line.length === 0) {
                this.#cursor = {
                    offset: this.#cursor.offset + 1,
                    lastSeq: this.#cursor.lastSeq,
                    updatedAt: Date.now(),
                };
                continue;
            }

            const parsed = parseEvent(line);
            if (!parsed.ok) {
                this.#parseErrors++;
                this.#log.warn({line, error: parsed.error}, "outbox parse error — skipping line");
                this.#cursor = {
                    offset: this.#cursor.offset + lineByteLen,
                    lastSeq: this.#cursor.lastSeq,
                    updatedAt: Date.now(),
                };
                continue;
            }

            try {
                await this.#handler!(parsed.event);
            } catch (err) {
                this.#handlerErrors++;
                this.#log.error({err, seq: parsed.event.seq}, "outbox handler threw — will retry");
                // Push the line + trailing newline back onto the buffer so the next tick
                // re-delivers it. Cursor stays put; we already paid the read cost.
                this.#buffer = `${line}\n${this.#buffer}`;
                await sleep(this.#pollIntervalMs);
                return processedThisTick;
            }

            this.#cursor = {
                offset: this.#cursor.offset + lineByteLen,
                lastSeq: parsed.event.seq,
                updatedAt: Date.now(),
            };
            this.#processed++;
            this.#since_persist++;
            processedThisTick = true;

            if (this.#since_persist >= this.#persistEveryN) {
                await this.#flushCursor();
            }
        }
        return processedThisTick;
    }

    async #flushCursor(): Promise<void> {
        await saveCursor(this.#cursorPath, this.#cursor);
        this.#since_persist = 0;
    }
}

function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}
