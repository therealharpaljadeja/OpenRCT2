/// Minimal ABI fragments used by the M2.5 chain layer. We hand-roll these rather than
/// importing the full Foundry artifacts because:
///   1. Only a few selectors are touched (balanceOf, decimals, totalSupply, dripPark, dripMon).
///   2. Foundry artifacts aren't installed by `npm ci` — the sidecar would have to grow a
///      build-step dependency on the contracts package, which we want to avoid.
///   3. viem's `parseAbi` / inline-tuple syntax keeps these readable inline.
///
/// If a contract surface ever expands meaningfully, switch to importing the generated
/// `viem`-style ABI from `contracts/out/<Name>.sol/<Name>.json` via the build pipeline.

import {parseAbi} from "viem";

export const PARK_TOKEN_ABI = parseAbi([
    "function balanceOf(address account) view returns (uint256)",
    "function decimals() view returns (uint8)",
    "function totalSupply() view returns (uint256)",
]);

export const FAUCET_ABI = parseAbi([
    "function dripPark(address to, uint256 amount)",
    "function dripMon(address[] calldata addrs, uint256[] calldata amts) payable",
    "function owner() view returns (address)",
]);

/// `SettlementBatcher.settle(SpendAuth[], bytes[])` — the only function the relayer pool ever
/// calls on this contract. The struct shape mirrors `OpenRCT2/contracts/src/SettlementBatcher.sol`
/// 1:1 (same field order; any drift would change the function selector and break submission).
export const SETTLEMENT_BATCHER_ABI = parseAbi([
    "struct SpendAuth { address from; uint32 venueId; uint8 category; uint256 amount; uint64 nonce; uint64 deadline; uint64 gameTick; }",
    "function settle(SpendAuth[] auths, bytes[] sigs)",
]);
