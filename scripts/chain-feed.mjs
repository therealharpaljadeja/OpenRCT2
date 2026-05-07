#!/usr/bin/env node
// Live on-chain activity feed — push-based via Hasura GraphQL subscriptions.
//
// Connects to the indexer's WebSocket endpoint (default ws://localhost:8080/v1/graphql)
// and subscribes to spends, venue registrations, and loan changes. Hasura pushes new rows
// the moment they're written; no polling cadence to tune. Per-batch info is omitted —
// every spend already carries the full batch tx hash, so a separate summary line is
// strictly duplicate noise.
//
// Companion to chain-feed.sh — the bash version polls every interval and works without
// Node. This one is push-based but needs Node 22.4+ for the built-in WebSocket global.
//
// Usage:
//   scripts/chain-feed.mjs                              # follow everything
//   scripts/chain-feed.mjs --venue <chainVenueId>       # only spends for one venue
//   scripts/chain-feed.mjs --kind ride                  # one kind only
//   scripts/chain-feed.mjs --since <block>              # start cursor at this block
//   scripts/chain-feed.mjs --url ws://host:port/v1/graphql

if (typeof WebSocket === "undefined") {
    process.stderr.write(
        "error: WebSocket is not a global on this Node version.\n"
            + "       Need Node 22.4+ for the stable WebSocket class.\n"
            + "       Falling back? Run scripts/chain-feed.sh (poll-based, pure bash).\n",
    );
    process.exit(2);
}

// ---- args ----------------------------------------------------------------
const args = process.argv.slice(2);
const opts = {
    url: process.env.INDEXER_URL ?? "ws://localhost:8080/v1/graphql",
    since: "0",
    kind: null,
    venue: null,
};
for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--url") opts.url = args[++i];
    else if (a === "--since") opts.since = args[++i];
    else if (a === "--venue") opts.venue = args[++i];
    else if (a === "--kind") {
        const k = args[++i].toLowerCase();
        const map = {parkentrance: 0, entrance: 0, park: 0, ride: 1, shop: 2, stall: 3, facility: 4, atm: 5};
        if (!(k in map)) {
            process.stderr.write(`error: unknown --kind '${k}' (entrance|ride|shop|stall|facility|atm)\n`);
            process.exit(2);
        }
        opts.kind = map[k];
    } else if (a === "-h" || a === "--help") {
        // Print the doc-comment header (lines 2..16).
        const src = require("node:fs").readFileSync(new URL(import.meta.url), "utf8");
        process.stdout.write(src.split("\n").slice(1, 16).map((l) => l.replace(/^\/\/ ?/, "")).join("\n") + "\n");
        process.exit(0);
    } else {
        process.stderr.write(`error: unknown arg '${a}'\n`);
        process.exit(2);
    }
}

// http(s):// → ws(s):// in case the user passed an HTTP URL out of habit.
const wsUrl = opts.url.replace(/^http/, "ws");

// ---- ANSI ----------------------------------------------------------------
const C = {
    reset: "\x1b[0m",
    dim: "\x1b[2m",
    bold: "\x1b[1m",
    red: "\x1b[31m",
    green: "\x1b[32m",
    yellow: "\x1b[33m",
    blue: "\x1b[34m",
    magenta: "\x1b[35m",
    cyan: "\x1b[36m",
};

const KIND_COLOR = {
    ParkEntrance: C.magenta,
    Ride: C.blue,
    Shop: C.green,
    Stall: C.yellow,
    Facility: C.cyan,
    ATM: C.red,
};

// wei (string, may exceed uint64) → "X.XXX" PARK. Pure BigInt math, then format.
const WEI_PER_PARK = 10n ** 18n;
function park(weiStr) {
    const wei = BigInt(weiStr);
    const whole = wei / WEI_PER_PARK;
    // 3-decimal fractional: round to nearest 1e15 wei
    const frac = ((wei % WEI_PER_PARK) * 1000n) / WEI_PER_PARK;
    return `${whole}.${frac.toString().padStart(3, "0")}`;
}

const CATEGORY_LABEL = ["ride", "food", "shop", "facility", "entry", "atm"];

// ---- subscription queries -----------------------------------------------
// Hasura streaming subscriptions push only new rows past the cursor — exactly the
// "live tail" semantics we want, with no client-side dedup needed.
function spendSub(cursor) {
    const where = [];
    if (opts.kind !== null) where.push(`venue: {kind: {_eq: ${opts.kind}}}`);
    if (opts.venue !== null) where.push(`venue_id: {_eq: "${opts.venue}"}`);
    const whereClause = where.length ? `where: {${where.join(", ")}},` : "";
    return `subscription StreamSpends {
      Spend_stream(${whereClause} cursor: {initial_value: {block: "${cursor}"}, ordering: ASC}, batch_size: 50) {
        block amount category txHash
        venue { name kindLabel kind id }
        guest { id guestId }
      }
    }`;
}
function venueSub(cursor) {
    return `subscription StreamVenues {
      Venue_stream(cursor: {initial_value: {registeredAtBlock: "${cursor}"}, ordering: ASC}, batch_size: 50) {
        id name kindLabel kind registeredAtBlock active
      }
    }`;
}
function loanSub(cursor) {
    // Singleton — use a plain subscription that re-fires whenever the row is updated past
    // the cursor. The `_gt` filter prevents Hasura from re-emitting unchanged state.
    return `subscription LoanState {
      LoanState(where: {lastUpdatedBlock: {_gt: "${cursor}"}}) {
        principal ratePerBlock maxBorrow bankrupt lastUpdatedBlock bankruptcyDeficit
      }
    }`;
}

