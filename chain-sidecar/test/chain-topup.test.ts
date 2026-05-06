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
            permitNonce: async () => 0n,
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
        permitNonce: async () => 0n,
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

// ---- M3.12 — onRelayerFunded callback + requestImmediate ----

test("M3.12: onRelayerFunded fires for every healthy relayer per tick (refilled + already-healthy)", async () => {
    const balances = mockBalances({
        [RELAYERS[0]!]: 0n, // under water → drip
        [RELAYERS[1]!]: TARGET, // already healthy
        [RELAYERS[2]!]: 0n, // under water → drip
    });
    const faucet = mockFaucet();
    const funded: Array<{idx: number; addr: `0x${string}`}> = [];
    const topup = new RelayerTopUp(balances.reader, faucet.writer, {
        relayers: RELAYERS,
        lowWater: LOW_WATER,
        target: TARGET,
        onRelayerFunded: (idx, addr) => funded.push({idx, addr}),
    });

    await topup.tickOnce();

    // All 3 relayers are healthy after the tick (0 + 2 dripped to target, 1 was already
    // healthy). The callback fires once per healthy relayer to clear any stale
    // lowBalance flag the pool may be holding.
    assert.equal(funded.length, 3);
    assert.deepEqual(
        funded.map((f) => f.idx).sort((a, b) => a - b),
        [0, 1, 2],
    );
    assert.equal(faucet.monCalls.length, 1, "exactly one drip tx for the 2 under-water relayers");
});

test("M3.12: onRelayerFunded fires for healthy relayers even with no drip", async () => {
    const balances = mockBalances({
        [RELAYERS[0]!]: TARGET,
        [RELAYERS[1]!]: TARGET,
        [RELAYERS[2]!]: TARGET,
    });
    const faucet = mockFaucet();
    const funded: number[] = [];
    const topup = new RelayerTopUp(balances.reader, faucet.writer, {
        relayers: RELAYERS,
        lowWater: LOW_WATER,
        target: TARGET,
        onRelayerFunded: (idx) => funded.push(idx),
    });
    await topup.tickOnce();
    // All 3 are healthy → all 3 fire, even though no drip happened. This is what unsticks a
    // pool whose lowBalance flag is set but the chain says the relayer is fine.
    assert.equal(funded.length, 3);
    assert.equal(faucet.monCalls.length, 0, "no drip when all are healthy");
});

test("M3.12: onRelayerFunded does NOT fire for relayers still under water after a tick", async () => {
    // A degenerate case where dripMon throws — the under-water relayers stay under water,
    // so they shouldn't be reported as healthy. The healthy one still fires.
    const balances = mockBalances({
        [RELAYERS[0]!]: 0n,
        [RELAYERS[1]!]: TARGET,
        [RELAYERS[2]!]: 0n,
    });
    const faucet: FaucetWriter = {
        async dripPark() {
            throw new Error("not used");
        },
        async dripMon() {
            throw new Error("dripMon failed");
        },
    };
    const funded: number[] = [];
    const topup = new RelayerTopUp(balances.reader, faucet, {
        relayers: RELAYERS,
        lowWater: LOW_WATER,
        target: TARGET,
        onRelayerFunded: (idx) => funded.push(idx),
    });
    await assert.rejects(() => topup.tickOnce());
    // The drip tx threw — no healthy callbacks fire either (we bail before the loop).
    assert.equal(funded.length, 0);
});

test("M3.12: misbehaving onRelayerFunded callback doesn't poison the loop", async () => {
    const balances = mockBalances({
        [RELAYERS[0]!]: 0n,
        [RELAYERS[1]!]: 0n,
        [RELAYERS[2]!]: 0n,
    });
    const faucet = mockFaucet();
    const seen: number[] = [];
    const topup = new RelayerTopUp(balances.reader, faucet.writer, {
        relayers: RELAYERS,
        lowWater: LOW_WATER,
        target: TARGET,
        onRelayerFunded: (idx) => {
            seen.push(idx);
            if (idx === 1) throw new Error("callback bug for relayer 1");
        },
    });
    await topup.tickOnce();
    assert.deepEqual(
        seen.sort((a, b) => a - b),
        [0, 1, 2],
    );
    assert.equal(faucet.monCalls.length, 1);
});

test("M3.12: requestImmediate wakes the loop early", async () => {
    const balances = mockBalances({
        [RELAYERS[0]!]: TARGET,
        [RELAYERS[1]!]: TARGET,
        [RELAYERS[2]!]: TARGET,
    });
    const faucet = mockFaucet();
    let tickCount = 0;
    const reader: BalanceReader = {
        nativeBalance: async () => 0n,
        parkBalance: async () => 0n,
        nativeBalances: async (addrs) => {
            tickCount++;
            return addrs.map(() => TARGET);
        },
        permitNonce: async () => 0n,
    };
    const topup = new RelayerTopUp(reader, faucet.writer, {
        relayers: RELAYERS,
        lowWater: LOW_WATER,
        target: TARGET,
        intervalMs: 5_000, // long interval — wouldn't fire on its own during the test
    });
    topup.start();
    while (tickCount < 1) await sleep(5);
    const t0 = Date.now();
    topup.requestImmediate();
    while (tickCount < 2) await sleep(5);
    const elapsed = Date.now() - t0;
    await topup.stop();
    assert.ok(elapsed < 1000, `requestImmediate should wake quickly; elapsed=${elapsed}ms`);
    assert.equal(tickCount, 2);
});

test("M3.12: requestImmediate is safe to call before start()", () => {
    const balances = mockBalances({});
    const faucet = mockFaucet();
    const topup = new RelayerTopUp(balances.reader, faucet.writer, {
        relayers: RELAYERS,
        lowWater: LOW_WATER,
        target: TARGET,
        intervalMs: 100,
    });
    assert.doesNotThrow(() => topup.requestImmediate());
});

test("M3.12: requestImmediate is idempotent within one wait window", async () => {
    let tickCount = 0;
    const reader: BalanceReader = {
        nativeBalance: async () => 0n,
        parkBalance: async () => 0n,
        nativeBalances: async (addrs) => {
            tickCount++;
            return addrs.map(() => TARGET);
        },
        permitNonce: async () => 0n,
    };
    const faucet = mockFaucet();
    const topup = new RelayerTopUp(reader, faucet.writer, {
        relayers: RELAYERS,
        lowWater: LOW_WATER,
        target: TARGET,
        intervalMs: 5_000,
    });
    topup.start();
    while (tickCount < 1) await sleep(5);
    // Three rapid requestImmediate calls during the same sleep window.
    topup.requestImmediate();
    topup.requestImmediate();
    topup.requestImmediate();
    while (tickCount < 2) await sleep(5);
    await sleep(200); // give the loop time to settle.
    await topup.stop();
    // Don't expect 4 — collapsed to 2 (initial natural + one immediate).
    assert.ok(tickCount < 4, `expected < 4 ticks, saw ${tickCount}`);
});
