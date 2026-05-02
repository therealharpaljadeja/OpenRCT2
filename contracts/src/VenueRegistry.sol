// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

/// @title VenueRegistry — on-chain catalog of paying buildings in this park.
/// @notice Mirrors every paying location (rides, shops, stalls, facilities, ATMs, the park
///         entrance). Each venue is assigned a deterministic CREATE2 sub-account that acts as
///         its on-chain "till": no code is deployed there; the address is just a stable sink
///         for guest spend, so `balanceOf(subAccount)` reads as that venue's lifetime revenue
///         and indexers can resolve every `GuestSpend` to a human-readable building.
///
///         The registry itself is per-park (deployed via CREATE2 keyed on the park-save UUID),
///         so reloading a save reattaches to the same on-chain state. See `OpenRCT2/ONCHAIN_PLAN.md`.
contract VenueRegistry is Ownable {
    enum VenueKind {
        ParkEntrance,
        Ride,
        Shop,
        Stall,
        Facility,
        ATM
    }

    struct Venue {
        uint32 id;
        VenueKind kind;
        string name;
        string objectType;
        address subAccount;
        uint64 registeredAtBlock;
        bool active;
    }

    /// @dev Init-code hash used in the CREATE2 sub-account derivation. We never deploy code at
    ///      these addresses; the empty-init-code hash gives a stable, simple seed.
    bytes32 public constant SUBACCOUNT_INIT_CODE_HASH = keccak256("");

    mapping(uint32 venueId => Venue) public venues;
    uint32[] private _venueIds;

    event VenueRegistered(
        uint32 indexed id, VenueKind indexed kind, string name, string objectType, address subAccount
    );
    event VenueRenamed(uint32 indexed id, string newName);
    event VenueRetargeted(uint32 indexed id, address newSubAccount);
    event VenueRemoved(uint32 indexed id);

    error AlreadyRegistered();
    error NotRegistered();
    error AlreadyInactive();

    constructor(address initialOwner) Ownable(initialOwner) {}

    /// @notice Register a venue. Returns the deterministic sub-account that will receive its spend.
    function register(uint32 id, VenueKind kind, string calldata name, string calldata objectType)
        external
        onlyOwner
        returns (address subAccount)
    {
        if (venues[id].subAccount != address(0)) revert AlreadyRegistered();
        subAccount = subAccountOf(id);
        venues[id] = Venue({
            id: id,
            kind: kind,
            name: name,
            objectType: objectType,
            subAccount: subAccount,
            registeredAtBlock: uint64(block.number),
            active: true
        });
        _venueIds.push(id);
        emit VenueRegistered(id, kind, name, objectType, subAccount);
    }

    function rename(uint32 id, string calldata newName) external onlyOwner {
        Venue storage v = venues[id];
        if (v.subAccount == address(0)) revert NotRegistered();
        v.name = newName;
        emit VenueRenamed(id, newName);
    }

    /// @notice Re-point a venue's till. Future revenue lands at `newSubAccount`; balances already
    ///         held at the prior address remain there until swept by the treasury.
    function retarget(uint32 id, address newSubAccount) external onlyOwner {
        Venue storage v = venues[id];
        if (v.subAccount == address(0)) revert NotRegistered();
        v.subAccount = newSubAccount;
        emit VenueRetargeted(id, newSubAccount);
    }

    /// @notice Mark a venue inactive (e.g. ride demolished). Storage is preserved so historical
    ///         spend events can still be resolved by indexers.
    function remove(uint32 id) external onlyOwner {
        Venue storage v = venues[id];
        if (v.subAccount == address(0)) revert NotRegistered();
        if (!v.active) revert AlreadyInactive();
        v.active = false;
        emit VenueRemoved(id);
    }

    /// @notice Deterministic CREATE2 address used as venue `id`'s till. Stable across reloads —
    ///         depends only on this registry's address and the venue id.
    function subAccountOf(uint32 id) public view returns (address) {
        return address(
            uint160(
                uint256(
                    keccak256(
                        abi.encodePacked(bytes1(0xff), address(this), bytes32(uint256(id)), SUBACCOUNT_INIT_CODE_HASH)
                    )
                )
            )
        );
    }

    function venueCount() external view returns (uint256) {
        return _venueIds.length;
    }

    function venueIdAt(uint256 idx) external view returns (uint32) {
        return _venueIds[idx];
    }

    function exists(uint32 id) external view returns (bool) {
        return venues[id].subAccount != address(0);
    }
}
