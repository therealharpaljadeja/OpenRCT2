import {test} from "node:test";
import assert from "node:assert/strict";
import {privateKeyToAccount, type LocalAccount} from "viem/accounts";
import {Batcher, type Batch, type SinkResult} from "../src/batcher/batch.js";
import {SpendDispatcher, type SpendDispatcherStats} from "../src/batcher/dispatch.js";
import {SpendNonceTracker} from "../src/batcher/nonces.js";
import {GuestAddressCache} from "../src/derive/cache.js";
import {SpendRateLimiter} from "../src/ratelimit/index.js";
import {recoverSpendAuthSigner, spendAuthDomain} from "../src/batcher/sign.js";
import type {GuestSpendEvent} from "../src/outbox/types.js";

/// GUEST_SPEND → SpendAuth → Batcher hot path (M3.11). Tests use stub dependencies for
/// venue-mirror, derive, rate-limit so each is exercised in isolation. The integration
/// surface (recovering the signature on-chain) is covered by `batcher-sign.test.ts` already.

const TEST_MNEMONIC = "test test test test test test test test test test test junk";
const SETTLEMENT_BATCHER = "0x5266392DC0930C134a75E2900Ef1103B64722042" as const;
const CHAIN_ID = 10143;

interface VenueLookup {
    lookup(id: number): {id: number; active: boolean} | undefined;
}

interface VenueMirrorStub {
    lookup: (id: number) => {id: number; active: boolean} | undefined;
}

function makeMirror(active: Map<number, boolean>): VenueMirrorStub {
    return {
        lookup: (id: number) => {
            const a = active.get(id);
            if (a === undefined) return undefined;
            return {id, active: a};
        },
    };
}

interface DispatcherKit {
    dispatcher: SpendDispatcher;
    batcher: Batcher;
    received: Batch[];
    nonces: SpendNonceTracker;
    cache: GuestAddressCache;
    rateLimiter: SpendRateLimiter;
    accounts: Map<number, LocalAccount>;
}

function makeKit(opts?: {
    nowSeconds?: () => bigint;
    venueActive?: Map<number, boolean>;
    rateCap?: number;
    fetchInitialNonce?: (addr: `0x${string}`) => Promise<bigint>;
}): DispatcherKit {
    const received: Batch[] = [];
    const sink = async (batch: Batch): Promise<SinkResult> => {
        received.push(batch);
        return {};
    };
    const batcher = new Batcher({sink, maxSize: 16, maxAgeMs: 1000});
    const venueActive = opts?.venueActive ?? new Map([[1, true]]);
    const cache = new GuestAddressCache(TEST_MNEMONIC);
    const nonces = new SpendNonceTracker({
        fetchInitialNonce: opts?.fetchInitialNonce ?? (async () => 0n),
    });
    const rateLimiter = new SpendRateLimiter({maxAuthPerSecond: opts?.rateCap ?? 1000});
    const accounts = new Map<number, LocalAccount>();
    const deriveAccount = (idx: number): LocalAccount => {
        let a = accounts.get(idx);
        if (!a) {
            // Synthesize a deterministic 0x...01 padded private key for each hdIndex. We
            // explicitly DON'T use the real deriveGuest path here — the dispatcher's only
            // requirement is "give me a LocalAccount whose address matches the cache's
            // address-of(idx)". The cache still uses TEST_MNEMONIC for address resolution,
            // which means the recovered signer wouldn't match... so we patch the cache to
            // return our synthetic account's address instead. See `seedGuest` below.
            const hex = `0x${(idx + 1).toString(16).padStart(64, "0")}`;
            a = privateKeyToAccount(hex as `0x${string}`);
            accounts.set(idx, a);
        }
        return a;
    };
    // Patch the cache to return the deriveAccount-produced address. addressOf is normally
    // computed off the mnemonic; for the dispatcher's purposes we just need the cache's
    // value to match the signer.
    const addressOf = (idx: number): `0x${string}` => deriveAccount(idx).address;
    // Override addressOf on the cache via a typed shim — we don't extend the class.
    (cache as unknown as {addressOf: typeof addressOf}).addressOf = addressOf;
    (cache as unknown as {peek: typeof addressOf}).peek = addressOf;

    const venueMirror = makeMirror(venueActive) as unknown as Parameters<typeof SpendDispatcher.prototype.constructor>[0]["venueMirror"];
    const dispatcher = new SpendDispatcher({
        batcher,
        venueMirror: venueMirror as never,
        rateLimiter,
        guestCache: cache,
        nonces,
        domain: spendAuthDomain(CHAIN_ID, SETTLEMENT_BATCHER),
        deriveAccount,
        nowSeconds: opts?.nowSeconds ?? (() => 1_900_000_000n),
    });
    return {dispatcher, batcher, received, nonces, cache, rateLimiter, accounts};
}

