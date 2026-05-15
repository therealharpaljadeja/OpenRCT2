// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

/// @title ParkTreasury — owner-controlled smart account with delegated operator support.
/// @notice Holds the park's operating PARK and MON. The owner (the sidecar's deployer key)
///         remains the single root of trust — the only address that can add or remove
///         operators, transfer ownership, or unilaterally execute calls. Operators are a
///         M3.14 addition: a small set of EOA keys, each owned by a different sidecar
///         subsystem (funder, permits, sweeper), authorized to call `execute` /
///         `executeBatch` so each subsystem can submit admin txs from its own EOA without
///         colliding on the deployer's nonce sequence. Operators have no other privileges
///         (can't transfer ownership, can't authorize themselves, can't manage other
///         operators); they're scoped to executing pre-built calldata that the owner has
///         pre-approved by writing the subsystem's logic.
contract ParkTreasury is Ownable {
    event Executed(address indexed target, uint256 value, bytes data, bytes result);
    /// @notice Emitted when an operator is granted or revoked. `authorized` is the new state.
    event OperatorSet(address indexed operator, bool authorized);

    error CallFailed(bytes returnData);
    error NotOwnerOrOperator(address caller);
    error ZeroOperator();

    /// @notice `true` for addresses authorized to call `execute` / `executeBatch`. Cleared
    ///         on `removeOperator`. Owner is *not* automatically an operator — the access
    ///         check below is `owner || operators[msg.sender]`, so the owner doesn't need
    ///         a self-add.
    mapping(address => bool) public operators;

    constructor(address initialOwner) Ownable(initialOwner) {}

    /// @dev Modifier: owner-or-operator. Cheap (one SLOAD when caller is an operator; the
    ///      owner short-circuits to no SLOAD). Reverts with the caller's address so the
    ///      sidecar's IPC can surface the bad-key case clearly.
    modifier onlyOwnerOrOperator() {
        if (msg.sender != owner() && !operators[msg.sender]) {
            revert NotOwnerOrOperator(msg.sender);
        }
        _;
    }

    /// @notice Grant `op` the right to call `execute` / `executeBatch`. Owner-only.
    ///         Idempotent — re-adding an existing operator is a no-op (no event re-emitted)
    ///         so the sidecar can call this on every boot without polluting the event log.
    function addOperator(address op) external onlyOwner {
        if (op == address(0)) revert ZeroOperator();
        if (operators[op]) return;
        operators[op] = true;
        emit OperatorSet(op, true);
    }

    /// @notice Revoke an operator. Owner-only. Idempotent (no-op on a non-operator).
    function removeOperator(address op) external onlyOwner {
        if (!operators[op]) return;
        operators[op] = false;
        emit OperatorSet(op, false);
    }

    function execute(address target, uint256 value, bytes calldata data)
        external
        onlyOwnerOrOperator
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
        onlyOwnerOrOperator
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
