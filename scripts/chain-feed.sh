#!/usr/bin/env bash
# Live on-chain activity feed against the local indexer's GraphQL endpoint.
#
# Polls the indexer (default http://localhost:8080/v1/graphql) every 1s for new spends,
# venue registrations, batch settles, and loan state changes; prints color-coded lines.
# No deps beyond curl + jq, both standard on macOS and most Linux distros.
#
# Usage:
#   scripts/chain-feed.sh                              # follow everything
#   scripts/chain-feed.sh --venue <chainVenueId>       # only spends for one venue
#   scripts/chain-feed.sh --kind ride                  # only Ride / Stall / Shop / etc.
#   scripts/chain-feed.sh --since <block>              # backfill from this block
#   scripts/chain-feed.sh --interval 0.5               # poll faster (default 1s)
#   scripts/chain-feed.sh --url http://host:8080/...   # custom endpoint
#
# Filters compose: `--kind stall --venue 12345` shows stall spends for one venue.
#
# The polling cursor (last_block) is per-event-stream so a flood of one type doesn't
# stall the others. Backfill is bounded — first tick fetches up to 100 historical rows
# per stream, then strictly newest-first afterward.

set -uo pipefail

ENDPOINT="${INDEXER_URL:-http://localhost:8080/v1/graphql}"
INTERVAL="1"
SINCE_BLOCK="0"
KIND_FILTER=""
VENUE_FILTER=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --url)      ENDPOINT="$2"; shift 2 ;;
    --interval) INTERVAL="$2"; shift 2 ;;
    --since)    SINCE_BLOCK="$2"; shift 2 ;;
    --venue)    VENUE_FILTER="$2"; shift 2 ;;
    --kind)
      # accept "ride", "stall", etc. — convert to indexer's kind index (0..5)
      case "${2,,}" in
        parkentrance|entrance|park) KIND_FILTER=0 ;;
        ride)                       KIND_FILTER=1 ;;
        shop)                       KIND_FILTER=2 ;;
        stall)                      KIND_FILTER=3 ;;
        facility)                   KIND_FILTER=4 ;;
        atm)                        KIND_FILTER=5 ;;
        *) echo "error: unknown --kind '$2' (entrance|ride|shop|stall|facility|atm)" >&2; exit 2 ;;
      esac
      shift 2
      ;;
    -h|--help) sed -n '2,21p' "$0"; exit 0 ;;
    *) echo "error: unknown arg '$1'" >&2; exit 2 ;;
  esac
done

if ! command -v jq >/dev/null; then
  echo "error: 'jq' not in PATH" >&2; exit 2
fi

# ---- ANSI ------------------------------------------------------------------
RESET=$'\e[0m'; DIM=$'\e[2m'; BOLD=$'\e[1m'
FG_RED=$'\e[31m'; FG_GRN=$'\e[32m'; FG_YEL=$'\e[33m'
FG_BLU=$'\e[34m'; FG_MAG=$'\e[35m'; FG_CYN=$'\e[36m'

kind_color() {
  case "$1" in
    ParkEntrance) printf '%s' "$FG_MAG" ;;
    Ride)         printf '%s' "$FG_BLU" ;;
    Shop)         printf '%s' "$FG_GRN" ;;
    Stall)        printf '%s' "$FG_YEL" ;;
    Facility)     printf '%s' "$FG_CYN" ;;
    ATM)          printf '%s' "$FG_RED" ;;
    *)            printf '%s' "$RESET" ;;
  esac
}

# Convert wei (string, may exceed uint64) to PARK with 3 decimals. Pure awk so we don't
# trip on bash's 64-bit integer ceiling for amounts like 50 PARK = 5e19 wei.
park() {
  awk -v w="$1" 'BEGIN { printf "%.3f", w / 1e18 }'
}

# ---- query builder ---------------------------------------------------------
build_filter() {
  local block_floor="$1"
  local kind_clause=""
  local venue_clause=""
  if [[ -n "$KIND_FILTER" ]]; then
    kind_clause=", venue: {kind: {_eq: $KIND_FILTER}}"
  fi
  if [[ -n "$VENUE_FILTER" ]]; then
    venue_clause=", venue_id: {_eq: \"$VENUE_FILTER\"}"
  fi
  printf '{block: {_gt: "%s"}%s%s}' "$block_floor" "$kind_clause" "$venue_clause"
}

# ---- one-shot fetcher -----------------------------------------------------
gql() {
  local query="$1"
  local body
  body=$(printf '{"query":"%s"}' "$query" | sed 's/"/\\"/g; s/^\\"/\"/; s/\\"$/"/')
  # Simpler: jq builds the JSON for us.
  body=$(jq -nc --arg q "$query" '{query: $q}')
  curl -s --max-time 5 "$ENDPOINT" \
    -H 'content-type: application/json' \
    -d "$body"
}

# ---- per-stream cursors ---------------------------------------------------
last_spend_block="$SINCE_BLOCK"
last_venue_block="$SINCE_BLOCK"
last_batch_block="$SINCE_BLOCK"
last_loan_block="$SINCE_BLOCK"

