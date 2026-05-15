import {OutboxWriter} from "../outbox/index.js";
import type {Logger} from "../log.js";
import {log as defaultLog} from "../log.js";
import {waitForVenues} from "./sidecar-client.js";

/// Synthetic outbox event generator (M3.11).
///
/// The throughput demo doesn't need a running RCT2 game in the loop to stress-test the
/// sidecar's hot path — it needs `GUEST_SPEND` events landing in the WAL at a configurable
/// rate. This module produces them.
///
/// Two modes:
///   - **bootstrap**: emit `VENUE_REGISTERED` for `venues` ids, then `GUEST_ENTRY` for
///     `guests` HD indexes, then `GUEST_SPEND` at `rate` per second. The sidecar exercises
///     the funder + permit + venue-mirror admin paths in addition to the spend hot path —
///     this is the closest analogue to a real game-side producer.
///   - **spend-only**: skip the bootstrap events entirely and assume the operator has
///     pre-funded + pre-permitted the guest set out of band. Used when we want to measure
///     batcher + relayer throughput in isolation, without the funder/permit windows
///     contributing to the metrics.
///
/// The generator writes through `OutboxWriter` (M2.4), so the on-disk format is exactly what
/// M4.1's game-side writer will produce. The `OutboxReader` already in `main.ts` consumes
/// these events without modification — the harness is invisible to the rest of the sidecar.
///
/// Rate model: a pseudo-fixed-tick loop. We pick `tickMs` (default 10) and compute
/// `eventsPerTick = round(rate * tickMs / 1000)`. Each tick writes that many events and
/// awaits the next tick boundary. At 5000 auth/s + 10ms tick that's 50 events/tick — well
/// inside what `OutboxWriter.append` can handle without backing up the loop. If a tick
/// overruns, we don't try to "catch up" — we just log + drop the deficit so the next tick
/// stays on schedule. Stats surface the achieved rate so an operator can spot under-runs.

export interface StressGeneratorOptions {
    writer: OutboxWriter;
    /// Number of distinct guests to emit. HD indexes are 0..guests-1; the sidecar derives
    /// each guest's address via its existing `GuestAddressCache`.
    guests: number;
    /// Number of distinct venues. Venue ids are 1..venues (id 0 is reserved for the park
    /// entrance per plan §3.2 / §5.2). When `bootstrap=true`, the generator emits
    /// `VENUE_REGISTERED` for each id at startup.
    venues: number;
    /// Target authorizations per second. The actual achieved rate is reported in stats.
    rate: number;
    /// Total run length in seconds. 0 = unbounded; the caller is responsible for stopping.
    durationSeconds: number;
    /// Cash to give each guest at entry. Default 100 PARK.
    cashPerGuestWei?: bigint;
    /// Spend amount range. Each spend picks `min + rand(max - min)`. Default 1..10 PARK.
    spendMinWei?: bigint;
    spendMaxWei?: bigint;
    /// Tick granularity. Default 10ms — coarse enough that per-tick bookkeeping is cheap,
    /// fine enough that 5000+ auth/s rates don't bunch into noticeable bursts.
    tickMs?: number;
    /// Skip the bootstrap (`VENUE_REGISTERED` + `GUEST_ENTRY`) events. Use when the
    /// operator has pre-funded + pre-permitted guests out of band.
    skipBootstrap?: boolean;
    /// M3.12 — Fix 3: when set together with `bootstrapWaitSecs > 0`, after writing the
    /// bootstrap events the harness polls `chain.venues.status` over this UDS socket
    /// until the venue mirror's cache size matches the expected count. Without this, the
    /// spend loop starts immediately and the first ~5 s of spends drop with
    /// `dispatcherUnknownVenue` because the mirror is still landing each VENUE_REGISTERED
    /// admin tx. No-op when omitted (current behavior preserved).
    sidecarSocket?: string;
    /// Max time to wait for the venue cache to fill. Ignored when `sidecarSocket` is omitted.
    /// Default 60 s — comfortable headroom for ~50 venues × 1–2 s/tx.
    bootstrapWaitSecs?: number;
    log?: Logger;
    now?: () => number;
}

export interface StressGeneratorStats {
    /// `GUEST_ENTRY` events written.
    entries: number;
    /// `VENUE_REGISTERED` events written.
    venuesRegistered: number;
    /// `GUEST_SPEND` events written.
    spends: number;
    /// Cumulative ticks. `spends/ticks * (1000/tickMs)` ≈ achieved auth/s.
    ticks: number;
    /// Ticks where the loop ran late (didn't keep up with the schedule). A non-zero value
    /// past the bootstrap means the harness can't sustain the requested rate on this host —
    /// either drop `--rate` or increase `--tick-ms`.
    overruns: number;
    /// Tick where the loop slept *less* than 0ms (i.e. the previous tick took longer than
    /// `tickMs`). Distinct from `overruns` (which counts tick-deadline misses); a steady-state
    /// `behindBy` > 0 says the writer.append latency dominates.
    maxBehindMs: number;
    /// Wall-clock duration of the run, in ms. Includes bootstrap.
    elapsedMs: number;
}

