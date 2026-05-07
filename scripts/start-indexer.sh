#!/usr/bin/env bash
# Launch the OpenRCT2 park indexer with start_block aligned to the running sidecar.
#
# Behavior:
#   1. Auto-discovers the sidecar's chain workspace (looks for `indexer-start-block`
#      written by main.ts at boot, recently modified).
#   2. Reads the start block from <chainDir>/indexer-start-block.
#   3. Generates `indexer/config.runtime.yaml` from `indexer/config.yaml` with the
#      start_block patched to that value (gitignored).
#   4. Runs `envio dev --config config.runtime.yaml`.
#
# Each sidecar boot writes a fresh start block, so re-running this script picks up the
# new session boundary cleanly. Anything before that block (other epochs, prior runs,
# the contract deploy block) is skipped — keeps the index focused on this run.
#
# Usage:
#   scripts/start-indexer.sh                      # auto-discover + dev mode
#   scripts/start-indexer.sh /path/to/chain       # explicit chain dir
#   scripts/start-indexer.sh --baseline           # use config.yaml's deploy block (full history)
#   scripts/start-indexer.sh --rpc <url>          # fall back to chain head if no sidecar found
#
# Requires: node, npx envio (auto-installed via npm install in indexer/).

set -euo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
indexer_dir="$(cd "$here/.." && pwd)/indexer"

CHAIN_DIR=""
BASELINE=0
RPC="${MONAD_RPC_URL:-https://testnet-rpc.monad.xyz}"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --baseline) BASELINE=1; shift ;;
    --rpc) RPC="$2"; shift 2 ;;
    -h|--help) sed -n '2,22p' "$0"; exit 0 ;;
    --*) echo "error: unknown flag $1" >&2; exit 2 ;;
    *)
      [[ -z "$CHAIN_DIR" ]] && CHAIN_DIR="$1" && shift || { echo "error: too many args"; exit 2; }
      ;;
  esac
done

if [[ ! -d "$indexer_dir" ]]; then
  echo "error: $indexer_dir not found" >&2
  exit 2
fi

if (( BASELINE )); then
  echo "info: --baseline: using indexer/config.yaml's deploy-block start"
  cd "$indexer_dir"
  exec npx envio dev
fi

# ---- resolve start_block --------------------------------------------------
START_BLOCK=""

if [[ -z "$CHAIN_DIR" ]]; then
  # Look for a freshly-written indexer-start-block under the user's home or /tmp.
  # `xargs -r` is GNU-only and silently aborts on macOS BSD xargs, so do the dirname
  # explicitly with a guard.
  hit=$(find "$HOME" /tmp -maxdepth 6 -name indexer-start-block -mmin -1440 2>/dev/null | head -n1 || true)
  if [[ -n "$hit" ]]; then
    CHAIN_DIR=$(dirname "$hit")
  fi
fi

if [[ -n "$CHAIN_DIR" && -f "$CHAIN_DIR/indexer-start-block" ]]; then
  START_BLOCK=$(cat "$CHAIN_DIR/indexer-start-block")
  echo "info: start block from sidecar workspace ($CHAIN_DIR): $START_BLOCK"
fi

if [[ -z "$START_BLOCK" ]]; then
  if ! command -v cast >/dev/null; then
    echo "error: no sidecar workspace found and 'cast' (foundry) not in PATH." >&2
    echo "       Either start the sidecar first (it writes <chainDir>/indexer-start-block)" >&2
    echo "       or pass the chain dir explicitly:  $0 /path/to/chain" >&2
    exit 2
  fi
  START_BLOCK=$(cast block-number --rpc-url "$RPC")
  echo "info: no sidecar workspace found; using current chain head from $RPC: $START_BLOCK"
fi

# ---- generate runtime config ---------------------------------------------
RUNTIME_CONFIG="$indexer_dir/config.runtime.yaml"

# sed pattern is anchored to the YAML key so it never replaces inline references in
# comments or descriptions. Envio's start_block sits at the network level, so there
# should be exactly one such line.
if ! grep -q '^[[:space:]]*start_block:' "$indexer_dir/config.yaml"; then
  echo "error: indexer/config.yaml has no 'start_block:' line to patch" >&2
  exit 2
fi
sed "s|^\([[:space:]]*\)start_block:.*|\1start_block: $START_BLOCK|" \
  "$indexer_dir/config.yaml" > "$RUNTIME_CONFIG"

echo "info: launching envio dev with start_block=$START_BLOCK ($RUNTIME_CONFIG)"
cd "$indexer_dir"
exec npx envio dev --config config.runtime.yaml
