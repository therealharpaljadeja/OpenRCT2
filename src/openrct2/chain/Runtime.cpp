/*****************************************************************************
 * Copyright (c) 2014-2025 OpenRCT2 developers
 *
 * For a complete list of all authors, please refer to contributors.md
 * Interested in contributing? Visit https://github.com/OpenRCT2/OpenRCT2
 *
 * OpenRCT2 is licensed under the GNU General Public License version 3.
 *****************************************************************************/

#ifdef OPENRCT2_CHAIN

    #include "Runtime.h"

    #include "../Diagnostic.h"
    #include "Outbox.h"
    #include "Sidecar.h"

    #include <cstdlib>
    #include <memory>
    #include <mutex>
    #include <string>
    #include <system_error>
    #include <unistd.h>

namespace OpenRCT2::Chain
{
    namespace
    {
        std::mutex gRuntimeMutex;
        std::unique_ptr<SidecarProcess> gSidecar;
        bool gOutboxStarted = false;

        std::filesystem::path FindSidecarEntry(const std::filesystem::path& repoRoot)
        {
            // Plan §4.0: `chain-sidecar/dist/main.js`. The sidecar build target is part of
            // `agent_bundle`, so this should exist in any dev build. We don't try to fall
            // back to `npm run build` here — the agent_bundle target is the contract.
            return repoRoot / "chain-sidecar" / "dist" / "main.js";
        }

        // Resolve `name` to an absolute executable path. `execve` (which we use post-fork)
        // does *not* search PATH — passing a bare "node" silently fails with _exit(127) and
        // produces no diagnostic. We resolve here, on the parent side, so missing-node
        // surfaces as a normal `EnsureRuntime` error.
        std::string LookupExecutable(const std::string& name)
        {
            if (name.find('/') != std::string::npos)
                return name;

            if (const char* pathEnv = std::getenv("PATH"); pathEnv != nullptr)
            {
                std::string path = pathEnv;
                std::size_t start = 0;
                while (start <= path.size())
                {
                    std::size_t end = path.find(':', start);
                    if (end == std::string::npos)
                        end = path.size();
                    std::string segment = path.substr(start, end - start);
                    if (!segment.empty())
                    {
                        auto candidate = std::filesystem::path(segment) / name;
                        if (::access(candidate.c_str(), X_OK) == 0)
                            return candidate.string();
                    }
                    if (end == path.size())
                        break;
                    start = end + 1;
                }
            }

            // GUI launches on macOS often inherit a bare PATH (`/usr/bin:/bin`). Fall back
            // to the standard Homebrew + system locations so a double-click .app launch
            // still finds Node.
            for (const char* p : { "/opt/homebrew/bin/node", "/usr/local/bin/node", "/usr/bin/node" })
            {
                if (::access(p, X_OK) == 0)
                    return p;
            }
            return {};
        }
    } // namespace

