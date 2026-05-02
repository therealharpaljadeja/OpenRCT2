// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {ERC20Permit} from "@openzeppelin/contracts/token/ERC20/extensions/ERC20Permit.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

/// @title PARK — in-game ERC-20 currency for the OpenRCT2 × Monad demo.
/// @notice Mint/burn is restricted to addresses on the minter allowlist (Faucet, LendingPool).
/// @dev EIP-2612 permit is used by guests to grant the SettlementBatcher unlimited allowance off-chain.
contract ParkToken is ERC20, ERC20Permit, Ownable {
    mapping(address minter => bool allowed) public minters;

    event MinterSet(address indexed minter, bool allowed);

    error NotMinter();

    modifier onlyMinter() {
        if (!minters[msg.sender]) revert NotMinter();
        _;
    }

    constructor(address initialOwner) ERC20("Park", "PARK") ERC20Permit("Park") Ownable(initialOwner) {}

    function setMinter(address minter, bool allowed) external onlyOwner {
        minters[minter] = allowed;
        emit MinterSet(minter, allowed);
    }

    function mint(address to, uint256 amount) external onlyMinter {
        _mint(to, amount);
    }

    function burn(address from, uint256 amount) external onlyMinter {
        _burn(from, amount);
    }
}
