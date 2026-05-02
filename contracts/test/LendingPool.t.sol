// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";
import {ParkToken} from "../src/ParkToken.sol";
import {LendingPool} from "../src/LendingPool.sol";

contract LendingPoolTest is Test {
    ParkToken token;
    LendingPool pool;
    address owner = address(0xA);
    address treasury = address(0xBEEF);
    address rando = address(0xDEAD);
    uint256 constant MAX = 5_000_000e18;
    uint256 constant RATE = 1e12; // 0.0001% per block (1e12 / 1e18)

    function setUp() public {
        token = new ParkToken(owner);
        pool = new LendingPool(owner, token, treasury, MAX, RATE);
        vm.prank(owner);
        token.setMinter(address(pool), true);
    }

    function test_borrowMintsToTreasury() public {
        vm.prank(treasury);
        pool.borrow(1_000_000e18);
        assertEq(pool.principal(), 1_000_000e18);
        assertEq(token.balanceOf(treasury), 1_000_000e18);
    }

    function test_repayBurnsFromTreasury() public {
        vm.prank(treasury);
        pool.borrow(1_000_000e18);
        vm.prank(treasury);
        pool.repay(400_000e18);
        assertEq(pool.principal(), 600_000e18);
        assertEq(token.balanceOf(treasury), 600_000e18);
    }

    function test_interestAccruesOverBlocks() public {
        vm.prank(treasury);
        pool.borrow(1_000_000e18);

        // Use a bigger rate (1e15 = 0.1% per block) so interest is visible without overflow.
        vm.prank(owner);
        pool.setRate(1e15);

        vm.roll(block.number + 100);
        // Touch via repay(0) — accrue runs.
        vm.prank(treasury);
        pool.repay(0);
        // interest = 1_000_000e18 * 1e15 * 100 / 1e18 = 100_000e18
        assertEq(pool.principal(), 1_000_000e18 + 100_000e18);
    }

    function test_currentDebtIncludesUnaccrued() public {
        vm.prank(treasury);
        pool.borrow(1_000_000e18);
        vm.prank(owner);
        pool.setRate(1e15);
        vm.roll(block.number + 100);
        // currentDebt should reflect unaccrued interest without mutating state.
        assertEq(pool.currentDebt(), 1_000_000e18 + 100_000e18);
        assertEq(pool.principal(), 1_000_000e18); // not yet folded in
    }

    function test_nonBorrowerCannotBorrow() public {
        vm.prank(rando);
        vm.expectRevert(LendingPool.NotBorrower.selector);
        pool.borrow(1);
    }

    function test_borrowExceedingMaxReverts() public {
        vm.prank(treasury);
        vm.expectRevert(LendingPool.ExceedsMax.selector);
        pool.borrow(MAX + 1);
    }

    function test_bankruptcyBlocksFurtherBorrows() public {
        vm.prank(treasury);
        pool.borrow(100e18);
        vm.prank(owner);
        pool.declareBankruptcy();
        assertTrue(pool.bankrupt());

        vm.prank(treasury);
        vm.expectRevert(LendingPool.AlreadyBankrupt.selector);
        pool.borrow(1);
    }

    function test_repayCapsAtPrincipal() public {
        vm.prank(treasury);
        pool.borrow(100e18);
        vm.prank(treasury);
        pool.repay(500e18);
        assertEq(pool.principal(), 0);
        assertEq(token.balanceOf(treasury), 0);
    }
}
