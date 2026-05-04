/*****************************************************************************
 * Copyright (c) 2014-2025 OpenRCT2 developers
 *
 * For a complete list of all authors, please refer to contributors.md
 * Interested in contributing? Visit https://github.com/OpenRCT2/OpenRCT2
 *
 * OpenRCT2 is licensed under the GNU General Public License version 3.
 *****************************************************************************/

#include "AIAgentLaunch.h"

#ifdef OPENRCT2_CHAIN
    #include "../OpenRCT2.h"
    #include "../chain/Runtime.h"
#endif

#include <cctype>
#include <chrono>
#include <cstdlib>
#include <ctime>
#include <filesystem>
#include <fstream>
#include <iomanip>
#include <optional>
#include <sstream>
#include <string_view>
#include <system_error>
#include <vector>
#include <vector>

#include "../Context.h"
#include "../GameState.h"
#include "../OpenRCT2.h"
#include "../PlatformEnvironment.h"
#include "../platform/Platform.h"

#if defined(__APPLE__) || defined(__linux__) || defined(__FreeBSD__) || defined(__NetBSD__) || defined(__OpenBSD__)
    #include <unistd.h>
#endif

namespace OpenRCT2::Terminal
{
    namespace
    {
        constexpr const char* kAgentWorkspaceDir = ".openrct2-agent";
        constexpr const char* kWorkspaceReadme = "CLAUDE.md";
        constexpr const char* kRepoReadmeFilename = "IN_GAME_AGENT.md";
        constexpr int kMaxRepoSearchDepth = 8;

#if defined(__APPLE__) || defined(__linux__) || defined(__FreeBSD__) || defined(__NetBSD__) || defined(__OpenBSD__)
        std::optional<std::string> FindExecutable(const std::string& name)
        {
            if (name.empty())
            {
                return std::nullopt;
            }

            if (name.find('/') != std::string::npos)
            {
                if (access(name.c_str(), X_OK) == 0)
                {
                    return name;
                }
                return std::nullopt;
            }

            const char* pathEnv = std::getenv("PATH");
            if (pathEnv == nullptr)
            {
                return std::nullopt;
            }

            std::string_view remaining(pathEnv);
            size_t start = 0;
            while (start <= remaining.size())
            {
                const size_t end = remaining.find(':', start);
                auto segment = remaining.substr(start, end == std::string_view::npos ? remaining.size() - start : end - start);
                if (!segment.empty())
                {
                    std::filesystem::path candidate = std::filesystem::path(segment) / name;
                    if (access(candidate.c_str(), X_OK) == 0)
                    {
                        return candidate.string();
                    }
                }
                if (end == std::string_view::npos)
                {
                    break;
                }
                start = end + 1;
            }

            return std::nullopt;
        }

        bool IsStubWorkspaceReadme(const std::filesystem::path& readmePath)
        {
            std::ifstream in(readmePath);
            if (!in)
            {
                return false;
            }
            std::string firstLine;
            if (!std::getline(in, firstLine))
            {
                return false;
            }
            return firstLine.find("AI Agent x OpenRCT2") != std::string::npos
                || firstLine.find("Claude Code x OpenRCT2") != std::string::npos;
        }

        struct SeedResult
        {
            bool success = false;
            std::string error;
        };

        SeedResult SeedWorkspaceReadme(
            const std::filesystem::path& workspace, const std::filesystem::path& repoRoot)
        {
            // Claude Code CLI looks for CLAUDE.md in .claude/ subdirectory
            auto agentConfigDir = workspace / ".claude";
            auto readmePath = agentConfigDir / kWorkspaceReadme;

            auto repoReadme = repoRoot / "ai-agent-workspace" / kRepoReadmeFilename;
            if (!std::filesystem::exists(repoReadme))
            {
                return { false, "IN_GAME_AGENT.md not found at: " + repoReadme.string() };
            }

            std::error_code dirEc;
            std::filesystem::create_directories(agentConfigDir, dirEc);
            if (dirEc)
            {
                return { false, "Failed to create agent config directory: " + dirEc.message() };
            }

            // Copy if missing, stub, or source is newer than deployed
            bool readmeExists = std::filesystem::exists(readmePath);
            bool shouldCopy = !readmeExists || IsStubWorkspaceReadme(readmePath);

            // Also copy if source is newer than deployed (sync updates)
            if (!shouldCopy && readmeExists)
            {
                std::error_code ec;
                auto sourceTime = std::filesystem::last_write_time(repoReadme, ec);
                if (!ec)
                {
                    auto deployedTime = std::filesystem::last_write_time(readmePath, ec);
                    if (!ec && sourceTime > deployedTime)
                    {
                        shouldCopy = true;
                    }
                }
            }

            if (shouldCopy)
            {
                std::error_code copyEc;
                std::filesystem::copy_file(
                    repoReadme, readmePath, std::filesystem::copy_options::overwrite_existing, copyEc);
                if (copyEc)
                {
                    return { false, "Failed to copy IN_GAME_AGENT.md: " + copyEc.message() };
                }
            }

            return { true, "" };
        }

