#include "rctctl/renderers/chain.hpp"

#include "rctctl/renderers/text.hpp"

#include <iostream>

namespace rctctl::renderers {
namespace {
using json = nlohmann::json;
}

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

} // namespace rctctl::renderers
