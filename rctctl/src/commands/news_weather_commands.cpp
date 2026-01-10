#include "rctctl/commands/command_groups.hpp"

#include "rctctl/cli/cli.hpp"
#include "rctctl/renderers/weather_news.hpp"

#include <nlohmann/json.hpp>

namespace rctctl::commands {
namespace {
using json = nlohmann::json;

using cli::CommandArgSpec;
using cli::CommandPlan;
using cli::CommandSpec;
using cli::ParsedArgs;
}

void AppendNewsWeatherCommands(std::vector<CommandSpec>& specs)
{
    specs.push_back(CommandSpec{
        "awards",
        { "list" },
        "List active park awards.",
        "Displays currently active awards and their remaining duration.",
        {},
        [](const ParsedArgs&) {
            return CommandPlan{ "park.rewards", json::object() };
        },
        renderers::RenderAwardsList });

    specs.push_back(CommandSpec{
        "awards",
        { "history" },
        "Show award history.",
        "Lists recent awards earned/lost via awards.history RPC.",
        { CommandArgSpec{ "limit", "Maximum number of awards to display.", false, "INT" } },
        [](const ParsedArgs& args) {
            json params = json::object();
            if (auto limit = cli::GetIntOption(args, { "limit" }))
            {
                if (*limit < 1)
                {
                    throw std::runtime_error("Invalid: --limit must be at least 1");
                }
                params["limit"] = *limit;
            }
            return CommandPlan{ "awards.history", params };
        },
        renderers::RenderAwardsHistory });

    specs.push_back(CommandSpec{
        "news",
        { "list" },
        "Show recent news feed.",
        "Displays the 10 most recent news items (including archived). Use --limit to change the count.",
        { CommandArgSpec{ "archived", "Include archived news items (default: true).", false, "BOOL" },
          CommandArgSpec{ "limit", "Maximum items to display (default: 10).", false, "INT" } },
        [](const ParsedArgs& args) {
            json params = json::object();

            bool includeArchived = true;
            if (auto archived = cli::GetBoolOption(args, { "archived" }))
            {
                includeArchived = *archived;
            }

            // Default to 10 items
            int limit = 10;
            if (auto userLimit = cli::GetIntOption(args, { "limit" }))
            {
                if (*userLimit < 1)
                {
                    throw std::runtime_error("Invalid: --limit must be at least 1");
                }
                limit = *userLimit;
            }
            params["limit"] = limit;

            // Use appropriate RPC method based on archived flag
            std::string method = includeArchived ? "news.archive" : "news.recent";
            return CommandPlan{ method, params };
        },
        renderers::RenderNewsList });

    specs.push_back(CommandSpec{
        "news",
        { "history" },
        "Open message history window.",
        "Opens the Recent Messages window to review notifications and news history.",
        {},
        [](const ParsedArgs&) {
            return CommandPlan{ "news.openHistory", json::object() };
        },
        renderers::RenderNewsHistory });

    specs.push_back(CommandSpec{
        "weather",
        { "status" },
        "Show current weather.",
        "Displays current weather state and forecast progress.",
        {},
        [](const ParsedArgs&) {
            return CommandPlan{ "weather.status", json::object() };
        },
        renderers::RenderWeatherStatus });

    specs.push_back(CommandSpec{
        "weather",
        { "forecast" },
        "Show next weather state.",
        "Displays next weather type and time to change.",
        {},
        [](const ParsedArgs&) {
            return CommandPlan{ "weather.forecast", json::object() };
        },
        renderers::RenderWeatherStatus });
}

} // namespace rctctl::commands
