import type {Hex} from "viem";
import type {HDAccount} from "viem/accounts";
import type {Batch} from "../batcher/index.js";
import {log as defaultLog, type Logger} from "../log.js";

/// Submission abstraction (plan §4.3 / M3.3).
///
/// The pool routes batches; the submitter does the actual chain work. Splitting these means
/// the M3.3 round-robin / nonce / queueing logic can be exercised against a hand-rolled mock
/// in unit tests, while the real viem-backed `eth_sendRawTransactionSync` path lands cleanly
/// in M3.4 by swapping out the implementation. Mirrors the same boundary M2.5 drew with
/// `BalanceReader` / `FaucetWriter`.

/// Per-tx outcome. `latencyMs` is wall-clock submit→confirm: with `eth_sendRawTransactionSync`
/// (M3.4) that's just the duration of the single sync RPC call, no polling.
export interface SubmitResult {
    txHash: Hex;
    blockNumber: bigint;
    gasUsed: bigint;
    latencyMs: number;
}

/// What the pool hands the submitter for each tx.
export interface SubmitArgs {
    /// The relayer's signing account (an `HDAccount` from `relayerPool(...)`). The submitter
    /// owns the tx-encoding + signing path; this is just the secret-bearing object.
    account: HDAccount;
    /// The exact nonce to use. The pool tracks this per-relayer; the submitter must not
    /// override or refresh it on its own — that's the pool's job (so error-recovery stays
    /// in one place).
    nonce: number;
    /// What goes on the wire — `SettlementBatcher.settle(auths, sigs)` calldata is built
    /// from `batch.auths` / `batch.sigs`.
    batch: Batch;
}

export interface RelayerSubmitter {
    submit(args: SubmitArgs): Promise<SubmitResult>;
    /// Read the relayer's current pending tx count from chain. The pool calls this lazily on
    /// first use of each relayer, and again on `nonce too low` / `already known` recovery.
    fetchNonce(address: `0x${string}`): Promise<number>;
}

/// Heuristics for "this error means our local nonce drifted from chain". String-matched
/// because every node implementation phrases it differently and the structured error code
/// path is even less consistent. Exported so tests can assert against the same set the pool
/// uses.
const NONCE_ERROR_PATTERNS: readonly RegExp[] = [
    /nonce too low/i,
    /already known/i,
    /replacement transaction underpriced/i,
    /known transaction/i,
    /tx already in mempool/i,
];

export function isNonceError(err: unknown): boolean {
    const msg = err instanceof Error ? err.message : String(err);
    return NONCE_ERROR_PATTERNS.some((re) => re.test(msg));
}

/// Stand-in submitter that doesn't touch the network. Useful in three places:
///   1. M3.3 boot before M3.4's viem-backed submitter exists — the sidecar can wire the
///      pool end-to-end into the batcher without an RPC URL or funded relayers.
///   2. Headless tests that need to exercise the *batcher → pool → sink* path without
///      pulling a network harness in.
///   3. Local dev cycles where you just want to watch the queue depth move without burning
///      MON.
///
/// The synthetic latency lets the pool's stats surface (lastLatencyMs, etc.) look realistic.
/// Synthetic block numbers monotonically increase per call so consumers that index by block
/// don't trip over duplicates.
export interface NoopSubmitterOptions {
    /// Synthetic per-call latency before resolution. Default 1 ms — enough to make the
    /// promise actually async (real chain calls are ≥ a network RTT).
    latencyMs?: number;
    /// Starting nonce returned by `fetchNonce`. Tests use 0; production-style sims could
    /// pass a non-zero seed to mimic a relayer that's already submitted prior txs.
    startingNonce?: number;
    log?: Logger;
}

export function createNoopSubmitter(opts: NoopSubmitterOptions = {}): RelayerSubmitter {
    const latencyMs = opts.latencyMs ?? 1;
    const startingNonce = opts.startingNonce ?? 0;
    const log = (opts.log ?? defaultLog).child({mod: "noop-submitter"});
    let calls = 0;
    return {
        async submit(args: SubmitArgs): Promise<SubmitResult> {
            calls++;
            const id = calls;
            // Wait the synthetic latency. `setImmediate` would technically suffice for "be
            // async" but not for testing latency-driven behaviour, so we honour the option.
            await new Promise<void>((resolve) => setTimeout(resolve, latencyMs));
            log.debug(
                {nonce: args.nonce, count: args.batch.auths.length, batchId: args.batch.id},
                "noop-submit",
            );
            // Synthetic but distinguishable per call so a stats consumer doesn't see e.g. a
            // constant `0xdead…` they might mistake for "tx never sent".
            const txHash = (`0x${id.toString(16).padStart(64, "0")}`) as Hex;
            return {
                txHash,
                blockNumber: BigInt(id),
                gasUsed: BigInt(args.batch.auths.length * 43_000), // ~43k/auth per M1.6 measurement
                latencyMs,
            };
        },
        async fetchNonce(_address: `0x${string}`): Promise<number> {
            // Always return the starting nonce — the pool only re-fetches on error, and the
            // noop submitter never produces nonce errors, so this is always the boot value.
            return startingNonce;
        },
    };
}
