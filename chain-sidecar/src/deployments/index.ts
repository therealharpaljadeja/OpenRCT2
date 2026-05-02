import {readFileSync} from "node:fs";
import {rename, writeFile, mkdir} from "node:fs/promises";
import {dirname, resolve as resolvePath} from "node:path";

/// `deployments.json` is the single source of truth for "where does the on-chain stack
/// live". Three consumers depend on it (plan §2.6, §8.6):
///
///   - Game (C++ runtime)  — reads addresses for explorer URLs in the Treasury window.
///   - rctctl              — reads chainId / addresses for `rctctl chain status` and friends.
///   - sidecar (this code) — reads the lot, then writes back when per-park CREATE2 sections
///                           are added (future milestone) or when an operator runs a deploy.
///   - Envio indexer       — its `config.yaml` is generated from this file (M7.x).
///
/// Producer is currently `contracts/script/Deploy.s.sol` (M1.5); M2.6 lands the *writer* here
/// in TypeScript so subsequent flows can amend the file at runtime without re-running Foundry.
///
/// Schema is small but invariant-heavy — addresses are 20-byte hex with a leading `0x`,
/// chainId is a positive integer, `loan.maxBorrow` is a decimal string (uint256-sized) so it
/// survives JSON's number-precision limits, and `loan.ratePerBlock` is a non-negative integer.
/// `parseDeployments` rejects anything that doesn't match — three downstream consumers can't
/// afford to chase a typo'd hex char a week later.

export interface Deployments {
    chainId: number;
    deployer: `0x${string}`;
    /// Block at which the contracts were deployed. Indexer uses it as `start_block`.
    startBlock: number;
    globals: GlobalContracts;
    /// The single deployed park used by the demo. Multi-park CREATE2 sections will land in
    /// a future schema bump as `parks: Record<uuid, ParkContracts>`; for now we keep the
    /// single-park field that M1.5 already writes.
    demoPark: ParkContracts;
    loan: LoanParams;
}

export interface GlobalContracts {
    /// ERC-20 in-game currency. EIP-2612 `permit` enabled.
    parkToken: `0x${string}`;
    /// PARK + MON dispenser, owner-only.
    faucet: `0x${string}`;
    /// Mass-fund helper for `disperseEther` / `disperseToken`.
    disperse: `0x${string}`;
}

export interface ParkContracts {
    treasury: `0x${string}`;
    lendingPool: `0x${string}`;
    guestRegistry: `0x${string}`;
    venueRegistry: `0x${string}`;
    settlementBatcher: `0x${string}`;
}

export interface LoanParams {
    /// Max loan principal in PARK wei (uint256-sized — kept as decimal string).
    maxBorrow: string;
    /// Per-block interest rate scaled by 1e18 (e.g. 1e12 = 1e-6/block).
    ratePerBlock: number;
}

// ----------------------------------------------------------------------------------------
// Load / parse
// ----------------------------------------------------------------------------------------

export class DeploymentsValidationError extends Error {
    constructor(
        public readonly field: string,
        public readonly value: unknown,
        message: string,
    ) {
        super(`deployments.${field}: ${message} (got: ${JSON.stringify(value)})`);
    }
}

/// Read + parse + validate. Throws `DeploymentsValidationError` for schema violations and
/// `Error` for I/O / JSON-parse failures. Fail-fast on bad input is the whole point — three
/// consumers depend on this file being correct.
export function loadDeployments(path: string): Deployments {
    const raw = readFileSync(path, "utf8");
    let parsed: unknown;
    try {
        parsed = JSON.parse(raw);
    } catch (err) {
        throw new Error(`${path}: invalid JSON: ${err instanceof Error ? err.message : String(err)}`);
    }
    return parseDeployments(parsed);
}

/// Validate an already-parsed object. Used by `loadDeployments`, by JSON-RPC writers, and by
/// tests that want to round-trip in-memory deployments through the validator.
export function parseDeployments(raw: unknown): Deployments {
    if (typeof raw !== "object" || raw === null) {
        throw new DeploymentsValidationError("(root)", raw, "must be a JSON object");
    }
    const obj = raw as Record<string, unknown>;
    const chainId = requirePositiveInt(obj.chainId, "chainId");
    const startBlock = requireNonNegativeInt(obj.startBlock, "startBlock");
    const deployer = requireAddress(obj.deployer, "deployer");
    const globals = parseGlobals(obj.globals);
    const demoPark = parsePark(obj.demoPark, "demoPark");
    const loan = parseLoan(obj.loan);
    return {chainId, deployer, startBlock, globals, demoPark, loan};
}

