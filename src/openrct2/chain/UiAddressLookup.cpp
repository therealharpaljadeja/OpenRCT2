/*****************************************************************************
 * Copyright (c) 2014-2025 OpenRCT2 developers
 *
 * For a complete list of all authors, please refer to contributors.md
 * Interested in contributing? Visit https://github.com/OpenRCT2/OpenRCT2
 *
 * OpenRCT2 is licensed under the GNU General Public License version 3.
 *****************************************************************************/

#ifdef OPENRCT2_CHAIN

    #include "UiAddressLookup.h"

    #include "../OpenRCT2.h"
    #include "../core/Json.hpp"
    #include "SidecarClient.h"

    #include <array>
    #include <chrono>
    #include <mutex>
    #include <string>
    #include <unordered_map>

namespace OpenRCT2::Chain::UiAddressLookup
{
    namespace
    {
        // ---- Synthetic stub fallback ---------------------------------------
        // Returned when the sidecar isn't reachable. Deterministic per id so
        // the UI renders something stable in offline / pre-IPC builds.

        EthAddress SynthesiseAddress(uint32_t id, uint8_t kind)
        {
            EthAddress addr{};
            uint64_t state = (static_cast<uint64_t>(kind) << 32) | id;
            for (size_t i = 0; i < addr.bytes.size(); ++i)
            {
                state ^= state << 13;
                state ^= state >> 7;
                state ^= state << 17;
                addr.bytes[i] = static_cast<uint8_t>(state & 0xFF);
            }
            return addr;
        }

        char NibbleToHex(uint8_t nibble)
        {
            return nibble < 10 ? static_cast<char>('0' + nibble) : static_cast<char>('a' + (nibble - 10));
        }

        std::optional<uint8_t> HexNibble(char c)
        {
            if (c >= '0' && c <= '9')
                return static_cast<uint8_t>(c - '0');
            if (c >= 'a' && c <= 'f')
                return static_cast<uint8_t>(10 + (c - 'a'));
            if (c >= 'A' && c <= 'F')
                return static_cast<uint8_t>(10 + (c - 'A'));
            return std::nullopt;
        }

        // Parse "0x" + 40 hex chars into the 20 raw bytes the rest of the chain
        // namespace expects. Returns nullopt on any malformed input.
        std::optional<EthAddress> ParseHexAddress(std::string_view hex)
        {
            if (hex.size() != 42)
                return std::nullopt;
            if (hex[0] != '0' || (hex[1] != 'x' && hex[1] != 'X'))
                return std::nullopt;
            EthAddress out{};
            for (size_t i = 0; i < 20; ++i)
            {
                auto hi = HexNibble(hex[2 + i * 2]);
                auto lo = HexNibble(hex[3 + i * 2]);
                if (!hi || !lo)
                    return std::nullopt;
                out.bytes[i] = static_cast<uint8_t>((*hi << 4) | *lo);
            }
            return out;
        }

        // ---- Address cache --------------------------------------------------
        // Sidecar lookups are cheap but not free (UDS round-trip on the UI
        // thread). The UI calls TryGet* every paint, so we cache successes
        // forever and rate-limit failures to once per `kFailureCooldownMs`
        // per id — paint never re-blocks on a missing/offline sidecar.

        constexpr int kCallTimeoutMs = 100;
        constexpr int64_t kFailureCooldownMs = 5'000;

        struct Cache
        {
            std::mutex mu;
            std::unordered_map<uint32_t, EthAddress> hits;
            std::unordered_map<uint32_t, int64_t> nextRetryAt;
        };
        Cache& GuestCache()
        {
            static Cache c;
            return c;
        }
        Cache& VenueCache()
        {
            static Cache c;
            return c;
        }

        // ---- Per-session venue epoch ---------------------------------------
        // The sidecar mirror folds a 16-bit per-boot epoch into every chainId
        // (`venues/epoch.ts`); the game emits raw gameIds (`rideId + 1`). We
        // need the epoch to translate gameId -> chainId before calling
        // `chain.venues.get`. Fetched once via `sidecar.status` and cached.

        struct EpochCache
        {
            std::mutex mu;
            bool resolved = false;
            uint32_t epoch = 0;
            int64_t nextRetryAt = 0;
        };
        EpochCache& VenueEpoch()
        {
            static EpochCache c;
            return c;
        }

        std::optional<uint32_t> ResolveVenueEpoch(int64_t now)
        {
            auto& cache = VenueEpoch();
            {
                std::lock_guard<std::mutex> lock(cache.mu);
                if (cache.resolved)
                    return cache.epoch;
                if (now < cache.nextRetryAt)
                    return std::nullopt;
            }
            json_t result;
            if (!SidecarClient::Call("sidecar.status", json_t::object(), result, kCallTimeoutMs)
                || !result.is_object() || !result.contains("sessionEpoch")
                || !result["sessionEpoch"].is_number_integer())
            {
                std::lock_guard<std::mutex> lock(cache.mu);
                cache.nextRetryAt = now + kFailureCooldownMs;
                return std::nullopt;
            }
            const auto raw = result["sessionEpoch"].get<int64_t>();
            if (raw < 0 || raw > 0xFFFF)
            {
                std::lock_guard<std::mutex> lock(cache.mu);
                cache.nextRetryAt = now + kFailureCooldownMs;
                return std::nullopt;
            }
            std::lock_guard<std::mutex> lock(cache.mu);
            cache.epoch = static_cast<uint32_t>(raw);
            cache.resolved = true;
            return cache.epoch;
        }

