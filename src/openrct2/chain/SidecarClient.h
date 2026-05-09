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

    #include "../core/JsonFwd.hpp"

    #include <string>
    #include <string_view>

namespace OpenRCT2::Chain::SidecarClient
{
    // One-shot synchronous JSON-RPC 2.0 call to the running sidecar over UDS
    // (line-delimited framing per `chain-sidecar/src/ipc/protocol.ts`).
    //
    //   - Opens a fresh connection, writes one line, reads one line, closes.
    //   - Returns true on success and writes the parsed `result` field into `result`.
    //   - Returns false if the runtime is down (no socket path), connect fails,
    //     the timeout expires, the response can't be parsed, or the sidecar
    //     responded with an `error` envelope. Callers fall back to a stub.
    //
    // Safe to call from the UI thread when `timeoutMs` is small (UDS round-trips
    // are sub-ms in the happy path); callers should still cache results and
    // gate retries to avoid hitching paint when the sidecar is unreachable.
    bool Call(std::string_view method, const json_t& params, json_t& result, int timeoutMs);
} // namespace OpenRCT2::Chain::SidecarClient

#endif // OPENRCT2_CHAIN
