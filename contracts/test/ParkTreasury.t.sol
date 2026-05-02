// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";
import {ParkToken} from "../src/ParkToken.sol";
import {ParkTreasury} from "../src/ParkTreasury.sol";

contract ParkTreasuryTest is Test {
    ParkToken token;
    ParkTreasury treasury;
    address owner = address(0xA);
    address minter = address(0xB);
    address payee = address(0xCAFE);
    address rando = address(0xDEAD);

    function setUp() public {
        token = new ParkToken(owner);
        vm.prank(owner);
        token.setMinter(minter, true);
        treasury = new ParkTreasury(owner);
        vm.prank(minter);
        token.mint(address(treasury), 1_000_000e18);
    }

    function test_executePaysWages() public {
        bytes memory data = abi.encodeCall(token.transfer, (payee, 100e18));
        vm.prank(owner);
        treasury.execute(address(token), 0, data);
        assertEq(token.balanceOf(payee), 100e18);
        assertEq(token.balanceOf(address(treasury)), 1_000_000e18 - 100e18);
    }

    function test_executeBatchPaysMultiple() public {
        address[] memory targets = new address[](2);
        uint256[] memory values = new uint256[](2);
        bytes[] memory datas = new bytes[](2);
        targets[0] = address(token);
        targets[1] = address(token);
        values[0] = 0;
        values[1] = 0;
        datas[0] = abi.encodeCall(token.transfer, (address(0x1), 50e18));
        datas[1] = abi.encodeCall(token.transfer, (address(0x2), 75e18));

        vm.prank(owner);
        treasury.executeBatch(targets, values, datas);
        assertEq(token.balanceOf(address(0x1)), 50e18);
        assertEq(token.balanceOf(address(0x2)), 75e18);
    }

    function test_nonOwnerCannotExecute() public {
        vm.prank(rando);
        vm.expectRevert();
        treasury.execute(address(token), 0, "");
    }

    function test_failedCallReverts() public {
        // Try to transfer more PARK than the treasury has.
        bytes memory data = abi.encodeCall(token.transfer, (payee, 10_000_000e18));
        vm.prank(owner);
        vm.expectRevert();
        treasury.execute(address(token), 0, data);
    }
}
