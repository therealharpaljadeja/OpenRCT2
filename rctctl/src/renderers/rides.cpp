#include "rctctl/renderers/rides.hpp"

#include "rctctl/renderers/text.hpp"
#include "rctctl/util/format.hpp"
#include "rctctl/util/string_utils.hpp"

#include <algorithm>
#include <iomanip>
#include <iostream>
#include <sstream>
#include <string>

namespace rctctl::renderers {
namespace {
using json = nlohmann::json;

const json& ExtractRidePayload(const json& payload)
{
    if (payload.is_object())
    {
        auto it = payload.find("ride");
        if (it != payload.end())
        {
            return *it;
        }
    }
    return payload;
}

std::string RideTypeLabel(const json& ride)
{
    auto typeName = ride.value("typeName", std::string());
    if (!typeName.empty())
    {
        return typeName;
    }
    if (ride.contains("type") && ride["type"].is_number_integer())
    {
        return "type#" + std::to_string(ride["type"].get<int>());
    }
    return "ride";
}

std::string BuildRideLabel(const json& ride)
{
    std::ostringstream rideLabel;
    rideLabel << "#" << ride.value("id", -1) << " " << ride.value("name", std::string("(unnamed ride)"));
    return rideLabel.str();
}

std::string DescribeReason(const json& reason)
{
    if (!reason.is_object())
    {
        return "unknown";
    }
    auto label = reason.value("label", std::string());
    if (label.empty())
    {
        label = reason.value("key", std::string("none"));
    }
    return label;
}

std::string FormatPercent(double value)
{
    std::ostringstream oss;
    oss << std::fixed << std::setprecision(1) << value << "%";
    return oss.str();
}

std::string JoinGuestSamples(const json& samples)
{
    if (!samples.is_array() || samples.empty())
    {
        return "-";
    }
    std::ostringstream oss;
    bool first = true;
    for (const auto& sample : samples)
    {
        if (!first)
        {
            oss << ", ";
        }
        first = false;
        oss << sample.value("name", std::string("Guest")) << " (id:" << sample.value("id", -1) << ")";
    }
    return oss.str();
}

std::string FormatCurrencyOrDash(const json& node, const char* key)
{
    auto it = node.find(key);
    if (it == node.end() || !it->is_number())
    {
        return "-";
    }
    return util::FormatCurrency(it->get<double>());
}

std::string FormatTileLabel(const json& node)
{
    std::ostringstream oss;
    oss << "(" << node.value("x", 0) << ", " << node.value("y", 0) << ")";
    return oss.str();
}

std::string FormatTileList(const json& tiles, size_t limit = 12)
{
    if (!tiles.is_array() || tiles.empty())
    {
        return "-";
    }

    std::ostringstream oss;
    for (size_t i = 0; i < tiles.size() && i < limit; ++i)
    {
        if (i != 0)
        {
            oss << ", ";
        }
        oss << FormatTileLabel(tiles[i]);
    }
    if (tiles.size() > limit)
    {
        oss << ", +" << (tiles.size() - limit) << " more";
    }
    return oss.str();
}

std::string FormatStationEndpoint(const json& endpoint)
{
    if (!endpoint.is_object())
    {
        return "-";
    }
    std::ostringstream oss;
    oss << '(' << endpoint.value("x", 0) << ", " << endpoint.value("y", 0) << ", z"
        << endpoint.value("z", 0) << ')';
    auto facing = endpoint.value("facing", std::string());
    if (!facing.empty())
    {
        oss << " facing " << facing;
    }

    // Show path connectivity status
    if (endpoint.contains("pathAccess") && endpoint["pathAccess"].is_object())
    {
        const auto& pathAccess = endpoint["pathAccess"];
        bool connected = pathAccess.value("connected", false);
        if (connected)
        {
            auto pathType = pathAccess.value("pathType", std::string("path"));
            oss << " [" << pathType << " connected]";
        }
        else
        {
            oss << " [NO PATH]";
        }
    }
    return oss.str();
}

std::string StationLabel(const json& station)
{
    int index = station.value("stationIndex", -1);
    if (index >= 0)
    {
        return "Station " + std::to_string(index);
    }
    return "Station";
}

} // namespace

void RenderRideList(const json& result)
{
    TextCanvas canvas(std::cout);
    canvas.Section("Rides");
    if (!result.is_array() || result.empty())
    {
        canvas.Paragraph("No rides available.");
        return;
    }

    TableView table;
    table.headers = { "ID", "Status", "Type", "Name" };
    for (const auto& ride : result)
    {
        auto id = ride.value("id", -1);
        auto status = ride.value("status", std::string("unknown"));
        auto typeName = RideTypeLabel(ride);
        auto name = ride.value("name", std::string("(unnamed ride)"));
        if (ride.value("isClosed", false))
        {
            name += " (closed)";
        }
        table.rows.push_back({ std::to_string(id), status, typeName, name });
    }
    canvas.Table(table);
}

static std::string BuildRideSelectorLabel(const json& entry)
{
    std::vector<std::string> selectors;
    auto name = entry.value("name", std::string());
    if (!name.empty())
    {
        selectors.push_back("--name \"" + name + "\"");
    }

    auto entryIndex = entry.value("entryIndex", -1);
    if (entryIndex >= 0)
    {
        selectors.push_back("--entry-index " + std::to_string(entryIndex));
    }

    auto identifier = entry.value("identifier", std::string());
    if (!identifier.empty())
    {
        selectors.push_back("--type " + identifier);
    }

    if (selectors.empty())
    {
        return std::string("-");
    }

    std::ostringstream oss;
    for (size_t i = 0; i < selectors.size(); ++i)
    {
        if (i != 0)
        {
            oss << " or ";
        }
        oss << selectors[i];
    }
    return oss.str();
}

void RenderRideAvailability(const json& result)
{
    TextCanvas canvas(std::cout);
    const auto& rides = result.value("rides", json::array());
    canvas.Section("Ride Blueprints");
    canvas.KeyValue("Entries", static_cast<int>(rides.size()));
    if (rides.empty())
    {
        canvas.Paragraph("No ride objects meet the current filter.");
        return;
    }

    TableView table;
    table.headers = { "Name", "Category", "Status", "Cost", "Use with" };
    for (const auto& ride : rides)
    {
        std::string name = ride.value("name", std::string("(unknown)"));
        std::string category = ride.value("category", std::string("ride"));
        std::string status = ride.value("invented", false) ? "available" : "locked";

        std::string costLabel = "-";
        if (ride.contains("priceEstimate") && ride["priceEstimate"].is_number())
        {
            costLabel = util::FormatCurrency(ride.value("priceEstimate", 0.0));
        }
        else
        {
            const auto& costs = ride.value("buildCost", json::object());
            if (!costs.empty())
            {
                std::ostringstream cost;
                double trackCost = costs.value("track", 0.0);
                double supportCost = costs.value("supports", 0.0);
                cost << util::FormatCurrency(trackCost);
                if (supportCost > 0.0)
                {
                    cost << "/" << util::FormatCurrency(supportCost);
                }
                auto multiplier = costs.value("estimateMultiplier", 0);
                if (multiplier > 0)
                {
                    cost << " x" << multiplier;
                }
                costLabel = cost.str();
            }
        }

        table.rows.push_back({ name, category, status, costLabel, BuildRideSelectorLabel(ride) });
    }

    canvas.Table(table);
}

void RenderRideStatus(const json& result)
{
    const auto& ride = ExtractRidePayload(result);
    TextCanvas canvas(std::cout);
    canvas.Section("Ride");
    canvas.KeyValue("ID", ride.value("id", -1));
    canvas.KeyValue("Name", ride.value("name", std::string("(unnamed ride)")));
    canvas.KeyValue("Type", RideTypeLabel(ride));
    canvas.KeyValue("Status", ride.value("status", std::string("")));
    canvas.KeyValue("Mode", ride.value("mode", std::string("")));

    const auto& vehicles = ride.value("vehicles", json::object());
    if (!vehicles.empty())
    {
        canvas.Section("Vehicles");
        canvas.KeyValue("Trains", vehicles.value("trains", 0));
        canvas.KeyValue("Cars/train", vehicles.value("carsPerTrain", 0));
        canvas.KeyValue("Seats/car", vehicles.value("seatsPerCar", 0));
    }

    const auto& ratings = ride.value("ratings", json::object());
    if (!ratings.empty())
    {
        canvas.Section("Ratings");
        canvas.KeyValue("Excitement", ratings.value("excitement", 0.0));
        canvas.KeyValue("Intensity", ratings.value("intensity", 0.0));
        canvas.KeyValue("Nausea", ratings.value("nausea", 0.0));
    }

    canvas.Section("Queue");
    canvas.KeyValue("Length", ride.value("queueLength", 0));
    canvas.KeyValue("Wait", std::to_string(ride.value("queueTime", 0)) + " min");

    const auto& stations = ride.value("stations", json::array());
    if (!stations.empty())
    {
        canvas.Section("Access");
        for (const auto& station : stations)
        {
            auto label = StationLabel(station);
            if (station.contains("entrance"))
            {
                canvas.KeyValue(label + " entrance", FormatStationEndpoint(station["entrance"]));
            }
            if (station.contains("exit"))
            {
                canvas.KeyValue(label + " exit", FormatStationEndpoint(station["exit"]));
            }
        }
    }

    if (ride.contains("origin") && ride["origin"].is_object())
    {
        const auto& origin = ride["origin"];
        std::ostringstream originLabel;
        originLabel << '(' << origin.value("x", 0) << ", " << origin.value("y", 0) << ')';
        canvas.KeyValue("Origin", originLabel.str());
    }

    if (ride.contains("reliabilityPercent"))
    {
        canvas.Section("Maintenance");
        canvas.KeyValue("Reliability", std::to_string(ride.value("reliabilityPercent", 0)) + "%");
        canvas.KeyValue("Downtime", std::to_string(ride.value("downtimePercent", 0)) + "%");
        if (ride.contains("inspectionIntervalLabel"))
        {
            canvas.KeyValue("Inspection interval", ride.value("inspectionIntervalLabel", std::string("")));
        }
        if (ride.contains("minutesUntilInspection"))
        {
            canvas.KeyValue("Next inspection",
                std::to_string(ride.value("minutesUntilInspection", 0)) + " min");
        }
        canvas.KeyValue("Due inspection", ride.value("dueInspection", false));
        canvas.KeyValue("Broken", ride.value("isBrokenDown", false));
    }

    canvas.Section("Guests");
    canvas.KeyValue("Currently riding", ride.value("guestsOnRide", 0));
    canvas.KeyValue("Lifetime riders", ride.value("totalCustomers", 0));
    canvas.KeyValue("Favourites", ride.value("favouriteGuests", 0));

    if (ride.contains("profitThisMonth") || ride.contains("incomePerHour") || ride.contains("price"))
    {
        canvas.Section("Finance");
        canvas.KeyValue("Price", util::FormatCurrency(ride.value("price", 0.0)));
        if (ride.value("numPrices", 1) > 1 && ride.contains("secondaryPrice"))
        {
            canvas.KeyValue("Secondary price", util::FormatCurrency(ride.value("secondaryPrice", 0.0)));
        }
        double profit = ride.contains("profitPerHour") ? ride.value("profitPerHour", 0.0) : ride.value("profitThisMonth", 0.0);
        canvas.KeyValue("Profit/hr", util::FormatCurrency(profit));
        canvas.KeyValue("Income/hr", util::FormatCurrency(ride.value("incomePerHour", 0.0)));
        canvas.KeyValue("Running cost/hr", util::FormatCurrency(ride.value("runningCost", 0.0)));
    }
}

void RenderRideFinancials(const json& result)
{
    TextCanvas canvas(std::cout);
    canvas.Section("Ride Finances");

    // Handler returns { "rides": [...], "count": N }
    json rides;
    if (result.is_object() && result.contains("rides"))
    {
        rides = result["rides"];
    }
    else if (result.is_array())
    {
        rides = result;
    }

    if (!rides.is_array() || rides.empty())
    {
        canvas.Paragraph("No rides available.");
        return;
    }

    TableView table;
    table.headers = { "Ride", "Status", "Income/hr", "Cost/hr", "Profit/hr" };
    for (const auto& ride : rides)
    {
        auto label = BuildRideLabel(ride);
        if (ride.value("isClosed", false))
        {
            label += " (closed)";
        }

        auto status = util::ToUpper(ride.value("status", std::string("unknown")));
        // Handler uses "income" and "runningCost" field names
        auto income = FormatCurrencyOrDash(ride, "income");
        auto runningCost = FormatCurrencyOrDash(ride, "runningCost");
        std::string profit = "-";
        if (ride.contains("profit"))
        {
            profit = util::FormatCurrency(ride.value("profit", 0.0));
        }

        table.rows.push_back({ label, status, income, runningCost, profit });
    }

    canvas.Table(table);
}

void RenderRidePerception(const json& result)
{
    TextCanvas canvas(std::cout);
    canvas.Section("Ride Perception");

    // Handler returns { "rides": [...], "count": N }
    json rides;
    if (result.is_object() && result.contains("rides"))
    {
        rides = result["rides"];
    }
    else if (result.is_array())
    {
        rides = result;
    }

    if (!rides.is_array() || rides.empty())
    {
        canvas.Paragraph("No rides available.");
        return;
    }

    TableView table;
    table.headers = { "Ride", "Pop%", "Sat%", "Fav", "Exc", "Int", "Nau" };
    for (const auto& ride : rides)
    {
        auto label = BuildRideLabel(ride);

        auto popularity = std::to_string(ride.value("popularity", 0)) + "%";
        auto satisfaction = std::to_string(ride.value("satisfaction", 0)) + "%";
        auto favorites = std::to_string(ride.value("guestsFavourite", 0));

        std::string excitement = "-";
        std::string intensity = "-";
        std::string nausea = "-";
        if (!ride["excitement"].is_null())
        {
            std::ostringstream ss;
            ss << std::fixed << std::setprecision(2) << ride.value("excitement", 0.0);
            excitement = ss.str();
        }
        if (!ride["intensity"].is_null())
        {
            std::ostringstream ss;
            ss << std::fixed << std::setprecision(2) << ride.value("intensity", 0.0);
            intensity = ss.str();
        }
        if (!ride["nausea"].is_null())
        {
            std::ostringstream ss;
            ss << std::fixed << std::setprecision(2) << ride.value("nausea", 0.0);
            nausea = ss.str();
        }

        table.rows.push_back({ label, popularity, satisfaction, favorites, excitement, intensity, nausea });
    }

    canvas.Table(table);
}

void RenderRideOperations(const json& result)
{
    TextCanvas canvas(std::cout);
    canvas.Section("Ride Operations");

    // Handler returns { "rides": [...], "count": N }
    json rides;
    if (result.is_object() && result.contains("rides"))
    {
        rides = result["rides"];
    }
    else if (result.is_array())
    {
        rides = result;
    }

    if (!rides.is_array() || rides.empty())
    {
        canvas.Paragraph("No rides available.");
        return;
    }

    TableView table;
    table.headers = { "Ride", "Rel%", "Down%", "QTime", "QLen", "Cust/hr" };
    for (const auto& ride : rides)
    {
        auto label = BuildRideLabel(ride);

        auto reliability = std::to_string(ride.value("reliability", 0)) + "%";
        auto downtime = std::to_string(ride.value("downtime", 0)) + "%";
        auto queueTime = std::to_string(ride.value("queueTime", 0)) + "m";
        auto queueLength = std::to_string(ride.value("queueLength", 0));
        auto customersPerHour = std::to_string(ride.value("customersPerHour", 0));

        table.rows.push_back({ label, reliability, downtime, queueTime, queueLength, customersPerHour });
    }

    canvas.Table(table);
}

void RenderRidePrice(const json& result, bool announceChange)
{
    const auto& ride = ExtractRidePayload(result);
    auto id = ride.value("id", -1);
    auto name = ride.value("name", std::string("(unnamed ride)"));
    double price = result.value("price", ride.value("price", 0.0));

    TextCanvas canvas(std::cout);
    canvas.Section("Ride Pricing");
    std::ostringstream rideLabel;
    rideLabel << "#" << id << " " << name;
    canvas.KeyValue("Ride", rideLabel.str());
    canvas.KeyValue(announceChange ? "Updated price" : "Price", util::FormatCurrency(price));

    if (result.contains("secondaryPrice") || ride.contains("secondaryPrice"))
    {
        double secondary = result.value("secondaryPrice", ride.value("secondaryPrice", 0.0));
        canvas.KeyValue("Secondary price", util::FormatCurrency(secondary));
    }
    if (result.contains("previousPrice"))
    {
        canvas.KeyValue("Previous", util::FormatCurrency(result.value("previousPrice", 0.0)));
    }
}

void RenderRideStatusChange(const json& result)
{
    const auto& ride = ExtractRidePayload(result);
    auto id = ride.value("id", -1);
    auto name = ride.value("name", std::string("(unnamed ride)"));
    auto newStatus = result.value("status", ride.value("status", std::string("unknown")));
    auto previous = result.value("previousStatus", std::string());

    TextCanvas canvas(std::cout);
    canvas.Section("Ride Status");
    std::ostringstream rideLabel;
    rideLabel << "#" << id << " " << name;
    canvas.KeyValue("Ride", rideLabel.str());
    std::string state = util::ToUpper(newStatus);
    if (!previous.empty())
    {
        state += " (was " + util::ToUpper(previous) + ')';
    }
    canvas.KeyValue("State", state);
}

void RenderRideRename(const json& result)
{
    const auto& ride = ExtractRidePayload(result);
    TextCanvas canvas(std::cout);
    canvas.Section("Ride Rename");
    canvas.KeyValue("ID", ride.value("id", -1));
    canvas.KeyValue("Previous", result.value("previousName", std::string("")));
    // Server sets result["name"] with the new name (ride payload may be stale)
    auto newName = result.value("name", std::string());
    if (newName.empty())
    {
        newName = ride.value("name", std::string(""));
    }
    canvas.KeyValue("Current", newName);
}

void RenderRideConfigure(const json& result)
{
    const auto& ride = ExtractRidePayload(result);
    TextCanvas canvas(std::cout);
    canvas.Section("Ride Tuning");
    std::ostringstream rideLabel;
    rideLabel << "#" << ride.value("id", -1) << " " << ride.value("name", std::string(""));
    canvas.KeyValue("Ride", rideLabel.str());

    const auto& applied = result.value("applied", json::object());
    if (applied.empty())
    {
        canvas.Paragraph("No settings changed.");
        return;
    }

    canvas.Section("Applied Settings");
    for (const auto& [key, value] : applied.items())
    {
        std::string rendered;
        if (value.is_string())
        {
            rendered = value.get<std::string>();
        }
        else if (value.is_boolean())
        {
            rendered = value.get<bool>() ? "true" : "false";
        }
        else if (value.is_number_float())
        {
            rendered = std::to_string(value.get<double>());
        }
        else if (value.is_number_integer())
        {
            rendered = std::to_string(value.get<int64_t>());
        }
        else
        {
            rendered = value.dump();
        }
        canvas.KeyValue(key, rendered);
    }
}

void RenderRidePlacement(const json& result)
{
    const auto& ride = ExtractRidePayload(result);
    const auto& object = result.value("object", json::object());
    const auto& tile = result.value("tile", json::object());
    const auto& footprint = result.value("footprint", json::object());
    const auto& costs = result.value("costBreakdown", json::object());

    TextCanvas canvas(std::cout);
    canvas.Section("Ride Placement");
    canvas.KeyValue("Ride", BuildRideLabel(ride));

    std::string blueprintLabel = object.value("name", std::string());
    if (blueprintLabel.empty())
    {
        blueprintLabel = object.value("identifier", std::string("(object)"));
    }
    else
    {
        blueprintLabel += " (" + object.value("identifier", std::string()) + ')';
    }
    canvas.KeyValue("Blueprint", blueprintLabel);

    std::ostringstream anchor;
    anchor << "(" << tile.value("x", 0) << ", " << tile.value("y", 0) << ") z=" << tile.value("z", 0);
    if (tile.contains("meaning"))
    {
        anchor << " — " << tile.value("meaning", std::string());
    }
    canvas.KeyValue("Anchor", anchor.str());
    canvas.KeyValue("Facing", result.value("direction", std::string("south")));

    canvas.KeyValue("Total cost", util::FormatCurrency(result.value("cost", 0.0)));
    canvas.KeyValue("Create cost", util::FormatCurrency(costs.value("create", 0.0)));
    canvas.KeyValue("Build cost", util::FormatCurrency(costs.value("build", 0.0)));

    if (!footprint.empty())
    {
        json bounds = footprint.value("bounds", json::object());
        std::ostringstream footprintSummary;
        footprintSummary << footprint.value("tileCount", 0) << " tiles";
        if (bounds.contains("width") && bounds.contains("height"))
        {
            footprintSummary << " (" << bounds.value("width", 0) << " x " << bounds.value("height", 0) << ")";
        }
        canvas.KeyValue("Footprint", footprintSummary.str());
        canvas.KeyValue("Tiles", FormatTileList(footprint.value("tiles", json::array())));

        const auto& candidates = footprint.value("entranceCandidates", json::array());
        if (!candidates.empty())
        {
            TableView table;
            table.headers = { "Tile", "Facing", "Owned" };
            const size_t limit = std::min<size_t>(candidates.size(), 8);
            for (size_t i = 0; i < limit; ++i)
            {
                const auto& candidate = candidates[i];
                table.rows.push_back(
                    { FormatTileLabel(candidate), candidate.value("direction", std::string()),
                        candidate.value("owned", false) ? "yes" : "no" });
            }
            canvas.Section("Entrance candidates");
            canvas.Table(table);
            if (candidates.size() > limit)
            {
                std::ostringstream note;
                note << "… " << (candidates.size() - limit) << " more candidate tiles available with --json.";
                canvas.Paragraph(note.str());
            }
        }
        canvas.Paragraph("Next: use rides entrance place / rides exit place with one of the candidate tiles to finish the build.");
    }
    else
    {
        canvas.Paragraph("Footprint data unavailable; inspect the ride via map tile for placement details.");
    }
}

void RenderRideEntrancePlacement(const json& result)
{
    const bool isExit = result.value("entranceType", std::string("entrance")) == "exit";
    const auto& ride = ExtractRidePayload(result);
    const auto& tile = result.value("tile", json::object());
    const auto& adjacent = result.value("adjacentRideTile", json::object());

    TextCanvas canvas(std::cout);
    canvas.Section(isExit ? "Ride Exit Placement" : "Ride Entrance Placement");
    canvas.KeyValue("Ride", BuildRideLabel(ride));
    canvas.KeyValue("Station", result.value("stationIndex", 0));

    std::ostringstream location;
    location << "(" << tile.value("x", 0) << ", " << tile.value("y", 0) << ") z=" << tile.value("z", 0);
    std::string facing = tile.value("direction", std::string());
    if (!facing.empty())
    {
        location << " facing " << facing;
        if (tile.value("directionInferred", false))
        {
            location << " (auto)";
        }
    }
    canvas.KeyValue("Location", location.str());

    if (!adjacent.empty())
    {
        canvas.KeyValue("Touching ride tile", FormatTileLabel(adjacent));
    }

    canvas.KeyValue("Cost", util::FormatCurrency(result.value("cost", 0.0)));
    canvas.Paragraph("Connect a path or queue to the indicated face to complete guest access.");
}

void RenderRideDemolish(const json& result)
{
    const auto& ride = ExtractRidePayload(result);
    TextCanvas canvas(std::cout);
    canvas.Section("Ride Action");
    canvas.KeyValue("ID", ride.value("id", -1));
    canvas.KeyValue("Name", ride.value("name", std::string("(unnamed ride)")));
    canvas.KeyValue("Type", RideTypeLabel(ride));
    canvas.KeyValue("Action", util::ToUpper(result.value("status", std::string("unknown"))));

    auto cost = result.value("cost", 0.0);
    canvas.KeyValue("Cash delta", util::FormatCurrency(cost));

    if (result.contains("position") && result["position"].contains("tile"))
    {
        const auto& tile = result["position"]["tile"];
        std::ostringstream oss;
        oss << tile.value("x", 0) << ", " << tile.value("y", 0);
        canvas.KeyValue("Reference tile", oss.str());
    }
}

void RenderRideBreakdowns(const json& result)
{
    const auto& ride = ExtractRidePayload(result);
    TextCanvas canvas(std::cout);
    canvas.Section("Ride Breakdown");
    canvas.KeyValue("Ride", BuildRideLabel(ride));
    canvas.KeyValue("Status", result.value("isBrokenDown", false) ? "BROKEN" : "Operational");
    canvas.KeyValue("Current", DescribeReason(result.value("currentReason", json::object())));
    canvas.KeyValue("Pending", DescribeReason(result.value("pendingReason", json::object())));

    const auto& mechanic = result.value("mechanic", json::object());
    std::ostringstream mech;
    mech << mechanic.value("key", std::string("idle"));
    if (mechanic.value("mechanicAssigned", false))
    {
        mech << " via " << mechanic.value("mechanicName", std::string("mechanic"))
             << " (#" << mechanic.value("mechanicId", -1) << ")";
    }
    canvas.KeyValue("Mechanic", mech.str());

    canvas.Section("Maintenance");
    canvas.KeyValue("Reliability", std::to_string(result.value("reliabilityPercent", 0)) + "%");
    canvas.KeyValue("Downtime", std::to_string(result.value("downtimePercent", 0)) + "%");
    canvas.KeyValue("Minutes since inspection", result.value("minutesSinceInspection", 0));
    canvas.KeyValue("Minutes until inspection", result.value("minutesUntilInspection", 0));

    const auto& history = result.value("downtimeHistory", json::array());
    if (!history.empty())
    {
        TableView table;
        table.headers = { "Window", "% Broken", "Ticks" };
        for (const auto& bucket : history)
        {
            std::ostringstream window;
            window << std::fixed << std::setprecision(1)
                   << bucket.value("windowStartMinutesAgo", 0.0) << "m ago";
            auto percent = FormatPercent(bucket.value("percentIntervalBroken", 0.0));
            table.rows.push_back({ window.str(), percent, std::to_string(bucket.value("ticksBroken", 0)) });
        }
        canvas.Section("Recent Downtime");
        canvas.Table(table);

        std::ostringstream note;
        note << "Each bucket covers ~" << std::fixed << std::setprecision(1)
             << result.value("downtimeBucketMinutes", 0.0) << " in-game minutes.";
        canvas.Paragraph(note.str());
    }
}

void RenderRideThroughput(const json& result)
{
    const auto& ride = ExtractRidePayload(result);
    TextCanvas canvas(std::cout);
    canvas.Section("Ride Throughput");
    canvas.KeyValue("Ride", BuildRideLabel(ride));
    canvas.KeyValue("Customers/hour", result.value("customersPerHour", 0));
    canvas.KeyValue("Last 5 min", result.value("customersLast5Minutes", 0));
    canvas.KeyValue("Current interval", result.value("currentIntervalCustomers", 0));
    canvas.KeyValue("Queue length", ride.value("queueLength", 0));
    canvas.KeyValue("Queue time", std::to_string(result.value("queueTimeMinutes", 0)) + " min");
    canvas.KeyValue("Riders on ride", result.value("numRiders", 0));

    auto pop = result.find("popularityPercent");
    canvas.KeyValue("Popularity", pop != result.end() ? std::to_string(pop->get<int>()) + "%" : "unknown");
    auto sat = result.find("satisfactionPercent");
    canvas.KeyValue("Satisfaction", sat != result.end() ? std::to_string(sat->get<int>()) + "%" : "unknown");

    canvas.KeyValue("Lifetime riders", result.value("totalCustomers", 0));
    canvas.KeyValue("Favourite guests", result.value("guestsFavourite", 0));

    const auto& itemsSold = result.value("itemsSold", json::array());
    if (!itemsSold.empty())
    {
        canvas.Section("Items Sold");
        for (const auto& item : itemsSold)
        {
            std::ostringstream line;
            line << item.value("slot", std::string("item")) << ": "
                 << item.value("item", std::string("item")) << " ("
                 << item.value("sold", 0) << ")";
            canvas.Bullet(line.str());
        }
    }

    const auto& history = result.value("customerHistory", json::array());
    if (!history.empty())
    {
        TableView table;
        table.headers = { "Interval", "Guests" };
        for (const auto& sample : history)
        {
            table.rows.push_back({ std::to_string(sample.value("index", 0)),
                std::to_string(sample.value("customers", 0)) });
        }
        canvas.Section("Customer History");
        canvas.Table(table);
        canvas.Paragraph("Intervals update roughly every 30 seconds of game time.");
    }
}

void RenderRideFeedback(const json& result)
{
    const auto& ride = ExtractRidePayload(result);
    const auto& groups = result.value("groups", json::array());

    TextCanvas canvas(std::cout);
    canvas.Section("Ride Feedback");
    canvas.KeyValue("Ride", BuildRideLabel(ride));
    canvas.KeyValue("Groups", static_cast<int>(groups.size()));
    canvas.KeyValue("Guests matched", result.value("totalMatches", 0));

    if (groups.empty())
    {
        canvas.Paragraph("No guests are currently sharing ride-specific thoughts.");
        return;
    }

    TableView table;
    table.headers = { "Thought", "Guests", "Sample" };
    for (const auto& group : groups)
    {
        table.rows.push_back({ group.value("text", std::string()), std::to_string(group.value("count", 0)),
            JoinGuestSamples(group.value("guestSamples", json::array())) });
    }
    canvas.Table(table);
}

// ─────────────────────────────────────────────────────────────────────────────
// Pre-built Coaster Renderers
// ─────────────────────────────────────────────────────────────────────────────

void RenderRideCoastersCategories(const json& result)
{
    TextCanvas canvas(std::cout);

    auto totalDesigns = result.value("totalDesigns", 0);
    canvas.Section("Pre-built Coaster Categories");
    canvas.Paragraph(std::to_string(totalDesigns) + " coaster design(s) available.");
    canvas.BlankLine();

    const auto& categories = result.value("categories", json::array());
    if (categories.empty())
    {
        canvas.Paragraph("No coaster designs found. Ensure RCT2 data files are installed.");
        return;
    }

    TableView table;
    table.headers = { "ID", "Category", "Ride Types", "Designs" };
    for (const auto& cat : categories)
    {
        table.rows.push_back({
            cat.value("id", std::string()),
            cat.value("name", std::string()),
            std::to_string(cat.value("typeCount", 0)),
            std::to_string(cat.value("designCount", 0))
        });
    }
    canvas.Table(table);

    canvas.BlankLine();
    canvas.Paragraph("Use 'rides coasters types --category <id>' to filter by category.");
}

void RenderRideCoastersTypes(const json& result)
{
    TextCanvas canvas(std::cout);

    canvas.Section("Ride Types with Pre-built Coasters");

    if (result.contains("filteredCategory"))
    {
        canvas.Paragraph("Filtered by category: " + result.value("filteredCategory", std::string()));
        canvas.BlankLine();
    }

    const auto& types = result.value("types", json::array());
    if (types.empty())
    {
        canvas.Paragraph("No ride types with coaster designs found.");
        return;
    }

    TableView table;
    table.headers = { "Identifier", "Name", "Category", "Designs", "Status" };
    for (const auto& type : types)
    {
        std::string status = type.value("invented", false) ? "Available" : "Not Invented";
        table.rows.push_back({
            type.value("identifier", std::string()),
            type.value("name", std::string()),
            type.value("categoryName", std::string()),
            std::to_string(type.value("designCount", 0)),
            status
        });
    }
    canvas.Table(table);

    canvas.BlankLine();
    canvas.Paragraph("Use 'rides coasters list --type <identifier>' to list designs for a type.");
}

void RenderRideCoastersList(const json& result)
{
    TextCanvas canvas(std::cout);

    canvas.Section("Pre-built Coasters");

    if (result.contains("filteredType"))
    {
        canvas.Paragraph("Filtered by type: " + result.value("filteredType", std::string()));
        canvas.BlankLine();
    }

    auto totalCount = result.value("totalCount", 0);
    canvas.Paragraph(std::to_string(totalCount) + " design(s) found.");
    canvas.BlankLine();

    const auto& designs = result.value("designs", json::array());
    if (designs.empty())
    {
        canvas.Paragraph("No coaster designs found for the specified criteria.");
        return;
    }

    TableView table;
    table.headers = { "Name", "Ride Type", "Ratings (E/I/N)", "Size", "Status" };
    for (const auto& design : designs)
    {
        std::string ratings = "-";
        std::string size = "-";

        if (design.contains("statistics"))
        {
            const auto& stats = design["statistics"];
            std::ostringstream ratingsStr;
            ratingsStr << std::fixed << std::setprecision(2)
                       << stats.value("excitement", 0.0) << "/"
                       << stats.value("intensity", 0.0) << "/"
                       << stats.value("nausea", 0.0);
            ratings = ratingsStr.str();

            if (stats.contains("spaceRequired"))
            {
                const auto& space = stats["spaceRequired"];
                size = std::to_string(space.value("x", 0)) + "x" + std::to_string(space.value("y", 0));
            }
        }

        std::string status = design.value("invented", false) ? "Available" : "Not Invented";

        table.rows.push_back({
            design.value("name", std::string()),
            design.value("rideTypeName", std::string()),
            ratings,
            size,
            status
        });
    }
    canvas.Table(table);
}

void RenderRideCoastersPreview(const json& result)
{
    TextCanvas canvas(std::cout);

    canvas.Section("Coaster Placement Preview");

    // Design info
    if (result.contains("design"))
    {
        const auto& design = result["design"];
        canvas.KeyValue("Design", design.value("name", std::string()));
        canvas.KeyValue("Ride Type", design.value("rideTypeName", std::string()));
    }

    canvas.BlankLine();

    // Placement info
    if (result.contains("placement"))
    {
        const auto& placement = result["placement"];
        bool canPlace = placement.value("canPlace", false);

        std::ostringstream coordStr;
        coordStr << placement.value("x", 0) << ", " << placement.value("y", 0);
        int zVal = placement.value("z", 0);
        bool zAuto = placement.value("zAutoDetected", false);
        coordStr << ", z=" << zVal;
        if (zAuto)
        {
            coordStr << " (auto-detected from surface)";
        }
        canvas.KeyValue("Location", coordStr.str());

        // Extract direction - handle potential type mismatches defensively
        int dir = 0;
        if (placement.contains("direction"))
        {
            const auto& dirVal = placement["direction"];
            if (dirVal.is_number())
            {
                dir = dirVal.get<int>();
            }
            else if (dirVal.is_boolean())
            {
                dir = dirVal.get<bool>() ? 1 : 0;
            }
        }
        // Per TileElementBase.h TILE_ELEMENT_DIRECTION_*: 0=west, 1=north, 2=east, 3=south
        const char* dirNames[] = { "West", "North", "East", "South" };
        canvas.KeyValue("Direction", dirNames[dir & 3]);

        std::ostringstream costStr;
        costStr << "$" << std::fixed << std::setprecision(2) << placement.value("cost", 0.0);
        canvas.KeyValue("Cost", costStr.str());

        canvas.BlankLine();

        if (canPlace)
        {
            canvas.Paragraph("Status: CAN PLACE - Use 'rides coasters place' to build.");
        }
        else
        {
            canvas.Paragraph("Status: CANNOT PLACE");
            if (placement.contains("errorMessage"))
            {
                canvas.KeyValue("Error", placement.value("errorMessage", std::string()));
            }
            if (placement.contains("heightHint"))
            {
                canvas.BlankLine();
                canvas.Paragraph(placement.value("heightHint", std::string()));
            }
        }
    }
}

void RenderRideCoastersPlace(const json& result)
{
    TextCanvas canvas(std::cout);

    canvas.Section("Coaster Placed");

    // Ride info
    if (result.contains("ride"))
    {
        const auto& ride = result["ride"];
        canvas.KeyValue("Ride ID", ride.value("id", 0));
        canvas.KeyValue("Name", ride.value("name", std::string()));
        canvas.KeyValue("Type", ride.value("type", std::string()));
    }

    // Cost
    std::ostringstream costStr;
    costStr << "$" << std::fixed << std::setprecision(2) << result.value("cost", 0.0);
    canvas.KeyValue("Cost", costStr.str());

    // Position
    if (result.contains("position"))
    {
        const auto& pos = result["position"];
        std::ostringstream coordStr;
        coordStr << pos.value("x", 0) << ", " << pos.value("y", 0);
        canvas.KeyValue("Location", coordStr.str());

        // Extract direction - handle potential type mismatches defensively
        int dir = 0;
        if (pos.contains("direction"))
        {
            const auto& dirVal = pos["direction"];
            if (dirVal.is_number())
            {
                dir = dirVal.get<int>();
            }
            else if (dirVal.is_boolean())
            {
                dir = dirVal.get<bool>() ? 1 : 0;
            }
        }
        // Per TileElementBase.h TILE_ELEMENT_DIRECTION_*: 0=west, 1=north, 2=east, 3=south
        const char* dirNames[] = { "West", "North", "East", "South" };
        canvas.KeyValue("Direction", dirNames[dir & 3]);
    }

    canvas.BlankLine();

    // Show note if present (e.g., when ride lookup had issues)
    if (result.contains("note"))
    {
        canvas.Paragraph("Note: " + result.value("note", std::string()));
    }
    else
    {
        canvas.Paragraph("Coaster placed successfully. Use 'rides status' to view details.");
    }
}

// ========== Theme Renderers ==========

namespace {
std::string FormatColorDisplay(const json& color)
{
    // Colors are now just strings (the name)
    if (color.is_string())
        return color.get<std::string>();
    return "-";
}
} // namespace

void RenderRideTheme(const json& result)
{
    TextCanvas canvas(std::cout);
    canvas.Section("Ride Theming");

    const auto& ride = ExtractRidePayload(result);
    canvas.KeyValue("Ride", BuildRideLabel(ride));
    canvas.KeyValue("Type", RideTypeLabel(ride));
    canvas.BlankLine();

    // Track Colors
    canvas.Section("Track Colors");
    if (result.contains("trackColours") && result["trackColours"].is_array())
    {
        for (const auto& scheme : result["trackColours"])
        {
            int schemeIdx = scheme.value("scheme", 0);
            std::ostringstream row;
            row << "Main: " << FormatColorDisplay(scheme.value("main", json()))
                << ", Additional: " << FormatColorDisplay(scheme.value("additional", json()))
                << ", Supports: " << FormatColorDisplay(scheme.value("supports", json()));
            canvas.KeyValue("Scheme " + std::to_string(schemeIdx), row.str());
        }
    }
    canvas.BlankLine();

    // Vehicle Colors
    canvas.Section("Vehicle Colors");
    if (result.contains("vehicleColourSettings") && result["vehicleColourSettings"].is_object())
    {
        auto mode = result["vehicleColourSettings"].value("mode", std::string("same"));
        canvas.KeyValue("Mode", mode);
    }
    if (result.contains("vehicleColours") && result["vehicleColours"].is_array())
    {
        for (const auto& vehicle : result["vehicleColours"])
        {
            int vehIdx = vehicle.value("index", 0);
            std::ostringstream row;
            row << "Body: " << FormatColorDisplay(vehicle.value("body", json()))
                << ", Trim: " << FormatColorDisplay(vehicle.value("trim", json()))
                << ", Tertiary: " << FormatColorDisplay(vehicle.value("tertiary", json()));
            canvas.KeyValue("Vehicle " + std::to_string(vehIdx), row.str());
        }
    }
    canvas.BlankLine();

    // Entrance Style
    canvas.Section("Entrance Style");
    if (result.contains("entranceStyle") && result["entranceStyle"].is_object())
    {
        const auto& style = result["entranceStyle"];
        canvas.KeyValue("Style", style.value("name", std::string("Unknown")));
        canvas.KeyValue("Identifier", style.value("identifier", std::string("-")));
    }
}

void RenderRideThemeChange(const json& result)
{
    TextCanvas canvas(std::cout);
    canvas.Section("Ride Theme Update");

    const auto& ride = ExtractRidePayload(result);
    canvas.KeyValue("Ride", BuildRideLabel(ride));

    // Show what was changed
    if (result.contains("applied") && result["applied"].is_object())
    {
        canvas.BlankLine();
        canvas.Section("Applied Changes");
        for (const auto& [key, value] : result["applied"].items())
        {
            canvas.KeyValue(key, FormatColorDisplay(value));
        }
    }

    // Show previous values
    if (result.contains("previous") && result["previous"].is_object())
    {
        canvas.BlankLine();
        canvas.Section("Previous Values");
        for (const auto& [key, value] : result["previous"].items())
        {
            canvas.KeyValue(key, FormatColorDisplay(value));
        }
    }

    // Special handling for mode change
    if (result.contains("mode"))
    {
        canvas.BlankLine();
        canvas.KeyValue("New Mode", result.value("mode", std::string("-")));
        canvas.KeyValue("Previous Mode", result.value("previousMode", std::string("-")));
    }

    // Special handling for entrance style
    if (result.contains("entranceStyle") && result["entranceStyle"].is_object())
    {
        canvas.BlankLine();
        const auto& newStyle = result["entranceStyle"];
        canvas.KeyValue("New Style", newStyle.value("name", std::string("-")));
        if (result.contains("previousStyle") && result["previousStyle"].is_object())
        {
            const auto& prevStyle = result["previousStyle"];
            canvas.KeyValue("Previous Style", prevStyle.value("name", std::string("-")));
        }
    }

    // Show scheme index if present
    if (result.contains("scheme"))
    {
        canvas.BlankLine();
        canvas.KeyValue("Scheme", std::to_string(result.value("scheme", 0)));
    }

    // Show train index if present
    if (result.contains("train"))
    {
        canvas.BlankLine();
        canvas.KeyValue("Train", std::to_string(result.value("train", 0)));
    }
}

void RenderEntranceStyleList(const json& result)
{
    TextCanvas canvas(std::cout);
    canvas.Section("Entrance Styles");

    if (!result.contains("styles") || !result["styles"].is_array())
    {
        canvas.Paragraph("No entrance styles available.");
        return;
    }

    const auto& styles = result["styles"];
    if (styles.empty())
    {
        canvas.Paragraph("No entrance styles loaded.");
        return;
    }

    // Build table
    TableView table;
    table.headers = { "Name", "Identifier" };

    for (const auto& style : styles)
    {
        table.rows.push_back({
            style.value("name", std::string("-")),
            style.value("identifier", std::string("-"))
        });
    }

    canvas.Table(table);
    canvas.BlankLine();
    canvas.Paragraph("Use style names or identifiers with 'rides theme entrance set --style <name>'.");
}

void RenderColorList(const json& result)
{
    TextCanvas canvas(std::cout);
    canvas.Section("Available Colors");

    if (!result.contains("colors") || !result["colors"].is_array())
    {
        canvas.Paragraph("No colors available.");
        return;
    }

    const auto& colors = result["colors"];

    // Build table
    TableView table;
    table.headers = { "Name", "Category" };

    for (const auto& color : colors)
    {
        table.rows.push_back({
            color.value("name", std::string("-")),
            color.value("category", std::string("-"))
        });
    }

    canvas.Table(table);
    canvas.BlankLine();
    canvas.Paragraph("Use color names with theme commands (e.g., --main bright_red).");
}

} // namespace rctctl::renderers
