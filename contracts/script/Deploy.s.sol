// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Script} from "forge-std/Script.sol";
import {console2} from "forge-std/console2.sol";
import {ParkToken} from "../src/ParkToken.sol";
import {Faucet} from "../src/Faucet.sol";
import {Disperse} from "../src/Disperse.sol";
import {ParkTreasury} from "../src/ParkTreasury.sol";
import {LendingPool} from "../src/LendingPool.sol";
import {GuestRegistry} from "../src/GuestRegistry.sol";
import {VenueRegistry} from "../src/VenueRegistry.sol";
import {SettlementBatcher} from "../src/SettlementBatcher.sol";

/// @title Deploy — bootstraps the full on-chain stack and writes a deployments artifact.
/// @notice Deploys the singleton globals (`ParkToken`, `Faucet`, `Disperse`) and a default
///         per-park stack (`ParkTreasury`, `LendingPool`, `GuestRegistry`, `VenueRegistry`,
///         `SettlementBatcher`) with the wiring the plan describes (Faucet + LendingPool
///         hold the PARK minter role; LendingPool's borrower is the demo treasury).
///
///         Run with:
///           forge script script/Deploy.s.sol:Deploy \
///             --rpc-url monad_testnet --broadcast --verify -vvvv
///
///         On success, writes `deployments/monad-testnet.json` with all addresses, the
///         deploy block, deployer, and the demo loan parameters. Re-running overwrites
///         that file with a fresh stack — keep the prior file if you need history.
contract Deploy is Script {
    /// @dev Tunable demo loan parameters; sane defaults if env vars are absent.
    ///      `1e12` per-block ≈ 0.0001%/block (~3% per million blocks).
    uint256 internal constant DEFAULT_LOAN_MAX_BORROW = 1_000_000e18;
    uint256 internal constant DEFAULT_LOAN_RATE_PER_BLOCK = 1e12;

    struct Stack {
        ParkToken parkToken;
        Faucet faucet;
        Disperse disperse;
        ParkTreasury treasury;
        LendingPool lendingPool;
        GuestRegistry guestRegistry;
        VenueRegistry venueRegistry;
        SettlementBatcher settlementBatcher;
        address deployer;
        uint256 startBlock;
        uint256 loanMaxBorrow;
        uint256 loanRatePerBlock;
    }

    function run() external {
        uint256 deployerKey = vm.envUint("DEPLOYER_PRIVATE_KEY");
        address deployer = vm.addr(deployerKey);

        uint256 loanMaxBorrow = vm.envOr("LOAN_MAX_BORROW", DEFAULT_LOAN_MAX_BORROW);
        uint256 loanRatePerBlock = vm.envOr("LOAN_RATE_PER_BLOCK", DEFAULT_LOAN_RATE_PER_BLOCK);

        console2.log("Deployer:", deployer);
        console2.log("Chain id:", block.chainid);
        console2.log("Block:", block.number);

        vm.startBroadcast(deployerKey);
        Stack memory s = _deploy(deployer, loanMaxBorrow, loanRatePerBlock);
        vm.stopBroadcast();

        _logStack(s);
        _writeDeployments(s);
    }

    function _deploy(address deployer, uint256 loanMaxBorrow, uint256 loanRatePerBlock)
        internal
        returns (Stack memory s)
    {
        s.deployer = deployer;
        s.startBlock = block.number;
        s.loanMaxBorrow = loanMaxBorrow;
        s.loanRatePerBlock = loanRatePerBlock;

        // Globals.
        s.parkToken = new ParkToken(deployer);
        s.faucet = new Faucet(deployer, s.parkToken);
        s.parkToken.setMinter(address(s.faucet), true);
        s.disperse = new Disperse();

        // Demo per-park stack. Sidecar may later redeploy these via CREATE2 keyed on
        // park-save UUID; this instance is the reference deployment used by tests,
        // the in-game agent's smoke checks, and the indexer's bootstrap config.
        s.treasury = new ParkTreasury(deployer);
        s.lendingPool = new LendingPool(deployer, s.parkToken, address(s.treasury), loanMaxBorrow, loanRatePerBlock);
        s.parkToken.setMinter(address(s.lendingPool), true);
        s.guestRegistry = new GuestRegistry(deployer);
        s.venueRegistry = new VenueRegistry(deployer);
        s.settlementBatcher = new SettlementBatcher(s.parkToken, s.venueRegistry);
    }

    function _logStack(Stack memory s) internal pure {
        console2.log("--- Globals ---");
        console2.log("ParkToken         :", address(s.parkToken));
        console2.log("Faucet            :", address(s.faucet));
        console2.log("Disperse          :", address(s.disperse));
        console2.log("--- Demo park ---");
        console2.log("ParkTreasury      :", address(s.treasury));
        console2.log("LendingPool       :", address(s.lendingPool));
        console2.log("GuestRegistry     :", address(s.guestRegistry));
        console2.log("VenueRegistry     :", address(s.venueRegistry));
        console2.log("SettlementBatcher :", address(s.settlementBatcher));
    }

    /// @dev Builds a stable two-level JSON document and writes it to
    ///      `deployments/monad-testnet.json`. Consumers (`sidecar`, `rctctl`, indexer)
    ///      should read it as { chainId, deployer, startBlock, globals{}, demoPark{}, loan{} }.
    function _writeDeployments(Stack memory s) internal {
        string memory globals = "globals";
        vm.serializeAddress(globals, "parkToken", address(s.parkToken));
        vm.serializeAddress(globals, "faucet", address(s.faucet));
        string memory globalsJson = vm.serializeAddress(globals, "disperse", address(s.disperse));

        string memory demo = "demoPark";
        vm.serializeAddress(demo, "treasury", address(s.treasury));
        vm.serializeAddress(demo, "lendingPool", address(s.lendingPool));
        vm.serializeAddress(demo, "guestRegistry", address(s.guestRegistry));
        vm.serializeAddress(demo, "venueRegistry", address(s.venueRegistry));
        string memory demoJson = vm.serializeAddress(demo, "settlementBatcher", address(s.settlementBatcher));

        string memory loan = "loan";
        vm.serializeUint(loan, "maxBorrow", s.loanMaxBorrow);
        string memory loanJson = vm.serializeUint(loan, "ratePerBlock", s.loanRatePerBlock);

        string memory root = "root";
        vm.serializeUint(root, "chainId", block.chainid);
        vm.serializeAddress(root, "deployer", s.deployer);
        vm.serializeUint(root, "startBlock", s.startBlock);
        vm.serializeString(root, "globals", globalsJson);
        vm.serializeString(root, "demoPark", demoJson);
        string memory rootJson = vm.serializeString(root, "loan", loanJson);

        string memory path = string.concat(vm.projectRoot(), "/deployments/monad-testnet.json");
        vm.writeJson(rootJson, path);
        console2.log("Wrote", path);
    }
}
