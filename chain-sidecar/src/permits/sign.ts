import {hashTypedData, parseSignature, recoverTypedDataAddress, type Hex} from "viem";
import type {LocalAccount} from "viem/accounts";

/// EIP-2612 Permit signer (plan §2.3 / M3.6).
///
/// Each guest signs a Permit at park entry granting the SettlementBatcher unlimited PARK
/// allowance off-chain — no per-spend approval tx. The collector packs N of these signatures
/// into one `treasury.executeBatch([parkToken.permit(...)] × N)` and submits via the deployer
/// EOA. After this lands, `transferFrom(guest, venueSubAccount, amount)` inside `settle` works
/// for that guest forever (until they exit and we sweep — M3.7).
///
/// Domain pinning: ParkToken extends OZ's ERC20Permit which constructs `EIP712(name, "1")` with
/// the token's name. ParkToken passes `"Park"` (see `contracts/src/ParkToken.sol:23`), so the
/// off-chain domain is `{name: "Park", version: "1", chainId, verifyingContract: parkToken}`.
/// Drift on either side breaks recovery and surfaces as `ERC2612InvalidSigner` on chain.

export const PARK_PERMIT_DOMAIN_NAME = "Park";
export const PARK_PERMIT_DOMAIN_VERSION = "1";

/// EIP-2612 Permit type list. Order and types are pinned to `ERC20Permit.PERMIT_TYPEHASH`:
///   keccak256("Permit(address owner,address spender,uint256 value,uint256 nonce,uint256 deadline)")
export const PERMIT_TYPES = {
    Permit: [
        {name: "owner", type: "address"},
        {name: "spender", type: "address"},
        {name: "value", type: "uint256"},
        {name: "nonce", type: "uint256"},
        {name: "deadline", type: "uint256"},
    ],
} as const;

export interface PermitDomain {
    name: typeof PARK_PERMIT_DOMAIN_NAME;
    version: typeof PARK_PERMIT_DOMAIN_VERSION;
    chainId: number;
    verifyingContract: `0x${string}`;
}

/// What the guest signs. `nonce` is `parkToken.nonces(owner)` at signing time — for fresh
/// guests this is always 0; for any guest who's permitted before (e.g. recovery / re-permit
/// flow) it must match the on-chain counter exactly or `permit` reverts with InvalidSigner.
export interface PermitArgs {
    owner: `0x${string}`;
    spender: `0x${string}`;
    value: bigint;
    nonce: bigint;
    deadline: bigint;
}

/// What the collector buffers — the args that eventually get encoded as
/// `parkToken.permit(owner, spender, value, deadline, v, r, s)`. We split the 65-byte sig
/// here once so the flush path doesn't have to re-decode N signatures on the hot path.
export interface SignedPermit {
    args: PermitArgs;
    v: number;
    r: Hex;
    s: Hex;
    /// Original 65-byte sig — kept for tests and for any future "audit log" path. Production
    /// flush only consumes (v, r, s).
    signature: Hex;
}

export function permitDomain(chainId: number, parkToken: `0x${string}`): PermitDomain {
    if (!Number.isInteger(chainId) || chainId <= 0) {
        throw new Error(`permitDomain: chainId must be a positive integer, got ${chainId}`);
    }
    if (!/^0x[0-9a-fA-F]{40}$/.test(parkToken)) {
        throw new Error(`permitDomain: parkToken is not a 20-byte hex address: ${parkToken}`);
    }
    return {
        name: PARK_PERMIT_DOMAIN_NAME,
        version: PARK_PERMIT_DOMAIN_VERSION,
        chainId,
        verifyingContract: parkToken,
    };
}

/// Reject malformed args at the boundary so we never queue a sig the contract will revert on.
function assertPermitArgs(a: PermitArgs): void {
    for (const [k, v] of [["owner", a.owner], ["spender", a.spender]] as const) {
        if (!/^0x[0-9a-fA-F]{40}$/.test(v)) {
            throw new Error(`PermitArgs.${k} is not a 20-byte hex address: ${v}`);
        }
    }
    const u256Max = (1n << 256n) - 1n;
    for (const [k, v] of [
        ["value", a.value],
        ["nonce", a.nonce],
        ["deadline", a.deadline],
    ] as const) {
        if (typeof v !== "bigint" || v < 0n || v > u256Max) {
            throw new Error(`PermitArgs.${k} out of uint256 range: ${String(v)}`);
        }
    }
}

/// Compute the EIP-712 digest the contract will compare against. Useful in tests, debug logs,
/// and a future "dedupe by digest" optimization. Cheap — no signing.
export function hashPermit(domain: PermitDomain, args: PermitArgs): Hex {
    assertPermitArgs(args);
    return hashTypedData({
        domain,
        types: PERMIT_TYPES,
        primaryType: "Permit",
        message: args,
    });
}

/// Sign a Permit as `account` and split the 65-byte sig into (v, r, s) so the collector can
/// hand them straight to `parkToken.permit(...)` calldata without re-parsing per submit.
/// Validates that `args.owner` matches the signing account; mismatch is a producer bug we
/// catch here rather than letting the chain reject with `ERC2612InvalidSigner`.
export async function signPermit(
    account: LocalAccount,
    domain: PermitDomain,
    args: PermitArgs,
): Promise<SignedPermit> {
    assertPermitArgs(args);
    if (args.owner.toLowerCase() !== account.address.toLowerCase()) {
        throw new Error(
            `signPermit: account ${account.address} cannot sign for owner=${args.owner}`,
        );
    }
    const signature = await account.signTypedData({
        domain,
        types: PERMIT_TYPES,
        primaryType: "Permit",
        message: args,
    });
    // viem's `parseSignature` returns the v/r/s split; v is normalised to 27/28.
    const {v, r, s} = parseSignature(signature);
    if (v === undefined) {
        // viem can return `yParity` only on EIP-2098 compact sigs. ERC-2612's permit needs
        // the legacy v in [27, 28]; fail loud rather than guess.
        throw new Error("signPermit: viem returned no v component (compact sig?) — incompatible with permit");
    }
    return {
        args,
        v: Number(v),
        r,
        s,
        signature,
    };
}

/// Recover the address that signed a permit. Production never calls this — the chain does the
/// recovery — but tests need it to verify the sig is valid before we even try to submit.
export async function recoverPermitSigner(
    domain: PermitDomain,
    args: PermitArgs,
    signature: Hex,
): Promise<`0x${string}`> {
    return recoverTypedDataAddress({
        domain,
        types: PERMIT_TYPES,
        primaryType: "Permit",
        message: args,
        signature,
    });
}
