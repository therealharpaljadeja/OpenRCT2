// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";
import {Deploy} from "../script/Deploy.s.sol";

/// @dev Exercises the deploy script's `_deploy` path (without broadcasting or writing JSON)
///      so regressions in the live wiring fail this test instead of silently producing a
///      half-wired stack on testnet. We inherit `Deploy` to call its internal helper directly.
contract DeployTest is Test, Deploy {
    function test_DeployedStackIsWired() public {
        Stack memory s = _deploy(address(this), 1_000_000e18, 1e12);

        // Minters: Faucet and LendingPool both need PARK mint authority. Anything else
        // doesn't, and granting it would be a foot-gun.
        assertTrue(s.parkToken.minters(address(s.faucet)), "faucet should be minter");
        assertTrue(s.parkToken.minters(address(s.lendingPool)), "lendingPool should be minter");

        // LendingPool's sole borrower is the treasury — see ONCHAIN_PLAN.md §9.
        assertEq(s.lendingPool.borrower(), address(s.treasury), "lending pool borrower wrong");

        // Batcher reads venue metadata from the registry it was deployed with, not just any
        // VenueRegistry — verify they match.
        assertEq(address(s.settlementBatcher.venueRegistry()), address(s.venueRegistry));
        assertEq(address(s.settlementBatcher.token()), address(s.parkToken));

        // Loan params propagate from the run-time arguments (env vars in production).
        assertEq(s.lendingPool.maxBorrow(), s.loanMaxBorrow);
        assertEq(s.lendingPool.interestRatePerBlock(), s.loanRatePerBlock);
    }
}
