#!/usr/bin/env node
import {resolve} from "node:path";
import {OutboxWriter} from "../outbox/index.js";
import {log} from "../log.js";
import {StressGenerator} from "./generator.js";

/// `rct2-stress` — CLI driver for the M3.11 stress harness.
///
/// Writes synthetic `GUEST_SPEND` events (and optionally `VENUE_REGISTERED` + `GUEST_ENTRY`
/// for full-lifecycle bootstrap) into a WAL that an `rct2-chain-sidecar` is already draining.
/// The two processes share `--outbox <path>` and nothing else.
///
/// Typical usage (full-lifecycle, modest rate):
///
///     rct2-stress \
///       --outbox /tmp/rct2-stress.wal \
///       --guests 1000 \
///       --venues 50 \
///       --rate 1000 \
///       --duration 60
///
/// Spend-only (assumes guests are already funded + permitted; e.g. across a sidecar restart
/// while `--rate` is being swept):
///
///     rct2-stress \
///       --outbox /tmp/rct2-stress.wal \
///       --guests 1000 \
///       --venues 50 \
///       --rate 5000 \
///       --duration 30 \
///       --no-bootstrap

const USAGE = `Usage: rct2-stress [options]

Options:
  --outbox <path>            WAL to write into (must match the sidecar's --outbox) (required)
  --guests <n>               Distinct guest HD indexes (default 1000)
  --venues <n>               Distinct venue ids 1..n (default 50)
  --rate <n>                 Target GUEST_SPEND auth/s (default 1000)
  --duration <s>             Run length in seconds; 0 = unbounded (default 60)
  --no-bootstrap             Skip VENUE_REGISTERED + GUEST_ENTRY bootstrap (default: bootstrap)
  --sidecar-socket <path>    UDS socket of the running sidecar; harness polls chain.venues.status
                             after bootstrap to avoid the dispatcher cache-miss race
  --bootstrap-wait-secs <n>  Max seconds to wait for the venue cache to fill (default 60; 0 = no wait)
  --tick-ms <n>              Tick granularity in ms (default 10)
  --cash-wei <n>             Cash per GUEST_ENTRY (default 100 PARK = 100e18)
  --spend-min-wei <n>        Minimum spend amount (default 1 PARK = 1e18)
  --spend-max-wei <n>        Maximum spend amount (default 10 PARK = 10e18)
  --outbox-max-bytes <n>     WAL byte cap before truncation (default 500 MiB)
  -h, --help                 Show this help

Notes:
  • The sidecar must already be running with --outbox <path> to drain events. The harness
    fails fast if the WAL path doesn't exist; create the parent directory beforehand.
  • At rates over ~3000 auth/s, expect occasional tick overruns reported in final stats.
    Increase --tick-ms or drop --rate; the harness logs the achieved auth/s on exit.
  • Bootstrap mode triggers the sidecar's funder + permit + venue-mirror admin paths — this
    consumes real testnet PARK + MON. Re-runs are idempotent (venue mirror catches dupes).
`;

interface Args {
    outbox: string;
    guests: number;
    venues: number;
    rate: number;
    durationSeconds: number;
    bootstrap: boolean;
    tickMs: number;
    cashWei: bigint;
    spendMinWei: bigint;
    spendMaxWei: bigint;
    outboxMaxBytes: number;
    sidecarSocket?: string;
    bootstrapWaitSecs: number;
}

