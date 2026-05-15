import {test} from "node:test";
import assert from "node:assert/strict";
import {
    BaseError,
    ContractFunctionRevertedError,
    decodeFunctionData,
    encodeFunctionData,
    type Hex,
    type PublicClient,
    type WalletClient,
} from "viem";
import {VENUE_REGISTRY_ABI} from "../src/chain/abis.js";
import {VenueMirror, subAccountOf, type VenueMirrorOptions} from "../src/venues/index.js";

const OWNER: `0x${string}` = "0x000000000000000000000000000000000000aaaa";
const VENUE_REGISTRY: `0x${string}` = "0x000000000000000000000000000000000000bbbb";

interface SentTx {
    to: `0x${string}`;
    data: Hex;
    value: bigint;
}

/// `simulateContract` request shape (subset). Mirrors the relevant parts of viem's
/// `WriteContractParameters` — we pass it through from `simulateContract` to `writeContract`
/// in the mock without losing the function name + args, so the recording layer can encode
/// the equivalent calldata for the existing `decodeFunctionData(sent[i].data)` assertions.
interface SimulateRequest {
    address: `0x${string}`;
    functionName: string;
    args: readonly unknown[];
}

/// Configurable mock harness for the M3.15 path: `simulateContract → writeContract +
/// confirmTx`. By default `simulateContract` returns a passthrough request, `writeContract`
/// records the SentTx (with calldata encoded for the existing decode assertions) and returns
/// a unique hash, and `waitForTransactionReceipt` returns success. Override any of the four
/// to mimic simulate-time reverts (`AlreadyRegistered`), submit-time RPC errors, or
/// execution-time reverts (`status: "reverted"`).
function makeMocks(overrides: {
    simulateContract?: (args: {
        address: `0x${string}`;
        functionName: string;
        args: readonly unknown[];
    }) => Promise<{request: SimulateRequest}>;
    writeContract?: (request: SimulateRequest) => Promise<Hex>;
    waitForTransactionReceipt?: (args: {hash: Hex}) => Promise<{
        status: "success" | "reverted";
        blockNumber: bigint;
        gasUsed: bigint;
        transactionHash: Hex;
    }>;
    readContract?: (args: {functionName: string; args?: readonly unknown[]}) => Promise<unknown>;
} = {}): {
    walletClient: WalletClient;
    publicClient: PublicClient;
    sent: SentTx[];
} {
    const sent: SentTx[] = [];
    let counter = 0;
    const nextHash = (): Hex => {
        counter++;
        return (`0x${counter.toString(16).padStart(64, "0")}`) as Hex;
    };
    const defaultSimulate = async (args: {
        address: `0x${string}`;
        functionName: string;
        args: readonly unknown[];
    }): Promise<{request: SimulateRequest}> => ({
        request: {address: args.address, functionName: args.functionName, args: args.args},
    });
    const defaultWrite = async (request: SimulateRequest): Promise<Hex> => {
        // Encode the equivalent calldata so the existing decode assertions on
        // `sent[i].data` keep working unchanged.
        const data = encodeFunctionData({
            abi: VENUE_REGISTRY_ABI,
            functionName: request.functionName as never,
            args: request.args as never,
        });
        sent.push({to: request.address, data, value: 0n});
        return nextHash();
    };
    const defaultReceipt = async (args: {hash: Hex}): Promise<{
        status: "success" | "reverted";
        blockNumber: bigint;
        gasUsed: bigint;
        transactionHash: Hex;
    }> => ({status: "success", blockNumber: 1n, gasUsed: 0n, transactionHash: args.hash});
    const walletClient = {
        account: {address: OWNER, type: "json-rpc"},
        chain: null,
        writeContract: overrides.writeContract ?? defaultWrite,
    } as unknown as WalletClient;
    const defaultRead = async (): Promise<unknown> => {
        throw new Error("read not configured");
    };
    const publicClient = {
        simulateContract: overrides.simulateContract ?? defaultSimulate,
        waitForTransactionReceipt: overrides.waitForTransactionReceipt ?? defaultReceipt,
        readContract: overrides.readContract ?? defaultRead,
    } as unknown as PublicClient;
    return {walletClient, publicClient, sent};
}