function parseGlobals(raw: unknown): GlobalContracts {
    if (typeof raw !== "object" || raw === null) {
        throw new DeploymentsValidationError("globals", raw, "must be an object");
    }
    const obj = raw as Record<string, unknown>;
    return {
        parkToken: requireAddress(obj.parkToken, "globals.parkToken"),
        faucet: requireAddress(obj.faucet, "globals.faucet"),
        disperse: requireAddress(obj.disperse, "globals.disperse"),
    };
}

function parsePark(raw: unknown, key: string): ParkContracts {
    if (typeof raw !== "object" || raw === null) {
        throw new DeploymentsValidationError(key, raw, "must be an object");
    }
    const obj = raw as Record<string, unknown>;
    return {
        treasury: requireAddress(obj.treasury, `${key}.treasury`),
        lendingPool: requireAddress(obj.lendingPool, `${key}.lendingPool`),
        guestRegistry: requireAddress(obj.guestRegistry, `${key}.guestRegistry`),
        venueRegistry: requireAddress(obj.venueRegistry, `${key}.venueRegistry`),
        settlementBatcher: requireAddress(obj.settlementBatcher, `${key}.settlementBatcher`),
    };
}

function parseLoan(raw: unknown): LoanParams {
    if (typeof raw !== "object" || raw === null) {
        throw new DeploymentsValidationError("loan", raw, "must be an object");
    }
    const obj = raw as Record<string, unknown>;
    if (typeof obj.maxBorrow !== "string" || !/^\d+$/.test(obj.maxBorrow)) {
        throw new DeploymentsValidationError(
            "loan.maxBorrow",
            obj.maxBorrow,
            "must be a non-negative decimal string (uint256-sized)",
        );
    }
    return {
        maxBorrow: obj.maxBorrow,
        ratePerBlock: requireNonNegativeInt(obj.ratePerBlock, "loan.ratePerBlock"),
    };
}

function requireAddress(value: unknown, field: string): `0x${string}` {
    if (typeof value !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(value)) {
        throw new DeploymentsValidationError(field, value, "must be a 20-byte 0x-prefixed hex address");
    }
    // Lower-case canonical form so equality checks are trivial. Checksum casing is a UI
    // concern — explorers will re-checksum for display.
    return value.toLowerCase() as `0x${string}`;
}

function requirePositiveInt(value: unknown, field: string): number {
    if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
        throw new DeploymentsValidationError(field, value, "must be a positive integer");
    }
    return value;
}

function requireNonNegativeInt(value: unknown, field: string): number {
    if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
        throw new DeploymentsValidationError(field, value, "must be a non-negative integer");
    }
    return value;
}

// ----------------------------------------------------------------------------------------
// Save
// ----------------------------------------------------------------------------------------

/// Atomic write: serialize to a sibling temp file, fsync-equivalent rename. The rename is
/// the atomic operation on POSIX — if the process dies mid-write, the original file is
/// untouched and the temp file is the only casualty. Three consumers can keep tailing.
///
/// Pretty-printed (2-space indent) for git-friendliness — the file is checked in, diffs
/// matter. Final newline so editors don't complain.
export async function saveDeployments(path: string, deployments: Deployments): Promise<void> {
    // Validate before write — never persist a bad shape, even if the caller fed us garbage.
    parseDeployments(deployments);
    const resolved = resolvePath(path);
    await mkdir(dirname(resolved), {recursive: true}).catch(() => undefined);
    const tmp = `${resolved}.tmp`;
    const body = `${JSON.stringify(deployments, sortedReplacer(deployments), 2)}\n`;
    await writeFile(tmp, body, {encoding: "utf8"});
    await rename(tmp, resolved);
}

/// JSON.stringify replacer that sorts object keys alphabetically. The Foundry deploy script
/// already produces alphabetically-sorted JSON; matching that order keeps re-saves a no-op
/// in `git diff` instead of churning the whole file each time.
function sortedReplacer(_root: Deployments): (this: unknown, key: string, value: unknown) => unknown {
    return function (_key: string, value: unknown): unknown {
        if (value && typeof value === "object" && !Array.isArray(value)) {
            const sorted: Record<string, unknown> = {};
            for (const k of Object.keys(value as Record<string, unknown>).sort()) {
                sorted[k] = (value as Record<string, unknown>)[k];
            }
            return sorted;
        }
        return value;
    };
}
