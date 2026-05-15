#include "rctctl/commands/command_groups.hpp"

#include "rctctl/cli/cli.hpp"
#include "rctctl/renderers/chain.hpp"

#include <nlohmann/json.hpp>

namespace rctctl::commands {
namespace {
using json = nlohmann::json;

using cli::CommandPlan;
using cli::CommandSpec;
using cli::ParsedArgs;
}

void AppendChainCommands(std::vector<CommandSpec>& specs)
{
    specs.push_back(CommandSpec{
        "chain",
        { "status" },
        "Chain integration status.",
        "Shows whether Monad chain integration is enabled for this session. "
        "When enabled, returns sidecar and throughput summary; otherwise reports disabled.",
        {},
        [](const ParsedArgs&) {
            return CommandPlan{ "chain.status", json::object() };
        },
        renderers::RenderChainStatus });

    specs.push_back(CommandSpec{
        "chain",
        { "earnings" },
        "Park earnings summary across every venue.",
        "Aggregates on-chain PARK held by each venue's CREATE2 sub-account (entrance fees, "
        "ride fares, shop sales, etc.) plus the operating treasury balance and pipeline "
        "health. Use --all to list every venue (default shows the top 5). Pair with --json "
        "for the raw IPC payload.",
        {
            cli::CommandArgSpec{ "all", "Show every venue, not just the top 5.", false, "" },
        },
        [](const ParsedArgs& args) {
            json params = json::object();
            // The sidecar slices byVenue to top 5 by default; pass `all` through so the
            // server returns the complete sorted list when the operator asks for it.
            if (cli::GetBoolOption(args, { "--all", "all" }).value_or(false))
                params["all"] = true;
            return CommandPlan{ "chain.parkEarnings", std::move(params) };
        },
        renderers::RenderParkEarnings });
}

} // namespace rctctl::commands