        int64_t NowMs()
        {
            return std::chrono::duration_cast<std::chrono::milliseconds>(
                       std::chrono::steady_clock::now().time_since_epoch())
                .count();
        }

        // Generic: ask the sidecar for `method` with `params`, expect a
        // `{ ..., addressKey: "0x..." }`-shaped result, parse, return.
        std::optional<EthAddress> CallForAddress(
            const char* method, const json_t& params, const char* addressKey, const json_t* nestedKey = nullptr)
        {
            json_t result;
            if (!SidecarClient::Call(method, params, result, kCallTimeoutMs))
                return std::nullopt;
            if (!result.is_object())
                return std::nullopt;

            const json_t* addressNode = &result;
            if (nestedKey != nullptr)
            {
                if (!nestedKey->is_string())
                    return std::nullopt;
                const auto key = nestedKey->get<std::string>();
                if (!result.contains(key) || !result[key].is_object())
                    return std::nullopt;
                addressNode = &result[key];
            }
            if (!addressNode->contains(addressKey))
                return std::nullopt;
            const auto& addrJson = (*addressNode)[addressKey];
            if (!addrJson.is_string())
                return std::nullopt;
            return ParseHexAddress(addrJson.get<std::string>());
        }

        std::optional<EthAddress> TryFromCache(Cache& cache, uint32_t id)
        {
            std::lock_guard<std::mutex> lock(cache.mu);
            if (auto it = cache.hits.find(id); it != cache.hits.end())
                return it->second;
            return std::nullopt;
        }

        bool IsInCooldown(Cache& cache, uint32_t id, int64_t now)
        {
            std::lock_guard<std::mutex> lock(cache.mu);
            auto it = cache.nextRetryAt.find(id);
            return it != cache.nextRetryAt.end() && now < it->second;
        }

        void MemoiseHit(Cache& cache, uint32_t id, EthAddress addr)
        {
            std::lock_guard<std::mutex> lock(cache.mu);
            cache.hits[id] = addr;
            cache.nextRetryAt.erase(id);
        }

        void MemoiseMiss(Cache& cache, uint32_t id, int64_t now)
        {
            std::lock_guard<std::mutex> lock(cache.mu);
            cache.nextRetryAt[id] = now + kFailureCooldownMs;
        }
    } // namespace

    std::optional<EthAddress> TryGetGuestAddress(uint32_t hdIndex)
    {
        if (hdIndex == 0)
            return std::nullopt;

        auto& cache = GuestCache();
        if (auto cached = TryFromCache(cache, hdIndex))
            return cached;

        const auto now = NowMs();
        if (gOpenRCT2ChainEnabled && !IsInCooldown(cache, hdIndex, now))
        {
            json_t params = { { "index", hdIndex } };
            if (auto addr = CallForAddress("guest.address", params, "address"))
            {
                MemoiseHit(cache, hdIndex, *addr);
                return *addr;
            }
            MemoiseMiss(cache, hdIndex, now);
        }
        // Falling back to the synthetic stub keeps the UI populated when the
        // sidecar is offline / the keystore hasn't materialised this guest yet.
        return SynthesiseAddress(hdIndex, /*kind=*/0);
    }

    std::optional<EthAddress> TryGetVenueAddress(uint32_t venueId)
    {
        if (venueId == 0)
            return std::nullopt;

        auto& cache = VenueCache();
        if (auto cached = TryFromCache(cache, venueId))
            return cached;

        const auto now = NowMs();
        if (gOpenRCT2ChainEnabled && !IsInCooldown(cache, venueId, now))
        {
            // Translate gameId -> chainId by folding in the sidecar's per-session epoch.
            // Without this the lookup would target a venueId the registry never saw and
            // every paint would fall through to the synthetic stub.
            if (const auto epoch = ResolveVenueEpoch(now); epoch.has_value())
            {
                const uint32_t chainId = (*epoch << 16) | (venueId & 0xFFFFu);
                json_t params = { { "id", chainId } };
                const json_t nestedKey = "venue";
                if (auto addr = CallForAddress("chain.venues.get", params, "subAccount", &nestedKey))
                {
                    MemoiseHit(cache, venueId, *addr);
                    return *addr;
                }
            }
            MemoiseMiss(cache, venueId, now);
        }
        return SynthesiseAddress(venueId, /*kind=*/1);
    }

    std::string FormatHex(const EthAddress& addr)
    {
        std::string out;
        out.reserve(2 + addr.bytes.size() * 2);
        out.append("0x");
        for (auto b : addr.bytes)
        {
            out.push_back(NibbleToHex(b >> 4));
            out.push_back(NibbleToHex(b & 0x0F));
        }
        return out;
    }

    std::string FormatHexShort(const EthAddress& addr)
    {
        const auto full = FormatHex(addr);
        // 0x + first 6 + ellipsis + last 8 = "0xabcdef…12345678"
        return full.substr(0, 8) + "\xE2\x80\xA6" + full.substr(full.size() - 8);
    }
} // namespace OpenRCT2::Chain::UiAddressLookup

#endif // OPENRCT2_CHAIN
