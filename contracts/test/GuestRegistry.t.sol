// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";
import {GuestRegistry} from "../src/GuestRegistry.sol";

contract GuestRegistryTest is Test {
    GuestRegistry registry;
    address owner = address(0xA);
    address rando = address(0xDEAD);

    function setUp() public {
        registry = new GuestRegistry(owner);
    }

    function test_recordEntryStoresAddress() public {
        vm.prank(owner);
        registry.recordEntry(42, address(0x1234));
        (address addr, uint64 entryBlock, uint64 exitBlock) = registry.guests(42);
        assertEq(addr, address(0x1234));
        assertEq(entryBlock, uint64(block.number));
        assertEq(exitBlock, 0);
        assertEq(registry.guestIdOf(address(0x1234)), 42);
    }

    function test_recordEntryBatch() public {
        uint256[] memory ids = new uint256[](3);
        address[] memory addrs = new address[](3);
        ids[0] = 1; addrs[0] = address(0x1);
        ids[1] = 2; addrs[1] = address(0x2);
        ids[2] = 3; addrs[2] = address(0x3);

        vm.prank(owner);
        registry.recordEntryBatch(ids, addrs);

        for (uint256 i = 0; i < 3; ++i) {
            (address a,,) = registry.guests(ids[i]);
            assertEq(a, addrs[i]);
        }
    }

    function test_doubleRegisterReverts() public {
        vm.prank(owner);
        registry.recordEntry(1, address(0x1));
        vm.prank(owner);
        vm.expectRevert(GuestRegistry.AlreadyRegistered.selector);
        registry.recordEntry(1, address(0x2));
    }

    function test_recordExitStampsBlock() public {
        vm.prank(owner);
        registry.recordEntry(1, address(0x1));
        vm.roll(block.number + 100);
        vm.prank(owner);
        registry.recordExit(1);
        (, , uint64 exitBlock) = registry.guests(1);
        assertEq(exitBlock, uint64(block.number));
    }

    function test_exitWithoutEntryReverts() public {
        vm.prank(owner);
        vm.expectRevert(GuestRegistry.NotRegistered.selector);
        registry.recordExit(99);
    }

    function test_doubleExitReverts() public {
        vm.prank(owner);
        registry.recordEntry(1, address(0x1));
        vm.prank(owner);
        registry.recordExit(1);
        vm.prank(owner);
        vm.expectRevert(GuestRegistry.AlreadyExited.selector);
        registry.recordExit(1);
    }

    function test_nonOwnerCannotRecord() public {
        vm.prank(rando);
        vm.expectRevert();
        registry.recordEntry(1, address(0x1));
    }
}
