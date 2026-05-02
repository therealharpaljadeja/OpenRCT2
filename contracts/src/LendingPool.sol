// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {ParkToken} from "./ParkToken.sol";

/// @title LendingPool — park-level bank loan against PARK.
/// @notice Single borrower (the park treasury). Interest accrues per block at a fixed rate.
///         The pool mints PARK on `borrow` and burns it on `repay` — it must hold the `minter` role.
///         Guests are NOT borrowers here; ATM-style guest micro-loans (if/when implemented) are a
///         separate facility per the plan §10.
contract LendingPool is Ownable {
    ParkToken public immutable parkToken;
    address public borrower;

    /// @notice Outstanding principal (includes accrued interest after each `_accrue`).
    uint256 public principal;
    /// @notice Block at which `principal` last had interest folded in.
    uint256 public lastAccruedBlock;
    /// @notice Per-block rate, scaled by 1e18. e.g. 1e12 ≈ 0.0001% per block.
    uint256 public interestRatePerBlock;
    /// @notice Hard cap on outstanding debt.
    uint256 public maxBorrow;
    /// @notice Once true, no further borrows are allowed.
    bool public bankrupt;

    event LoanChanged(uint256 newPrincipal, uint256 ratePerBlock, uint256 maxBorrow);
    event InterestAccrued(uint256 added, uint256 newPrincipal, uint256 atBlock);
    event Bankruptcy(uint256 deficit, uint256 atBlock);
    event BorrowerSet(address indexed borrower);

    error NotBorrower();
    error AlreadyBankrupt();
    error ExceedsMax();

    constructor(
        address initialOwner,
        ParkToken parkToken_,
        address borrower_,
        uint256 maxBorrow_,
        uint256 interestRatePerBlock_
    ) Ownable(initialOwner) {
        parkToken = parkToken_;
        borrower = borrower_;
        maxBorrow = maxBorrow_;
        interestRatePerBlock = interestRatePerBlock_;
        lastAccruedBlock = block.number;
        emit BorrowerSet(borrower_);
        emit LoanChanged(0, interestRatePerBlock_, maxBorrow_);
    }

    modifier accrue() {
        _accrue();
        _;
    }

    function _accrue() internal {
        uint256 blocks = block.number - lastAccruedBlock;
        if (blocks > 0 && principal > 0 && interestRatePerBlock > 0) {
            uint256 interest = (principal * interestRatePerBlock * blocks) / 1e18;
            if (interest > 0) {
                principal += interest;
                emit InterestAccrued(interest, principal, block.number);
            }
        }
        lastAccruedBlock = block.number;
    }

    function setBorrower(address borrower_) external onlyOwner accrue {
        borrower = borrower_;
        emit BorrowerSet(borrower_);
    }

    function setRate(uint256 interestRatePerBlock_) external onlyOwner accrue {
        interestRatePerBlock = interestRatePerBlock_;
        emit LoanChanged(principal, interestRatePerBlock_, maxBorrow);
    }

    function setMaxBorrow(uint256 maxBorrow_) external onlyOwner {
        maxBorrow = maxBorrow_;
        emit LoanChanged(principal, interestRatePerBlock, maxBorrow_);
    }

    function borrow(uint256 amount) external accrue {
        if (msg.sender != borrower) revert NotBorrower();
        if (bankrupt) revert AlreadyBankrupt();
        if (principal + amount > maxBorrow) revert ExceedsMax();
        principal += amount;
        parkToken.mint(borrower, amount);
        emit LoanChanged(principal, interestRatePerBlock, maxBorrow);
    }

    /// @notice Repay up to `amount`; caps at `principal`. Burns PARK from the borrower.
    function repay(uint256 amount) external accrue {
        if (msg.sender != borrower) revert NotBorrower();
        uint256 toBurn = amount > principal ? principal : amount;
        principal -= toBurn;
        parkToken.burn(borrower, toBurn);
        emit LoanChanged(principal, interestRatePerBlock, maxBorrow);
    }

    /// @notice Off-chain trigger: when the sidecar detects insolvency it calls this.
    function declareBankruptcy() external onlyOwner accrue {
        if (bankrupt) revert AlreadyBankrupt();
        bankrupt = true;
        emit Bankruptcy(principal, block.number);
    }

    /// @notice Read-only debt including unaccrued interest at the current block.
    function currentDebt() external view returns (uint256) {
        if (principal == 0 || interestRatePerBlock == 0) return principal;
        uint256 blocks = block.number - lastAccruedBlock;
        if (blocks == 0) return principal;
        uint256 interest = (principal * interestRatePerBlock * blocks) / 1e18;
        return principal + interest;
    }
}
