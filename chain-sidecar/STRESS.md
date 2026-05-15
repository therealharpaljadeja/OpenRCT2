# Stress harness (M3.11)

The throughput demo's headline metric is `auth/s` — independent guest authorizations
confirmed on Monad per second. M3.11 ships the wiring + tooling needed to measure and tune
that number against testnet, ahead of M4 (the game-side outbox writer).

## Pieces

- **GUEST_SPEND hot path** — `src/batcher/dispatch.ts`. Dispatcher signs each spend as an
  EIP-712 `SpendAuth` and pushes it into the existing M3.2 `Batcher`, whose flushes feed the
  M3.3 relayer pool, whose submissions go through M3.4's `eth_sendRawTransactionSync`.
- **Per-guest sig nonce tracker** — `src/batcher/nonces.ts`. Lazy chain-side fetch on
  first-touch (`SettlementBatcher.sigNonces[guest]`), local increment thereafter.
- **Stress harness CLI** — `src/stress/cli.ts` → `rct2-stress` binary. Synthesizes valid
  outbox events at a configurable rate without needing the game.

## Operator runbook

### One-time setup

You need three credentials on the host:

1. **Faucet-owner private key** — the deployer EOA from
   `contracts/deployments/monad-testnet.json`. Owns `Faucet`, `ParkTreasury`, and
   `VenueRegistry`. Drop the 0x-prefixed key into a file readable only by your user
   (`chmod 0600`):

   ```sh
   echo "0x<deployer-private-key>" > /tmp/rct2-faucet-key
   chmod 0600 /tmp/rct2-faucet-key
   ```

