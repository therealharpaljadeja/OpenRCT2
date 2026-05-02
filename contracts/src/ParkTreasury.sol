// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

/// @title ParkTreasury — minimal owner-controlled smart account.
/// @notice Holds the park's operating PARK and MON. The owner (the sidecar's deployer key) can
///         execute arbitrary calls — e.g. `parkToken.approve(disperse, max)`,
///         `parkToken.transfer(staff, wages)`, `lendingPool.repay(amount)`.
contract ParkTreasury is Ownable {
    event Executed(address indexed target, uint256 value, bytes data, bytes result);

    error CallFailed(bytes returnData);

    constructor(address initialOwner) Ownable(initialOwner) {}

    function execute(address target, uint256 value, bytes calldata data)
        external
        onlyOwner
        returns (bytes memory result)
    {
        bool ok;
        (ok, result) = target.call{value: value}(data);
        if (!ok) revert CallFailed(result);
        emit Executed(target, value, data, result);
    }

    /// @notice Convenience for batched admin (sweeping sub-accounts, paying multiple staff in one tx, etc.).
    function executeBatch(address[] calldata targets, uint256[] calldata values, bytes[] calldata datas)
        external
        onlyOwner
        returns (bytes[] memory results)
    {
        require(targets.length == values.length && values.length == datas.length, "length mismatch");
        results = new bytes[](targets.length);
        for (uint256 i; i < targets.length; ++i) {
            (bool ok, bytes memory result) = targets[i].call{value: values[i]}(datas[i]);
            if (!ok) revert CallFailed(result);
            results[i] = result;
            emit Executed(targets[i], values[i], datas[i], result);
        }
    }

    receive() external payable {}
}
