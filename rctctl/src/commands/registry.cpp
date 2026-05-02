#include "rctctl/commands/registry.hpp"

#include "rctctl/commands/command_groups.hpp"
#include "rctctl/util/string_utils.hpp"

#include <iostream>
#include <set>

namespace rctctl::commands {
namespace {

// Resource descriptions for top-level help (progressive disclosure)
struct ResourceInfo
{
    const char* name;
    const char* description;
};

// Ordered list of resources with descriptions
// This controls the display order in --help
constexpr ResourceInfo kResourceDescriptions[] = {
    // Core
    {"park", "Park status, pricing, and ratings"},
    {"map", "Map inspection and ASCII rendering"},
    {"construction", "Land and water terraforming"},
    // Attractions
    {"rides", "Ride management and placement"},
    {"shops", "Shops and stalls"},
    {"facilities", "Kiosks, toilets, ATMs, first aid"},
    {"entrances", "Park entrance locations"},
    // Landscaping
    {"paths", "Footpath placement"},
    {"path-items", "Benches, bins, lamps on paths"},
    {"trees", "Tree placement"},
    {"scenery", "Scenery item placement"},
    // People
    {"guests", "Guest inspection and search"},
    {"staff", "Staff hiring and patrol"},
    // Finance
    {"finance", "Financial overview"},
    {"loans", "Loan management"},
    {"marketing", "Marketing campaigns"},
    // Info
    {"research", "R&D funding and priorities"},
    {"awards", "Park awards"},
    {"news", "News feed"},
    {"weather", "Weather status and forecast"},
    // Onchain
    {"chain", "Monad chain integration status and throughput"},
    // Meta
    {"bug", "Report bugs or observations"},
};

const std::vector<cli::CommandSpec>& BuildRegistry()
{
    static const std::vector<cli::CommandSpec> registry = [] {
        std::vector<cli::CommandSpec> specs;
        specs.reserve(64);
        AppendParkCommands(specs);
        AppendEnvironmentCommands(specs);
        AppendShopCommands(specs);
        AppendRideCommands(specs);
        AppendGuestCommands(specs);
        AppendStaffCommands(specs);
        AppendResearchMarketingCommands(specs);
        AppendFinanceCommands(specs);
        AppendNewsWeatherCommands(specs);
        // AppendWindowCommands(specs); // Disabled - don't expose window control to Claude
        AppendBugCommands(specs);
        AppendChainCommands(specs);
        return specs;
    }();
    return registry;
}
} // namespace

const std::vector<cli::CommandSpec>& GetCommandRegistry()
{
    return BuildRegistry();
}

const cli::CommandSpec* FindCommandSpec(const std::string& resource, const std::vector<std::string>& path)
{
    auto loweredResource = util::ToLower(resource);
    auto loweredPath = cli::NormalisePath(path);
    for (const auto& spec : GetCommandRegistry())
    {
        if (spec.resource == loweredResource && spec.path == loweredPath)
        {
            return &spec;
        }
    }
    return nullptr;
}

void PrintUsage()
{
    std::cout << "Usage:\n"
                 "  rctctl [--output text|json] <resource> <verb> [flags]\n\n"
                 "Global flags:\n"
                 "  --output FORMAT  Output format: text (default) or json\n\n"
                 "Resources:\n";

    // Build set of resources that actually have commands registered
    std::set<std::string> registeredResources;
    for (const auto& spec : GetCommandRegistry())
    {
        registeredResources.insert(spec.resource);
    }

    // Print resources in defined order with descriptions
    for (const auto& info : kResourceDescriptions)
    {
        if (registeredResources.count(info.name))
        {
            std::cout << "  " << info.name << "\n"
                      << "      " << info.description << "\n";
        }
    }

    // Print any resources not in kResourceDescriptions (safety net)
    for (const auto& resource : registeredResources)
    {
        bool found = false;
        for (const auto& info : kResourceDescriptions)
        {
            if (resource == info.name)
            {
                found = true;
                break;
            }
        }
        if (!found)
        {
            std::cout << "  " << resource << "\n";
        }
    }

    std::cout << "\nUse `rctctl <resource> --help` for available commands.\n";
}

bool PrintResourceUsage(const std::string& resource)
{
    auto lowered = util::ToLower(resource);
    std::vector<const cli::CommandSpec*> matches;
    for (const auto& spec : GetCommandRegistry())
    {
        if (spec.resource == lowered)
        {
            matches.push_back(&spec);
        }
    }

    if (matches.empty())
    {
        std::cout << "Unknown resource: " << resource << "\n";
        std::cout << "Use `rctctl --help` to see available resources.\n";
        return false;
    }

    // Find description for this resource
    const char* resourceDesc = nullptr;
    for (const auto& info : kResourceDescriptions)
    {
        if (lowered == info.name)
        {
            resourceDesc = info.description;
            break;
        }
    }

    std::cout << "Resource: " << lowered;
    if (resourceDesc)
    {
        std::cout << " - " << resourceDesc;
    }
    std::cout << "\n\nUsage:\n  rctctl " << lowered << " <command> [flags]\n\nCommands:\n";

    for (const auto* spec : matches)
    {
        // Build verb string (path without resource)
        std::string verb;
        for (const auto& part : spec->path)
        {
            if (!verb.empty())
                verb += ' ';
            verb += part;
        }
        std::cout << "  " << verb << "\n"
                  << "      " << spec->summary << "\n";
    }
    std::cout << "\nUse `rctctl " << lowered << " <command> --help` for flags.\n";
    return true;
}

bool PrintSubcommandUsage(const std::string& resource, const std::vector<std::string>& pathPrefix)
{
    auto loweredResource = util::ToLower(resource);
    auto loweredPrefix = cli::NormalisePath(pathPrefix);

    // Find all commands that match this resource and have the prefix as a path start
    std::vector<const cli::CommandSpec*> matches;
    for (const auto& spec : GetCommandRegistry())
    {
        if (spec.resource != loweredResource)
        {
            continue;
        }

        // Check if spec.path starts with pathPrefix
        if (spec.path.size() <= loweredPrefix.size())
        {
            continue;
        }

        bool prefixMatches = true;
        for (size_t i = 0; i < loweredPrefix.size(); ++i)
        {
            if (spec.path[i] != loweredPrefix[i])
            {
                prefixMatches = false;
                break;
            }
        }

        if (prefixMatches)
        {
            matches.push_back(&spec);
        }
    }

    if (matches.empty())
    {
        return false;
    }

    // Build the command prefix label
    std::string prefixLabel = loweredResource;
    for (const auto& part : loweredPrefix)
    {
        prefixLabel += ' ';
        prefixLabel += part;
    }

    std::cout << "Usage:\n  rctctl " << prefixLabel << " <subcommand> [flags]\n\nSubcommands:\n";

    for (const auto* spec : matches)
    {
        // Build subcommand string (path after prefix)
        std::string subcommand;
        for (size_t i = loweredPrefix.size(); i < spec->path.size(); ++i)
        {
            if (!subcommand.empty())
                subcommand += ' ';
            subcommand += spec->path[i];
        }
        std::cout << "  " << subcommand << "\n"
                  << "      " << spec->summary << "\n";
    }
    std::cout << "\nUse `rctctl " << prefixLabel << " <subcommand> --help` for flags.\n";
    return true;
}

void PrintCommandHelp(const cli::CommandSpec& spec)
{
    std::cout << "Usage:\n  rctctl " << cli::BuildCommandLabel(spec.resource, spec.path);
    if (!spec.args.empty())
    {
        std::cout << " [flags]";
    }
    std::cout << "\n\n" << spec.help << "\n";

    if (!spec.args.empty())
    {
        std::cout << "\nFlags:\n";
        for (const auto& arg : spec.args)
        {
            std::cout << "  --" << arg.flag;
            if (!arg.valueName.empty())
            {
                std::cout << ' ' << arg.valueName;
            }
            if (!arg.required)
            {
                std::cout << " (optional)";
            }
            std::cout << "\n      " << arg.description << "\n";
        }
    }
}

} // namespace rctctl::commands
