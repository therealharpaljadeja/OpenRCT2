import {hashTypedData, recoverTypedDataAddress, type Hex} from "viem";
import type {LocalAccount} from "viem/accounts";

/// EIP-712 SpendAuth signer (plan §2.4 / M3.1).
///
/// This is the off-chain twin of `SettlementBatcher.SpendAuth` — every guest spend the batcher
/// emits on the wire was signed here. Field order, name, and version are pinned to the
/// contract; if anything drifts, on-chain `_hashTypedDataV4` recovers a different address and
/// `settle` reverts with `BadSignature`. The contract-side fixtures
/// (`contracts/test/SettlementBatcher.t.sol::test_hashSpendAuthMatchesOffChainComputation`)
/// share the same encoding, and our parity test re-derives it via this module so a typo in
/// either side is caught immediately.

/// Pinned to the constructor of `SettlementBatcher`: `EIP712("SettlementBatcher", "1")`.
/// Bump only in lockstep with the contract — the domain participates in the digest, so any
/// change invalidates every previously-collected signature.
export const SPEND_AUTH_DOMAIN_NAME = "SettlementBatcher";
export const SPEND_AUTH_DOMAIN_VERSION = "1";

/// The exact field list the contract hashes, in the exact order it hashes them. Mirrors
/// `SPEND_AUTH_TYPEHASH` in `SettlementBatcher.sol`. Re-ordering breaks consensus with the
/// chain even if the names are identical, hence the redundant `as const`.
export const SPEND_AUTH_TYPES = {
    SpendAuth: [
        {name: "from", type: "address"},
        {name: "venueId", type: "uint32"},
        {name: "category", type: "uint8"},
        {name: "amount", type: "uint256"},
        {name: "nonce", type: "uint64"},
        {name: "deadline", type: "uint64"},
        {name: "gameTick", type: "uint64"},
    ],
} as const;

/// Off-chain payload. Mirrors the on-chain struct one-for-one. We use `bigint` for every
/// integer field — the uint64 fields would *fit* in a JS number, but mixing `number` and
/// `bigint` in the typed-data tree means viem coerces silently and a future field switch from
/// uint64→uint256 wouldn't surface as a type error. One type, one rule.
export interface SpendAuth {
    from: `0x${string}`;
    venueId: number;
    category: number;
    amount: bigint;
    nonce: bigint;
    deadline: bigint;
    gameTick: bigint;
}

/// EIP-712 domain for the deployed `SettlementBatcher` on a specific chain. `chainId` and
/// `verifyingContract` come from `deployments.json` — see `deployments/index.ts`.
export interface SpendAuthDomain {
    name: typeof SPEND_AUTH_DOMAIN_NAME;
    version: typeof SPEND_AUTH_DOMAIN_VERSION;
    chainId: number;
    verifyingContract: `0x${string}`;
}

/// Build a domain object from the two pieces that vary per deployment. Centralising this means
/// callers can't accidentally use a stale `name` / `version` and produce signatures that
/// silently fail on-chain.
export function spendAuthDomain(chainId: number, verifyingContract: `0x${string}`): SpendAuthDomain {
    if (!Number.isInteger(chainId) || chainId <= 0) {
        throw new Error(`spendAuthDomain: chainId must be a positive integer, got ${chainId}`);
    }
    if (!/^0x[0-9a-fA-F]{40}$/.test(verifyingContract)) {
        throw new Error(`spendAuthDomain: verifyingContract is not a 20-byte hex address: ${verifyingContract}`);
    }
    return {
        name: SPEND_AUTH_DOMAIN_NAME,
        version: SPEND_AUTH_DOMAIN_VERSION,
        chainId,
        verifyingContract,
    };
}

/// Reject malformed inputs at the boundary so the batcher can't accidentally produce a
/// signature that the contract will revert on. The cost (a handful of cheap checks) is
/// negligible next to the secp256k1 sign that follows.
function assertSpendAuth(a: SpendAuth): void {
    if (!/^0x[0-9a-fA-F]{40}$/.test(a.from)) {
        throw new Error(`SpendAuth.from is not a 20-byte hex address: ${a.from}`);
    }
    if (!Number.isInteger(a.venueId) || a.venueId < 0 || a.venueId > 0xffff_ffff) {
        throw new Error(`SpendAuth.venueId out of uint32 range: ${a.venueId}`);
    }
    if (!Number.isInteger(a.category) || a.category < 0 || a.category > 0xff) {
        throw new Error(`SpendAuth.category out of uint8 range: ${a.category}`);
    }
    if (typeof a.amount !== "bigint" || a.amount < 0n) {
        throw new Error(`SpendAuth.amount must be a non-negative bigint: ${String(a.amount)}`);
    }
    // uint256 max — overflow here would be a producer bug. Cheap guard.
    if (a.amount > (1n << 256n) - 1n) {
        throw new Error(`SpendAuth.amount exceeds uint256: ${a.amount.toString()}`);
    }
    const u64Max = (1n << 64n) - 1n;
    for (const [k, v] of [["nonce", a.nonce], ["deadline", a.deadline], ["gameTick", a.gameTick]] as const) {
        if (typeof v !== "bigint" || v < 0n || v > u64Max) {
            throw new Error(`SpendAuth.${k} out of uint64 range: ${String(v)}`);
        }
    }
}

/// Compute the EIP-712 digest the contract will compare against. Mirrors
/// `SettlementBatcher.hashSpendAuth(...)`. Cheap (no signing) — useful for tests, debug logs,
/// and the metrics path if we ever want to deduplicate by digest.
export function hashSpendAuth(domain: SpendAuthDomain, auth: SpendAuth): Hex {
    assertSpendAuth(auth);
    return hashTypedData({
        domain,
        types: SPEND_AUTH_TYPES,
        primaryType: "SpendAuth",
        message: auth,
    });
}

/// Sign a `SpendAuth` as the given account. The account is expected to be the guest's
/// `HDAccount` from `deriveGuest` — its `signTypedData` produces a 65-byte `r || s || v` hex
/// string suitable for `SettlementBatcher.settle(auths, sigs)`.
///
/// Throws synchronously on a malformed `auth` (so the batcher never queues a signature it
/// already knows the contract will reject). The actual sign is async because viem accounts
/// expose async signing primitives — most local accounts resolve in a single tick, but we keep
/// the contract async so a future hardware-signer / worker-thread path needs no changes here.
export async function signSpendAuth(
    account: LocalAccount,
    domain: SpendAuthDomain,
    auth: SpendAuth,
): Promise<Hex> {
    assertSpendAuth(auth);
    if (auth.from.toLowerCase() !== account.address.toLowerCase()) {
        // The contract's recovery check (`recovered != a.from`) would reject this anyway, but
        // catching it here turns a wasted submit + revert into a developer error during
        // batching.
        throw new Error(
            `signSpendAuth: account ${account.address} cannot sign for from=${auth.from}`,
        );
    }
    return account.signTypedData({
        domain,
        types: SPEND_AUTH_TYPES,
        primaryType: "SpendAuth",
        message: auth,
    });
}

/// Recover the signer of a `SpendAuth` signature. Wraps viem's `recoverTypedDataAddress` with
/// our pinned types/domain so callers can't accidentally validate against a drifted shape.
/// Used by tests today; in production the chain itself does the recovery.
export async function recoverSpendAuthSigner(
    domain: SpendAuthDomain,
    auth: SpendAuth,
    signature: Hex,
): Promise<`0x${string}`> {
    return recoverTypedDataAddress({
        domain,
        types: SPEND_AUTH_TYPES,
        primaryType: "SpendAuth",
        message: auth,
        signature,
    });
}
