#!/usr/bin/env bash
# Live-tail the chain sidecar log, filtering to essential lifecycle events
# (venues, guests, park launch, treasury). Pretty-prints time/level/msg/event.
#
# Usage:  ./tail-events.sh                       # auto: ~/.openrct2-agent/chain/sidecar.log
#         ./tail-events.sh /path/to/sidecar.log  # explicit log file
#         FILTER='VENUE_|GUEST_' ./tail-events.sh
#         RAW=1 ./tail-events.sh                 # skip jq, dump raw JSON lines
set -uo pipefail

LOG="${1:-$HOME/.openrct2-agent/chain/sidecar.log}"
FILTER="${FILTER:-VENUE_|GUEST_|park.launch|treasury}"

[[ -f "$LOG" ]] || { echo "ERROR: log not found at $LOG" >&2; exit 1; }

echo "Tailing: $LOG"
echo "Filter:  $FILTER"
echo

if [[ "${RAW:-0}" == "1" ]] || ! command -v jq >/dev/null 2>&1; then
  [[ "${RAW:-0}" != "1" ]] && echo "(jq not found — falling back to grep)" >&2
  exec tail -F "$LOG" | grep -E --line-buffered "$FILTER"
fi

exec tail -F "$LOG" \
  | jq -rc --arg filter "$FILTER" '
      select(.msg | test($filter))
      | "\(.time)  L\(.level)  \(.msg)  \(.event // {} | tojson)"
    '