2. **Keystore passphrase** — encrypts the master mnemonic (relayer pool + guests are derived
   from this; dropping it = losing every guest's testnet balance):

   ```sh
   echo "<your-passphrase>" > /tmp/rct2-pass
   chmod 0600 /tmp/rct2-pass
   ```

3. **Monad testnet RPC URL** — the public endpoint or your own node.

### Boot the sidecar

```sh
cd OpenRCT2/chain-sidecar
node dist/main.js \
  --socket /tmp/rct2-sidecar.sock \
  --deployments ../contracts/deployments/monad-testnet.json \
  --keystore /tmp/rct2-keystore.json \
  --keystore-passphrase-file /tmp/rct2-pass \
  --rpc-url https://testnet-rpc.monad.xyz \
  --faucet-owner-keyfile /tmp/rct2-faucet-key \
  --outbox /tmp/rct2-stress.wal \
  --relayer-count 8
```

First boot creates a fresh keystore (warning logged); back the file up — only the passphrase
can decrypt it.

The sidecar will:

1. Derive 8 relayer EOAs (`m/44'/60'/0'/1/0..7`).
2. Begin polling `/tmp/rct2-stress.wal` for events (no producer yet — empty file is fine).
3. Stand up a top-up loop that drips MON to relayers below the low-water mark on a 30 s
   schedule (the loop is a no-op on a fresh testnet until the next step).

In a separate terminal, run the park-launch flow once to prime treasury PARK + relayer MON:

```sh
echo '{"jsonrpc":"2.0","id":1,"method":"chain.faucet.drip","params":{}}' | nc -U /tmp/rct2-sidecar.sock
```

This emits one tx that mints 1,000,000 PARK to the treasury and one tx that splits MON
across the relayer pool. After it lands, `chain.balances` should show the treasury and
relayers funded.

### Kick off a stress run

```sh
node dist/stress/cli.js \
  --outbox /tmp/rct2-stress.wal \
  --guests 200 \
  --venues 50 \
  --rate 1000 \
  --duration 60
```

The harness:

1. Emits 50 `VENUE_REGISTERED` events (the sidecar's M3.8 venue mirror submits one tx per
   event). On re-runs the chain reverts duplicates as `AlreadyRegistered` and the mirror
   counts them under `skippedAlreadyApplied`.
2. Emits 200 `GUEST_ENTRY` events (the M3.5 funder fans PARK out via
   `treasury.execute(disperse, …)`; the M3.6 permit collector batches each guest's
   EIP-2612 permit).
3. Emits `GUEST_SPEND` at 1000 auth/s for 60 s.

Monitor live throughput from a third terminal:

```sh
echo '{"jsonrpc":"2.0","id":1,"method":"chain.throughput","params":{}}' | nc -U /tmp/rct2-sidecar.sock
```

The reply has `txPerSecond`, `authPerSecond`, `latencyMs.{p50,p95,p99}`, `batchFill`, queue
depths, and per-subsystem error counters. Loop it (`watch -n 1 …`) for a live view.

### Sweep relayer + batch parameters

The plan asks "tune relayer pool size and batch parameters". The sweep is:

| Knob | Default | Range to try | What changes |
| --- | --- | --- | --- |
| `--relayer-count` | 8 | 4 / 8 / 16 / 32 | More relayers = more parallel `sendRawTransactionSync` calls per second. Each relayer is gated by per-EOA nonce sequencing, so doubling = roughly doubling cap. |
| `BATCH_MAX_SIZE` | 256 | 64 / 128 / 256 / 512 | Calldata per tx (and gas per tx — see M1.6's flat ~43k/auth). 512 fits inside a single Monad block but eats `chain.batch.config` a single relayer's full block budget per submission. |
| `BATCH_MAX_AGE_MS` | 200 | 50 / 100 / 200 / 500 | Lower = lower queueing latency at the cost of less batch density when the producer is slow. Doesn't affect peak throughput, only the spend → confirm latency floor. |

Adjust the batcher knobs at runtime without restarting the sidecar:

```sh
echo '{"jsonrpc":"2.0","id":1,"method":"chain.batch.config","params":{"maxSize":512,"maxAgeMs":100}}' \
  | nc -U /tmp/rct2-sidecar.sock
```

For relayer count, restart the sidecar with `--relayer-count <N>` (the pool size is fixed at
boot — it's tied to HD derivation `m/44'/60'/0'/1/0..N-1`, and re-derivation mid-flight would
orphan in-flight nonces).

For each (relayers, maxSize, maxAgeMs) triple, run `rct2-stress --rate <target>` for 60 s and
record:

- `auth/s` from `chain.throughput.authPerSecond`
- `tx/s` from `chain.throughput.txPerSecond`
- p95 latency from `chain.throughput.latencyMs.p95`
- `batchFill.avg` (lower than `maxSize` = age-flushes dominating; equal to `maxSize` = the
  size trigger is firing first)
- `errors.relayerPoolErrors`, `errors.relayerPoolNonceRefreshes`, `drops.batcherAuths`

### Expected ranges

From the M1.6 contract gas benchmarks + Monad's 1 s blocks:

- Single relayer, `maxSize=256`: ~256 auth/block = ~256 auth/s ceiling.
- 8 relayers, `maxSize=256`: ~2 048 auth/s ceiling.
- 16 relayers, `maxSize=256`: ~4 096 auth/s ceiling — within 20 % of the demo target.
- 16 relayers, `maxSize=512`: ~8 192 auth/s ceiling, but only if the chain accepts 22 M-gas
  txs per relayer per block. Test before committing.

These are upper bounds; observed numbers will be lower because of `sendRawTransactionSync`
round-trip latency, fee oracle TTL, and the operator's network path to Monad.

## Pure-spend mode (sweep without re-funding)

Once a guest set is funded + permitted, you can re-run the spend portion without the
bootstrap costs:

```sh
node dist/stress/cli.js \
  --outbox /tmp/rct2-stress.wal \
  --guests 200 \
  --venues 50 \
  --rate 5000 \
  --duration 30 \
  --no-bootstrap
```

Use this for the (rate × relayers × maxSize) sweep so each sample is just the spend hot
path. The funder + permit + venue-mirror lines on `chain.throughput.queues` should stay at
0 throughout.

## Known limitations

- **Sig-nonce tracker is in-process.** A sidecar restart re-fetches each guest's nonce from
  chain on first touch — correct, but spend events that were in flight at the moment of
  crash are re-played from the WAL with the same nonces and revert. The relayer pool's
  one-shot retry path doesn't help here; the cure is "M3.x + WAL replay with per-batch
  nonce refresh", deferred.
- **Fee oracle is cached for 3 s.** Under sustained load the cached `estimateFeesPerGas` is
  fine; during a burst-then-quiet pattern the first burst after the cache expires can pay a
  visibly higher tip.
- **Producer-side backpressure dominates.** At rates above ~5000 auth/s the harness starts
  reporting `overruns` (its own loop misses tick deadlines) before the sidecar saturates.
  Increase `--tick-ms` or run two harness processes against the same WAL — the WAL is
  append-safe under POSIX `O_APPEND`.

## Files

- `src/batcher/dispatch.ts` — the GUEST_SPEND hot path.
- `src/batcher/nonces.ts` — per-guest sig nonce tracker.
- `src/stress/generator.ts` — synthetic-event loop.
- `src/stress/cli.ts` — `rct2-stress` binary.
- Tests: `test/batcher-dispatch.test.ts`, `test/batcher-nonces.test.ts`, `test/stress.test.ts`.
