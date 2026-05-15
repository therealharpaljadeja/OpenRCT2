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

    #include "EthAddress.h"

    #include <cstdint>
    #include <optional>
    #include <string>

namespace OpenRCT2::Chain::UiAddressLookup
{
    // Stub address provider — exists to let the in-game floating dialog UI for
    // guests / venues land in parallel with the sidecar IPC client. Once the IPC
    // ships, the implementations become a thin facade over the cached responses;
    // the call sites in Guest.cpp / Ride.cpp don't need to change.
    //
    // Today's behaviour: deterministic synthetic 20-byte address derived from the
    // id. Returns nullopt for id == 0 (sentinel "no value").
    std::optional<EthAddress> TryGetGuestAddress(uint32_t hdIndex);
    std::optional<EthAddress> TryGetVenueAddress(uint32_t venueId);

    // "0x" + 40 lowercase hex chars. No EIP-55 checksum (would need keccak256
    // on the C++ side). Wallets accept lowercase fine.
    std::string FormatHex(const EthAddress& addr);

    // Compact rendering for tight UI: "0xABCDEF…12345678" (8 + 8). Always pairs
    // with FormatHex for the actual clipboard payload.
    std::string FormatHexShort(const EthAddress& addr);

    // Drop every cached guest/venue lookup and the per-session venue epoch the UI
    // resolved from `sidecar.status`. Called from `Chain::BeginNewSession()` after
    // the sidecar's `chain.session.begin` flips its own caches: keeps the C++ UI
    // from serving stale addresses (or the wrong epoch) for the lifetime of the
    // failure-cooldown window. Idempotent.
    void ClearCaches();
} // namespace OpenRCT2::Chain::UiAddressLookup

#endif // OPENRCT2_CHAIN
