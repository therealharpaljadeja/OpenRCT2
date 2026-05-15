// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";
import {VenueRegistry} from "../src/VenueRegistry.sol";

contract VenueRegistryTest is Test {
    VenueRegistry registry;
    address owner = address(0xA);
    address rando = address(0xDEAD);

    function setUp() public {
        registry = new VenueRegistry(owner);
    }

    function test_registerStoresVenue() public {
        vm.prank(owner);
        address subAccount =
            registry.register(7, VenueRegistry.VenueKind.Ride, "Wooden Roller Coaster 1", "rct2.ride.wmouse");

        (
            uint32 id,
            VenueRegistry.VenueKind kind,
            string memory name,
            string memory objectType,
            address sa,
            uint64 registeredAt,
            bool active
        ) = registry.venues(7);

        assertEq(id, 7);
        assertEq(uint256(kind), uint256(VenueRegistry.VenueKind.Ride));
        assertEq(name, "Wooden Roller Coaster 1");
        assertEq(objectType, "rct2.ride.wmouse");
        assertEq(sa, subAccount);
        assertEq(registeredAt, uint64(block.number));
        assertTrue(active);
    }

    function test_subAccountIsDeterministic() public {
        // Same id derives same address pre-registration and post-registration.
        address pre = registry.subAccountOf(42);
        vm.prank(owner);
        address fromRegister = registry.register(42, VenueRegistry.VenueKind.Shop, "Burger Bar", "rct2.shop.burgb");
        assertEq(pre, fromRegister);

        // Different ids produce different addresses.
        assertTrue(registry.subAccountOf(1) != registry.subAccountOf(2));
    }

    function test_subAccountMatchesCreate2Formula() public view {
        uint32 id = 99;
        address expected = address(
            uint160(
                uint256(
                    keccak256(abi.encodePacked(bytes1(0xff), address(registry), bytes32(uint256(id)), keccak256("")))
                )
            )
        );
        assertEq(registry.subAccountOf(id), expected);
    }

    function test_doubleRegisterReverts() public {
        vm.prank(owner);
        registry.register(1, VenueRegistry.VenueKind.Ride, "RC", "ot");
        vm.prank(owner);
        vm.expectRevert(VenueRegistry.AlreadyRegistered.selector);
        registry.register(1, VenueRegistry.VenueKind.Ride, "RC", "ot");
    }

    function test_renameUpdatesName() public {
        vm.prank(owner);
        registry.register(2, VenueRegistry.VenueKind.Shop, "Old Name", "ot");
        vm.prank(owner);
        registry.rename(2, "New Name");
        (,, string memory name,,,,) = registry.venues(2);
        assertEq(name, "New Name");
    }

    function test_renameUnknownReverts() public {
        vm.prank(owner);
        vm.expectRevert(VenueRegistry.NotRegistered.selector);
        registry.rename(99, "x");
    }

    function test_retargetSwapsSubAccount() public {
        vm.prank(owner);
        registry.register(3, VenueRegistry.VenueKind.Facility, "Loo", "ot");
        address newSub = address(0xBEEF);
        vm.prank(owner);
        registry.retarget(3, newSub);
        (,,,, address sa,,) = registry.venues(3);
        assertEq(sa, newSub);
    }

    function test_retargetUnknownReverts() public {
        vm.prank(owner);
        vm.expectRevert(VenueRegistry.NotRegistered.selector);
        registry.retarget(99, address(0xBEEF));
    }

    function test_removeMarksInactive() public {
        vm.prank(owner);
        registry.register(4, VenueRegistry.VenueKind.ATM, "ATM 1", "ot");
        vm.prank(owner);
        registry.remove(4);
        (,,,,,, bool active) = registry.venues(4);
        assertFalse(active);
        // Storage is preserved so indexers can still resolve historical spend.
        assertTrue(registry.exists(4));
    }

    function test_doubleRemoveReverts() public {
        vm.prank(owner);
        registry.register(4, VenueRegistry.VenueKind.ATM, "ATM 1", "ot");
        vm.prank(owner);
        registry.remove(4);
        vm.prank(owner);
        vm.expectRevert(VenueRegistry.AlreadyInactive.selector);
        registry.remove(4);
    }

    function test_removeUnknownReverts() public {
        vm.prank(owner);
        vm.expectRevert(VenueRegistry.NotRegistered.selector);
        registry.remove(99);
    }

    function test_venueIndexAndCount() public {
        vm.prank(owner);
        registry.register(10, VenueRegistry.VenueKind.Ride, "A", "x");
        vm.prank(owner);
        registry.register(20, VenueRegistry.VenueKind.Shop, "B", "y");

        assertEq(registry.venueCount(), 2);
        assertEq(registry.venueIdAt(0), 10);
        assertEq(registry.venueIdAt(1), 20);
        assertTrue(registry.exists(10));
        assertFalse(registry.exists(99));
    }

    function test_parkEntranceIsKindZero() public {
        // Park entrance is registered once at park init with venueId=0 (per plan §5.2).
        vm.prank(owner);
        registry.register(0, VenueRegistry.VenueKind.ParkEntrance, "Main Gate", "rct2.entrance");
        (uint32 id, VenueRegistry.VenueKind kind,,,,, bool active) = registry.venues(0);
        assertEq(id, 0);
        assertEq(uint256(kind), uint256(VenueRegistry.VenueKind.ParkEntrance));
        assertTrue(active);
        assertTrue(registry.exists(0));
    }

    function test_nonOwnerCannotRegister() public {
        vm.prank(rando);
        vm.expectRevert();
        registry.register(1, VenueRegistry.VenueKind.Ride, "x", "y");
    }

    function test_nonOwnerCannotRename() public {
        vm.prank(owner);
        registry.register(1, VenueRegistry.VenueKind.Ride, "x", "y");
        vm.prank(rando);
        vm.expectRevert();
        registry.rename(1, "z");
    }

    function test_nonOwnerCannotRetarget() public {
        vm.prank(owner);
        registry.register(1, VenueRegistry.VenueKind.Ride, "x", "y");
        vm.prank(rando);
        vm.expectRevert();
        registry.retarget(1, address(0xBEEF));
    }

    function test_nonOwnerCannotRemove() public {
        vm.prank(owner);
        registry.register(1, VenueRegistry.VenueKind.Ride, "x", "y");
        vm.prank(rando);
        vm.expectRevert();
        registry.remove(1);
    }
}
