/// The hot path. Signs each guest spend as an EIP-712 `SpendAuth`, packs into the active batch,
/// flushes on `BATCH_MAX_SIZE` or `BATCH_MAX_AGE_MS`, and hands flushed batches to the relayer
/// pool for submission. Lands in M3.1 / M3.2.
export {};
