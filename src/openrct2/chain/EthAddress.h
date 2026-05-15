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

    #include <array>
    #include <cstdint>

namespace OpenRCT2::Chain
{
    // 20-byte raw EVM address. Cached on Guest after the sidecar derives it from HdIndex.
    // Plan §5.1 spec: stored as raw bytes (no checksum / no leading "0x") so it stays a
    // trivial POD and survives Guest's struct constraints. Stringification (with EIP-55
    // checksum) lives in the rendering layer.
    struct EthAddress
    {
        std::array<uint8_t, 20> bytes{};

        bool IsZero() const
        {
            for (auto b : bytes)
                if (b != 0)
                    return false;
            return true;
        }
    };

    static_assert(sizeof(EthAddress) == 20, "EthAddress must be exactly 20 bytes");
} // namespace OpenRCT2::Chain

#endif // OPENRCT2_CHAIN
