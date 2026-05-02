import {deriveGuest} from "./index.js";

/// Address-only cache for guest HD wallets (plan §2.1, §2.3 / M2.3).
///
/// The sidecar sees a `GUEST_ENTRY` event referencing a `hdIndex` and needs to answer two
/// questions cheaply, repeatedly:
///   1. "What's this guest's address?" — used by the funder to disperse PARK at entry,
///      by the venue mirror to attach `from` to spend events, by the IPC layer to echo a
///      `GuestEntered { address }` back to the game so it can stamp `Guest::OnchainAddress`.
///   2. "Sign this `SpendAuth` as the guest." — only the batcher does this (§4.2). The
///      private key isn't kept around between signs; the batcher re-derives via `deriveGuest`
///      on demand. That's the plan's "address-only; key derived on demand inside batcher".
///
/// Why we don't cache the `HDAccount` itself: a viem `HDAccount` carries a derived key plus
/// signing closures. At 5 000+ guests that's a lot of long-lived secret material in RAM for
/// no benefit — we re-derive in single-digit milliseconds when we actually sign. So the cache
/// stores 20-byte addresses and nothing else; the mnemonic lives in this object's closure
/// and never escapes.
///
/// No eviction policy: the plan's worst case is ~5 000 concurrent guests × 20 bytes = ~100 KB.
/// If a save ever pushed millions of guests we'd revisit, but in the demo bounds the cache is
/// trivially small.
export class GuestAddressCache {
    readonly #mnemonic: string;
    readonly #addresses = new Map<number, `0x${string}`>();
    #hits = 0;
    #misses = 0;

    constructor(mnemonic: string) {
        if (typeof mnemonic !== "string" || mnemonic.length === 0) {
            throw new Error("GuestAddressCache: mnemonic must be a non-empty string");
        }
        this.#mnemonic = mnemonic;
    }

    /// Cheap path. Returns the cached address or derives + caches a new one.
    addressOf(index: number): `0x${string}` {
        if (!Number.isInteger(index) || index < 0) {
            throw new Error(`GuestAddressCache: invalid index ${index}`);
        }
        const hit = this.#addresses.get(index);
        if (hit !== undefined) {
            this.#hits++;
            return hit;
        }
        this.#misses++;
        const derived = deriveGuest(this.#mnemonic, index).address;
        this.#addresses.set(index, derived);
        return derived;
    }

    /// Lookup without deriving. Used by code paths that want to avoid the keccak / secp work
    /// when the address was supposed to be primed earlier (e.g. by `GUEST_ENTRY` handling).
    peek(index: number): `0x${string}` | undefined {
        return this.#addresses.get(index);
    }

    has(index: number): boolean {
        return this.#addresses.has(index);
    }

    size(): number {
        return this.#addresses.size;
    }

    /// Pre-derive a contiguous block. Useful for tests and for save-load: the game's known
    /// guest set is replayed into the cache so we don't pay derivation cost during the first
    /// post-load tick storm.
    warmup(indices: Iterable<number>): void {
        for (const i of indices) this.addressOf(i);
    }

    stats(): GuestAddressCacheStats {
        return {size: this.#addresses.size, hits: this.#hits, misses: this.#misses};
    }

    /// Drop everything. The mnemonic is retained so the cache stays usable after a clear —
    /// shape matches the eventual "park unloaded, sidecar idle" path.
    clear(): void {
        this.#addresses.clear();
        this.#hits = 0;
        this.#misses = 0;
    }
}

export interface GuestAddressCacheStats {
    size: number;
    hits: number;
    misses: number;
}
