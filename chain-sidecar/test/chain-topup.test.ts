import {test} from "node:test";
import assert from "node:assert/strict";
import {RelayerTopUp, type BalanceReader, type FaucetWriter} from "../src/chain/index.js";

const RELAYERS: readonly `0x${string}`[] = [
    "0x0000000000000000000000000000000000000A11",
    "0x0000000000000000000000000000000000000A22",
    "0x0000000000000000000000000000000000000A33",
];

/// Mutable balance map so tests can simulate a relayer dropping below the low-water mark
/// and verify the top-up brings it back to target. Defaults to "everyone has plenty".
function mockBalances(initial: Record<`0x${string}`, bigint>): {
    reader: BalanceReader;
    set(addr: `0x${string}`, bal: bigint): void;
} {
    const balances: Record<string, bigint> = {...initial};
    return {
        set(addr, bal) {
            balances[addr] = bal;
        },
        reader: {
            nativeBalance: async (a) => balances[a] ?? 0n,
            parkBalance: async () => 0n,
            nativeBalances: async (addrs) => addrs.map((a) => balances[a] ?? 0n),
        },
    };
}

function mockFaucet(): {
    writer: FaucetWriter;
    monCalls: Array<{addrs: readonly `0x${string}`[]; amounts: readonly bigint[]}>;
} {
    const monCalls: Array<{addrs: readonly `0x${string}`[]; amounts: readonly bigint[]}> = [];
    let nonce = 1n;
    return {
        monCalls,
        writer: {
            async dripPark() {
                throw new Error("dripPark should not be called by RelayerTopUp");
            },
            async dripMon(addrs, amounts) {
                monCalls.push({addrs, amounts});
                return `0x${(nonce++).toString(16).padStart(64, "0")}` as `0x${string}`;
            },
        },
    };
}

const ONE_MON = 10n ** 18n;
const LOW_WATER = ONE_MON / 100n; // 0.01 MON
const TARGET = ONE_MON / 10n; // 0.1 MON

test("RelayerTopUp validates target > lowWater", () => {
    const balances = mockBalances({});
    const faucet = mockFaucet();
    assert.throws(
        () =>
            new RelayerTopUp(balances.reader, faucet.writer, {
                relayers: RELAYERS,
                lowWater: 100n,
                target: 100n,
            }),
        /target.*must exceed lowWater/,
    );
});

test("RelayerTopUp validates non-empty relayer list", () => {
    const balances = mockBalances({});
    const faucet = mockFaucet();
    assert.throws(
        () =>
            new RelayerTopUp(balances.reader, faucet.writer, {
                relayers: [],
                lowWater: LOW_WATER,
                target: TARGET,
            }),
        /empty relayer list/,
    );
});

test("tickOnce skips refill when all relayers are above the low-water mark", async () => {
    const balances = mockBalances({
        [RELAYERS[0]!]: TARGET,
        [RELAYERS[1]!]: TARGET,
        [RELAYERS[2]!]: TARGET,
    });
    const faucet = mockFaucet();
    const topup = new RelayerTopUp(balances.reader, faucet.writer, {
        relayers: RELAYERS,
        lowWater: LOW_WATER,
        target: TARGET,
    });
    const refilled = await topup.tickOnce();
    assert.equal(refilled, false);
    assert.equal(faucet.monCalls.length, 0);
    const stats = topup.stats();
    assert.equal(stats.lastRefilled, 0);
    assert.equal(stats.refillTxCount, 0);
    assert.equal(Object.keys(stats.lastBalances).length, 3);
});

