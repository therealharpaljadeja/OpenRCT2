import {readFileSync} from "node:fs";
import {resolve} from "node:path";

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

/// Parsed CLI invocation. M2.1 keeps this small; later milestones will fill in
/// `--rpc-url`, `--keystore`, `--relayer-count`, etc.
export interface SidecarConfig {
    socketPath: string;
    deploymentsPath: string;
    deployments: Deployments;
}

const USAGE = `Usage: rct2-chain-sidecar [options]

Options:
  --socket <path>         UDS path for the JSON-RPC server (required)
  --deployments <path>    Path to a deployments.json from contracts/deployments/ (required)
  -h, --help              Show this help

Environment:
  LOG_LEVEL               pino log level (default: info)
`;

export function parseArgs(argv: readonly string[]): SidecarConfig {
    let socketPath: string | undefined;
    let deploymentsPath: string | undefined;
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
            default:
                throw new Error(`unknown argument: ${a}\n\n${USAGE}`);
        }
    }
    if (!socketPath) throw new Error(`missing --socket\n\n${USAGE}`);
    if (!deploymentsPath) throw new Error(`missing --deployments\n\n${USAGE}`);

    const resolvedDeployments = resolve(deploymentsPath);
    const deployments = loadDeployments(resolvedDeployments);
    return {socketPath: resolve(socketPath), deploymentsPath: resolvedDeployments, deployments};
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
