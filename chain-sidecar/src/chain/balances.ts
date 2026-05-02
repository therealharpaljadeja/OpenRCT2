import type {PublicClient} from "viem";
import {PARK_TOKEN_ABI} from "./abis.js";

/// Read-only view of on-chain balances. Pulled out as an interface so the top-up loop and
/// `chain.balances` JSON-RPC handler can be unit-tested against a hand-rolled mock without
/// standing up a real RPC endpoint. The viem-backed implementation lives below.
export interface BalanceReader {
    /// Native MON balance in wei (1 MON = 1e18 wei). Used to gate relayer top-ups.
    nativeBalance(addr: `0x${string}`): Promise<bigint>;
    /// PARK ERC-20 balance. PARK is 18-decimals.
    parkBalance(addr: `0x${string}`): Promise<bigint>;
    /// Convenience for the status surface — single round-trip to fetch every native balance.
    /// We don't currently parallelize via `multicall` because Monad's `eth_call` throughput
    /// under our scale (≤16 relayers + 1 treasury) is already negligible.
    nativeBalances(addrs: readonly `0x${string}`[]): Promise<bigint[]>;
}

export interface BalanceReaderOptions {
    publicClient: PublicClient;
    parkToken: `0x${string}`;
}

export function createBalanceReader(opts: BalanceReaderOptions): BalanceReader {
    const {publicClient, parkToken} = opts;
    return {
        nativeBalance: (addr) => publicClient.getBalance({address: addr}),
        parkBalance: (addr) =>
            publicClient.readContract({
                address: parkToken,
                abi: PARK_TOKEN_ABI,
                functionName: "balanceOf",
                args: [addr],
            }) as Promise<bigint>,
        nativeBalances: async (addrs) => {
            // Promise.all is fine — viem batches these onto the keep-alive socket. If we
            // outgrow that, switch to a Multicall3 read; the on-chain Multicall is on Monad
            // testnet too.
            return Promise.all(addrs.map((a) => publicClient.getBalance({address: a})));
        },
    };
}