        struct WorkspaceResult
        {
            std::filesystem::path path;
            bool success = false;
            std::string error;
        };

        WorkspaceResult EnsureWorkspace()
        {
            const char* home = std::getenv("HOME");
            if (!home || !*home)
            {
                return { {}, false, "HOME environment variable not set" };
            }
            auto workspace = std::filesystem::path(home) / kAgentWorkspaceDir;
            std::error_code ec;
            std::filesystem::create_directories(workspace, ec);
            if (ec)
            {
                return { {}, false, "Failed to create workspace directory: " + ec.message() };
            }

            return { workspace, true, "" };
        }

        bool LooksLikeRepoRoot(const std::filesystem::path& candidate)
        {
            return std::filesystem::exists(candidate / "rctctl" / "CMakeLists.txt")
                && std::filesystem::exists(candidate / "src");
        }

        std::optional<std::filesystem::path> DetectRepoRoot()
        {
            std::vector<std::filesystem::path> seeds;

            try
            {
                seeds.push_back(std::filesystem::current_path());
            }
            catch (...)
            {
                // Ignore failures; other probes may still succeed.
            }

            if (auto* ctx = GetContext())
            {
                auto openrctDir = ctx->GetPlatformEnvironment().GetDirectoryPath(DirBase::openrct2);
                if (!openrctDir.empty())
                {
                    seeds.emplace_back(std::filesystem::u8path(openrctDir));
                }
            }

            auto exePath = Platform::GetCurrentExecutablePath();
            if (!exePath.empty())
            {
                auto exeDir = std::filesystem::u8path(exePath).parent_path();
                if (!exeDir.empty())
                {
                    seeds.emplace_back(std::move(exeDir));
                }
            }

            for (const auto& seed : seeds)
            {
                auto current = seed;
                for (int depth = 0; depth < kMaxRepoSearchDepth && !current.empty(); ++depth)
                {
                    if (LooksLikeRepoRoot(current))
                    {
                        return current;
                    }

                    auto parent = current.parent_path();
                    if (parent == current)
                    {
                        break;
                    }
                    current = std::move(parent);
                }
            }

            return std::nullopt;
        }

        std::optional<std::filesystem::path> FindRctctlBinary(const std::optional<std::filesystem::path>& repoRoot)
        {
            const auto base = repoRoot.value_or(std::filesystem::current_path());
            std::vector<std::filesystem::path> candidates = {
                base / "build" / "rctctl" / "rctctl",
                base / "build" / "rctctl" / "Release" / "rctctl",
                base / "build" / "rctctl" / "Debug" / "rctctl",
                base / "build" / "bin" / "rctctl",
                base / "build" / "rctctl",
            };

#if defined(_WIN32)
            const char* executableSuffix = ".exe";
#else
            const char* executableSuffix = "";
#endif

            for (auto& candidate : candidates)
            {
                auto withSuffix = candidate;
                if (withSuffix.extension() != executableSuffix)
                {
                    withSuffix += executableSuffix;
                }
                if (std::filesystem::is_regular_file(withSuffix))
                {
                    return withSuffix;
                }
            }

            return std::nullopt;
        }

        void PublishWorkspaceTool(
            const std::filesystem::path& workspace, const std::filesystem::path& toolPath, std::string_view alias)
        {
            if (!std::filesystem::is_regular_file(toolPath))
            {
                return;
            }

            auto binDir = workspace / "bin";
            std::error_code ec;
            std::filesystem::create_directories(binDir, ec);

            auto linkPath = binDir / alias;
            if (std::filesystem::exists(linkPath))
            {
                std::error_code removeEc;
                std::filesystem::remove(linkPath, removeEc);
            }

            std::error_code linkEc;
            std::filesystem::create_symlink(toolPath, linkPath, linkEc);
            if (linkEc)
            {
                std::error_code copyEc;
                std::filesystem::copy_file(toolPath, linkPath, std::filesystem::copy_options::overwrite_existing, copyEc);
                (void)copyEc;
            }
        }

        std::string SanitizeForFilename(const std::string& input, size_t maxLength = 40)
        {
            std::string result;
            result.reserve(std::min(input.size(), maxLength));

            for (char c : input)
            {
                if (result.size() >= maxLength)
                {
                    break;
                }
                // Replace spaces and problematic filesystem characters
                if (c == ' ' || c == '\t')
                {
                    if (!result.empty() && result.back() != '-')
                    {
                        result += '-';
                    }
                }
                else if (std::isalnum(static_cast<unsigned char>(c)) || c == '-' || c == '_')
                {
                    result += c;
                }
                // Skip other characters (/, \, :, *, ?, ", <, >, |, etc.)
            }

            // Trim trailing dashes
            while (!result.empty() && result.back() == '-')
            {
                result.pop_back();
            }

            return result;
        }