function parseArgs(argv: readonly string[]): Args {
    let outbox: string | undefined;
    let guests = 1000;
    let venues = 50;
    let rate = 1000;
    let durationSeconds = 60;
    let bootstrap = true;
    let tickMs = 10;
    let cashWei = 100n * 10n ** 18n;
    let spendMinWei = 10n ** 18n;
    let spendMaxWei = 10n * 10n ** 18n;
    let outboxMaxBytes = 500 * 1024 * 1024;
    let sidecarSocket: string | undefined;
    let bootstrapWaitSecs = 60;

    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        switch (a) {
            case "-h":
            case "--help":
                process.stdout.write(USAGE);
                process.exit(0);
            // eslint-disable-next-line no-fallthrough
            case "--outbox":
                outbox = argv[++i];
                break;
            case "--guests":
                guests = parseIntFlag("--guests", argv[++i]);
                break;
            case "--venues":
                venues = parseIntFlag("--venues", argv[++i]);
                break;
            case "--rate":
                rate = parseFloatFlag("--rate", argv[++i]);
                break;
            case "--duration":
                durationSeconds = parseFloatFlag("--duration", argv[++i]);
                break;
            case "--no-bootstrap":
                bootstrap = false;
                break;
            case "--tick-ms":
                tickMs = parseIntFlag("--tick-ms", argv[++i]);
                break;
            case "--cash-wei":
                cashWei = parseBigIntFlag("--cash-wei", argv[++i]);
                break;
            case "--spend-min-wei":
                spendMinWei = parseBigIntFlag("--spend-min-wei", argv[++i]);
                break;
            case "--spend-max-wei":
                spendMaxWei = parseBigIntFlag("--spend-max-wei", argv[++i]);
                break;
            case "--outbox-max-bytes":
                outboxMaxBytes = parseIntFlag("--outbox-max-bytes", argv[++i]);
                break;
            case "--sidecar-socket":
                sidecarSocket = argv[++i];
                break;
            case "--bootstrap-wait-secs":
                bootstrapWaitSecs = parseFloatFlag("--bootstrap-wait-secs", argv[++i]);
                break;
            default:
                throw new Error(`unknown argument: ${a}\n\n${USAGE}`);
        }
    }
    if (!outbox) throw new Error(`missing --outbox\n\n${USAGE}`);
    const args: Args = {
        outbox: resolve(outbox),
        guests,
        venues,
        rate,
        durationSeconds,
        bootstrap,
        tickMs,
        cashWei,
        spendMinWei,
        spendMaxWei,
        outboxMaxBytes,
        bootstrapWaitSecs,
    };
    if (sidecarSocket) args.sidecarSocket = resolve(sidecarSocket);
    return args;
}

function parseIntFlag(name: string, raw: string | undefined): number {
    if (raw === undefined) throw new Error(`${name} requires a value`);
    const n = Number(raw);
    if (!Number.isInteger(n)) throw new Error(`${name} must be an integer, got ${raw}`);
    return n;
}

function parseFloatFlag(name: string, raw: string | undefined): number {
    if (raw === undefined) throw new Error(`${name} requires a value`);
    const n = Number(raw);
    if (!Number.isFinite(n)) throw new Error(`${name} must be a finite number, got ${raw}`);
    return n;
}

function parseBigIntFlag(name: string, raw: string | undefined): bigint {
    if (raw === undefined) throw new Error(`${name} requires a value`);
    if (!/^\d+$/.test(raw)) throw new Error(`${name} must be a non-negative integer, got ${raw}`);
    return BigInt(raw);
}

async function main(): Promise<void> {
    let args: Args;
    try {
        args = parseArgs(process.argv.slice(2));
    } catch (err) {
        process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
        process.exit(2);
    }

    const writer = new OutboxWriter(args.outbox, {maxBytes: args.outboxMaxBytes, log});
    await writer.open();
    log.info(
        {
            outbox: args.outbox,
            guests: args.guests,
            venues: args.venues,
            rate: args.rate,
            duration: args.durationSeconds,
            bootstrap: args.bootstrap,
            tickMs: args.tickMs,
        },
        "rct2-stress: starting",
    );

    const genOpts: ConstructorParameters<typeof StressGenerator>[0] = {
        writer,
        guests: args.guests,
        venues: args.venues,
        rate: args.rate,
        durationSeconds: args.durationSeconds,
        cashPerGuestWei: args.cashWei,
        spendMinWei: args.spendMinWei,
        spendMaxWei: args.spendMaxWei,
        tickMs: args.tickMs,
        skipBootstrap: !args.bootstrap,
        bootstrapWaitSecs: args.bootstrapWaitSecs,
        log,
    };
    if (args.sidecarSocket) genOpts.sidecarSocket = args.sidecarSocket;
    const generator = new StressGenerator(genOpts);

    const onSignal = (signal: string): void => {
        log.info({signal}, "rct2-stress: stop signal received");
        generator.stop();
    };
    process.on("SIGINT", () => onSignal("SIGINT"));
    process.on("SIGTERM", () => onSignal("SIGTERM"));

    try {
        const stats = await generator.run();
        await writer.close();
        const achievedRate =
            stats.spends > 0 && stats.elapsedMs > 0 ? Math.round((stats.spends * 1000) / stats.elapsedMs) : 0;
        // Print a single human-friendly summary line so the operator can grep for it across
        // sweep runs ("rate=N achieved=M overruns=K").
        process.stdout.write(
            `rate=${args.rate} achieved=${achievedRate} spends=${stats.spends} entries=${stats.entries} venues=${stats.venuesRegistered} overruns=${stats.overruns} maxBehindMs=${stats.maxBehindMs} elapsedMs=${stats.elapsedMs}\n`,
        );
        process.exit(0);
    } catch (err) {
        log.error({err}, "rct2-stress: fatal");
        await writer.close().catch(() => undefined);
        process.exit(1);
    }
}

main().catch((err) => {
    log.error({err}, "rct2-stress: top-level fatal");
    process.exit(1);
});
