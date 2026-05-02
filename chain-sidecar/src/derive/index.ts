import {mnemonicToAccount, type HDAccount} from "viem/accounts";

/// HD derivation off the park master mnemonic. M2.2 lands the basic derivation surface and the
/// relayer pool; M2.3 adds an address cache so the batcher can attach a guest's address without
/// re-deriving on every spend.
///
/// BIP-44 path layout (`OpenRCT2/ONCHAIN_PLAN.md` §2.1):
///
///   m / 44' / 60' / 0' / change / index
///                       ^^^^^^^   ^^^^^
///                       0=guest   guestIdx (M2.3+)
///                       1=relayer relayerIdx (this milestone)
///
/// Splitting guests and relayers under different `change` indices means a guest and a relayer
/// can never share an address by accident, and a future role (e.g. dedicated faucet drainer)
/// can claim its own change index without colliding.

export const CHANGE_GUEST = 0;
export const CHANGE_RELAYER = 1;

export interface DerivedAccount {
    /// HD path relative to the park master mnemonic — useful for explorer / debug.
    path: string;
    address: `0x${string}`;
    account: HDAccount;
}

/// Derive a single guest account. Index 0..N-1 maps to the game's `Guest::HdIndex`.
export function deriveGuest(mnemonic: string, index: number): DerivedAccount {
    if (!Number.isInteger(index) || index < 0) throw new Error(`invalid guest index: ${index}`);
    const account = mnemonicToAccount(mnemonic, {
        accountIndex: 0,
        changeIndex: CHANGE_GUEST,
        addressIndex: index,
    });
    return {path: `m/44'/60'/0'/${CHANGE_GUEST}/${index}`, address: account.address, account};
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
