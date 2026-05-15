// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test, Vm} from "forge-std/Test.sol";
import {console2} from "forge-std/console2.sol";
import {ParkToken} from "../src/ParkToken.sol";
import {VenueRegistry} from "../src/VenueRegistry.sol";
import {SettlementBatcher} from "../src/SettlementBatcher.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/// @notice Gas benchmark for `SettlementBatcher.settle(N)` at N ∈ {64, 128, 256, 512}.
///         Drives the default `BATCH_MAX_SIZE` chosen by the sidecar (M3.2) and the
///         throughput math in `OpenRCT2/ONCHAIN_PLAN.md` §4.3.
///
/// Run with:
///     forge test --match-contract SettlementBatcherGas -vvv
contract SettlementBatcherGasTest is Test {
    ParkToken token;
    VenueRegistry registry;
    SettlementBatcher batcher;

    address tokenOwner = address(0xA);
    address registryOwner = address(0xB);
    address minter = address(0xC);

    uint32 constant RIDE_ID = 7;
    address rideTill;

    function setUp() public {
        token = new ParkToken(tokenOwner);
        vm.prank(tokenOwner);
        token.setMinter(minter, true);

        registry = new VenueRegistry(registryOwner);
        batcher = new SettlementBatcher(IERC20(address(token)), registry);

        vm.prank(registryOwner);
        rideTill = registry.register(RIDE_ID, VenueRegistry.VenueKind.Ride, "Wooden RC", "rct2.ride.wmouse");
    }

    // ---------------------------------------------------------------------------
    // Benchmarks
    // ---------------------------------------------------------------------------

    function test_gas_settle_64() public {
        _bench(64);
    }

    function test_gas_settle_128() public {
        _bench(128);
    }

    function test_gas_settle_256() public {
        _bench(256);
    }

    function test_gas_settle_512() public {
        _bench(512);
    }

    // ---------------------------------------------------------------------------
    // Internals
    // ---------------------------------------------------------------------------

    /// @dev Build N unique guests, mint+approve, sign N `SpendAuth`s, call `settle`, and log
    ///      the resulting gas (and calldata size) so the sidecar can pick a default batch size
    ///      that fits comfortably under the Monad block gas limit.
    function _bench(uint256 n) internal {
        // Stable, deterministic guest keys — derivation matches what the sidecar's HD path will
        // produce in shape (one key per guest); the actual derivation algorithm is irrelevant
        // here because the contract only sees `(from, sig)`.
        uint256[] memory pks = new uint256[](n);
        address[] memory guests = new address[](n);
        for (uint256 i; i < n; ++i) {
            // Avoid pk == 0 / pk >= curve order by masking + nudging to a known-good range.
            uint256 pk = uint256(keccak256(abi.encode("rct2.gas.bench", i))) >> 1;
            if (pk == 0) pk = 1;
            pks[i] = pk;
            guests[i] = vm.addr(pk);
        }

        // Fund + approve. Foundry doesn't charge for cheatcode setup against gas measurement,
        // but we still want this loop separated cleanly from the metered call below.
        vm.startPrank(minter);
        for (uint256 i; i < n; ++i) {
            token.mint(guests[i], 1_000e18);
        }
        vm.stopPrank();
        for (uint256 i; i < n; ++i) {
            vm.prank(guests[i]);
            token.approve(address(batcher), type(uint256).max);
        }

        // Build the batch.
        SettlementBatcher.SpendAuth[] memory auths = new SettlementBatcher.SpendAuth[](n);
        bytes[] memory sigs = new bytes[](n);
        uint64 deadline = uint64(block.timestamp + 1 hours);
        for (uint256 i; i < n; ++i) {
            auths[i] = SettlementBatcher.SpendAuth({
                from: guests[i],
                venueId: RIDE_ID,
                category: 1,
                amount: 1e18,
                nonce: 0,
                deadline: deadline,
                gameTick: uint64(i)
            });
            sigs[i] = _sign(pks[i], auths[i]);
        }

        // Approximate calldata size: 4 (selector) + 64 (offsets) + per-element overhead.
        // We can compute exactly via abi.encodeCall.
        uint256 calldataBytes = abi.encodeCall(SettlementBatcher.settle, (auths, sigs)).length;

        batcher.settle(auths, sigs);
        Vm.Gas memory g = vm.lastCallGas();
        uint256 used = uint256(g.gasTotalUsed);
        // Use mGas (gas × 1000) for per-auth precision below 1 gas.
        uint256 mGasPerAuth = (used * 1000) / n;
        uint256 mBytesPerAuth = (calldataBytes * 1000) / n;

        console2.log("=== settle(N) gas benchmark ===");
        console2.log("  N                       :", n);
        console2.log("  total gas               :", used);
        console2.log("  gas / auth (x1000)      :", mGasPerAuth);
        console2.log("  calldata bytes          :", calldataBytes);
        console2.log("  calldata / auth (x1000) :", mBytesPerAuth);
        // Auths/sec at 1 block/sec, assuming a 100M-gas block reserved entirely for batchers.
        // Real Monad blocks have a higher limit (and a sidecar relayer pool of N writes per
        // block), so this is a *floor* on per-relayer throughput.
        console2.log("  auths / 100M-gas budget :", uint256(100_000_000) / (mGasPerAuth / 1000));

        // Sanity: every auth landed.
        assertEq(batcher.sigNonces(guests[0]), 1);
        assertEq(batcher.sigNonces(guests[n - 1]), 1);
        assertEq(token.balanceOf(rideTill), n * 1e18);

        // Regression guard: per-auth gas should stay ~flat as N scales (no quadratic creep).
        // 64k mGas/auth = 64 gas/auth at the boundary — a generous ceiling well above the
        // ~43k gas/auth we observe today; this trips only on a real algorithmic regression.
        assertLt(mGasPerAuth, 64_000_000, "gas/auth regressed");
    }

    function _sign(uint256 pk, SettlementBatcher.SpendAuth memory a) internal view returns (bytes memory) {
        bytes32 structHash = keccak256(
            abi.encode(
                batcher.SPEND_AUTH_TYPEHASH(), a.from, a.venueId, a.category, a.amount, a.nonce, a.deadline, a.gameTick
            )
        );
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", batcher.domainSeparator(), structHash));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, digest);
        return abi.encodePacked(r, s, v);
    }
}
