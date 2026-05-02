# OpenRCT2 × Monad — On-chain contracts

Foundry project for the per-guest onchain wallets demo. See `OpenRCT2/ONCHAIN_PLAN.md` for the design.

Contracts in `src/`: `ParkToken`, `Faucet`, `Disperse`, `ParkTreasury`, `LendingPool`, `GuestRegistry`, `VenueRegistry`, `SettlementBatcher`. Deploy script in `script/Deploy.s.sol`; the canonical artifact (consumed by sidecar / `rctctl` / indexer) is `deployments/monad-testnet.json`.

## Setup

```bash
# One-time: install Foundry
curl -L https://foundry.paradigm.xyz | bash
foundryup

# Project deps (forge-std + OpenZeppelin v5.1) live in lib/, already vendored.
# If you ever need to refresh:
#   forge install OpenZeppelin/openzeppelin-contracts@v5.1.0 --no-git

cp .env.example .env   # then fill in DEPLOYER_PRIVATE_KEY
```

## Build / test

```bash
forge build
forge test
forge fmt
```

### Gas benchmark

`test/SettlementBatcherGas.t.sol` measures `SettlementBatcher.settle(N)` at
N ∈ {64, 128, 256, 512} so the sidecar can pick a `BATCH_MAX_SIZE` that fits
under the Monad block gas budget. Run with `-vvv` to surface the logged numbers:

```bash
forge test --match-contract SettlementBatcherGas -vvv
```

Reference numbers (solc 0.8.26, optimizer on, 200 runs):

| N   | total gas  | gas/auth | calldata bytes |
| --- | ---------- | -------- | -------------- |
| 64  |  2,732,894 | ~42,701  |  24,708        |
| 128 |  5,449,102 | ~42,571  |  49,284        |
| 256 | 10,934,187 | ~42,712  |  98,436        |
| 512 | 22,115,033 | ~43,193  | 196,740        |

Per-auth cost is essentially flat (~43k gas, ~385 calldata bytes) — confirms
linear scaling with no quadratic creep. The benchmark also asserts a 64k
gas/auth ceiling as a regression guard.

## Deploy

`script/Deploy.s.sol` deploys the singleton globals (`ParkToken`, `Faucet`, `Disperse`)
and a default per-park stack (`ParkTreasury`, `LendingPool`, `GuestRegistry`,
`VenueRegistry`, `SettlementBatcher`) with the wiring from `ONCHAIN_PLAN.md`: `Faucet`
and `LendingPool` hold the PARK minter role; `LendingPool`'s borrower is the demo
treasury. It writes all addresses to `deployments/monad-testnet.json`.

```bash
# Required: DEPLOYER_PRIVATE_KEY in .env, funded with MON.
# Optional: LOAN_MAX_BORROW, LOAN_RATE_PER_BLOCK override the demo loan params.
forge script script/Deploy.s.sol:Deploy --rpc-url monad_testnet --broadcast -vvvv

# To verify on Monadscan (Etherscan v2 multichain), set MONAD_EXPLORER_API_KEY in .env
# and add `--verify`.
```

The committed `deployments/monad-testnet.json` is the pointer all consumers (sidecar,
`rctctl`, indexer) read at startup: `{ chainId, deployer, startBlock, globals{},
demoPark{}, loan{} }`. Re-running the deploy overwrites it — coordinate before
re-deploying.

## Network

- Monad testnet RPC: `https://testnet-rpc.monad.xyz`
- Chain id: `10143`
- Block explorer: `https://testnet.monadscan.com/`
- Verification API (Etherscan v2 multichain): `https://api.etherscan.io/v2/api?chainid=10143`
- Configured via `[rpc_endpoints]` / `[etherscan]` in `foundry.toml` — `forge script ... --rpc-url monad_testnet --verify`.

## Layout

```
contracts/
├── foundry.toml         # solc 0.8.26, optimizer on, OZ remappings
├── remappings.txt       # mirror of foundry.toml remappings (for IDE/LSP)
├── .env / .env.example  # deployer key + RPC config (.env gitignored)
├── src/                 # contracts land here in M1.2+
├── test/                # forge tests
├── script/              # forge deploy scripts
├── deployments/         # checked-in JSON artifacts: deployments/<network>.json
└── lib/
    ├── forge-std/
    └── openzeppelin-contracts/  # v5.1.0
```
