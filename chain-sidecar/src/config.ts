import {readFileSync} from "node:fs";
import {resolve} from "node:path";
import {DEFAULT_RELAYER_COUNT, MAX_RELAYER_COUNT, MIN_RELAYER_COUNT} from "./derive/index.js";
import {loadDeployments, type Deployments} from "./deployments/index.js";

export {loadDeployments, type Deployments};

/// Defaults for the M2.5 chain plumbing. Per-relayer MON sizes are conservative — Monad
/// testnet gas should be cheap, but we want headroom across many batch txs without leaning
/// on the top-up loop on the hot path.
const DEFAULT_MON_LOW_WATER_WEI = 10_000_000_000_000_000n; // 0.01 MON
const DEFAULT_MON_TARGET_WEI = 100_000_000_000_000_000n; // 0.1 MON
const DEFAULT_PARK_LAUNCH_WEI = 1_000_000n * 10n ** 18n; // 1,000,000 PARK
const DEFAULT_TOPUP_INTERVAL_MS = 30_000;
/// Funder window defaults — match plan §4.4 ("every 200 ms ... up to 200 new addresses").
const DEFAULT_FUNDER_WINDOW_SIZE = 200;
const DEFAULT_FUNDER_WINDOW_AGE_MS = 200;
const DEFAULT_FUNDER_MAX_QUEUED = 5_000;
/// Permit collector defaults — same cadence as the funder so both windows settle together.
const DEFAULT_PERMITS_WINDOW_SIZE = 200;
const DEFAULT_PERMITS_WINDOW_AGE_MS = 200;
const DEFAULT_PERMITS_MAX_QUEUED = 5_000;
/// Sweeper defaults — same cadence; smaller queue cap is fine because exits are sparse.
const DEFAULT_SWEEPER_WINDOW_SIZE = 200;
const DEFAULT_SWEEPER_WINDOW_AGE_MS = 200;
const DEFAULT_SWEEPER_MAX_QUEUED = 5_000;
/// Venue mirror — venue events are sparse (admin path), so no batching, just a queue cap.
const DEFAULT_VENUE_MIRROR_MAX_QUEUED = 1024;
/// Days from now to use as the permit's `deadline`. Past this point a permit submission
/// reverts with `ERC2612ExpiredSignature`. The deadline only constrains *submission* — once
/// permit lands on-chain the allowance is set forever, so we want a generous default. 30 days
/// is comfortably above any realistic queue-stall scenario.
const DEFAULT_PERMIT_DEADLINE_DAYS = 30;

/// Parsed CLI invocation. M2.1 + M2.2 surface — later milestones fill in `--rpc-url`,
/// `--batch-max-size`, etc.
export interface SidecarConfig {
    socketPath: string;
    deploymentsPath: string;
    deployments: Deployments;
    keystorePath: string;
    /// Resolved at parse time so `main.ts` doesn't have to repeat the env / file fallbacks.
    keystorePassphrase: string;
    relayerCount: number;
    /// M2.4: optional outbox WAL path. When set, the sidecar starts an `OutboxReader` at
    /// boot and drains game events from it. Absent in tests / when the game isn't running.
    outboxPath?: string;
    /// Cursor file. Defaults to `${outboxPath}.cursor` so a single `--outbox` flag covers
    /// the common case.
    outboxCursorPath?: string;
    /// Reader poll interval; the default in `OutboxReader` is fine for production.
    outboxPollIntervalMs?: number;
    /// M2.5: chain RPC + faucet. All optional — without them the sidecar boots without any
    /// on-chain plumbing (useful for unit tests + ahead-of-launch ops).
    rpcUrl?: string;
    /// 0x-prefixed 32-byte private key for the Faucet owner. Required to call `dripPark` /
    /// `dripMon`. Read from a file (`--faucet-owner-keyfile`) or `FAUCET_OWNER_KEY` env so
    /// the key never lands in `ps` output.
    faucetOwnerKey?: `0x${string}`;
    monLowWaterWei: bigint;
    monTargetWei: bigint;
    parkLaunchWei: bigint;
    topupIntervalMs: number;
    /// M3.5 funder window. Only consulted when chain plumbing + faucet-owner key are present
    /// (the funder needs a wallet client to drive `treasury.execute`).
    funderWindowSize: number;
    funderWindowAgeMs: number;
    funderMaxQueued: number;
    /// M3.6 permit collector knobs.
    permitsWindowSize: number;
    permitsWindowAgeMs: number;
    permitsMaxQueued: number;
    permitDeadlineDays: number;
    /// M3.7 sweeper knobs.
    sweeperWindowSize: number;
    sweeperWindowAgeMs: number;
    sweeperMaxQueued: number;
    /// M3.8 venue mirror knobs.
    venueMirrorMaxQueued: number;
}

