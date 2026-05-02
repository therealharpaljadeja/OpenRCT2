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
}

} // namespace rctctl::commands
