import type {PublicClient, WalletClient} from "viem";
import {FAUCET_ABI} from "./abis.js";

/// Owner-side write surface for the Faucet contract. The faucet's `dripPark` and `dripMon`
/// functions are `onlyOwner`, so the wallet client backing this writer must be the deployer
/// EOA. Pulled out as an interface so orchestration logic (`parkLaunchSetup`, `RelayerTopUp`)
/// can be unit-tested against an in-memory mock that records what *would* have been called.
export interface FaucetWriter {
    /// Mints PARK to the recipient (typically the park treasury). Returns the tx hash so
    /// the caller can correlate with explorer + receipt polling.
    dripPark(to: `0x${string}`, amount: bigint): Promise<`0x${string}`>;
    /// Distributes MON in one call to a list of recipients. Used both at park launch
    /// (every relayer in one tx) and during ongoing top-up (only the under-threshold subset).
    dripMon(addrs: readonly `0x${string}`[], amounts: readonly bigint[]): Promise<`0x${string}`>;
}

export interface FaucetWriterOptions {
    walletClient: WalletClient;
    publicClient: PublicClient;
    faucetAddress: `0x${string}`;
}

export function createFaucetWriter(opts: FaucetWriterOptions): FaucetWriter {
    const {walletClient, publicClient, faucetAddress} = opts;
    if (!walletClient.account) {
        throw new Error("createFaucetWriter: walletClient missing account — pass a key-bound client");
    }
    const account = walletClient.account;
    return {
        dripPark: async (to, amount) => {
            const {request} = await publicClient.simulateContract({
                address: faucetAddress,
                abi: FAUCET_ABI,
                functionName: "dripPark",
                args: [to, amount],
                account,
            });
            return walletClient.writeContract(request);
        },
        dripMon: async (addrs, amounts) => {
            if (addrs.length !== amounts.length) {
                throw new Error(`dripMon: addrs/amounts length mismatch (${addrs.length} vs ${amounts.length})`);
            }
            if (addrs.length === 0) throw new Error("dripMon: empty recipient list");
            const {request} = await publicClient.simulateContract({
                address: faucetAddress,
                abi: FAUCET_ABI,
                functionName: "dripMon",
                args: [addrs as readonly `0x${string}`[], amounts as readonly bigint[]],
                account,
            });
            return walletClient.writeContract(request);
        },
    };
}

export interface ParkLaunchOptions {
    treasury: `0x${string}`;
    relayers: readonly `0x${string}`[];
    /// PARK to mint into the treasury. Wei-style (18 decimals). Plan §2.3 calls for "real
    /// observable balance" so this should be sized to fund initial guest entries; pick a
    /// number large enough that disperseToken at park launch doesn't run dry.
    parkAmount: bigint;
    /// MON to seed each relayer with at park launch. Plan §4.3 sizes the pool at 8–16
    /// relayers × ~0.05 MON/relayer for a safe starting margin.
    monPerRelayer: bigint;
}

/// One-shot park-launch funding flow. PARK is dripped first so the treasury is solvent
/// before the very first guest enters; MON is dripped second so relayers can start
/// submitting batches immediately. Each step is its own tx — keeps recovery simple if one
/// side fails (rerun this function; `dripPark` is idempotent in effect — extra mint just
/// boosts the balance).
export async function parkLaunchSetup(faucet: FaucetWriter, opts: ParkLaunchOptions): Promise<{
    parkTx: `0x${string}`;
    monTx: `0x${string}`;
}> {
    const parkTx = await faucet.dripPark(opts.treasury, opts.parkAmount);
    const amounts = opts.relayers.map(() => opts.monPerRelayer);
    const monTx = await faucet.dripMon(opts.relayers, amounts);
    return {parkTx, monTx};
}
