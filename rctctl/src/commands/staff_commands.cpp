#include "rctctl/commands/command_groups.hpp"

#include "rctctl/cli/cli.hpp"
#include "rctctl/renderers/staff.hpp"

#include <iostream>
#include <nlohmann/json.hpp>
#include <string_view>

namespace rctctl::commands {
namespace {
using json = nlohmann::json;

using cli::CommandArgSpec;
using cli::CommandPlan;
using cli::CommandSpec;
using cli::ParsedArgs;
}

void AppendStaffCommands(std::vector<CommandSpec>& specs)
{
    specs.push_back(CommandSpec{
        "staff",
        { "list" },
        "List staff members.",
        "Shows staff roster with optional filtering/sorting. IDs are internal game entity IDs (non-sequential).",
        { CommandArgSpec{ "limit", "Max staff to show.", false, "INT" },
          CommandArgSpec{ "role", "Filter by role (handyman/mechanic/security/entertainer).", false, "ROLE" },
          CommandArgSpec{ "order", "Sort by id, name, role, energy, wage, or hire.", false, "FIELD" },
          CommandArgSpec{ "direction", "Sort order asc/desc.", false, "DIR" } },
        [](const ParsedArgs& args) {
            json params = json::object();
            if (auto limit = cli::GetIntOption(args, { "limit" }))
            {
                params["limit"] = *limit;
            }
            if (auto role = cli::GetStringOption(args, { "role" }))
            {
                params["role"] = *role;
            }
            if (auto order = cli::GetStringOption(args, { "order" }))
            {
                params["order"] = *order;
            }
            if (auto direction = cli::GetStringOption(args, { "direction" }))
            {
                params["direction"] = *direction;
            }
            return CommandPlan{ "staff.list", params };
        },
        renderers::RenderStaffList });

    specs.push_back(CommandSpec{
        "staff",
        { "get" },
        "Inspect a staffer.",
        "Shows stats/patrol info for a staff member. Specify via --id or --name (exact match, case-insensitive).",
        { CommandArgSpec{ "id", "Staff identifier.", false, "INT" },
          CommandArgSpec{ "name", "Staff name (exact match, case-insensitive).", false, "NAME" } },
        [](const ParsedArgs& args) {
            json params = json::object();
            if (auto id = cli::GetIntOption(args, { "id" }))
            {
                params["id"] = *id;
            }
            else if (auto name = cli::GetStringOption(args, { "name" }))
            {
                params["name"] = *name;
            }
            else
            {
                throw std::runtime_error("Invalid: Provide --id or --name to identify staff member");
            }
            return CommandPlan{ "staff.get", params };
        },
        [](const json& result) { renderers::RenderStaffDetail(result); } });

    specs.push_back(CommandSpec{
        "staff",
        { "hire" },
        "Hire new staff.",
        "Hires staff via staff.hire --type <handyman|mechanic|security|entertainer>. Alias: --role.",
        { CommandArgSpec{ "type", "Staff role (handyman, mechanic, security, entertainer).", false, "STRING" },
          CommandArgSpec{ "role", "Alias for --type.", false, "STRING" },
          CommandArgSpec{ "costume", "Entertainer costume index.", false, "INT" },
          CommandArgSpec{ "auto-place", "true to auto-place in park.", false, "BOOL" } },
        [](const ParsedArgs& args) {
            json params = json::object();
            params["type"] = cli::RequireStringOption(args, { "type", "role" }, "staff type (--type or --role)");
            if (auto costume = cli::GetIntOption(args, { "costume" }))
            {
                params["costume"] = *costume;
            }
            if (auto autoPlace = cli::GetBoolOption(args, { "auto-place" }))
            {
                params["autoPlace"] = *autoPlace;
            }
            return CommandPlan{ "staff.hire", params };
        },
        renderers::RenderStaffDetail });

    specs.push_back(CommandSpec{
        "staff",
        { "fire" },
        "Fire staff member.",
        "Dismisses staff by --id.",
        { CommandArgSpec{ "id", "Staff identifier.", true, "INT" } },
        [](const ParsedArgs& args) {
            json params = json::object();
            params["id"] = cli::RequireIntOption(args, { "id" }, "id");
            return CommandPlan{ "staff.fire", params };
        },
        [](const json& result) {
            std::cout << "Staff #" << result.value("id", -1) << " fired.\n";
        } });

    specs.push_back(CommandSpec{
        "staff",
        { "patrol" },
        "Assign or clear a patrol area.",
        "Uses staff.setPatrol --id <n> [--mode set|unset|clear] plus tile brush (--x/--y/--width/--height).",
        { CommandArgSpec{ "id", "Staff identifier.", true, "INT" },
          CommandArgSpec{ "mode", "set (default), unset, or clear.", false, "MODE" },
          CommandArgSpec{ "x", "Tile X coordinate.", false, "X" },
          CommandArgSpec{ "y", "Tile Y coordinate.", false, "Y" },
          CommandArgSpec{ "width", "Brush width in tiles (default 1).", false, "W" },
          CommandArgSpec{ "height", "Brush height in tiles (default 1).", false, "H" } },
        [](const ParsedArgs& args) {
            json params = json::object();
            params["id"] = cli::RequireIntOption(args, { "id" }, "staff id");
            if (auto mode = cli::GetStringOption(args, { "mode" }))
            {
                params["mode"] = *mode;
            }
            if (auto x = cli::GetIntOption(args, { "x" }))
            {
                params["x"] = *x;
            }
            if (auto y = cli::GetIntOption(args, { "y" }))
            {
                params["y"] = *y;
            }
            if (auto width = cli::GetIntOption(args, { "width" }))
            {
                params["width"] = *width;
            }
            if (auto height = cli::GetIntOption(args, { "height" }))
            {
                params["height"] = *height;
            }
            return CommandPlan{ "staff.setPatrol", params };
        },
        [](const json& result) {
            const auto& staff = result.contains("staff") ? result["staff"] : result;
            renderers::RenderStaffDetail(staff);
        } });

    specs.push_back(CommandSpec{
        "staff",
        { "orders" },
        "Toggle staff task orders.",
        "Wraps staff.setOrders to enable/disable sweeping, watering, inspections, etc. Only valid for handymen/mechanics.",
        { CommandArgSpec{ "id", "Staff identifier.", true, "INT" },
          CommandArgSpec{ "sweeping", "(Handyman) allow sweeping?", false, "BOOL" },
          CommandArgSpec{ "watering", "(Handyman) allow watering flowers?", false, "BOOL" },
          CommandArgSpec{ "empty-bins", "(Handyman) allow emptying bins?", false, "BOOL" },
          CommandArgSpec{ "mowing", "(Handyman) allow mowing lawns?", false, "BOOL" },
          CommandArgSpec{ "inspect", "(Mechanic) allow inspections?", false, "BOOL" },
          CommandArgSpec{ "fix", "(Mechanic) allow repairs?", false, "BOOL" } },
        [](const ParsedArgs& args) {
            json params = json::object();
            params["id"] = cli::RequireIntOption(args, { "id" }, "staff id");

            auto apply = [&](std::initializer_list<std::string_view> names, const char* key, bool& mutated) {
                if (auto value = cli::GetBoolOption(args, names))
                {
                    params[key] = *value;
                    mutated = true;
                }
            };

            bool mutated = false;
            apply({ "sweeping" }, "sweeping", mutated);
            apply({ "watering" }, "watering", mutated);
            apply({ "empty-bins", "empty_bins" }, "emptyBins", mutated);
            apply({ "mowing" }, "mowing", mutated);
            apply({ "inspect", "inspect-rides" }, "inspectRides", mutated);
            apply({ "fix", "fix-rides" }, "fixRides", mutated);

            if (!mutated)
            {
                throw std::runtime_error("Invalid: Provide at least one order toggle (use --sweeping, --inspect, --mowing, etc.)");
            }

            return CommandPlan{ "staff.setOrders", params };
        },
        [](const json& result) {
            const auto& staff = result.contains("staff") ? result["staff"] : result;
            renderers::RenderStaffDetail(staff);
        } });

    specs.push_back(CommandSpec{
        "staff",
        { "pickup" },
        "Pick up a staff member for relocation.",
        "Lifts a staff member off the map, entering 'picked' state. Staff must not be busy with a task. "
        "After pickup, use 'staff place' to set them down at a new location, or 'staff drop' to return "
        "them to their original position.",
        { CommandArgSpec{ "id", "Staff identifier.", true, "INT" } },
        [](const ParsedArgs& args) {
            json params = json::object();
            params["id"] = cli::RequireIntOption(args, { "id" }, "staff id");
            return CommandPlan{ "staff.pickup", params };
        },
        [](const json& result) {
            const auto& staff = result.contains("staff") ? result["staff"] : result;
            renderers::RenderStaffDetail(staff);
        } });

    specs.push_back(CommandSpec{
        "staff",
        { "place" },
        "Place a picked-up staff member at a new location.",
        "Sets down a staff member who is currently in 'picked' state (from 'staff pickup') at tile --x --y. "
        "Height --z defaults to surface/path height if not specified. Fails if staff is not picked up "
        "or destination is invalid.",
        { CommandArgSpec{ "id", "Staff identifier.", true, "INT" },
          CommandArgSpec{ "x", "Destination tile X coordinate.", true, "INT" },
          CommandArgSpec{ "y", "Destination tile Y coordinate.", true, "INT" },
          CommandArgSpec{ "z", "Optional height in tile units (defaults to surface).", false, "INT" } },
        [](const ParsedArgs& args) {
            json params = json::object();
            params["id"] = cli::RequireIntOption(args, { "id" }, "staff id");
            params["x"] = cli::RequireIntOption(args, { "x" }, "tile x");
            params["y"] = cli::RequireIntOption(args, { "y" }, "tile y");
            if (auto z = cli::GetIntOption(args, { "z" }))
            {
                params["z"] = *z;
            }
            return CommandPlan{ "staff.place", params };
        },
        [](const json& result) {
            const auto& staff = result.contains("staff") ? result["staff"] : result;
            renderers::RenderStaffDetail(staff);
        } });

    specs.push_back(CommandSpec{
        "staff",
        { "drop" },
        "Cancel pickup and restore staff to original location.",
        "Returns a staff member in 'picked' state to where they were before pickup. Use this to abort "
        "a relocation after 'staff pickup'. Only works if the staff is currently picked up.",
        { CommandArgSpec{ "id", "Staff identifier.", true, "INT" } },
        [](const ParsedArgs& args) {
            json params = json::object();
            params["id"] = cli::RequireIntOption(args, { "id" }, "staff id");
            return CommandPlan{ "staff.drop", params };
        },
        [](const json& result) {
            const auto& staff = result.contains("staff") ? result["staff"] : result;
            renderers::RenderStaffDetail(staff);
        } });
}

} // namespace rctctl::commands
