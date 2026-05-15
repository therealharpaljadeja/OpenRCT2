#!/usr/bin/env bash
# Inspect the chain spend pipeline end-to-end so you can tell at a glance
# whether a missing on-chain GuestSpend is a dispatcher drop, a permit gap, a
# revert, or just an empty queue.
#
# Usage:
#   ./chain-spend-debug.sh                       # auto-discover workspace
#   ./chain-spend-debug.sh /path/to/chain        # explicit chain dir
#   ./chain-spend-debug.sh --venue 1373437961    # also query on-chain balance + recent logs
#
# Deps: nc OR socat for the unix socket; jq for pretty output (optional);
#       cast for on-chain queries (only used with --venue).

set -uo pipefail

CHAIN_DIR=""
VENUE_ID=""
LOG_TAIL="${LOG_TAIL:-50}"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --venue) VENUE_ID="$2"; shift 2 ;;
    --tail)  LOG_TAIL="$2"; shift 2 ;;
    -h|--help)
      sed -n '2,12p' "$0"; exit 0 ;;
    *)
      [[ -z "$CHAIN_DIR" ]] && CHAIN_DIR="$1" && shift || { echo "Unknown arg: $1"; exit 2; } ;;
  esac
done

# ---- locate the chain workspace -------------------------------------------
if [[ -z "$CHAIN_DIR" ]]; then
  CHAIN_DIR=$(find "$HOME" /tmp -maxdepth 6 -name sidecar.sock -mmin -1440 2>/dev/null | head -n1 | xargs -r dirname)
fi
if [[ -z "$CHAIN_DIR" || ! -d "$CHAIN_DIR" ]]; then
  echo "error: no chain workspace found. Pass it explicitly: $0 /path/to/chain" >&2
  exit 2
fi
SOCK="$CHAIN_DIR/sidecar.sock"
LOG="$CHAIN_DIR/sidecar.log"
echo "workspace: $CHAIN_DIR"
[[ -S "$SOCK" ]] || { echo "error: $SOCK missing — sidecar not running?" >&2; exit 2; }

# ---- socket transport ------------------------------------------------------
if command -v socat >/dev/null; then
  call() { echo "$1" | socat -t 2 - UNIX-CONNECT:"$SOCK"; }
elif command -v nc >/dev/null; then
  call() { echo "$1" | nc -U -w 2 "$SOCK"; }
else
  echo "error: need either socat or nc to talk to the unix socket" >&2; exit 2
fi
PRETTY="cat"; command -v jq >/dev/null && PRETTY="jq ."

ipc() {
  local method="$1"
  local body="{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"$method\"}"
  printf '\n── %s ──\n' "$method"
  call "$body" | $PRETTY
}

# ---- the four diagnostic surfaces ------------------------------------------
ipc chain.status
ipc chain.faucetReserve.status
ipc chain.spend.status
ipc chain.permits.status
ipc chain.venues.status

# ---- recent log noise ------------------------------------------------------
if [[ -f "$LOG" ]]; then
  printf '\n── sidecar.log (last %s lines, warn+ only) ──\n' "$LOG_TAIL"
  tail -n "$LOG_TAIL" "$LOG" | grep -E '"level":(40|50|60)|revert|drop|VenueNotRegistered|BadSignature|BadNonce' | tail -n 20 || echo "(no warn/error lines in window)"
fi

# ---- on-chain check for a specific venue (optional) ------------------------
if [[ -n "$VENUE_ID" ]]; then
  RPC="${MONAD_RPC_URL:-https://testnet-rpc.monad.xyz}"
  DEPLOY="${DEPLOYMENTS:-$(dirname "$0")/../contracts/deployments/monad-testnet.json}"
  if ! command -v cast >/dev/null; then
    echo "warn: cast not in PATH — skipping on-chain check" >&2
  elif [[ ! -f "$DEPLOY" ]]; then
    echo "warn: $DEPLOY not found — skipping on-chain check" >&2
  else
    VR=$(jq -r '.demoPark.venueRegistry'    "$DEPLOY")
    PT=$(jq -r '.globals.parkToken'         "$DEPLOY")
    SB=$(jq -r '.demoPark.settlementBatcher' "$DEPLOY")
    printf '\n── on-chain venue %s ──\n' "$VENUE_ID"
    SUB=$(cast call "$VR" "subAccountOf(uint32)(address)" "$VENUE_ID" --rpc-url "$RPC" 2>/dev/null)
    BAL=$(cast call "$PT" "balanceOf(address)(uint256)" "$SUB"     --rpc-url "$RPC" 2>/dev/null)
    REG=$(cast call "$VR" "venues(uint32)(uint32,uint8,string,string,address,uint64,bool)" "$VENUE_ID" --rpc-url "$RPC" 2>/dev/null)
    echo "subAccount:  $SUB"
    echo "PARK balance: $BAL wei"
    echo "registry row:"; printf '  %s\n' "$REG" | sed 's/^/  /'

    HEAD=$(cast block-number --rpc-url "$RPC" 2>/dev/null)
    REGBLOCK=$(echo "$REG" | sed -n '6p')   # registeredAtBlock is field 6
    if [[ -n "$HEAD" && -n "$REGBLOCK" ]]; then
      printf '\n── GuestSpend(venueId=%s) since registration (head=%s, registered=%s) ──\n' \
        "$VENUE_ID" "$HEAD" "$REGBLOCK"
      # eth_getLogs is capped at 100-block windows on Monad — walk it.
      TOPIC=$(printf '0x%064x' "$VENUE_ID")
      total=0
      start="$REGBLOCK"
      while (( start <= HEAD )); do
        end=$(( start + 99 )); (( end > HEAD )) && end=$HEAD
        n=$(cast logs --rpc-url "$RPC" --address "$SB" \
              'GuestSpend(address,uint32,uint8,uint8,uint256,uint64)' \
              null "$TOPIC" null \
              --from-block "$start" --to-block "$end" 2>/dev/null | grep -c blockHash || true)
        total=$(( total + n ))
        start=$(( end + 1 ))
      done
      echo "total matching events: $total"
    fi
  fi
fi
