#!/usr/bin/env bash
# Quick health check for the OpenRCT2 onchain sidecar.
# Reads the live log + WAL + cursor and prints a verdict.
# Usage:  ./check-sidecar.sh                    # auto-discover workspace
#         ./check-sidecar.sh /path/to/chain     # explicit chain dir
# Exit codes: 0 healthy, 1 degraded, 2 broken, 3 cannot determine.

set -uo pipefail

SAMPLE_SECS="${SAMPLE_SECS:-5}"   # how long to sample WAL/cursor + PIDs
WARN_WINDOW="${WARN_WINDOW:-200}" # tail lines to scan for warn/error

# ---- locate the chain workspace -------------------------------------------
CHAIN_DIR="${1:-}"
if [[ -z "$CHAIN_DIR" ]]; then
  CHAIN_DIR=$(find /home/ubuntu /tmp -maxdepth 6 -name sidecar.log -mmin -60 2>/dev/null \
              | head -n1 | xargs -r dirname)
fi
if [[ -z "$CHAIN_DIR" || ! -d "$CHAIN_DIR" ]]; then
  echo "Verdict: CANNOT DETERMINE — no recent sidecar.log found."
  echo "  Pass the chain dir explicitly:  $0 /path/to/chain"
  exit 3
fi

LOG="$CHAIN_DIR/sidecar.log"
WAL="$CHAIN_DIR/outbox.wal"
CUR="$CHAIN_DIR/outbox.cursor"
SOCK="$CHAIN_DIR/sidecar.sock"

echo "Workspace: $CHAIN_DIR"
[[ -f "$LOG" ]] || { echo "Verdict: BROKEN — sidecar.log missing"; exit 2; }

# ---- process / respawn check ----------------------------------------------
pids_now() { pgrep -f 'chain-sidecar/dist/main.js' 2>/dev/null | sort -u | tr '\n' ' '; }
PIDS_A=$(pids_now)
sleep "$SAMPLE_SECS"
PIDS_B=$(pids_now)

ALIVE=0
ROTATED=0
if [[ -n "$PIDS_A$PIDS_B" ]]; then ALIVE=1; fi
if [[ -n "$PIDS_A" && "$PIDS_A" != "$PIDS_B" ]]; then ROTATED=1; fi

# ---- WAL drain check ------------------------------------------------------
size() { [[ -f "$1" ]] && stat -c%s "$1" 2>/dev/null || echo 0; }
WAL_A=$(size "$WAL"); CUR_A=$(size "$CUR")
# already slept once above; re-sample after the same window
WAL_B=$(size "$WAL"); CUR_B=$(size "$CUR")
LAG=$(( WAL_B - CUR_B ))
WAL_GROWING=$(( WAL_B > WAL_A ))
CUR_ADVANCING=$(( CUR_B > CUR_A ))

# ---- log scan -------------------------------------------------------------
TAIL=$(tail -n "$WARN_WINDOW" "$LOG")
ERR_COUNT=$(printf '%s\n' "$TAIL" | grep -c '"level":50\|"level":60' || true)
WARN_COUNT=$(printf '%s\n' "$TAIL" | grep -c '"level":40' || true)
WORST=$(printf '%s\n' "$TAIL" | grep -E '"level":(50|60)' | tail -n1)
[[ -z "$WORST" ]] && WORST=$(printf '%s\n' "$TAIL" | grep '"level":40' | tail -n1)

SETTLE_COUNT=$(printf '%s\n' "$TAIL" | grep -c 'settle' || true)
HAS_FUNDER_OK=$(printf '%s\n' "$TAIL" | grep -c 'funder.start succeeded' || true)
HAS_RELAYER_OK=$(printf '%s\n' "$TAIL" | grep -c 'topup landed' || true)

# ---- verdict --------------------------------------------------------------
VERDICT="HEALTHY"
RC=0
REASONS=()

if [[ "$ALIVE" -eq 0 ]]; then
  VERDICT="BROKEN"; RC=2; REASONS+=("no chain-sidecar process running")
fi
if [[ "$ROTATED" -eq 1 ]]; then
  VERDICT="BROKEN"; RC=2; REASONS+=("PIDs rotated within ${SAMPLE_SECS}s — crash-respawn loop")
fi
if [[ "$ERR_COUNT" -gt 0 ]]; then
  VERDICT="BROKEN"; RC=2; REASONS+=("$ERR_COUNT error lines in last $WARN_WINDOW")
fi
if [[ "$WAL_GROWING" -eq 1 && "$CUR_ADVANCING" -eq 0 ]]; then
  VERDICT="BROKEN"; RC=2; REASONS+=("WAL growing but cursor stuck — sidecar not draining")
fi
if [[ "$VERDICT" == "HEALTHY" && "$WARN_COUNT" -gt 0 ]]; then
  VERDICT="DEGRADED"; RC=1; REASONS+=("$WARN_COUNT warn lines")
fi

echo
echo "Verdict:    $VERDICT"
echo "Process:    pids=[$PIDS_B] rotated=$ROTATED alive=$ALIVE"
echo "Drain:      wal=${WAL_B}B cursor=${CUR_B}B lag=${LAG}B wal_growing=$WAL_GROWING cursor_advancing=$CUR_ADVANCING"
echo "Log (last $WARN_WINDOW lines): err=$ERR_COUNT warn=$WARN_COUNT settle_msgs=$SETTLE_COUNT funder_ok=$HAS_FUNDER_OK topup_ok=$HAS_RELAYER_OK"
[[ -e "$SOCK" ]] && echo "Socket:     $SOCK present" || echo "Socket:     $SOCK MISSING"
if ((${#REASONS[@]})); then
  echo "Reasons:"
  for r in "${REASONS[@]}"; do echo "  - $r"; done
fi
[[ -n "$WORST" ]] && { echo "Worst log line:"; echo "  $WORST"; }

exit "$RC"
