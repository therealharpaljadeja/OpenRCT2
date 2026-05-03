/// Per-guest spend rate limiter (M3.10 / plan §10). One token bucket per `hdIndex`; refills
/// at `maxAuthPerSecond`/sec; rejects + counts when empty so a runaway guest can't dominate
/// the batch.
export {
    SpendRateLimiter,
    DEFAULT_PER_GUEST_AUTH_PER_SEC,
    MAX_PER_GUEST_AUTH_PER_SEC,
    type SpendRateLimiterOptions,
    type SpendRateLimiterStats,
} from "./spend.js";
