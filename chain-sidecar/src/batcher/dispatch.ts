import type {LocalAccount} from "viem/accounts";
import {log as defaultLog, type Logger} from "../log.js";
import type {Batcher} from "./batch.js";
import type {VenueMirror} from "../venues/index.js";
import type {SpendRateLimiter} from "../ratelimit/index.js";
import type {GuestAddressCache} from "../derive/cache.js";
import type {GuestSpendEvent} from "../outbox/types.js";
import {signSpendAuth, type SpendAuth, type SpendAuthDomain} from "./sign.js";
import type {SpendNonceTracker} from "./nonces.js";

/// GUEST_SPEND → SpendAuth → Batcher hot path (M3.11 / plan §4.2).
///
/// Replaces the M3.10 stub in `main.ts` that just logged each event. For every accepted
/// `GUEST_SPEND` from the outbox:
///
///   1. Pre-batcher rate-limit (M3.10) — drop runaway spends before any signing work.
///   2. Resolve the venue from the M3.8 mirror cache. Unknown / inactive venues drop with a
///      counter bump; the chain-side `settle` would revert with `VenueNotRegistered` /
///      `VenueInactive` and lose the *whole* batch, so dropping at the producer is mandatory.
///   3. Resolve the guest's address from the M2.3 cache.
///   4. Reserve the next per-guest sig nonce from the local tracker (M3.11 nonce module).
///   5. Sign the EIP-712 SpendAuth via the guest's HD account (M3.1 signer).
///   6. `batcher.accept({auth, signature})` — fire-and-forget; the batcher's flush triggers
///      decide when this becomes a `settle(...)` tx.
///
/// All counters surface on `chain.spend.status` so a stress run can see exactly where events
/// went: dropped vs signed vs accepted vs sink-error.
///
/// **Why it's a class, not a function**: counters live somewhere, the rate-limit / venue /
/// nonce / cache dependencies are passed once at construction (DI-friendly for tests), and the
/// dispatcher is the natural home for any future "skip the auth if the guest's permit hasn't
/// landed yet" gate (an existing M3.6 race acknowledged in the plan).

export interface SpendDispatcherOptions {
    batcher: Batcher;
    venueMirror: VenueMirror | undefined;
    rateLimiter: SpendRateLimiter | undefined;
    guestCache: GuestAddressCache;
    nonces: SpendNonceTracker;
    /// EIP-712 domain for the deployed `SettlementBatcher` (chainId + verifyingContract).
    domain: SpendAuthDomain;
    /// Resolves a guest's `LocalAccount` from its HD index. In production this is
    /// `(idx) => deriveGuest(mnemonic, idx).account`; tests inject a stub.
    deriveAccount: (hdIndex: number) => LocalAccount;
    /// Auth deadline window in seconds (clock-time, not game ticks). The M2.4 reader is
    /// sequential at ~10k events/s under stress; if a batch sits in the relayer queue for an
    /// hour the auth deadline still has hours of headroom. Default: 1 day.
    authDeadlineSeconds?: bigint;
    /// Override `now()` (seconds-since-epoch) for tests. Default `() => BigInt(Math.floor(Date.now()/1000))`.
    nowSeconds?: () => bigint;
    log?: Logger;
}

export const DEFAULT_AUTH_DEADLINE_SECONDS = 24n * 60n * 60n; // 1 day

export interface SpendDispatcherStats {
    /// `accept`-ed by the dispatcher (received from the outbox, not yet judged).
    accepted: number;
    /// Successfully signed and pushed to the batcher.
    signed: number;
    /// Pre-batcher drops, broken out by reason. Sum of these + `signed` == `accepted` modulo
    /// in-flight events (a `dropped*` bump and a `signed` bump are mutually exclusive per
    /// event, but the increment isn't guarded by an atomic — close-enough for metrics).
    droppedRateLimited: number;
    droppedUnknownVenue: number;
    droppedInactiveVenue: number;
    droppedAddressDerivation: number;
    droppedMalformed: number;
    /// Threw inside `signSpendAuth` — distinct from "rejected because malformed" since it
    /// indicates a real signing failure (e.g. account/from mismatch from a producer bug).
    signErrors: number;
    /// Threw inside `nonces.next()` — chain RPC failure on the first-touch fetch.
    nonceErrors: number;
}

export class SpendDispatcher {
    readonly #batcher: Batcher;
    readonly #venueMirror: VenueMirror | undefined;
    readonly #rateLimiter: SpendRateLimiter | undefined;
    readonly #guestCache: GuestAddressCache;
    readonly #nonces: SpendNonceTracker;
    readonly #domain: SpendAuthDomain;
    readonly #deriveAccount: (hdIndex: number) => LocalAccount;
    readonly #authDeadline: bigint;
    readonly #nowSeconds: () => bigint;
    readonly #log: Logger;

    #accepted = 0;
    #signed = 0;
    #droppedRateLimited = 0;
    #droppedUnknownVenue = 0;
    #droppedInactiveVenue = 0;
    #droppedAddressDerivation = 0;
    #droppedMalformed = 0;
    #signErrors = 0;
    #nonceErrors = 0;

