/// Tracks `tx/s`, `auth/s`, p50/p95/p99 submit→confirm latency, batch-fill, queue depth,
/// dropped auths, and per-relayer pending-nonce / busy state. Surfaced over JSON-RPC for
/// rctctl + the in-game Treasury window. Lands in M3.9.
export {};