const USAGE = `Usage: rct2-chain-sidecar [options]

Options:
  --socket <path>                  UDS path for the JSON-RPC server (required)
  --deployments <path>             Path to a deployments.json from contracts/deployments/ (required)
  --keystore <path>                Encrypted-mnemonic keystore. Created on first run if missing. (required)
  --keystore-passphrase-file <p>   Read keystore passphrase from this file (overrides KEYSTORE_PASSPHRASE)
  --relayer-count <n>              Treasury-funded relayer EOAs, ${MIN_RELAYER_COUNT}-${MAX_RELAYER_COUNT} (default ${DEFAULT_RELAYER_COUNT})
  --outbox <path>                  Game-side outbox WAL to drain (M2.4). Reader is disabled when omitted.
  --outbox-cursor <path>           Cursor file (default: <outbox>.cursor)
  --outbox-poll-ms <n>             Poll interval in ms (default: 50)
  --rpc-url <url>                  Chain RPC endpoint. Required to enable on-chain plumbing (M2.5).
  --faucet-owner-keyfile <path>    File containing the Faucet-owner 0x-prefixed private key
  --mon-low-water-wei <n>          Relayer MON refill threshold (default: 0.01 MON)
  --mon-target-wei <n>             Relayer MON refill target (default: 0.1 MON)
  --park-launch-wei <n>            PARK to mint into treasury at park launch (default: 1,000,000 PARK)
  --topup-interval-ms <n>          Relayer top-up loop interval in ms (default: 30000)
  --funder-window-size <n>         Max entries per funding tx (default: 200)
  --funder-window-age-ms <n>       Max age of buffered entries before flush (default: 200)
  --funder-max-queued <n>          Drop-oldest cap on the funder buffer (default: 5000)
  --permits-window-size <n>        Max permit sigs per tx (default: 200)
  --permits-window-age-ms <n>      Max age of buffered permits before flush (default: 200)
  --permits-max-queued <n>         Drop-oldest cap on the permit buffer (default: 5000)
  --permit-deadline-days <n>       Days from now to set as permit deadline (default: 30)
  --sweeper-window-size <n>        Max exits per sweep tx (default: 200)
  --sweeper-window-age-ms <n>      Max age of buffered exits before flush (default: 200)
  --sweeper-max-queued <n>         Drop-oldest cap on the sweeper buffer (default: 5000)
  --venue-mirror-max-queued <n>    Drop-oldest cap on the venue mirror queue (default: 1024)
  -h, --help                       Show this help

Environment:
  KEYSTORE_PASSPHRASE              Keystore passphrase (alternative to --keystore-passphrase-file)
  FAUCET_OWNER_KEY                 Faucet owner private key (alternative to --faucet-owner-keyfile)
  LOG_LEVEL                        pino log level (default: info)
`;

