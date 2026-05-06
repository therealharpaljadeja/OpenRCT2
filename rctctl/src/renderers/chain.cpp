#include "rctctl/renderers/chain.hpp"

#include "rctctl/renderers/text.hpp"

#include <array>
#include <cstddef>
#include <iostream>
#include <sstream>
#include <string>

namespace rctctl::renderers {
namespace {
using json = nlohmann::json;

// Format a wei-string (arbitrary-precision integer in decimal) as a fixed-point token
// quantity with `decimals` precision. PARK and MON are both 18-decimal, so no per-unit
// switch needed. The amount can exceed uint64, hence string-only arithmetic — we never
// parse to a numeric type.
std::string FormatTokenWei(const std::string& weiStr, std::size_t precision = 3)
{
    if (weiStr.empty() || weiStr == "0")
        return "0";
    constexpr std::size_t kDecimals = 18;
    // Pad so the decimal point can always be inserted at position `len - kDecimals`.
    std::string padded = weiStr;
    if (padded.size() <= kDecimals)
        padded.insert(0, kDecimals + 1 - padded.size(), '0');
    auto dot = padded.size() - kDecimals;
    std::string whole = padded.substr(0, dot);
    std::string frac = padded.substr(dot, precision);
    while (whole.size() > 1 && whole.front() == '0')
        whole.erase(whole.begin());
    if (frac.empty())
        return whole;
    return whole + "." + frac;
}

std::string FormatPark(const std::string& weiStr) { return FormatTokenWei(weiStr) + " PARK"; }
std::string FormatMon(const std::string& weiStr) { return FormatTokenWei(weiStr) + " MON"; }

const char* KindToHeading(int kind)
{
    switch (kind)
    {
        case 0: return "Park entrance";
        case 1: return "Ride";
        case 2: return "Shop";
        case 3: return "Stall";
        case 4: return "Facility";
        case 5: return "ATM";
        default: return "Unknown";
    }
}

} // namespace

void RenderChainStatus(const json& result)
{
    TextCanvas canvas(std::cout);
    canvas.Section("Chain");
    bool enabled = result.value("enabled", false);
    canvas.KeyValue("Enabled", enabled);
    if (!enabled)
    {
        canvas.Paragraph(
            "Chain integration is disabled. Build with -DOPENRCT2_CHAIN=ON and launch with --chain to enable.");
    }
}

void RenderParkEarnings(const json& result)
{
    TextCanvas canvas(std::cout);
    canvas.Section("Park earnings");
    if (!result.value("enabled", false))
    {
        canvas.Paragraph("Chain integration is disabled or the venue mirror is offline.");
        return;
    }
    canvas.KeyValue("Total revenue", FormatPark(result.value("totalRevenueWei", "0")));
    canvas.KeyValue("Treasury", FormatPark(result.value("treasuryWei", "0")));
    canvas.KeyValue("Deployer MON", FormatMon(result.value("deployerWei", "0")));
    canvas.KeyValue("Faucet MON", FormatMon(result.value("faucetWei", "0")));
    canvas.KeyValue("Venue count", static_cast<int>(result.value("venueCount", 0)));

    canvas.Section("By category");
    const auto& byKindWei = result.value("byKindWei", json::object());
    const auto& byKindCount = result.value("byKindCount", json::object());
    static constexpr std::array<std::pair<const char*, const char*>, 6> kCategories = { {
        { "parkEntrance", "Park entrance" },
        { "ride", "Ride fares" },
        { "stall", "Stall sales" },
        { "shop", "Shop sales" },
        { "facility", "Facility" },
        { "atm", "ATM" },
    } };
    for (const auto& [key, label] : kCategories)
    {
        std::string wei = byKindWei.value(key, "0");
        int count = byKindCount.value(key, 0);
        std::ostringstream line;
        line << FormatPark(wei) << " (" << count << " venues)";
        canvas.KeyValue(label, line.str());
    }

    auto venues = result.value("byVenue", json::array());
    auto totalVenues = result.value("byVenueTotal", venues.size());
    canvas.Section(venues.size() == totalVenues ? "Venues" : "Top venues");
    if (venues.empty())
    {
        canvas.Paragraph("No venues registered yet.");
    }
    else
    {
        for (const auto& v : venues)
        {
            std::ostringstream line;
            line << FormatPark(v.value("balanceWei", "0"))
                 << "  (" << KindToHeading(v.value("kind", -1)) << ")";
            canvas.KeyValue(v.value("name", "(unnamed)"), line.str());
        }
        if (venues.size() < totalVenues)
        {
            std::ostringstream more;
            more << "... " << (totalVenues - venues.size())
                 << " more venues — use --all for the full list";
            canvas.Paragraph(more.str());
        }
    }

    if (result.contains("activity") && !result.at("activity").is_null())
    {
        const auto& a = result.at("activity");
        canvas.Section("Activity");
        canvas.KeyValue("Accepted", static_cast<int>(a.value("accepted", 0)));
        canvas.KeyValue("Signed", static_cast<int>(a.value("signed", 0)));
        canvas.KeyValue("Dropped", static_cast<int>(a.value("dropped", 0)));
    }

    canvas.Section("Pipeline");
    bool healthy = result["pipeline"].value("healthy", false);
    canvas.KeyValue("Healthy", healthy);
    for (const auto& alert : result["pipeline"].value("alerts", json::array()))
    {
        canvas.Bullet(alert.get<std::string>());
    }
}

} // namespace rctctl::renderers
