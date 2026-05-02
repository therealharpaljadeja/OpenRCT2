/// Mirrors `VenueRegistry` — drains `VENUE_REGISTERED` / `_RENAMED` / `_REMOVED` outbox events
/// and submits one admin tx per event. Caches the venue table locally. Lands in M3.8.
export {};
