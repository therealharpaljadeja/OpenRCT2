import {createPublicClient, createWalletClient, http, type Chain, type Hex, type PublicClient, type WalletClient} from "viem";
import {privateKeyToAccount} from "viem/accounts";
import {log as defaultLog, type Logger} from "../log.js";

/// Build a viem `Chain` config for whatever testnet / mainnet the sidecar is pointed at.
/// We don't import a pre-baked `monadTestnet` from `viem/chains` because the sidecar should
/// follow `deployments.json`'s `chainId` — that artifact is the source of truth for "which
/// chain are we deployed to" and we don't want to fight a hard-coded chain object if Monad's
/// official chainId ever shifts on testnet.
export function makeChain(chainId: number, rpcUrl: string): Chain {
    return {
        id: chainId,
        // Display-only — Monad testnet is 10143; we surface a neutral name so the same builder
        // works for any future EVM testnet (anvil, Holesky, etc.) without confusing the logs.
        name: chainId === 10143 ? "Monad Testnet" : `chain-${chainId}`,
        nativeCurrency: {name: "MON", symbol: "MON", decimals: 18},
        rpcUrls: {default: {http: [rpcUrl]}},
    };
}

/// Default to **opt-in JSON-RPC batching** (M3.12). `wait: 0` only coalesces calls that are
/// already pending in the same microtask — no added latency. Public testnet RPCs (Monad's
/// QuickNode is 50 rps, 25 rps for `eth_call`) bite hard on bursts: the M3.11 stress run hit
/// timeouts during bootstrap because parallel `Promise.all([getBalance × 8, ...])` reads,
/// venue-mirror hydration, and first-touch `sigNonces` reads burst past the cap together.
/// Batching collapses those into a single HTTP per microtask. The settle hot path
/// (`eth_sendRawTransactionSync`) goes through the same client — concurrent sync sends from
/// different relayers naturally land in one batch, which is *better* than 8 separate HTTPs
/// (1 RPC slot used instead of 8). Receipts come back independently in the batch response.
const DEFAULT_BATCH: boolean | {wait: number} = true;
/// Bump from viem's 10 s default. Monad's `eth_sendRawTransactionSync` can take several
/// seconds end-to-end under load; layering a public-RPC's 429-with-backoff retry on top
/// frequently exceeded 10 s in M3.11. 30 s gives the receipt path room to breathe without
/// masking real chain stalls — operators can tune via `--rpc-timeout-ms` (config.ts).
const DEFAULT_RPC_TIMEOUT_MS = 30_000;

export interface ClientOptions {
    /// JSON-RPC batching policy. Defaults to `true` (`wait: 0` — coalesce same-tick calls
    /// only). Set `false` to disable for debugging; pass `{wait: N}` to add up to N ms of
    /// coalescing window (trades latency for fewer HTTPs).
    batch?: boolean | {wait: number};
    /// HTTP request timeout in ms. Default 30 s (M3.12). Applies to every JSON-RPC method
    /// that goes through the transport, including `eth_sendRawTransactionSync` on the hot
    /// path — bump higher if your RPC is slow under sustained load.
    timeoutMs?: number;
}

/// One-shot factory for the read-side. The sidecar holds a single `PublicClient` for the
/// life of the process — viem keeps the underlying HTTP transport keep-alive'd so per-call
/// overhead is negligible. The `eth_sendRawTransactionSync` hot path also goes through this
/// client (see `relayers/viem-submitter.ts`), so the batching + timeout settings affect both
/// reads and the settle submission.
export function makePublicClient(
    chainId: number,
    rpcUrl: string,
    opts: ClientOptions = {},
): PublicClient {
    const chain = makeChain(chainId, rpcUrl);
    return createPublicClient({
        chain,
        transport: http(rpcUrl, {
            batch: opts.batch ?? DEFAULT_BATCH,
            timeout: opts.timeoutMs ?? DEFAULT_RPC_TIMEOUT_MS,
        }),
    });
}

/// Wallet client for the Faucet owner. The faucet owner is the contract deployer EOA on
/// Monad testnet (see `contracts/deployments/monad-testnet.json#deployer`); its key has to
/// be supplied out-of-band because it's not derivable from the park's master mnemonic
/// (would require redeploying with a derived owner).
export function makeFaucetOwnerClient(
    chainId: number,
    rpcUrl: string,
    privateKey: `0x${string}`,
    opts: ClientOptions = {},
): WalletClient {
    const chain = makeChain(chainId, rpcUrl);
    const account = privateKeyToAccount(privateKey);
    return createWalletClient({
        chain,
        transport: http(rpcUrl, {
            batch: opts.batch ?? DEFAULT_BATCH,
            timeout: opts.timeoutMs ?? DEFAULT_RPC_TIMEOUT_MS,
        }),
        account,
    });
}

