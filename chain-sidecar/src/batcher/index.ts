/// The hot path. Signs each guest spend as an EIP-712 `SpendAuth` (M3.1, `sign.ts`), packs
/// auths into the active batch and flushes on `BATCH_MAX_SIZE` / `BATCH_MAX_AGE_MS` (M3.2,
/// `batch.ts`). M3.3 plugs the relayer pool in as the batch sink.
export {
    SPEND_AUTH_DOMAIN_NAME,
    SPEND_AUTH_DOMAIN_VERSION,
    SPEND_AUTH_TYPES,
    spendAuthDomain,
    hashSpendAuth,
    signSpendAuth,
    recoverSpendAuthSigner,
    type SpendAuth,
    type SpendAuthDomain,
} from "./sign.js";
export {
    Batcher,
    DEFAULT_BATCH_MAX_SIZE,
    DEFAULT_BATCH_MAX_AGE_MS,
    DEFAULT_MAX_QUEUED_AUTHS,
    MAX_BATCH_MAX_SIZE,
    type Batch,
    type BatchSink,
    type BatcherOptions,
    type BatcherStats,
    type FlushReason,
    type SignedAuth,
    type SinkResult,
} from "./batch.js";
/// M3.11 — per-guest signature-nonce tracker (lazy chain fetch + local increment).
export {SpendNonceTracker} from "./nonces.js";
export type {SpendNonceTrackerOptions, SpendNonceTrackerChainOptions, SpendNonceTrackerTestOptions} from "./nonces.js";
/// M3.11 — GUEST_SPEND → SpendAuth → Batcher hot path.
export {SpendDispatcher, DEFAULT_AUTH_DEADLINE_SECONDS} from "./dispatch.js";
export type {SpendDispatcherOptions, SpendDispatcherStats} from "./dispatch.js";
