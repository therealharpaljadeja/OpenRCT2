#!/usr/bin/env bash
# Deploy the OpenRCT2 park indexer to Envio Cloud.
#
# Wraps `envio cloud deploy` with the workspace path resolution so it can be invoked
# from anywhere in the repo. Idempotent: Envio cloud diffs config.yaml + schema.graphql
# server-side and only redeploys when something actually changed.
#
# Requires: ENVIO_API_TOKEN in env (or login first via `npx envio cloud login`).
#
# Usage:
#   scripts/deploy-indexer.sh             # deploy from main branch / latest commit
#   scripts/deploy-indexer.sh --dry-run   # validate config without uploading

set -euo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
indexer_dir="$(cd "$here/.." && pwd)/indexer"

if [[ ! -d "$indexer_dir" ]]; then
  echo "error: indexer directory not found at $indexer_dir" >&2
  exit 2
fi

if [[ -z "${ENVIO_API_TOKEN:-}" ]]; then
  echo "warn: ENVIO_API_TOKEN not set; falling back to interactive login if needed" >&2
fi

cd "$indexer_dir"

# Make sure node_modules is current — `envio cloud deploy` runs codegen but a stale
# node_modules can ship the wrong runtime version.
if [[ ! -d node_modules ]]; then
  echo "info: installing indexer deps..."
  npm install
fi

echo "info: regenerating Envio code..."
npx envio codegen

if [[ "${1:-}" == "--dry-run" ]]; then
  echo "info: --dry-run set; skipping upload"
  exit 0
fi

echo "info: deploying to Envio cloud..."
npx envio cloud deploy

echo "ok: indexer deploy complete. Find the GraphQL endpoint via 'npx envio cloud list'."
