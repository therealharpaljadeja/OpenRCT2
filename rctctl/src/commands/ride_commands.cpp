#include "rctctl/commands/command_groups.hpp"

#include "rctctl/cli/cli.hpp"
#include "rctctl/renderers/rides.hpp"

#include <algorithm>
#include <cctype>
#include <nlohmann/json.hpp>
#include <stdexcept>

namespace rctctl::renderers
{
    void RenderRideDemolish(const nlohmann::json& result);
}

namespace rctctl::commands {
namespace {
using json = nlohmann::json;

using cli::CommandArgSpec;
using cli::CommandPlan;
using cli::CommandSpec;
using cli::ParsedArgs;
}

void AppendRideCommands(std::vector<CommandSpec>& specs)
{
    specs.push_back(CommandSpec{
        "rides",
        { "list" },
        "List rides in the park.",
        "Shows ride identifier, name, type, status, and approximate location.",
        {},
        [](const ParsedArgs&) {
            return CommandPlan{ "rides.list", json::object() };
        },
        renderers::RenderRideList });

    specs.push_back(CommandSpec{
        "rides",
        { "finances" },
        "Show ride-level income and profit.",
        "Mirrors the in-game ride list finance view with income/hr, running cost, and profit/hr for every ride.",
        { CommandArgSpec{ "order", "Sort column: profit, income, cost, or name.", false, "FIELD" },
          CommandArgSpec{ "direction", "Sort order: asc or desc (defaults depend on column).", false, "DIR" },
          CommandArgSpec{ "status", "Filter rides: open, closed, or all.", false, "STATUS" },
          CommandArgSpec{ "limit", "Show only the first N rides after sorting.", false, "INT" } },
        [](const ParsedArgs& args) {
            json params = json::object();
            if (auto order = cli::GetStringOption(args, { "order" }))
            {
                params["order"] = *order;
            }
            if (auto direction = cli::GetStringOption(args, { "direction" }))
            {
                params["direction"] = *direction;
            }
            if (auto status = cli::GetStringOption(args, { "status" }))
            {
                params["status"] = *status;
            }
            if (auto limit = cli::GetIntOption(args, { "limit" }))
            {
                params["limit"] = *limit;
            }
            return CommandPlan{ "rides.financials", params };
        },
        renderers::RenderRideFinancials });

    specs.push_back(CommandSpec{
        "rides",
        { "perception" },
        "Show guest perception metrics for rides.",
        "Lists rides with popularity, satisfaction, favorites, and ratings (excitement/intensity/nausea).",
        { CommandArgSpec{ "order", "Sort column: popularity, satisfaction, excitement, intensity, nausea, or favorites.", false, "FIELD" },
          CommandArgSpec{ "direction", "Sort order: asc or desc (defaults to desc).", false, "DIR" },
          CommandArgSpec{ "status", "Filter rides: open, closed, or all.", false, "STATUS" },
          CommandArgSpec{ "limit", "Show only the first N rides after sorting.", false, "INT" } },
        [](const ParsedArgs& args) {
            json params = json::object();
            if (auto order = cli::GetStringOption(args, { "order" }))
            {
                params["order"] = *order;
            }
            if (auto direction = cli::GetStringOption(args, { "direction" }))
            {
                params["direction"] = *direction;
            }
            if (auto status = cli::GetStringOption(args, { "status" }))
            {
                params["status"] = *status;
            }
            if (auto limit = cli::GetIntOption(args, { "limit" }))
            {
                params["limit"] = *limit;
            }
            return CommandPlan{ "rides.perception", params };
        },
        renderers::RenderRidePerception });

    specs.push_back(CommandSpec{
        "rides",
        { "operations" },
        "Show operational health metrics for rides.",
        "Lists rides with reliability, downtime, queue times, and customer throughput.",
        { CommandArgSpec{ "order", "Sort column: reliability, downtime, queueTime, queueLength, customers, or age.", false, "FIELD" },
          CommandArgSpec{ "direction", "Sort order: asc or desc (defaults to desc).", false, "DIR" },
          CommandArgSpec{ "status", "Filter rides: open, closed, or all.", false, "STATUS" },
          CommandArgSpec{ "limit", "Show only the first N rides after sorting.", false, "INT" } },
        [](const ParsedArgs& args) {
            json params = json::object();
            if (auto order = cli::GetStringOption(args, { "order" }))
            {
                params["order"] = *order;
            }
            if (auto direction = cli::GetStringOption(args, { "direction" }))
            {
                params["direction"] = *direction;
            }
            if (auto status = cli::GetStringOption(args, { "status" }))
            {
                params["status"] = *status;
            }
            if (auto limit = cli::GetIntOption(args, { "limit" }))
            {
                params["limit"] = *limit;
            }
            return CommandPlan{ "rides.operations", params };
        },
        renderers::RenderRideOperations });

    specs.push_back(CommandSpec{
        "rides",
        { "catalog" },
        "List buildable ride blueprints.",
        "Enumerates invented ride/stall objects (or every loaded entry with --all) with category and cost hints.",
        { CommandArgSpec{ "all", "Include locked/uninvented entries as well.", false, "BOOL" },
          CommandArgSpec{ "include-locked", "Alias for --all.", false, "BOOL" } },
        [](const ParsedArgs& args) {
            json params = json::object();
            if (auto includeLocked = cli::GetBoolOption(args, { "all", "include-locked" }))
            {
                params["includeLocked"] = *includeLocked;
            }
            return CommandPlan{ "rides.available", params };
        },
        renderers::RenderRideAvailability });

    specs.push_back(CommandSpec{
        "rides",
        { "place" },
        "Place a flat ride blueprint.",
        "Creates a flat ride using --name, --entry-index, or --type. --x/--y mark the ride's north-west (top-left) tile.",
        { CommandArgSpec{ "type", "Ride object identifier (see rides catalog).", false, "ID" },
          CommandArgSpec{ "name", "Display name from the catalog (e.g., \"Ferris Wheel\").", false, "STRING" },
          CommandArgSpec{ "entry-index", "Entry index from rides catalog.", false, "INT" },
          CommandArgSpec{ "x", "Tile X coordinate for the north-west anchor.", true, "INT" },
          CommandArgSpec{ "y", "Tile Y coordinate for the north-west anchor.", true, "INT" },
          CommandArgSpec{ "z", "Optional height in tile units. Defaults to surface.", false, "INT" },
          CommandArgSpec{ "facing", "Optional facing: north, south, east, or west (default south).", false, "DIR" },
          CommandArgSpec{ "dry-run", "Validate placement and estimate cost without actually building. Returns feasibility, estimated cost, and placement details. The camera will pan to the target location.", false, "BOOL" } },
        [](const ParsedArgs& args) {
            json params = json::object();

            auto appendEntryIndex = [&](int value) {
                if (value >= 0)
                {
                    params["entryIndex"] = value;
                }
            };

            auto hasSelector = false;
            if (auto type = cli::GetStringOption(args, { "type" }))
            {
                hasSelector = true;
                const auto& typeValue = *type;
                const bool numeric = !typeValue.empty()
                    && std::all_of(typeValue.begin(), typeValue.end(), [](unsigned char ch) { return std::isdigit(ch); });
                if (numeric)
                {
                    appendEntryIndex(cli::ParseIntValue(typeValue, "type"));
                }
                else
                {
                    params["type"] = typeValue;
                }
            }
            if (auto name = cli::GetStringOption(args, { "name" }))
            {
                hasSelector = true;
                params["name"] = *name;
            }
            if (auto entryIndex = cli::GetIntOption(args, { "entry-index", "entryIndex" }))
            {
                hasSelector = true;
                appendEntryIndex(*entryIndex);
            }
            if (!hasSelector)
            {
                throw std::runtime_error("Invalid: Provide --name, --entry-index, or --type to choose a ride");
            }

            params["x"] = cli::RequireIntOption(args, { "x" }, "x");
            params["y"] = cli::RequireIntOption(args, { "y" }, "y");
            if (auto z = cli::GetIntOption(args, { "z" }))
            {
                params["z"] = *z;
            }
            if (auto facing = cli::GetStringOption(args, { "facing" }))
            {
                params["facing"] = *facing;
            }
            if (auto dryRun = cli::GetBoolOption(args, { "dry-run", "dryRun" }))
            {
                params["dryRun"] = *dryRun;
            }
            return CommandPlan{ "rides.place", params };
        },
        renderers::RenderRidePlacement });

    specs.push_back(CommandSpec{
        "rides",
        { "get" },
        "Show ride state and maintenance info.",
        "Displays status, mode, trains, queue length, maintenance health, and finance stats for a ride. "
        "Also shows entrance/exit path connectivity status (whether a path is connected to each access point). "
        "Specify the ride via --id or --name.",
        { CommandArgSpec{ "id", "Ride identifier (numeric).", false, "ID" },
          CommandArgSpec{ "name", "Ride name (case-insensitive).", false, "NAME" } },
        [](const ParsedArgs& args) {
            json params = json::object();
            cli::ApplyRideSelector(params, args);
            return CommandPlan{ "rides.status", params };
        },
        renderers::RenderRideStatus });

    specs.push_back(CommandSpec{
        "rides",
        { "breakdowns" },
        "Summarize breakdown history.",
        "Shows current/pending breakdown reasons, mechanic status, and a recent downtime timeline for a ride.",
        { CommandArgSpec{ "id", "Ride identifier (numeric).", false, "ID" },
          CommandArgSpec{ "name", "Ride name (case-insensitive).", false, "NAME" } },
        [](const ParsedArgs& args) {
            json params = json::object();
            cli::ApplyRideSelector(params, args);
            return CommandPlan{ "rides.breakdowns", params };
        },
        renderers::RenderRideBreakdowns });

    specs.push_back(CommandSpec{
        "rides",
        { "throughput" },
        "Inspect throughput metrics.",
        "Mirrors the in-game Customers tab: riders/hour, queue stats, satisfaction, and recent interval history.",
        { CommandArgSpec{ "id", "Ride identifier (numeric).", false, "ID" },
          CommandArgSpec{ "name", "Ride name (case-insensitive).", false, "NAME" } },
        [](const ParsedArgs& args) {
            json params = json::object();
            cli::ApplyRideSelector(params, args);
            return CommandPlan{ "rides.throughput", params };
        },
        renderers::RenderRideThroughput });

    specs.push_back(CommandSpec{
        "rides",
        { "feedback" },
        "Summarize guest thoughts about a ride.",
        "Clusters the most common guest thoughts tied to the ride with sample guest ids (defaults: 6 groups, 5 guests each).",
        { CommandArgSpec{ "id", "Ride identifier (numeric).", false, "ID" },
          CommandArgSpec{ "name", "Ride name (case-insensitive).", false, "NAME" },
          CommandArgSpec{ "limit", "Thought groups to show (default 6).", false, "INT" },
          CommandArgSpec{ "guest-limit", "Sample guests per group (default 5).", false, "INT" } },
        [](const ParsedArgs& args) {
            json params = json::object();
            cli::ApplyRideSelector(params, args);
            if (auto limit = cli::GetIntOption(args, { "limit" }))
            {
                params["limit"] = *limit;
            }
            if (auto guestLimit = cli::GetIntOption(args, { "guest-limit", "guestLimit" }))
            {
                params["guestLimit"] = *guestLimit;
            }
            return CommandPlan{ "rides.feedback", params };
        },
        renderers::RenderRideFeedback });

    specs.push_back(CommandSpec{
        "rides",
        { "entrance", "place" },
        "Place a ride entrance.",
        "Places an entrance adjacent to the ride's station platform. For coasters, this must be next to a station track piece. "
        "For flat rides, this must be adjacent to a valid entrance point on the ride platform.\n\n"
        "Use the entranceCandidates from 'rides place' output to find valid positions (same positions work for exits). "
        "The entrance automatically faces toward the station.",
        { CommandArgSpec{ "id", "Ride identifier (numeric).", false, "ID" },
          CommandArgSpec{ "name", "Ride name (case-insensitive).", false, "NAME" },
          CommandArgSpec{ "x", "Tile X coordinate for the entrance building.", true, "INT" },
          CommandArgSpec{ "y", "Tile Y coordinate for the entrance building.", true, "INT" },
          CommandArgSpec{ "station", "Station index to attach (default 0).", false, "INT" } },
        [](const ParsedArgs& args) {
            json params = json::object();
            cli::ApplyRideSelector(params, args);
            params["x"] = cli::RequireIntOption(args, { "x" }, "x");
            params["y"] = cli::RequireIntOption(args, { "y" }, "y");
            if (auto station = cli::GetIntOption(args, { "station" }))
            {
                params["station"] = *station;
            }
            return CommandPlan{ "rides.entrancePlace", params };
        },
        renderers::RenderRideEntrancePlacement });

    specs.push_back(CommandSpec{
        "rides",
        { "exit", "place" },
        "Place a ride exit.",
        "Places an exit adjacent to the ride's station platform. For coasters, this must be next to a station track piece. "
        "For flat rides, this must be adjacent to a valid exit point on the ride platform.\n\n"
        "Use the entranceCandidates from 'rides place' output to find valid positions (same positions work for entrances). "
        "The exit automatically faces toward the station.",
        { CommandArgSpec{ "id", "Ride identifier (numeric).", false, "ID" },
          CommandArgSpec{ "name", "Ride name (case-insensitive).", false, "NAME" },
          CommandArgSpec{ "x", "Tile X coordinate for the exit building.", true, "INT" },
          CommandArgSpec{ "y", "Tile Y coordinate for the exit building.", true, "INT" },
          CommandArgSpec{ "station", "Station index to attach (default 0).", false, "INT" } },
        [](const ParsedArgs& args) {
            json params = json::object();
            cli::ApplyRideSelector(params, args);
            params["x"] = cli::RequireIntOption(args, { "x" }, "x");
            params["y"] = cli::RequireIntOption(args, { "y" }, "y");
            if (auto station = cli::GetIntOption(args, { "station" }))
            {
                params["station"] = *station;
            }
            return CommandPlan{ "rides.exitPlace", params };
        },
        renderers::RenderRideEntrancePlacement });

    specs.push_back(CommandSpec{
        "rides",
        { "open" },
        "Open a ride to guests.",
        "Sets the ride status to OPEN via rides.setStatus RPC. Requires --id or --name.",
        { CommandArgSpec{ "id", "Ride identifier (numeric).", false, "ID" },
          CommandArgSpec{ "name", "Ride name (case-insensitive).", false, "NAME" } },
        [](const ParsedArgs& args) {
            json params = json::object();
            cli::ApplyRideSelector(params, args);
            params["status"] = "open";
            return CommandPlan{ "rides.setStatus", params };
        },
        renderers::RenderRideStatusChange });

    specs.push_back(CommandSpec{
        "rides",
        { "close" },
        "Close a ride.",
        "Sets the ride status to CLOSED. Without --evict-guests, guests currently on the ride will finish their trip before exiting. "
        "Use --evict-guests to immediately clear all guests from the ride (required for refurbishment, maintenance, or demolition).",
        { CommandArgSpec{ "id", "Ride identifier (numeric).", false, "ID" },
          CommandArgSpec{ "name", "Ride name (case-insensitive).", false, "NAME" },
          CommandArgSpec{ "evict-guests", "Immediately remove all guests (use this to fully close for refurbishment/repairs/demolition).", false, "BOOL" } },
        [](const ParsedArgs& args) {
            json params = json::object();
            cli::ApplyRideSelector(params, args);
            params["status"] = "closed";
            if (auto evict = cli::GetBoolOption(args, { "evict-guests" }))
            {
                params["evictGuests"] = *evict;
            }
            return CommandPlan{ "rides.setStatus", params };
        },
        renderers::RenderRideStatusChange });

    specs.push_back(CommandSpec{
        "rides",
        { "test" },
        "Put a ride into TESTING.",
        "Queues the ride for testing to calculate ratings. Testing typically takes 1-2 minutes for most rides. "
        "Use 'rides get' afterward to check ratings once testing completes.",
        { CommandArgSpec{ "id", "Ride identifier (numeric).", false, "ID" },
          CommandArgSpec{ "name", "Ride name (case-insensitive).", false, "NAME" } },
        [](const ParsedArgs& args) {
            json params = json::object();
            cli::ApplyRideSelector(params, args);
            params["status"] = "testing";
            return CommandPlan{ "rides.setStatus", params };
        },
        renderers::RenderRideStatusChange });

    specs.push_back(CommandSpec{
        "rides",
        { "price" },
        "Show current ride price.",
        "Displays the ride's admission price (and secondary price where applicable).",
        { CommandArgSpec{ "id", "Ride identifier (numeric).", false, "ID" },
          CommandArgSpec{ "name", "Ride name (case-insensitive).", false, "NAME" } },
        [](const ParsedArgs& args) {
            json params = json::object();
            cli::ApplyRideSelector(params, args);
            return CommandPlan{ "rides.price", params };
        },
        [](const json& result) { renderers::RenderRidePrice(result, false); } });

    specs.push_back(CommandSpec{
        "rides",
        { "price", "set" },
        "Update a ride's price.",
        "Sets the primary price (default) or secondary price (use --secondary=true) for a ride.",
        { CommandArgSpec{ "id", "Ride identifier (numeric).", false, "ID" },
          CommandArgSpec{ "name", "Ride name (case-insensitive).", false, "NAME" },
          CommandArgSpec{ "value", "Price in dollars (e.g., 12.50).", true, "AMOUNT" },
          CommandArgSpec{ "secondary", "Set to true to adjust the secondary/stall/photo price.", false, "BOOL" } },
        [](const ParsedArgs& args) {
            json params = json::object();
            cli::ApplyRideSelector(params, args);
            params["price"] = cli::RequireDoubleOption(args, { "value", "price" }, "price");
            if (auto secondary = cli::GetBoolOption(args, { "secondary" }))
            {
                params["secondary"] = *secondary;
            }
            return CommandPlan{ "rides.setPrice", params };
        },
        [](const json& result) { renderers::RenderRidePrice(result, true); } });

    specs.push_back(CommandSpec{
        "rides",
        { "rename" },
        "Rename a ride.",
        "Changes a ride's display name. Select the ride with --id and provide the new name with --name.",
        { CommandArgSpec{ "id", "Ride identifier (numeric).", true, "ID" },
          CommandArgSpec{ "name", "New ride name.", true, "STRING" } },
        [](const ParsedArgs& args) {
            json params = json::object();
            params["rideId"] = cli::RequireIntOption(args, { "id" }, "ride id");
            params["newName"] = cli::RequireStringOption(args, { "name" }, "new name");
            return CommandPlan{ "rides.rename", params };
        },
        renderers::RenderRideRename });

    specs.push_back(CommandSpec{
        "rides",
        { "tune" },
        "Adjust ride operating settings.",
        "Tweaks operating mode, wait times, circuits, lift hill speed, inspection cadence, ride-specific settings "
        "(laps/launch speed/rotations), and departure behavior via rides.configure.",
        { CommandArgSpec{ "id", "Ride identifier (numeric).", false, "ID" },
          CommandArgSpec{ "name", "Ride name (case-insensitive).", false, "NAME" },
          CommandArgSpec{ "mode", "Operating mode label (normal, race, etc.).", false, "MODE" },
          CommandArgSpec{ "min-wait", "Minimum wait time (0-255).", false, "MIN" },
          CommandArgSpec{ "max-wait", "Maximum wait time (0-255).", false, "MAX" },
          CommandArgSpec{ "num-circuits", "Number of circuits (1-255).", false, "COUNT" },
          CommandArgSpec{ "lift-hill-speed", "Lift hill speed (0-255).", false, "VALUE" },
          CommandArgSpec{ "inspection", "Inspection interval label (10m/hourly/never).", false, "LABEL" },
          CommandArgSpec{ "inspection-index", "Inspection interval index (0-6).", false, "INT" },
          CommandArgSpec{ "operation-option", "Ride-specific operating value. Meaning varies by ride type: laps (Go-Karts, 1-10), launch speed (LIM/LSM coasters, 10-31), rotations (Twist/Enterprise), time limit (Dodgems). Use 'rides get' to see operationLabel, operationMin, operationMax for a specific ride.", false, "INT" },
          CommandArgSpec{ "wait-for-load", "Departure wait-for-load level. Values: any (no waiting), quarter (25%), half (50%), three-quarter (75%), full (100%).", false, "LEVEL" },
          CommandArgSpec{ "leave-on-arrival", "Depart when another train arrives at station (true/false).", false, "BOOL" },
          CommandArgSpec{ "sync-stations", "Synchronize departure with adjacent ride stations (true/false).", false, "BOOL" } },
        [](const ParsedArgs& args) {
            json params = json::object();
            cli::ApplyRideSelector(params, args);
            bool mutated = false;

            if (auto mode = cli::GetStringOption(args, { "mode" }))
            {
                params["mode"] = *mode;
                mutated = true;
            }
            if (auto minWait = cli::GetIntOption(args, { "min-wait" }))
            {
                params["minWait"] = *minWait;
                mutated = true;
            }
            if (auto maxWait = cli::GetIntOption(args, { "max-wait" }))
            {
                params["maxWait"] = *maxWait;
                mutated = true;
            }
            if (auto circuits = cli::GetIntOption(args, { "num-circuits" }))
            {
                params["numCircuits"] = *circuits;
                mutated = true;
            }
            if (auto liftSpeed = cli::GetIntOption(args, { "lift-hill-speed" }))
            {
                params["liftHillSpeed"] = *liftSpeed;
                mutated = true;
            }
            if (auto inspection = cli::GetStringOption(args, { "inspection", "inspection-interval" }))
            {
                params["inspectionInterval"] = *inspection;
                mutated = true;
            }
            if (auto inspectionIndex = cli::GetIntOption(args, { "inspection-index" }))
            {
                params["inspectionIndex"] = *inspectionIndex;
                mutated = true;
            }

            // Operating option (laps, launch speed, rotations, time limit)
            if (auto opOption = cli::GetIntOption(args, { "operation-option" }))
            {
                params["operationOption"] = *opOption;
                mutated = true;
            }

            // Departure flags - need to combine into a single byte
            // Flag bits: 0-2 = load level, 3 = wait for load enabled, 4 = leave on arrival, 5 = sync stations
            bool hasDepartFlags = false;
            int departFlags = 0;

            if (auto waitLoad = cli::GetStringOption(args, { "wait-for-load" }))
            {
                int level = 0;
                if (*waitLoad == "any")
                    level = 0;
                else if (*waitLoad == "quarter")
                    level = 1;
                else if (*waitLoad == "half")
                    level = 2;
                else if (*waitLoad == "three-quarter")
                    level = 3;
                else if (*waitLoad == "full")
                    level = 4;
                else
                    throw std::runtime_error("Invalid wait-for-load level: " + *waitLoad + ". Use: any, quarter, half, three-quarter, full");

                departFlags = (departFlags & ~7) | level;  // Bits 0-2 = level
                if (level > 0)
                    departFlags |= (1 << 3);  // Bit 3 = wait for load enabled
                hasDepartFlags = true;
            }

            if (auto leaveOnArrival = cli::GetBoolOption(args, { "leave-on-arrival" }))
            {
                if (*leaveOnArrival)
                    departFlags |= (1 << 4);  // Bit 4 = leave when another arrives
                else
                    departFlags &= ~(1 << 4);
                hasDepartFlags = true;
            }

            if (auto syncStations = cli::GetBoolOption(args, { "sync-stations" }))
            {
                if (*syncStations)
                    departFlags |= (1 << 5);  // Bit 5 = sync with adjacent stations
                else
                    departFlags &= ~(1 << 5);
                hasDepartFlags = true;
            }

            if (hasDepartFlags)
            {
                params["departureFlags"] = departFlags;
                mutated = true;
            }

            if (!mutated)
            {
                throw std::runtime_error("Invalid: Provide at least one tuning flag (use --mode, --min-wait, --max-wait, --operation-option, etc.)");
            }

            return CommandPlan{ "rides.configure", params };
        },
        renderers::RenderRideConfigure });

    specs.push_back(CommandSpec{
        "rides",
        { "refurbish" },
        "Refurbish a ride to restore reliability.",
        "Resets a ride's breakdown history and restores it to new condition without demolishing. "
        "This is the safe way to improve a ride's reliability. The ride must be empty of guests first; "
        "use 'rides close --evict-guests' before refurbishing. Use --id or --name to select the ride.",
        { CommandArgSpec{ "id", "Ride identifier (numeric).", false, "ID" },
          CommandArgSpec{ "name", "Ride name (case-insensitive).", false, "NAME" } },
        [](const ParsedArgs& args) {
            json params = json::object();
            cli::ApplyRideSelector(params, args);
            params["mode"] = "renew";
            return CommandPlan{ "rides.demolish", params };
        },
        renderers::RenderRideDemolish });

    specs.push_back(CommandSpec{
        "rides",
        { "demolish" },
        "Permanently demolish a ride.",
        "WARNING: This permanently removes the ride and cannot be undone. Use 'rides refurbish' instead if you just want to restore reliability.",
        { CommandArgSpec{ "id", "Ride identifier (numeric).", false, "ID" },
          CommandArgSpec{ "name", "Ride name (case-insensitive).", false, "NAME" } },
        [](const ParsedArgs& args) {
            json params = json::object();
            cli::ApplyRideSelector(params, args);
            params["mode"] = "demolish";
            return CommandPlan{ "rides.demolish", params };
        },
        renderers::RenderRideDemolish });

    // ─────────────────────────────────────────────────────────────────────
    // Coaster Commands (Pre-built Track Designs)
    // ─────────────────────────────────────────────────────────────────────

    specs.push_back(CommandSpec{
        "rides",
        { "coasters", "categories" },
        "List ride categories with pre-built coasters.",
        "Shows categories (Roller Coasters, Thrill Rides, etc.) that have pre-built coasters available.\n\n"
        "Use this as a starting point to browse coasters. Then use 'rides coasters types --category <cat>'\n"
        "to see specific ride types within a category.",
        {},
        [](const ParsedArgs&) {
            return CommandPlan{ "rides.coasters.categories", json::object() };
        },
        renderers::RenderRideCoastersCategories });

    specs.push_back(CommandSpec{
        "rides",
        { "coasters", "types" },
        "List ride types with pre-built coasters.",
        "Shows ride types (Corkscrew Coaster, Log Flume, etc.) that have pre-built coasters.\n\n"
        "Each type shows its numeric ID and invention status. Use --category to filter.\n"
        "Then use 'rides coasters list --type <id>' to see specific coaster designs.\n\n"
        "Examples:\n"
        "  rides coasters types                           # All types with coasters\n"
        "  rides coasters types --category rollerCoaster  # Only roller coaster types",
        { CommandArgSpec{ "category", "Filter by category: transport, gentle, rollerCoaster, thrill, water.", false, "CAT" } },
        [](const ParsedArgs& args) {
            json params = json::object();
            if (auto cat = cli::GetStringOption(args, { "category" }))
            {
                params["category"] = *cat;
            }
            return CommandPlan{ "rides.coasters.types", params };
        },
        renderers::RenderRideCoastersTypes });

    specs.push_back(CommandSpec{
        "rides",
        { "coasters", "list" },
        "List available pre-built coasters.",
        "Shows pre-built coasters with excitement/intensity/nausea ratings.\n\n"
        "Use --type with the numeric ID from 'rides coasters types' to filter.\n"
        "Then use 'rides coasters preview' to check placement before building.\n\n"
        "Examples:\n"
        "  rides coasters list --type 10   # Coasters for ride type ID 10\n"
        "  rides coasters list             # All available coasters (may be large)",
        { CommandArgSpec{ "type", "Numeric ride type ID (from 'rides coasters types').", false, "TYPE" } },
        [](const ParsedArgs& args) {
            json params = json::object();
            if (auto type = cli::GetStringOption(args, { "type" }))
            {
                params["type"] = *type;
            }
            return CommandPlan{ "rides.coasters.list", params };
        },
        renderers::RenderRideCoastersList });

    specs.push_back(CommandSpec{
        "rides",
        { "coasters", "preview" },
        "Preview placing a pre-built coaster.",
        "Queries what would happen if a coaster were placed at the specified location.\n\n"
        "Returns cost estimate, feasibility, and any placement errors without actually building.\n"
        "If placement looks good, use 'rides coasters place' with the same arguments to build.\n\n"
        "Examples:\n"
        "  rides coasters preview --name \"Shuttle Loop\" --x 50 --y 50\n"
        "  rides coasters preview --name \"Shuttle Loop\" --x 50 --y 50 --direction 2",
        { CommandArgSpec{ "name", "Coaster name (from 'rides coasters list').", true, "NAME" },
          CommandArgSpec{ "x", "X tile coordinate for placement.", true, "X" },
          CommandArgSpec{ "y", "Y tile coordinate for placement.", true, "Y" },
          CommandArgSpec{ "z", "Optional height in tile units. Defaults to auto.", false, "Z" },
          CommandArgSpec{ "direction", "Facing direction: 0=W, 1=N, 2=E, 3=S (default 0).", false, "DIR" } },
        [](const ParsedArgs& args) {
            json params = json::object();
            if (auto name = cli::GetStringOption(args, { "name" }))
            {
                params["name"] = *name;
            }
            if (auto x = cli::GetIntOption(args, { "x" }))
            {
                params["x"] = *x;
            }
            if (auto y = cli::GetIntOption(args, { "y" }))
            {
                params["y"] = *y;
            }
            if (auto z = cli::GetIntOption(args, { "z" }))
            {
                params["z"] = *z;
            }
            if (auto dir = cli::GetIntOption(args, { "direction" }))
            {
                params["direction"] = *dir;
            }
            return CommandPlan{ "rides.coasters.preview", params };
        },
        renderers::RenderRideCoastersPreview });

    specs.push_back(CommandSpec{
        "rides",
        { "coasters", "place" },
        "Place a pre-built coaster.",
        "Places a pre-built coaster at the specified location, creating a complete ride.\n\n"
        "Includes all track and vehicles. Entrance and exit are placed automatically.\n"
        "Use --scenery to include any associated scenery items from the design.\n"
        "After placement, use 'rides open --id <id>' to open the ride to guests.\n\n"
        "Examples:\n"
        "  rides coasters place --name \"Shuttle Loop\" --x 50 --y 50\n"
        "  rides coasters place --name \"Shuttle Loop\" --x 50 --y 50 --scenery",
        { CommandArgSpec{ "name", "Coaster name (from 'rides coasters list').", true, "NAME" },
          CommandArgSpec{ "x", "X tile coordinate for placement.", true, "X" },
          CommandArgSpec{ "y", "Y tile coordinate for placement.", true, "Y" },
          CommandArgSpec{ "z", "Optional height in tile units. Defaults to auto.", false, "Z" },
          CommandArgSpec{ "direction", "Facing direction: 0=W, 1=N, 2=E, 3=S (default 0).", false, "DIR" },
          CommandArgSpec{ "scenery", "Include associated scenery (flag).", false, "" } },
        [](const ParsedArgs& args) {
            json params = json::object();
            if (auto name = cli::GetStringOption(args, { "name" }))
            {
                params["name"] = *name;
            }
            if (auto x = cli::GetIntOption(args, { "x" }))
            {
                params["x"] = *x;
            }
            if (auto y = cli::GetIntOption(args, { "y" }))
            {
                params["y"] = *y;
            }
            if (auto z = cli::GetIntOption(args, { "z" }))
            {
                params["z"] = *z;
            }
            if (auto dir = cli::GetIntOption(args, { "direction" }))
            {
                params["direction"] = *dir;
            }
            if (auto scenery = cli::GetBoolOption(args, { "scenery" }))
            {
                params["scenery"] = *scenery;
            }
            return CommandPlan{ "rides.coasters.place", params };
        },
        renderers::RenderRideCoastersPlace });

    // ========== Theme Commands ==========

    specs.push_back(CommandSpec{
        "rides",
        { "theme", "colors" },
        "List all available color names.",
        "Lists all 56 colors available for ride theming. Use these names with 'rides theme track set' "
        "and 'rides theme vehicle set'.\n\n"
        "Colors are organized by category: classic (original RCT2), extended (additional palette), "
        "and special.\n\n"
        "Common colors: black, white, bright_red, dark_blue, bright_green, yellow, bright_purple, "
        "dark_brown.\n\n"
        "Workflow: Run this first to see available colors, then use 'rides theme track set' or "
        "'rides theme vehicle set' to apply them.",
        {},
        [](const ParsedArgs& /*args*/) {
            return CommandPlan{ "rides.theme.colors.list", json::object() };
        },
        renderers::RenderColorList });

    specs.push_back(CommandSpec{
        "rides",
        { "theme", "entrance", "list" },
        "List available entrance/station styles.",
        "Lists station entrance styles loaded in the current scenario. Each style has an "
        "identifier (e.g., 'rct2.station.plain') and display name.\n\n"
        "Use any of these with 'rides theme entrance set --style <name|identifier>'.\n\n"
        "Common styles: Plain, Wooden, Canvas, Pagoda, Space, Jungle, Abstract.",
        {},
        [](const ParsedArgs& /*args*/) {
            return CommandPlan{ "rides.theme.entrance.list", json::object() };
        },
        renderers::RenderEntranceStyleList });

    specs.push_back(CommandSpec{
        "rides",
        { "theme", "get" },
        "Show all theming info for a ride.",
        "Displays complete color and style information:\n"
        "  - Track colors: 4 schemes (0-3), each with main/additional/supports\n"
        "  - Vehicle colors: body/trim/tertiary per train (count depends on mode)\n"
        "  - Vehicle color mode: same, per-train, or per-car\n"
        "  - Entrance style: station entrance/exit appearance\n\n"
        "Use this to inspect current theming before making changes. Requires --id or --name.",
        { CommandArgSpec{ "id", "Ride identifier (numeric).", false, "ID" },
          CommandArgSpec{ "name", "Ride name (case-insensitive).", false, "NAME" } },
        [](const ParsedArgs& args) {
            json params = json::object();
            cli::ApplyRideSelector(params, args);
            return CommandPlan{ "rides.theme.get", params };
        },
        renderers::RenderRideTheme });

    specs.push_back(CommandSpec{
        "rides",
        { "theme", "track", "set" },
        "Set track colors for a ride.",
        "Changes track colors for one of 4 color schemes (0-3). Each scheme has three components:\n"
        "  --main: Primary track color (rails, structure)\n"
        "  --additional: Secondary accent color\n"
        "  --supports: Support structure color\n\n"
        "Colors: Use names like bright_red, dark_blue, black, white. "
        "Run 'rides theme colors' for the full list.\n\n"
        "Scheme 0 is applied to most track. Schemes 1-3 can be painted onto specific track sections "
        "in the game's paint mode.\n\n"
        "Examples:\n"
        "  rides theme track set --id 1 --main bright_red --supports black\n"
        "  rides theme track set --name \"Corkscrew\" --scheme 1 --main dark_blue --additional white",
        { CommandArgSpec{ "id", "Ride identifier (numeric).", false, "ID" },
          CommandArgSpec{ "name", "Ride name (case-insensitive).", false, "NAME" },
          CommandArgSpec{ "scheme", "Color scheme index 0-3 (default 0). Scheme 0 is primary.", false, "INT" },
          CommandArgSpec{ "main", "Main track color (e.g., 'bright_red').", false, "COLOR" },
          CommandArgSpec{ "additional", "Additional accent color.", false, "COLOR" },
          CommandArgSpec{ "supports", "Support structure color.", false, "COLOR" } },
        [](const ParsedArgs& args) {
            json params = json::object();
            cli::ApplyRideSelector(params, args);

            bool hasColor = false;
            if (auto scheme = cli::GetIntOption(args, { "scheme" }))
            {
                params["scheme"] = *scheme;
            }
            if (auto main = cli::GetStringOption(args, { "main" }))
            {
                params["main"] = *main;
                hasColor = true;
            }
            if (auto additional = cli::GetStringOption(args, { "additional" }))
            {
                params["additional"] = *additional;
                hasColor = true;
            }
            if (auto supports = cli::GetStringOption(args, { "supports" }))
            {
                params["supports"] = *supports;
                hasColor = true;
            }

            if (!hasColor)
            {
                throw std::runtime_error(
                    "Invalid: Provide at least one color flag (--main, --additional, or --supports)");
            }

            return CommandPlan{ "rides.theme.track.set", params };
        },
        renderers::RenderRideThemeChange });

    specs.push_back(CommandSpec{
        "rides",
        { "theme", "vehicle", "set" },
        "Set vehicle/train colors for a ride.",
        "Changes the colors of ride vehicles (cars, boats, trains, etc.). Each vehicle has:\n"
        "  --body: Primary vehicle body color\n"
        "  --trim: Secondary trim/accent color\n"
        "  --tertiary: Third color (used by some vehicle types)\n\n"
        "The --train index meaning depends on vehicle color mode (see 'rides theme vehicle mode'):\n"
        "  same: Index 0 only, applies to all vehicles\n"
        "  per-train: Each index is a different train\n"
        "  per-car: Each index is a different car position\n\n"
        "Colors: Use names like bright_purple, yellow, dark_blue. "
        "Run 'rides theme colors' for the full list.\n\n"
        "Examples:\n"
        "  rides theme vehicle set --id 1 --body bright_purple --trim yellow\n"
        "  rides theme vehicle set --name \"Shuttle\" --train 1 --body dark_blue",
        { CommandArgSpec{ "id", "Ride identifier (numeric).", false, "ID" },
          CommandArgSpec{ "name", "Ride name (case-insensitive).", false, "NAME" },
          CommandArgSpec{ "train", "Vehicle/train index (default 0). Meaning depends on color mode.", false, "INT" },
          CommandArgSpec{ "body", "Primary body color (e.g., 'bright_purple').", false, "COLOR" },
          CommandArgSpec{ "trim", "Trim/accent color.", false, "COLOR" },
          CommandArgSpec{ "tertiary", "Third color for supported vehicles.", false, "COLOR" } },
        [](const ParsedArgs& args) {
            json params = json::object();
            cli::ApplyRideSelector(params, args);

            bool hasColor = false;
            if (auto train = cli::GetIntOption(args, { "train" }))
            {
                params["train"] = *train;
            }
            if (auto body = cli::GetStringOption(args, { "body" }))
            {
                params["body"] = *body;
                hasColor = true;
            }
            if (auto trim = cli::GetStringOption(args, { "trim" }))
            {
                params["trim"] = *trim;
                hasColor = true;
            }
            if (auto tertiary = cli::GetStringOption(args, { "tertiary" }))
            {
                params["tertiary"] = *tertiary;
                hasColor = true;
            }

            if (!hasColor)
            {
                throw std::runtime_error(
                    "Invalid: Provide at least one color flag (--body, --trim, or --tertiary)");
            }

            return CommandPlan{ "rides.theme.vehicle.set", params };
        },
        renderers::RenderRideThemeChange });

    specs.push_back(CommandSpec{
        "rides",
        { "theme", "vehicle", "mode" },
        "Set vehicle color mode (same/per-train/per-car).",
        "Controls how vehicle colors are applied across the ride's trains and cars:\n"
        "  same: All vehicles use identical colors (--train 0 only)\n"
        "  per-train: Each train can have different colors\n"
        "  per-car: Each car position can have different colors\n\n"
        "Changing mode resets colors to the first vehicle's scheme. Set mode first, then "
        "use 'rides theme vehicle set' to color individual trains/cars.\n\n"
        "Examples:\n"
        "  rides theme vehicle mode --id 1 --mode per-train\n"
        "  rides theme vehicle mode --name \"Corkscrew\" --mode same",
        { CommandArgSpec{ "id", "Ride identifier (numeric).", false, "ID" },
          CommandArgSpec{ "name", "Ride name (case-insensitive).", false, "NAME" },
          CommandArgSpec{ "mode", "Color mode: same, per-train, or per-car. Required.", true, "MODE" } },
        [](const ParsedArgs& args) {
            json params = json::object();
            cli::ApplyRideSelector(params, args);
            std::string mode = cli::RequireStringOption(args, { "mode" }, "mode (same, per-train, or per-car)");

            // Validate mode value
            if (mode != "same" && mode != "per-train" && mode != "per-car")
            {
                throw std::runtime_error(
                    "Invalid: --mode must be 'same', 'per-train', or 'per-car'");
            }
            params["mode"] = mode;
            return CommandPlan{ "rides.theme.vehicle.mode", params };
        },
        renderers::RenderRideThemeChange });

    specs.push_back(CommandSpec{
        "rides",
        { "theme", "entrance", "set" },
        "Set ride entrance/exit station style.",
        "Changes the visual style of the ride's entrance and exit buildings. Only affects rides "
        "that have entrance/exit structures (coasters, tracked rides).\n\n"
        "Run 'rides theme entrance list' to see available styles in the current scenario. "
        "Use the style name (e.g., 'Wooden') or identifier (e.g., 'rct2.station.wooden').\n\n"
        "Examples:\n"
        "  rides theme entrance set --id 1 --style plain\n"
        "  rides theme entrance set --name \"Log Flume\" --style wooden\n"
        "  rides theme entrance set --id 3 --style rct2.station.canvas",
        { CommandArgSpec{ "id", "Ride identifier (numeric).", false, "ID" },
          CommandArgSpec{ "name", "Ride name (case-insensitive).", false, "NAME" },
          CommandArgSpec{ "style", "Station style: name or identifier. Required. See 'rides theme entrance list'.", true, "STYLE" } },
        [](const ParsedArgs& args) {
            json params = json::object();
            cli::ApplyRideSelector(params, args);
            params["style"] = cli::RequireStringOption(args, { "style" }, "style (run 'rides theme entrance list' to see options)");
            return CommandPlan{ "rides.theme.entrance.set", params };
        },
        renderers::RenderRideThemeChange });
}

} // namespace rctctl::commands
