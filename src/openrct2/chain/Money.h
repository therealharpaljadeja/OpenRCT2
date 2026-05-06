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
    // 10^17 maps $1 in-game → 1 PARK on chain (1 unit = $0.10 → 0.1 PARK). Block explorers
    // show readable token quantities that track in-game prices 1:1. Above uint64 for any
    // plausible game value (default starting cash $50 = 5 × 10^19 wei), so we widen the
    // outbox amount field to unsigned __int128 — the contract side already uses uint256.
    inline constexpr unsigned __int128 kGameMoneyToWei = static_cast<unsigned __int128>(100'000'000'000'000'000ULL);

    inline unsigned __int128 GameMoneyToWei(int64_t money)
    {
        if (money <= 0)
            return 0;
        return static_cast<unsigned __int128>(money) * kGameMoneyToWei;
    }
} // namespace OpenRCT2::Chain

#endif // OPENRCT2_CHAIN
