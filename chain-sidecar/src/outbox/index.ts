/// Drains game-side spend / venue / loan events from the on-disk outbox + WAL and feeds them
/// into the rest of the sidecar. M2.4 lands the WAL format, the writer (test producer until
/// the game-side outbox arrives in M4.1), and the polling reader with cursor durability.
export type {
    OutboxEvent,
    OutboxEventKind,
    GuestEntryEvent,
    GuestSpendEvent,
    GuestExitEvent,
    VenueRegisteredEvent,
    VenueRenamedEvent,
    VenueRemovedEvent,
    OutboxEventWithoutSeq,
    ParseResult,
} from "./types.js";
export {parseEvent, serializeEvent} from "./types.js";
export {
    OutboxWriter,
    DEFAULT_MAX_BYTES,
    MAX_MAX_BYTES,
    type OutboxWriterOptions,
    type OutboxWriterStats,
} from "./wal.js";
export {OutboxReader, type OutboxReaderOptions, type OutboxReaderStats, type EventHandler} from "./reader.js";
export {loadCursor, saveCursor, ZERO_CURSOR, type Cursor} from "./cursor.js";