export function parseArgs(argv: readonly string[]): SidecarConfig {
    let socketPath: string | undefined;
    let deploymentsPath: string | undefined;
    let keystorePath: string | undefined;
    let keystorePassphraseFile: string | undefined;
    let relayerCount = DEFAULT_RELAYER_COUNT;
    let outboxPath: string | undefined;
    let outboxCursorPath: string | undefined;
    let outboxPollIntervalMs: number | undefined;
    let rpcUrl: string | undefined;
    let faucetOwnerKeyFile: string | undefined;
    let monLowWaterWei = DEFAULT_MON_LOW_WATER_WEI;
    let monTargetWei = DEFAULT_MON_TARGET_WEI;
    let parkLaunchWei = DEFAULT_PARK_LAUNCH_WEI;
    let topupIntervalMs = DEFAULT_TOPUP_INTERVAL_MS;
    let funderWindowSize = DEFAULT_FUNDER_WINDOW_SIZE;
    let funderWindowAgeMs = DEFAULT_FUNDER_WINDOW_AGE_MS;
    let funderMaxQueued = DEFAULT_FUNDER_MAX_QUEUED;
    let permitsWindowSize = DEFAULT_PERMITS_WINDOW_SIZE;
    let permitsWindowAgeMs = DEFAULT_PERMITS_WINDOW_AGE_MS;
    let permitsMaxQueued = DEFAULT_PERMITS_MAX_QUEUED;
    let permitDeadlineDays = DEFAULT_PERMIT_DEADLINE_DAYS;
    let sweeperWindowSize = DEFAULT_SWEEPER_WINDOW_SIZE;
    let sweeperWindowAgeMs = DEFAULT_SWEEPER_WINDOW_AGE_MS;
    let sweeperMaxQueued = DEFAULT_SWEEPER_MAX_QUEUED;
    let venueMirrorMaxQueued = DEFAULT_VENUE_MIRROR_MAX_QUEUED;
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        switch (a) {
            case "-h":
            case "--help":
                process.stdout.write(USAGE);
                process.exit(0);
            // eslint-disable-next-line no-fallthrough
            case "--socket":
                socketPath = argv[++i];
                break;
            case "--deployments":
                deploymentsPath = argv[++i];
                break;
            case "--keystore":
                keystorePath = argv[++i];
                break;
            case "--keystore-passphrase-file":
                keystorePassphraseFile = argv[++i];
                break;
            case "--relayer-count": {
                const raw = argv[++i];
                const n = Number(raw);
                if (!Number.isInteger(n) || n < MIN_RELAYER_COUNT || n > MAX_RELAYER_COUNT) {
                    throw new Error(
                        `--relayer-count must be an integer in [${MIN_RELAYER_COUNT}, ${MAX_RELAYER_COUNT}], got ${String(raw)}`,
                    );
                }
                relayerCount = n;
                break;
            }
            case "--outbox":
                outboxPath = argv[++i];
                break;
            case "--outbox-cursor":
                outboxCursorPath = argv[++i];
                break;
            case "--outbox-poll-ms": {
                const raw = argv[++i];
                const n = Number(raw);
                if (!Number.isInteger(n) || n < 1 || n > 60_000) {
                    throw new Error(`--outbox-poll-ms must be an integer in [1, 60000], got ${String(raw)}`);
                }
                outboxPollIntervalMs = n;
                break;
            }
            case "--rpc-url":
                rpcUrl = argv[++i];
                break;
            case "--faucet-owner-keyfile":
                faucetOwnerKeyFile = argv[++i];
                break;
            case "--mon-low-water-wei":
                monLowWaterWei = parseBigIntFlag("--mon-low-water-wei", argv[++i]);
                break;
            case "--mon-target-wei":
                monTargetWei = parseBigIntFlag("--mon-target-wei", argv[++i]);
                break;
            case "--park-launch-wei":
                parkLaunchWei = parseBigIntFlag("--park-launch-wei", argv[++i]);
                break;
            case "--topup-interval-ms": {
                const raw = argv[++i];
                const n = Number(raw);
                if (!Number.isInteger(n) || n < 1_000 || n > 3_600_000) {
                    throw new Error(
                        `--topup-interval-ms must be an integer in [1000, 3600000], got ${String(raw)}`,
                    );
                }
                topupIntervalMs = n;
                break;
            }
            case "--funder-window-size": {
                const raw = argv[++i];
                const n = Number(raw);
                if (!Number.isInteger(n) || n < 1 || n > 1024) {
                    throw new Error(`--funder-window-size must be an integer in [1, 1024], got ${String(raw)}`);
                }
                funderWindowSize = n;
                break;
            }
            case "--funder-window-age-ms": {
                const raw = argv[++i];
                const n = Number(raw);
                if (!Number.isInteger(n) || n < 1 || n > 60_000) {
                    throw new Error(`--funder-window-age-ms must be an integer in [1, 60000], got ${String(raw)}`);
                }
                funderWindowAgeMs = n;
                break;
            }
            case "--funder-max-queued": {
                const raw = argv[++i];
                const n = Number(raw);
                if (!Number.isInteger(n) || n < 1 || n > 1_000_000) {
                    throw new Error(`--funder-max-queued must be an integer in [1, 1000000], got ${String(raw)}`);
                }
                funderMaxQueued = n;
                break;
            }
            case "--permits-window-size": {
                const raw = argv[++i];
                const n = Number(raw);
                if (!Number.isInteger(n) || n < 1 || n > 1024) {
                    throw new Error(`--permits-window-size must be an integer in [1, 1024], got ${String(raw)}`);
                }
                permitsWindowSize = n;
                break;
            }
            case "--permits-window-age-ms": {
                const raw = argv[++i];
                const n = Number(raw);
                if (!Number.isInteger(n) || n < 1 || n > 60_000) {
                    throw new Error(`--permits-window-age-ms must be an integer in [1, 60000], got ${String(raw)}`);
                }
                permitsWindowAgeMs = n;
                break;
            }
            case "--permits-max-queued": {
                const raw = argv[++i];
                const n = Number(raw);
                if (!Number.isInteger(n) || n < 1 || n > 1_000_000) {
                    throw new Error(`--permits-max-queued must be an integer in [1, 1000000], got ${String(raw)}`);
                }
                permitsMaxQueued = n;
                break;
            }
            case "--permit-deadline-days": {
                const raw = argv[++i];
                const n = Number(raw);
                if (!Number.isInteger(n) || n < 1 || n > 365) {
                    throw new Error(`--permit-deadline-days must be an integer in [1, 365], got ${String(raw)}`);
                }
                permitDeadlineDays = n;
                break;
            }
            case "--sweeper-window-size": {
                const raw = argv[++i];
                const n = Number(raw);
                if (!Number.isInteger(n) || n < 1 || n > 1024) {
                    throw new Error(`--sweeper-window-size must be an integer in [1, 1024], got ${String(raw)}`);
                }
                sweeperWindowSize = n;
                break;
            }
            case "--sweeper-window-age-ms": {
                const raw = argv[++i];
                const n = Number(raw);
                if (!Number.isInteger(n) || n < 1 || n > 60_000) {
                    throw new Error(`--sweeper-window-age-ms must be an integer in [1, 60000], got ${String(raw)}`);
                }
                sweeperWindowAgeMs = n;
                break;
            }
            case "--sweeper-max-queued": {
                const raw = argv[++i];
                const n = Number(raw);
                if (!Number.isInteger(n) || n < 1 || n > 1_000_000) {
                    throw new Error(`--sweeper-max-queued must be an integer in [1, 1000000], got ${String(raw)}`);
                }
                sweeperMaxQueued = n;
                break;
            }
            case "--venue-mirror-max-queued": {
                const raw = argv[++i];
                const n = Number(raw);
                if (!Number.isInteger(n) || n < 1 || n > 1_000_000) {
                    throw new Error(
                        `--venue-mirror-max-queued must be an integer in [1, 1000000], got ${String(raw)}`,
                    );
                }
                venueMirrorMaxQueued = n;
                break;
            }
            default:
                throw new Error(`unknown argument: ${a}\n\n${USAGE}`);
        }
    }
    if (!socketPath) throw new Error(`missing --socket\n\n${USAGE}`);
    if (!deploymentsPath) throw new Error(`missing --deployments\n\n${USAGE}`);
    if (!keystorePath) throw new Error(`missing --keystore\n\n${USAGE}`);

    const keystorePassphrase = resolvePassphrase(keystorePassphraseFile);

    const resolvedDeployments = resolve(deploymentsPath);
    const deployments = loadDeployments(resolvedDeployments);
    const resolvedOutbox = outboxPath ? resolve(outboxPath) : undefined;
    const resolvedOutboxCursor = outboxCursorPath
        ? resolve(outboxCursorPath)
        : resolvedOutbox
          ? `${resolvedOutbox}.cursor`
          : undefined;
    if (monTargetWei <= monLowWaterWei) {
        throw new Error(
            `--mon-target-wei (${monTargetWei}) must exceed --mon-low-water-wei (${monLowWaterWei})`,
        );
    }
    const faucetOwnerKey = resolveFaucetOwnerKey(faucetOwnerKeyFile);
    // exactOptionalPropertyTypes: undefined keys must be *omitted*, not present-with-undefined.
    const config: SidecarConfig = {
        socketPath: resolve(socketPath),
        deploymentsPath: resolvedDeployments,
        deployments,
        keystorePath: resolve(keystorePath),
        keystorePassphrase,
        relayerCount,
        monLowWaterWei,
        monTargetWei,
        parkLaunchWei,
        topupIntervalMs,
        funderWindowSize,
        funderWindowAgeMs,
        funderMaxQueued,
        permitsWindowSize,
        permitsWindowAgeMs,
        permitsMaxQueued,
        permitDeadlineDays,
        sweeperWindowSize,
        sweeperWindowAgeMs,
        sweeperMaxQueued,
        venueMirrorMaxQueued,
    };
    if (resolvedOutbox) config.outboxPath = resolvedOutbox;
    if (resolvedOutboxCursor) config.outboxCursorPath = resolvedOutboxCursor;
    if (outboxPollIntervalMs !== undefined) config.outboxPollIntervalMs = outboxPollIntervalMs;
    if (rpcUrl) config.rpcUrl = rpcUrl;
    if (faucetOwnerKey) config.faucetOwnerKey = faucetOwnerKey;
    return config;
}