    bool EnsureRuntime(const RuntimeOptions& opts, std::string& errorOut)
    {
        std::lock_guard<std::mutex> lock(gRuntimeMutex);
        if (gSidecar && gSidecar->IsRunning() && gOutboxStarted)
            return true;

        // ---- Resolve paths.
        if (opts.repoRoot.empty())
        {
            errorOut = "chain runtime: repoRoot is empty";
            return false;
        }
        if (opts.workspace.empty())
        {
            errorOut = "chain runtime: workspace is empty";
            return false;
        }

        const auto chainDir = opts.workspace / "chain";
        std::error_code ec;
        std::filesystem::create_directories(chainDir, ec);
        if (ec)
        {
            errorOut = "chain runtime: cannot create " + chainDir.string() + ": " + ec.message();
            return false;
        }

        const auto walPath = chainDir / "outbox.wal";
        const auto cursorPath = chainDir / "outbox.cursor";
        const auto socketPath = chainDir / "sidecar.sock";
        const auto sidecarLogPath = chainDir / "sidecar.log";
        const auto keystorePath = opts.keystorePath.empty() ? (chainDir / "keystore.json") : opts.keystorePath;

        const auto sidecarEntry = FindSidecarEntry(opts.repoRoot);
        if (!std::filesystem::exists(sidecarEntry))
        {
            errorOut = "chain runtime: sidecar entry not found at " + sidecarEntry.string()
                + " — build with `cmake --build build --target agent_bundle`";
            return false;
        }

        // ---- Construct + start the game-side Outbox first; if this fails we don't bother
        // launching the sidecar (it would just spin trying to read an absent WAL).
        if (!gOutboxStarted)
        {
            OutboxOptions oboxOpts;
            oboxOpts.walPath = walPath.string();
            // maxBytes / ringCapacity defaults from chain/Outbox.h apply (500 MiB / 65536).
            auto outbox = std::make_unique<Outbox>(std::move(oboxOpts));
            if (!outbox->Start())
            {
                errorOut = "chain runtime: Outbox::Start failed (see prior log)";
                return false;
            }
            SetOutbox(std::move(outbox));
            gOutboxStarted = true;

            // Bootstrap the park-entrance venue. Guests pay at the entrance with
            // `venueId == kVenueIdEntrance` (Peep.cpp), so the on-chain VenueRegistry needs
            // a matching entry or every entrance fee drops at the dispatcher with
            // `VenueNotRegistered`. Outbox dedupes, so re-runs are safe.
            if (auto* startedOutbox = GetOutbox())
            {
                startedOutbox->PushVenueRegistered(kVenueIdEntrance, VenueKind::ParkEntrance, "Park Entrance", "");
            }
        }

        // ---- Resolve node before fork — `execve` does no PATH search.
        const auto nodeBin = LookupExecutable("node");
        if (nodeBin.empty())
        {
            errorOut = "chain runtime: `node` not found in PATH or standard install locations "
                       "(/opt/homebrew/bin, /usr/local/bin, /usr/bin)";
            return false;
        }

        // ---- Build sidecar argv. Mirrors the flags introduced across M2.x / M3.x.
        SidecarProcess::Options spawnOpts;
        spawnOpts.workingDirectory = opts.repoRoot.string();
        spawnOpts.logFilePath = sidecarLogPath.string();
        spawnOpts.argv = {
            nodeBin,
            sidecarEntry.string(),
            "--socket", socketPath.string(),
            "--outbox", walPath.string(),
            "--outbox-cursor", cursorPath.string(),
            "--keystore", keystorePath.string(),
        };
        // Optional knobs sourced from environment so the user can override without touching
        // C++. Empty values are skipped — the sidecar's own defaults take over.
        auto pushIfSet = [&](const char* envName, const char* flag) {
            if (const char* v = std::getenv(envName); v != nullptr && v[0] != '\0')
            {
                spawnOpts.argv.emplace_back(flag);
                spawnOpts.argv.emplace_back(v);
            }
        };
        pushIfSet("MONAD_RPC_URL", "--rpc-url");
        pushIfSet("MONAD_DEPLOYMENTS", "--deployments");
        pushIfSet("FAUCET_OWNER_KEYFILE", "--faucet-owner-keyfile");

        gSidecar = std::make_unique<SidecarProcess>();
        std::string spawnErr;
        if (!gSidecar->Start(spawnOpts, spawnErr))
        {
            errorOut = "chain runtime: sidecar spawn failed: " + spawnErr;
            gSidecar.reset();
            return false;
        }
        LOG_INFO("chain.runtime: up; wal=%s socket=%s", walPath.string().c_str(), socketPath.string().c_str());
        return true;
    }

    void TeardownRuntime()
    {
        std::lock_guard<std::mutex> lock(gRuntimeMutex);
        if (gSidecar)
        {
            gSidecar->Stop();
            gSidecar.reset();
        }
        if (gOutboxStarted)
        {
            // Drop the global; its destructor calls Stop() to drain + close the WAL.
            SetOutbox(nullptr);
            gOutboxStarted = false;
        }
    }

    bool IsRuntimeUp()
    {
        std::lock_guard<std::mutex> lock(gRuntimeMutex);
        return gOutboxStarted && gSidecar && gSidecar->IsRunning();
    }
} // namespace OpenRCT2::Chain

#endif // OPENRCT2_CHAIN
