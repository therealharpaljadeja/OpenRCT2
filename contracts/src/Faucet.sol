// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {ParkToken} from "./ParkToken.sol";

/// @title Faucet — owner-only PARK + MON dispenser, globally shared across park sessions.
/// @notice Used at park launch to mint PARK to the treasury and to fund the relayer pool with MON.
///         The Faucet is the sole MON source for relayers throughout a park's lifetime — the
///         treasury holds PARK only, never MON.
contract Faucet is Ownable {
    ParkToken public immutable parkToken;

    event ParkDripped(address indexed to, uint256 amount);
    event MonDripped(address indexed to, uint256 amount);

    error LengthMismatch();
    error InsufficientMonBalance();
    error TransferFailed();

    constructor(address initialOwner, ParkToken parkToken_) Ownable(initialOwner) {
        parkToken = parkToken_;
    }

    /// @notice Mint PARK to a recipient. Faucet must hold the `minter` role on PARK.
    function dripPark(address to, uint256 amount) external onlyOwner {
        parkToken.mint(to, amount);
        emit ParkDripped(to, amount);
    }

    /// @notice Forward MON from this contract's balance to N recipients in one tx.
    /// @dev Used at park launch to fund all relayers in a single call.
    function dripMon(address[] calldata addrs, uint256[] calldata amts) external onlyOwner {
        if (addrs.length != amts.length) revert LengthMismatch();
        uint256 total;
        for (uint256 i; i < addrs.length; ++i) {
            total += amts[i];
        }
        if (address(this).balance < total) revert InsufficientMonBalance();
        for (uint256 i; i < addrs.length; ++i) {
            (bool ok,) = addrs[i].call{value: amts[i]}("");
            if (!ok) revert TransferFailed();
            emit MonDripped(addrs[i], amts[i]);
        }
    }

    /// @notice Owner-only sweep, in case the faucet is decommissioned.
    function withdrawMon(address to, uint256 amount) external onlyOwner {
        (bool ok,) = to.call{value: amount}("");
        if (!ok) revert TransferFailed();
    }

    receive() external payable {}
}
