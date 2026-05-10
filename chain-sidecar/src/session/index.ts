import {randomBytes} from "node:crypto";
import {MAX_EPOCH} from "../venues/epoch.js";

/// Per-game-session identity. The game emits `chain.session.begin { sessionId }` on every
/// "new park" boundary; everything that's keyed on a session-scoped value (guest HD
/// derivation, venue chain id epoch, rate-limit buckets, sig-nonce cache, venue mirror
/// cache) reads from this object so a single mutation flips them all in one shot.
///
/// Width: 16 bits. The on-chain `VenueRegistry` venue id is `uint32`, split as
/// `(epoch << 16) | gameId` (`venues/epoch.ts`); the high 16 bits are the only namespace
/// we have for venues without a contract change. We use the same width for the BIP-44
/// `accountIndex` in guest derivation so two sessions with distinct ids get distinct
/// guest addresses *and* distinct venue chain ids in lockstep — no risk of one space
/// disagreeing with the other.
///
/// Subscribers register a reset callback via `onChange` and the context fires them all
/// on `change`. Order is registration order; failures bubble up (a bad subscriber crashes
/// the session-begin IPC call rather than leaving half the system on the new session and
/// half on the old).

export const SESSION_ID_BITS = 16;
export const MAX_SESSION_ID = (1 << SESSION_ID_BITS) - 1;

export function generateSessionId(): number {
    return randomBytes(2).readUInt16BE(0);
}

export function validateSessionId(id: number): number {
    if (!Number.isInteger(id) || id < 0 || id > MAX_SESSION_ID) {
        throw new Error(`sessionId out of [0, ${MAX_SESSION_ID}] range: ${id}`);
    }
    return id;
}

export function formatSessionId(id: number): string {
    return `0x${id.toString(16).padStart(4, "0")}`;
}

export class SessionContext {
    #sessionId: number;
    #subscribers: Array<(prev: number, next: number) => void> = [];

    constructor(initialSessionId: number) {
        this.#sessionId = validateSessionId(initialSessionId);
    }

    /// Current session id. The same value is used both as the venue epoch (`& 0xFFFF`,
    /// which is a no-op when sessionId is 16-bit) and as the BIP-44 `accountIndex` for
    /// guest HD derivation.
    get sessionId(): number {
        return this.#sessionId;
    }

    /// Same value, exposed under the legacy "epoch" name for callers that already speak
    /// `applyEpoch(epoch, gameId)`. Mirror of `sessionId & MAX_EPOCH`.
    get epoch(): number {
        return this.#sessionId & MAX_EPOCH;
    }

    /// Register a reset callback. Fired (in registration order) when `change` is called
    /// with a different id. Idempotent transitions (`change(currentId)`) are skipped so
    /// re-applying the same id at boot is a no-op rather than a forced cache wipe.
    onChange(cb: (prev: number, next: number) => void): void {
        this.#subscribers.push(cb);
    }

    /// Switch to a new session. Returns true if the id changed (and subscribers fired);
    /// false if the new id matches the current one (no-op).
    change(newSessionId: number): boolean {
        validateSessionId(newSessionId);
        if (newSessionId === this.#sessionId) return false;
        const prev = this.#sessionId;
        this.#sessionId = newSessionId;
        for (const cb of this.#subscribers) cb(prev, newSessionId);
        return true;
    }
}
