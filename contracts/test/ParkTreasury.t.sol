// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";
import {Vm} from "forge-std/Vm.sol";
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

    // ---- M3.14 — operator support ----

    function test_addOperatorEmitsEventAndAuthorizes() public {
        address op = address(0x77);
        vm.expectEmit(true, false, false, true, address(treasury));
        emit ParkTreasury.OperatorSet(op, true);
        vm.prank(owner);
        treasury.addOperator(op);
        assertTrue(treasury.operators(op));

        // Operator can now execute().
        bytes memory data = abi.encodeCall(token.transfer, (payee, 100e18));
        vm.prank(op);
        treasury.execute(address(token), 0, data);
        assertEq(token.balanceOf(payee), 100e18);
    }

    function test_addOperatorIsIdempotent() public {
        address op = address(0x77);
        vm.prank(owner);
        treasury.addOperator(op);
        // A second call is a no-op — no event re-emitted, state unchanged.
        vm.recordLogs();
        vm.prank(owner);
        treasury.addOperator(op);
        Vm.Log[] memory logs = vm.getRecordedLogs();
        assertEq(logs.length, 0, "second addOperator must not re-emit");
        assertTrue(treasury.operators(op));
    }

    function test_addOperatorRejectsZeroAddress() public {
        vm.prank(owner);
        vm.expectRevert(ParkTreasury.ZeroOperator.selector);
        treasury.addOperator(address(0));
    }

    function test_removeOperatorRevokes() public {
        address op = address(0x77);
        vm.prank(owner);
        treasury.addOperator(op);
        vm.prank(owner);
        treasury.removeOperator(op);
        assertFalse(treasury.operators(op));

        // Now the operator can't execute.
        vm.prank(op);
        vm.expectRevert(abi.encodeWithSelector(ParkTreasury.NotOwnerOrOperator.selector, op));
        treasury.execute(address(token), 0, "");
    }

    function test_removeOperatorIsIdempotent() public {
        address op = address(0x77); // never added
        vm.recordLogs();
        vm.prank(owner);
        treasury.removeOperator(op);
        Vm.Log[] memory logs = vm.getRecordedLogs();
        assertEq(logs.length, 0, "removeOperator on a non-operator must not emit");
    }

    function test_addOperatorOnlyOwner() public {
        address op = address(0x77);
        vm.prank(rando);
        vm.expectRevert();
        treasury.addOperator(op);

        // Even an existing operator can't grant other operators (intentional — no privilege escalation).
        vm.prank(owner);
        treasury.addOperator(op);
        vm.prank(op);
        vm.expectRevert();
        treasury.addOperator(address(0x88));
    }

    function test_removeOperatorOnlyOwner() public {
        address op = address(0x77);
        vm.prank(owner);
        treasury.addOperator(op);
        vm.prank(rando);
        vm.expectRevert();
        treasury.removeOperator(op);
        // Even the operator themselves can't self-remove (no privilege from operator role).
        vm.prank(op);
        vm.expectRevert();
        treasury.removeOperator(op);
    }

    function test_operatorCanExecuteBatch() public {
        address op = address(0x77);
        vm.prank(owner);
        treasury.addOperator(op);

        address[] memory targets = new address[](2);
        uint256[] memory values = new uint256[](2);
        bytes[] memory datas = new bytes[](2);
        targets[0] = address(token);
        targets[1] = address(token);
        datas[0] = abi.encodeCall(token.transfer, (address(0x1), 50e18));
        datas[1] = abi.encodeCall(token.transfer, (address(0x2), 75e18));

        vm.prank(op);
        treasury.executeBatch(targets, values, datas);
        assertEq(token.balanceOf(address(0x1)), 50e18);
        assertEq(token.balanceOf(address(0x2)), 75e18);
    }

    function test_nonOwnerNonOperatorRejected() public {
        // Random caller can't execute.
        vm.prank(rando);
        vm.expectRevert(abi.encodeWithSelector(ParkTreasury.NotOwnerOrOperator.selector, rando));
        treasury.execute(address(token), 0, "");

        // Random caller can't executeBatch either.
        address[] memory targets = new address[](0);
        uint256[] memory values = new uint256[](0);
        bytes[] memory datas = new bytes[](0);
        vm.prank(rando);
        vm.expectRevert(abi.encodeWithSelector(ParkTreasury.NotOwnerOrOperator.selector, rando));
        treasury.executeBatch(targets, values, datas);
    }

    function test_ownerStillWorksAfterOperatorsAreSet() public {
        // The owner is *not* automatically an operator; the access check is `owner ||
        // operators[caller]`. Verify owner still works after operators are configured.
        address op = address(0x77);
        vm.prank(owner);
        treasury.addOperator(op);
        bytes memory data = abi.encodeCall(token.transfer, (payee, 42e18));
        vm.prank(owner);
        treasury.execute(address(token), 0, data);
        assertEq(token.balanceOf(payee), 42e18);
    }

    function test_multipleOperatorsExecuteIndependently() public {
        address opA = address(0xAA1);
        address opB = address(0xBB1);
        address opC = address(0xCC1);
        vm.startPrank(owner);
        treasury.addOperator(opA);
        treasury.addOperator(opB);
        treasury.addOperator(opC);
        vm.stopPrank();

        // Each operator submits its own transfer — would be the funder/permits/sweeper
        // pattern in production, each carrying its own pre-built calldata.
        for (uint160 i; i < 3; ++i) {
            address op = [opA, opB, opC][uint256(i)];
            bytes memory data = abi.encodeCall(token.transfer, (address(uint160(0x100 + i)), 10e18));
            vm.prank(op);
            treasury.execute(address(token), 0, data);
        }
        assertEq(token.balanceOf(address(0x100)), 10e18);
        assertEq(token.balanceOf(address(0x101)), 10e18);
        assertEq(token.balanceOf(address(0x102)), 10e18);
    }
}