const DEFAULT_TICK_MS = 10;
const DEFAULT_CASH_WEI = 100n * 10n ** 18n; // 100 PARK
const DEFAULT_SPEND_MIN_WEI = 10n ** 18n; // 1 PARK
const DEFAULT_SPEND_MAX_WEI = 10n * 10n ** 18n; // 10 PARK

export class StressGenerator {
    readonly #writer: OutboxWriter;
    readonly #guests: number;
    readonly #venues: number;
    readonly #rate: number;
    readonly #durationSeconds: number;
    readonly #cashPerGuestWei: bigint;
    readonly #spendMinWei: bigint;
    readonly #spendRangeWei: bigint;
    readonly #tickMs: number;
    readonly #skipBootstrap: boolean;
    readonly #sidecarSocket: string | undefined;
    readonly #bootstrapWaitSecs: number;
    readonly #log: Logger;
    readonly #now: () => number;
    #stopRequested = false;

    constructor(opts: StressGeneratorOptions) {
        if (!Number.isInteger(opts.guests) || opts.guests < 1 || opts.guests > 1_000_000) {
            throw new Error(`guests must be an integer in [1, 1_000_000], got ${opts.guests}`);
        }
        if (!Number.isInteger(opts.venues) || opts.venues < 1 || opts.venues > 65_535) {
            throw new Error(`venues must be an integer in [1, 65_535], got ${opts.venues}`);
        }
        if (!Number.isFinite(opts.rate) || opts.rate <= 0 || opts.rate > 50_000) {
            throw new Error(`rate must be in (0, 50_000], got ${opts.rate}`);
        }
        if (!Number.isFinite(opts.durationSeconds) || opts.durationSeconds < 0) {
            throw new Error(`durationSeconds must be >= 0, got ${opts.durationSeconds}`);
        }
        const tickMs = opts.tickMs ?? DEFAULT_TICK_MS;
        if (!Number.isInteger(tickMs) || tickMs < 1 || tickMs > 1_000) {
            throw new Error(`tickMs must be an integer in [1, 1000], got ${tickMs}`);
        }
        const spendMin = opts.spendMinWei ?? DEFAULT_SPEND_MIN_WEI;
        const spendMax = opts.spendMaxWei ?? DEFAULT_SPEND_MAX_WEI;
        if (spendMin <= 0n || spendMax <= spendMin) {
            throw new Error(`spendMinWei/spendMaxWei out of range`);
        }

        this.#writer = opts.writer;
        this.#guests = opts.guests;
        this.#venues = opts.venues;
        this.#rate = opts.rate;
        this.#durationSeconds = opts.durationSeconds;
        this.#cashPerGuestWei = opts.cashPerGuestWei ?? DEFAULT_CASH_WEI;
        this.#spendMinWei = spendMin;
        this.#spendRangeWei = spendMax - spendMin;
        this.#tickMs = tickMs;
        this.#skipBootstrap = opts.skipBootstrap ?? false;
        this.#sidecarSocket = opts.sidecarSocket;
        const waitSecs = opts.bootstrapWaitSecs ?? 60;
        if (!Number.isFinite(waitSecs) || waitSecs < 0 || waitSecs > 600) {
            throw new Error(`bootstrapWaitSecs must be in [0, 600], got ${waitSecs}`);
        }
        this.#bootstrapWaitSecs = waitSecs;
        this.#log = (opts.log ?? defaultLog).child({mod: "stress"});
        this.#now = opts.now ?? Date.now;
    }

    /// Run a stop signal. Idempotent.
    stop(): void {
        this.#stopRequested = true;
    }

