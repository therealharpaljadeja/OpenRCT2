import {randomBytes} from "node:crypto";

/// Per-session venue id namespace.
///
/// Game-side ride indices (`gameId`) restart at 1 for every park. The on-chain `VenueRegistry`
/// is global and persists across sessions, so naive use causes collisions: park A registers id
/// 2, park B then tries to register id 2 and reverts with `AlreadyRegistered`.
///
/// We split the uint32 id space: the high 16 bits are a per-sidecar-boot `epoch`, the low 16
/// bits are the game's ride index. The sidecar generates a fresh random epoch at startup; every
/// `VENUE_*` and `GUEST_SPEND` event coming off the outbox has its `venueId` translated
/// `(epoch << 16) | gameId` before entering the rest of the pipeline. Internals only ever see
/// chainIds; the game keeps emitting raw ride indices.
///
/// A 16-bit epoch gives ~65k distinct sessions before namespace pressure — plenty for a demo.
/// If you need more, widen the contract to bytes32 (separate refactor).
export const EPOCH_BITS = 16;
export const GAME_ID_BITS = 16;
export const MAX_EPOCH = (1 << EPOCH_BITS) - 1;
export const MAX_GAME_ID = (1 << GAME_ID_BITS) - 1;
const GAME_ID_MASK = MAX_GAME_ID;

export function generateEpoch(): number {
    return randomBytes(2).readUInt16BE(0);
}

export function validateEpoch(epoch: number): number {
    if (!Number.isInteger(epoch) || epoch < 0 || epoch > MAX_EPOCH) {
        throw new Error(`epoch out of [0, ${MAX_EPOCH}] range: ${epoch}`);
    }
    return epoch;
}

/// Compose the on-chain venue id from `(epoch, gameId)`. Throws on out-of-range gameId so a
/// malformed event becomes a per-event drop at the call site rather than a silently-wrong id.
export function applyEpoch(epoch: number, gameId: number): number {
    validateEpoch(epoch);
    if (!Number.isInteger(gameId) || gameId < 0 || gameId > MAX_GAME_ID) {
        throw new Error(`gameId out of [0, ${MAX_GAME_ID}] range: ${gameId}`);
    }
    // `* (1<<16)` instead of `<<` because `<<` returns a *signed* 32-bit int and trips on
    // epochs >= 0x8000 (top bit set → negative number after the shift).
    return epoch * (1 << GAME_ID_BITS) + (gameId & GAME_ID_MASK);
}

export function gameIdFromChainId(chainId: number): number {
    return chainId & GAME_ID_MASK;
}

export function epochFromChainId(chainId: number): number {
    return Math.floor(chainId / (1 << GAME_ID_BITS)) & MAX_EPOCH;
}

export function formatEpoch(epoch: number): string {
    return `0x${epoch.toString(16).padStart(4, "0")}`;
}