/// M3.14 — wallet client bound to an arbitrary HDAccount. Used to build per-operator
/// clients (one each for the funder, permit collector, sweeper) so each subsystem submits
/// admin txs from its own key + nonce sequence. The transport options default the same way
/// as the public/faucet clients so JSON-RPC batching + the 30 s timeout apply uniformly.
export function makeOperatorClient(
    chainId: number,
    rpcUrl: string,
    account: WalletClient["account"],
    opts: ClientOptions = {},
): WalletClient {
    if (!account) throw new Error("makeOperatorClient: account is required");
    const chain = makeChain(chainId, rpcUrl);
    return createWalletClient({
        chain,
        transport: http(rpcUrl, {
            batch: opts.batch ?? DEFAULT_BATCH,
            timeout: opts.timeoutMs ?? DEFAULT_RPC_TIMEOUT_MS,
        }),
        account,
    });
}

/// M3.13 — wait for a tx's receipt and throw if it reverted. The catch every subsystem in
/// the sidecar shares: `sendTransaction` / `writeContract` returns the *tx hash*, not the
/// receipt — the chain may have included the tx and reverted it (`status: 0x0`) and the
/// caller has no idea unless someone polls. Without this, every revert (transferFrom of
/// 0-balance guest, BadNonce, AlreadyRegistered, etc.) registers as a successful tx and
/// the metrics + recovery paths never fire.
///
/// Throwing on revert flows up to the existing per-subsystem `rpcErrors`/`onTerminalFailure`
/// counters, so consumers don't need new error-handling — just plug `await confirmTx(...)`
/// into the path that follows the submit.
///
/// We surface the tx hash + block + an `opName` in the error so an operator who sees the
/// error can click straight to the failed tx in a block explorer.
export interface ConfirmTxOptions {
    publicClient: PublicClient;
    txHash: Hex;
    /// Human-readable label to include in the error message ("funder.disperse",
    /// "permits.executeBatch", "venue.register", etc.).
    opName: string;
    /// Max wait time for inclusion. Default 30 s — well above Monad block time but short
    /// enough that a stuck tx fails fast rather than hanging the caller forever.
    timeoutMs?: number;
}

export async function confirmTx(opts: ConfirmTxOptions): Promise<{
    blockNumber: bigint;
    gasUsed: bigint;
}> {
    const timeoutMs = opts.timeoutMs ?? 30_000;
    const receipt = await opts.publicClient.waitForTransactionReceipt({
        hash: opts.txHash,
        timeout: timeoutMs,
    });
    if (receipt.status !== "success") {
        throw new Error(
            `${opts.opName} reverted on chain: tx=${opts.txHash} block=${receipt.blockNumber.toString()}`,
        );
    }
    return {blockNumber: receipt.blockNumber, gasUsed: receipt.gasUsed};
}

/// M3.16 — "warm up" a freshly-funded EOA by sending a 0-value self-transfer through its
/// wallet client. The Monad public RPC's `eth_sendRawTransaction` validation path has an
/// unpredictable lag behind on-chain state for new EOAs even after their funding tx
/// confirms (the chain has the funds; the validating RPC node hasn't seen them yet, and
/// `getBalance` lies less than `eth_sendRawTransaction` does). Sending a no-op self-transfer
/// first routes the operator's address through the same validation path with no state
/// side-effect; subsequent contract calls from the same wallet client then succeed cleanly.
///
/// Empirically: a fresh operator funded via `dripMon` will reject contract-call submissions
/// with `Signer had insufficient balance` for tens of seconds (even with `confirmTx` already
/// having waited for the funding receipt). After one successful self-transfer, the same
/// operator can submit any tx without retry. We retry on the warm-up tx itself with backoff
/// for the same reason — the warm-up tx is what trains the RPC node.
///
/// Cost: a few thousand gas + a tx hash on chain. Cheap relative to the alternative
/// (multi-minute backoff loops in every subsystem's first call).
export interface WarmUpEOAOptions {
    walletClient: WalletClient;
    publicClient: PublicClient;
    /// Total time to keep retrying the warm-up tx. Default 60 s — well past Monad's typical
    /// gossip lag.
    timeoutMs?: number;
    /// Backoff between retries. Default 5 s.
    retryDelayMs?: number;
    /// Optional label for log lines (e.g. "funder", "permits"). Defaults to the wallet's
    /// address truncated to 10 chars.
    label?: string;
    log?: Logger;
}

