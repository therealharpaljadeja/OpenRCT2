#pragma once

#include <nlohmann/json.hpp>

namespace rctctl::renderers {

void RenderChainStatus(const nlohmann::json& result);

} // namespace rctctl::renderers
