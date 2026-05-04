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

    #include <cstdint>

namespace OpenRCT2::Chain
{
    // Scale factor from in-game money64 (fixed_64_1dp; 1 unit = 0.1 currency) to PARK wei.
    // 10^15 picks a regime where guests' default initial cash (~500 units = £50) maps to
    // 5 × 10^17 wei = 0.5 PARK — small enough to leave room for spends, large enough that
    // dispersed amounts read as recognisable PARK figures in explorers. uint64 holds game
    // values up to 9.2 × 10^3 units after scaling, well above any plausible CashInPocket
    // or single-spend amount.
    inline constexpr uint64_t kGameMoneyToWei = 1'000'000'000'000'000ULL;

    inline uint64_t GameMoneyToWei(int64_t money)
    {
        if (money <= 0)
            return 0ULL;
        return static_cast<uint64_t>(money) * kGameMoneyToWei;
    }
} // namespace OpenRCT2::Chain

#endif // OPENRCT2_CHAIN
