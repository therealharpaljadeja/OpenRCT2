# RCT2 × Monad — Per-Guest Onchain Wallets (Throughput Demo)

> Working plan. Edit in place; don't re-paste in chat.

## 1. Design overview

### 1.1 The pitch

Every guest who walks through the park gates gets a **real EVM account** on Monad testnet. Every payment they make — entrance fee, ride fare, drink, burger, ATM withdrawal — produces a **real, individually-signed EIP-712 authorization** from *that* guest's key.

The sidecar continuously drains the game's outbox and packs guests' signed authorizations into `SettlementBatcher.settle(...)` calls — typically one tx every ~200 ms carrying 100–500 independent guest authorizations. A busy park (~1500 guests, default game speed) produces roughly **300–600 authorized spend events/second**; pushed with the speed-multiplier and 5000+ guests, **multi-thousand auth/sec** is realistic.

**The demo is the throughput.** Each block carries thousands of independent guest signatures verified and applied in parallel — exactly the workload Monad's parallel execution is designed to demolish. Two metrics matter and we surface both:

- **`tx/s`** — raw transactions per second the park submits.
- **`auth/s`** — effective signed guest authorizations per second (i.e. real "spends" the chain has executed).

Why batching is a feature, not a compromise:
- There are always many spends in flight at once — coalescing them is free wins, not a hack.
- Each authorization is its own EIP-712 signature; the chain still sees N independent signers per block.
- Batched calldata is much denser than N raw txs → more meaningful work per Monad block, more dramatic on-chain feed for indexers to render.
- Guests don't need MON for gas — the treasury (relayer) pays. Funding logistics shrink to "drip a one-time MON balance to a small relayer pool" instead of "fund 5000 EOAs".

### 1.2 What stays cheap on the game side

The game tick is untouchable:
- Each economic event is **one ring-buffer push** in C++.
- All signing, nonce management, fanout, and submission lives in the **sidecar**.
- A drowning sidecar never blocks the game; events can drop or pile up, gameplay continues.

The blockchain is the heavy lifter; the game is just an event source.

### 1.3 Why per-guest, always-batched

| Config | Wallet model | Submission | Authentic signatures | Verdict |
|---|---|---|---|---|
| Aggregated pool | Single shared float | Park treasury signs | One signer for everyone | ❌ uninteresting for Monad |
| Per-guest, every-spend-is-its-own-tx | Each guest = EOA | 1 tx per spend | Each guest signs each tx | ❌ wastes calldata; each spend submitted alone is silly when 100 are pending |
| **Per-guest, batched (this plan)** | Each guest = EOA | EIP-712 auths packed into one `SettlementBatcher.settle` tx | Each guest signs each spend | ✅ thousands of independent signers per block; dense calldata; relayer pays gas |

Park-side flows (loans, wages, marketing, construction, venue lifecycle) batch independently on their own slower cadence — they're the "boring" admin path. The interesting parallelism is in guest spend.

---

## 2. Per-guest wallet model

### 2.1 Key derivation
- Master seed generated once per park save (BIP-39 mnemonic), encrypted in the sidecar's keystore.
- Each guest gets an HD index `m/44'/60'/0'/0/<guestIdx>`.
- Game stores only the `uint32 hdIndex` in the `Guest` struct — actual key never touches the game process.
- 24-byte overhead per guest (cached address + 4-byte index). For 5000 guests = ~120 KB.

### 2.2 Gas — guests never pay it

