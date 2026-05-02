import {encodeFunctionData, type Hex, type PublicClient} from "viem";
import {sendRawTransactionSync} from "viem/actions";
import {SETTLEMENT_BATCHER_ABI} from "../chain/abis.js";
import {log as defaultLog, type Logger} from "../log.js";
import type {RelayerSubmitter, SubmitArgs, SubmitResult} from "./submitter.js";

/// viem-backed `RelayerSubmitter` (plan §4.3 / M3.4).
///
/// One in-flight call per relayer is enforced by `RelayerPool`; this submitter is stateless
/// per call apart from the cached fee snapshot. The hot path is:
///
///   1. encode `settle(auths, sigs)`
///   2. build EIP-1559 tx with the relayer's nonce + a refreshed fee snapshot
///   3. sign locally via the `HDAccount` (no key leaves the process)
///   4. submit via Monad's `eth_sendRawTransactionSync` and return the receipt
///   5. wall-time around step 4 is the submit→confirm latency we surface to the pool
///
/// The pool is in charge of retries / nonce refresh; this submitter only throws. Any error
/// message the node emits passes through unchanged so `isNonceError` (in `submitter.ts`) can
/// match on the canonical strings ("nonce too low", "already known", etc.).
///
/// Why `sendRawTransactionSync` rather than the standard `eth_sendRawTransaction` +
/// `eth_getTransactionReceipt` polling: it's a single round-trip per tx, and that round-trip
/// is also our submit→confirm latency measurement — no polling pipeline, no separate receipt
/// state machine, no clock skew to reason about. EIP-7966 / Monad RPC.

export interface ViemSubmitterOptions {
    /// Read-side viem client. Used both for fee/gas reads and to host the
    /// `eth_sendRawTransactionSync` request — viem's action dispatches on `client.request`,
    /// so any client with the same `chain.id` works.
    publicClient: PublicClient;
    /// `SettlementBatcher` address — destination of every batch tx.
    settlementBatcher: `0x${string}`;
    /// Per-auth gas. M1.6 measured ~42.7-43.2k gas/auth flat across N ∈ {64, 128, 256, 512}.
    /// We default to a 50k-per-auth budget plus a 200k baseline (intrinsic + array decode +
    /// VenueRegistry SLOAD warmup) — comfortably above the measured curve so we don't
    /// out-of-gas under load. Tunable for stress runs that bump `BATCH_MAX_SIZE`.
    perAuthGas?: bigint;
    /// Constant gas overhead added once per tx (intrinsic + calldata decode + outer overhead).
    baseGas?: bigint;
    /// Min fee snapshot freshness. Monad blocks are ~1s; fees rarely move dramatically inside
    /// a few blocks, so caching for 3s saves an RPC per submit without risking stale-tx
    /// rejection. Set to 0 to refresh on every submit (test-time use).
    feeCacheMs?: number;
    /// Optional override for `sendRawTransactionSync` — exposed for tests so we don't need a
    /// real RPC endpoint.
    sendRawSync?: (serialized: `0x${string}`) => Promise<{txHash: Hex; blockNumber: bigint; gasUsed: bigint}>;
    /// Same idea for the fee fetch — tests inject deterministic fees.
    fetchFees?: () => Promise<{maxFeePerGas: bigint; maxPriorityFeePerGas: bigint}>;
    /// And for the nonce read. Production path uses `getTransactionCount({blockTag: "pending"})`.
    fetchNonce?: (addr: `0x${string}`) => Promise<number>;
    /// Wall clock — injectable so latency assertions in tests are deterministic.
    now?: () => number;
    log?: Logger;
}

export const DEFAULT_PER_AUTH_GAS = 50_000n;
export const DEFAULT_BASE_GAS = 200_000n;
export const DEFAULT_FEE_CACHE_MS = 3_000;

