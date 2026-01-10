#include "rctctl/renderers/weather_news.hpp"

#include "rctctl/renderers/text.hpp"
#include "rctctl/util/string_utils.hpp"

#include <iostream>
#include <sstream>

namespace rctctl::renderers {
namespace {
using json = nlohmann::json;
}

void RenderWeatherStatus(const json& result)
{
    const auto& current = result.contains("current") ? result["current"] : result.value("next", json::object());
    TextCanvas canvas(std::cout);
    canvas.Section("Weather");
    canvas.KeyValue("Type", current.value("type", std::string("")));
    canvas.KeyValue("Effect", current.value("effect", std::string("")));
    canvas.KeyValue("Level", current.value("level", std::string("")));
    canvas.KeyValue("Temp (C)", current.value("temperatureC", 0));
    canvas.KeyValue("Temp (F)", current.value("temperatureF", current.value("temperatureC", 0)));
    auto season = current.value("season", std::string(""));
    if (!season.empty())
    {
        canvas.KeyValue("Season", season);
    }
}

void RenderNewsList(const json& result)
{
    const auto& items = result.value("items", json::array());
    TextCanvas canvas(std::cout);
    canvas.Section("News");
    TableView table;
    table.headers = { "Type", "Text", "Date" };
    for (const auto& item : items)
    {
        auto text = item.value("text", std::string(""));
        if (text.empty())
        {
            continue;
        }
        std::ostringstream date;
        date << item.value("monthName", std::string("")) << " day " << item.value("day", 0) << ", year "
             << item.value("year", 0);
        table.rows.push_back({ item.value("type", std::string("")), text, date.str() });
    }
    if (table.rows.empty())
    {
        canvas.Paragraph("No news items.");
        return;
    }
    canvas.Table(table);
}

void RenderNewsHistory(const json& result)
{
    TextCanvas canvas(std::cout);
    canvas.Section("Message History");

    auto recentCount = result.value("recentCount", 0);
    auto archivedCount = result.value("archivedCount", 0);
    auto totalCount = result.value("totalCount", 0);

    canvas.KeyValue("Recent messages", recentCount);
    canvas.KeyValue("Archived messages", archivedCount);
    canvas.KeyValue("Total messages", totalCount);
    canvas.Paragraph("Opened Recent Messages window.");
}

void RenderAwardsHistory(const json& result)
{
    const auto& history = result.value("history", json::array());
    TextCanvas canvas(std::cout);
    canvas.Section("Award History");

    if (history.empty())
    {
        canvas.Paragraph("No award history recorded yet.");
        return;
    }

    TableView table;
    table.headers = { "Award", "Date" };
    for (const auto& item : history)
    {
        std::ostringstream date;
        date << item.value("monthName", std::string("")) << " day " << item.value("day", 0) << ", year "
             << item.value("year", 0);
        auto awardText = util::StripFormatCodes(item.value("text", std::string("")));
        table.rows.push_back({ awardText, date.str() });
    }
    canvas.Table(table);
}

void RenderAwardsList(const json& result)
{
    const auto& awards = result.value("awards", json::array());
    TextCanvas canvas(std::cout);
    canvas.Section("Active Awards");

    if (awards.empty())
    {
        canvas.Paragraph("No active awards.");
        return;
    }

    int index = 1;
    for (const auto& award : awards)
    {
        auto label = util::StripFormatCodes(award.value("label", std::string()));
        if (label.empty())
        {
            label = award.value("type", std::string("award"));
        }
        bool positive = award.value("isPositive", true);
        auto remaining = award.value("expiresInMonths", 0);
        std::ostringstream line;
        line << index++ << ". " << label << " (" << (positive ? "positive" : "negative")
             << ") — expires in " << remaining << " month(s)";
        canvas.Paragraph(line.str());
    }
}

} // namespace rctctl::renderers
