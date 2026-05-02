# Chain Mode — RCT2 × Monad Throughput Demo

This fork adds an opt-in **chain mode** that turns every guest in the park into a real EVM account on the Monad testnet. Each spend a guest makes — entrance fee, ride fare, drink, burger, ATM withdrawal — produces a real, individually-signed authorization from that guest's key. A sidecar packs these into batched on-chain transactions in real time.

The goal is **throughput**. A busy park sustains hundreds of authorized spends per second; with the speed multiplier and a stress-mode crowd, multi-thousand auth/sec is realistic. Each block carries thousands of independent guest signatures verified and applied in parallel — exactly the workload Monad's parallel execution is built for.

## The two metrics

- **`tx/s`** — raw transactions per second the park submits.
- **`auth/s`** — effective signed guest authorizations per second. This is the headline number; one batched tx can carry hundreds of independent guest signatures.

Both are surfaced live in the Treasury window in-game and via `rctctl chain throughput`.

## Enabling chain mode

Chain mode is **off by default**. To use it you need:

1. A build with the chain feature compiled in:
   ```
   cmake -S . -B build -DOPENRCT2_CHAIN=ON ...
   cmake --build build --target agent_bundle -j8
   ```
2. The runtime opt-in flag when launching the game:
   ```
   ./build/OpenRCT2 --chain
   ```
   `--no-chain` wins if both are passed. With neither, chain integration stays dormant and the game runs normally.

When the build flag is off, all `chain.*` commands and RPC endpoints still exist but report `enabled: false` so tooling never breaks.

## Quick check

```
rctctl chain status
```

Reports whether chain mode is on for the current session. When enabled, it expands to include sidecar health, the relayer pool, and current block — those fields land as later milestones ship.

## What gets built when you turn it on

When the feature is enabled end-to-end, four pieces work together:

1. **Smart contracts** (Foundry, deployed to Monad testnet) — `ParkToken`, `Faucet`, `SettlementBatcher`, `VenueRegistry`, `GuestRegistry`, `ParkTreasury`, `LendingPool`.
2. **Sidecar** (Node.js + viem) — drains a game-side outbox of spend events, signs EIP-712 authorizations using HD-derived per-guest keys, and feeds packed `SettlementBatcher.settle(...)` calls to a small relayer pool.
3. **Game hooks** — minimal cost in the tick: each economic event is one ring-buffer push to the outbox; no syscalls, no chain reads on the hot path.
4. **Indexer** (Envio HyperIndex) — exposes a hosted GraphQL endpoint that the in-game Treasury window and `rctctl chain feed` both read from.

Guests don't pay gas — the relayer pool does. Each guest does, however, hold a real ERC-20 PARK balance you can verify in any block explorer.

## What stays cheap on the game side

The game is just an event source. All signing, batching, and submission happens out-of-process. A drowning sidecar never blocks the game; events can pile up or drop and gameplay continues. The on-chain feed surfaces backpressure honestly.

## Stress demo

Once the full pipeline lands, the showcase is:

```
rctctl chain stress start --guests 5000 --multiplier 4
rctctl chain throughput --watch
```

This spawns a large crowd, bumps the game speed, and lets you watch the live `auth/s` curve in the terminal while the in-game Treasury window mirrors the same numbers.

## Where the rest is documented

This doc is the **what and why**. For the full design — wallet model, signature scheme, contract surface, sidecar architecture, indexer schema, and milestone breakdown — see [`ONCHAIN_PLAN.md`](./ONCHAIN_PLAN.md).
