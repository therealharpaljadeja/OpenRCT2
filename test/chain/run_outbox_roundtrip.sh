#!/usr/bin/env bash
# M4.1 roundtrip check: build the C++ harness against Outbox.cpp, write a WAL,
# parse each line through chain-sidecar's real parseEvent.

set -euo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
repo="$(cd "$here/../.." && pwd)"

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

bin="$work/outbox_roundtrip"
wal="$work/chain-outbox.wal"

g++ -std=c++20 -O2 -DOPENRCT2_CHAIN \
    -I"$repo/src/openrct2" \
    "$here/outbox_roundtrip.cpp" \
    "$repo/src/openrct2/chain/Outbox.cpp" \
    -pthread \
    -o "$bin"

# Make sure the sidecar's TS has been compiled at least once so dist/outbox/types.js exists.
if [[ ! -f "$repo/chain-sidecar/dist/outbox/types.js" ]]; then
    (cd "$repo/chain-sidecar" && npm run build)
fi

"$bin" "$wal"
node "$here/parse_wal.mjs" "$wal"