function makeMirror(extra: Partial<VenueMirrorOptions> = {}, mocksOverride?: ReturnType<typeof makeMocks>): {
    mirror: VenueMirror;
    sent: SentTx[];
} {
    const mocks = mocksOverride ?? makeMocks();
    const mirror = new VenueMirror({
        walletClient: mocks.walletClient,
        publicClient: mocks.publicClient,
        venueRegistry: VENUE_REGISTRY,
        ...extra,
    });
    return {mirror, sent: mocks.sent};
}

test("constructor rejects bad address / missing account / out-of-range queue", () => {
    const mocks = makeMocks();
    assert.throws(
        () =>
            new VenueMirror({
                walletClient: mocks.walletClient,
                publicClient: mocks.publicClient,
                venueRegistry: "0xzzz" as `0x${string}`,
            }),
        /20-byte hex/,
    );
    const noAccount = {...mocks.walletClient, account: undefined} as unknown as WalletClient;
    assert.throws(
        () =>
            new VenueMirror({
                walletClient: noAccount,
                publicClient: mocks.publicClient,
                venueRegistry: VENUE_REGISTRY,
            }),
        /missing account/,
    );
    assert.throws(
        () =>
            new VenueMirror({
                walletClient: mocks.walletClient,
                publicClient: mocks.publicClient,
                venueRegistry: VENUE_REGISTRY,
                maxQueuedEvents: 0,
            }),
        /maxQueuedEvents/,
    );
});

test("subAccountOf is deterministic and depends on registry + venueId", () => {
    const a1 = subAccountOf(VENUE_REGISTRY, 1);
    const a1Again = subAccountOf(VENUE_REGISTRY, 1);
    assert.equal(a1, a1Again, "deterministic");
    const a2 = subAccountOf(VENUE_REGISTRY, 2);
    assert.notEqual(a1, a2, "id changes the address");
    const altRegistry: `0x${string}` = "0x000000000000000000000000000000000000cccc";
    const a1Alt = subAccountOf(altRegistry, 1);
    assert.notEqual(a1, a1Alt, "registry changes the address");
});

test("subAccountOf rejects out-of-uint32 ids", () => {
    assert.throws(() => subAccountOf(VENUE_REGISTRY, -1), /uint32/);
    assert.throws(() => subAccountOf(VENUE_REGISTRY, 0x1_0000_0000), /uint32/);
});

test("register flow: submits register tx, populates cache with deterministic subAccount", async () => {
    const {mirror, sent} = makeMirror();
    mirror.start();
    mirror.accept({kind: "register", venueId: 7, venueKind: 1, name: "Wooden Coaster 1", objectType: "rct2.ride.wmouse"});
    await mirror.drain();

    assert.equal(sent.length, 1);
    assert.equal(sent[0]!.to.toLowerCase(), VENUE_REGISTRY.toLowerCase());
    const decoded = decodeFunctionData({abi: VENUE_REGISTRY_ABI, data: sent[0]!.data});
    assert.equal(decoded.functionName, "register");
    const [id, kind, name, objectType] = decoded.args as [number, number, string, string];
    assert.equal(id, 7);
    assert.equal(kind, 1);
    assert.equal(name, "Wooden Coaster 1");
    assert.equal(objectType, "rct2.ride.wmouse");

    const cached = mirror.lookup(7);
    assert.ok(cached, "venue cached after submission");
    assert.equal(cached!.id, 7);
    assert.equal(cached!.kind, 1);
    assert.equal(cached!.name, "Wooden Coaster 1");
    assert.equal(cached!.objectType, "rct2.ride.wmouse");
    assert.equal(cached!.subAccount, subAccountOf(VENUE_REGISTRY, 7));
    assert.equal(cached!.active, true);

    const stats = mirror.stats();
    assert.equal(stats.submitted, 1);
    assert.equal(stats.accepted, 1);
    assert.equal(stats.rpcErrors, 0);
    assert.equal(stats.cacheSize, 1);
    assert.equal(stats.eventCounts.register, 1);
});

