// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";
import {ParkToken} from "../src/ParkToken.sol";
import {Disperse} from "../src/Disperse.sol";

contract DisperseTest is Test {
    ParkToken token;
    Disperse disperse;
    address owner = address(0xA);
    address minter = address(0xB);
    address payable funder;

    function setUp() public {
        token = new ParkToken(owner);
        vm.prank(owner);
        token.setMinter(minter, true);
        disperse = new Disperse();
        funder = payable(address(0xF00D));
        vm.deal(funder, 100 ether);
    }

    function test_disperseEtherFansOutAndRefunds() public {
        address payable[] memory recipients = new address payable[](3);
        recipients[0] = payable(address(0x101));
        recipients[1] = payable(address(0x102));
        recipients[2] = payable(address(0x103));

        address[] memory addrs = new address[](3);
        uint256[] memory amts = new uint256[](3);
        addrs[0] = recipients[0];
        addrs[1] = recipients[1];
        addrs[2] = recipients[2];
        amts[0] = 1 ether;
        amts[1] = 2 ether;
        amts[2] = 3 ether;

        uint256 funderBefore = funder.balance;
        vm.prank(funder);
        disperse.disperseEther{value: 10 ether}(addrs, amts);

        assertEq(recipients[0].balance, 1 ether);
        assertEq(recipients[1].balance, 2 ether);
        assertEq(recipients[2].balance, 3 ether);
        // Funder pays only the sum (6 ether), gets 4 ether refunded.
        assertEq(funder.balance, funderBefore - 6 ether);
    }

    function test_disperseEtherInsufficientReverts() public {
        address[] memory addrs = new address[](1);
        uint256[] memory amts = new uint256[](1);
        addrs[0] = address(0x101);
        amts[0] = 5 ether;

        vm.prank(funder);
        vm.expectRevert();
        disperse.disperseEther{value: 1 ether}(addrs, amts);
    }

    function test_disperseTokenPullsFromCaller() public {
        vm.prank(minter);
        token.mint(funder, 1000e18);
        vm.prank(funder);
        token.approve(address(disperse), type(uint256).max);

        address[] memory addrs = new address[](2);
        uint256[] memory amts = new uint256[](2);
        addrs[0] = address(0x201);
        addrs[1] = address(0x202);
        amts[0] = 100e18;
        amts[1] = 250e18;

        vm.prank(funder);
        disperse.disperseToken(token, addrs, amts);

        assertEq(token.balanceOf(address(0x201)), 100e18);
        assertEq(token.balanceOf(address(0x202)), 250e18);
        assertEq(token.balanceOf(funder), 1000e18 - 350e18);
    }

    function test_lengthMismatchReverts() public {
        address[] memory addrs = new address[](2);
        uint256[] memory amts = new uint256[](1);
        vm.prank(funder);
        vm.expectRevert(Disperse.LengthMismatch.selector);
        disperse.disperseEther{value: 0}(addrs, amts);
    }
}
