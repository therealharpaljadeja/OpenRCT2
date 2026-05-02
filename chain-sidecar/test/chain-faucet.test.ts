import {test} from "node:test";
import assert from "node:assert/strict";
import {parkLaunchSetup, type FaucetWriter} from "../src/chain/index.js";

/// In-memory FaucetWriter stub that records calls for assertion. Lets us test the
/// orchestration logic (length-mismatch checks, ordering, return shape) without standing up
/// a real RPC endpoint or signing keys.
function mockFaucet(): {
    writer: FaucetWriter;
    parkCalls: Array<{to: `0x${string}`; amount: bigint}>;
    monCalls: Array<{addrs: readonly `0x${string}`[]; amounts: readonly bigint[]}>;
} {
    const parkCalls: Array<{to: `0x${string}`; amount: bigint}> = [];
    const monCalls: Array<{addrs: readonly `0x${string}`[]; amounts: readonly bigint[]}> = [];
    let nonce = 1n;
    const writer: FaucetWriter = {
        async dripPark(to, amount) {
            parkCalls.push({to, amount});
            return `0x${(nonce++).toString(16).padStart(64, "0")}` as `0x${string}`;
        },
        async dripMon(addrs, amounts) {
            monCalls.push({addrs, amounts});
            return `0x${(nonce++).toString(16).padStart(64, "0")}` as `0x${string}`;
        },
    };
    return {writer, parkCalls, monCalls};
}

const TREASURY = "0xf1A95d2689E2949ff128Cb943E9BF564e6f91beD" as const;
const RELAYERS: readonly `0x${string}`[] = [
    "0x0000000000000000000000000000000000000A11",
    "0x0000000000000000000000000000000000000A22",
    "0x0000000000000000000000000000000000000A33",
];

test("parkLaunchSetup drips PARK to the treasury then MON to all relayers", async () => {
    const {writer, parkCalls, monCalls} = mockFaucet();
    const result = await parkLaunchSetup(writer, {
        treasury: TREASURY,
        relayers: RELAYERS,
        parkAmount: 1_000_000n * 10n ** 18n,
        monPerRelayer: 50_000_000_000_000_000n, // 0.05 MON
    });
    assert.equal(parkCalls.length, 1);
    assert.equal(parkCalls[0]!.to, TREASURY);
    assert.equal(parkCalls[0]!.amount, 1_000_000n * 10n ** 18n);
    assert.equal(monCalls.length, 1);
    assert.deepEqual(monCalls[0]!.addrs, RELAYERS);
    assert.deepEqual(
        monCalls[0]!.amounts,
        [50_000_000_000_000_000n, 50_000_000_000_000_000n, 50_000_000_000_000_000n],
    );
    assert.match(result.parkTx, /^0x[0-9a-f]{64}$/);
    assert.match(result.monTx, /^0x[0-9a-f]{64}$/);
});

test("parkLaunchSetup orders PARK before MON so treasury is solvent before relayers can push tx", async () => {
    let order: string[] = [];
    const writer: FaucetWriter = {
        async dripPark() {
            order.push("park");
            return "0x1" as `0x${string}`;
        },
        async dripMon() {
            order.push("mon");
            return "0x2" as `0x${string}`;
        },
    };
    await parkLaunchSetup(writer, {
        treasury: TREASURY,
        relayers: RELAYERS,
        parkAmount: 1n,
        monPerRelayer: 1n,
    });
    assert.deepEqual(order, ["park", "mon"]);
});