test("rename flow: submits rename tx, updates cached name", async () => {
    const {mirror, sent} = makeMirror();
    mirror.start();
    mirror.accept({kind: "register", venueId: 5, venueKind: 2, name: "Stand A", objectType: "rct2.shop.x"});
    mirror.accept({kind: "rename", venueId: 5, newName: "Stand B"});
    await mirror.drain();

    assert.equal(sent.length, 2);
    const renameDecoded = decodeFunctionData({abi: VENUE_REGISTRY_ABI, data: sent[1]!.data});
    assert.equal(renameDecoded.functionName, "rename");
    const [id, newName] = renameDecoded.args as [number, string];
    assert.equal(id, 5);
    assert.equal(newName, "Stand B");

    assert.equal(mirror.lookup(5)!.name, "Stand B");
    assert.equal(mirror.stats().eventCounts.rename, 1);
});

test("remove flow: submits remove tx, marks cache inactive (preserves entry)", async () => {
    const {mirror, sent} = makeMirror();
    mirror.start();
    mirror.accept({kind: "register", venueId: 9, venueKind: 1, name: "X", objectType: "rct2.ride.x"});
    mirror.accept({kind: "remove", venueId: 9});
    await mirror.drain();

    assert.equal(sent.length, 2);
    const removeDecoded = decodeFunctionData({abi: VENUE_REGISTRY_ABI, data: sent[1]!.data});
    assert.equal(removeDecoded.functionName, "remove");
    assert.equal((removeDecoded.args as [number])[0], 9);

    const cached = mirror.lookup(9);
    assert.ok(cached, "remove preserves cache entry (so historical events resolve)");
    assert.equal(cached!.active, false);
    assert.equal(mirror.stats().eventCounts.remove, 1);
});

test("ordering: events for the same venue are processed serially in submission order", async () => {
    // Critical: a rename → remove burst must hit chain in that order, otherwise the remove
    // sees stale state. Verify by inspecting the recorded tx sequence.
    const {mirror, sent} = makeMirror();
    mirror.start();
    mirror.accept({kind: "register", venueId: 1, venueKind: 1, name: "A", objectType: "rct2.ride.x"});
    mirror.accept({kind: "rename", venueId: 1, newName: "B"});
    mirror.accept({kind: "rename", venueId: 1, newName: "C"});
    mirror.accept({kind: "remove", venueId: 1});
    await mirror.drain();

    assert.equal(sent.length, 4);
    const fns = sent.map((s) => decodeFunctionData({abi: VENUE_REGISTRY_ABI, data: s.data}).functionName);
    assert.deepEqual(fns, ["register", "rename", "rename", "remove"]);
    const cached = mirror.lookup(1);
    assert.equal(cached!.name, "C", "second rename wins");
    assert.equal(cached!.active, false, "remove was applied last");
});

