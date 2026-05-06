/*****************************************************************************
 * Copyright (c) 2014-2025 OpenRCT2 developers
 *
 * For a complete list of all authors, please refer to contributors.md
 * Interested in contributing? Visit https://github.com/OpenRCT2/OpenRCT2
 *
 * OpenRCT2 is licensed under the GNU General Public License version 3.
 *****************************************************************************/

#pragma once

#ifdef OPENRCT2_CHAIN

    #include <cstddef>
    #include <cstdint>
    #include <memory>
    #include <string>
    #include <string_view>

namespace OpenRCT2::Chain
{
    // Wire-format constants — must match chain-sidecar/src/outbox/types.ts.
    enum class VenueKind : uint8_t
    {
        ParkEntrance = 0,
        Ride = 1,
        Shop = 2,
        Stall = 3,
        Facility = 4,
        ATM = 5,
    };

    enum class SpendCategory : uint8_t
    {
        RideFare = 0,
        ShopPrimary = 1,
        ShopSecondary = 2,
        FacilityUse = 3,
        Entry = 4,
        AtmFee = 5,
    };

    // Venue-id convention shared by producers (M4.4–M4.8) and the on-chain VenueRegistry:
    //   - 0 is the park entrance (registered once at park init, plan §3.2).
    //   - Any other venue's id is its game-side `RideId` underlying + 1 (so RideId 0 doesn't
    //     collide with the entrance sentinel). Caller does the +1.
    //   - UINT32_MAX is a producer-side sentinel meaning "no venue here, don't emit"; never
    //     transmitted on the wire.
    inline constexpr uint32_t kVenueIdEntrance = 0;
    inline constexpr uint32_t kVenueIdNone = 0xFFFFFFFFu;

    struct OutboxOptions
    {
        std::string walPath;
        // Soft cap on the WAL file size. Truncate-in-place when the next append would exceed.
        // Default + sidecar M3.10 reader contract: 500 MiB.
        uint64_t maxBytes = 500ull * 1024ull * 1024ull;
        // SPSC ring capacity in records. Rounded up to a power of two.
        // 65536 records × ~200 B/record ≈ 13 MiB worst-case backing buffer.
        std::size_t ringCapacity = 65536;
    };

    struct OutboxStats
    {
        uint64_t pushed;        // Producer-side: events accepted into the ring.
        uint64_t written;       // Writer thread: events serialized + appended.
        uint64_t dropped;       // Producer-side: events dropped because ring was full.
        uint64_t bytesWritten;  // Cumulative bytes written across this Outbox lifetime.
        uint64_t rotations;     // Times the WAL was truncated due to maxBytes cap.
        uint64_t writeErrors;   // Writer thread: I/O failures (line skipped).
        uint64_t nextSeq;       // Next seq the producer will hand out.
        std::string walPath;
        bool running;
    };

    // Append-only outbox that drives the on-chain pipeline.
    //
    // Threading: Push* are wait-free and safe to call from a single producer thread (the
    // game tick). A dedicated writer thread serializes records to NDJSON and appends to the
    // WAL. The wire format must stay byte-identical with the sidecar reader at
    // chain-sidecar/src/outbox/types.ts — see Outbox.cpp for serialization details.
    //
    // Crash safety mirrors the sidecar writer: no fsync per event; durability is provided by
    // the consumer's cursor. A killed producer is replayed on next boot from the cursor.
    //
    // Overflow policy: if the ring is full, the producer drops the *new* event and bumps
    // `dropped`. We bound the ring large enough that this only triggers under sustained
    // disk failure; the alternative (drop oldest from the producer) would race the consumer.
    class Outbox
    {
    public:
        explicit Outbox(OutboxOptions opts);
        ~Outbox();

        Outbox(const Outbox&) = delete;
        Outbox& operator=(const Outbox&) = delete;

        // Open the WAL, scan it for the highest existing seq, spawn the writer thread.
        // Returns false on I/O error.
        bool Start();

        // Hand out a fresh BIP-32 HD derivation index for a new guest. Monotonic across the
        // lifetime of this Outbox instance (resets on Start). The sidecar derives the
        // guest's wallet from this index against the master mnemonic — so within a single
        // park run, every guest gets a unique on-chain identity.
        uint32_t AllocateHdIndex();

        // Signal the writer thread to drain and exit; close the WAL.
        void Stop();

        // -------- Producer API (single-thread; game tick) --------
        // `cashWei` and `amountWei` are integer wei values; the caller converts in-game
        // money to wei. Sidecar parses these as bigint per its uint256 ABI contract.
        // `unsigned __int128` covers the full range needed at kGameMoneyToWei = 10^17 —
        // even the wealthiest guest's CashInPocket fits comfortably below 2^128.

        void PushGuestEntry(int32_t guestId, uint32_t hdIndex, unsigned __int128 cashWei);
        void PushGuestSpend(
            int32_t guestId,
            uint32_t hdIndex,
            uint32_t venueId,
            unsigned __int128 amountWei,
            SpendCategory category,
            uint64_t gameTick);
        void PushGuestExit(int32_t guestId, uint32_t hdIndex);
        void PushVenueRegistered(uint32_t venueId, VenueKind kind, std::string_view name, std::string_view objectType);
        void PushVenueRenamed(uint32_t venueId, std::string_view newName);
        void PushVenueRemoved(uint32_t venueId);

        OutboxStats GetStats() const;

    private:
        struct Impl;
        std::unique_ptr<Impl> _impl;
    };

    // Process-wide singleton the game hooks reach for. Boot wires the instance via
    // SetOutbox(); GetOutbox() returns nullptr when chain integration is disabled.
    Outbox* GetOutbox();
    void SetOutbox(std::unique_ptr<Outbox> outbox);
} // namespace OpenRCT2::Chain

#endif // OPENRCT2_CHAIN
