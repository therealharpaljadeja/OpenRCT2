import {mnemonicToAccount, type HDAccount} from "viem/accounts";

/// HD derivation off the park master mnemonic. M2.2 lands the basic derivation surface and the
/// relayer pool; M2.3 adds an address cache so the batcher can attach a guest's address without
/// re-deriving on every spend; M3.14 adds the operator role for per-subsystem admin EOAs.
///
/// BIP-44 path layout (`OpenRCT2/ONCHAIN_PLAN.md` §2.1):
///
///   m / 44' / 60' / 0' / change / index
///                       ^^^^^^^   ^^^^^
///                       0=guest    guestIdx (M2.3+)
///                       1=relayer  relayerIdx (M2.2)
///                       2=operator opIdx (M3.14 — funder/permits/sweeper)
///
/// Splitting roles under different `change` indices means addresses across roles can never
/// collide by accident. M3.14 adds the operator role: a small set of EOAs (one per high-volume
/// admin subsystem) authorized by `ParkTreasury.addOperator(...)` to call `execute` /
/// `executeBatch` without contending on the deployer's nonce sequence. Funder = idx 0,
/// permits = idx 1, sweeper = idx 2 (mirrors the `OPERATOR_*` enum below).

export const CHANGE_GUEST = 0;
export const CHANGE_RELAYER = 1;
export const CHANGE_OPERATOR = 2;

export interface DerivedAccount {
    /// HD path relative to the park master mnemonic — useful for explorer / debug.
    path: string;
    address: `0x${string}`;
    account: HDAccount;
}

/// Per-session guest namespace. The BIP-44 `accountIndex` is hardened (0..2^31-1); we
/// fold the session id into it so two sessions with distinct ids derive disjoint guest
/// trees from the same mnemonic. Sessions widths are 16 bits today (see `session/`),
/// well within the hardened range.
export interface DeriveGuestOptions {
    /// BIP-44 account index. Defaults to 0, which preserves the pre-session HD derivation
    /// (Hardhat default at idx 0 → `0xf39F…2266`) so legacy tests and external derivation
    /// callers keep their existing addresses unchanged.
    accountIndex?: number;
}

/// Derive a single guest account. Index 0..N-1 maps to the game's `Guest::HdIndex`.
/// When `accountIndex` is set, the derivation path becomes `m/44'/60'/<accountIndex>'/0/<index>`
/// so two sessions with distinct account indices yield disjoint guest addresses.
export function deriveGuest(mnemonic: string, index: number, opts: DeriveGuestOptions = {}): DerivedAccount {
    if (!Number.isInteger(index) || index < 0) throw new Error(`invalid guest index: ${index}`);
    const accountIndex = opts.accountIndex ?? 0;
    if (!Number.isInteger(accountIndex) || accountIndex < 0) {
        throw new Error(`invalid guest accountIndex: ${accountIndex}`);
    }
    const account = mnemonicToAccount(mnemonic, {
        accountIndex,
        changeIndex: CHANGE_GUEST,
        addressIndex: index,
    });
    return {
        path: `m/44'/60'/${accountIndex}'/${CHANGE_GUEST}/${index}`,
        address: account.address,
        account,
    };
}

/// Derive a single relayer account. The pool is treasury-funded and pays gas for batched
/// `SettlementBatcher.settle` submissions (§4.3).
export function deriveRelayer(mnemonic: string, index: number): DerivedAccount {
    if (!Number.isInteger(index) || index < 0) throw new Error(`invalid relayer index: ${index}`);
    const account = mnemonicToAccount(mnemonic, {
        accountIndex: 0,
        changeIndex: CHANGE_RELAYER,
        addressIndex: index,
    });
    return {path: `m/44'/60'/0'/${CHANGE_RELAYER}/${index}`, address: account.address, account};
}

/// Materialize the relayer pool. The plan recommends 8–16; sub-1 makes no sense and >32 has
/// no use case (one in-flight `eth_sendRawTransactionSync` per relayer is the bottleneck).
export const MIN_RELAYER_COUNT = 1;
export const MAX_RELAYER_COUNT = 32;
export const DEFAULT_RELAYER_COUNT = 8;

export function relayerPool(mnemonic: string, count: number): DerivedAccount[] {
    if (!Number.isInteger(count) || count < MIN_RELAYER_COUNT || count > MAX_RELAYER_COUNT) {
        throw new Error(
            `relayer count must be an integer in [${MIN_RELAYER_COUNT}, ${MAX_RELAYER_COUNT}], got ${count}`,
        );
    }
    const out: DerivedAccount[] = [];
    for (let i = 0; i < count; i++) out.push(deriveRelayer(mnemonic, i));
    return out;
}

/// M3.14 — per-subsystem operator EOAs. Each high-volume admin subsystem (funder, permit
/// collector, sweeper) gets its own key so the three can submit `treasury.execute` /
/// `executeBatch` calls in parallel without colliding on a single shared deployer-nonce
/// sequence. Authorized on chain via `ParkTreasury.addOperator(addr)` once at sidecar boot.
///
/// The role enum is the canonical name → idx mapping; consumers should use these constants
/// instead of magic numbers so a future re-shuffle (e.g. inserting a "lendingPool" operator)
/// only touches this file.
export const OPERATOR_FUNDER = 0;
export const OPERATOR_PERMITS = 1;
export const OPERATOR_SWEEPER = 2;
export const OPERATOR_COUNT = 3;

export function deriveOperator(mnemonic: string, index: number): DerivedAccount {
    if (!Number.isInteger(index) || index < 0) throw new Error(`invalid operator index: ${index}`);
    const account = mnemonicToAccount(mnemonic, {
        accountIndex: 0,
        changeIndex: CHANGE_OPERATOR,
        addressIndex: index,
    });
    return {path: `m/44'/60'/0'/${CHANGE_OPERATOR}/${index}`, address: account.address, account};
}

/// Materialize all three operator accounts in canonical order. The returned array maps
/// `OPERATOR_FUNDER` → idx 0, etc. so callers can index by role constant.
export function operatorPool(mnemonic: string): DerivedAccount[] {
    const out: DerivedAccount[] = [];
    for (let i = 0; i < OPERATOR_COUNT; i++) out.push(deriveOperator(mnemonic, i));
    return out;
}