print_spends() {
  local where; where=$(build_filter "$last_spend_block")
  local q="query{ Spend(where: $where, order_by: {block: asc, id: asc}, limit: 50) { id amount block blockTimestamp category txHash venue { name kindLabel kind } guest { id guestId } } }"
  local resp; resp=$(gql "$q") || return 0
  local count; count=$(echo "$resp" | jq -r '.data.Spend | length // 0')
  [[ "$count" == "0" ]] && return 0
  echo "$resp" | jq -r '.data.Spend[] | [.block, .venue.kindLabel, .venue.name, .amount, .category, (.guest.id // "0x?"), .txHash] | @tsv' \
    | while IFS=$'\t' read -r block kind name amount category guest tx; do
        local kc; kc=$(kind_color "$kind")
        local cat; case "$category" in
          0) cat="ride" ;;  1) cat="food" ;;  2) cat="shop" ;;
          3) cat="facility" ;; 4) cat="entry" ;; 5) cat="atm" ;;
          *) cat="?$category" ;;
        esac
        printf "${DIM}%-9s${RESET}  spend  ${kc}%-22s${RESET} ${FG_YEL}%9s PARK${RESET}  ${DIM}%s • %s… • %s${RESET}\n" \
          "$block" "${name:0:22}" "$(park "$amount")" "$cat" "${guest:0:10}" "$tx"
      done
  last_spend_block=$(echo "$resp" | jq -r '.data.Spend | last | .block')
}

print_venues() {
  local q="query{ Venue(where: {registeredAtBlock: {_gt: \"$last_venue_block\"}}, order_by: {registeredAtBlock: asc}, limit: 50) { id name kindLabel registeredAtBlock active } }"
  local resp; resp=$(gql "$q") || return 0
  local count; count=$(echo "$resp" | jq -r '.data.Venue | length // 0')
  [[ "$count" == "0" ]] && return 0
  echo "$resp" | jq -r '.data.Venue[] | [.registeredAtBlock, .kindLabel, .name, .id] | @tsv' \
    | while IFS=$'\t' read -r block kind name id; do
        local kc; kc=$(kind_color "$kind")
        printf "${DIM}%-9s${RESET}  ${BOLD}venue${RESET}  ${kc}%-22s${RESET}  ${DIM}registered  id=%s  kind=%s${RESET}\n" \
          "$block" "${name:0:22}" "$id" "$kind"
      done
  last_venue_block=$(echo "$resp" | jq -r '.data.Venue | last | .registeredAtBlock')
}

print_batches() {
  local q="query{ Batch(where: {block: {_gt: \"$last_batch_block\"}}, order_by: {block: asc}, limit: 50) { id count block txHash } }"
  local resp; resp=$(gql "$q") || return 0
  local count; count=$(echo "$resp" | jq -r '.data.Batch | length // 0')
  [[ "$count" == "0" ]] && return 0
  echo "$resp" | jq -r '.data.Batch[] | [.block, .count, .txHash] | @tsv' \
    | while IFS=$'\t' read -r block n tx; do
        printf "${DIM}%-9s${RESET}  ${FG_CYN}batch${RESET}  ${DIM}settled %s spend(s) • %s${RESET}\n" \
          "$block" "$n" "$tx"
      done
  last_batch_block=$(echo "$resp" | jq -r '.data.Batch | last | .block')
}

print_loan() {
  # singleton — poll its lastUpdatedBlock as the cursor
  local q="query{ LoanState_by_pk(id: \"loan\") { principal ratePerBlock maxBorrow bankrupt lastUpdatedBlock } }"
  local resp; resp=$(gql "$q") || return 0
  local block; block=$(echo "$resp" | jq -r '.data.LoanState_by_pk.lastUpdatedBlock // "0"')
  if [[ "$block" != "0" && "$block" -gt "$last_loan_block" ]]; then
    local principal rate bankrupt
    principal=$(echo "$resp" | jq -r '.data.LoanState_by_pk.principal')
    rate=$(echo "$resp" | jq -r '.data.LoanState_by_pk.ratePerBlock')
    bankrupt=$(echo "$resp" | jq -r '.data.LoanState_by_pk.bankrupt')
    local color="$FG_GRN"
    [[ "$bankrupt" == "true" ]] && color="$FG_RED"
    printf "${DIM}%-9s${RESET}  ${color}loan${RESET}   principal=%s PARK • rate/block=%s • bankrupt=%s\n" \
      "$block" "$(park "$principal")" "$rate" "$bankrupt"
    last_loan_block="$block"
  fi
}

# ---- header + loop ---------------------------------------------------------
printf "${DIM}feed: %s   poll=%ss   filter:${RESET} kind=%s venue=%s\n" \
  "$ENDPOINT" "$INTERVAL" "${KIND_FILTER:-any}" "${VENUE_FILTER:-any}"
printf "${DIM}block       type   what                                      details${RESET}\n"

# Be polite on Ctrl+C
trap 'echo; echo "(feed stopped)"; exit 0' INT TERM

while true; do
  print_spends
  print_venues
  print_batches
  print_loan
  sleep "$INTERVAL"
done
