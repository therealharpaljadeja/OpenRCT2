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
    "function approve(address spender, uint256 amount) returns (bool)",
    "function allowance(address owner, address spender) view returns (uint256)",
    "function nonces(address owner) view returns (uint256)",
    "function permit(address owner, address spender, uint256 value, uint256 deadline, uint8 v, bytes32 r, bytes32 s)",
    "function transfer(address to, uint256 amount) returns (bool)",
    "function transferFrom(address from, address to, uint256 amount) returns (bool)",
]);

/// `Disperse.disperseToken(IERC20, address[], uint256[])` — funder uses this via
/// `ParkTreasury.execute` to fan PARK out to many guest wallets in one tx.
export const DISPERSE_ABI = parseAbi([
    "function disperseToken(address token, address[] addrs, uint256[] amts)",
    "function disperseEther(address[] addrs, uint256[] amts) payable",
]);

/// `ParkTreasury.execute` — owner-only wrapper that lets the deployer EOA call any function on
/// any contract while the treasury appears as `msg.sender`. M3.5's funder uses this to make
/// the treasury approve Disperse and to drive `disperseToken` off the treasury's PARK balance.
export const PARK_TREASURY_ABI = parseAbi([
    "function execute(address target, uint256 value, bytes data) returns (bytes)",
    "function executeBatch(address[] targets, uint256[] values, bytes[] datas) returns (bytes[])",
    "function addOperator(address op)",
    "function removeOperator(address op)",
    "function operators(address op) view returns (bool)",
    // `execute` wraps inner-call reverts as `CallFailed(bytes)`. The decoder unwraps this
    // recursively against `KNOWN_REVERT_ERRORS_ABI` so the inner ERC20InsufficientBalance /
    // ERC20InsufficientAllowance / etc. surfaces in the log.
    "error CallFailed(bytes result)",
    "error NotOwnerOrOperator(address caller)",
    "error ZeroOperator()",
]);

/// OpenZeppelin v5 ERC20 + Ownable + Permit custom errors. Most reverts the funder /
/// permits / sweeper / faucet paths see come from one of these, wrapped inside
/// `CallFailed(bytes)` from the treasury hop. Pulled into their own bundle so the decoder
/// can unwrap a `CallFailed` payload recursively without re-walking unrelated error decls.
export const ERC20_ERRORS_ABI = parseAbi([
    "error ERC20InsufficientBalance(address sender, uint256 balance, uint256 needed)",
    "error ERC20InsufficientAllowance(address spender, uint256 allowance, uint256 needed)",
    "error ERC20InvalidApprover(address approver)",
    "error ERC20InvalidSpender(address spender)",
    "error ERC20InvalidReceiver(address receiver)",
    "error ERC20InvalidSender(address sender)",
    "error ERC2612ExpiredSignature(uint256 deadline)",
    "error ERC2612InvalidSigner(address signer, address owner)",
    "error OwnableUnauthorizedAccount(address account)",
    "error OwnableInvalidOwner(address owner)",
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
    "function sigNonces(address guest) view returns (uint64)",
    "error LengthMismatch()",
    "error EmptyBatch()",
    "error DeadlineExpired(uint256 index)",
    "error BadNonce(uint256 index, uint64 expected, uint64 got)",
    "error BadSignature(uint256 index)",
    "error VenueNotRegistered(uint256 index, uint32 venueId)",
    "error VenueInactive(uint256 index, uint32 venueId)",
]);

/// Faucet custom errors. Surfaces in dripPark / dripMon paths.
export const FAUCET_ERRORS_ABI = parseAbi([
    "error LengthMismatch()",
    "error InsufficientMonBalance()",
    "error TransferFailed()",
]);

/// `VenueRegistry` — owner-only catalog mirrored by M3.8. Selectors pinned to the deployed
/// contract: register / rename / remove are write entrypoints; `venues` / `venueCount` /
/// `venueIdAt` / `subAccountOf` are reads used for cache hydration on restart.
export const VENUE_REGISTRY_ABI = parseAbi([
    "function register(uint32 id, uint8 kind, string name, string objectType) returns (address subAccount)",
    "function rename(uint32 id, string newName)",
    "function remove(uint32 id)",
    "function retarget(uint32 id, address newSubAccount)",
    "function venues(uint32 id) view returns (uint32, uint8, string, string, address, uint64, bool)",
    "function venueCount() view returns (uint256)",
    "function venueIdAt(uint256 idx) view returns (uint32)",
    "function subAccountOf(uint32 id) view returns (address)",
    "function exists(uint32 id) view returns (bool)",
    // Idempotent-revert errors. Declared here so viem's revert decoder reports them by name
    // (instead of the raw 4-byte selector), letting `isAlreadyAppliedError` classify the three
    // recoverable mirror cases as `skippedAlreadyApplied` rather than `rpcErrors`.
    "error AlreadyRegistered()",
    "error NotRegistered()",
    "error AlreadyInactive()",
]);
