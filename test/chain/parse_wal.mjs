// Round-trip checker for chain/Outbox (M4.1).
//
// Reads the WAL produced by the C++ harness and runs each line through the
// real sidecar parseEvent. Asserts the field shapes match what the sidecar
// will see in production.
//
// Usage: node parse_wal.mjs <wal_path>

import {readFileSync} from "node:fs";
import {parseEvent} from "../../chain-sidecar/dist/outbox/types.js";

const walPath = process.argv[2];
if (!walPath) {
    console.error("usage: node parse_wal.mjs <wal_path>");
    process.exit(2);
}

const text = readFileSync(walPath, "utf8");
const lines = text.split("\n").filter((l) => l.length > 0);

const expected = [
    {kind: "GUEST_ENTRY", seq: 0, guestId: 42, hdIndex: 0, cash: "250000000000000000"},
    {
        kind: "VENUE_REGISTERED",
        seq: 1,
        venueId: 1,
        venueKind: 1,
        name: "Madhatter's Café 🎢",
        objectType: "ParkRide",
    },
    {
        kind: "GUEST_SPEND",
        seq: 2,
        guestId: 42,
        hdIndex: 0,
        venueId: 1,
        amount: "5000000000000000",
        category: 0,
        gameTick: 12345,
    },
    {
        kind: "GUEST_SPEND",
        seq: 3,
        guestId: 42,
        hdIndex: 0,
        venueId: 1,
        amount: "3000000000000000",
        category: 1,
        gameTick: 12350,
    },
    {kind: "VENUE_RENAMED", seq: 4, venueId: 1, newName: 'The Wild "Quote" Coaster\\'},
    {kind: "GUEST_EXIT", seq: 5, guestId: 42, hdIndex: 0},
    {kind: "VENUE_REMOVED", seq: 6, venueId: 1},
    // Second producer (after re-open) — proves seq resumes monotonically past the tail.
    {kind: "GUEST_ENTRY", seq: 7, guestId: 99, hdIndex: 1, cash: "100000000000000000"},
];

if (lines.length !== expected.length) {
    console.error(`line count mismatch: got ${lines.length}, expected ${expected.length}`);
    process.exit(1);
}

for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const r = parseEvent(line);
    if (!r.ok) {
        console.error(`line ${i} parse failed: ${r.error}\n  raw: ${line}`);
        process.exit(1);
    }
    const got = r.event;
    const want = expected[i];
    for (const [k, v] of Object.entries(want)) {
        if (got[k] !== v) {
            console.error(`line ${i} field '${k}': got ${JSON.stringify(got[k])}, want ${JSON.stringify(v)}`);
            console.error(`  raw: ${line}`);
            process.exit(1);
        }
    }
    if (typeof got.ts !== "number" || got.ts <= 0) {
        console.error(`line ${i} bad ts: ${JSON.stringify(got.ts)}`);
        process.exit(1);
    }
}

console.log(`OK: ${lines.length} lines parsed and matched expected fields.`);
