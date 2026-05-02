/// The hot path. Signs each guest spend as an EIP-712 `SpendAuth`, packs into the active batch,
/// flushes on `BATCH_MAX_SIZE` or `BATCH_MAX_AGE_MS`, and hands flushed batches to the relayer
/// pool for submission.
///
/// M3.1 lands the EIP-712 signer (`sign.ts`); M3.2 will add the batch accumulator + flush
/// triggers; M3.3 the relayer pool.
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
