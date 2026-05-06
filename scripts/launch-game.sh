#!/usr/bin/env bash
# Launches OpenRCT2 with chain mode enabled and the env the sidecar needs.
# Usage:  ./launch-game.sh                       # boot to title screen (no park)
#         ./launch-game.sh /path/to/park.park    # launch a specific park
#         STREAM=1 ./launch-game.sh              # also stream to Twitch (uses stream.sh)
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
echo $REPO

# ---- chain config ----------------------------------------------------------
# Required:
export MONAD_DEPLOYMENTS="${MONAD_DEPLOYMENTS:-$REPO/contracts/deployments/monad-testnet.json}"

# Optional (sidecar boots with on-chain plumbing only when these are set):
# export MONAD_RPC_URL="${MONAD_RPC_URL:-https://testnet-rpc.monad.xyz}"
# export FAUCET_OWNER_KEYFILE="${FAUCET_OWNER_KEYFILE:-/home/ubuntu/.rct2/faucet-owner.key}"
# export FAUCET_OWNER_KEY="${FAUCET_OWNER_KEY:-0x...}"   # alternative to keyfile

# Required for keystore unlock — the sidecar reads this directly:
: "${KEYSTORE_PASSPHRASE:?KEYSTORE_PASSPHRASE not set. Export it before running this script.}"

# ---- game config -----------------------------------------------------------
# macOS builds produce an .app bundle (binary + assembled data live inside);
# Linux builds produce a plain binary alongside built data files.
if [[ "$(uname -s)" == "Darwin" ]]; then
  OPENRCT2_BIN="${OPENRCT2_BIN:-$REPO/build/OpenRCT2.app/Contents/MacOS/OpenRCT2}"
  OPENRCT2_DATA="${OPENRCT2_DATA:-$REPO/build/OpenRCT2.app/Contents/Resources}"
else
  OPENRCT2_BIN="${OPENRCT2_BIN:-$REPO/build/openrct2}"
  OPENRCT2_DATA="${OPENRCT2_DATA:-$REPO/data}"
fi
RCT2_DATA="${RCT2_DATA:-$REPO/../Rollercoaster Tycoon 2}"
PARK="${1:-${PARK:-}}"

# Pass the park as a positional arg only when one was provided.
PARK_ARGS=()
[[ -n "$PARK" ]] && PARK_ARGS=("$PARK")

# ---- preflight -------------------------------------------------------------
[[ -x "$OPENRCT2_BIN" ]]    || { echo "ERROR: openrct2 binary not found at $OPENRCT2_BIN" >&2; exit 1; }
[[ -f "$MONAD_DEPLOYMENTS" ]] || { echo "ERROR: deployments file not found at $MONAD_DEPLOYMENTS" >&2; exit 1; }
[[ -z "$PARK" || -f "$PARK" ]] || { echo "ERROR: park file not found at $PARK" >&2; exit 1; }

echo "OpenRCT2:       $OPENRCT2_BIN"
echo "Park:           ${PARK:-<none — boot to title screen>}"
echo "Deployments:    $MONAD_DEPLOYMENTS"
echo "RPC URL:        ${MONAD_RPC_URL:-<unset — sidecar runs without on-chain plumbing>}"
echo "Faucet keyfile: ${FAUCET_OWNER_KEYFILE:-<unset>}"
echo

# ---- launch ----------------------------------------------------------------
if [[ "${STREAM:-0}" == "1" ]]; then
  : "${STREAM_KEY_URL:?STREAM=1 requires STREAM_KEY_URL (rtmp://…)}"
  # stream.sh inherits our env; tell it which binary + park + that we want chain mode.
  # (stream.sh's command line is fixed, so we re-implement its launch here with --chain.)
  echo "Streaming requested. Re-implementing stream.sh launch with --chain enabled."
  DISPLAY_NUM="${DISPLAY_NUM:-:99}"
  RES="${RES:-1280x720}"
  FPS="${FPS:-30}"
  Xvfb "$DISPLAY_NUM" -screen 0 "${RES}x24" -nolisten tcp >/tmp/xvfb.log 2>&1 &
  XVFB_PID=$!
  trap 'kill $XVFB_PID 2>/dev/null || true' EXIT
  sleep 1
  export DISPLAY="$DISPLAY_NUM"
  "$OPENRCT2_BIN" ${PARK_ARGS[@]+"${PARK_ARGS[@]}"} --chain \
    --openrct2-data-path="$OPENRCT2_DATA" \
    --rct2-data-path="$RCT2_DATA" \
    >/tmp/openrct2.log 2>&1 &
  GAME_PID=$!
  sleep 3
  ffmpeg -hide_banner -loglevel info \
    -f x11grab -video_size "$RES" -framerate "$FPS" -i "$DISPLAY_NUM" \
    -f lavfi -i anullsrc=r=44100:cl=stereo \
    -c:v libx264 -preset veryfast -tune zerolatency -pix_fmt yuv420p \
    -b:v 2500k -maxrate 2500k -bufsize 5000k -g $((FPS*2)) \
    -c:a aac -b:a 128k -ar 44100 \
    -f flv "$STREAM_KEY_URL" >/tmp/ffmpeg.log 2>&1 &
  FFMPEG_PID=$!
  trap 'kill $FFMPEG_PID $GAME_PID $XVFB_PID 2>/dev/null || true' EXIT
  echo "Game PID=$GAME_PID  ffmpeg PID=$FFMPEG_PID"
  echo "Logs: /tmp/openrct2.log  /tmp/ffmpeg.log  /tmp/xvfb.log"
  wait "$FFMPEG_PID"
else
  exec "$OPENRCT2_BIN" ${PARK_ARGS[@]+"${PARK_ARGS[@]}"} --chain \
    --openrct2-data-path="$OPENRCT2_DATA" \
    --rct2-data-path="$RCT2_DATA"
fi