function parseBigIntFlag(name: string, raw: string | undefined): bigint {
    if (typeof raw !== "string" || raw.length === 0) throw new Error(`${name} requires a value`);
    if (!/^\d+$/.test(raw)) throw new Error(`${name} must be a non-negative integer (wei), got ${raw}`);
    return BigInt(raw);
}

/// File flag wins over env var, mirroring the keystore-passphrase resolution above. Trims a
/// trailing newline because shell heredocs habitually leave one. Validates 32-byte hex so a
/// truncated paste fails fast rather than at first contract call.
function resolveFaucetOwnerKey(file: string | undefined): `0x${string}` | undefined {
    let raw: string | undefined;
    if (file) {
        raw = readFileSync(resolve(file), "utf8").replace(/\r?\n$/, "").trim();
        if (raw.length === 0) throw new Error(`faucet-owner-keyfile ${file} is empty`);
    } else {
        const env = process.env.FAUCET_OWNER_KEY;
        if (env && env.length > 0) raw = env.trim();
    }
    if (!raw) return undefined;
    const hex = raw.startsWith("0x") || raw.startsWith("0X") ? raw : `0x${raw}`;
    if (!/^0x[0-9a-fA-F]{64}$/.test(hex)) {
        throw new Error("faucet owner key must be a 0x-prefixed 32-byte hex string");
    }
    return hex.toLowerCase() as `0x${string}`;
}

/// File flag wins over env var so deployment automation can pin the source explicitly without
/// fighting an inherited env. Either resolves to the raw passphrase string with trailing
/// whitespace stripped — common from `echo` heredocs.
function resolvePassphrase(file: string | undefined): string {
    if (file) {
        const raw = readFileSync(resolve(file), "utf8").replace(/\r?\n$/, "");
        if (raw.length === 0) throw new Error(`keystore passphrase file ${file} is empty`);
        return raw;
    }
    const env = process.env.KEYSTORE_PASSPHRASE;
    if (env && env.length > 0) return env;
    throw new Error(
        "no keystore passphrase: set KEYSTORE_PASSPHRASE or pass --keystore-passphrase-file <path>",
    );
}

