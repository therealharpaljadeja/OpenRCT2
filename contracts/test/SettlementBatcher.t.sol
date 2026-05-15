// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";
import {ParkToken} from "../src/ParkToken.sol";
import {VenueRegistry} from "../src/VenueRegistry.sol";
import {SettlementBatcher} from "../src/SettlementBatcher.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

contract SettlementBatcherTest is Test {
    ParkToken token;
    VenueRegistry registry;
    SettlementBatcher batcher;

    address tokenOwner = address(0xA);
    address registryOwner = address(0xB);
    address minter = address(0xC);

    // Guests with known private keys so we can sign typed-data.
    uint256 aliPk = 0xA11CE;
    uint256 bobPk = 0xB0B;
    uint256 carPk = 0xCA70;
    address ali;
    address bob;
    address car;

    uint32 constant RIDE_ID = 7;
    uint32 constant SHOP_ID = 8;
    uint32 constant DEMOLISHED_ID = 9;
    address rideTill;
    address shopTill;
    address demolishedTill;

    function setUp() public {
        token = new ParkToken(tokenOwner);
        vm.prank(tokenOwner);
        token.setMinter(minter, true);

        registry = new VenueRegistry(registryOwner);
        batcher = new SettlementBatcher(IERC20(address(token)), registry);

        vm.startPrank(registryOwner);
        rideTill = registry.register(RIDE_ID, VenueRegistry.VenueKind.Ride, "Wooden RC", "rct2.ride.wmouse");
        shopTill = registry.register(SHOP_ID, VenueRegistry.VenueKind.Shop, "Burger Bar", "rct2.shop.burgb");
        demolishedTill = registry.register(DEMOLISHED_ID, VenueRegistry.VenueKind.Stall, "Old Stall", "rct2.stall.x");
        registry.remove(DEMOLISHED_ID);
        vm.stopPrank();

        ali = vm.addr(aliPk);
        bob = vm.addr(bobPk);
        car = vm.addr(carPk);

        vm.startPrank(minter);
        token.mint(ali, 1_000e18);
        token.mint(bob, 1_000e18);
        token.mint(car, 1_000e18);
        vm.stopPrank();

        // Each guest grants the batcher unlimited allowance via a single approve. Production
        // uses EIP-2612 `permit` collected at park entry; the on-chain effect is identical.
        vm.prank(ali);
        token.approve(address(batcher), type(uint256).max);
        vm.prank(bob);
        token.approve(address(batcher), type(uint256).max);
        vm.prank(car);
        token.approve(address(batcher), type(uint256).max);
    }

    // ---- helpers --------------------------------------------------------------

    function _auth(address from, uint32 venueId, uint8 category, uint256 amount, uint64 nonce, uint64 deadline)
        internal
        pure
        returns (SettlementBatcher.SpendAuth memory)
    {
        return SettlementBatcher.SpendAuth({
            from: from,
            venueId: venueId,
            category: category,
            amount: amount,
            nonce: nonce,
            deadline: deadline,
            gameTick: 0
        });
    }

    function _sign(uint256 pk, SettlementBatcher.SpendAuth memory a) internal view returns (bytes memory) {
        bytes32 structHash = keccak256(
            abi.encode(
                batcher.SPEND_AUTH_TYPEHASH(),
                a.from,
                a.venueId,
                a.category,
                a.amount,
                a.nonce,
                a.deadline,
                a.gameTick
            )
        );
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", batcher.domainSeparator(), structHash));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, digest);
        return abi.encodePacked(r, s, v);
    }

    function _calldataAuths(SettlementBatcher.SpendAuth memory a)
        internal
        pure
        returns (SettlementBatcher.SpendAuth[] memory arr)
    {
        arr = new SettlementBatcher.SpendAuth[](1);
        arr[0] = a;
    }

    function _sigs(bytes memory s) internal pure returns (bytes[] memory arr) {
        arr = new bytes[](1);
        arr[0] = s;
    }

    // ---- happy paths ----------------------------------------------------------

    function test_settleSingleAuthMovesTokensAndBumpsNonce() public {
        SettlementBatcher.SpendAuth memory a = _auth(ali, RIDE_ID, 1, 12e18, 0, uint64(block.timestamp + 1 hours));
        bytes memory sig = _sign(aliPk, a);

        uint256 aliBefore = token.balanceOf(ali);
        uint256 tillBefore = token.balanceOf(rideTill);

        batcher.settle(_calldataAuths(a), _sigs(sig));

        assertEq(token.balanceOf(ali), aliBefore - 12e18);
        assertEq(token.balanceOf(rideTill), tillBefore + 12e18);
        assertEq(batcher.sigNonces(ali), 1);
    }

    function test_settleEmitsGuestSpendAndBatchSettled() public {
        SettlementBatcher.SpendAuth memory a = _auth(ali, RIDE_ID, 3, 7e18, 0, uint64(block.timestamp + 1 hours));
        a.gameTick = 1234;
        bytes memory sig = _sign(aliPk, a);

        vm.expectEmit(true, true, true, true, address(batcher));
        emit SettlementBatcher.GuestSpend(ali, RIDE_ID, VenueRegistry.VenueKind.Ride, 3, 7e18, 1234);
        vm.expectEmit(true, true, true, true, address(batcher));
        emit SettlementBatcher.BatchSettled(1);

        batcher.settle(_calldataAuths(a), _sigs(sig));
    }

    function test_settleBatchAcrossManyGuestsAndVenues() public {
        SettlementBatcher.SpendAuth[] memory auths = new SettlementBatcher.SpendAuth[](4);
        bytes[] memory sigs = new bytes[](4);
        uint64 dl = uint64(block.timestamp + 1 hours);

        auths[0] = _auth(ali, RIDE_ID, 1, 5e18, 0, dl);
        auths[1] = _auth(bob, SHOP_ID, 2, 11e18, 0, dl);
        auths[2] = _auth(ali, SHOP_ID, 2, 3e18, 1, dl);
        auths[3] = _auth(car, RIDE_ID, 1, 9e18, 0, dl);

        sigs[0] = _sign(aliPk, auths[0]);
        sigs[1] = _sign(bobPk, auths[1]);
        sigs[2] = _sign(aliPk, auths[2]);
        sigs[3] = _sign(carPk, auths[3]);

        batcher.settle(auths, sigs);

        assertEq(batcher.sigNonces(ali), 2);
        assertEq(batcher.sigNonces(bob), 1);
        assertEq(batcher.sigNonces(car), 1);

        assertEq(token.balanceOf(ali), 1_000e18 - 5e18 - 3e18);
        assertEq(token.balanceOf(bob), 1_000e18 - 11e18);
        assertEq(token.balanceOf(car), 1_000e18 - 9e18);
        assertEq(token.balanceOf(rideTill), 5e18 + 9e18);
        assertEq(token.balanceOf(shopTill), 11e18 + 3e18);
    }

    function test_consecutiveSettlesIncrementNonce() public {
        uint64 dl = uint64(block.timestamp + 1 hours);
        for (uint64 i; i < 3; ++i) {
            SettlementBatcher.SpendAuth memory a = _auth(ali, RIDE_ID, 1, 1e18, i, dl);
            batcher.settle(_calldataAuths(a), _sigs(_sign(aliPk, a)));
        }
        assertEq(batcher.sigNonces(ali), 3);
    }

    // ---- replay / nonce -------------------------------------------------------

    function test_replaySameNonceReverts() public {
        SettlementBatcher.SpendAuth memory a = _auth(ali, RIDE_ID, 1, 5e18, 0, uint64(block.timestamp + 1 hours));
        bytes memory sig = _sign(aliPk, a);
        batcher.settle(_calldataAuths(a), _sigs(sig));

        vm.expectRevert(abi.encodeWithSelector(SettlementBatcher.BadNonce.selector, uint256(0), uint64(1), uint64(0)));
        batcher.settle(_calldataAuths(a), _sigs(sig));
    }

    function test_outOfOrderNonceReverts() public {
        // Skipping nonce 0 by submitting nonce 1 first should fail.
        SettlementBatcher.SpendAuth memory a = _auth(ali, RIDE_ID, 1, 5e18, 1, uint64(block.timestamp + 1 hours));
        bytes memory sig = _sign(aliPk, a);
        vm.expectRevert(abi.encodeWithSelector(SettlementBatcher.BadNonce.selector, uint256(0), uint64(0), uint64(1)));
        batcher.settle(_calldataAuths(a), _sigs(sig));
    }

    // ---- signature checks -----------------------------------------------------

    function test_wrongSignerReverts() public {
        SettlementBatcher.SpendAuth memory a = _auth(ali, RIDE_ID, 1, 5e18, 0, uint64(block.timestamp + 1 hours));
        // bob signs an auth that claims to be from ali — recovered != a.from.
        bytes memory sig = _sign(bobPk, a);
        vm.expectRevert(abi.encodeWithSelector(SettlementBatcher.BadSignature.selector, uint256(0)));
        batcher.settle(_calldataAuths(a), _sigs(sig));
    }

    function test_tamperedAmountReverts() public {
        SettlementBatcher.SpendAuth memory a = _auth(ali, RIDE_ID, 1, 5e18, 0, uint64(block.timestamp + 1 hours));
        bytes memory sig = _sign(aliPk, a);
        a.amount = 50e18; // bump after signing
        vm.expectRevert(abi.encodeWithSelector(SettlementBatcher.BadSignature.selector, uint256(0)));
        batcher.settle(_calldataAuths(a), _sigs(sig));
    }

    // ---- deadline -------------------------------------------------------------

    function test_expiredDeadlineReverts() public {
        uint64 dl = uint64(block.timestamp + 60);
        SettlementBatcher.SpendAuth memory a = _auth(ali, RIDE_ID, 1, 5e18, 0, dl);
        bytes memory sig = _sign(aliPk, a);
        vm.warp(uint256(dl) + 1);
        vm.expectRevert(abi.encodeWithSelector(SettlementBatcher.DeadlineExpired.selector, uint256(0)));
        batcher.settle(_calldataAuths(a), _sigs(sig));
    }

    // ---- venue resolution -----------------------------------------------------

    function test_unknownVenueReverts() public {
        uint32 missing = 999;
        SettlementBatcher.SpendAuth memory a = _auth(ali, missing, 1, 5e18, 0, uint64(block.timestamp + 1 hours));
        bytes memory sig = _sign(aliPk, a);
        vm.expectRevert(
            abi.encodeWithSelector(SettlementBatcher.VenueNotRegistered.selector, uint256(0), missing)
        );
        batcher.settle(_calldataAuths(a), _sigs(sig));
    }

    function test_inactiveVenueReverts() public {
        SettlementBatcher.SpendAuth memory a =
            _auth(ali, DEMOLISHED_ID, 1, 5e18, 0, uint64(block.timestamp + 1 hours));
        bytes memory sig = _sign(aliPk, a);
        vm.expectRevert(
            abi.encodeWithSelector(SettlementBatcher.VenueInactive.selector, uint256(0), DEMOLISHED_ID)
        );
        batcher.settle(_calldataAuths(a), _sigs(sig));
    }

    // ---- shape errors ---------------------------------------------------------

    function test_emptyBatchReverts() public {
        SettlementBatcher.SpendAuth[] memory empty = new SettlementBatcher.SpendAuth[](0);
        bytes[] memory emptySigs = new bytes[](0);
        vm.expectRevert(SettlementBatcher.EmptyBatch.selector);
        batcher.settle(empty, emptySigs);
    }

    function test_lengthMismatchReverts() public {
        SettlementBatcher.SpendAuth memory a = _auth(ali, RIDE_ID, 1, 5e18, 0, uint64(block.timestamp + 1 hours));
        SettlementBatcher.SpendAuth[] memory auths = _calldataAuths(a);
        bytes[] memory sigs = new bytes[](2); // mismatched
        vm.expectRevert(SettlementBatcher.LengthMismatch.selector);
        batcher.settle(auths, sigs);
    }

    // ---- atomic-failure semantics --------------------------------------------

    function test_oneBadItemRevertsEntireBatch() public {
        // Batch of 3 — second item carries an expired deadline. Whole batch must roll back so
        // nonces don't drift; the sidecar can repack and retry without ambiguity.
        uint64 dlGood = uint64(block.timestamp + 1 hours);
        uint64 dlBad = uint64(block.timestamp + 60);

        SettlementBatcher.SpendAuth[] memory auths = new SettlementBatcher.SpendAuth[](3);
        bytes[] memory sigs = new bytes[](3);

        auths[0] = _auth(ali, RIDE_ID, 1, 5e18, 0, dlGood);
        auths[1] = _auth(bob, SHOP_ID, 2, 7e18, 0, dlBad);
        auths[2] = _auth(car, RIDE_ID, 1, 9e18, 0, dlGood);

        sigs[0] = _sign(aliPk, auths[0]);
        sigs[1] = _sign(bobPk, auths[1]);
        sigs[2] = _sign(carPk, auths[2]);

        vm.warp(uint256(dlBad) + 1);

        vm.expectRevert(abi.encodeWithSelector(SettlementBatcher.DeadlineExpired.selector, uint256(1)));
        batcher.settle(auths, sigs);

        assertEq(batcher.sigNonces(ali), 0);
        assertEq(batcher.sigNonces(bob), 0);
        assertEq(batcher.sigNonces(car), 0);
        assertEq(token.balanceOf(ali), 1_000e18);
    }

    // ---- helpers exposed via public functions ---------------------------------

    function test_hashSpendAuthMatchesOffChainComputation() public view {
        SettlementBatcher.SpendAuth memory a = _auth(ali, RIDE_ID, 1, 5e18, 0, uint64(block.timestamp + 1 hours));
        bytes32 structHash = keccak256(
            abi.encode(
                batcher.SPEND_AUTH_TYPEHASH(),
                a.from,
                a.venueId,
                a.category,
                a.amount,
                a.nonce,
                a.deadline,
                a.gameTick
            )
        );
        bytes32 expected = keccak256(abi.encodePacked("\x19\x01", batcher.domainSeparator(), structHash));

        SettlementBatcher.SpendAuth[] memory arr = _calldataAuths(a);
        assertEq(_callHashSpendAuth(arr, 0), expected);
    }

    function _callHashSpendAuth(SettlementBatcher.SpendAuth[] memory arr, uint256 i) internal view returns (bytes32) {
        // hashSpendAuth takes calldata; route through an external self-call to coerce memory→calldata.
        return this._extHash(arr[i]);
    }

    function _extHash(SettlementBatcher.SpendAuth calldata a) external view returns (bytes32) {
        return batcher.hashSpendAuth(a);
    }
}