    /// Bootstrap + spend loop. Returns final stats.
    async run(): Promise<StressGeneratorStats> {
        const startedAt = this.#now();
        let entries = 0;
        let venuesRegistered = 0;
        let spends = 0;
        let ticks = 0;
        let overruns = 0;
        let maxBehindMs = 0;

        if (!this.#skipBootstrap) {
            // VENUE_REGISTERED for ids 1..V. The mirror's idempotency catches duplicates on
            // re-runs; we always emit because the registry might have been re-deployed
            // between runs.
            for (let id = 1; id <= this.#venues; id++) {
                if (this.#stopRequested) break;
                await this.#writer.append({
                    kind: "VENUE_REGISTERED",
                    ts: this.#now(),
                    venueId: id,
                    venueKind: 1, // Ride — most common; the on-chain effect doesn't depend on it
                    name: `Stress Venue ${id}`,
                    objectType: "rct2.stress.venue",
                });
                venuesRegistered++;
            }
            // GUEST_ENTRY for hdIndex 0..N-1. The sidecar's funder + permit collector each
            // batch these in their own windows; the harness doesn't need to throttle here.
            for (let i = 0; i < this.#guests; i++) {
                if (this.#stopRequested) break;
                await this.#writer.append({
                    kind: "GUEST_ENTRY",
                    ts: this.#now(),
                    guestId: i,
                    hdIndex: i,
                    cash: this.#cashPerGuestWei.toString(),
                });
                entries++;
            }
            this.#log.info(
                {entries, venuesRegistered},
                "stress: bootstrap WAL events written",
            );
            // M3.12 / Fix 3 — wait for the sidecar's venue mirror to land all VENUE_REGISTERED
            // events before kicking off the spend loop. Without this, the first ~5 s of spends
            // drop with `dispatcherUnknownVenue`. Skipped when `sidecarSocket` is unset
            // (preserves the original behavior; useful for unit tests + headless dev).
            if (this.#sidecarSocket && this.#bootstrapWaitSecs > 0 && venuesRegistered > 0) {
                this.#log.info(
                    {expected: venuesRegistered, timeoutSecs: this.#bootstrapWaitSecs},
                    "stress: waiting for venue mirror to catch up before spend loop",
                );
                try {
                    const finalCount = await waitForVenues({
                        socketPath: this.#sidecarSocket,
                        expectedCount: venuesRegistered,
                        timeoutMs: this.#bootstrapWaitSecs * 1_000,
                    });
                    this.#log.info(
                        {expected: venuesRegistered, observed: finalCount},
                        "stress: venue mirror caught up",
                    );
                } catch (err) {
                    // Non-fatal: log loud and proceed anyway. Operators may want to start the
                    // spend stream even if a venue is wedged; the dispatcher's drop counter
                    // surfaces the impact.
                    this.#log.warn(
                        {err: err instanceof Error ? err.message : String(err)},
                        "stress: waitForVenues failed — proceeding to spend loop; expect drops",
                    );
                }
            }
            this.#log.info({entries, venuesRegistered}, "stress: entering spend loop");
        }

        const eventsPerTick = Math.max(1, Math.round((this.#rate * this.#tickMs) / 1000));
        // M3.12 / Fix 3 — `durationSeconds` is the *spend-loop* duration, not "total wall
        // time including bootstrap + venue-mirror wait". Otherwise, a 60 s test with a 30 s
        // bootstrap wait would have only 30 s of spends; users would have to math the offset
        // every time. The deadline is anchored to the moment we enter the spend loop.
        const spendStartedAt = this.#now();
        const endAt = this.#durationSeconds > 0 ? spendStartedAt + this.#durationSeconds * 1000 : Infinity;
        let nextTickAt = this.#now();

        while (!this.#stopRequested && this.#now() < endAt) {
            const tickStarted = this.#now();
            // Write one tick's worth of events. We don't pipeline across ticks — the writer
            // is sequential per file, and back-to-back appends keep its `currentSize` counter
            // accurate. Errors here are typically I/O failures (disk full, fs read-only); we
            // surface them to the caller rather than swallowing.
            for (let i = 0; i < eventsPerTick; i++) {
                if (this.#stopRequested) break;
                await this.#writer.append(this.#randomSpend(tickStarted));
                spends++;
            }
            ticks++;

            nextTickAt += this.#tickMs;
            const sleepMs = nextTickAt - this.#now();
            if (sleepMs <= 0) {
                overruns++;
                if (-sleepMs > maxBehindMs) maxBehindMs = -sleepMs;
                // Reset the schedule when behind to keep tick distribution stable. If we
                // tried to catch up by issuing zero-sleep ticks, we'd burn through the next
                // few cycles back-to-back and never sleep — pinning a core for nothing.
                nextTickAt = this.#now();
            } else {
                await sleep(sleepMs);
            }
        }

        const elapsedMs = this.#now() - startedAt;
        const achievedRate = spends > 0 && elapsedMs > 0 ? Math.round((spends * 1000) / elapsedMs) : 0;
        this.#log.info(
            {
                entries,
                venuesRegistered,
                spends,
                ticks,
                overruns,
                maxBehindMs,
                elapsedMs,
                achievedRate,
            },
            "stress: run complete",
        );
        return {entries, venuesRegistered, spends, ticks, overruns, maxBehindMs, elapsedMs};
    }

    #randomSpend(ts: number): {
        kind: "GUEST_SPEND";
        ts: number;
        guestId: number;
        hdIndex: number;
        venueId: number;
        amount: string;
        category: number;
        gameTick: number;
    } {
        const guest = Math.floor(Math.random() * this.#guests);
        const venueId = 1 + Math.floor(Math.random() * this.#venues);
        // Sample a uniform integer in [0, range) using bit-twiddle on a JS-safe portion of
        // the bigint range — randomly samples around 1..max wei without slow string math.
        const rangeBits = this.#spendRangeWei <= BigInt(Number.MAX_SAFE_INTEGER)
            ? Number(this.#spendRangeWei)
            : Number.MAX_SAFE_INTEGER;
        const amount = this.#spendMinWei + BigInt(Math.floor(Math.random() * rangeBits));
        return {
            kind: "GUEST_SPEND",
            ts,
            guestId: guest,
            hdIndex: guest,
            venueId,
            amount: amount.toString(),
            category: 1,
            gameTick: ts,
        };
    }
}

function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}
