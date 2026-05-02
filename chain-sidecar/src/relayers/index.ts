/// Pool of treasury-funded EOAs that submit batched `SettlementBatcher.settle` calls.
/// M3.3 lands the round-robin / nonce-tracking / queue-cap pool (`pool.ts`) plus the
/// submitter abstraction (`submitter.ts`) that M3.4 will back with viem's
/// `eth_sendRawTransactionSync`.
export {
    RelayerPool,
    DEFAULT_MAX_QUEUED_BATCHES,
    type RelayerPoolOptions,
    type RelayerPoolStats,
    type RelayerStats,
} from "./pool.js";
export {
    createNoopSubmitter,
    isNonceError,
    type RelayerSubmitter,
    type SubmitArgs,
    type SubmitResult,
    type NoopSubmitterOptions,
} from "./submitter.js";
export {
    createViemSubmitter,
    DEFAULT_PER_AUTH_GAS,
    DEFAULT_BASE_GAS,
    DEFAULT_FEE_CACHE_MS,
    type ViemSubmitterOptions,
} from "./viem-submitter.js";