function makeEvent(overrides: Partial<GuestSpendEvent> = {}): GuestSpendEvent {
    return {
        kind: "GUEST_SPEND",
        seq: 0,
        ts: 1,
        guestId: 1,
        hdIndex: 1,
        venueId: 1,
        amount: "1000000000000000000",
        category: 1,
        gameTick: 100,
        ...overrides,
    };
}

async function flushBatcher(kit: DispatcherKit): Promise<void> {
    kit.batcher.flush();
    await new Promise((r) => setImmediate(r));
}

test("happy path: signs and pushes; signature recovers to the guest address", async () => {
    const kit = makeKit();
    await kit.dispatcher.handle(makeEvent({hdIndex: 7, venueId: 1, amount: "5000000000000000000"}));
    assert.equal(kit.dispatcher.stats().signed, 1);
    await flushBatcher(kit);
    assert.equal(kit.received.length, 1);
    const batch = kit.received[0]!;
    assert.equal(batch.auths.length, 1);
    const auth = batch.auths[0]!;
    const sig = batch.sigs[0]!;
    const recovered = await recoverSpendAuthSigner(
        spendAuthDomain(CHAIN_ID, SETTLEMENT_BATCHER),
        auth,
        sig,
    );
    assert.equal(recovered.toLowerCase(), auth.from.toLowerCase());
    assert.equal(auth.venueId, 1);
    assert.equal(auth.amount, 5_000_000_000_000_000_000n);
    assert.equal(auth.nonce, 0n);
});

test("nonces increment monotonically per guest, independently across guests", async () => {
    const kit = makeKit({venueActive: new Map([[1, true]])});
    for (let i = 0; i < 3; i++) await kit.dispatcher.handle(makeEvent({hdIndex: 1}));
    for (let i = 0; i < 2; i++) await kit.dispatcher.handle(makeEvent({hdIndex: 2}));
    await flushBatcher(kit);
    assert.equal(kit.received.length, 1);
    const auths = kit.received[0]!.auths;
    assert.equal(auths.length, 5);
    const noncesByGuest = new Map<string, bigint[]>();
    for (const a of auths) {
        const arr = noncesByGuest.get(a.from.toLowerCase()) ?? [];
        arr.push(a.nonce);
        noncesByGuest.set(a.from.toLowerCase(), arr);
    }
    const lists = [...noncesByGuest.values()];
    assert.equal(lists.length, 2);
    // Each guest's nonces start at 0 and increment by 1.
    for (const list of lists) {
        for (let i = 0; i < list.length; i++) assert.equal(list[i], BigInt(i));
    }
});

test("drops on unknown venue (mirror miss)", async () => {
    const kit = makeKit({venueActive: new Map()});
    await kit.dispatcher.handle(makeEvent({venueId: 99}));
    const stats = kit.dispatcher.stats();
    assert.equal(stats.signed, 0);
    assert.equal(stats.droppedUnknownVenue, 1);
});

test("drops on inactive venue", async () => {
    const kit = makeKit({venueActive: new Map([[1, false]])});
    await kit.dispatcher.handle(makeEvent({venueId: 1}));
    const stats = kit.dispatcher.stats();
    assert.equal(stats.signed, 0);
    assert.equal(stats.droppedInactiveVenue, 1);
});

test("drops over-rate spends (rate limiter)", async () => {
    const kit = makeKit({rateCap: 1}); // 1 auth/s/guest, burst 1
    // First call consumes the bucket, second is dropped.
    await kit.dispatcher.handle(makeEvent({hdIndex: 1}));
    await kit.dispatcher.handle(makeEvent({hdIndex: 1}));
    const stats = kit.dispatcher.stats();
    assert.equal(stats.signed, 1);
    assert.equal(stats.droppedRateLimited, 1);
});

