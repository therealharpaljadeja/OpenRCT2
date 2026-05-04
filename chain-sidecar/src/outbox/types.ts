/// Outbox event types — the wire contract between the game's hot-path producer (M4.1) and
/// the sidecar's consumer (M2.4 / M3.x).
///
/// On-disk format: newline-delimited JSON (NDJSON). Each event is one JSON object terminated
/// by a single `\n`. Lines that fail to parse are skipped with a `parse_errors` counter bump
/// — never let one bad line stall the whole drain.
///
/// **Format invariants** (M4.1 must match):
/// 1. UTF-8. POSIX append writes ≤ PIPE_BUF are atomic; events must stay under that to keep
///    the SPSC reader-while-writing case torn-write-free. ~1 KB / event is the realistic max.
/// 2. Monotonic `seq` starting at 0; producers must not reuse or skip values. Used purely for
///    debug / sanity (the cursor is a byte offset — see `reader.ts`), but the assertion is
///    cheap and catches producer bugs early.
/// 3. `ts` is ms since Unix epoch (game wall-clock, not ticks; ticks live inside payloads
///    that need them).
/// 4. Numeric monetary amounts are decimal *strings* — JSON has no BigInt. Same convention as
///    contract-side `uint256`.
///
/// **Why no schema version field**: this format only exists between two binaries built from
/// the same repo / commit. If we ever fork the format we bump it on both sides in lockstep.
/// Adding `v` to every event is just bytes for no value at this stage.

export type OutboxEvent =
    | GuestEntryEvent
    | GuestSpendEvent
    | GuestExitEvent
    | VenueRegisteredEvent
    | VenueRenamedEvent
    | VenueRemovedEvent;

export type OutboxEventKind = OutboxEvent["kind"];

/// `Omit<T, K>` doesn't distribute over unions — it returns the *intersection* of the
/// per-branch shapes, dropping every discriminator-specific field. This distributive form
/// preserves each branch independently, which is what callers like `OutboxWriter.append`
/// actually want when they take a "seqless" event from a producer.
export type OutboxEventWithoutSeq = OutboxEvent extends infer T
    ? T extends OutboxEvent
        ? Omit<T, "seq">
        : never
    : never;

interface BaseEvent {
    /// Monotonic per-WAL sequence number. Starts at 0.
    seq: number;
    /// ms since epoch (real wall-clock, not game ticks).
    ts: number;
}

/// Guest spawned at the park gate (plan §5.2). Triggers PARK funding (M3.5) and permit
/// collection (M3.6). The sidecar derives the address from `hdIndex` and echoes it back to
/// the game via `chain.guest.assigned` so the game can stamp `Guest::OnchainAddress`.
export interface GuestEntryEvent extends BaseEvent {
    kind: "GUEST_ENTRY";
    guestId: number;
    hdIndex: number;
    /// Cash the game put in this guest's pocket — exact disperseToken amount.
    cash: string;
}

/// Guest paid a venue (plan §5.2, §3.2). Hot-path event — this is what the batcher (M3.2)
/// converts into EIP-712 SpendAuths.
export interface GuestSpendEvent extends BaseEvent {
    kind: "GUEST_SPEND";
    guestId: number;
    /// HD derivation index. The future spend signer (M3.x) needs it to derive the guest's
    /// EIP-712 signing key on the hot path; the M3.10 rate limiter keys per-guest buckets
    /// off it as well so `forget(hdIndex)` on GUEST_EXIT lines up.
    hdIndex: number;
    venueId: number;
    /// Decimal string (PARK is 18-decimals; values can exceed JS number precision).
    amount: string;
    /// Mirrors the contract enum: ride-fare, shop-primary, shop-secondary, facility-use,
    /// entry, atm-fee. Producers send the integer value; consumers narrow if they care.
    category: number;
    /// In-game tick the spend happened on. Surfaces on `GuestSpend` events for indexers.
    gameTick: number;
}

/// Guest leaves the park (plan §5.2). Sidecar sweeps remaining PARK back to treasury (M3.7).
/// `hdIndex` is required because the sweeper needs the guest's HDAccount to sign a fresh
/// permit (entry-time permit is for SettlementBatcher; sweep needs spender=treasury).
export interface GuestExitEvent extends BaseEvent {
    kind: "GUEST_EXIT";
    guestId: number;
    hdIndex: number;
}

