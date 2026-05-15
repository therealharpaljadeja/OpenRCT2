/// VenueMirror (plan §3.1 / §4.5 / M3.8). Drains `VENUE_REGISTERED` / `_RENAMED` / `_REMOVED`
/// outbox events, submits one admin tx per event, and caches the venue table locally so the
/// spend batcher (M3.x) can resolve venueId → kind / subAccount without a chain read.
export {
    VenueMirror,
    DEFAULT_VENUE_MIRROR_MAX_QUEUED,
    SUBACCOUNT_INIT_CODE_HASH,
    subAccountOf,
    type VenueKind,
    type CachedVenue,
    type VenueMirrorEvent,
    type VenueMirrorOptions,
    type VenueMirrorStats,
} from "./mirror.js";
