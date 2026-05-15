// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";
import {ParkToken} from "../src/ParkToken.sol";

contract ParkTokenTest is Test {
    ParkToken token;
    address owner = address(0xA);
    address minter = address(0xB);
    address alice = address(0x1);
    address bob = address(0x2);

    function setUp() public {
        token = new ParkToken(owner);
        vm.prank(owner);
        token.setMinter(minter, true);
    }

    function test_metadata() public view {
        assertEq(token.name(), "Park");
        assertEq(token.symbol(), "PARK");
        assertEq(token.decimals(), 18);
    }

    function test_mintByMinterTransfersAndBurns() public {
        vm.prank(minter);
        token.mint(alice, 1000e18);
        assertEq(token.balanceOf(alice), 1000e18);

        vm.prank(alice);
        token.transfer(bob, 400e18);
        assertEq(token.balanceOf(alice), 600e18);
        assertEq(token.balanceOf(bob), 400e18);

        vm.prank(minter);
        token.burn(bob, 400e18);
        assertEq(token.balanceOf(bob), 0);
    }

    function test_nonMinterCannotMint() public {
        vm.expectRevert(ParkToken.NotMinter.selector);
        token.mint(alice, 1);
    }

    function test_ownerCanRevokeMinter() public {
        vm.prank(owner);
        token.setMinter(minter, false);
        vm.prank(minter);
        vm.expectRevert(ParkToken.NotMinter.selector);
        token.mint(alice, 1);
    }

    function test_permitSetsAllowance() public {
        uint256 alicePk = 0xA11CE;
        address aliceAddr = vm.addr(alicePk);
        address spender = address(0xCAFE);
        uint256 deadline = block.timestamp + 1 hours;

        vm.prank(minter);
        token.mint(aliceAddr, 100e18);

        bytes32 permitTypehash = keccak256(
            "Permit(address owner,address spender,uint256 value,uint256 nonce,uint256 deadline)"
        );
        bytes32 structHash = keccak256(
            abi.encode(permitTypehash, aliceAddr, spender, type(uint256).max, token.nonces(aliceAddr), deadline)
        );
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", token.DOMAIN_SEPARATOR(), structHash));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(alicePk, digest);

        token.permit(aliceAddr, spender, type(uint256).max, deadline, v, r, s);
        assertEq(token.allowance(aliceAddr, spender), type(uint256).max);

        vm.prank(spender);
        token.transferFrom(aliceAddr, bob, 30e18);
        assertEq(token.balanceOf(bob), 30e18);
    }
}