/// Ride / shop / stall / facility / entrance placed (plan §3.1, §5.2). Low-volume admin
/// path — the venue mirror (M3.8) submits one tx per event.
export interface VenueRegisteredEvent extends BaseEvent {
    kind: "VENUE_REGISTERED";
    venueId: number;
    /// Mirrors the contract `VenueKind` enum: ParkEntrance / Ride / Shop / Stall / Facility / ATM.
    venueKind: number;
    name: string;
    objectType: string;
}

export interface VenueRenamedEvent extends BaseEvent {
    kind: "VENUE_RENAMED";
    venueId: number;
    newName: string;
}

export interface VenueRemovedEvent extends BaseEvent {
    kind: "VENUE_REMOVED";
    venueId: number;
}

/// Result of `parseEvent`. Distinguishes "valid event" from "garbage" so callers can decide
/// whether to skip + bump a counter (production) vs throw (tests).
export type ParseResult = {ok: true; event: OutboxEvent} | {ok: false; error: string};

/// Strict, hand-rolled validator. We don't pull zod/ajv for this — the schema is small,
/// parsing happens at WAL drain rate (well under 10k/s for our scope), and a custom checker
/// gives us the exact "skip the bad line, log the reason" semantics the reader wants.
export function parseEvent(line: string): ParseResult {
    let raw: unknown;
    try {
        raw = JSON.parse(line);
    } catch (err) {
        return {ok: false, error: `invalid JSON: ${err instanceof Error ? err.message : String(err)}`};
    }
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
        return {ok: false, error: "event must be a JSON object"};
    }
    const obj = raw as Record<string, unknown>;
    const seqOk = typeof obj.seq === "number" && Number.isInteger(obj.seq) && obj.seq >= 0;
    if (!seqOk) return {ok: false, error: `bad seq: ${String(obj.seq)}`};
    if (typeof obj.ts !== "number" || !Number.isFinite(obj.ts)) {
        return {ok: false, error: `bad ts: ${String(obj.ts)}`};
    }
    if (typeof obj.kind !== "string") return {ok: false, error: `bad kind: ${String(obj.kind)}`};

    switch (obj.kind) {
        case "GUEST_ENTRY":
            if (typeof obj.guestId !== "number" || typeof obj.hdIndex !== "number") {
                return {ok: false, error: "GUEST_ENTRY missing guestId/hdIndex"};
            }
            if (typeof obj.cash !== "string") return {ok: false, error: "GUEST_ENTRY.cash must be string"};
            return {ok: true, event: obj as unknown as GuestEntryEvent};
        case "GUEST_SPEND":
            if (
                typeof obj.guestId !== "number" ||
                typeof obj.hdIndex !== "number" ||
                typeof obj.venueId !== "number" ||
                typeof obj.amount !== "string" ||
                typeof obj.category !== "number" ||
                typeof obj.gameTick !== "number"
            ) {
                return {ok: false, error: "GUEST_SPEND missing/invalid fields"};
            }
            return {ok: true, event: obj as unknown as GuestSpendEvent};
        case "GUEST_EXIT":
            if (typeof obj.guestId !== "number" || typeof obj.hdIndex !== "number") {
                return {ok: false, error: "GUEST_EXIT missing guestId/hdIndex"};
            }
            return {ok: true, event: obj as unknown as GuestExitEvent};
        case "VENUE_REGISTERED":
            if (
                typeof obj.venueId !== "number" ||
                typeof obj.venueKind !== "number" ||
                typeof obj.name !== "string" ||
                typeof obj.objectType !== "string"
            ) {
                return {ok: false, error: "VENUE_REGISTERED missing/invalid fields"};
            }
            return {ok: true, event: obj as unknown as VenueRegisteredEvent};
        case "VENUE_RENAMED":
            if (typeof obj.venueId !== "number" || typeof obj.newName !== "string") {
                return {ok: false, error: "VENUE_RENAMED missing/invalid fields"};
            }
            return {ok: true, event: obj as unknown as VenueRenamedEvent};
        case "VENUE_REMOVED":
            if (typeof obj.venueId !== "number") return {ok: false, error: "VENUE_REMOVED.venueId missing"};
            return {ok: true, event: obj as unknown as VenueRemovedEvent};
        default:
            return {ok: false, error: `unknown kind: ${String(obj.kind)}`};
    }
}

/// Serialize for write. Producers should never re-implement this — the format is a wire
/// contract and going through one helper keeps the two sides in sync.
export function serializeEvent(event: OutboxEvent): string {
    return `${JSON.stringify(event)}\n`;
}