        std::optional<std::filesystem::path> PrepareSessionLogFile(const std::optional<std::filesystem::path>& repoRoot)
        {
            // Skip session logging in headless mode (test suite runs)
            if (gOpenRCT2Headless)
            {
                return std::nullopt;
            }

            if (!repoRoot)
            {
                return std::nullopt;
            }

            auto logDir = *repoRoot / "agent-logs";
            std::error_code ec;
            std::filesystem::create_directories(logDir, ec);
            if (ec)
            {
                return std::nullopt;
            }

            // Generate timestamped filename: agent-session-YYYYMMDD-HHMMSS-ParkName.log
            auto now = std::chrono::system_clock::now();
            auto timeT = std::chrono::system_clock::to_time_t(now);
            std::tm tm{};
            localtime_r(&timeT, &tm);

            std::ostringstream filename;
            filename << "agent-session-" << std::put_time(&tm, "%Y%m%d-%H%M%S");

            // Append sanitized park name if available
            const auto& parkName = getGameState().park.name;
            if (!parkName.empty())
            {
                auto sanitized = SanitizeForFilename(parkName);
                if (!sanitized.empty())
                {
                    filename << "-" << sanitized;
                }
            }

            filename << ".log";

            return logDir / filename.str();
        }

        void AddDefaultEnvironment(
            ShellLaunchOptions& options, const std::filesystem::path& workspace,
            const std::optional<std::filesystem::path>& repoRoot)
        {
            options.environment.emplace_back("TERM=xterm-256color");
            options.environment.emplace_back("LC_ALL=en_US.UTF-8");
            options.environment.emplace_back("LANG=en_US.UTF-8");
            options.environment.emplace_back("RC_AGENT_MODE=ai-agent");

            // Use a clean temp directory to avoid Claude Code crashing when its file watcher
            // encounters socket files (Discord IPC, Docker, PowerShell pipes, etc.) in /tmp.
            // This is a workaround for a Claude Code bug where fs.watch() fails on socket files.
            auto cleanTmpDir = workspace / ".tmp";
            std::error_code tmpEc;
            std::filesystem::create_directories(cleanTmpDir, tmpEc);
            if (!tmpEc)
            {
                options.environment.emplace_back("TMPDIR=" + cleanTmpDir.string());
            }

            std::vector<std::filesystem::path> candidatePaths;
            candidatePaths.emplace_back(workspace / "bin");
            candidatePaths.emplace_back(workspace);

            if (repoRoot)
            {
                options.environment.emplace_back("OPENRCT2_REPO_ROOT=" + repoRoot->string());
                candidatePaths.emplace_back(*repoRoot / "build" / "rctctl");
                candidatePaths.emplace_back(*repoRoot / "build" / "bin");
                candidatePaths.emplace_back(*repoRoot / "build");
            }

            std::string existingPath;
            if (const char* envPath = std::getenv("PATH"))
            {
                existingPath = envPath;
            }

            std::vector<std::string> segments;
            segments.reserve(candidatePaths.size() + 1);
            for (const auto& path : candidatePaths)
            {
                if (std::filesystem::exists(path))
                {
                    segments.push_back(path.string());
                }
            }
            if (!existingPath.empty())
            {
                segments.push_back(existingPath);
            }

            if (!segments.empty())
            {
                std::ostringstream buffer;
                bool first = true;
                for (size_t i = 0; i < segments.size(); ++i)
                {
                    if (!segments[i].empty())
                    {
                        if (!first)
                        {
                            buffer << ":";
                        }
                        first = false;
                        buffer << segments[i];
                    }
                }
                if (!first)
                {
                    options.environment.emplace_back("PATH=" + buffer.str());
                }
            }
        }

#endif
    } // namespace

