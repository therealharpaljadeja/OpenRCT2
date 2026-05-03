/// EIP-2612 permit collection (plan §2.3 / M3.6). Each guest signs a permit at park entry
/// granting the SettlementBatcher unlimited PARK allowance off-chain; the collector packs N
/// of these signatures into one `treasury.executeBatch` tx so the on-chain allowance is set
/// before the first GUEST_SPEND lands.
export {
    permitDomain,
    signPermit,
    hashPermit,
    recoverPermitSigner,
    PARK_PERMIT_DOMAIN_NAME,
    PARK_PERMIT_DOMAIN_VERSION,
    PERMIT_TYPES,
    type PermitDomain,
    type PermitArgs,
    type SignedPermit,
} from "./sign.js";
export {
    PermitCollector,
    DEFAULT_PERMIT_MAX_SIZE,
    DEFAULT_PERMIT_MAX_AGE_MS,
    DEFAULT_PERMIT_MAX_QUEUED,
    type PermitCollectorOptions,
    type PermitCollectorStats,
    type PermitFlushReason,
} from "./collector.js";
