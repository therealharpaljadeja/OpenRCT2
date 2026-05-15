# Quickstart

End-to-end checklist to get a chain-mode park running. Four moving parts:
**contracts** (one-time), **game** (auto-spawns the sidecar), **indexer**,
and **chain feed**.

## 0. Prerequisites

- macOS (Sonoma+) or Linux. Windows isn't supported.
- CMake 3.24+, Ninja, Xcode CLT (mac) or build-essentials (Linux).
- `libvterm` + `pkg-config` — `brew install libvterm pkg-config`.
- Node 20+ and npm.
- [Foundry](https://book.getfoundry.sh/getting-started/installation) — only
  needed if you re-deploy contracts.
- RollerCoaster Tycoon 2 assets ([Steam](https://store.steampowered.com/app/285330/) or [GOG](https://www.gog.com/game/rollercoaster_tycoon_2)) installed to `~/Library/Application Support/OpenRCT2/` on macOS.
- Optional: [Claude Code CLI](https://docs.anthropic.com/en/docs/claude-code)
  for the full agent experience (a bootstrap REPL is used otherwise).

## 1. Deploy contracts (skip if reusing the committed deployment)

`contracts/deployments/monad-testnet.json` is checked in and points at a live
demo park. Skip this step unless you need a fresh stack.

```bash
cd contracts
cp .env.example .env          # fill in DEPLOYER_PRIVATE_KEY (funded with MON)
forge script script/Deploy.s.sol:Deploy --rpc-url monad_testnet --broadcast -vvvv
```

The script writes addresses back to `deployments/monad-testnet.json`. Details
and verification flags: [`contracts/README.md`](contracts/README.md).

## 2. Build the game + sidecar + CLI

From the repo root:

```bash
cmake -S . -B build -G Ninja
cmake --build build --target agent_bundle -j8
```

`agent_bundle` compiles the game, terminal UI, `rctctl`, sprite assets, and
runs `npm ci && npm run build` inside `chain-sidecar/`. Build details and
fallback flags: [`SETUP.md`](SETUP.md).

## 3. Launch the game (auto-spawns the sidecar)

```bash
export KEYSTORE_PASSPHRASE='your-passphrase'   # required — first run creates the keystore
scripts/launch-game.sh                          # or: scripts/launch-game.sh /path/to/park.park
```

The launcher sets `MONAD_DEPLOYMENTS` to the committed JSON, passes `--chain`,
and the game spawns `chain-sidecar/dist/main.js` against a UDS at
`<chainDir>/sidecar.sock`. The sidecar writes `indexer-start-block` to its
workspace at boot — the indexer reads it next.

Optional env: `MONAD_RPC_URL`, `FAUCET_OWNER_KEYFILE`, `STREAM=1` for Twitch
streaming. Full launcher reference: [`scripts/launch-game.sh`](scripts/launch-game.sh)
and chain-mode overview in [`CHAIN.md`](CHAIN.md).

## 4. Start the indexer (separate terminal)

```bash
cd indexer && npm install                # one-time
scripts/start-indexer.sh                 # auto-discovers the sidecar's start block
```

GraphQL lands on `http://localhost:8080/v1/graphql`, dashboard on `:8081`.
Other modes (`--baseline`, explicit chain dir, custom RPC): [`indexer/README.md`](indexer/README.md).

## 5. Run the chain feed (separate terminal)

```bash
scripts/chain-feed.sh                    # pure bash, curl + jq, 1s polling
# or, push-based via Hasura subscriptions (Node 22.4+):
scripts/chain-feed.mjs
```

Filter examples: `--kind ride`, `--venue <id>`, `--since <block>`. The feed is
read-only against the indexer's GraphQL endpoint.

## Verifying the pipeline

```bash
rctctl chain status              # sidecar + relayer pool + block height
scripts/check-sidecar.sh         # health check on the sidecar workspace
```

If `chain status` reports `enabled: false`, the build is missing
`-DOPENRCT2_CHAIN=ON` or the game was launched without `--chain`.
