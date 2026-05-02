/// Funder (plan §2.3 / §4.4 / M3.5). Coalesces guest-entry events into windowed
/// `Disperse.disperseToken(PARK, …)` calls so each entering guest gets a real PARK balance
/// without one tx per guest. M3.6 will extend this module with EIP-2612 permit collection.
export {
    Funder,
    DEFAULT_FUNDER_MAX_SIZE,
    DEFAULT_FUNDER_MAX_AGE_MS,
    DEFAULT_FUNDER_MAX_QUEUED,
    DEFAULT_FUNDER_ALLOWANCE,
    type FunderEntry,
    type FunderOptions,
    type FunderStats,
    type FunderFlushReason,
} from "./funder.js";
