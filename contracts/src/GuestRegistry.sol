// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

/// @title GuestRegistry — on-chain index of guests in this park.
/// @notice Mirrors the game-side guest table: `guestId → wallet address`, plus entry/exit blocks.
///         Indexers (Envio) and the in-game Treasury window read from here. Owner is the sidecar.
contract GuestRegistry is Ownable {
    struct GuestInfo {
        address addr;
        uint64 entryBlock;
        uint64 exitBlock; // 0 = still in park
    }

    mapping(uint256 guestId => GuestInfo) public guests;
    mapping(address wallet => uint256 guestId) public guestIdOf;

    event Entry(uint256 indexed guestId, address indexed addr, uint64 entryBlock);
    event Exit(uint256 indexed guestId, address indexed addr, uint64 exitBlock);

    error LengthMismatch();
    error AlreadyRegistered();
    error NotRegistered();
    error AlreadyExited();

    constructor(address initialOwner) Ownable(initialOwner) {}

    function recordEntry(uint256 guestId, address addr) external onlyOwner {
        _recordEntry(guestId, addr);
    }

    /// @notice Batch helper for the funder's windowed entry path.
    function recordEntryBatch(uint256[] calldata guestIds, address[] calldata addrs) external onlyOwner {
        if (guestIds.length != addrs.length) revert LengthMismatch();
        for (uint256 i; i < guestIds.length; ++i) {
            _recordEntry(guestIds[i], addrs[i]);
        }
    }

    function _recordEntry(uint256 guestId, address addr) internal {
        if (guests[guestId].addr != address(0)) revert AlreadyRegistered();
        uint64 nowBlock = uint64(block.number);
        guests[guestId] = GuestInfo({addr: addr, entryBlock: nowBlock, exitBlock: 0});
        guestIdOf[addr] = guestId;
        emit Entry(guestId, addr, nowBlock);
    }

    function recordExit(uint256 guestId) external onlyOwner {
        _recordExit(guestId);
    }

    function recordExitBatch(uint256[] calldata guestIds) external onlyOwner {
        for (uint256 i; i < guestIds.length; ++i) {
            _recordExit(guestIds[i]);
        }
    }

    function _recordExit(uint256 guestId) internal {
        GuestInfo storage g = guests[guestId];
        if (g.addr == address(0)) revert NotRegistered();
        if (g.exitBlock != 0) revert AlreadyExited();
        uint64 nowBlock = uint64(block.number);
        g.exitBlock = nowBlock;
        emit Exit(guestId, g.addr, nowBlock);
    }
}
