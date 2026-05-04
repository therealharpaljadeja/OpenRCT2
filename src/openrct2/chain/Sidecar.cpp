/*****************************************************************************
 * Copyright (c) 2014-2025 OpenRCT2 developers
 *
 * For a complete list of all authors, please refer to contributors.md
 * Interested in contributing? Visit https://github.com/OpenRCT2/OpenRCT2
 *
 * OpenRCT2 is licensed under the GNU General Public License version 3.
 *****************************************************************************/

#ifdef OPENRCT2_CHAIN
    #if defined(__APPLE__) || defined(__linux__) || defined(__FreeBSD__) || defined(__NetBSD__) || defined(__OpenBSD__)

        #include "Sidecar.h"

        #include "../Diagnostic.h"

        #include <cerrno>
        #include <chrono>
        #include <cstdio>
        #include <cstdlib>
        #include <cstring>
        #include <fcntl.h>
        #include <signal.h>
        #include <sys/types.h>
        #include <sys/wait.h>
        #include <thread>
        #include <unistd.h>
        #include <vector>

namespace OpenRCT2::Chain
{
    namespace
    {
        // Build argv as null-terminated char* array from string vector. Returned vector owns
        // the memory; caller passes .data() to execve.
        std::vector<char*> ToArgv(const std::vector<std::string>& src, std::vector<std::string>& holder)
        {
            holder = src;
            std::vector<char*> out;
            out.reserve(holder.size() + 1);
            for (auto& s : holder)
                out.push_back(s.data());
            out.push_back(nullptr);
            return out;
        }

        // Compose the child's environment: parent env first, then options.environment overrides.
        // We can't call malloc-using C++ between fork and exec safely, so the vector is built
        // pre-fork and only its pointers are touched in the child.
        std::vector<char*> ComposeEnv(const std::vector<std::string>& extra, std::vector<std::string>& holder)
        {
            holder.clear();
            // Inherit parent env.
            for (char** envp = environ; envp != nullptr && *envp != nullptr; ++envp)
                holder.emplace_back(*envp);
            for (const auto& e : extra)
                holder.emplace_back(e);
            std::vector<char*> out;
            out.reserve(holder.size() + 1);
            for (auto& s : holder)
                out.push_back(s.data());
            out.push_back(nullptr);
            return out;
        }
    } // namespace

    SidecarProcess::~SidecarProcess()
    {
        Stop();
    }

    bool SidecarProcess::Start(const Options& options, std::string& errorOut)
    {
        if (_pid > 0)
        {
            errorOut = "sidecar already running";
            return false;
        }
        if (options.argv.empty())
        {
            errorOut = "sidecar argv is empty";
            return false;
        }

        std::vector<std::string> argvHolder;
        auto argv = ToArgv(options.argv, argvHolder);

        std::vector<std::string> envHolder;
        auto envp = ComposeEnv(options.environment, envHolder);

        // Open the log file pre-fork; fd is inherited across fork. Truncate so each launch
        // starts clean — small WAL-style accidentally-replayed-noise on the operator side.
        int logFd = -1;
        if (!options.logFilePath.empty())
        {
            logFd = ::open(options.logFilePath.c_str(), O_WRONLY | O_CREAT | O_TRUNC | O_CLOEXEC, 0644);
            if (logFd < 0)
            {
                errorOut = std::string("open(sidecar log): ") + std::strerror(errno);
                return false;
            }
        }

        const std::string& cwd = options.workingDirectory;

        pid_t pid = ::fork();
        if (pid < 0)
        {
            int err = errno;
            if (logFd >= 0)
                ::close(logFd);
            errorOut = std::string("fork: ") + std::strerror(err);
            return false;
        }

        if (pid == 0)
        {
            // ---- Child path. Avoid anything that might allocate or re-enter the parent's
            // mutex state — only call async-signal-safe APIs here.

            // Detach from parent's controlling terminal: new session, new process group.
            // This isolates sidecar signals from the agent terminal's PTY (the agent CLI
            // sends SIGINT/SIGWINCH to its session).
            ::setsid();

            // Redirect stdout + stderr to log file (or /dev/null).
            if (logFd >= 0)
            {
                ::dup2(logFd, STDOUT_FILENO);
                ::dup2(logFd, STDERR_FILENO);
                if (logFd > STDERR_FILENO)
                    ::close(logFd);
            }
            else
            {
                int devnull = ::open("/dev/null", O_WRONLY | O_CLOEXEC);
                if (devnull >= 0)
                {
                    ::dup2(devnull, STDOUT_FILENO);
                    ::dup2(devnull, STDERR_FILENO);
                    ::close(devnull);
                }
            }
            // Sidecar reads no stdin; redirect to /dev/null so any accidental read returns EOF.
            int devnullR = ::open("/dev/null", O_RDONLY | O_CLOEXEC);
            if (devnullR >= 0)
            {
                ::dup2(devnullR, STDIN_FILENO);
                ::close(devnullR);
            }

            if (!cwd.empty())
            {
                if (::chdir(cwd.c_str()) != 0)
                {
                    // Can't reliably log from here — the caller will notice via the
                    // sidecar's own startup-failure exit code in the log file.
                    ::_exit(126);
                }
            }

            ::execve(argv[0], argv.data(), envp.data());

            // execve only returns on failure.
            ::_exit(127);
        }

        // ---- Parent path.
        if (logFd >= 0)
            ::close(logFd);
        _pid = pid;
        LOG_INFO("chain.sidecar: spawned pid=%lld argv0=%s", static_cast<long long>(_pid), options.argv[0].c_str());
        return true;
    }

    void SidecarProcess::Stop()
    {
        if (_pid <= 0)
            return;
        const pid_t pid = static_cast<pid_t>(_pid);
        // SIGTERM the whole process group (we put the sidecar in its own session above).
        ::kill(-pid, SIGTERM);
        ::kill(pid, SIGTERM);

        // Wait up to ~2s for graceful shutdown.
        constexpr int kGraceMs = 2000;
        constexpr int kPollMs = 50;
        for (int waited = 0; waited < kGraceMs; waited += kPollMs)
        {
            int status = 0;
            pid_t r = ::waitpid(pid, &status, WNOHANG);
            if (r == pid || r < 0)
            {
                _pid = -1;
                LOG_INFO("chain.sidecar: stopped pid=%lld", static_cast<long long>(pid));
                return;
            }
            std::this_thread::sleep_for(std::chrono::milliseconds(kPollMs));
        }

        ::kill(-pid, SIGKILL);
        ::kill(pid, SIGKILL);
        int status = 0;
        ::waitpid(pid, &status, 0);
        _pid = -1;
        LOG_WARNING("chain.sidecar: force-killed pid=%lld", static_cast<long long>(pid));
    }

    bool SidecarProcess::IsRunning() const
    {
        if (_pid <= 0)
            return false;
        // ::kill with sig=0 probes existence without sending a signal.
        return ::kill(static_cast<pid_t>(_pid), 0) == 0;
    }

    int64_t SidecarProcess::Pid() const
    {
        return _pid;
    }
} // namespace OpenRCT2::Chain

    #endif // POSIX
#endif // OPENRCT2_CHAIN
