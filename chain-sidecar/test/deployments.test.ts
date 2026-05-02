import {test} from "node:test";
import assert from "node:assert/strict";
import {mkdtemp, readFile, rm, writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {
    DeploymentsValidationError,
    loadDeployments,
    parseDeployments,
    saveDeployments,
    type Deployments,
} from "../src/deployments/index.js";

/// Frozen snapshot mirroring `contracts/deployments/monad-testnet.json`. Lets every test
/// start from a known-good baseline and mutate just the field under test.
const VALID: Deployments = {
    chainId: 10143,
    deployer: "0x74f29100178a388f8cf3872d4d73f65f66fd0386",
    startBlock: 29174215,
    globals: {
        parkToken: "0x7555be7675c7826657d61adb0b97abf42b80a47f",
        faucet: "0x01dc4d083268bde65226c21d2cf0f50ca3214475",
        disperse: "0x3329a07443cd3755ba46364ef083b64193706a56",
    },
    demoPark: {
        treasury: "0xf1a95d2689e2949ff128cb943e9bf564e6f91bed",
        lendingPool: "0x364630e9f91958bc20fdaa98d5b28824273ac26d",
        guestRegistry: "0x88c453755ae5518d779f52174d768c296d958e2f",
        venueRegistry: "0xe6eaaf90380840b2f5f7509138ba330e5ec8b812",
        settlementBatcher: "0x5266392dc0930c134a75e2900ef1103b64722042",
    },
    loan: {
        maxBorrow: "1000000000000000000000000",
        ratePerBlock: 1000000000000,
    },
};

async function tmpDir(): Promise<{dir: string; cleanup: () => Promise<void>}> {
    const dir = await mkdtemp(join(tmpdir(), "rct2-deployments-test-"));
    return {dir, cleanup: () => rm(dir, {recursive: true, force: true})};
}

// ----------------------------------------------------------------------------------------
// parseDeployments — happy path + validation
// ----------------------------------------------------------------------------------------

test("parseDeployments accepts the canonical Monad-testnet snapshot", () => {
    const result = parseDeployments(VALID);
    assert.deepEqual(result, VALID);
});

test("parseDeployments lower-cases addresses to canonical form", () => {
    const mixed = {
        ...VALID,
        deployer: "0x74F29100178A388F8CF3872D4D73F65F66FD0386",
    };
    const result = parseDeployments(mixed);
    assert.equal(result.deployer, VALID.deployer);
});

test("parseDeployments rejects malformed addresses", () => {
    for (const bad of [
        "0x123", // too short
        "74f29100178a388f8cf3872d4d73f65f66fd0386", // missing 0x
        "0xZZf29100178a388f8cf3872d4d73f65f66fd0386", // non-hex chars
        123, // not a string
    ]) {
        assert.throws(
            () => parseDeployments({...VALID, deployer: bad}),
            (err: unknown) => {
                assert.ok(err instanceof DeploymentsValidationError);
                assert.equal(err.field, "deployer");
                return true;
            },
            `expected reject for: ${JSON.stringify(bad)}`,
        );
    }
});

test("parseDeployments rejects negative or non-integer chainId", () => {
    for (const bad of [-1, 0, 1.5, "10143"]) {
        assert.throws(() => parseDeployments({...VALID, chainId: bad}), DeploymentsValidationError);
    }
});

test("parseDeployments accepts startBlock = 0 (genesis) but not negative", () => {
    assert.doesNotThrow(() => parseDeployments({...VALID, startBlock: 0}));
    assert.throws(() => parseDeployments({...VALID, startBlock: -1}), DeploymentsValidationError);
});

test("parseDeployments rejects loan.maxBorrow that isn't a decimal string", () => {
    assert.throws(
        () => parseDeployments({...VALID, loan: {maxBorrow: "abc", ratePerBlock: 0}}),
        DeploymentsValidationError,
    );
    assert.throws(
        () =>
            parseDeployments({
                ...VALID,
                loan: {maxBorrow: 1_000_000 as unknown as string, ratePerBlock: 0},
            }),
        DeploymentsValidationError,
    );
    // Decimal-string-of-uint256 should pass — that's the whole point of the string.
    const huge = "1" + "0".repeat(76); // > 2^256, validates as decimal regardless
    assert.doesNotThrow(() =>
        parseDeployments({...VALID, loan: {maxBorrow: huge, ratePerBlock: 0}}),
    );
});

test("parseDeployments rejects missing top-level fields", () => {
    for (const field of ["chainId", "deployer", "startBlock", "globals", "demoPark", "loan"]) {
        const broken = {...VALID} as Record<string, unknown>;
        delete broken[field];
        assert.throws(
            () => parseDeployments(broken),
            DeploymentsValidationError,
            `expected reject when missing ${field}`,
        );
    }
});

test("parseDeployments rejects missing nested park / global fields", () => {
    for (const field of ["parkToken", "faucet", "disperse"]) {
        const broken = {...VALID, globals: {...VALID.globals}} as Record<string, unknown>;
        delete (broken.globals as Record<string, unknown>)[field];
        assert.throws(() => parseDeployments(broken), DeploymentsValidationError);
    }
    for (const field of ["treasury", "lendingPool", "guestRegistry", "venueRegistry", "settlementBatcher"]) {
        const broken = {...VALID, demoPark: {...VALID.demoPark}} as Record<string, unknown>;
        delete (broken.demoPark as Record<string, unknown>)[field];
        assert.throws(() => parseDeployments(broken), DeploymentsValidationError);
    }
});

test("parseDeployments rejects non-object root", () => {
    for (const bad of [null, "string", 42, []]) {
        assert.throws(() => parseDeployments(bad), DeploymentsValidationError);
    }
});

// ----------------------------------------------------------------------------------------
// loadDeployments — file I/O
// ----------------------------------------------------------------------------------------

test("loadDeployments reads + validates a file", async () => {
    const {dir, cleanup} = await tmpDir();
    try {
        const path = join(dir, "monad-testnet.json");
        await writeFile(path, JSON.stringify(VALID));
        const result = loadDeployments(path);
        assert.deepEqual(result, VALID);
    } finally {
        await cleanup();
    }
});

test("loadDeployments wraps JSON-parse errors with the file path", async () => {
    const {dir, cleanup} = await tmpDir();
    try {
        const path = join(dir, "broken.json");
        await writeFile(path, "{not valid json");
        assert.throws(() => loadDeployments(path), /broken\.json: invalid JSON/);
    } finally {
        await cleanup();
    }
});

// ----------------------------------------------------------------------------------------
// saveDeployments — atomic write + round-trip
// ----------------------------------------------------------------------------------------

test("saveDeployments writes a file that round-trips through loadDeployments", async () => {
    const {dir, cleanup} = await tmpDir();
    try {
        const path = join(dir, "out.json");
        await saveDeployments(path, VALID);
        const reloaded = loadDeployments(path);
        assert.deepEqual(reloaded, VALID);
    } finally {
        await cleanup();
    }
});

test("saveDeployments produces stable, sorted, pretty-printed output", async () => {
    const {dir, cleanup} = await tmpDir();
    try {
        const path = join(dir, "out.json");
        await saveDeployments(path, VALID);
        const raw = await readFile(path, "utf8");
        // Pretty-printed (multi-line + 2-space indent) — git-friendly.
        assert.ok(raw.includes("\n  "), "expected 2-space indentation");
        assert.ok(raw.endsWith("\n"), "expected trailing newline");
        // Top-level keys alphabetized — saving the same object twice should be a no-op diff.
        const firstKeyMatch = raw.match(/^{\n  "([a-zA-Z]+)"/);
        assert.equal(firstKeyMatch?.[1], "chainId");
        // Idempotent re-save.
        await saveDeployments(path, VALID);
        const raw2 = await readFile(path, "utf8");
        assert.equal(raw, raw2);
    } finally {
        await cleanup();
    }
});

test("saveDeployments refuses to persist an invalid object", async () => {
    const {dir, cleanup} = await tmpDir();
    try {
        const path = join(dir, "out.json");
        const broken = {...VALID, chainId: -1} as Deployments;
        await assert.rejects(saveDeployments(path, broken), DeploymentsValidationError);
        // File should not have been created.
        await assert.rejects(readFile(path), /ENOENT/);
    } finally {
        await cleanup();
    }
});

test("saveDeployments creates the parent directory if missing", async () => {
    const {dir, cleanup} = await tmpDir();
    try {
        const path = join(dir, "nested", "deeper", "out.json");
        await saveDeployments(path, VALID);
        const reloaded = loadDeployments(path);
        assert.deepEqual(reloaded, VALID);
    } finally {
        await cleanup();
    }
});

test("saveDeployments leaves no stray .tmp file behind on success", async () => {
    const {dir, cleanup} = await tmpDir();
    try {
        const path = join(dir, "out.json");
        await saveDeployments(path, VALID);
        await assert.rejects(readFile(`${path}.tmp`), /ENOENT/);
    } finally {
        await cleanup();
    }
});
