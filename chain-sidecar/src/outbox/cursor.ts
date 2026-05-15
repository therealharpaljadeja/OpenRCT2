import {readFile, rename, writeFile} from "node:fs/promises";
import {existsSync} from "node:fs";
import {dirname} from "node:path";
import {mkdir} from "node:fs/promises";

/// Byte-offset cursor persistence. The reader writes "I've consumed up to byte N" so the
/// next sidecar boot resumes from there. Atomic write via write-then-rename — the OS
/// guarantees rename is atomic on the same filesystem, so we never see a half-written file.
///
/// Why bytes, not seq: a byte offset is a literal seek target — restart is one `read(fd, ...,
/// offset=N)` call. A seq would require re-scanning the WAL prefix to find where seq=N
/// lives. For 500 MB WALs that's seconds of cold start we don't want.
export interface Cursor {
    /// Byte offset into the WAL of the next un-processed event.
    offset: number;
    /// Highest seq we've acknowledged. Sanity-only — used to detect non-monotonic producer
    /// bugs after a restart, not to drive replay.
    lastSeq: number;
    /// ms since epoch. Useful to spot stuck readers.
    updatedAt: number;
}

export const ZERO_CURSOR: Cursor = {offset: 0, lastSeq: -1, updatedAt: 0};

export async function loadCursor(path: string): Promise<Cursor> {
    if (!existsSync(path)) return {...ZERO_CURSOR};
    const raw = await readFile(path, "utf8");
    let parsed: unknown;
    try {
        parsed = JSON.parse(raw);
    } catch {
        // Corrupt cursor — safer to re-scan from 0 than to stop the world. This is rare;
        // the only path that produces a corrupt cursor file is `kill -9` between the write
        // and the rename (and our atomic rename should make even that a non-issue).
        return {...ZERO_CURSOR};
    }
    if (typeof parsed !== "object" || parsed === null) return {...ZERO_CURSOR};
    const obj = parsed as Record<string, unknown>;
    if (typeof obj.offset !== "number" || obj.offset < 0) return {...ZERO_CURSOR};
    return {
        offset: obj.offset,
        lastSeq: typeof obj.lastSeq === "number" ? obj.lastSeq : -1,
        updatedAt: typeof obj.updatedAt === "number" ? obj.updatedAt : 0,
    };
}

export async function saveCursor(path: string, cursor: Cursor): Promise<void> {
    await mkdir(dirname(path), {recursive: true}).catch(() => undefined);
    const tmp = `${path}.tmp`;
    await writeFile(tmp, JSON.stringify(cursor));
    await rename(tmp, path);
}
