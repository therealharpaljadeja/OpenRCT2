import {
    BaseError,
    ContractFunctionRevertedError,
    decodeErrorResult,
    type Abi,
    type Hex,
    type PublicClient,
} from "viem";
import {
    DISPERSE_ABI,
    ERC20_ERRORS_ABI,
    FAUCET_ABI,
    FAUCET_ERRORS_ABI,
    PARK_TOKEN_ABI,
    PARK_TREASURY_ABI,
    SETTLEMENT_BATCHER_ABI,
    VENUE_REGISTRY_ABI,
} from "./abis.js";

/// Master union of every custom error declaration the sidecar might encounter on revert.
/// Used as the default decoding bundle by `confirmTx`. The order doesn't matter — viem matches
/// by 4-byte selector, and our error names are unique across these contracts.
export const KNOWN_REVERT_ERRORS_ABI: Abi = [
    ...PARK_TREASURY_ABI,
    ...VENUE_REGISTRY_ABI,
    ...SETTLEMENT_BATCHER_ABI,
    ...ERC20_ERRORS_ABI,
    ...FAUCET_ERRORS_ABI,
    ...PARK_TOKEN_ABI,
    ...DISPERSE_ABI,
    ...FAUCET_ABI,
];

const EMPTY_DATA: Hex = "0x";

/// Replay a failed tx via `eth_call` at `blockNumber - 1` to recover its revert data, then
/// decode against `errorAbi`. `CallFailed(bytes)` payloads (the wrapper Treasury.execute uses
/// for inner-call reverts) are unwrapped recursively against the same ABI.
///
/// Best-effort: returns a human-readable string on success, or `undefined` if anything in the
/// pipeline fails. The caller appends to a generic "reverted on chain" message — never throws
/// from here, since this is a diagnostic path on top of an already-failed tx.
export interface DecodeRevertOptions {
    publicClient: PublicClient;
    txHash: Hex;
    /// Combined error declarations to try decoding against. Defaults to `KNOWN_REVERT_ERRORS_ABI`.
    errorAbi?: Abi;
}

export async function decodeRevertReason(opts: DecodeRevertOptions): Promise<string | undefined> {
    const errorAbi = opts.errorAbi ?? KNOWN_REVERT_ERRORS_ABI;
    let revertData: Hex | undefined;
    try {
        const tx = await opts.publicClient.getTransaction({hash: opts.txHash});
        if (!tx.to) return undefined; // contract creation revert — out of scope
        try {
            await opts.publicClient.call({
                account: tx.from,
                to: tx.to,
                data: tx.input,
                value: tx.value,
                blockNumber: tx.blockNumber === null ? undefined : tx.blockNumber - 1n,
            });
            return undefined; // didn't revert on replay — chain state diverged
        } catch (err) {
            revertData = extractRevertData(err);
        }
    } catch {
        return undefined;
    }
    if (!revertData || revertData === EMPTY_DATA) return undefined;
    return formatRevert(revertData, errorAbi);
}

/// Walk a viem error to find the raw revert hex. Two paths:
/// - Structured: `BaseError.walk(...)` yields a `ContractFunctionRevertedError` with
///   `data.errorName` and pre-parsed args (only when viem's own decoder matched against the ABI
///   we passed to the call site — we don't pass one to `publicClient.call`, so this rarely
///   fires for us, but it's the cheap path when it does).
/// - Raw: viem's `RawContractError` carries `data` (a 0x-prefixed bytes string) on the cause.
///   That's the typical shape of `eth_call` revert data on a plain `publicClient.call`.
function extractRevertData(err: unknown): Hex | undefined {
    if (err instanceof BaseError) {
        const reverted = err.walk((e) => e instanceof ContractFunctionRevertedError) as
            | ContractFunctionRevertedError
            | undefined;
        if (reverted?.raw) return reverted.raw;
    }
    // Walk through the error and its `cause` chain for a `.data` field — covers viem's
    // `BaseError` chain, plain `RpcError` shapes, and the test mock that sets `.data`
    // directly on a `new Error(...)`.
    let cur: unknown = err;
    for (let depth = 0; depth < 8 && cur && typeof cur === "object"; depth++) {
        const data = (cur as {data?: unknown}).data;
        if (typeof data === "string" && /^0x[0-9a-fA-F]*$/.test(data)) return data as Hex;
        const cause = (cur as {cause?: unknown}).cause;
        if (cause === cur) break;
        cur = cause;
    }
    // Last resort: dig a 0x... blob out of the message.
    if (err instanceof Error) {
        const m = /(0x[0-9a-fA-F]{8,})/.exec(err.message);
        if (m) return m[1] as Hex;
    }
    return undefined;
}

/// Decode `data` against `errorAbi` and pretty-print. Recurses on `CallFailed(bytes)`.
function formatRevert(data: Hex, errorAbi: Abi): string {
    let decoded;
    try {
        decoded = decodeErrorResult({abi: errorAbi, data});
    } catch {
        return `revertData=${truncate(data)}`;
    }
    const args = decoded.args ?? [];
    if (decoded.errorName === "CallFailed" && typeof args[0] === "string") {
        const inner = formatRevert(args[0] as Hex, errorAbi);
        return `CallFailed → ${inner}`;
    }
    if (args.length === 0) return decoded.errorName;
    return `${decoded.errorName}(${args.map(formatArg).join(", ")})`;
}

function formatArg(v: unknown): string {
    if (typeof v === "bigint") return v.toString();
    if (typeof v === "string") return v;
    if (typeof v === "number" || typeof v === "boolean") return String(v);
    if (v === null || v === undefined) return String(v);
    try {
        return JSON.stringify(v, (_k, val) => (typeof val === "bigint" ? val.toString() : val));
    } catch {
        return "<unprintable>";
    }
}

function truncate(s: string, max = 130): string {
    return s.length > max ? `${s.slice(0, max)}…` : s;
}
