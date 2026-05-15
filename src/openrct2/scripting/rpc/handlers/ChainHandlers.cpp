/*****************************************************************************
 * Copyright (c) 2014-2025 OpenRCT2 developers
 *
 * For a complete list of all authors, please refer to contributors.md
 * Interested in contributing? Visit https://github.com/OpenRCT2/OpenRCT2
 *
 * OpenRCT2 is licensed under the GNU General Public License version 3.
 *****************************************************************************/

#ifdef ENABLE_SCRIPTING

#include "../HandlerRegistry.h"
#include "HandlerInit.h"
#include "../RpcTypes.h"

#include "../../../OpenRCT2.h"

namespace OpenRCT2::Scripting::Rpc::Handlers
{
    using namespace Rpc;

    namespace
    {
        bool IsChainEnabled()
        {
#ifdef OPENRCT2_CHAIN
            return gOpenRCT2ChainEnabled;
#else
            return false;
#endif
        }

        RpcResult HandleChainStatus(const json_t& /*params*/)
        {
            json_t payload = json_t::object();
            payload["enabled"] = IsChainEnabled();
            return RpcResult::Ok(payload);
        }

        struct ChainHandlerRegistrar
        {
            ChainHandlerRegistrar()
            {
                auto& registry = HandlerRegistry::Instance();
                registry.Register("chain.status", HandleChainStatus);
            }
        } chainRegistrar;

    } // namespace

    void InitChainHandlers()
    {
        (void)chainRegistrar;
    }

} // namespace OpenRCT2::Scripting::Rpc::Handlers

#endif // ENABLE_SCRIPTING