// ---- printers ------------------------------------------------------------
function printSpend(s) {
    const kc = KIND_COLOR[s.venue?.kindLabel] ?? C.reset;
    const cat = CATEGORY_LABEL[s.category] ?? `?${s.category}`;
    const name = (s.venue?.name ?? "(unknown)").slice(0, 22);
    const guest = (s.guest?.id ?? "0x?").slice(0, 10);
    const tx = s.txHash ?? "?"; // full — the user pastes this into the explorer
    process.stdout.write(
        `${C.dim}${String(s.block).padEnd(9)}${C.reset}  spend  ${kc}${name.padEnd(22)}${C.reset} `
            + `${C.yellow}${park(s.amount).padStart(9)} PARK${C.reset}  `
            + `${C.dim}${cat.padEnd(8)} • ${guest}… • ${tx}${C.reset}\n`,
    );
}
function printVenue(v) {
    const kc = KIND_COLOR[v.kindLabel] ?? C.reset;
    const name = (v.name ?? "(unknown)").slice(0, 22);
    process.stdout.write(
        `${C.dim}${String(v.registeredAtBlock).padEnd(9)}${C.reset}  ${C.bold}venue${C.reset}  `
            + `${kc}${name.padEnd(22)}${C.reset}  ${C.dim}registered  id=${v.id}  kind=${v.kindLabel}${C.reset}\n`,
    );
}
function printLoan(l) {
    const color = l.bankrupt ? C.red : C.green;
    process.stdout.write(
        `${C.dim}${String(l.lastUpdatedBlock).padEnd(9)}${C.reset}  ${color}loan${C.reset}   `
            + `principal=${park(l.principal)} PARK • rate/block=${l.ratePerBlock} • bankrupt=${l.bankrupt}\n`,
    );
}

// ---- WS protocol (graphql-transport-ws) ----------------------------------
// Per-stream cursor state — kept in a closure so a reconnect can resume cleanly without
// re-printing rows already shown.
let cursors = {
    spend: opts.since,
    venue: opts.since,
    loan: opts.since,
};

const SUB_IDS = {spend: "1", venue: "2", loan: "3"};

function connect() {
    const ws = new WebSocket(wsUrl, ["graphql-transport-ws"]);

    ws.addEventListener("open", () => {
        ws.send(JSON.stringify({type: "connection_init", payload: {}}));
    });

    ws.addEventListener("message", (ev) => {
        const msg = JSON.parse(typeof ev.data === "string" ? ev.data : ev.data.toString());
        switch (msg.type) {
            case "connection_ack":
                // Open all four subscriptions. Each gets its own id so server pushes route
                // back to the right printer.
                ws.send(JSON.stringify({type: "subscribe", id: SUB_IDS.spend, payload: {query: spendSub(cursors.spend)}}));
                ws.send(JSON.stringify({type: "subscribe", id: SUB_IDS.venue, payload: {query: venueSub(cursors.venue)}}));
                ws.send(JSON.stringify({type: "subscribe", id: SUB_IDS.loan, payload: {query: loanSub(cursors.loan)}}));
                process.stdout.write(
                    `${C.dim}feed: ${wsUrl}   filter: kind=${opts.kind ?? "any"} venue=${opts.venue ?? "any"}${C.reset}\n`
                        + `${C.dim}block       type   what                                      details${C.reset}\n`,
                );
                break;
            case "next":
                handleData(msg.id, msg.payload.data);
                break;
            case "error":
                process.stderr.write(`subscription error (id=${msg.id}): ${JSON.stringify(msg.payload)}\n`);
                break;
            case "complete":
                // Server completed a subscription. Re-subscribe so the stream stays open.
                resubscribe(ws, msg.id);
                break;
            // ka (keep-alive), ping, pong, connection_keep_alive — ignore.
        }
    });

    ws.addEventListener("close", (ev) => {
        process.stderr.write(`${C.dim}(ws closed: code=${ev.code} reason=${ev.reason || "—"}; reconnecting in 2s…)${C.reset}\n`);
        setTimeout(connect, 2000);
    });

    ws.addEventListener("error", () => {
        // close handler will fire afterward; nothing extra to do here.
    });
}

function handleData(id, data) {
    if (!data) return;
    if (id === SUB_IDS.spend && Array.isArray(data.Spend_stream)) {
        for (const s of data.Spend_stream) {
            printSpend(s);
            cursors.spend = String(s.block);
        }
    } else if (id === SUB_IDS.venue && Array.isArray(data.Venue_stream)) {
        for (const v of data.Venue_stream) {
            printVenue(v);
            cursors.venue = String(v.registeredAtBlock);
        }
    } else if (id === SUB_IDS.loan && Array.isArray(data.LoanState)) {
        for (const l of data.LoanState) {
            printLoan(l);
            cursors.loan = String(l.lastUpdatedBlock);
        }
    }
}

function resubscribe(ws, id) {
    const builders = {
        [SUB_IDS.spend]: () => ({id, payload: {query: spendSub(cursors.spend)}}),
        [SUB_IDS.venue]: () => ({id, payload: {query: venueSub(cursors.venue)}}),
        [SUB_IDS.loan]: () => ({id, payload: {query: loanSub(cursors.loan)}}),
    };
    const b = builders[id];
    if (b) ws.send(JSON.stringify({type: "subscribe", ...b()}));
}

process.on("SIGINT", () => {
    process.stdout.write("\n(feed stopped)\n");
    process.exit(0);
});

connect();
