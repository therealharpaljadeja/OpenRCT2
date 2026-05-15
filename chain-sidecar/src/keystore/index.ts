import {createCipheriv, createDecipheriv, randomBytes, scrypt as scryptCb} from "node:crypto";
import {existsSync} from "node:fs";
import {mkdir, readFile, writeFile} from "node:fs/promises";
import {dirname} from "node:path";
import {promisify} from "node:util";
import {english, generateMnemonic, mnemonicToAccount} from "viem/accounts";

/// Per-park master mnemonic, encrypted at rest. See `OpenRCT2/ONCHAIN_PLAN.md` §2.1: the seed
/// is generated once per park save, encrypted by the sidecar, and used to derive both the
/// relayer pool (this milestone) and per-guest accounts on demand (M2.3+). The game process
/// never sees a private key — only the cached address corresponding to a guest's HD index.
///
/// Format choices:
///   - scrypt for the KDF — bundled with Node, no native deps; default cost (N=131072, r=8, p=1)
///     puts unlock at ~100ms which is fine for a one-shot boot operation.
///   - AES-256-GCM for the cipher — authenticated encryption catches passphrase mistakes
///     and corruption with a clean error rather than silently producing garbage bytes.

const KEYSTORE_VERSION = 1 as const;

/// Tuned for a single boot-time unlock. Memory ≈ 128 · r · N = 134 MB with these defaults,
/// hence the explicit `maxmem` ceiling we pass to `scrypt`.
export const DEFAULT_KDF_PARAMS: KdfTuning = {
    n: 131072,
    r: 8,
    p: 1,
    dklen: 32,
};
const SCRYPT_MAXMEM = 256 * 1024 * 1024;

const scryptAsync = promisify<string | Buffer, Buffer, number, {N: number; r: number; p: number; maxmem: number}, Buffer>(
    scryptCb as unknown as (
        password: string | Buffer,
        salt: Buffer,
        keylen: number,
        options: {N: number; r: number; p: number; maxmem: number},
        cb: (err: Error | null, derivedKey: Buffer) => void,
    ) => void,
);

export interface KdfTuning {
    n: number;
    r: number;
    p: number;
    dklen: 32;
}

export interface KdfParams extends KdfTuning {
    salt: string; // hex
}

export interface KeystoreFile {
    version: 1;
    createdAt: string;
    kdf: "scrypt";
    kdfParams: KdfParams;
    cipher: "aes-256-gcm";
    iv: string; // hex, 12 bytes
    ciphertext: string; // hex
    authTag: string; // hex, 16 bytes
}

export interface UnlockedKeystore {
    mnemonic: string;
    createdAt: string;
}

export class KeystoreError extends Error {
    public override readonly cause?: unknown;
    constructor(message: string, cause?: unknown) {
        super(message);
        this.cause = cause;
    }
}

async function deriveKey(passphrase: string, params: KdfParams): Promise<Buffer> {
    const salt = Buffer.from(params.salt, "hex");
    return scryptAsync(passphrase, salt, params.dklen, {
        N: params.n,
        r: params.r,
        p: params.p,
        maxmem: SCRYPT_MAXMEM,
    });
}

export async function encryptMnemonic(
    mnemonic: string,
    passphrase: string,
    kdfTuning: KdfTuning = DEFAULT_KDF_PARAMS,
): Promise<KeystoreFile> {
    if (passphrase.length === 0) throw new KeystoreError("keystore passphrase is empty");
    const salt = randomBytes(16);
    const kdfParams: KdfParams = {...kdfTuning, salt: salt.toString("hex")};
    const key = await deriveKey(passphrase, kdfParams);
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", key, iv);
    const enc = Buffer.concat([cipher.update(mnemonic, "utf8"), cipher.final()]);
    const authTag = cipher.getAuthTag();
    return {
        version: KEYSTORE_VERSION,
        createdAt: new Date().toISOString(),
        kdf: "scrypt",
        kdfParams,
        cipher: "aes-256-gcm",
        iv: iv.toString("hex"),
        ciphertext: enc.toString("hex"),
        authTag: authTag.toString("hex"),
    };
}

export async function decryptKeystore(file: KeystoreFile, passphrase: string): Promise<UnlockedKeystore> {
    if (file.version !== KEYSTORE_VERSION) {
        throw new KeystoreError(`unsupported keystore version: ${String(file.version)}`);
    }
    if (file.kdf !== "scrypt") throw new KeystoreError(`unsupported kdf: ${String(file.kdf)}`);
    if (file.cipher !== "aes-256-gcm") throw new KeystoreError(`unsupported cipher: ${String(file.cipher)}`);
    const key = await deriveKey(passphrase, file.kdfParams);
    const iv = Buffer.from(file.iv, "hex");
    const decipher = createDecipheriv("aes-256-gcm", key, iv);
    decipher.setAuthTag(Buffer.from(file.authTag, "hex"));
    let mnemonic: string;
    try {
        mnemonic = Buffer.concat([
            decipher.update(Buffer.from(file.ciphertext, "hex")),
            decipher.final(),
        ]).toString("utf8");
    } catch (err) {
        // GCM auth-tag failure looks identical for "bad passphrase" and "tampered file" — the
        // single message keeps that ambiguity intact rather than leaking which one it was.
        throw new KeystoreError("keystore unlock failed: bad passphrase or corrupt data", err);
    }
    return {mnemonic, createdAt: file.createdAt};
}

export interface CreateOptions {
    /// Override entropy — used by tests for deterministic vectors. Production omits this.
    mnemonic?: string;
    kdfTuning?: KdfTuning;
}

export async function createKeystoreFile(
    path: string,
    passphrase: string,
    options: CreateOptions = {},
): Promise<UnlockedKeystore> {
    const mnemonic = options.mnemonic ?? generateMnemonic(english);
    if (!isValidMnemonic(mnemonic)) {
        throw new KeystoreError("provided mnemonic failed BIP-39 validation");
    }
    const file = await encryptMnemonic(mnemonic, passphrase, options.kdfTuning ?? DEFAULT_KDF_PARAMS);
    await mkdir(dirname(path), {recursive: true});
    // Mode 0o600: defense-in-depth against accidental world-readable backups. The encryption
    // is what guards the secret on hostile disks; this guards against a tar that escapes.
    await writeFile(path, JSON.stringify(file, null, 2), {mode: 0o600});
    return {mnemonic, createdAt: file.createdAt};
}

export async function loadKeystoreFile(path: string, passphrase: string): Promise<UnlockedKeystore> {
    const raw = await readFile(path, "utf8");
    let file: KeystoreFile;
    try {
        file = JSON.parse(raw) as KeystoreFile;
    } catch (err) {
        throw new KeystoreError(`keystore at ${path} is not valid JSON`, err);
    }
    return decryptKeystore(file, passphrase);
}

export async function loadOrCreateKeystoreFile(
    path: string,
    passphrase: string,
    options: CreateOptions = {},
): Promise<{unlocked: UnlockedKeystore; created: boolean}> {
    if (existsSync(path)) {
        return {unlocked: await loadKeystoreFile(path, passphrase), created: false};
    }
    const unlocked = await createKeystoreFile(path, passphrase, options);
    return {unlocked, created: true};
}

/// Liberal validity check via viem: if `mnemonicToAccount` accepts the phrase, BIP-39 does too.
function isValidMnemonic(mnemonic: string): boolean {
    try {
        mnemonicToAccount(mnemonic);
        return true;
    } catch {
        return false;
    }
}
