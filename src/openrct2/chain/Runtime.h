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

    #include <filesystem>
    #include <string>

namespace OpenRCT2::Chain
{
    struct RuntimeOptions
    {
        // Repo root for resolving the sidecar's `chain-sidecar/dist/main.js`.
        std::filesystem::path repoRoot;
        // Per-session workspace dir for the WAL, cursor, sidecar log, and UDS socket.
        std::filesystem::path workspace;
        // Optional override of the keystore path. If empty, sidecar default
        // (`<workspace>/chain/keystore.json`) is used.
        std::filesystem::path keystorePath;
    };

    // Idempotent. On first call: constructs the global Outbox + spawns the sidecar process.
    // Subsequent calls are no-ops while the runtime is up. Failure leaves the runtime down
    // and returns false; populates errorOut with a one-line cause.
    //
    // Credentials (KEYSTORE_PASSPHRASE, FAUCET_OWNER_KEY, MONAD_RPC_URL) are inherited from
    // the parent process environment — the sidecar reads them itself per its M2.2/M2.5
    // CLI surface. v0 doesn't prompt or stash them on the C++ side.
    bool EnsureRuntime(const RuntimeOptions& opts, std::string& errorOut);

    // Stops the sidecar (SIGTERM/grace/SIGKILL) then the Outbox. Idempotent. The Outbox
    // singleton is cleared so subsequent EnsureRuntime calls start fresh.
    void TeardownRuntime();

    bool IsRuntimeUp();
} // namespace OpenRCT2::Chain

#endif // OPENRCT2_CHAIN
