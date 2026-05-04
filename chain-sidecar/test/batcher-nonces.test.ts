import {test} from "node:test";
import assert from "node:assert/strict";
import {SpendNonceTracker} from "../src/batcher/nonces.js";

/// Per-guest sig-nonce tracker (M3.11). Tests use the injectable `fetchInitialNonce` form so
/// no chain client is needed; the chain-backed branch is exercised via the integration test
/// that boots the dispatcher against a stubbed publicClient.

const ADDR_A = "0x0000000000000000000000000000000000000001" as const;
const ADDR_B = "0x0000000000000000000000000000000000000002" as const;
const ADDR_A_UPPER = "0x0000000000000000000000000000000000000001".toUpperCase() as `0x${string}`;

test("rejects malformed settlementBatcher in chain-mode constructor", () => {
    assert.throws(() => {
        new SpendNonceTracker({
            publicClient: {} as never,
            settlementBatcher: "not-an-address" as `0x${string}`,
        });
    }, /not a 20-byte hex address/);
});

test("first-touch fetches from chain, then advances locally", async () => {
    const fetched: string[] = [];
    const t = new SpendNonceTracker({
        fetchInitialNonce: async (addr) => {
            fetched.push(addr);
            return 0n;
        },
    });
    assert.equal(await t.next(ADDR_A), 0n);
    assert.equal(await t.next(ADDR_A), 1n);
    assert.equal(await t.next(ADDR_A), 2n);
    assert.equal(fetched.length, 1, "only one chain read for repeated calls on the same address");
});

test("first-touch honors a non-zero chain value (cross-restart recovery)", async () => {
    const t = new SpendNonceTracker({
        fetchInitialNonce: async () => 42n,
    });
    assert.equal(await t.next(ADDR_A), 42n);
    assert.equal(await t.next(ADDR_A), 43n);
});

test("nonces are tracked independently per address", async () => {
    const t = new SpendNonceTracker({
        fetchInitialNonce: async () => 0n,
    });
    assert.equal(await t.next(ADDR_A), 0n);
    assert.equal(await t.next(ADDR_B), 0n);
    assert.equal(await t.next(ADDR_A), 1n);
    assert.equal(await t.next(ADDR_B), 1n);
});

test("address lookup is case-insensitive (checksum vs lower-case)", async () => {
    const t = new SpendNonceTracker({
        fetchInitialNonce: async () => 0n,
    });
    assert.equal(await t.next(ADDR_A), 0n);
    // Upper-case form of the same address should hit the same bucket.
    assert.equal(await t.next(ADDR_A_UPPER), 1n);
    assert.equal(t.peek(ADDR_A), 2n);
    assert.equal(t.peek(ADDR_A_UPPER), 2n);
});

test("forget drops an address from the cache", async () => {
    let chainValue = 5n;
    const t = new SpendNonceTracker({
        fetchInitialNonce: async () => chainValue,
    });
    assert.equal(await t.next(ADDR_A), 5n);
    assert.equal(await t.next(ADDR_A), 6n);
    t.forget(ADDR_A);
    // After forget, next() should re-fetch from chain — caller's mock can return a different
    // value to prove this.
    chainValue = 99n;
    assert.equal(await t.next(ADDR_A), 99n);
});

test("forget on unknown address is a no-op", async () => {
    const t = new SpendNonceTracker({
        fetchInitialNonce: async () => 0n,
    });
    assert.doesNotThrow(() => t.forget(ADDR_A));
    assert.equal(t.stats().size, 0);
});

test("stats track size + chain-fetch count", async () => {
    let calls = 0;
    const t = new SpendNonceTracker({
        fetchInitialNonce: async () => {
            calls++;
            return 0n;
        },
    });
    await t.next(ADDR_A);
    await t.next(ADDR_A); // local-only
    await t.next(ADDR_B);
    assert.equal(calls, 2, "one fetch per fresh address");
    assert.equal(t.stats().size, 2);
    assert.equal(t.stats().fetches, 2);
});

