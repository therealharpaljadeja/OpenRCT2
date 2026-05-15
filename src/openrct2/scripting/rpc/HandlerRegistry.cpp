/*****************************************************************************
 * Copyright (c) 2014-2025 OpenRCT2 developers
 *
 * For a complete list of all authors, please refer to contributors.md
 * Interested in contributing? Visit https://github.com/OpenRCT2/OpenRCT2
 *
 * OpenRCT2 is licensed under the GNU General Public License version 3.
 *****************************************************************************/

#ifdef ENABLE_SCRIPTING

#include "HandlerRegistry.h"
#include "handlers/HandlerInit.h"

namespace OpenRCT2::Scripting::Rpc
{
    HandlerRegistry& HandlerRegistry::Instance()
    {
        static HandlerRegistry instance;
        return instance;
    }

    void HandlerRegistry::InitializeAllHandlers()
    {
        // Force linking of all handler object files
        Handlers::InitWeatherHandlers();
        Handlers::InitNewsHandlers();
        Handlers::InitFinanceHandlers();
        Handlers::InitWindowHandlers();
        Handlers::InitAgentHandlers();
        Handlers::InitResearchHandlers();
        Handlers::InitParkHandlers();
        Handlers::InitGuestHandlers();
        Handlers::InitShopHandlers();
        Handlers::InitMapHandlers();
        Handlers::InitStaffHandlers();
        Handlers::InitRideHandlers();
        Handlers::InitChainHandlers();
    }

    void HandlerRegistry::Register(std::string_view method, RpcHandler handler)
    {
        _handlers[std::string(method)] = std::move(handler);
    }

    bool HandlerRegistry::HasHandler(std::string_view method) const
    {
        return _handlers.find(std::string(method)) != _handlers.end();
    }

    RpcResult HandlerRegistry::Dispatch(std::string_view method, const json_t& params) const
    {
        auto it = _handlers.find(std::string(method));
        if (it == _handlers.end())
        {
            return RpcResult::Error(-32601, "Method not found: " + std::string(method));
        }
        return it->second(params);
    }

} // namespace OpenRCT2::Scripting::Rpc

#endif // ENABLE_SCRIPTING
