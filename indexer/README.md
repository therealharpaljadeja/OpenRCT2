# OpenRCT2 Park Indexer (Envio HyperIndex)

Indexes the four park contracts on Monad testnet and serves a GraphQL API the in-game agent
queries via `rctctl chain feed`.

## What it indexes

| Contract | Address | Events |
|---|---|---|
| `VenueRegistry` | `0x6384430d201E8fF6bF6bee8Acb99882b0A119270` | `VenueRegistered`, `VenueRenamed`, `VenueRetargeted`, `VenueRemoved` |
| `SettlementBatcher` | `0x67d35905B93d4F4a82a5CDcca8c0400198F57B52` | `GuestSpend`, `BatchSettled` |
| `GuestRegistry` | `0xa2dd713F0dC6138640c7Fb8fac660812787a9902` | `Entry`, `Exit` |
| `LendingPool` | `0x8A06cEc79E7C6BfB399Be57c9e653A35f56fF4E9` | `LoanChanged`, `InterestAccrued`, `Bankruptcy` |

Schema in `schema.graphql`; one entity per real-world thing (`Guest`, `Venue`, `Spend`,
`LoanState`, `Batch`). Aggregates (`Venue.totalRevenue`, `Guest.totalSpent`) are maintained
in-handler so live-feed queries stay cheap.

## Running locally

The recommended path is via the wrapper that aligns the indexer's `start_block` to the
running sidecar's session boundary:

```bash
npm install                        # one-time (in indexer/)
../scripts/start-indexer.sh        # auto-discovers chain workspace + launches envio dev
```

The wrapper reads `<chainDir>/indexer-start-block` (written by the sidecar at boot) and
generates `config.runtime.yaml` with `start_block` patched to that value. Each sidecar
restart re-emits a fresh start block, so re-running the script lines the index up with
exactly this session's events. Anything from previous epochs (different namespaces of
venueIds) is skipped — keeps the index focused on what's live.

Other modes:

```bash
../scripts/start-indexer.sh --baseline       # use config.yaml's deploy block (full history)
../scripts/start-indexer.sh /path/to/chain   # explicit chain dir
../scripts/start-indexer.sh --rpc <url>      # fall back to chain head if no sidecar found
```

Direct (no wrapper) — full history from contract deploy:

```bash
npm run codegen                    # regenerate generated/ from config.yaml + schema.graphql
npm run dev                        # GraphQL on http://localhost:8080/v1/graphql
```

The GraphQL endpoint is at `http://localhost:8080/v1/graphql`. The Envio dashboard is on
port 8081 — drop into it to see indexing progress, error counts, etc.

## How it discovers venues and guests

You don't need Envio's dynamic-contracts (factory) feature here. Venue sub-accounts and
guest wallets aren't separate contracts — they're CREATE2 receiver addresses (no code) and
EOAs (no code), respectively. Everything we need rides inside events from the four fixed
contracts:

| New entity | Discovered via | Stored in |
|---|---|---|
| `Venue` | `VenueRegistry.VenueRegistered(id, kind, name, ...)` | `Venue` entity, keyed by chain venueId |
| `Guest` | `GuestRegistry.Entry(guestId, addr, ...)` | `Guest` entity, keyed by lowercased address |
| `Spend` | `SettlementBatcher.GuestSpend(guest, venueId, ...)` | `Spend` entity + aggregate updates on Guest/Venue |

The handlers do first-touch upserts on `Guest` and `Venue` whenever a `Spend` references
one we haven't seen yet — so out-of-order delivery (rare on HyperSync, but possible across
reorgs) doesn't drop rows.

## Deploying to Envio cloud

```bash
../scripts/deploy-indexer.sh
```

Requires an Envio account + `ENVIO_API_TOKEN` in env. The script wraps `envio cloud
deploy` so re-runs are idempotent.

## Sample queries

Latest 50 spends with venue + guest joins (this is what `rctctl chain feed` subscribes to):

```graphql
subscription LiveFeed {
  Spend(order_by: {block: desc}, limit: 50) {
    id
    amount
    category
    block
    txHash
    gameTick
    venue { id name kindLabel }
    guest { id guestId }
  }
}
```

Top 10 venues by revenue:

```graphql
{
  Venue(order_by: {totalRevenue: desc}, limit: 10, where: {active: {_eq: true}}) {
    id name kindLabel totalRevenue spendCount
  }
}
```

Per-guest spend history:

```graphql
{
  Guest_by_pk(id: "0x…") {
    guestId entryBlock exitBlock totalSpent spendCount
    spends(order_by: {block: desc}) { amount venue { name } block }
  }
}
```

## Re-deploy notes

If the contracts redeploy with a new address set, update `config.yaml` (`networks[].contracts[].address`)
and `start_block` to the new deploy height, then re-run `npm run codegen` and re-deploy. Envio
keys entities by ID — anything in the old indexer that survives the address change won't auto-merge,
so plan for a fresh database on contract redeploys.