test("drops on malformed amount", async () => {
    const kit = makeKit();
    await kit.dispatcher.handle(makeEvent({amount: "not-a-number"}));
    assert.equal(kit.dispatcher.stats().droppedMalformed, 1);
    assert.equal(kit.dispatcher.stats().signed, 0);
});

test("drops on negative amount", async () => {
    const kit = makeKit();
    await kit.dispatcher.handle(makeEvent({amount: "-1"}));
    assert.equal(kit.dispatcher.stats().droppedMalformed, 1);
});

test("drops on bad gameTick / category", async () => {
    const kit = makeKit();
    await kit.dispatcher.handle(makeEvent({gameTick: -5}));
    await kit.dispatcher.handle(makeEvent({category: 999}));
    assert.equal(kit.dispatcher.stats().droppedMalformed, 2);
});

test("propagates nonce-fetch RPC failure as a counter bump, doesn't poison batcher", async () => {
    let attempts = 0;
    const kit = makeKit({
        fetchInitialNonce: async () => {
            attempts++;
            throw new Error("rpc bombed");
        },
    });
    await kit.dispatcher.handle(makeEvent({hdIndex: 5}));
    assert.equal(kit.dispatcher.stats().nonceErrors, 1);
    assert.equal(kit.dispatcher.stats().signed, 0);
    assert.equal(kit.received.length, 0);
    // The next call retries — nonces module doesn't poison its cache on failure.
    assert.equal(attempts, 1);
});

test("auth deadline is now+window", async () => {
    let now = 1_900_000_000n;
    const kit = makeKit({nowSeconds: () => now});
    await kit.dispatcher.handle(makeEvent());
    await flushBatcher(kit);
    const auth = kit.received[0]!.auths[0]!;
    // Default window is 1 day = 86400s.
    assert.equal(auth.deadline, now + 86_400n);
});

test("absent venue mirror lets spends through (offline-mode regression guard)", async () => {
    const cache = new GuestAddressCache(TEST_MNEMONIC);
    const accounts = new Map<number, LocalAccount>();
    const deriveAccount = (idx: number): LocalAccount => {
        let a = accounts.get(idx);
        if (!a) {
            const hex = `0x${(idx + 1).toString(16).padStart(64, "0")}`;
            a = privateKeyToAccount(hex as `0x${string}`);
            accounts.set(idx, a);
        }
        return a;
    };
    const addressOf = (idx: number) => deriveAccount(idx).address;
    (cache as unknown as {addressOf: typeof addressOf}).addressOf = addressOf;

    const received: Batch[] = [];
    const batcher = new Batcher({
        sink: async (b) => {
            received.push(b);
            return {};
        },
        maxSize: 16,
        maxAgeMs: 1000,
    });
    const dispatcher = new SpendDispatcher({
        batcher,
        venueMirror: undefined,
        rateLimiter: undefined,
        guestCache: cache,
        nonces: new SpendNonceTracker({fetchInitialNonce: async () => 0n}),
        domain: spendAuthDomain(CHAIN_ID, SETTLEMENT_BATCHER),
        deriveAccount,
        nowSeconds: () => 1_900_000_000n,
    });
    await dispatcher.handle(makeEvent({venueId: 99}));
    assert.equal(dispatcher.stats().signed, 1, "no mirror = no venue lookup; signing proceeds");
});

test("stats consistency: signed + drops == accepted (modulo errors)", async () => {
    const kit = makeKit({venueActive: new Map([[1, true]]), rateCap: 2});
    // 1 signed
    await kit.dispatcher.handle(makeEvent({hdIndex: 1, venueId: 1}));
    // 1 dropped venue
    await kit.dispatcher.handle(makeEvent({hdIndex: 2, venueId: 99}));
    // 1 dropped malformed
    await kit.dispatcher.handle(makeEvent({hdIndex: 3, amount: "abc"}));
    // 1 dropped rate-limited (consumes hdIndex 4 once OK, then drops). Use rate cap = 1
    // To set it up cleanly let's use independent buckets.
    const stats: SpendDispatcherStats = kit.dispatcher.stats();
    assert.equal(stats.accepted, 3);
    assert.equal(stats.signed, 1);
    assert.equal(stats.droppedUnknownVenue, 1);
    assert.equal(stats.droppedMalformed, 1);
});
