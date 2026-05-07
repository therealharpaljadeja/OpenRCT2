/**
 * Event handlers for the OpenRCT2 park indexer.
 *
 * One handler per (contract, event) pair. The shapes Envio generates from `config.yaml`
 * land in `generated/src/Handlers.gen.ts` after `pnpm codegen`; we import them by name
 * and register `.handler(...)` callbacks. Each callback gets:
 *   - `event` — the decoded log + block context
 *   - `context` — entity loaders/setters and a logger
 *
 * Conventions:
 *   - Entity ids are lowercased hex / decimal strings (never raw bytes); GraphQL `ID`
 *     is a string. The schema's `subAccount`/`address` fields mirror the same string
 *     so consumers can filter without thinking about case.
 *   - Aggregates (`totalRevenue`, `totalSpent`, `spendCount`) are maintained in-handler
 *     instead of computed at query time. Keeps the live feed cheap; the cost is one
 *     extra read+write per spend, which Envio batches inside a single block transaction.
 */
// Relative import into the codegen output. The Envio templates use `from "generated"` and
// rely on a pnpm workspace symlink, but Node's ESM resolver (used when Envio loads
// handlers in some runtimes) is strict about node_modules layout and that path is
// fragile across pnpm/npm/symlink combinations. The relative path is unambiguous and
// works on every package-manager setup with no extra wiring.
import {
  GuestRegistry,
  LendingPool,
  SettlementBatcher,
  VenueRegistry,
} from "../generated/src/Handlers.gen.js";

const ZERO = 0n;
const LOAN_ID = "loan";

const KIND_LABELS = ["ParkEntrance", "Ride", "Shop", "Stall", "Facility", "ATM"] as const;

function kindLabel(kind: number): string {
  return KIND_LABELS[kind] ?? `Unknown(${kind})`;
}

function lowerAddress(addr: string): string {
  return addr.toLowerCase();
}

// -----------------------------------------------------------------------------
// VenueRegistry — venue lifecycle
// -----------------------------------------------------------------------------

VenueRegistry.VenueRegistered.handler(async ({event, context}) => {
  const id = String(event.params.id);
  const kind = Number(event.params.kind);
  context.Venue.set({
    id,
    venueId: BigInt(event.params.id),
    kind,
    kindLabel: kindLabel(kind),
    name: event.params.name,
    objectType: event.params.objectType,
    subAccount: lowerAddress(event.params.subAccount),
    active: true,
    registeredAtBlock: BigInt(event.block.number),
    totalRevenue: ZERO,
    spendCount: 0,
  });
});

VenueRegistry.VenueRenamed.handler(async ({event, context}) => {
  const id = String(event.params.id);
  const existing = await context.Venue.get(id);
  if (!existing) {
    // Rename before register would mean a producer/contract drift; record a warning and
    // create a stub so subsequent spends still have a venue to attach to.
    context.log.warn(`VenueRenamed for unknown venueId=${id} — creating stub`);
    context.Venue.set({
      id,
      venueId: BigInt(event.params.id),
      kind: 0,
      kindLabel: kindLabel(0),
      name: event.params.newName,
      objectType: "",
      subAccount: "",
      active: true,
      registeredAtBlock: BigInt(event.block.number),
      totalRevenue: ZERO,
      spendCount: 0,
    });
    return;
  }
  context.Venue.set({...existing, name: event.params.newName});
});

VenueRegistry.VenueRetargeted.handler(async ({event, context}) => {
  const id = String(event.params.id);
  const existing = await context.Venue.get(id);
  if (!existing) {
    context.log.warn(`VenueRetargeted for unknown venueId=${id}`);
    return;
  }
  context.Venue.set({...existing, subAccount: lowerAddress(event.params.newSubAccount)});
});

VenueRegistry.VenueRemoved.handler(async ({event, context}) => {
  const id = String(event.params.id);
  const existing = await context.Venue.get(id);
  if (!existing) {
    context.log.warn(`VenueRemoved for unknown venueId=${id}`);
    return;
  }
  // The contract preserves storage on remove (only flips `active`) so historical events
  // can still resolve back to a name; we mirror that — keep the row, flip the flag.
  context.Venue.set({...existing, active: false});
});

// -----------------------------------------------------------------------------
// SettlementBatcher — spends + per-batch metadata
// -----------------------------------------------------------------------------