/// Build a submitter ready to plug into `RelayerPool`. The returned object is safe to share
/// across the whole pool — nothing in here is per-relayer except via the `args.account`
/// passed into each `submit` call.
export function createViemSubmitter(opts: ViemSubmitterOptions): RelayerSubmitter {
    const {publicClient, settlementBatcher} = opts;
    const perAuthGas = opts.perAuthGas ?? DEFAULT_PER_AUTH_GAS;
    const baseGas = opts.baseGas ?? DEFAULT_BASE_GAS;
    const feeCacheMs = opts.feeCacheMs ?? DEFAULT_FEE_CACHE_MS;
    const now = opts.now ?? Date.now;
    const log = (opts.log ?? defaultLog).child({mod: "viem-submitter"});

    if (!publicClient.chain) {
        throw new Error("createViemSubmitter: publicClient.chain is required (chainId for EIP-1559 sig)");
    }
    if (!/^0x[0-9a-fA-F]{40}$/.test(settlementBatcher)) {
        throw new Error(`createViemSubmitter: settlementBatcher is not a 20-byte hex address: ${settlementBatcher}`);
    }
    const chainId = publicClient.chain.id;

    // Default fee fetch: viem's `estimateFeesPerGas` returns an EIP-1559 pair using the same
    // formula viem itself uses for `prepareTransactionRequest`. We don't currently have a
    // post-1559 chain that wants the legacy gasPrice path, so this is fine.
    const fetchFeesImpl = opts.fetchFees ?? (async () => {
        const fees = await publicClient.estimateFeesPerGas();
        return {
            maxFeePerGas: fees.maxFeePerGas,
            maxPriorityFeePerGas: fees.maxPriorityFeePerGas,
        };
    });
    const fetchNonceImpl = opts.fetchNonce ?? (async (addr: `0x${string}`) => {
        // `pending` so a relayer that already has unmined txs in the mempool doesn't collide
        // with itself on restart (pool also calls this lazily on first use).
        return publicClient.getTransactionCount({address: addr, blockTag: "pending"});
    });

    const sendRawSyncImpl = opts.sendRawSync ?? (async (serialized) => {
        const receipt = await sendRawTransactionSync(publicClient, {serializedTransaction: serialized});
        return {
            txHash: receipt.transactionHash,
            blockNumber: receipt.blockNumber,
            gasUsed: receipt.gasUsed,
        };
    });

    let feeCache: {at: number; fees: {maxFeePerGas: bigint; maxPriorityFeePerGas: bigint}} | null = null;
    async function getFees(): Promise<{maxFeePerGas: bigint; maxPriorityFeePerGas: bigint}> {
        const t = now();
        if (feeCache && t - feeCache.at < feeCacheMs) return feeCache.fees;
        const fees = await fetchFeesImpl();
        feeCache = {at: t, fees};
        return fees;
    }

    return {
        async submit(args: SubmitArgs): Promise<SubmitResult> {
            const {account, nonce, batch} = args;
            // `bytes[]` on the wire is `0x...` strings; the type-cast to readonly tuple is
            // just to satisfy viem's `encodeFunctionData` arg-shape check.
            const data = encodeFunctionData({
                abi: SETTLEMENT_BATCHER_ABI,
                functionName: "settle",
                args: [batch.auths as readonly never[], batch.sigs as readonly Hex[]],
            });
            const fees = await getFees();
            const gas = baseGas + perAuthGas * BigInt(batch.auths.length);

            const serialized = await account.signTransaction({
                type: "eip1559",
                chainId,
                to: settlementBatcher,
                data,
                nonce,
                gas,
                maxFeePerGas: fees.maxFeePerGas,
                maxPriorityFeePerGas: fees.maxPriorityFeePerGas,
                value: 0n,
            });

            const startedAt = now();
            try {
                const receipt = await sendRawSyncImpl(serialized);
                const latencyMs = now() - startedAt;
                log.debug(
                    {
                        relayer: account.address,
                        batchId: batch.id,
                        nonce,
                        count: batch.auths.length,
                        gas: gas.toString(),
                        latencyMs,
                        txHash: receipt.txHash,
                        block: receipt.blockNumber.toString(),
                    },
                    "settle submitted",
                );
                return {
                    txHash: receipt.txHash,
                    blockNumber: receipt.blockNumber,
                    gasUsed: receipt.gasUsed,
                    latencyMs,
                };
            } catch (err) {
                // Pool decides whether this is a nonce-refresh case or a hard fail. We just
                // surface the message verbatim so `isNonceError` can string-match. A revert
                // (TransactionReceiptRevertedError) flows through the same path.
                const latencyMs = now() - startedAt;
                log.warn(
                    {relayer: account.address, batchId: batch.id, nonce, latencyMs, err},
                    "settle submission failed",
                );
                throw err;
            }
        },
        async fetchNonce(address: `0x${string}`): Promise<number> {
            return fetchNonceImpl(address);
        },
    };
}
