// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";
import {ParkToken} from "../src/ParkToken.sol";
import {Faucet} from "../src/Faucet.sol";

contract FaucetTest is Test {
    ParkToken token;
    Faucet faucet;
    address owner = address(0xA);
    address treasury = address(0xBEEF);
    address relayer1 = address(0xE1);
    address relayer2 = address(0xE2);
    address rando = address(0xCC);

    function setUp() public {
        token = new ParkToken(owner);
        faucet = new Faucet(owner, token);
        vm.prank(owner);
        token.setMinter(address(faucet), true);
        vm.deal(address(faucet), 10 ether);
    }

    function test_dripParkMintsToTreasury() public {
        vm.prank(owner);
        faucet.dripPark(treasury, 1_000_000e18);
        assertEq(token.balanceOf(treasury), 1_000_000e18);
    }

    function test_dripMonFundsRelayers() public {
        address[] memory addrs = new address[](2);
        uint256[] memory amts = new uint256[](2);
        addrs[0] = relayer1;
        addrs[1] = relayer2;
        amts[0] = 1 ether;
        amts[1] = 2 ether;

        vm.prank(owner);
        faucet.dripMon(addrs, amts);

        assertEq(relayer1.balance, 1 ether);
        assertEq(relayer2.balance, 2 ether);
        assertEq(address(faucet).balance, 7 ether);
    }

    function test_nonOwnerCannotDrip() public {
        vm.prank(rando);
        vm.expectRevert();
        faucet.dripPark(treasury, 1);

        address[] memory addrs = new address[](1);
        uint256[] memory amts = new uint256[](1);
        addrs[0] = relayer1;
        amts[0] = 1 ether;
        vm.prank(rando);
        vm.expectRevert();
        faucet.dripMon(addrs, amts);
    }

    function test_dripMonInsufficientBalanceReverts() public {
        address[] memory addrs = new address[](1);
        uint256[] memory amts = new uint256[](1);
        addrs[0] = relayer1;
        amts[0] = 100 ether;

        vm.prank(owner);
        vm.expectRevert(Faucet.InsufficientMonBalance.selector);
        faucet.dripMon(addrs, amts);
    }

    function test_dripMonLengthMismatchReverts() public {
        address[] memory addrs = new address[](2);
        uint256[] memory amts = new uint256[](1);
        addrs[0] = relayer1;
        addrs[1] = relayer2;
        amts[0] = 1 ether;

        vm.prank(owner);
        vm.expectRevert(Faucet.LengthMismatch.selector);
        faucet.dripMon(addrs, amts);
    }
}