test("tickOnce refills only the under-threshold subset and brings each to target", async () => {
    const balances = mockBalances({
        [RELAYERS[0]!]: 0n, // empty — needs full target
        [RELAYERS[1]!]: TARGET, // healthy
        [RELAYERS[2]!]: LOW_WATER / 2n, // partially drained
    });
    const faucet = mockFaucet();
    const topup = new RelayerTopUp(balances.reader, faucet.writer, {
        relayers: RELAYERS,
        lowWater: LOW_WATER,
        target: TARGET,
    });
    const refilled = await topup.tickOnce();
    assert.equal(refilled, true);
    assert.equal(faucet.monCalls.length, 1);
    const call = faucet.monCalls[0]!;
    assert.deepEqual(call.addrs, [RELAYERS[0]!, RELAYERS[2]!]);
    assert.deepEqual(call.amounts, [TARGET, TARGET - LOW_WATER / 2n]);
    const stats = topup.stats();
    assert.equal(stats.lastRefilled, 2);
    assert.equal(stats.refillTxCount, 1);
    assert.equal(stats.refillRelayerCount, 2);
    assert.match(stats.lastRefillTx ?? "", /^0x[0-9a-f]{64}$/);
});

test("tickOnce treats balance == lowWater as healthy (strict less-than threshold)", async () => {
    const balances = mockBalances({
        [RELAYERS[0]!]: LOW_WATER,
        [RELAYERS[1]!]: LOW_WATER,
        [RELAYERS[2]!]: LOW_WATER,
    });
    const faucet = mockFaucet();
    const topup = new RelayerTopUp(balances.reader, faucet.writer, {
        relayers: RELAYERS,
        lowWater: LOW_WATER,
        target: TARGET,
    });
    const refilled = await topup.tickOnce();
    assert.equal(refilled, false);
});

test("tickOnce records balances in stats even when no refill is needed", async () => {
    const balances = mockBalances({
        [RELAYERS[0]!]: TARGET,
        [RELAYERS[1]!]: TARGET,
        [RELAYERS[2]!]: TARGET,
    });
    const faucet = mockFaucet();
    const topup = new RelayerTopUp(balances.reader, faucet.writer, {
        relayers: RELAYERS,
        lowWater: LOW_WATER,
        target: TARGET,
    });
    await topup.tickOnce();
    const stats = topup.stats();
    assert.equal(stats.lastBalances[RELAYERS[0]!], TARGET.toString());
    assert.ok(stats.lastCheckedAt > 0);
});

test("RelayerTopUp loop runs ticks on its interval and stops cleanly", async () => {
    const balances = mockBalances({
        [RELAYERS[0]!]: 0n,
        [RELAYERS[1]!]: 0n,
        [RELAYERS[2]!]: 0n,
    });
    const faucet = mockFaucet();
    const topup = new RelayerTopUp(balances.reader, faucet.writer, {
        relayers: RELAYERS,
        lowWater: LOW_WATER,
        target: TARGET,
        intervalMs: 30, // tight for the test
    });
    topup.start();
    // Wait until at least one refill happened.
    const start = Date.now();
    while (faucet.monCalls.length === 0 && Date.now() - start < 1000) {
        await sleep(10);
    }
    await topup.stop();
    assert.ok(faucet.monCalls.length >= 1, "expected at least one tick to refill");
});

test("RelayerTopUp loop survives a transient balance-read failure", async () => {
    let failed = false;
    const reader: BalanceReader = {
        nativeBalance: async () => 0n,
        parkBalance: async () => 0n,
        nativeBalances: async () => {
            if (!failed) {
                failed = true;
                throw new Error("simulated RPC failure");
            }
            return RELAYERS.map(() => TARGET);
        },
    };
    const faucet = mockFaucet();
    const topup = new RelayerTopUp(reader, faucet.writer, {
        relayers: RELAYERS,
        lowWater: LOW_WATER,
        target: TARGET,
        intervalMs: 20,
    });
    topup.start();
    // Wait for at least 2 ticks: the failing one + the recovery one.
    await sleep(150);
    await topup.stop();
    const stats = topup.stats();
    assert.ok(stats.errors >= 1, "should have logged at least one tick error");
    assert.equal(faucet.monCalls.length, 0, "second tick saw healthy balances; no refill");
});

function sleep(ms: number): Promise<void> {
    return new Promise((r) => setTimeout(r, ms));
}
