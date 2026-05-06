// Standalone roundtrip harness for chain/Outbox (M4.1).
//
// Builds without gtest / openrct2 deps — just compiles Outbox.cpp directly.
// Pushes one of each event kind, then prints the WAL path so the companion
// Node script can parse the lines through chain-sidecar's parseEvent.
//
// Build + run via test/chain/run_outbox_roundtrip.sh.

#include "../../src/openrct2/chain/Outbox.h"

#include <cstdio>
#include <cstdlib>
#include <filesystem>
#include <iostream>
#include <thread>

// LOG_* macros call into Diagnostic.h's DiagnosticLog* symbols, which live in
// libopenrct2. Stub them here so the harness links standalone.
#include "../../src/openrct2/Diagnostic.h"

void DiagnosticLogWithLocation(DiagnosticLevel, const char*, const char*, int32_t, const char*, ...)
{
    // no-op — the test only cares about file output
}
void DiagnosticLog(DiagnosticLevel, const char*, ...)
{
}

using namespace OpenRCT2::Chain;

static int RunFirstProducer(const std::filesystem::path& walPath)
{
    OutboxOptions opts;
    opts.walPath = walPath.string();
    opts.maxBytes = 1024 * 1024;
    opts.ringCapacity = 1024;
    Outbox outbox(std::move(opts));
    if (!outbox.Start())
    {
        std::fprintf(stderr, "outbox.Start failed (first)\n");
        return 1;
    }
    outbox.PushGuestEntry(42, 0, 250'000'000'000'000'000ULL);
    outbox.PushVenueRegistered(1, VenueKind::Ride, "Madhatter's Café 🎢", "ParkRide");
    outbox.PushGuestSpend(42, 0, 1, 5'000'000'000'000'000ULL, SpendCategory::RideFare, 12345);
    outbox.PushGuestSpend(42, 0, 1, 3'000'000'000'000'000ULL, SpendCategory::ShopPrimary, 12350);
    outbox.PushVenueRenamed(1, "The Wild \"Quote\" Coaster\\");
    outbox.PushGuestExit(42, 0);
    outbox.PushVenueRemoved(1);

    std::this_thread::sleep_for(std::chrono::milliseconds(150));
    outbox.Stop();

    auto stats = outbox.GetStats();
    if (stats.pushed != 7 || stats.written != 7 || stats.dropped != 0 || stats.writeErrors != 0
        || stats.nextSeq != 7)
    {
        std::fprintf(
            stderr, "first producer stats mismatch: pushed=%llu written=%llu dropped=%llu nextSeq=%llu\n",
            (unsigned long long)stats.pushed, (unsigned long long)stats.written,
            (unsigned long long)stats.dropped, (unsigned long long)stats.nextSeq);
        return 1;
    }
    return 0;
}

// Re-open the same WAL with a fresh Outbox; nextSeq must resume past the existing tail.
static int RunSecondProducer(const std::filesystem::path& walPath)
{
    OutboxOptions opts;
    opts.walPath = walPath.string();
    opts.maxBytes = 1024 * 1024;
    opts.ringCapacity = 1024;
    Outbox outbox(std::move(opts));
    if (!outbox.Start())
    {
        std::fprintf(stderr, "outbox.Start failed (second)\n");
        return 1;
    }
    // 50 PARK in wei (5 × 10^19) — exceeds uint64 max (~1.84 × 10^19) by ~3×, so this
    // line is the regression check that the wire format still round-trips for amounts
    // that overflow the old uint64-only path.
    unsigned __int128 fiftyParkWei = static_cast<unsigned __int128>(50) * static_cast<unsigned __int128>(1'000'000'000'000'000'000ULL);
    outbox.PushGuestEntry(99, 1, fiftyParkWei);
    std::this_thread::sleep_for(std::chrono::milliseconds(80));
    outbox.Stop();
    auto stats = outbox.GetStats();
    if (stats.nextSeq != 8 || stats.written != 1)
    {
        std::fprintf(
            stderr, "second producer seq-resume mismatch: nextSeq=%llu written=%llu (expected 8/1)\n",
            (unsigned long long)stats.nextSeq, (unsigned long long)stats.written);
        return 1;
    }
    return 0;
}

int main(int argc, char** argv)
{
    if (argc < 2)
    {
        std::fprintf(stderr, "usage: %s <wal_path>\n", argv[0]);
        return 2;
    }
    std::filesystem::path walPath = argv[1];
    std::error_code ec;
    std::filesystem::remove(walPath, ec);

    if (int rc = RunFirstProducer(walPath); rc != 0)
        return rc;
    if (int rc = RunSecondProducer(walPath); rc != 0)
        return rc;
    std::fprintf(stderr, "outbox_roundtrip C++ phase OK\n");
    return 0;
}
