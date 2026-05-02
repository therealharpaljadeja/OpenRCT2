#pragma once

#include <vector>

#include "rctctl/cli/cli.hpp"

namespace rctctl::commands {

void AppendParkCommands(std::vector<cli::CommandSpec>& specs);
void AppendEnvironmentCommands(std::vector<cli::CommandSpec>& specs);
void AppendShopCommands(std::vector<cli::CommandSpec>& specs);
void AppendRideCommands(std::vector<cli::CommandSpec>& specs);
void AppendGuestCommands(std::vector<cli::CommandSpec>& specs);
void AppendStaffCommands(std::vector<cli::CommandSpec>& specs);
void AppendResearchMarketingCommands(std::vector<cli::CommandSpec>& specs);
void AppendFinanceCommands(std::vector<cli::CommandSpec>& specs);
void AppendNewsWeatherCommands(std::vector<cli::CommandSpec>& specs);
void AppendWindowCommands(std::vector<cli::CommandSpec>& specs);
void AppendBugCommands(std::vector<cli::CommandSpec>& specs);
void AppendChainCommands(std::vector<cli::CommandSpec>& specs);

} // namespace rctctl::commands
