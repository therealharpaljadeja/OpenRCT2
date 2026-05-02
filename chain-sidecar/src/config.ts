import {readFileSync} from "node:fs";
import {resolve} from "node:path";
import {DEFAULT_RELAYER_COUNT, MAX_RELAYER_COUNT, MIN_RELAYER_COUNT} from "./derive/index.js";

/// Mirrors the JSON written by `contracts/script/Deploy.s.sol` to
/// `OpenRCT2/contracts/deployments/<network>.json`. Game, rctctl, sidecar, and indexer all
/// read this same artifact so addresses stay in lockstep with the on-chain stack. Plan §2.6.
export interface Deployments {
    chainId: number;
    deployer: `0x${string}`;
    startBlock: number;
    globals: {
        parkToken: `0x${string}`;
        faucet: `0x${string}`;
        disperse: `0x${string}`;
    };
    demoPark: {
        treasury: `0x${string}`;
        lendingPool: `0x${string}`;
        guestRegistry: `0x${string}`;
        venueRegistry: `0x${string}`;
        settlementBatcher: `0x${string}`;
    };
    loan: {
        maxBorrow: string;
        ratePerBlock: number;
    };
}

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
}

const USAGE = `Usage: rct2-chain-sidecar [options]

Options:
  --socket <path>                  UDS path for the JSON-RPC server (required)
  --deployments <path>             Path to a deployments.json from contracts/deployments/ (required)
  --keystore <path>                Encrypted-mnemonic keystore. Created on first run if missing. (required)
  --keystore-passphrase-file <p>   Read keystore passphrase from this file (overrides KEYSTORE_PASSPHRASE)
  --relayer-count <n>              Treasury-funded relayer EOAs, ${MIN_RELAYER_COUNT}-${MAX_RELAYER_COUNT} (default ${DEFAULT_RELAYER_COUNT})
  -h, --help                       Show this help

Environment:
  KEYSTORE_PASSPHRASE              Keystore passphrase (alternative to --keystore-passphrase-file)
  LOG_LEVEL                        pino log level (default: info)
`;

export function parseArgs(argv: readonly string[]): SidecarConfig {
    let socketPath: string | undefined;
    let deploymentsPath: string | undefined;
    let keystorePath: string | undefined;
    let keystorePassphraseFile: string | undefined;
    let relayerCount = DEFAULT_RELAYER_COUNT;
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
    return {
        socketPath: resolve(socketPath),
        deploymentsPath: resolvedDeployments,
        deployments,
        keystorePath: resolve(keystorePath),
        keystorePassphrase,
        relayerCount,
    };
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

export function loadDeployments(path: string): Deployments {
    const raw = readFileSync(path, "utf8");
    const parsed = JSON.parse(raw) as Deployments;
    if (typeof parsed.chainId !== "number") throw new Error(`${path}: missing chainId`);
    if (!parsed.globals?.parkToken) throw new Error(`${path}: missing globals.parkToken`);
    if (!parsed.demoPark?.settlementBatcher) {
        throw new Error(`${path}: missing demoPark.settlementBatcher`);
    }
    return parsed;
}