    constructor(opts: SpendDispatcherOptions) {
        this.#batcher = opts.batcher;
        this.#venueMirror = opts.venueMirror;
        this.#rateLimiter = opts.rateLimiter;
        this.#guestCache = opts.guestCache;
        this.#nonces = opts.nonces;
        this.#domain = opts.domain;
        this.#deriveAccount = opts.deriveAccount;
        this.#authDeadline = opts.authDeadlineSeconds ?? DEFAULT_AUTH_DEADLINE_SECONDS;
        this.#nowSeconds = opts.nowSeconds ?? (() => BigInt(Math.floor(Date.now() / 1000)));
        this.#log = (opts.log ?? defaultLog).child({mod: "spend-dispatch"});
    }

    /// Process one outbox event. Awaiting this returns when the auth has been pushed to the
    /// batcher (or the event was dropped). The reader is sequential — `accept` returning fast
    /// is what keeps the WAL drain at line rate.
    async handle(event: GuestSpendEvent): Promise<void> {
        this.#accepted++;

        // (1) Rate-limit. Drop pre-batcher; M3.10's existing counter is also bumped on the
        // `consume()` path, but we double-track here to localise the dispatcher's metric
        // surface (operators looking at `chain.spend.status` shouldn't have to cross-reference
        // the rate-limiter to understand drop reasons).
        if (this.#rateLimiter && !this.#rateLimiter.consume(event.hdIndex)) {
            this.#droppedRateLimited++;
            return;
        }

        // (2) Venue lookup. The mirror's cache is hot-path safe (in-memory Map). Without a
        // mirror configured (offline / unit tests) we let the spend through — the receiving
        // chain would still revert, but that's the operator's problem in that mode.
        let venueResolved = true;
        if (this.#venueMirror) {
            const venue = this.#venueMirror.lookup(event.venueId);
            if (!venue) {
                this.#droppedUnknownVenue++;
                this.#log.warn(
                    {hdIndex: event.hdIndex, venueId: event.venueId, guestId: event.guestId},
                    "GUEST_SPEND: venue not in mirror cache — dropping (would revert VenueNotRegistered)",
                );
                venueResolved = false;
            } else if (!venue.active) {
                this.#droppedInactiveVenue++;
                this.#log.warn(
                    {hdIndex: event.hdIndex, venueId: event.venueId},
                    "GUEST_SPEND: venue inactive — dropping (would revert VenueInactive)",
                );
                venueResolved = false;
            }
        }
        if (!venueResolved) return;

        // (3) Guest address. The M2.3 cache derives lazily and pins; an unparseable hdIndex is
        // a producer bug worth surfacing as a counter.
        let address: `0x${string}`;
        try {
            address = this.#guestCache.addressOf(event.hdIndex);
        } catch (err) {
            this.#droppedAddressDerivation++;
            this.#log.warn({err, event}, "GUEST_SPEND: address derivation failed");
            return;
        }

        // (4) Amount + deadline. We parse the decimal string here (rather than at outbox-read
        // time) so a malformed amount stays a per-event drop rather than a parser-level error
        // that takes down the WAL line.
        let amount: bigint;
        try {
            amount = BigInt(event.amount);
            if (amount < 0n) throw new Error("negative");
        } catch (err) {
            this.#droppedMalformed++;
            this.#log.warn({err, amount: event.amount, event}, "GUEST_SPEND: invalid amount");
            return;
        }
        if (
            !Number.isInteger(event.gameTick) ||
            event.gameTick < 0 ||
            !Number.isInteger(event.category) ||
            event.category < 0 ||
            event.category > 0xff
        ) {
            this.#droppedMalformed++;
            this.#log.warn({event}, "GUEST_SPEND: invalid gameTick/category");
            return;
        }
        const deadline = this.#nowSeconds() + this.#authDeadline;

        // (5) Reserve the per-guest sig nonce. First call per address triggers a chain read;
        // subsequent calls are O(1) Map ops. Errors here are RPC errors — counted, dropped,
        // not retried (a future M3.x can retry transient failures by re-feeding the WAL).
        let nonce: bigint;
        try {
            nonce = await this.#nonces.next(address);
        } catch (err) {
            this.#nonceErrors++;
            this.#log.error({err, address, event}, "GUEST_SPEND: nonce fetch failed");
            return;
        }

        const auth: SpendAuth = {
            from: address,
            venueId: event.venueId,
            category: event.category,
            amount,
            nonce,
            deadline,
            gameTick: BigInt(event.gameTick),
        };

        // (6) Sign and push. `signSpendAuth` re-validates the auth shape inside; double-check
        // is cheap relative to the secp256k1 sign and catches a class of drift bugs early.
        let signature;
        try {
            const account = this.#deriveAccount(event.hdIndex);
            signature = await signSpendAuth(account, this.#domain, auth);
        } catch (err) {
            this.#signErrors++;
            this.#log.error({err, address, event}, "GUEST_SPEND: signing failed");
            return;
        }

        this.#batcher.accept({auth, signature});
        this.#signed++;
    }

    stats(): SpendDispatcherStats {
        return {
            accepted: this.#accepted,
            signed: this.#signed,
            droppedRateLimited: this.#droppedRateLimited,
            droppedUnknownVenue: this.#droppedUnknownVenue,
            droppedInactiveVenue: this.#droppedInactiveVenue,
            droppedAddressDerivation: this.#droppedAddressDerivation,
            droppedMalformed: this.#droppedMalformed,
            signErrors: this.#signErrors,
            nonceErrors: this.#nonceErrors,
        };
    }
}
