/// Pool of treasury-funded EOAs that submit batched `SettlementBatcher.settle` calls via
/// Monad's `eth_sendRawTransactionSync` — one in-flight sync call per relayer at a time.
/// Lands in M3.3 / M3.4.
export {};
