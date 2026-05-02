# chain-sidecar

Node.js sidecar for the RCT2 × Monad throughput demo. See
`OpenRCT2/ONCHAIN_PLAN.md` (especially §4) for the design.

This module is the engineering-dense piece: it drains the game's outbox of
spend events, signs each as an EIP-712 `SpendAuth` from a per-guest HD-derived
key, packs N of them into `SettlementBatcher.settle(...)`, and feeds the
result to a small relayer pool that submits via Monad's
`eth_sendRawTransactionSync`.

M2.1 lands the skeleton: TypeScript project, viem dep, line-delimited JSON-RPC
over a Unix domain socket, and CMake integration with the `agent_bundle`
target. Subsequent milestones fill in the subsystems under `src/`.

## Layout

```
chain-sidecar/
├── package.json / tsconfig.json / package-lock.json
├── CMakeLists.txt          # hooked into the parent agent_bundle target
├── src/
│   ├── main.ts             # entrypoint
│   ├── config.ts           # CLI args + deployments.json loader
│   ├── log.ts              # pino logger
│   ├── ipc/                # UDS JSON-RPC server + handlers
│   ├── outbox/             # M2.4 — drains game events
│   ├── derive/             # M2.2/2.3 — HD derivation + address cache
│   ├── funder/             # M3.5/3.6 — Disperse funding + permit collection
│   ├── venues/             # M3.8 — VenueRegistry mirror
│   ├── batcher/            # M3.1/3.2 — EIP-712 signing + flush conditions
│   ├── relayers/           # M3.3/3.4 — relayer pool + sendRawTransactionSync
│   └── metrics/            # M3.9 — tx/s, auth/s, latency, queue depth
└── test/                   # node:test smoke tests
```

## Build / run

Requires Node 20+ and npm. (Currently builds on Node 18 with an
`EBADENGINE` warning; viem 2.x and pino 9.x both work, but stick with 20+
for production.)

```bash
cd OpenRCT2/chain-sidecar
npm ci
npm run build              # emits dist/main.js
npm test                   # smoke tests over a temp UDS

# Run against the deployed demo park:
node dist/main.js \
    --socket /tmp/rct2-sidecar.sock \
    --deployments ../contracts/deployments/monad-testnet.json
```

`cmake --build build --target agent_bundle` automatically runs `npm ci &&
npm run build` for this project — see `chain-sidecar/CMakeLists.txt`. If
`node`/`npm` are not on `PATH`, CMake skips the sidecar with a notice and the
rest of the agent bundle still builds.

## JSON-RPC over UDS

The sidecar speaks line-delimited JSON-RPC 2.0. One request per line, one
response per line. Used by `rctctl chain` and by the in-game terminal
(proxied via the game's existing `ChainHandlers`).

Methods registered by M2.1:

| Method            | Purpose                                                |
| ----------------- | ------------------------------------------------------ |
| `sidecar.ping`    | Heartbeat. Returns `"pong"`.                           |
| `sidecar.status`  | Sidecar version, uptime, deployments, registered methods. |
| `sidecar.shutdown`| Graceful stop. Used by tests / agent_bundle teardown.  |

Quick check:

```bash
nc -U /tmp/rct2-sidecar.sock <<< '{"jsonrpc":"2.0","id":1,"method":"sidecar.status"}'
```

## Why Node + TypeScript

Per `ONCHAIN_PLAN.md` §4.0: viem gives first-class EIP-712 + EIP-2612 +
HD-wallet support; `@scure/bip32` & `@scure/bip39` arrive transitively;
Node's event loop comfortably handles the I/O-bound 5000+ auth/sec target
without a worker pool. Same language as the Envio handlers (M7) so types and
ABI bindings can be shared.
