import {encodeFunctionData, type Hex, type PublicClient, type WalletClient} from "viem";
import {PARK_TREASURY_ABI} from "./abis.js";
import {confirmTx} from "./clients.js";
import {log as defaultLog, type Logger} from "../log.js";

/// Boot-time helper that authorizes the sidecar's operator EOAs on `ParkTreasury`. M3.14:
/// each high-volume admin subsystem (funder, permits, sweeper) gets its own EOA for
/// nonce-isolation; before the sidecar can use them, the on-chain `Treasury.operators`
/// mapping must include each address. The mapping is owner-only — only the deployer key
/// can call `addOperator` — so this helper runs once at sidecar boot from the deployer's
/// `walletClient`, idempotent under re-runs (the contract no-ops on re-add and the helper
/// reads `operators(addr)` first to skip the tx entirely when the chain is already in
/// the desired state).
///
/// Why per-EOA reads + maybe-tx (rather than blanket re-add): saves a tx per operator on
/// every restart, and keeps the operator-set authoritative on chain. A typo in the
/// mnemonic would surface here as a tx-from-wrong-deployer, not a silent set-and-forget.

export interface AuthorizeOperatorsOptions {
    walletClient: WalletClient;
    publicClient: PublicClient;
    treasury: `0x${string}`;
    /// Operator EOA addresses, in canonical order (funder/permits/sweeper). Ordering doesn't
    /// affect correctness — each is checked + authorized independently — but the result
    /// array preserves the input order so callers can correlate.
    operators: readonly `0x${string}`[];
    log?: Logger;
}

export interface AuthorizeOperatorsResult {
    address: `0x${string}`;
    /// `true` if this run sent an `addOperator` tx (the operator wasn't already authorized).
    /// `false` means the on-chain state already matched.
    authorized: boolean;
    /// Tx hash, present only when `authorized === true`.
    txHash?: Hex;
}

export async function authorizeOperators(
    opts: AuthorizeOperatorsOptions,
): Promise<AuthorizeOperatorsResult[]> {
    const log = (opts.log ?? defaultLog).child({mod: "operators"});
    const account = opts.walletClient.account;
    if (!account) throw new Error("authorizeOperators: walletClient missing account");
    const chain = opts.walletClient.chain ?? null;
    const out: AuthorizeOperatorsResult[] = [];
    for (const addr of opts.operators) {
        const already = (await opts.publicClient.readContract({
            address: opts.treasury,
            abi: PARK_TREASURY_ABI,
            functionName: "operators",
            args: [addr],
        })) as boolean;
        if (already) {
            log.info({operator: addr}, "operators: already authorized on chain — skipping addOperator");
            out.push({address: addr, authorized: false});
            continue;
        }
        const data = encodeFunctionData({
            abi: PARK_TREASURY_ABI,
            functionName: "addOperator",
            args: [addr],
        });
        const txHash = await opts.walletClient.sendTransaction({
            account,
            chain,
            to: opts.treasury,
            data,
            value: 0n,
        });
        await confirmTx({publicClient: opts.publicClient, txHash, opName: "treasury.addOperator"});
        log.info({operator: addr, tx: txHash}, "operators: authorized via addOperator");
        out.push({address: addr, authorized: true, txHash});
    }
    return out;
}