/// M3.16 — submit a tx and retry on Monad's `Signer had insufficient balance` mempool
/// error class. Combines `walletClient.sendTransaction` + `confirmTx` (M3.13) with the
/// retry policy that turned out to be necessary across every subsystem after M3.14: the
/// mempool-validation lag isn't per-EOA (the warmUpEOA helper assumed it was), it's per-
/// wallet-client. Each fresh viem walletClient's first contract call gets rejected
/// regardless of whether the underlying EOA has previously sent txs through some other
/// client. Internal retry inside the submit path is the only way to absorb the lag without
/// burning the *first* window-flush of each subsystem.
///
/// On non-recoverable errors (revert, BadSignature, etc.) the helper throws on first
/// attempt — only `Signer had insufficient balance` (and the equivalent error patterns
/// from other Geth-style chains) trigger retry. The retry rebuilds the tx (re-fetches
/// nonce, re-estimates fees) so a stale value isn't the cause of repeated failure.
export interface SubmitAndConfirmOptions {
    walletClient: WalletClient;
    publicClient: PublicClient;
    /// What to send. Same shape as `walletClient.sendTransaction`'s args minus `account` /
    /// `chain` (we read those off the walletClient).
    request: {to: `0x${string}`; data?: Hex; value?: bigint};
    /// Label for log lines + the thrown error message ("funder.treasury.execute" etc.).
    opName: string;
    /// Default 12 attempts × 10 s delay → 2 minutes of mempool-lag tolerance. Calibrated
    /// empirically against Monad public testnet — the cold operator EOA's first contract
    /// call lags up to ~60 s on the validator, well past the simpler 6×5s budget. Override
    /// via the option for time-sensitive callers.
    maxAttempts?: number;
    retryDelayMs?: number;
    log?: Logger;
}

export async function submitAndConfirm(opts: SubmitAndConfirmOptions): Promise<Hex> {
    const account = opts.walletClient.account;
    if (!account) throw new Error("submitAndConfirm: walletClient missing account");
    const log = (opts.log ?? defaultLog).child({mod: "submit", op: opts.opName});
    const maxAttempts = opts.maxAttempts ?? 12;
    const retryDelayMs = opts.retryDelayMs ?? 10_000;
    let lastErr: unknown;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        try {
            const txHash = await opts.walletClient.sendTransaction({
                account,
                chain: opts.walletClient.chain ?? null,
                to: opts.request.to,
                data: opts.request.data ?? "0x",
                value: opts.request.value ?? 0n,
            });
            await confirmTx({publicClient: opts.publicClient, txHash, opName: opts.opName});
            if (attempt > 1) log.info({attempt, txHash}, "succeeded after retry");
            return txHash;
        } catch (err) {
            lastErr = err;
            const msg = err instanceof Error ? err.message : String(err);
            if (attempt < maxAttempts && /insufficient balance/i.test(msg)) {
                log.warn(
                    {attempt, retryDelayMs},
                    "submit hit insufficient balance — Monad RPC mempool lag, retrying",
                );
                await new Promise<void>((r) => setTimeout(r, retryDelayMs));
                continue;
            }
            throw err;
        }
    }
    throw lastErr ?? new Error(`${opts.opName}: ran out of attempts`);
}

export async function warmUpEOA(opts: WarmUpEOAOptions): Promise<Hex> {
    const account = opts.walletClient.account;
    if (!account) throw new Error("warmUpEOA: walletClient missing account");
    const log = (opts.log ?? defaultLog).child({mod: "warmup", op: opts.label ?? account.address.slice(0, 10)});
    const timeoutMs = opts.timeoutMs ?? 60_000;
    const retryDelayMs = opts.retryDelayMs ?? 5_000;
    const deadline = Date.now() + timeoutMs;
    let attempt = 0;
    while (true) {
        attempt++;
        try {
            const txHash = await opts.walletClient.sendTransaction({
                account,
                chain: opts.walletClient.chain ?? null,
                to: account.address,
                data: "0x",
                value: 0n,
            });
            await confirmTx({publicClient: opts.publicClient, txHash, opName: "warmup.self-transfer"});
            log.info({attempt, txHash}, "warmup tx confirmed; subsystem ready to send");
            return txHash;
        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            const remaining = deadline - Date.now();
            if (remaining <= 0 || !/insufficient balance/i.test(msg)) {
                log.error({err, attempt, remaining}, "warmup failed");
                throw err;
            }
            log.warn({err, attempt, retryDelayMs}, "warmup hit insufficient balance — RPC mempool lag, retrying");
            await new Promise<void>((r) => setTimeout(r, Math.min(retryDelayMs, remaining)));
        }
    }
}
