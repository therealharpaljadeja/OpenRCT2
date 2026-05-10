import {log as defaultLog, type Logger} from "../log.js";

/// Per-guest spend rate limiter (plan §10: "Hard cap on per-guest spend rate (e.g. 10
/// auth/sec/guest) to prevent runaways; configurable.").
///
/// One token bucket per guest, keyed on `hdIndex`. The bucket refills continuously at
/// `maxAuthPerSecond` tokens/sec, capped at `maxAuthPerSecond` tokens (so a guest who's been
/// idle has up to one second of burst). Each `consume(hdIndex)` call returns true and
/// debits a token if one is available, false otherwise. False = drop the spend at the
/// dispatcher and bump the counter; the game keeps running (plan §4.2 backpressure shape).
///
/// Why per-guest, not global: a single buggy guest in a tight loop is the runaway shape we
/// want to bound. Global throttling would cap honest concurrent spend; per-guest only
/// constrains the abuser. The bucket map grows with the active guest set; `forget(hdIndex)`
/// is called on `GUEST_EXIT` so the map doesn't accumulate ghost buckets across park sessions.
///
/// Why a bucket, not a sliding-window counter: O(1) state per guest (`tokens`,
/// `lastRefillMs`) vs O(rate × window) timestamps. At 10 auth/sec/guest × 5000 guests we
/// stay under 200 KB of bucket state regardless of throughput.

export const DEFAULT_PER_GUEST_AUTH_PER_SEC = 10;
/// Upper bound on the configured rate. 10k/sec/guest is comically high — even at that rate
/// a single guest would saturate the entire 5k auth/sec target. The cap is for fat-finger
/// protection, not a real ceiling. `chain.ratelimit.config` rejects above this.
export const MAX_PER_GUEST_AUTH_PER_SEC = 10_000;

export interface SpendRateLimiterOptions {
    maxAuthPerSecond?: number;
    log?: Logger;
    /// Injectable clock for tests.
    now?: () => number;
}

export interface SpendRateLimiterStats {
    maxAuthPerSecond: number;
    accepted: number;
    rejected: number;
    /// Number of guests with a tracked bucket. Bounded by the active guest set; drops on
    /// `forget(hdIndex)` (GUEST_EXIT).
    guestsTracked: number;
}

interface Bucket {
    tokens: number;
    lastRefillMs: number;
}

export class SpendRateLimiter {
    readonly #log: Logger;
    readonly #now: () => number;
    #max: number;
    readonly #buckets = new Map<number, Bucket>();
    #accepted = 0;
    #rejected = 0;

    constructor(opts: SpendRateLimiterOptions = {}) {
        const max = opts.maxAuthPerSecond ?? DEFAULT_PER_GUEST_AUTH_PER_SEC;
        validateMaxAuthPerSecond(max);
        this.#max = max;
        this.#log = (opts.log ?? defaultLog).child({mod: "ratelimit"});
        this.#now = opts.now ?? Date.now;
    }

    /// Try to consume one token for `hdIndex`. Returns true if the spend may proceed; false
    /// if the guest has exhausted their bucket. Time complexity O(1).
    consume(hdIndex: number): boolean {
        if (!Number.isInteger(hdIndex) || hdIndex < 0) {
            // Garbage in → drop. Counts as a rejection so the operator sees something is
            // wrong; we don't throw because the caller is the outbox dispatcher which must
            // not stall on bad data.
            this.#rejected++;
            return false;
        }
        const now = this.#now();
        let b = this.#buckets.get(hdIndex);
        if (!b) {
            b = {tokens: this.#max, lastRefillMs: now};
            this.#buckets.set(hdIndex, b);
        } else if (now > b.lastRefillMs) {
            const elapsedSec = (now - b.lastRefillMs) / 1000;
            b.tokens = Math.min(this.#max, b.tokens + elapsedSec * this.#max);
            b.lastRefillMs = now;
        }
        if (b.tokens >= 1) {
            b.tokens -= 1;
            this.#accepted++;
            return true;
        }
        this.#rejected++;
        return false;
    }

    /// Drop a guest's bucket. Called on GUEST_EXIT so the map doesn't grow unbounded across
    /// park sessions. Idempotent.
    forget(hdIndex: number): void {
        this.#buckets.delete(hdIndex);
    }

    /// Drop every bucket. Used on a session-change (a new game starts): hdIndex 0 of the
    /// new session would otherwise inherit the depleted bucket of hdIndex 0 from the old
    /// session and get rate-limited unfairly for the first second. Counters are preserved
    /// — they're cumulative over the sidecar's lifetime, useful for comparing sessions.
    clear(): void {
        this.#buckets.clear();
    }

    /// Hot-tunable knob (operator can lower under abuse, raise during stress mode). Throws
    /// on invalid input so the IPC layer maps to InvalidParams.
    updateConfig(maxAuthPerSecond: number): void {
        validateMaxAuthPerSecond(maxAuthPerSecond);
        // Existing buckets keep their current `tokens` value; a new ceiling only constrains
        // future refills. A guest mid-burst with 7 tokens won't be capped to a new lower
        // ceiling until they spend down + refill — that's fine, the cap converges quickly
        // and we'd rather not strand existing tokens.
        this.#max = maxAuthPerSecond;
        this.#log.info({maxAuthPerSecond}, "rate limiter reconfigured");
    }

    stats(): SpendRateLimiterStats {
        return {
            maxAuthPerSecond: this.#max,
            accepted: this.#accepted,
            rejected: this.#rejected,
            guestsTracked: this.#buckets.size,
        };
    }
}

function validateMaxAuthPerSecond(n: number): void {
    if (!Number.isFinite(n) || n <= 0 || n > MAX_PER_GUEST_AUTH_PER_SEC) {
        throw new Error(
            `maxAuthPerSecond must be in (0, ${MAX_PER_GUEST_AUTH_PER_SEC}], got ${n}`,
        );
    }
}
