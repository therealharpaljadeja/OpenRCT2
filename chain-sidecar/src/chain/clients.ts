import {createPublicClient, createWalletClient, http, type Chain, type PublicClient, type WalletClient} from "viem";
import {privateKeyToAccount} from "viem/accounts";

/// Build a viem `Chain` config for whatever testnet / mainnet the sidecar is pointed at.
/// We don't import a pre-baked `monadTestnet` from `viem/chains` because the sidecar should
/// follow `deployments.json`'s `chainId` — that artifact is the source of truth for "which
/// chain are we deployed to" and we don't want to fight a hard-coded chain object if Monad's
/// official chainId ever shifts on testnet.
export function makeChain(chainId: number, rpcUrl: string): Chain {
    return {
        id: chainId,
        // Display-only — Monad testnet is 10143; we surface a neutral name so the same builder
        // works for any future EVM testnet (anvil, Holesky, etc.) without confusing the logs.
        name: chainId === 10143 ? "Monad Testnet" : `chain-${chainId}`,
        nativeCurrency: {name: "MON", symbol: "MON", decimals: 18},
        rpcUrls: {default: {http: [rpcUrl]}},
    };
}

/// One-shot factory for the read-side. The sidecar holds a single `PublicClient` for the
/// life of the process — viem keeps the underlying HTTP transport keep-alive'd so per-call
/// overhead is negligible.
export function makePublicClient(chainId: number, rpcUrl: string): PublicClient {
    const chain = makeChain(chainId, rpcUrl);
    return createPublicClient({chain, transport: http(rpcUrl)});
}

/// Wallet client for the Faucet owner. The faucet owner is the contract deployer EOA on
/// Monad testnet (see `contracts/deployments/monad-testnet.json#deployer`); its key has to
/// be supplied out-of-band because it's not derivable from the park's master mnemonic
/// (would require redeploying with a derived owner).
export function makeFaucetOwnerClient(
    chainId: number,
    rpcUrl: string,
    privateKey: `0x${string}`,
): WalletClient {
    const chain = makeChain(chainId, rpcUrl);
    const account = privateKeyToAccount(privateKey);
    return createWalletClient({chain, transport: http(rpcUrl), account});
}