    AIAgentLaunchPlan BuildAIAgentLaunchPlan(int cols, int rows)
    {
        AIAgentLaunchPlan plan;
        plan.options.cols = cols;
        plan.options.rows = rows;

#if defined(__APPLE__) || defined(__linux__) || defined(__FreeBSD__) || defined(__NetBSD__) || defined(__OpenBSD__)
        // Step 1: Detect repo root - REQUIRED for proper agent setup
        auto repoRoot = DetectRepoRoot();
        if (!repoRoot)
        {
            plan.error = "Could not locate OpenRCT2 repository. The AI Agent terminal requires running from a development build within the repo directory.";
            plan.available = false;
            return plan;
        }

        // Step 2: Create workspace directory
        auto workspaceResult = EnsureWorkspace();
        if (!workspaceResult.success)
        {
            plan.error = workspaceResult.error;
            plan.available = false;
            return plan;
        }
        auto workspace = workspaceResult.path;

        // Step 3: Seed IN_GAME_AGENT.md - REQUIRED for proper agent instructions
        auto seedResult = SeedWorkspaceReadme(workspace, *repoRoot);
        if (!seedResult.success)
        {
            plan.error = seedResult.error;
            plan.available = false;
            return plan;
        }

        // Step 4: Find rctctl binary - REQUIRED for agent to interact with game
        auto rctctlPath = FindRctctlBinary(repoRoot);
        if (!rctctlPath)
        {
            plan.error = "rctctl binary not found. Build the project first with: cmake --build build --target agent_bundle";
            plan.available = false;
            return plan;
        }

        // Setup workspace environment
        plan.options.workingDirectory = workspace.string();
        std::error_code workspaceEc;
        std::filesystem::create_directories(workspace / "bin", workspaceEc);
        AddDefaultEnvironment(plan.options, workspace, repoRoot);
        plan.options.environment.emplace_back("AGENT_WORKSPACE=" + plan.options.workingDirectory);

        PublishWorkspaceTool(workspace, *rctctlPath, "rctctl");

#ifdef OPENRCT2_CHAIN
        // Auto-spawn the chain sidecar (plan §M4.10). Chain mode is opt-in via --chain at
        // game start; if it's off we skip silently. Failure here is non-fatal — the agent
        // launch continues and the chain hooks no-op (Chain::GetOutbox returns nullptr).
        if (gOpenRCT2ChainEnabled)
        {
            OpenRCT2::Chain::RuntimeOptions chainOpts;
            chainOpts.repoRoot = *repoRoot;
            chainOpts.workspace = workspace;
            std::string chainErr;
            if (!OpenRCT2::Chain::EnsureRuntime(chainOpts, chainErr))
            {
                LOG_WARNING("AIAgentLaunch: chain runtime not started: %s", chainErr.c_str());
            }
        }
#endif

        // Prepare session log file for capturing full terminal output
        auto sessionLogFile = PrepareSessionLogFile(repoRoot);
        if (sessionLogFile)
        {
            plan.options.environment.emplace_back("AGENT_SESSION_LOG=" + sessionLogFile->string());
        }

        if (const char* customCommand = std::getenv("AGENT_TERMINAL_COMMAND"))
        {
            if (sessionLogFile)
            {
                // Wrap with script to capture terminal output: script -q <logfile> /bin/sh -lc <command>
                plan.options.command = { "/usr/bin/script", "-q", sessionLogFile->string(), "/bin/sh", "-lc", customCommand };
            }
            else
            {
                plan.options.command = { "/bin/sh", "-lc", customCommand };
            }
            plan.description = customCommand;
            plan.usesAgent = true;
            plan.available = true;
            return plan;
        }

        // Check for Claude Code CLI (searching for "claude" executable is intentional - it's the actual product binary name)
        if (auto agentBin = FindExecutable("claude"))
        {
            // Settings to pass to Claude Code CLI (disable spinner tips for cleaner UI)
            constexpr const char* kClaudeSettings = R"({"spinnerTipsEnabled":false})";

            // Launch Claude directly - session logs are generated in-game via SessionLogGenerator
            // on terminal close and /clear command (more reliable than external wrapper scripts)
            plan.options.command = {
                agentBin.value(), "--dangerously-skip-permissions", "--settings", kClaudeSettings
            };
            plan.description = agentBin.value();
            plan.usesAgent = true;
            plan.available = true;
            return plan;
        }

        auto resolveBootstrapScript = [&]() -> std::optional<std::filesystem::path> {
            constexpr std::string_view kBootstrap = "agent_bootstrap.sh";
            std::vector<std::filesystem::path> candidates;

            candidates.emplace_back(*repoRoot / "scripts" / kBootstrap);

            for (const auto& candidate : candidates)
            {
                if (!candidate.empty() && std::filesystem::exists(candidate))
                {
                    return candidate;
                }
            }

            return std::nullopt;
        }();

        if (resolveBootstrapScript)
        {
            if (sessionLogFile)
            {
                plan.options.command = {
                    "/usr/bin/script", "-q", sessionLogFile->string(), "/bin/bash", resolveBootstrapScript->string()
                };
            }
            else
            {
                plan.options.command = { "/bin/bash", resolveBootstrapScript->string() };
            }
            plan.description = resolveBootstrapScript->string();
            plan.usesAgent = true;
            plan.available = true;
            return plan;
        }

        plan.error = "Claude Code CLI not found. Install it with: npm install -g @anthropic-ai/claude-code";
        plan.available = false;
        return plan;
#else
        plan.error = "Agent terminal is only supported on macOS and Linux right now.";
        return plan;
#endif
    }
} // namespace OpenRCT2::Terminal