Guests sign EIP-712 messages off-chain only. The `SettlementBatcher.settle` tx is paid for by a small **relayer pool** of treasury-funded EOAs (e.g. 4–8 relayers so per-EOA nonce sequences don't bottleneck). The relayer pool is topped up by a single `Faucet.drip` at park launch and refilled from the treasury periodically.

This means:
- No per-guest gas funding. No `disperseEther`. No 5000-EOA gas dust to sweep on exit.
- The only actor that needs MON is the small relayer pool.

### 2.3 Funding PARK tokens — guests hold real ERC-20 balances

We want `ParkToken.balanceOf(guest)` to be the real, observable balance — so a block explorer or feed dapp can see exactly how much cash each guest has at any moment.

When guests enter the park, sidecar sees `GUEST_ENTRY` events, queues addresses, fires `Disperse.disperseToken(PARK, addresses, amounts)`. Amount = whatever cash the game gave the guest. Each guest now has a real PARK balance.

Each guest also signs an EIP-2612 `permit` for the `SettlementBatcher` at entry — one off-chain signature, no on-chain tx — granting unlimited allowance. The batcher uses `transferFrom` on settle, so:
- Guest's `balanceOf` decreases on every spend (visible in explorers).
- Treasury / venue sub-account `balanceOf` increases on every spend.
- No internal-ledger trick; everyone holds real ERC-20.

On exit, sidecar sweeps remaining balance back to treasury via a single `transferFrom` (their permit is still valid).

### 2.4 EIP-712 authorization

Each guest spend produces a typed-data signature over:

```
SpendAuth {
  address from;        // guest
  address to;          // shop / treasury sub-account
  uint256 amount;
  uint8   category;    // ride/shop/facility/entry/atm
  uint64  nonce;       // per-guest sig nonce, separate from EOA nonce
  uint64  deadline;
}
```

Sidecar collects N of these (configurable; default 256), encodes them into `SettlementBatcher.settle(SpendAuth[], bytes[])`, submits one tx. Contract verifies each signature, calls `transferFrom(guest, venueSubAccount, amount)`, emits one `GuestSpend` event per item.

This means a single block can carry **thousands of independent guest authorizations** — useful for showing off Monad's signature-verification throughput and parallel execution of independent state writes within one tx.

### 2.5 Why this is honest
A skeptic could argue: "the sidecar holds all the keys, so nothing is really independent." True — but:
- Each *authorization* has a unique signature; the chain verifies N independent signatures and executes N independent `transferFrom`s, each affecting a distinct guest's `balanceOf`.
- The workload is identical to "5000 humans tapping NFC cards" — independent signers making concurrent transfers.
- Optionally export the mnemonic so any guest's wallet can be re-derived in MetaMask and inspected.

This is the "wallet-as-a-service" pattern many real onchain games use, instrumented at extreme scale.

---

## 3. Contracts (Foundry, deployed to Monad testnet)

Live in `OpenRCT2/contracts/`.

1. **`ParkToken.sol`** — ERC-20 in-game currency. Mintable by `Faucet`. Supports EIP-2612 `permit` so allowances can be set by signature.
2. **`Faucet.sol`** — Drips PARK + MON to park treasury on first run; rate-limited.
3. **`Disperse.sol`** — Mass-fund helper: `disperseEther(addrs, amts)` and `disperseToken(token, addrs, amts)`.
4. **`ParkTreasury.sol`** — Ownable smart account holding park's operating PARK; receives all guest payments; pays staff/loans/construction.
5. **`LendingPool.sol`** — Park-level loan: borrow/repay/accrued interest, `Bankruptcy` event.
6. **`SettlementBatcher.sol`** — Verifies an array of EIP-712 `SpendAuth` signatures and executes each transfer in one tx. Emits one `GuestSpend` per item. Per-guest sig-nonce mapping to prevent replay. **Used by batched mode.**
7. **`VenueRegistry.sol`** — Source of truth for *named buildings* in the park. See §3.1.
8. **`GuestRegistry.sol`** — Mapping `guestId → address`, `address → entryBlock`, plus `Entry/Exit` events.

**No** `GuestPool` aggregator — guests are real accounts, not shares of a float.

Per-park contracts (`Treasury`, `LendingPool`, `VenueRegistry`, `GuestRegistry`) deployed via CREATE2 keyed on park-save UUID, so reloading a save reattaches to the same on-chain state.

### 3.1 `VenueRegistry` — feed-friendly building catalog

Every paying location in the park (ride, shop, stall, facility, park entrance) is a **venue**. The registry mirrors that catalog on-chain so a feed dapp can resolve every spend event to a human-readable building name.

```solidity
enum VenueKind { ParkEntrance, Ride, Shop, Stall, Facility, ATM }

struct Venue {
    uint32  id;           // mirrors the game's stable internal ride/shop id
    VenueKind kind;
    string  name;         // e.g. "Wooden Roller Coaster 1", "Burger Bar"
    string  objectType;   // e.g. "rct2.ride.wmouse", "rct2.shop.burgb" — for icons/grouping
    address subAccount;   // CREATE2-derived sink address; receives this venue's spend
    uint64  registeredAtBlock;
    bool    active;
}

event VenueRegistered(uint32 indexed id, VenueKind indexed kind, string name, string objectType, address subAccount);
event VenueRenamed   (uint32 indexed id, string newName);
event VenueRetargeted(uint32 indexed id, address newSubAccount); // rare; supports relocation
event VenueRemoved   (uint32 indexed id);
```

- `subAccount` is a deterministic CREATE2 address derived from `(parkUuid, venueId)`. No contract is actually deployed there — it just acts as the on-chain "till" so per-venue revenue is queryable via `balanceOf(subAccount)` and incoming-transfer history.
- Park treasury can sweep from any sub-account in batched txs (fewer txs, same auditability).
- Game writes to this registry on placement / rename / demolish (low-volume admin txs, one per event — these are *not* on the hot path).

### 3.2 Spend events carry venue id

Both submission modes emit the same event shape from the same contract path:

```solidity
event GuestSpend(
    address indexed guest,
    uint32  indexed venueId,
    VenueKind indexed kind,
    uint8   category,    // ride-fare, shop-primary, shop-secondary, facility-use, entry, atm-fee
    uint256 amount,
    uint64  gameTick     // optional, lets feed correlate to in-game time
);
```

A feed dapp reads `GuestSpend` events, joins each `venueId` against `VenueRegistered`/`VenueRenamed` to render:

> Guest `0xabc…` spent **12 PARK** at **Wooden Roller Coaster 1** (Ride) at block 1,847,221

Indexers can be naive (subgraph-style) or just a thin Node script — all the data is on-chain, no off-chain DB required.

### 3.3 Why not per-venue contracts

A previous variant deployed a small contract per ride/shop. Rejected because:
- 50–200 venues per park × deploy cost = heavy CREATE storm at park init.
- All the "per-venue receives money" properties are achievable via deterministic CREATE2 addresses without ever deploying code there.
- A single registry is dramatically easier to index for the feed.

---

## 4. Sidecar — the throughput engine

The sidecar is the most engineering-dense piece. It collects guests' EIP-712 signatures and continuously feeds packed `SettlementBatcher.settle` calls to the chain.

### 4.0 Language: Node.js (TypeScript)

The sidecar is written in **TypeScript on Node.js** (Node 20+). Same language as the Envio handlers, easy to share types and ABI bindings across both.

Key dependencies:
- **`viem`** — ethers-style client; first-class EIP-712 signing, EIP-2612 `permit` helpers, HD wallet, type-safe contract bindings, and an HTTP transport that fans out over keep-alive connections. Modern, fast, well maintained.
- **`@noble/hashes` / `@scure/bip32` / `@scure/bip39`** — already pulled in transitively by viem; used for HD derivation off the master mnemonic.
- **`node:net`** — UDS / TCP for the JSON-RPC server. No framework needed; the protocol is line-delimited JSON.
- **`pino`** — structured logging.
- **No Go runtime, no compile step beyond `tsc`** — the binary is just `node dist/main.js`. CMake `agent_bundle` target invokes `npm ci && npm run build`.

Performance notes:
- Targets (5000+ auth/s submission) are I/O-bound; Node's event loop handles this comfortably with viem's connection pooling.
- EIP-712 signing on `secp256k1` via `@noble` is ~30k sigs/sec single-threaded — well above our targets. If signing ever becomes the bottleneck, fan it out to `worker_threads` with a small pool.
- Use `viem`'s `writeContract` with `nonce` overrides so we manage relayer-pool nonces explicitly.

### 4.1 Process structure
```
chain-sidecar/
├── package.json
├── tsconfig.json
├── src/
│   ├── outbox/      # drains game events
│   ├── derive/      # HD key derivation, address cache
│   ├── funder/      # Disperse-based PARK funding + permit collection
│   ├── venues/      # mirrors VenueRegistry; submits register/rename/remove txs
│   ├── batcher/     # signs guest spends, packs into SettlementBatcher.settle
│   ├── relayers/    # pool of treasury-funded EOAs that submit batch txs
│   ├── metrics/     # tx/s, auth/s submitted, queue depth, batch-fill, drop count
│   ├── ipc/         # JSON-RPC server (UDS or TCP) to game + rctctl
│   └── main.ts
```

### 4.2 Batcher (the hot path)

Targets: **sustain 5000+ auth/s submission**.

- For each `GUEST_SPEND`, derive the guest's key on demand, sign an EIP-712 `SpendAuth`, push into the active batch.
- **Flush conditions** (whichever fires first): `BATCH_MAX_SIZE` (default 256 auths) or `BATCH_MAX_AGE_MS` (default 200 ms). Tunable per-launch and at runtime via `chain.batch.config`.
- Hand the flushed batch to the relayer pool — the next free relayer signs and submits one tx.
- **Backpressure**: if the unflushed-auth queue grows beyond N (e.g. 50k), drop oldest auths and bump a `dropped_auths` counter. Game keeps running; demo shows backpressure honestly.

### 4.3 Relayer pool

- 8–16 treasury-funded EOAs, each with its own monotonic nonce sequence — round-robin assignment so we don't bottleneck on one EOA's nonce.
- Each relayer is a viem `walletClient` with its own keep-alive HTTP transport to the Monad RPC.
- **Submission via Monad's `eth_sendRawTransactionSync`** — one RPC call submits the tx *and* returns the receipt once it's included in a block. This gives us per-tx confirmation latency for free, with no separate receipt-polling pipeline. Each relayer can have one in-flight sync call at a time (its nonce sequence is gated by inclusion); pool-wide throughput scales linearly with relayer count.
- On `nonce too low` / `already known` / RPC error, refresh the relayer's nonce via `getTransactionCount(..., 'pending')` and retry; bump an `rpc_errors` counter.
- If all relayers are busy and a new batch is ready, queue it (small bounded queue). If queue exceeds threshold, grow batch size, relayer pool, or both — surfaced as metrics.
- **Crash safety**: outbox + pending-batch state is a disk WAL (`${USER_DATA}/chain-outbox.wal`). On sidecar restart, replay unfinished signatures into a fresh batch.

#### Throughput math
- 1s blocks × 1 sync-tx per relayer per block × N relayers × `BATCH_MAX_SIZE` auths per tx.
- Default: 16 relayers × 256 auths = **~4 000 auth/s sustained**, with linear scaling.
- For higher peaks during stress mode, we can bump `BATCH_MAX_SIZE` to 512+ (gas permitting) or grow the pool to 32 relayers.

### 4.4 Funder
- Coalesces guest entries into windows (e.g. every 200 ms): collects up to 200 new addresses, fires one `Disperse.disperseToken(PARK, …)` to mint each new guest a real ERC-20 PARK balance.
- Collects each new guest's EIP-2612 `permit` signature (off-chain only — granted at entry) so the batcher can later `transferFrom`.
- On exit, sweeps remaining PARK back to treasury via a single `transferFrom`.

### 4.5 Venue mirror
- Drains `VENUE_REGISTERED`/`VENUE_RENAMED`/`VENUE_REMOVED` events from the outbox.
- Submits one tx per admin event (low volume; rides aren't placed at high frequency).
- Caches venue table locally so the batcher can attach venueId to each spend without a chain read.

### 4.6 Metrics surface (over JSON-RPC)
Submission + confirmation, both available because `sendRawTransactionSync` returns the receipt:
- **`tx/s`** — raw transactions per second the park confirms.
- **`auth/s`** — effective signed guest authorizations per second confirmed.
- Submit→confirm latency p50 / p95 / p99 (from sync-call wall time).
- Average / max batch fill (auths per `settle` tx).
- Outbox depth, queued-batches depth, dropped auths.
- Per-relayer pending-nonce gauge and busy-state.
- RPC error counter.

These bubble up to `rctctl chain throughput` and the in-game **Treasury window**.

---

## 5. Game integration

### 5.1 Per-guest onchain fields
Add to `Guest`:
```cpp
uint32_t HdIndex;          // BIP-32 derivation index
EthAddress OnchainAddress; // 20-byte cached address
```

Generated when guest spawns. Address computed in sidecar, pushed back via `chain.guest.assigned`. No private key in game memory.

### 5.2 Hooks (minimal cost in tick)

**Guest lifecycle / spend** (high volume — feeds the batcher):
- `SpawnGuest` → `chain.outbox.push(GUEST_ENTRY, guestId, cashOnHand)`
- `Guest::SpendMoney(...)` → `chain.outbox.push(GUEST_SPEND, guestId, venueId, amount, category)`
- `Guest::LeavingPark` → `chain.outbox.push(GUEST_EXIT, guestId)`

**Venue lifecycle** (low volume — admin txs, one-shot per event):
- Ride placed (`RideCreateAction`) → `chain.outbox.push(VENUE_REGISTERED, rideId, kind=Ride, name, objectType)`
- Shop / stall / facility placed → same with appropriate `kind`
- Park entrance: registered once at park init with `venueId=0`
- Ride/shop renamed → `chain.outbox.push(VENUE_RENAMED, venueId, newName)`
- Ride/shop demolished → `chain.outbox.push(VENUE_REMOVED, venueId)`

**Park-side admin** (own batched cadence): loan, wages, marketing, construction.

### 5.3 What flows back into the game (aggregate-only)

The game shows on-chain UI but **does not display per-event confirmations**. Per-spend receipts are not pushed back; they live on chain and are surfaced by Envio (§8).

Sidecar pushes `chain.event.push` only for things the game actually needs:
- `GuestEntered { guestId, address }` — game stamps `OnchainAddress` on guest. (One per entry; no tx hash needed in-game.)
- `AggregateTick { tx_per_s, auth_per_s, p50_latency_ms, p95_latency_ms, batch_fill_avg, treasury_balance, queued_batches, dropped_auths }` — emitted ~2 Hz. Drives the Treasury window.
- `LoanChanged { principal, rate }` — pulled from Envio on a slow poll; loan-status mirror.
- `Bankruptcy { deficit }` — game-over trigger.

Anything beyond that (per-spend tx hashes, full event history, per-guest tx lists) is read on demand against Envio or the sidecar — never streamed into game state.

### 5.4 New JSON-RPC handlers
`src/openrct2/scripting/rpc/handlers/ChainHandlers.cpp`:

**Read:**
- `chain.status`
- `chain.throughput` — aggregate `tx/s`, `auth/s`, latency, batch-fill stats.
- `chain.guest.get`, `chain.guest.list` — includes `balanceOf` from chain.
- `chain.venue.get`, `chain.venue.list` — registry mirror.
- `chain.tx.list` — recent batch txs with auth counts.
- `chain.treasury` — balance + cumulative inflows.
- `chain.loan.status`

**Write (proxied to sidecar):**
- `chain.faucet.drip`
- `chain.send`
- `chain.loan.borrow|repay`
- `chain.batch.config` — adjust `BATCH_MAX_SIZE` / `BATCH_MAX_AGE_MS` at runtime.
- `chain.stress.start|stop`

---

## 6. `rctctl chain` commands

### Read
- `rctctl chain status` — sidecar + chain summary (mode, relayer pool, current block).
- `rctctl chain throughput` — **headline command**. Live `tx/s` and `auth/s`, p50/p95/p99 latency, outbox depth, batch-fill avg, drops. `--watch` for live refresh + ASCII sparkline.
- `rctctl chain guests [--limit N]` — guest wallets table: `id | address | balance | spends | last-spend-age`.
- `rctctl chain guest --id <gid>` — full per-guest record incl. last 10 spends and explorer URLs.
- `rctctl chain venues [--kind ride|shop|stall|facility]` — registry mirror with revenue per venue.
- `rctctl chain venue --id <vid>` — single venue: name, address, lifetime revenue, top spenders.
- `rctctl chain tx [--limit N]` — recent batch txs with auth counts and gas used.
- `rctctl chain treasury` — treasury balance + cumulative income.
- `rctctl chain loan status`
- `rctctl chain block` — current block, fullness, time since last.
- `rctctl chain feed [--watch] [--venue <vid>] [--guest <gid>]` — spawns / connects to the indexer (§8); shows the live spend feed in the agent terminal.

### Write
- `rctctl chain faucet drip`
- `rctctl chain send --to <addr> --amount <n>`
- `rctctl chain loan borrow|repay --amount <n>`
- `rctctl chain batch config [--max-size N] [--max-age-ms M]` — runtime tuning.
- `rctctl chain stress start [--guests N] [--multiplier X]`
- `rctctl chain stress stop`
- `rctctl chain reconcile`

### Output style
Same natural-language style as the rest of `rctctl`. Tx hashes printed with explorer URLs. `chain throughput --watch` prints an ASCII sparkline for last 60s.

### Follow-mode hints
- `chain throughput` → opens **Throughput HUD**.
- `chain guest` → camera pans to that guest in the park.
- `chain venue --id <vid>` → camera pans to that ride/shop.
- `chain treasury` → opens **Treasury** window.

---

## 7. In-game on-chain UI (aggregate-only)

The game shows on-chain status, **never** per-event confirmations. Fed by the ~2 Hz `AggregateTick` from the sidecar plus on-demand reads against Envio (§8). Existing in-game indicators (guest count, finances) already cover most of the player-facing information; the new UI is just a single window for the chain-specific bits.

### 7.1 Treasury window
Toolbar button → window with:
- Park treasury address (click to copy / open in explorer).
- PARK balance, last 24h income (queried from Envio).
- Loan principal + accrued interest.
- Aggregate metrics line: `auth/s · tx/s · p95 latency · batch-fill avg · queued · dropped` (from sidecar).
- Relayer pool health (count, MON balances).
- "Open Live Feed" button — launches the Envio feed terminal (§8).

No floating HUD overlay; everything sits in this one window.

### 7.2 Stress mode
`rctctl chain stress start --guests 5000 --multiplier 4`:
- Calls existing guest-generation cheat to spawn N additional guests fast.
- Bumps `gGameSpeed`.
- Optionally lowers ride/shop prices so spend rate goes up.
- Stop returns to normal.

Reproducible from the agent terminal: "Claude, please push the park to 5000 auth/s for 30 seconds and report the latency curve."

---

## 8. Indexing & feed — Envio

We use **[Envio](https://envio.dev/)** (HyperIndex) to index the chain — no custom indexer to build or run. Envio supports Monad; we just define a config + schema + handlers and get a hosted GraphQL API.

### 8.1 What we index

Lives in `OpenRCT2/indexer/` (an Envio HyperIndex project).

**Contracts watched**: `VenueRegistry`, `SettlementBatcher`, `LendingPool`, `GuestRegistry`.

**Events handled**:
- `VenueRegistered` / `VenueRenamed` / `VenueRemoved` → upsert `Venue` entity.
- `GuestSpend` → insert `Spend` entity (linked to `Guest` and `Venue`); update rolling aggregates on both.
- `Entry` / `Exit` → upsert `Guest` entity with entry/exit blocks.
- `LoanChanged` / `InterestAccrued` / `Bankruptcy` → update `LoanState` singleton.

### 8.2 Schema (`schema.graphql`)

```graphql
type Guest {
  id: ID!                # address
  guestId: BigInt!       # game-side id
  entryBlock: BigInt!
  exitBlock: BigInt
  totalSpent: BigInt!
  spendCount: Int!
  spends: [Spend!]! @derivedFrom(field: "guest")
}

type Venue {
  id: ID!                # venueId as string
  kind: String!
  name: String!
  objectType: String!
  subAccount: Bytes!
  totalRevenue: BigInt!
  spendCount: Int!
  active: Boolean!
  spends: [Spend!]! @derivedFrom(field: "venue")
}

type Spend {
  id: ID!                # txHash-logIndex
  guest: Guest!
  venue: Venue!
  category: Int!
  amount: BigInt!
  block: BigInt!
  txHash: Bytes!
  gameTick: BigInt!
}

type LoanState { id: ID!  principal: BigInt!  rate: Int!  bankrupt: Boolean! }
```

### 8.3 Output

Envio gives us a hosted GraphQL endpoint. From there:
- **Live feed query** with subscriptions: `subscription { spends(orderBy: block, orderDirection: desc, first: 50) { ... } }`.
- **Per-venue revenue**: `venues(orderBy: totalRevenue, ...)`.
- **Per-guest spend history**: `guest(id: "0x…") { spends { … } }`.
- **Aggregates**: handled via Envio's roll-up patterns or computed in-query.

### 8.4 Terminal feed for the agent

Instead of building a custom binary, `rctctl chain feed` is a thin GraphQL subscription client (~150 lines, any language; Go or Node both fine) that:
- Reads the Envio endpoint from `${USER_DATA}/chain/deployments.json`.
- Subscribes to `spends` ordered by block desc.
- Joins to `venue.name` (already a field on the `Spend` entity via Envio's relations).
- Prints lines like:

```
#1,847,221  0x4f…ac  →  Wooden Roller Coaster 1 (Ride)        12 PARK   tx 0x9a…
```

Filters: `--venue <vid>`, `--guest <gid>`, `--kind ride|shop`, `--json`. All trivially pushed down to the GraphQL query.

### 8.5 Why Envio

- No custom indexer code or hosting to maintain.
- GraphQL is what the in-game Treasury window queries for aggregate displays — same data source as the feed.
- Backfill, reorg handling, and multi-chain support come for free.
- Self-hostable later if we want to drop the dependency.

### 8.6 Bootstrapping

- `OpenRCT2/indexer/config.yaml` checked in to repo with placeholders for Monad-testnet contract addresses.
- After contract deploy (M1), addresses and start-block injected into config; deploy to Envio cloud via their CLI.
- Game / `rctctl` / sidecar all read the Envio endpoint URL from the same `deployments.json`.

---

## 9. Loans

Park-level loan stays the same — `LendingPool` contract, treasury borrows/repays, interest accrues per block.

### Optional: guest micro-loans (more demo fuel)
- Guest who runs out of cash but is still happy can "tap an ATM" → emits a `GUEST_BORROW` event the batcher packs alongside `SpendAuth`s.
- Repaid automatically next time the guest spends (or written off when they leave).
- Each ATM tap = one more authorization in the batch → more `auth/s`; makes "ATM" facilities meaningful for the first time.
- Flag-gated.

---

## 10. Anti-bloat / safety

- Game tick: only a ring-buffer push per event. **No syscalls in tick.**
- Outbox capped (e.g. 200k entries — wider than minimal because we *expect* high volume); on overflow, drop oldest with a counter.
- Sidecar runs as separate process; OOM/crash is contained.
- Game keeps **no per-spend chain history** in memory. Aggregate metrics only; everything else is queried on demand from Envio or the sidecar.
- WAL rotated; capped at e.g. 500 MB.
- Hard cap on per-guest spend rate (e.g. 10 auth/sec/guest) to prevent runaways; configurable.

---

## 11. Tasks & subtasks

### M0 — Foundations (1–2 days)
- [x] **0.1** Build flag `OPENRCT2_CHAIN`; runtime `--chain/--no-chain` flag.
- [x] **0.2** Stub `ChainHandlers.cpp`; `chain.status` returns `{enabled:false}` when disabled.
- [x] **0.3** Stub `rctctl chain status` end-to-end.
- [x] **0.4** Add `CHAIN.md` describing the throughput demo intent.

### M1 — Contracts (3–4 days)
- [x] **1.1** Foundry project under `contracts/`.
- [x] **1.2** Implement `ParkToken` (with EIP-2612 `permit`), `Faucet`, `Disperse`, `ParkTreasury`, `LendingPool`, `GuestRegistry`.
- [x] **1.3** Implement `VenueRegistry` (register/rename/remove + CREATE2 sub-account derivation).
- [x] **1.4** Implement `SettlementBatcher` (EIP-712 `SpendAuth` verify + `transferFrom` per item + `GuestSpend` events). Per-guest sig-nonce mapping.
- [x] **1.5** Deploy script + `deployments/monad-testnet.json` (deployed at block 29174215, all 8 contracts verified on Monadscan).
- [x] **1.6** Gas-cost benchmark for `settle(N)` for N ∈ {64, 128, 256, 512}; sizes default `BATCH_MAX_SIZE`. See `contracts/test/SettlementBatcherGas.t.sol` — per-auth gas is flat at ~42.7–43.2k across all N (no quadratic creep), calldata is ~385 B/auth. N=256 settles in ~10.9 M gas; N=512 in ~22.1 M. Default `BATCH_MAX_SIZE = 256` keeps a single batch tx at ~10–15% of a typical 100 M-gas block, leaving headroom for the 8–16-relayer pool to submit in parallel; bump to 512 for stress mode if the block budget allows.

### M2 — Sidecar core (3–4 days)
- [ ] **2.1** Node 20 + TypeScript skeleton; viem dep; UDS JSON-RPC server; integrated into `agent_bundle` build (`npm ci && tsc`).
- [ ] **2.2** Keystore: generate/encrypt master mnemonic for the park; relayer pool keys derived from it.
- [ ] **2.3** HD derivation cache (address-only; key derived on demand inside batcher).
- [ ] **2.4** Outbox poller + WAL.
- [ ] **2.5** Treasury + relayer-pool setup: `chain.faucet.drip`, MON top-up logic, balance reads (viem `publicClient`).
- [ ] **2.6** `deployments.json` writer (consumed by game, rctctl, indexer).

### M3 — Batcher, funder, relayer pool (high-throughput core, 4–5 days)
- [ ] **3.1** EIP-712 typed-data signer for `SpendAuth` (viem `signTypedData`).
- [ ] **3.2** Batcher: collect auths, flush on `BATCH_MAX_SIZE` or `BATCH_MAX_AGE_MS`.
- [ ] **3.3** Relayer pool: 8–16 EOAs, per-EOA nonce manager with refresh-on-error, round-robin batch assignment.
- [ ] **3.4** Submission via `eth_sendRawTransactionSync` (viem custom RPC method); per-tx wall-time captured as latency.
- [ ] **3.5** Funder: windowed `Disperse.disperseToken(PARK, …)` mints for entering guests.
- [ ] **3.6** Permit-collection at entry (each guest signs `permit(batcher, ∞)` off-chain at spawn).
- [ ] **3.7** Sweeper: `transferFrom` exit balance back to treasury on guest exit.
- [ ] **3.8** Venue mirror: register/rename/remove txs from `VENUE_*` outbox events.
- [ ] **3.9** Metrics: `tx/s`, `auth/s`, p50/p95/p99 latency, batch-fill, queue depth, drops, RPC errors.
- [ ] **3.10** Hard rate-limits, overflow handling, WAL replay on restart.
- [ ] **3.11** Stress run against Monad testnet; tune relayer pool size and batch parameters.

### M4 — Game hooks (3 days)
- [ ] **4.1** `chain/Outbox.{h,cpp}` lock-free ring buffer + WAL writer.
- [ ] **4.2** `Guest` struct: add `HdIndex` + `OnchainAddress`.
- [ ] **4.3** Hook `SpawnGuest` → `GUEST_ENTRY`; receive `GuestEntered` assignment back.
- [ ] **4.4** Hook `Guest::SpendMoney` → `GUEST_SPEND` with `venueId`.
- [ ] **4.5** Hook `LeavingPark` → `GUEST_EXIT`.
- [ ] **4.6** Hook ride/shop/facility placement → `VENUE_REGISTERED`.
- [ ] **4.7** Hook ride/shop rename → `VENUE_RENAMED`.
- [ ] **4.8** Hook ride/shop demolish → `VENUE_REMOVED`.
- [ ] **4.9** Park-side hooks for wages/marketing/construction → batched park flow.
- [ ] **4.10** Auto-spawn sidecar from `AIAgentLaunch.cpp`.

### M5 — `rctctl chain` (2 days)
- [ ] **5.1** Register `chain` resource in registry.
- [ ] **5.2** Read commands: `status`, `throughput`, `guests`, `guest`, `venues`, `venue`, `tx`, `treasury`, `loan status`, `block`, `feed`.
- [ ] **5.3** Write commands: `faucet drip`, `send`, `loan borrow|repay`, `batch config`, `reconcile`.
- [ ] **5.4** Stress: `stress start|stop`.
- [ ] **5.5** Renderers: tx-hash + explorer URL, ASCII sparkline for `throughput --watch`.
- [ ] **5.6** Follow-mode hints (treasury window, guest pan, venue pan).
- [ ] **5.7** Guided errors (sidecar down, relayer MON low, MON faucet link, etc.).

### M6 — In-game UI (1 day)
- [ ] **6.1** Treasury window (address, balance, aggregate metrics, loan, relayer health, "Open Live Feed" button).
- [ ] **6.2** `WindowClass::treasury` enum entry + toolbar button.

### M7 — Indexer (Envio) (2 days)
- [ ] **7.1** Bootstrap `OpenRCT2/indexer/` HyperIndex project (`config.yaml`, `schema.graphql`, handlers in TS).
- [ ] **7.2** Handlers for `VenueRegistered`/`Renamed`/`Removed`, `GuestSpend`, `Entry`/`Exit`, `LoanChanged`/`Bankruptcy`.
- [ ] **7.3** Envio cloud deploy script.
- [ ] **7.4** `rctctl chain feed` GraphQL subscription client (~150 LoC) — joins `Spend` → `Venue.name`.
- [ ] **7.5** `--venue`, `--guest`, `--kind`, `--json` filters via GraphQL where-clauses.

### M8 — Loans + ATM micro-loans (2 days)
- [ ] **8.1** Wrap `ParkSetLoanAction` so chain `LendingPool` is authoritative when chain mode is on.
- [ ] **8.2** `Bankruptcy` event handler → news item + scenario soft-fail.
- [ ] **8.3** ATM facility hook: `GuestUsesATM` → `GUEST_BORROW` event packed by batcher.
- [ ] **8.4** Auto-repay on next guest spend.

### M9 — Docs (0.5 day)
- [ ] **9.1** Update `CLAUDE.md`, `RCTCTL.md`, `CODING_AGENT.md`.
- [ ] **9.2** Update `ai-agent-workspace/IN_GAME_AGENT.md` so Claude knows the new `chain` verbs and the throughput-demo intent.

---

## 12. Open questions

1. **MON budget for the relayer pool** — at peak `auth/s`, how much MON do batch txs burn per minute? Pre-flight measurement before live demo. Built into **M1.6**.
2. **Throughput target** — sustain 1000+ `auth/s` for a minute, or spike to 5000+ `auth/s` in a 10s burst? Drives `BATCH_MAX_SIZE`, relayer-pool size, and stress-mode defaults.
3. **Master mnemonic exportability** — useful so a human can verify "this guest is a real wallet" by importing into MetaMask. Footgun even on testnet, but a strong demo prop.
4. **Envio cloud vs self-host** — cloud is fastest to ship; self-host is a fallback. Start cloud, document the self-host path.

---

## 13. Suggested order

Land **M0 + M1** first (scaffolding + contracts on testnet) so we have real addresses to point at. Then **M3** (batcher + relayers) since that's the load-bearing piece — everything else hangs off it. **M7** (Envio) can run in parallel with M3 once contracts are deployed.
