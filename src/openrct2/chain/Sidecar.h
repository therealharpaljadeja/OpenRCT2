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
    #include <string>
    #include <utility>
    #include <vector>

namespace OpenRCT2::Chain
{
    // Minimal POSIX subprocess wrapper for the chain-sidecar Node process. Not a general
    // process abstraction — just enough to fork+exec the sidecar, redirect its logs, track
    // the pid, and SIGTERM it on stop. Linux/macOS only (mirrors the platform gate in
    // `terminal/AIAgentLaunch.cpp`, which is the only caller).
    class SidecarProcess
    {
    public:
        struct Options
        {
            std::vector<std::string> argv;          // argv[0] is the executable path
            std::vector<std::string> environment;   // "KEY=VALUE" entries appended to inherited env
            std::string workingDirectory;           // cwd for the child; empty means inherit
            std::string logFilePath;                // sidecar stdout+stderr redirected here (truncated on start); empty means /dev/null
        };

        SidecarProcess() = default;
        ~SidecarProcess();

        SidecarProcess(const SidecarProcess&) = delete;
        SidecarProcess& operator=(const SidecarProcess&) = delete;

        // Fork + exec. Returns false on failure; populates errorOut.
        bool Start(const Options& options, std::string& errorOut);

        // Send SIGTERM, wait briefly, SIGKILL if still alive. No-op if not running.
        void Stop();

        bool IsRunning() const;
        int64_t Pid() const;

    private:
        int64_t _pid = -1;
    };
} // namespace OpenRCT2::Chain

#endif // OPENRCT2_CHAIN