test("concurrent first-touches share one chain read and produce distinct nonces", async () => {
    let calls = 0;
    let release: (() => void) | undefined;
    const fetchPromise = new Promise<bigint>((resolve) => {
        release = () => resolve(0n);
    });
    const t = new SpendNonceTracker({
        fetchInitialNonce: () => {
            calls++;
            return fetchPromise;
        },
    });

    // Fire two concurrent requests for the same address. Both should park on the in-flight
    // fetch; once it resolves, they should each get a distinct nonce in [0, 1].
    const p1 = t.next(ADDR_A);
    const p2 = t.next(ADDR_A);
    release!();
    const [n1, n2] = await Promise.all([p1, p2]);

    assert.equal(calls, 1, "single chain read shared across concurrent first-touches");
    assert.deepEqual(new Set([n1, n2]), new Set([0n, 1n]), "two callers see distinct consecutive nonces");
});

test("transient fetch failure doesn't poison the cache", async () => {
    let attempts = 0;
    const t = new SpendNonceTracker({
        fetchInitialNonce: async () => {
            attempts++;
            if (attempts === 1) throw new Error("rpc transient");
            return 7n;
        },
    });
    await assert.rejects(() => t.next(ADDR_A), /rpc transient/);
    assert.equal(t.stats().size, 0, "failed fetch leaves cache empty");
    // Retry succeeds and starts from the chain value.
    assert.equal(await t.next(ADDR_A), 7n);
    assert.equal(await t.next(ADDR_A), 8n);
});

test("peek doesn't trigger a fetch", () => {
    let calls = 0;
    const t = new SpendNonceTracker({
        fetchInitialNonce: async () => {
            calls++;
            return 0n;
        },
    });
    assert.equal(t.peek(ADDR_A), undefined);
    assert.equal(calls, 0);
});

test("invalidate forces re-fetch from chain on next call", async () => {
    let chainValue = 0n;
    const t = new SpendNonceTracker({
        fetchInitialNonce: async () => chainValue,
    });
    // Prime: chain says 0, local advances to 3 across three calls.
    assert.equal(await t.next(ADDR_A), 0n);
    assert.equal(await t.next(ADDR_A), 1n);
    assert.equal(await t.next(ADDR_A), 2n);
    assert.equal(t.peek(ADDR_A), 3n);

    // Suppose those three auths failed terminally on chain — chain still at 0.
    // Invalidate forces a re-fetch on the next call.
    t.invalidate([ADDR_A]);
    assert.equal(t.stats().invalidations, 1);
    assert.equal(t.stats().stale, 1);
    // Chain still at 0; the re-fetch returns 0, then increments locally to 1.
    assert.equal(await t.next(ADDR_A), 0n);
    assert.equal(t.stats().stale, 0, "stale flag cleared after re-fetch");
});

test("invalidate is idempotent and accepts unknown addresses", async () => {
    const t = new SpendNonceTracker({fetchInitialNonce: async () => 0n});
    // Invalidating an address never touched: not an error.
    assert.doesNotThrow(() => t.invalidate([ADDR_A]));
    // Twice: still fine.
    assert.doesNotThrow(() => t.invalidate([ADDR_A, ADDR_A]));
    assert.equal(t.stats().invalidations, 3);
    assert.equal(t.stats().stale, 1);
    // Still works correctly when the cache is empty.
    assert.equal(await t.next(ADDR_A), 0n);
});

test("invalidate then next picks up the chain's current value, not the stale local", async () => {
    let chainValue = 5n;
    const t = new SpendNonceTracker({
        fetchInitialNonce: async () => chainValue,
    });
    assert.equal(await t.next(ADDR_A), 5n);
    assert.equal(await t.next(ADDR_A), 6n);

    // Chain advances asynchronously (e.g. a successful batch landed for this guest from
    // some other operator); we invalidate; the next call observes the new chain value.
    chainValue = 12n;
    t.invalidate([ADDR_A]);
    assert.equal(await t.next(ADDR_A), 12n);
    assert.equal(await t.next(ADDR_A), 13n);
});

test("forget clears any pending invalidation flag", async () => {
    const t = new SpendNonceTracker({fetchInitialNonce: async () => 0n});
    t.invalidate([ADDR_A]);
    assert.equal(t.stats().stale, 1);
    t.forget(ADDR_A);
    assert.equal(t.stats().stale, 0, "forget drops the stale flag too");
});

test("invalidate of multiple addresses bumps both", async () => {
    const t = new SpendNonceTracker({fetchInitialNonce: async () => 7n});
    await t.next(ADDR_A);
    await t.next(ADDR_B);
    t.invalidate([ADDR_A, ADDR_B]);
    assert.equal(t.stats().stale, 2);
    assert.equal(t.stats().invalidations, 2);
});
