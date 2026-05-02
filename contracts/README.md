# OpenRCT2 × Monad — On-chain contracts

Foundry project for the per-guest onchain wallets demo. See `OpenRCT2/ONCHAIN_PLAN.md` for the design.

This milestone (M1.1) is the bare scaffold only. Contracts (`ParkToken`, `Faucet`, `Disperse`, `ParkTreasury`, `LendingPool`, `GuestRegistry`, `VenueRegistry`, `SettlementBatcher`) land in M1.2–M1.4.

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
