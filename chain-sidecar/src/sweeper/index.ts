/// Sweeper (plan §2.3 / §4.4 / M3.7). On `GUEST_EXIT`, returns the guest's remaining PARK
/// back to the treasury via batched `[permit, transferFrom]` calldatas through
/// `treasury.executeBatch`. See `sweeper.ts` for the full design rationale.
export {
    Sweeper,
    DEFAULT_SWEEPER_MAX_SIZE,
    DEFAULT_SWEEPER_MAX_AGE_MS,
    DEFAULT_SWEEPER_MAX_QUEUED,
    DEFAULT_SWEEPER_PERMIT_DEADLINE_DAYS,
    type SweeperEntry,
    type SweeperOptions,
    type SweeperStats,
    type SweeperFlushReason,
} from "./sweeper.js";