SettlementBatcher.GuestSpend.handler(async ({event, context}) => {
  const guestId = lowerAddress(event.params.guest);
  const venueIdStr = String(event.params.venueId);
  const amount = event.params.amount;

  // Upsert guest. First-touch from a spend (no Entry yet) creates a stub with guestId=0;
  // when the corresponding GuestRegistry.Entry lands later, it'll fill the real id.
  const guest = await context.Guest.get(guestId);
  if (!guest) {
    context.Guest.set({
      id: guestId,
      guestId: ZERO,
      address: guestId,
      entryBlock: undefined,
      exitBlock: undefined,
      totalSpent: amount,
      spendCount: 1,
    });
  } else {
    context.Guest.set({
      ...guest,
      totalSpent: guest.totalSpent + amount,
      spendCount: guest.spendCount + 1,
    });
  }

  // Update venue aggregates. Same first-touch rule — if the venue isn't registered yet
  // (theoretically possible if Envio processes events out of order, though HyperSync
  // delivers in block + log order so this is a safety net).
  const venue = await context.Venue.get(venueIdStr);
  if (!venue) {
    const kind = Number(event.params.kind);
    context.log.warn(`GuestSpend for unregistered venueId=${venueIdStr} — creating stub`);
    context.Venue.set({
      id: venueIdStr,
      venueId: BigInt(event.params.venueId),
      kind,
      kindLabel: kindLabel(kind),
      name: `Unknown venue ${venueIdStr}`,
      objectType: "",
      subAccount: "",
      active: true,
      registeredAtBlock: BigInt(event.block.number),
      totalRevenue: amount,
      spendCount: 1,
    });
  } else {
    context.Venue.set({
      ...venue,
      totalRevenue: venue.totalRevenue + amount,
      spendCount: venue.spendCount + 1,
    });
  }

  context.Spend.set({
    id: `${event.transaction.hash}-${event.logIndex}`,
    guest_id: guestId,
    venue_id: venueIdStr,
    category: Number(event.params.category),
    amount,
    block: BigInt(event.block.number),
    blockTimestamp: BigInt(event.block.timestamp),
    txHash: event.transaction.hash,
    gameTick: event.params.gameTick,
  });
});

SettlementBatcher.BatchSettled.handler(async ({event, context}) => {
  context.Batch.set({
    id: event.transaction.hash,
    count: event.params.count,
    block: BigInt(event.block.number),
    blockTimestamp: BigInt(event.block.timestamp),
    txHash: event.transaction.hash,
  });
});

// -----------------------------------------------------------------------------
// GuestRegistry — entry/exit lifecycle
// -----------------------------------------------------------------------------

GuestRegistry.Entry.handler(async ({event, context}) => {
  const id = lowerAddress(event.params.addr);
  const existing = await context.Guest.get(id);
  if (existing) {
    // First-touched by a spend; fill in the missing entry data.
    context.Guest.set({
      ...existing,
      guestId: event.params.guestId,
      entryBlock: BigInt(event.params.entryBlock),
    });
  } else {
    context.Guest.set({
      id,
      guestId: event.params.guestId,
      address: id,
      entryBlock: BigInt(event.params.entryBlock),
      exitBlock: undefined,
      totalSpent: ZERO,
      spendCount: 0,
    });
  }
});

GuestRegistry.Exit.handler(async ({event, context}) => {
  const id = lowerAddress(event.params.addr);
  const existing = await context.Guest.get(id);
  if (!existing) {
    context.log.warn(`Exit for unknown guest=${id}`);
    return;
  }
  context.Guest.set({...existing, exitBlock: BigInt(event.params.exitBlock)});
});

// -----------------------------------------------------------------------------
// LendingPool — singleton loan state
// -----------------------------------------------------------------------------

async function loadOrInitLoan(context: {LoanState: {get: (id: string) => Promise<any>}}) {
  const existing = await context.LoanState.get(LOAN_ID);
  return (
    existing ?? {
      id: LOAN_ID,
      principal: ZERO,
      ratePerBlock: ZERO,
      maxBorrow: ZERO,
      bankrupt: false,
      bankruptcyDeficit: undefined,
      bankruptcyAtBlock: undefined,
      lastUpdatedBlock: ZERO,
    }
  );
}

LendingPool.LoanChanged.handler(async ({event, context}) => {
  const loan = await loadOrInitLoan(context);
  context.LoanState.set({
    ...loan,
    principal: event.params.newPrincipal,
    ratePerBlock: event.params.ratePerBlock,
    maxBorrow: event.params.maxBorrow,
    lastUpdatedBlock: BigInt(event.block.number),
  });
});

LendingPool.InterestAccrued.handler(async ({event, context}) => {
  const loan = await loadOrInitLoan(context);
  context.LoanState.set({
    ...loan,
    principal: event.params.newPrincipal,
    lastUpdatedBlock: BigInt(event.block.number),
  });
});

LendingPool.Bankruptcy.handler(async ({event, context}) => {
  const loan = await loadOrInitLoan(context);
  context.LoanState.set({
    ...loan,
    bankrupt: true,
    bankruptcyDeficit: event.params.deficit,
    bankruptcyAtBlock: BigInt(event.params.atBlock),
    lastUpdatedBlock: BigInt(event.block.number),
  });
});
