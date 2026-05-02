/*****************************************************************************
 * Copyright (c) 2014-2025 OpenRCT2 developers
 *
 * For a complete list of all authors, please refer to contributors.md
 * Interested in contributing? Visit https://github.com/OpenRCT2/OpenRCT2
 *
 * OpenRCT2 is licensed under the GNU General Public License version 3.
 *****************************************************************************/

#pragma once

#ifdef ENABLE_SCRIPTING

namespace OpenRCT2::Scripting::Rpc::Handlers
{
    // Handler initialization functions - called to force linking of handler files
    void InitWeatherHandlers();
    void InitNewsHandlers();
    void InitFinanceHandlers();
    void InitWindowHandlers();
    void InitAgentHandlers();
    void InitResearchHandlers();
    void InitParkHandlers();
    void InitGuestHandlers();
    void InitShopHandlers();
    void InitMapHandlers();
    void InitStaffHandlers();
    void InitRideHandlers();
    void InitChainHandlers();

} // namespace OpenRCT2::Scripting::Rpc::Handlers

#endif // ENABLE_SCRIPTING
