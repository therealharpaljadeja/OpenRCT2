// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

/// @title Disperse — mass-fund helper.
/// @notice Used by the sidecar funder to mint/transfer PARK to many guest wallets in one tx,
///         and to top up the relayer pool with MON.
contract Disperse {
    using SafeERC20 for IERC20;

    error LengthMismatch();
    error InsufficientValue();
    error TransferFailed();

    /// @notice Forward MON to many recipients in one tx. Refunds excess `msg.value` to the caller.
    function disperseEther(address[] calldata addrs, uint256[] calldata amts) external payable {
        if (addrs.length != amts.length) revert LengthMismatch();
        uint256 total;
        for (uint256 i; i < addrs.length; ++i) {
            total += amts[i];
            (bool ok,) = addrs[i].call{value: amts[i]}("");
            if (!ok) revert TransferFailed();
        }
        if (msg.value < total) revert InsufficientValue();
        if (msg.value > total) {
            (bool ok,) = msg.sender.call{value: msg.value - total}("");
            if (!ok) revert TransferFailed();
        }
    }

    /// @notice Pull `token` from the caller (allowance required) and fan it out.
    function disperseToken(IERC20 token, address[] calldata addrs, uint256[] calldata amts) external {
        if (addrs.length != amts.length) revert LengthMismatch();
        for (uint256 i; i < addrs.length; ++i) {
            token.safeTransferFrom(msg.sender, addrs[i], amts[i]);
        }
    }
}
