set(RCTCTL_SOURCES
    "${CMAKE_CURRENT_LIST_DIR}/src/main.cpp"
    "${CMAKE_CURRENT_LIST_DIR}/src/cli/cli.cpp"
    "${CMAKE_CURRENT_LIST_DIR}/src/util/string_utils.cpp"
    "${CMAKE_CURRENT_LIST_DIR}/src/util/format.cpp"
    "${CMAKE_CURRENT_LIST_DIR}/src/rpc/json_rpc_client.cpp"
    "${CMAKE_CURRENT_LIST_DIR}/src/renderers/park.cpp"
    "${CMAKE_CURRENT_LIST_DIR}/src/renderers/rides.cpp"
    "${CMAKE_CURRENT_LIST_DIR}/src/renderers/paths.cpp"
    "${CMAKE_CURRENT_LIST_DIR}/src/renderers/trees.cpp"
    "${CMAKE_CURRENT_LIST_DIR}/src/renderers/scenery.cpp"
    "${CMAKE_CURRENT_LIST_DIR}/src/renderers/walls.cpp"
    "${CMAKE_CURRENT_LIST_DIR}/src/renderers/shops.cpp"
    "${CMAKE_CURRENT_LIST_DIR}/src/renderers/finance.cpp"
    "${CMAKE_CURRENT_LIST_DIR}/src/renderers/map.cpp"
    "${CMAKE_CURRENT_LIST_DIR}/src/renderers/windows.cpp"
    "${CMAKE_CURRENT_LIST_DIR}/src/renderers/guests.cpp"
    "${CMAKE_CURRENT_LIST_DIR}/src/renderers/staff.cpp"
    "${CMAKE_CURRENT_LIST_DIR}/src/renderers/research_marketing.cpp"
    "${CMAKE_CURRENT_LIST_DIR}/src/renderers/weather_news.cpp"
    "${CMAKE_CURRENT_LIST_DIR}/src/renderers/chain.cpp"
    "${CMAKE_CURRENT_LIST_DIR}/src/renderers/text.cpp"
    "${CMAKE_CURRENT_LIST_DIR}/src/renderers/context.cpp"
    "${CMAKE_CURRENT_LIST_DIR}/src/commands/registry.cpp"
    "${CMAKE_CURRENT_LIST_DIR}/src/commands/park_commands.cpp"
    "${CMAKE_CURRENT_LIST_DIR}/src/commands/environment_commands.cpp"
    "${CMAKE_CURRENT_LIST_DIR}/src/commands/shop_commands.cpp"
    "${CMAKE_CURRENT_LIST_DIR}/src/commands/ride_commands.cpp"
    "${CMAKE_CURRENT_LIST_DIR}/src/commands/guest_commands.cpp"
    "${CMAKE_CURRENT_LIST_DIR}/src/commands/staff_commands.cpp"
    "${CMAKE_CURRENT_LIST_DIR}/src/commands/research_marketing_commands.cpp"
    "${CMAKE_CURRENT_LIST_DIR}/src/commands/finance_commands.cpp"
    "${CMAKE_CURRENT_LIST_DIR}/src/commands/news_weather_commands.cpp"
    "${CMAKE_CURRENT_LIST_DIR}/src/commands/window_commands.cpp"
    "${CMAKE_CURRENT_LIST_DIR}/src/commands/bug_commands.cpp"
    "${CMAKE_CURRENT_LIST_DIR}/src/commands/chain_commands.cpp"
)

add_executable(rctctl ${RCTCTL_SOURCES})

set(RCTCTL_JSON_HINTS "")
if (DEFINED MACOS_DYLIBS_DIR)
    list(APPEND RCTCTL_JSON_HINTS "${MACOS_DYLIBS_DIR}/include")
endif()
list(APPEND RCTCTL_JSON_HINTS
    "$ENV{NLOHMANN_JSON_INCLUDE_DIR}"
    "${ROOT_DIR}/lib/macos/include"
    "/usr/include"
    "/usr/local/include"
)
list(REMOVE_DUPLICATES RCTCTL_JSON_HINTS)

find_path(RCTCTL_NLOHMANN_INCLUDE_DIR nlohmann/json.hpp PATHS ${RCTCTL_JSON_HINTS})
if (NOT RCTCTL_NLOHMANN_INCLUDE_DIR)
    message(FATAL_ERROR "Unable to locate nlohmann/json.hpp for rctctl. \
Set NLOHMANN_JSON_INCLUDE_DIR or install the OpenRCT2 dependency bundle.")
endif()

target_include_directories(rctctl PRIVATE
    "${RCTCTL_NLOHMANN_INCLUDE_DIR}"
    "${CMAKE_CURRENT_LIST_DIR}/include"
)

if (WIN32)
    target_link_libraries(rctctl PRIVATE ws2_32)
endif()
