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

    #include <array>

namespace OpenRCT2::Chain::UiAddressLookup
{
    namespace
    {
        // Mix the 32-bit id into the address bytes so different ids visibly
        // produce different stub addresses. Output is *not* a valid CREATE2
        // derivation — it's a placeholder until the IPC client returns the
        // real value from the sidecar.
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
    } // namespace

    std::optional<EthAddress> TryGetGuestAddress(uint32_t hdIndex)
    {
        if (hdIndex == 0)
            return std::nullopt;
        return SynthesiseAddress(hdIndex, /*kind=*/0);
    }

    std::optional<EthAddress> TryGetVenueAddress(uint32_t venueId)
    {
        if (venueId == 0)
            return std::nullopt;
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
