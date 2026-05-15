import {test} from "node:test";
import assert from "node:assert/strict";
import {decodeFunctionData, type Hex, type PublicClient, type WalletClient} from "viem";
import {authorizeOperators} from "../src/chain/operators.js";
import {PARK_TREASURY_ABI} from "../src/chain/abis.js";

/// Boot-time operator-authorization helper (M3.14). Mocked publicClient + walletClient so
/// we can exercise the idempotent skip-vs-tx branching without a real chain.

const TREASURY: `0x${string}` = "0x0000000000000000000000000000000000000aaa";
const OWNER: `0x${string}` = "0x0000000000000000000000000000000000000eee";
const OP_A: `0x${string}` = "0x000000000000000000000000000000000000a001";
const OP_B: `0x${string}` = "0x000000000000000000000000000000000000a002";
const OP_C: `0x${string}` = "0x000000000000000000000000000000000000a003";

function makeMocks(opts: {alreadyAuthorized?: Set<`0x${string}`>} = {}): {
    walletClient: WalletClient;
    publicClient: PublicClient;
    sent: Array<{to: `0x${string}`; data: Hex}>;
    receiptStatus: Map<Hex, "success" | "reverted">;
    setReceiptStatus: (h: Hex, s: "success" | "reverted") => void;
} {
    const sent: Array<{to: `0x${string}`; data: Hex}> = [];
    const receiptStatus = new Map<Hex, "success" | "reverted">();
    const already = opts.alreadyAuthorized ?? new Set<`0x${string}`>();
    let counter = 0;
    const walletClient = {
        account: {address: OWNER, type: "json-rpc"},
        chain: null,
        async sendTransaction(args: {to: `0x${string}`; data: Hex}): Promise<Hex> {
            sent.push({to: args.to, data: args.data});
            counter++;
            const hash = (`0x${counter.toString(16).padStart(64, "0")}`) as Hex;
            // Default to success; tests can override per-hash.
            if (!receiptStatus.has(hash)) receiptStatus.set(hash, "success");
            return hash;
        },
    } as unknown as WalletClient;
    const publicClient = {
        async readContract(args: {functionName: string; args: readonly unknown[]}): Promise<boolean> {
            assert.equal(args.functionName, "operators");
            const [addr] = args.args as [`0x${string}`];
            return already.has(addr.toLowerCase() as `0x${string}`);
        },
        async waitForTransactionReceipt(args: {hash: Hex}): Promise<{
            status: "success" | "reverted";
            blockNumber: bigint;
            gasUsed: bigint;
            transactionHash: Hex;
        }> {
            const status = receiptStatus.get(args.hash) ?? "success";
            return {status, blockNumber: 1n, gasUsed: 0n, transactionHash: args.hash};
        },
    } as unknown as PublicClient;
    return {
        walletClient,
        publicClient,
        sent,
        receiptStatus,
        setReceiptStatus: (h, s) => receiptStatus.set(h, s),
    };
}

test("M3.14: authorizes 3 fresh operators with one tx each", async () => {
    const m = makeMocks();
    const results = await authorizeOperators({
        walletClient: m.walletClient,
        publicClient: m.publicClient,
        treasury: TREASURY,
        operators: [OP_A, OP_B, OP_C],
    });
    assert.equal(results.length, 3);
    assert.deepEqual(
        results.map((r) => r.authorized),
        [true, true, true],
    );
    assert.equal(m.sent.length, 3, "one tx per fresh operator");
    // Each tx targets the treasury and carries `addOperator(addr)` calldata.
    for (let i = 0; i < 3; i++) {
        const decoded = decodeFunctionData({abi: PARK_TREASURY_ABI, data: m.sent[i]!.data});
        assert.equal(decoded.functionName, "addOperator");
        // viem auto-checksums on decode; compare lower-cased.
        assert.equal(
            ((decoded.args as readonly `0x${string}`[])[0] as string).toLowerCase(),
            [OP_A, OP_B, OP_C][i]!.toLowerCase(),
        );
    }
});

test("M3.14: skips operators already authorized on chain — no tx, no event spam", async () => {
    const m = makeMocks({alreadyAuthorized: new Set([OP_A.toLowerCase() as `0x${string}`, OP_B.toLowerCase() as `0x${string}`])});
    const results = await authorizeOperators({
        walletClient: m.walletClient,
        publicClient: m.publicClient,
        treasury: TREASURY,
        operators: [OP_A, OP_B, OP_C],
    });
    assert.deepEqual(
        results.map((r) => r.authorized),
        [false, false, true],
    );
    // Only OP_C needed a tx.
    assert.equal(m.sent.length, 1);
});

test("M3.14: idempotent across re-runs — second call sends zero txs", async () => {
    const already = new Set<`0x${string}`>();
    // First run: 3 fresh ops → 3 txs.
    const m1 = makeMocks({alreadyAuthorized: already});
    await authorizeOperators({
        walletClient: m1.walletClient,
        publicClient: m1.publicClient,
        treasury: TREASURY,
        operators: [OP_A, OP_B, OP_C],
    });
    assert.equal(m1.sent.length, 3);

    // Simulate the on-chain state catching up.
    for (const a of [OP_A, OP_B, OP_C]) already.add(a.toLowerCase() as `0x${string}`);

    // Second run: all 3 skipped, zero txs.
    const m2 = makeMocks({alreadyAuthorized: already});
    const results = await authorizeOperators({
        walletClient: m2.walletClient,
        publicClient: m2.publicClient,
        treasury: TREASURY,
        operators: [OP_A, OP_B, OP_C],
    });
    assert.equal(m2.sent.length, 0);
    assert.deepEqual(
        results.map((r) => r.authorized),
        [false, false, false],
    );
});

test("M3.14: throws when walletClient lacks an account", async () => {
    const m = makeMocks();
    const bad = {...m.walletClient, account: undefined} as unknown as WalletClient;
    await assert.rejects(
        () =>
            authorizeOperators({
                walletClient: bad,
                publicClient: m.publicClient,
                treasury: TREASURY,
                operators: [OP_A],
            }),
        /missing account/,
    );
});

test("M3.14: M3.13's confirmTx throws if the addOperator tx reverts", async () => {
    const m = makeMocks();
    // Pre-set the *next* hash to revert. The mock counter starts at 0 so the first tx hash
    // ends in 01.
    m.setReceiptStatus(("0x" + "0".repeat(63) + "1") as Hex, "reverted");
    await assert.rejects(
        () =>
            authorizeOperators({
                walletClient: m.walletClient,
                publicClient: m.publicClient,
                treasury: TREASURY,
                operators: [OP_A],
            }),
        /reverted on chain/,
    );
});
