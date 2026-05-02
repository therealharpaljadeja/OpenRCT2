// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {VenueRegistry} from "./VenueRegistry.sol";

/// @title SettlementBatcher — packs many guest EIP-712 spend authorizations into one tx.
/// @notice Each guest signs a `SpendAuth` off-chain. The sidecar collects up to `BATCH_MAX_SIZE`
///         of these, calls `settle(auths, sigs)`, and the contract verifies every signature,
///         executes a `transferFrom(guest, venueSubAccount, amount)` for each, and emits one
///         `GuestSpend` event per item. Guests' EIP-2612 `permit` to this batcher (collected at
///         park entry) is what makes `transferFrom` work without a per-spend approval tx.
///
///         Replay protection is per-guest sig-nonce — distinct from the wallet's EOA tx nonce,
///         since guests never broadcast their own transactions in this design (a relayer pool
///         pays gas).
///
///         See `OpenRCT2/ONCHAIN_PLAN.md` §2.4 / §3 / §4.2.
contract SettlementBatcher is EIP712 {
    using SafeERC20 for IERC20;

    /// @dev Off-chain typed-data payload signed by each guest.
    ///      `venueId` resolves to a sub-account + kind via the linked `VenueRegistry`, so we can
    ///      emit the human-readable event (and so guests can't redirect funds to arbitrary
    ///      addresses by signing a different `to`).
    struct SpendAuth {
        address from;
        uint32 venueId;
        uint8 category;
        uint256 amount;
        uint64 nonce;
        uint64 deadline;
        uint64 gameTick;
    }

    bytes32 public constant SPEND_AUTH_TYPEHASH = keccak256(
        "SpendAuth(address from,uint32 venueId,uint8 category,uint256 amount,uint64 nonce,uint64 deadline,uint64 gameTick)"
    );

    IERC20 public immutable token;
    VenueRegistry public immutable venueRegistry;

    /// @notice Per-guest monotonic signature nonce. Increments by one per accepted auth.
    mapping(address guest => uint64) public sigNonces;

    /// @notice Mirrors the event shape from `OpenRCT2/ONCHAIN_PLAN.md` §3.2 so indexers can join
    ///         each spend back to its venue (registered separately in `VenueRegistry`).
    event GuestSpend(
        address indexed guest,
        uint32 indexed venueId,
        VenueRegistry.VenueKind indexed kind,
        uint8 category,
        uint256 amount,
        uint64 gameTick
    );

    /// @notice Emitted once per `settle` call so dashboards can chart batch fill independent of
    ///         per-item events. `count` matches the number of `GuestSpend` events in the same tx.
    event BatchSettled(uint256 count);

    error LengthMismatch();
    error EmptyBatch();
    error DeadlineExpired(uint256 index);
    error BadNonce(uint256 index, uint64 expected, uint64 got);
    error BadSignature(uint256 index);
    error VenueNotRegistered(uint256 index, uint32 venueId);
    error VenueInactive(uint256 index, uint32 venueId);

    constructor(IERC20 token_, VenueRegistry venueRegistry_)
        EIP712("SettlementBatcher", "1")
    {
        token = token_;
        venueRegistry = venueRegistry_;
    }

    /// @notice EIP-712 domain separator for off-chain signers.
    function domainSeparator() external view returns (bytes32) {
        return _domainSeparatorV4();
    }

    /// @notice Hash of a single `SpendAuth` under this contract's domain. Useful for off-chain
    ///         debugging and for any signer that wants to verify before submitting.
    function hashSpendAuth(SpendAuth calldata auth) external view returns (bytes32) {
        return _hashTypedDataV4(_structHash(auth));
    }

    /// @notice Verify and execute a batch of guest spend authorizations.
    /// @dev Reverts the entire tx on the first invalid item. The sidecar is responsible for not
    ///      packing stale auths; partial settlement would complicate nonce accounting and make
    ///      the metrics ambiguous.
    function settle(SpendAuth[] calldata auths, bytes[] calldata sigs) external {
        uint256 n = auths.length;
        if (n == 0) revert EmptyBatch();
        if (sigs.length != n) revert LengthMismatch();

        for (uint256 i; i < n; ++i) {
            SpendAuth calldata a = auths[i];

            if (block.timestamp > a.deadline) revert DeadlineExpired(i);

            uint64 expected = sigNonces[a.from];
            if (a.nonce != expected) revert BadNonce(i, expected, a.nonce);

            bytes32 digest = _hashTypedDataV4(_structHash(a));
            address recovered = ECDSA.recover(digest, sigs[i]);
            if (recovered != a.from) revert BadSignature(i);

            (, VenueRegistry.VenueKind kind,,, address subAccount,, bool active) = venueRegistry.venues(a.venueId);
            if (subAccount == address(0)) revert VenueNotRegistered(i, a.venueId);
            if (!active) revert VenueInactive(i, a.venueId);

            unchecked {
                sigNonces[a.from] = expected + 1;
            }

            token.safeTransferFrom(a.from, subAccount, a.amount);

            emit GuestSpend(a.from, a.venueId, kind, a.category, a.amount, a.gameTick);
        }

        emit BatchSettled(n);
    }

    function _structHash(SpendAuth calldata a) internal pure returns (bytes32) {
        return keccak256(
            abi.encode(
                SPEND_AUTH_TYPEHASH,
                a.from,
                a.venueId,
                a.category,
                a.amount,
                a.nonce,
                a.deadline,
                a.gameTick
            )
        );
    }
}