test("backpressure: drops oldest when queue exceeds maxQueuedEvents", async () => {
    // Use a queue of pending resolvers so the worker stays parked on the first in-flight tx
    // until the test releases it. After the cap is exceeded, oldest should be dropped.
    // We park `writeContract` (the actual submit) — `simulateContract` runs first and
    // resolves immediately, but the hold lands inside the same `#processOne` call so the
    // worker still stays inFlight on the in-progress event.
    const pending: Array<(h: Hex) => void> = [];
    const writeFn = async (): Promise<Hex> =>
        new Promise<Hex>((resolve) => {
            pending.push(resolve);
        });
    const mocks = makeMocks({writeContract: writeFn});
    const mirror = new VenueMirror({
        walletClient: mocks.walletClient,
        publicClient: mocks.publicClient,
        venueRegistry: VENUE_REGISTRY,
        maxQueuedEvents: 2,
    });
    mirror.start();
    // First accept is consumed by the worker immediately and stays in-flight.
    mirror.accept({kind: "register", venueId: 1, venueKind: 1, name: "A", objectType: "rct2.ride.x"});
    // These three pile up in the queue; cap is 2, so the oldest (id=2) gets evicted.
    mirror.accept({kind: "register", venueId: 2, venueKind: 1, name: "B", objectType: "rct2.ride.x"});
    mirror.accept({kind: "register", venueId: 3, venueKind: 1, name: "C", objectType: "rct2.ride.x"});
    mirror.accept({kind: "register", venueId: 4, venueKind: 1, name: "D", objectType: "rct2.ride.x"});

    const stats = mirror.stats();
    assert.equal(stats.queueDepth, 2);
    assert.equal(stats.droppedEvents, 1);

    // Cleanup: release each in-flight tx as it lands and let the worker drain the survivors.
    while (mirror.stats().inFlight > 0 || mirror.stats().queueDepth > 0) {
        // Wait for the worker to actually call sendFn for the next event.
        while (pending.length === 0) await new Promise((r) => setImmediate(r));
        pending.shift()!("0xdead" as Hex);
        await new Promise((r) => setImmediate(r));
    }
    await mirror.drain();
});

test("post-stop accept is dropped, in-flight work drains", async () => {
    const {mirror} = makeMirror();
    mirror.start();
    mirror.accept({kind: "register", venueId: 1, venueKind: 1, name: "A", objectType: "rct2.ride.x"});
    await mirror.stop();
    mirror.accept({kind: "register", venueId: 2, venueKind: 1, name: "B", objectType: "rct2.ride.x"});
    const stats = mirror.stats();
    assert.equal(stats.droppedEvents, 1);
    assert.equal(stats.submitted, 1);
});

test("malformed input is dropped with a counter bump", () => {
    const {mirror} = makeMirror();
    mirror.start();
    mirror.accept({kind: "register", venueId: -1, venueKind: 1, name: "X", objectType: "y"});
    mirror.accept({kind: "register", venueId: 0x1_0000_0000, venueKind: 1, name: "X", objectType: "y"});
    mirror.accept({kind: "register", venueId: 1, venueKind: 99, name: "X", objectType: "y"});
    const stats = mirror.stats();
    assert.equal(stats.droppedEvents, 3);
    assert.equal(stats.queueDepth, 0);
});

test("rpc errors increment rpcErrors without wrecking the worker", async () => {
    let calls = 0;
    const mocks = makeMocks({
        writeContract: async (request) => {
            calls++;
            if (calls === 1) throw new Error("rpc: server unavailable");
            // Encode + record like the default write mock so the second call still lands
            // in `sent` for later assertions if needed.
            const data = encodeFunctionData({
                abi: VENUE_REGISTRY_ABI,
                functionName: request.functionName as never,
                args: request.args as never,
            });
            mocks.sent.push({to: request.address, data, value: 0n});
            return ("0x" + "11".repeat(32)) as Hex;
        },
    });
    const {mirror} = makeMirror({}, mocks);
    mirror.start();
    mirror.accept({kind: "register", venueId: 1, venueKind: 1, name: "A", objectType: "rct2.ride.x"});
    mirror.accept({kind: "register", venueId: 2, venueKind: 1, name: "B", objectType: "rct2.ride.x"});
    await mirror.drain();

    const stats = mirror.stats();
    assert.equal(stats.rpcErrors, 1, "first event errored");
    assert.equal(stats.submitted, 1, "second event succeeded");
    assert.equal(mirror.lookup(1), undefined, "errored event not cached");
    assert.ok(mirror.lookup(2), "successful event cached");
});

