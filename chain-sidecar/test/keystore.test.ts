import {test} from "node:test";
import assert from "node:assert/strict";
import {mkdtemp, readFile, rm, stat, writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {
    createKeystoreFile,
    decryptKeystore,
    encryptMnemonic,
    KeystoreError,
    loadKeystoreFile,
    loadOrCreateKeystoreFile,
    type KeystoreFile,
} from "../src/keystore/index.js";

/// All tests use a deliberately weak KDF so the suite runs in well under a second. Production
/// uses `DEFAULT_KDF_PARAMS` (N=131072) — the round-trip behavior is identical, only timing
/// changes. The `n=4096` test below explicitly proves the format ignores tuning beyond what's
/// stored in `kdfParams`.
const FAST_KDF = {n: 1024, r: 8, p: 1, dklen: 32 as const};
const TEST_MNEMONIC = "test test test test test test test test test test test junk";
const PASSPHRASE = "correct horse battery staple";

async function tmp(): Promise<string> {
    return mkdtemp(join(tmpdir(), "rct2-keystore-test-"));
}

test("encrypt → decrypt round-trips the mnemonic", async () => {
    const file = await encryptMnemonic(TEST_MNEMONIC, PASSPHRASE, FAST_KDF);
    const unlocked = await decryptKeystore(file, PASSPHRASE);
    assert.equal(unlocked.mnemonic, TEST_MNEMONIC);
    assert.equal(unlocked.createdAt, file.createdAt);
});

test("ciphertext + iv + salt are non-deterministic across encryptions", async () => {
    const a = await encryptMnemonic(TEST_MNEMONIC, PASSPHRASE, FAST_KDF);
    const b = await encryptMnemonic(TEST_MNEMONIC, PASSPHRASE, FAST_KDF);
    assert.notEqual(a.iv, b.iv, "iv must be random per encryption");
    assert.notEqual(a.kdfParams.salt, b.kdfParams.salt, "salt must be random per encryption");
    assert.notEqual(a.ciphertext, b.ciphertext, "ciphertext should differ");
});

test("wrong passphrase throws KeystoreError without leaking which check failed", async () => {
    const file = await encryptMnemonic(TEST_MNEMONIC, PASSPHRASE, FAST_KDF);
    await assert.rejects(decryptKeystore(file, "wrong-pass"), (err: unknown) => {
        assert.ok(err instanceof KeystoreError);
        assert.match(err.message, /unlock failed/);
        return true;
    });
});

test("tampered ciphertext fails GCM auth — same error as bad passphrase", async () => {
    const file = await encryptMnemonic(TEST_MNEMONIC, PASSPHRASE, FAST_KDF);
    const tampered: KeystoreFile = {
        ...file,
        // Flip a single byte.
        ciphertext: file.ciphertext.replace(/^.{2}/, (m) => (m === "ff" ? "00" : "ff")),
    };
    await assert.rejects(decryptKeystore(tampered, PASSPHRASE), KeystoreError);
});

test("rejects unsupported version / kdf / cipher cleanly", async () => {
    const ok = await encryptMnemonic(TEST_MNEMONIC, PASSPHRASE, FAST_KDF);
    await assert.rejects(decryptKeystore({...ok, version: 999} as unknown as KeystoreFile, PASSPHRASE), /version/);
    await assert.rejects(decryptKeystore({...ok, kdf: "pbkdf2" as never}, PASSPHRASE), /kdf/);
    await assert.rejects(decryptKeystore({...ok, cipher: "aes-128-cbc" as never}, PASSPHRASE), /cipher/);
});

test("createKeystoreFile writes 0o600 JSON and round-trips", async () => {
    const dir = await tmp();
    try {
        const path = join(dir, "ks.json");
        const created = await createKeystoreFile(path, PASSPHRASE, {
            mnemonic: TEST_MNEMONIC,
            kdfTuning: FAST_KDF,
        });
        assert.equal(created.mnemonic, TEST_MNEMONIC);

        const stats = await stat(path);
        // Mask out the file-type bits — only the permission triplet matters here.
        assert.equal(stats.mode & 0o777, 0o600, "keystore file must be 0o600");

        const reloaded = await loadKeystoreFile(path, PASSPHRASE);
        assert.equal(reloaded.mnemonic, TEST_MNEMONIC);
    } finally {
        await rm(dir, {recursive: true, force: true});
    }
});

test("loadOrCreateKeystoreFile creates on first call, loads on second", async () => {
    const dir = await tmp();
    try {
        const path = join(dir, "ks.json");
        const first = await loadOrCreateKeystoreFile(path, PASSPHRASE, {kdfTuning: FAST_KDF});
        assert.equal(first.created, true);
        // Second call should hit the existing file and decrypt the *same* mnemonic.
        const second = await loadOrCreateKeystoreFile(path, PASSPHRASE);
        assert.equal(second.created, false);
        assert.equal(second.unlocked.mnemonic, first.unlocked.mnemonic);
    } finally {
        await rm(dir, {recursive: true, force: true});
    }
});

test("rejects empty passphrase at encrypt time", async () => {
    await assert.rejects(encryptMnemonic(TEST_MNEMONIC, "", FAST_KDF), KeystoreError);
});

test("rejects an invalid mnemonic at create time", async () => {
    const dir = await tmp();
    try {
        await assert.rejects(
            createKeystoreFile(join(dir, "ks.json"), PASSPHRASE, {
                mnemonic: "not a bip39 mnemonic at all",
                kdfTuning: FAST_KDF,
            }),
            /BIP-39/,
        );
    } finally {
        await rm(dir, {recursive: true, force: true});
    }
});

test("loadKeystoreFile errors with a clear message on garbage JSON", async () => {
    const dir = await tmp();
    try {
        const path = join(dir, "broken.json");
        await writeFile(path, "{not json");
        await assert.rejects(loadKeystoreFile(path, PASSPHRASE), /not valid JSON/);
    } finally {
        await rm(dir, {recursive: true, force: true});
    }
});

test("on-disk format has no plaintext mnemonic words anywhere", async () => {
    const dir = await tmp();
    try {
        const path = join(dir, "ks.json");
        await createKeystoreFile(path, PASSPHRASE, {mnemonic: TEST_MNEMONIC, kdfTuning: FAST_KDF});
        const raw = await readFile(path, "utf8");
        for (const word of TEST_MNEMONIC.split(" ")) {
            assert.ok(!raw.includes(` ${word} `), `mnemonic word "${word}" leaked into keystore JSON`);
        }
    } finally {
        await rm(dir, {recursive: true, force: true});
    }
});
