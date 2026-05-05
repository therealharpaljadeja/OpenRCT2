import {test} from "node:test";
import assert from "node:assert/strict";
import {encodeErrorResult, type Hex, type PublicClient} from "viem";
import {ERC20_ERRORS_ABI, PARK_TREASURY_ABI} from "../src/chain/abis.js";
import {decodeRevertReason, KNOWN_REVERT_ERRORS_ABI} from "../src/chain/decode-revert.js";

const TX_HASH: Hex = "0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef";
const FROM: `0x${string}` = "0x000000000000000000000000000000000000aaaa";
const TO: `0x${string}` = "0x000000000000000000000000000000000000bbbb";

interface MockTx {
    revertData: Hex;
}

/// Build a mock PublicClient that returns the same revert data on `call(...)` regardless
/// of args, plus a synthetic `getTransaction` for the txHash.
function mockClient(tx: MockTx): PublicClient {
    return {
        async getTransaction() {
            return {
                from: FROM,
                to: TO,
                input: "0xdeadbeef",
                value: 0n,
                blockNumber: 100n,
            };
        },
        async call() {
            const err = new Error("execution reverted") as Error & {data?: Hex};
            err.data = tx.revertData;
            throw err;
        },
    } as unknown as PublicClient;
}

test("decodeRevertReason names a top-level custom error", async () => {
    const data = encodeErrorResult({
        abi: ERC20_ERRORS_ABI,
        errorName: "ERC20InsufficientBalance",
        args: [FROM, 100n, 1000n],
    });
    const reason = await decodeRevertReason({
        publicClient: mockClient({revertData: data}),
        txHash: TX_HASH,
    });
    assert.ok(reason, "should decode to a string");
    assert.match(reason!, /ERC20InsufficientBalance/);
    assert.match(reason!, /100/);
    assert.match(reason!, /1000/);
});

test("decodeRevertReason recursively unwraps Treasury.CallFailed(bytes)", async () => {
    const inner = encodeErrorResult({
        abi: ERC20_ERRORS_ABI,
        errorName: "ERC20InsufficientAllowance",
        args: [FROM, 0n, 500n],
    });
    const outer = encodeErrorResult({
        abi: PARK_TREASURY_ABI,
        errorName: "CallFailed",
        args: [inner],
    });
    const reason = await decodeRevertReason({
        publicClient: mockClient({revertData: outer}),
        txHash: TX_HASH,
    });
    assert.ok(reason);
    assert.match(reason!, /CallFailed/);
    assert.match(reason!, /ERC20InsufficientAllowance/);
    assert.match(reason!, /500/);
});

test("decodeRevertReason returns undefined when revert data doesn't match the ABI", async () => {
    // Random 4-byte selector + garbage payload — not in any of our ABIs.
    const bogus: Hex = "0xbeefcafe000102030405060708090a0b0c0d0e0f10111213";
    const reason = await decodeRevertReason({
        publicClient: mockClient({revertData: bogus}),
        txHash: TX_HASH,
    });
    // The decoder falls back to printing the raw hex when decode fails.
    assert.ok(reason && reason.startsWith("revertData=0xbeefcafe"));
});

test("decodeRevertReason returns undefined when the replay call doesn't revert", async () => {
    // `call()` resolving means chain state diverged between submit and replay; nothing to decode.
    const client = {
        async getTransaction() {
            return {from: FROM, to: TO, input: "0x" as Hex, value: 0n, blockNumber: 100n};
        },
        async call() {
            return {data: "0x" as Hex};
        },
    } as unknown as PublicClient;
    const reason = await decodeRevertReason({publicClient: client, txHash: TX_HASH});
    assert.equal(reason, undefined);
});

test("KNOWN_REVERT_ERRORS_ABI includes CallFailed and ERC20InsufficientBalance", () => {
    const errorNames = new Set(
        KNOWN_REVERT_ERRORS_ABI.flatMap((entry) =>
            entry.type === "error" ? [entry.name] : [],
        ),
    );
    assert.ok(errorNames.has("CallFailed"));
    assert.ok(errorNames.has("ERC20InsufficientBalance"));
    assert.ok(errorNames.has("ERC20InsufficientAllowance"));
    assert.ok(errorNames.has("AlreadyRegistered"));
    assert.ok(errorNames.has("BadNonce"));
});