test("AlreadyRegistered / NotRegistered / AlreadyInactive are skipped, cache still updated", async () => {
    // Simulate-time reverts (the simulate-first path is what M3.15 buys us). Throwing from
    // `simulateContract` exercises the message-substring fallback in `isAlreadyAppliedError`.
    let attempt = 0;
    const messages = [
        "execution reverted: AlreadyRegistered()",
        "execution reverted: NotRegistered()",
        "execution reverted: AlreadyInactive()",
    ];
    const mocks = makeMocks({
        simulateContract: async () => {
            const m = messages[attempt++]!;
            throw new Error(m);
        },
    });
    const {mirror} = makeMirror({}, mocks);
    mirror.start();
    mirror.accept({kind: "register", venueId: 1, venueKind: 1, name: "A", objectType: "rct2.ride.x"});
    mirror.accept({kind: "rename", venueId: 1, newName: "B"});
    mirror.accept({kind: "remove", venueId: 1});
    await mirror.drain();

    const stats = mirror.stats();
    assert.equal(stats.skippedAlreadyApplied, 3);
    assert.equal(stats.rpcErrors, 0, "expected reverts shouldn't bump rpcErrors");
    // Cache still reflects post-event state — chain is ahead of us, the local cache shouldn't lag.
    const cached = mirror.lookup(1);
    assert.ok(cached);
    assert.equal(cached!.name, "B");
    assert.equal(cached!.active, false);
});

test("stats() lastTxHash + lastSubmitLatencyMs surface for the most recent successful tx", async () => {
    // Latency is wall-clock around the entire simulate→write→confirm path. Advance the
    // injected clock inside `writeContract` (any of the three would do) to verify the
    // measurement is end-to-end rather than per-step.
    let now = 1_000_000_000_000;
    const mocks = makeMocks({
        writeContract: async () => {
            now += 50;
            return ("0xdeadbeef" as Hex);
        },
    });
    const {mirror} = makeMirror({now: () => now}, mocks);
    mirror.start();
    mirror.accept({kind: "register", venueId: 7, venueKind: 1, name: "A", objectType: "rct2.ride.x"});
    await mirror.drain();
    const stats = mirror.stats();
    assert.equal(stats.lastTxHash, "0xdeadbeef");
    assert.equal(stats.lastSubmitLatencyMs, 50);
});

test("lookup / list reflect cache state", async () => {
    const {mirror} = makeMirror();
    mirror.start();
    mirror.accept({kind: "register", venueId: 1, venueKind: 1, name: "A", objectType: "rct2.ride.x"});
    mirror.accept({kind: "register", venueId: 2, venueKind: 2, name: "B", objectType: "rct2.shop.x"});
    await mirror.drain();
    const list = mirror.list();
    assert.equal(list.length, 2);
    assert.deepEqual(
        list.map((v) => v.id),
        [1, 2],
    );
    assert.equal(mirror.lookup(1)!.kind, 1);
    assert.equal(mirror.lookup(2)!.kind, 2);
    assert.equal(mirror.lookup(99), undefined);
});

test("hydrateFromChain populates the cache from on-chain state", async () => {
    const venuesOnChain: Record<number, [number, number, string, string, `0x${string}`, bigint, boolean]> = {
        1: [1, 1, "Wooden Coaster", "rct2.ride.wmouse", subAccountOf(VENUE_REGISTRY, 1), 1000n, true],
        4: [4, 2, "Burger Bar", "rct2.shop.burgb", subAccountOf(VENUE_REGISTRY, 4), 1010n, true],
    };
    const ids = [1, 4];
    const mocks = makeMocks({
        readContract: async (args: {functionName: string; args?: readonly unknown[]}): Promise<unknown> => {
            if (args.functionName === "venueCount") return BigInt(ids.length);
            if (args.functionName === "venueIdAt") {
                const [idx] = args.args as [bigint];
                return ids[Number(idx)];
            }
            if (args.functionName === "venues") {
                const [id] = args.args as [number];
                return venuesOnChain[id];
            }
            throw new Error(`unexpected: ${args.functionName}`);
        },
    });
    const {mirror} = makeMirror({}, mocks);
    const n = await mirror.hydrateFromChain();
    assert.equal(n, 2);
    assert.equal(mirror.list().length, 2);
    assert.equal(mirror.lookup(1)!.name, "Wooden Coaster");
    assert.equal(mirror.lookup(4)!.objectType, "rct2.shop.burgb");
});

test("M3.15: structured ContractFunctionRevertedError from simulate is classified as already-applied", async () => {
    // The point of M3.15 — viem's `simulateContract` throws a structured
    // `ContractFunctionRevertedError` when a custom revert fires. `isAlreadyAppliedError`
    // walks the error chain to recognize the contract's three idempotent reverts by name.
    // This test exercises the structured path (the existing string-substring test covers
    // the message-only fallback for nodes that don't return ABI-decoded errors).
    //
    // We synthesize the error via prototype-assignment instead of calling the constructor
    // because viem's `ContractFunctionRevertedError` constructor calls `decodeErrorResult`
    // on the `data` arg — passing a synthetic `{errorName}` shorthand makes it crash on
    // `value_.slice`. Bypassing the constructor is the standard way to fixture this.
    const reverted = Object.assign(Object.create(ContractFunctionRevertedError.prototype), {
        name: "ContractFunctionRevertedError",
        message: "AlreadyRegistered()",
        data: {errorName: "AlreadyRegistered", args: []},
    }) as ContractFunctionRevertedError;
    const wrapped = new BaseError("simulate failed", {cause: reverted});
    const mocks = makeMocks({
        simulateContract: async () => {
            throw wrapped;
        },
    });
    const {mirror} = makeMirror({}, mocks);
    mirror.start();
    mirror.accept({kind: "register", venueId: 7, venueKind: 1, name: "A", objectType: "rct2.ride.x"});
    await mirror.drain();
    const stats = mirror.stats();
    assert.equal(stats.skippedAlreadyApplied, 1, "structured AlreadyRegistered classified as skip");
    assert.equal(stats.rpcErrors, 0, "structured idempotent revert must not bump rpcErrors");
    // Cache still updated — chain is in the post-event state, the local cache shouldn't lag.
    assert.ok(mirror.lookup(7));
});

test("M3.15: execution-time revert (receipt status=reverted) increments rpcErrors", async () => {
    // The other half of M3.15 — `confirmTx` catches the silent-revert class M3.13 fixed for
    // the other write paths. Here simulate succeeds (the chain accepted the inputs at view
    // time) and writeContract returns a hash, but the receipt comes back `status: reverted`
    // (e.g. ownership rotated between simulate and submit). The mirror should treat this
    // as a real error, not as "already applied".
    const mocks = makeMocks({
        waitForTransactionReceipt: async (args) => ({
            status: "reverted",
            blockNumber: 99n,
            gasUsed: 21000n,
            transactionHash: args.hash,
        }),
    });
    const {mirror} = makeMirror({}, mocks);
    mirror.start();
    mirror.accept({kind: "register", venueId: 1, venueKind: 1, name: "A", objectType: "rct2.ride.x"});
    await mirror.drain();
    const stats = mirror.stats();
    assert.equal(stats.rpcErrors, 1, "execution-time revert bumps rpcErrors");
    assert.equal(stats.skippedAlreadyApplied, 0, "must not be confused with idempotent skip");
    assert.equal(stats.submitted, 0, "tx didn't succeed — submitted stays at 0");
    assert.equal(mirror.lookup(1), undefined, "errored event not cached");
});
