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
#include "../RpcUtils.h"

#include "../../../Context.h"
#include "../../../GameState.h"
#include "../../../actions/ClearAction.h"
#include "../../../actions/SmallSceneryPlaceAction.h"
#include "../../../actions/FootpathPlaceAction.h"
#include "../../../actions/FootpathAdditionPlaceAction.h"
#include "../../../actions/FootpathAdditionRemoveAction.h"
#include "../../../actions/FootpathRemoveAction.h"
#include "../../../actions/GameActionResult.h"
#include "../../../actions/LandLowerAction.h"
#include "../../../actions/LandRaiseAction.h"
#include "../../../actions/WaterLowerAction.h"
#include "../../../actions/WaterRaiseAction.h"
#include "../../../core/Money.hpp"
#include "../../../entity/EntityList.h"
#include "../../../entity/Guest.h"
#include "../../../entity/Staff.h"
#include "../../../interface/WindowBase.h"
#include "../../../localisation/Formatting.h"
#include "../../../localisation/LocalisationService.h"
#include "../../../object/FootpathRailingsObject.h"
#include "../../../object/FootpathSurfaceObject.h"
#include "../../../object/FootpathObject.h"
#include "../../../object/ObjectList.h"
#include "../../../object/ObjectManager.h"
#include "../../../object/ObjectEntryManager.h"
#include "../../../object/PathAdditionEntry.h"
#include "../../../object/PathAdditionObject.h"
#include "../../../object/SmallSceneryEntry.h"
#include "../../../object/SmallSceneryObject.h"
#include "../../../object/LargeSceneryObject.h"
#include "../../../object/LargeSceneryEntry.h"
#include "../../../actions/LargeSceneryPlaceAction.h"
#include "../../../object/TerrainEdgeObject.h"
#include "../../../object/TerrainSurfaceObject.h"
#include "../../../object/WallObject.h"
#include "../../../telemetry/AIAgentActivityFeed.h"
#include "../../../world/tile_element/EntranceElement.h"
#include "../../../world/tile_element/LargeSceneryElement.h"
#include "../../../world/tile_element/WallElement.h"
#include "../../../world/tile_element/BannerElement.h"
#include "../../../world/Footpath.h"
#include "../../../world/Location.hpp"
#include "../../../world/Map.h"
#include "../../../world/MapSelection.h"
#include "../../../world/TileElementsView.h"
#include "../../../world/tile_element/PathElement.h"
#include "../../../world/tile_element/SmallSceneryElement.h"
#include "../../../world/tile_element/SurfaceElement.h"
#include "../../../world/tile_element/TrackElement.h"

#include <algorithm>
#include <functional>
#include <limits>
#include <string>
#include <string_view>
#include <unordered_map>
#include <unordered_set>
#include <utility>
#include <vector>

namespace OpenRCT2::Scripting::Rpc::Handlers
{
    using namespace Rpc;  // For shared types and utilities

    namespace
    {
        // Helper structures
        struct AreaGlyph
        {
            char symbol;
            std::string label;
        };

        struct BoundsAccumulator
        {
            bool hasBounds = false;
            int32_t minX = 0;
            int32_t minY = 0;
            int32_t maxX = 0;
            int32_t maxY = 0;
            uint64_t tiles = 0;
        };

        struct PathSurfaceSelection
        {
            ObjectEntryIndex entryIndex{ kObjectEntryIndexNull };
            std::string identifier;
            bool isLegacy{};
            bool isQueueSurface{};
        };

        struct PathRailingsSelection
        {
            ObjectEntryIndex entryIndex{ kObjectEntryIndexNull };
            std::string identifier;
        };

        struct BlockSummary
        {
            int32_t developmentCount = 0;
            int32_t guestCount = 0;
        };

        // Aliases for user-friendly path item names
        static const std::unordered_map<std::string, std::string> kPathItemAliases = {
            { "bench", "rct2.footpath_item.bench1" },
            { "bin", "rct2.footpath_item.litter1" },
            { "trash", "rct2.footpath_item.litter1" },
            { "trashcan", "rct2.footpath_item.litter1" },
            { "lamp", "rct2.footpath_item.lamp1" },
            { "light", "rct2.footpath_item.lamp1" },
            { "fountain", "rct2.footpath_item.jumpfnt1" },
        };

        // Forward declarations
        TileCoordsXY GetParkBoundsCenter(int32_t gridSize, int32_t zoom);

        // Helper function templates
        template<typename TObject>
        std::string ResolveObjectName(ObjectEntryIndex index)
        {
            if (index == kObjectEntryIndexNull)
            {
                return {};
            }
            auto* context = GetContext();
            if (context == nullptr)
            {
                return {};
            }
            auto& manager = context->GetObjectManager();
            if (auto* object = manager.GetLoadedObject<TObject>(index))
            {
                auto name = object->GetName();
                if (!name.empty())
                {
                    return std::string(name);
                }
            }
            return {};
        }

        std::string_view TileElementTypeToString(TileElementType type)
        {
            switch (type)
            {
                case TileElementType::Surface:
                    return "surface";
                case TileElementType::Path:
                    return "path";
                case TileElementType::Track:
                    return "track";
                case TileElementType::SmallScenery:
                    return "smallScenery";
                case TileElementType::Entrance:
                    return "entrance";
                case TileElementType::Wall:
                    return "wall";
                case TileElementType::LargeScenery:
                    return "largeScenery";
                case TileElementType::Banner:
                    return "banner";
                default:
                    return "unknown";
            }
        }

        std::string_view StaffTypeToString(StaffType type)
        {
            switch (type)
            {
                case StaffType::handyman:
                    return "handyman";
                case StaffType::mechanic:
                    return "mechanic";
                case StaffType::security:
                    return "security";
                case StaffType::entertainer:
                    return "entertainer";
                default:
                    return "staff";
            }
        }

        json_t BuildTileElementPayload(TileElement& element)
        {
            json_t node = json_t::object();
            node["type"] = TileElementTypeToString(element.GetType());
            node["base"] = WorldZToTileZ(element.GetBaseZ());
            node["clearance"] = WorldZToTileZ(element.GetClearanceZ());
            node["direction"] = element.GetDirection();
            node["ghost"] = element.IsGhost();
            node["invisible"] = element.IsInvisible();
            node["owner"] = element.GetOwner();
            node["quadrants"] = element.GetOccupiedQuadrants();
            node["isLast"] = element.IsLastForTile();

            if (auto* surface = element.AsSurface())
            {
                json_t details = json_t::object();
                details["slope"] = surface->GetSlope();
                details["waterHeight"] = WorldZToTileZ(surface->GetWaterHeight());
                details["ownershipMask"] = surface->GetOwnership();
                details["grassLength"] = surface->GetGrassLength();
                details["surfaceObjectIndex"] = surface->GetSurfaceObjectIndex();
                details["surfaceObjectName"] = ResolveObjectName<TerrainSurfaceObject>(surface->GetSurfaceObjectIndex());
                details["edgeObjectIndex"] = surface->GetEdgeObjectIndex();
                details["edgeObjectName"] = ResolveObjectName<TerrainEdgeObject>(surface->GetEdgeObjectIndex());
                details["hasWaterTrack"] = surface->HasTrackThatNeedsWater();
                node["surface"] = details;
            }
            else if (auto* path = element.AsPath())
            {
                json_t details = json_t::object();
                details["isQueue"] = path->IsQueue();
                details["isWide"] = path->IsWide();
                details["isSloped"] = path->IsSloped();
                details["slopeDirection"] = path->GetSlopeDirection();
                details["surfaceIndex"] = path->GetSurfaceEntryIndex();
                details["surfaceName"] = ResolveObjectName<FootpathSurfaceObject>(path->GetSurfaceEntryIndex());
                details["railingsIndex"] = path->GetRailingsEntryIndex();
                details["railingsName"] = ResolveObjectName<FootpathRailingsObject>(path->GetRailingsEntryIndex());
                details["hasAddition"] = path->HasAddition();
                details["additionIndex"] = path->HasAddition() ? path->GetAdditionEntryIndex() : 0;
                details["additionStatus"] = path->GetAdditionStatus();
                details["rideId"] = path->GetRideIndex().IsNull() ? -1 : path->GetRideIndex().ToUnderlying();
                auto stationIndex = path->GetStationIndex();
                details["stationIndex"] = stationIndex.IsNull() ? -1 : stationIndex.ToUnderlying();
                details["edges"] = path->GetEdges();
                details["corners"] = path->GetCorners();
                details["blockedByVehicle"] = path->IsBlockedByVehicle();
                node["path"] = details;
            }
            else if (auto* track = element.AsTrack())
            {
                json_t details = json_t::object();
                details["rideId"] = track->GetRideIndex().IsNull() ? -1 : track->GetRideIndex().ToUnderlying();
                details["sequence"] = track->GetSequenceIndex();
                details["type"] = static_cast<int32_t>(track->GetTrackType());
                details["colourScheme"] = track->GetColourScheme();
                details["rideType"] = track->GetRideType();
                auto stationIndex = track->GetStationIndex();
                details["stationIndex"] = stationIndex.IsNull() ? -1 : stationIndex.ToUnderlying();
                details["hasChainLift"] = track->HasChain();
                details["hasCableLift"] = track->HasCableLift();
                node["track"] = details;
            }
            else if (auto* small = element.AsSmallScenery())
            {
                json_t details = json_t::object();
                details["objectIndex"] = small->GetEntryIndex();
                details["objectName"] = ResolveObjectName<SmallSceneryObject>(small->GetEntryIndex());
                details["quadrant"] = small->GetSceneryQuadrant();
                node["smallScenery"] = details;
            }
            else if (auto* large = element.AsLargeScenery())
            {
                json_t details = json_t::object();
                details["objectIndex"] = large->GetEntryIndex();
                details["objectName"] = ResolveObjectName<LargeSceneryObject>(large->GetEntryIndex());
                details["sequence"] = large->GetSequenceIndex();
                node["largeScenery"] = details;
            }
            else if (auto* entrance = element.AsEntrance())
            {
                json_t details = json_t::object();
                details["type"] = entrance->GetEntranceType();
                details["isParkEntrance"] = entrance->GetEntranceType() == ENTRANCE_TYPE_PARK_ENTRANCE;
                details["rideId"] = entrance->GetRideIndex().IsNull() ? -1 : entrance->GetRideIndex().ToUnderlying();
                auto stationIndex = entrance->GetStationIndex();
                details["stationIndex"] = stationIndex.IsNull() ? -1 : stationIndex.ToUnderlying();
                node["entrance"] = details;
            }
            else if (auto* wall = element.AsWall())
            {
                json_t details = json_t::object();
                details["objectIndex"] = wall->GetEntryIndex();
                details["rotation"] = wall->GetDirection();
                details["primaryColour"] = wall->GetPrimaryColour();
                details["secondaryColour"] = wall->GetSecondaryColour();
                details["tertiaryColour"] = wall->GetTertiaryColour();
                node["wall"] = details;
            }
            else if (auto* banner = element.AsBanner())
            {
                json_t details = json_t::object();
                auto bannerIndex = banner->GetIndex();
                details["bannerId"] = bannerIndex.IsNull() ? -1 : bannerIndex.ToUnderlying();
                node["banner"] = details;
            }

            return node;
        }

        // Aliases for user-friendly path surface names
        static const std::unordered_map<std::string, std::string> kPathSurfaceAliases = {
            { "tarmac", "rct2.footpath_surface.tarmac" },
            { "tarmac_red", "rct2.footpath_surface.tarmac_red" },
            { "tarmac_brown", "rct2.footpath_surface.tarmac_brown" },
            { "tarmac_green", "rct2.footpath_surface.tarmac_green" },
            { "dirt", "rct2.footpath_surface.dirt" },
            { "dirt_red", "rct2.footpath_surface.dirt_red" },
            { "crazy", "rct2.footpath_surface.crazy_paving" },
            { "crazy_paving", "rct2.footpath_surface.crazy_paving" },
            { "ash", "rct2.footpath_surface.ash" },
            { "queue_blue", "rct2.footpath_surface.queue_blue" },
            { "queue_red", "rct2.footpath_surface.queue_red" },
            { "queue_yellow", "rct2.footpath_surface.queue_yellow" },
            { "queue_green", "rct2.footpath_surface.queue_green" },
        };

        // Aliases for user-friendly path railings names
        static const std::unordered_map<std::string, std::string> kPathRailingsAliases = {
            { "wood", "rct2.footpath_railings.wood" },
            { "concrete", "rct2.footpath_railings.concrete" },
            { "space", "rct2.footpath_railings.space" },
            { "bamboo", "rct2.footpath_railings.bamboo_black" },
            { "bamboo_black", "rct2.footpath_railings.bamboo_black" },
            { "bamboo_brown", "rct2.footpath_railings.bamboo_brown" },
        };

        // Helper to convert tile coordinates to world coordinates
        CoordsXY TileToCoords(int32_t tileX, int32_t tileY)
        {
            return CoordsXY{ tileX * kCoordsXYStep, tileY * kCoordsXYStep };
        }

        // Helper to build camera target for tile
        std::optional<CoordsXYZ> BuildTileCameraTarget(const TileCoordsXY& tile, int32_t width = 1, int32_t height = 1)
        {
            auto anchor = tile.ToCoordsXY();
            anchor.x += width * kCoordsXYHalfTile;
            anchor.y += height * kCoordsXYHalfTile;
            auto z = TileElementHeight(anchor);
            return CoordsXYZ{ anchor.x, anchor.y, z };
        }

        // Helper to create generic window hints
        Telemetry::AIAgentFollowHint MakeGenericWindowHint(
            std::string_view method, std::string contextLabel, WindowClass windowClass, std::optional<CoordsXYZ> camera)
        {
            Telemetry::AIAgentFollowHint hint;
            hint.sourceMethod = std::string(method);
            hint.contextLabel = std::move(contextLabel);
            hint.cameraTarget = camera;
            Telemetry::GenericWindowIntent intent;
            intent.windowClass = windowClass;
            hint.windowIntent = intent;
            return hint;
        }

        // Helper to create tile-based hints
        Telemetry::AIAgentFollowHint MakeTileHint(
            std::string_view method, std::string contextLabel, const TileCoordsXY& tile, WindowClass windowClass,
            int32_t width = 1, int32_t height = 1)
        {
            auto camera = BuildTileCameraTarget(tile, width, height);
            return MakeGenericWindowHint(method, std::move(contextLabel), windowClass, camera);
        }

        // Tree helper functions
        std::optional<ObjectEntryIndex> ResolveTreeEntryIndex(std::string_view identifier, std::string& errorMessage)
        {
            auto* context = GetContext();
            if (context == nullptr)
            {
                errorMessage = "Game context is not available";
                return std::nullopt;
            }

            auto& manager = context->GetObjectManager();
            auto entryIndex = manager.GetLoadedObjectEntryIndex(identifier);
            if (entryIndex == kObjectEntryIndexNull)
            {
                auto* object = manager.LoadObject(identifier);
                if (object != nullptr)
                {
                    entryIndex = manager.GetLoadedObjectEntryIndex(object);
                }
            }

            if (entryIndex == kObjectEntryIndexNull)
            {
                errorMessage = "Tree object '" + std::string(identifier) + "' is not loaded";
                return std::nullopt;
            }

            const auto* entry = OpenRCT2::ObjectManager::GetObjectEntry<SmallSceneryEntry>(entryIndex);
            if (entry == nullptr)
            {
                errorMessage = "Identifier '" + std::string(identifier) + "' is not a small scenery object";
                return std::nullopt;
            }
            if (!entry->HasFlag(SMALL_SCENERY_FLAG_IS_TREE))
            {
                errorMessage = "Object '" + std::string(identifier) + "' is not flagged as a tree";
                return std::nullopt;
            }

            return entryIndex;
        }

        json_t BuildTreeDescriptor(ObjectEntryIndex entryIndex, const std::string& identifier)
        {
            json_t tree = json_t::object();
            tree["entryIndex"] = entryIndex;
            if (!identifier.empty())
            {
                tree["identifier"] = identifier;
            }
            return tree;
        }

        json_t BuildTreeCatalogPayload(IContext& context)
        {
            auto& manager = context.GetObjectManager();
            auto maxEntries = static_cast<ObjectEntryIndex>(getObjectEntryGroupCount(ObjectType::smallScenery));
            json_t entries = json_t::array();

            for (ObjectEntryIndex i = 0; i < maxEntries; ++i)
            {
                auto* object = manager.GetLoadedObject<SmallSceneryObject>(i);
                if (object == nullptr)
                {
                    continue;
                }

                const auto* entry = OpenRCT2::ObjectManager::GetObjectEntry<SmallSceneryEntry>(i);
                if (entry == nullptr)
                {
                    continue;
                }

                // Only include trees
                if (!entry->HasFlag(SMALL_SCENERY_FLAG_IS_TREE))
                {
                    continue;
                }

                json_t node = json_t::object();
                node["identifier"] = std::string(object->GetIdentifier());
                node["entryIndex"] = i;

                auto name = object->GetName();
                if (!name.empty())
                {
                    node["name"] = std::string(name);
                }

                node["price"] = MoneyToDouble(entry->price);
                node["removalPrice"] = MoneyToDouble(entry->removal_price);
                node["height"] = entry->height;

                entries.push_back(node);
            }

            json_t payload = json_t::object();
            payload["entries"] = entries;
            payload["count"] = entries.size();
            return payload;
        }

        // Scenery helper functions
        struct ResolvedScenery
        {
            ObjectEntryIndex entryIndex;
            bool isLarge;
        };

        std::optional<ResolvedScenery> ResolveSceneryEntry(std::string_view identifier, std::string& errorMessage)
        {
            auto* context = GetContext();
            if (context == nullptr)
            {
                errorMessage = "Game context is not available";
                return std::nullopt;
            }

            auto& manager = context->GetObjectManager();
            auto entryIndex = manager.GetLoadedObjectEntryIndex(identifier);
            if (entryIndex == kObjectEntryIndexNull)
            {
                auto* object = manager.LoadObject(identifier);
                if (object != nullptr)
                {
                    entryIndex = manager.GetLoadedObjectEntryIndex(object);
                }
            }

            if (entryIndex == kObjectEntryIndexNull)
            {
                errorMessage = "Scenery object '" + std::string(identifier) + "' is not loaded";
                return std::nullopt;
            }

            // Try small scenery first
            if (manager.GetLoadedObject<SmallSceneryObject>(entryIndex) != nullptr)
            {
                const auto* entry = OpenRCT2::ObjectManager::GetObjectEntry<SmallSceneryEntry>(entryIndex);
                if (entry != nullptr)
                {
                    if (entry->HasFlag(SMALL_SCENERY_FLAG_IS_TREE))
                    {
                        errorMessage = "Object '" + std::string(identifier) + "' is a tree (use 'trees' commands instead)";
                        return std::nullopt;
                    }
                    return ResolvedScenery{ entryIndex, false };
                }
            }

            // Then large scenery
            if (manager.GetLoadedObject<LargeSceneryObject>(entryIndex) != nullptr)
            {
                const auto* entry = OpenRCT2::ObjectManager::GetObjectEntry<LargeSceneryEntry>(entryIndex);
                if (entry != nullptr)
                {
                    return ResolvedScenery{ entryIndex, true };
                }
            }

            errorMessage = "Identifier '" + std::string(identifier) + "' is not a placeable scenery object";
            return std::nullopt;
        }

        // Backward-compatible alias for callers that only care about small scenery.
        std::optional<ObjectEntryIndex> ResolveSceneryEntryIndex(std::string_view identifier, std::string& errorMessage)
        {
            auto resolved = ResolveSceneryEntry(identifier, errorMessage);
            if (!resolved)
                return std::nullopt;
            if (resolved->isLarge)
            {
                errorMessage = "Identifier '" + std::string(identifier) + "' is a large scenery object";
                return std::nullopt;
            }
            return resolved->entryIndex;
        }

        json_t BuildSceneryDescriptor(ObjectEntryIndex entryIndex, const std::string& identifier)
        {
            json_t scenery = json_t::object();
            scenery["entryIndex"] = entryIndex;
            if (!identifier.empty())
            {
                scenery["identifier"] = identifier;
            }

            const auto* entry = OpenRCT2::ObjectManager::GetObjectEntry<SmallSceneryEntry>(entryIndex);
            if (entry != nullptr)
            {
                scenery["price"] = MoneyToDouble(entry->price);
                scenery["removalPrice"] = MoneyToDouble(entry->removal_price);
            }
            return scenery;
        }

        json_t BuildSceneryCatalogPayload(IContext& context)
        {
            auto& manager = context.GetObjectManager();
            json_t entries = json_t::array();

            // Small scenery entries (single-tile decorations)
            auto maxSmall = static_cast<ObjectEntryIndex>(getObjectEntryGroupCount(ObjectType::smallScenery));
            for (ObjectEntryIndex i = 0; i < maxSmall; ++i)
            {
                auto* object = manager.GetLoadedObject<SmallSceneryObject>(i);
                if (object == nullptr)
                {
                    continue;
                }

                const auto* entry = OpenRCT2::ObjectManager::GetObjectEntry<SmallSceneryEntry>(i);
                if (entry == nullptr)
                {
                    continue;
                }

                // Skip trees - they have their own commands
                if (entry->HasFlag(SMALL_SCENERY_FLAG_IS_TREE))
                {
                    continue;
                }

                json_t node = json_t::object();
                node["identifier"] = std::string(object->GetIdentifier());
                node["entryIndex"] = i;
                node["type"] = "small";

                auto name = object->GetName();
                if (!name.empty())
                {
                    node["name"] = std::string(name);
                }

                node["price"] = MoneyToDouble(entry->price);
                node["removalPrice"] = MoneyToDouble(entry->removal_price);
                node["height"] = entry->height;

                // Categorize based on flags
                json_t flags = json_t::array();
                if (entry->HasFlag(SMALL_SCENERY_FLAG_FULL_TILE))
                    flags.push_back("fullTile");
                if (entry->HasFlag(SMALL_SCENERY_FLAG_ROTATABLE))
                    flags.push_back("rotatable");
                if (entry->HasFlag(SMALL_SCENERY_FLAG_ANIMATED))
                    flags.push_back("animated");
                if (entry->HasFlag(SMALL_SCENERY_FLAG_CAN_WITHER))
                    flags.push_back("canWither");
                if (entry->HasFlag(SMALL_SCENERY_FLAG_CAN_BE_WATERED))
                    flags.push_back("canBeWatered");
                if (entry->HasFlag(SMALL_SCENERY_FLAG_HAS_GLASS))
                    flags.push_back("hasGlass");
                if (entry->HasFlag(SMALL_SCENERY_FLAG_HAS_PRIMARY_COLOUR))
                    flags.push_back("hasPrimaryColour");
                if (entry->HasFlag(SMALL_SCENERY_FLAG_HAS_SECONDARY_COLOUR))
                    flags.push_back("hasSecondaryColour");
                if (entry->HasFlag(SMALL_SCENERY_FLAG_STACKABLE))
                    flags.push_back("stackable");
                node["flags"] = flags;

                entries.push_back(node);
            }

            // Large scenery entries (multi-tile decorations like signs and statues)
            auto maxLarge = static_cast<ObjectEntryIndex>(getObjectEntryGroupCount(ObjectType::largeScenery));
            for (ObjectEntryIndex i = 0; i < maxLarge; ++i)
            {
                auto* object = manager.GetLoadedObject<LargeSceneryObject>(i);
                if (object == nullptr)
                {
                    continue;
                }

                const auto* entry = OpenRCT2::ObjectManager::GetObjectEntry<LargeSceneryEntry>(i);
                if (entry == nullptr)
                {
                    continue;
                }

                json_t node = json_t::object();
                node["identifier"] = std::string(object->GetIdentifier());
                node["entryIndex"] = i;
                node["type"] = "large";

                auto name = object->GetName();
                if (!name.empty())
                {
                    node["name"] = std::string(name);
                }

                node["price"] = MoneyToDouble(entry->price);
                node["removalPrice"] = MoneyToDouble(entry->removal_price);
                node["tileCount"] = static_cast<int>(entry->tiles.size());

                json_t flags = json_t::array();
                if (entry->HasFlag(LARGE_SCENERY_FLAG_HAS_PRIMARY_COLOUR))
                    flags.push_back("hasPrimaryColour");
                if (entry->HasFlag(LARGE_SCENERY_FLAG_HAS_SECONDARY_COLOUR))
                    flags.push_back("hasSecondaryColour");
                if (entry->HasFlag(LARGE_SCENERY_FLAG_HAS_TERTIARY_COLOUR))
                    flags.push_back("hasTertiaryColour");
                if (entry->HasFlag(LARGE_SCENERY_FLAG_3D_TEXT))
                    flags.push_back("has3dText");
                node["flags"] = flags;

                entries.push_back(node);
            }

            json_t payload = json_t::object();
            payload["entries"] = entries;
            payload["count"] = entries.size();
            return payload;
        }

        // Path item helper functions
        std::string ResolvePathItemAlias(const std::string& input)
        {
            auto lowerInput = input;
            std::transform(lowerInput.begin(), lowerInput.end(), lowerInput.begin(), ::tolower);
            auto it = kPathItemAliases.find(lowerInput);
            if (it != kPathItemAliases.end())
            {
                return it->second;
            }
            return input;
        }

        std::string PathItemCategoryFromFlags(uint16_t flags)
        {
            if (flags & PATH_ADDITION_FLAG_IS_BENCH)
                return "bench";
            if (flags & PATH_ADDITION_FLAG_IS_BIN)
                return "bin";
            if (flags & PATH_ADDITION_FLAG_LAMP)
                return "lamp";
            if (flags & (PATH_ADDITION_FLAG_JUMPING_FOUNTAIN_WATER | PATH_ADDITION_FLAG_JUMPING_FOUNTAIN_SNOW))
                return "fountain";
            if (flags & PATH_ADDITION_FLAG_IS_QUEUE_SCREEN)
                return "queue_screen";
            return "other";
        }

        std::optional<ObjectEntryIndex> ResolvePathItemEntryIndex(std::string_view identifier, std::string& errorMessage)
        {
            auto* context = GetContext();
            if (context == nullptr)
            {
                errorMessage = "Game context is not available";
                return std::nullopt;
            }

            // Try alias first
            auto resolvedId = ResolvePathItemAlias(std::string(identifier));

            auto& manager = context->GetObjectManager();
            auto entryIndex = manager.GetLoadedObjectEntryIndex(resolvedId);
            if (entryIndex == kObjectEntryIndexNull)
            {
                auto* object = manager.LoadObject(resolvedId);
                if (object != nullptr)
                {
                    entryIndex = manager.GetLoadedObjectEntryIndex(object);
                }
            }

            if (entryIndex == kObjectEntryIndexNull)
            {
                errorMessage = "Path item '" + std::string(identifier) + "' is not loaded";
                return std::nullopt;
            }

            const auto* entry = OpenRCT2::ObjectManager::GetObjectEntry<PathAdditionEntry>(entryIndex);
            if (entry == nullptr)
            {
                errorMessage = "Identifier '" + std::string(identifier) + "' is not a path addition";
                return std::nullopt;
            }

            return entryIndex;
        }

        std::string PathItemIdentifierFromEntry(ObjectEntryIndex entryIndex)
        {
            auto* context = GetContext();
            if (context == nullptr)
            {
                return {};
            }

            auto& manager = context->GetObjectManager();
            auto* object = manager.GetLoadedObject(ObjectType::pathAdditions, static_cast<size_t>(entryIndex));
            if (object == nullptr)
            {
                return {};
            }
            return std::string(object->GetIdentifier());
        }

        std::string PathItemNameFromEntry(ObjectEntryIndex entryIndex)
        {
            auto* context = GetContext();
            if (context == nullptr)
            {
                return {};
            }

            auto& manager = context->GetObjectManager();
            auto* object = manager.GetLoadedObject(ObjectType::pathAdditions, static_cast<size_t>(entryIndex));
            if (object == nullptr)
            {
                return {};
            }
            auto name = object->GetName();
            if (!name.empty())
            {
                return std::string(name);
            }
            // Fallback to identifier if no name is available
            return std::string(object->GetIdentifier());
        }

        json_t BuildPathItemDescriptor(ObjectEntryIndex entryIndex, const std::string& identifier)
        {
            json_t item = json_t::object();
            item["entryIndex"] = entryIndex;
            if (!identifier.empty())
            {
                item["identifier"] = identifier;
            }

            // Look up the object to get the display name
            auto* context = GetContext();
            if (context != nullptr)
            {
                auto& manager = context->GetObjectManager();
                auto* object = manager.GetLoadedObject(ObjectType::pathAdditions, static_cast<size_t>(entryIndex));
                if (object != nullptr)
                {
                    auto name = object->GetName();
                    if (!name.empty())
                    {
                        item["name"] = std::string(name);
                    }
                }
            }

            const auto* entry = OpenRCT2::ObjectManager::GetObjectEntry<PathAdditionEntry>(entryIndex);
            if (entry != nullptr)
            {
                item["price"] = MoneyToDouble(entry->price);
                item["category"] = PathItemCategoryFromFlags(entry->flags);
            }
            return item;
        }

        json_t BuildPathItemsCatalogPayload(IContext& context, std::optional<std::string> categoryFilter)
        {
            auto& manager = context.GetObjectManager();
            auto maxEntries = static_cast<ObjectEntryIndex>(getObjectEntryGroupCount(ObjectType::pathAdditions));
            json_t entries = json_t::array();

            for (ObjectEntryIndex i = 0; i < maxEntries; ++i)
            {
                auto* object = manager.GetLoadedObject<PathAdditionObject>(i);
                if (object == nullptr)
                {
                    continue;
                }

                const auto* entry = OpenRCT2::ObjectManager::GetObjectEntry<PathAdditionEntry>(i);
                if (entry == nullptr)
                {
                    continue;
                }

                std::string category = PathItemCategoryFromFlags(entry->flags);

                // Apply category filter if specified
                if (categoryFilter)
                {
                    std::string filter = *categoryFilter;
                    std::transform(filter.begin(), filter.end(), filter.begin(), ::tolower);
                    // Allow plural forms
                    if (filter == "benches")
                        filter = "bench";
                    else if (filter == "bins" || filter == "trash" || filter == "trashcans")
                        filter = "bin";
                    else if (filter == "lamps" || filter == "lights")
                        filter = "lamp";
                    else if (filter == "fountains")
                        filter = "fountain";

                    if (category != filter)
                    {
                        continue;
                    }
                }

                json_t node = json_t::object();
                node["identifier"] = std::string(object->GetIdentifier());
                node["entryIndex"] = i;

                auto name = object->GetName();
                if (!name.empty())
                {
                    node["name"] = std::string(name);
                }

                node["price"] = MoneyToDouble(entry->price);
                node["category"] = category;

                // Include flags for advanced filtering
                json_t flags = json_t::array();
                if (entry->flags & PATH_ADDITION_FLAG_IS_BIN)
                    flags.push_back("isBin");
                if (entry->flags & PATH_ADDITION_FLAG_IS_BENCH)
                    flags.push_back("isBench");
                if (entry->flags & PATH_ADDITION_FLAG_LAMP)
                    flags.push_back("isLamp");
                if (entry->flags & PATH_ADDITION_FLAG_BREAKABLE)
                    flags.push_back("breakable");
                if (entry->flags & PATH_ADDITION_FLAG_JUMPING_FOUNTAIN_WATER)
                    flags.push_back("waterFountain");
                if (entry->flags & PATH_ADDITION_FLAG_JUMPING_FOUNTAIN_SNOW)
                    flags.push_back("snowFountain");
                if (entry->flags & PATH_ADDITION_FLAG_DONT_ALLOW_ON_QUEUE)
                    flags.push_back("noQueue");
                if (entry->flags & PATH_ADDITION_FLAG_DONT_ALLOW_ON_SLOPE)
                    flags.push_back("noSlope");
                if (entry->flags & PATH_ADDITION_FLAG_IS_QUEUE_SCREEN)
                    flags.push_back("queueScreen");
                node["flags"] = flags;

                entries.push_back(node);
            }

            json_t payload = json_t::object();
            payload["entries"] = entries;
            payload["count"] = entries.size();
            if (categoryFilter)
            {
                payload["categoryFilter"] = *categoryFilter;
            }
            return payload;
        }

        // Path surface/railings helper functions
        std::string ResolvePathSurfaceAlias(const std::string& input)
        {
            auto lowerInput = input;
            std::transform(lowerInput.begin(), lowerInput.end(), lowerInput.begin(), ::tolower);
            auto it = kPathSurfaceAliases.find(lowerInput);
            if (it != kPathSurfaceAliases.end())
            {
                return it->second;
            }
            return input;
        }

        std::string ResolvePathRailingsAlias(const std::string& input)
        {
            auto lowerInput = input;
            std::transform(lowerInput.begin(), lowerInput.end(), lowerInput.begin(), ::tolower);
            auto it = kPathRailingsAliases.find(lowerInput);
            if (it != kPathRailingsAliases.end())
            {
                return it->second;
            }
            return input;
        }

        std::string ResolveObjectIdentifier(std::string_view objectIdentifier, const std::string& fallback)
        {
            if (objectIdentifier.empty())
            {
                return fallback;
            }
            return std::string(objectIdentifier);
        }

        std::optional<PathSurfaceSelection> ResolvePathSurfaceSelection(std::string identifier, std::string& errorMessage)
        {
            auto* context = GetContext();
            if (context == nullptr)
            {
                errorMessage = "Game context is not available";
                return std::nullopt;
            }

            // Resolve user-friendly alias to full identifier
            auto resolvedId = ResolvePathSurfaceAlias(identifier);

            auto& manager = context->GetObjectManager();
            auto entryIndex = manager.GetLoadedObjectEntryIndex(resolvedId);
            if (entryIndex == kObjectEntryIndexNull)
            {
                if (auto* object = manager.LoadObject(resolvedId))
                {
                    entryIndex = manager.GetLoadedObjectEntryIndex(object);
                }
            }

            if (entryIndex == kObjectEntryIndexNull)
            {
                errorMessage = "Path surface '" + identifier + "' is not available";
                return std::nullopt;
            }

            if (auto* surface = manager.GetLoadedObject<FootpathSurfaceObject>(entryIndex))
            {
                PathSurfaceSelection selection;
                selection.entryIndex = entryIndex;
                selection.identifier = ResolveObjectIdentifier(surface->GetIdentifier(), identifier);
                selection.isLegacy = false;
                selection.isQueueSurface = (surface->Flags & FOOTPATH_ENTRY_FLAG_IS_QUEUE) != 0;
                return selection;
            }

            if (auto* legacy = manager.GetLoadedObject<FootpathObject>(entryIndex))
            {
                PathSurfaceSelection selection;
                selection.entryIndex = entryIndex;
                selection.identifier = ResolveObjectIdentifier(legacy->GetIdentifier(), identifier);
                selection.isLegacy = true;
                return selection;
            }

            errorMessage = "Identifier '" + identifier + "' is not a path surface";
            return std::nullopt;
        }

        std::optional<PathRailingsSelection> ResolvePathRailingsSelection(std::string identifier, std::string& errorMessage)
        {
            auto* context = GetContext();
            if (context == nullptr)
            {
                errorMessage = "Game context is not available";
                return std::nullopt;
            }

            // Resolve user-friendly alias to full identifier
            auto resolvedId = ResolvePathRailingsAlias(identifier);

            auto& manager = context->GetObjectManager();
            auto entryIndex = manager.GetLoadedObjectEntryIndex(resolvedId);
            if (entryIndex == kObjectEntryIndexNull)
            {
                if (auto* object = manager.LoadObject(resolvedId))
                {
                    entryIndex = manager.GetLoadedObjectEntryIndex(object);
                }
            }

            if (entryIndex == kObjectEntryIndexNull)
            {
                errorMessage = "Railings '" + identifier + "' is not available";
                return std::nullopt;
            }

            if (auto* railings = manager.GetLoadedObject<FootpathRailingsObject>(entryIndex))
            {
                PathRailingsSelection selection;
                selection.entryIndex = entryIndex;
                selection.identifier = ResolveObjectIdentifier(railings->GetIdentifier(), identifier);
                return selection;
            }

            errorMessage = "Identifier '" + identifier + "' is not a railings object";
            return std::nullopt;
        }

        json_t BuildPathSurfaceDescriptor(const PathSurfaceSelection& selection)
        {
            json_t surface = json_t::object();
            surface["entryIndex"] = selection.entryIndex;
            if (!selection.identifier.empty())
            {
                surface["identifier"] = selection.identifier;
            }
            surface["legacy"] = selection.isLegacy;
            return surface;
        }

        json_t BuildRailingsDescriptor(const PathRailingsSelection& selection)
        {
            json_t node = json_t::object();
            node["entryIndex"] = selection.entryIndex;
            if (!selection.identifier.empty())
            {
                node["identifier"] = selection.identifier;
            }
            return node;
        }

        // Helper to parse slope direction from string
        std::optional<Direction> ParseSlopeDirection(const std::string& input)
        {
            auto lower = input;
            std::transform(lower.begin(), lower.end(), lower.begin(), ::tolower);
            // Direction values: 0=SW, 1=NW, 2=NE, 3=SE
            // For user-friendly naming, map cardinal directions to game directions
            if (lower == "south" || lower == "s")
                return Direction{ 0 }; // SW - slopes down to south
            if (lower == "west" || lower == "w")
                return Direction{ 1 }; // NW - slopes down to west
            if (lower == "north" || lower == "n")
                return Direction{ 2 }; // NE - slopes down to north
            if (lower == "east" || lower == "e")
                return Direction{ 3 }; // SE - slopes down to east
            return std::nullopt;
        }

        std::string SlopeDirectionToString(Direction dir)
        {
            switch (dir)
            {
                case 0:
                    return "south";
                case 1:
                    return "west";
                case 2:
                    return "north";
                case 3:
                    return "east";
                default:
                    return "unknown";
            }
        }

        // Map helper functions
        json_t BuildMapTilePayload(const TileCoordsXY& tile)
        {
            json_t payload = json_t::object();
            payload["x"] = tile.x;
            payload["y"] = tile.y;

            auto mapCoords = tile.ToCoordsXY();

            const bool valid = MapIsLocationValid(mapCoords);
            payload["isValid"] = valid;
            if (!valid)
            {
                return payload;
            }

            payload["isEdge"] = MapIsEdge(mapCoords);

            auto* surface = MapGetSurfaceElementAt(tile);
            if (surface != nullptr)
            {
                json_t surfaceJson = json_t::object();
                surfaceJson["baseHeight"] = WorldZToTileZ(surface->GetBaseZ());
                surfaceJson["baseMeters"] = HeightToMeters(surface->GetBaseZ());
                surfaceJson["clearanceHeight"] = WorldZToTileZ(surface->GetClearanceZ());
                surfaceJson["waterHeight"] = WorldZToTileZ(surface->GetWaterHeight());
                surfaceJson["ownershipMask"] = surface->GetOwnership();
                surfaceJson["owned"] = (surface->GetOwnership() & OWNERSHIP_OWNED) != 0;
                surfaceJson["constructionRightsOwned"] =
                    (surface->GetOwnership() & OWNERSHIP_CONSTRUCTION_RIGHTS_OWNED) != 0;
                surfaceJson["constructionRightsForSale"] =
                    (surface->GetOwnership() & OWNERSHIP_CONSTRUCTION_RIGHTS_AVAILABLE) != 0;
                surfaceJson["forSale"] = (surface->GetOwnership() & OWNERSHIP_AVAILABLE) != 0;
                payload["surface"] = surfaceJson;
            }

            json_t elements = json_t::array();
            std::vector<int32_t> rideIds;
            for (auto* element : TileElementsView<TileElement>(tile))
            {
                if (element == nullptr)
                {
                    break;
                }
                if (auto rideId = element->GetRideIndex(); !rideId.IsNull())
                {
                    rideIds.push_back(rideId.ToUnderlying());
                }
                elements.push_back(BuildTileElementPayload(*element));
                if (element->IsLastForTile())
                {
                    break;
                }
            }
            payload["elements"] = elements;
            payload["rideFootprint"] = rideIds;

            json_t guestSamples = json_t::array();
            int32_t guestsOnTile = 0;
            for (auto guest : EntityList<Guest>())
            {
                if (guest == nullptr || guest->OutsideOfPark)
                {
                    continue;
                }
                auto loc = guest->GetLocation();
                if ((loc.x / kCoordsXYStep) == tile.x && (loc.y / kCoordsXYStep) == tile.y)
                {
                    guestsOnTile++;
                    if (guestSamples.size() < 16)
                    {
                        json_t sample = json_t::object();
                        sample["id"] = guest->Id.ToUnderlying();
                        sample["state"] = static_cast<int32_t>(guest->State);
                        sample["happiness"] = guest->Happiness;
                        sample["energy"] = guest->Energy;
                        guestSamples.push_back(sample);
                    }
                }
            }
            json_t guestsJson = json_t::object();
            guestsJson["count"] = guestsOnTile;
            guestsJson["sample"] = guestSamples;
            payload["guests"] = guestsJson;

            json_t patrols = json_t::array();
            for (auto staff : EntityList<Staff>())
            {
                if (staff == nullptr || !staff->HasPatrolArea())
                {
                    continue;
                }
                if (staff->IsLocationInPatrol(mapCoords))
                {
                    json_t entry = json_t::object();
                    entry["id"] = staff->Id.ToUnderlying();
                    entry["type"] = StaffTypeToString(staff->AssignedStaffType);
                    patrols.push_back(entry);
                }
            }
            payload["staffPatrols"] = patrols;

            return payload;
        }

        AreaGlyph DetermineAreaGlyph(const TileCoordsXY& tile)
        {
            auto coords = tile.ToCoordsXY();
            if (!MapIsLocationValid(coords))
            {
                return AreaGlyph{ '?', "Outside map bounds" };
            }

            auto* surface = MapGetSurfaceElementAt(tile);
            bool owned = false;
            bool rightsOnly = false;
            bool hasWater = false;
            if (surface != nullptr)
            {
                auto ownership = surface->GetOwnership();
                owned = (ownership & OWNERSHIP_OWNED) != 0;
                rightsOnly = !owned && ((ownership & OWNERSHIP_CONSTRUCTION_RIGHTS_OWNED) != 0);
                hasWater = surface->GetWaterHeight() > surface->GetBaseZ();
            }

            bool hasRideTrack = false;
            bool hasQueue = false;
            bool hasPath = false;
            bool hasEntrance = false;
            bool hasTree = false;
            bool hasScenery = false;

            for (auto* element : TileElementsView<TileElement>(tile))
            {
                if (element == nullptr)
                {
                    break;
                }
                // Use GetType() for reliable element type detection
                switch (element->GetType())
                {
                    case TileElementType::Track:
                        hasRideTrack = true;
                        break;
                    case TileElementType::Path:
                        if (auto* path = element->AsPath())
                        {
                            if (path->IsQueue())
                            {
                                hasQueue = true;
                            }
                            else
                            {
                                hasPath = true;
                            }
                        }
                        else
                        {
                            hasPath = true; // Fallback if cast fails
                        }
                        break;
                    case TileElementType::Entrance:
                        hasEntrance = true;
                        break;
                    case TileElementType::SmallScenery:
                        if (auto* small = element->AsSmallScenery())
                        {
                            const auto* entry = small->GetEntry();
                            if (entry != nullptr && entry->HasFlag(SMALL_SCENERY_FLAG_IS_TREE))
                            {
                                hasTree = true;
                            }
                            else
                            {
                                hasScenery = true;
                            }
                        }
                        else
                        {
                            hasScenery = true; // Fallback if cast fails
                        }
                        break;
                    case TileElementType::LargeScenery:
                    case TileElementType::Wall:
                    case TileElementType::Banner:
                        hasScenery = true;
                        break;
                    default:
                        break;
                }
            }

            if (hasRideTrack)
            {
                return AreaGlyph{ 'R', "Ride track/support" };
            }
            if (hasQueue)
            {
                return AreaGlyph{ 'Q', "Queue path" };
            }
            if (hasPath)
            {
                return AreaGlyph{ 'P', "Footpath" };
            }
            if (hasEntrance)
            {
                return AreaGlyph{ 'E', "Ride or park entrance" };
            }
            if (hasTree)
            {
                return AreaGlyph{ 'T', "Tree or foliage" };
            }
            if (hasScenery)
            {
                return AreaGlyph{ 'S', "Scenery/building" };
            }
            if (hasWater)
            {
                return AreaGlyph{ 'W', "Water" };
            }
            if (owned)
            {
                return AreaGlyph{ '.', "Owned ground" };
            }
            if (rightsOnly)
            {
                return AreaGlyph{ 'c', "Construction rights only" };
            }
            return AreaGlyph{ '#', "Not owned" };
        }

        AreaGlyph DetermineAreaGlyphPaths(const TileCoordsXY& tile)
        {
            auto coords = tile.ToCoordsXY();
            if (!MapIsLocationValid(coords))
            {
                return AreaGlyph{ '?', "Outside map bounds" };
            }

            bool hasQueue = false;
            bool hasPath = false;

            for (auto* element : TileElementsView<TileElement>(tile))
            {
                if (element == nullptr)
                {
                    break;
                }
                if (auto* path = element->AsPath())
                {
                    if (path->IsQueue())
                    {
                        hasQueue = true;
                    }
                    else
                    {
                        hasPath = true;
                    }
                }
            }

            if (hasQueue)
            {
                return AreaGlyph{ 'Q', "Queue path" };
            }
            if (hasPath)
            {
                return AreaGlyph{ 'P', "Footpath" };
            }
            return AreaGlyph{ '.', "Not a path" };
        }

        AreaGlyph DetermineAreaGlyphRides(const TileCoordsXY& tile)
        {
            auto coords = tile.ToCoordsXY();
            if (!MapIsLocationValid(coords))
            {
                return AreaGlyph{ '?', "Outside map bounds" };
            }

            bool hasRideTrack = false;
            bool hasEntrance = false;

            for (auto* element : TileElementsView<TileElement>(tile))
            {
                if (element == nullptr)
                {
                    break;
                }
                if (element->AsTrack() != nullptr)
                {
                    hasRideTrack = true;
                }
                if (element->AsEntrance() != nullptr)
                {
                    hasEntrance = true;
                }
            }

            if (hasRideTrack)
            {
                return AreaGlyph{ 'R', "Ride track/support" };
            }
            if (hasEntrance)
            {
                return AreaGlyph{ 'E', "Ride or park entrance" };
            }
            return AreaGlyph{ '.', "Not a ride" };
        }

        AreaGlyph DetermineAreaGlyphOwnership(const TileCoordsXY& tile)
        {
            auto coords = tile.ToCoordsXY();
            if (!MapIsLocationValid(coords))
            {
                return AreaGlyph{ '?', "Outside map bounds" };
            }

            auto* surface = MapGetSurfaceElementAt(tile);
            bool owned = false;
            bool rightsOnly = false;
            if (surface != nullptr)
            {
                auto ownership = surface->GetOwnership();
                owned = (ownership & OWNERSHIP_OWNED) != 0;
                rightsOnly = !owned && ((ownership & OWNERSHIP_CONSTRUCTION_RIGHTS_OWNED) != 0);
            }

            if (owned)
            {
                return AreaGlyph{ 'O', "Owned land" };
            }
            if (rightsOnly)
            {
                return AreaGlyph{ 'c', "Construction rights" };
            }
            return AreaGlyph{ '#', "Not owned" };
        }

        AreaGlyph DetermineAreaGlyphScenery(const TileCoordsXY& tile)
        {
            auto coords = tile.ToCoordsXY();
            if (!MapIsLocationValid(coords))
            {
                return AreaGlyph{ '?', "Outside map bounds" };
            }

            bool hasTree = false;
            bool hasScenery = false;

            for (auto* element : TileElementsView<TileElement>(tile))
            {
                if (element == nullptr)
                {
                    break;
                }
                // Use GetType() for reliable element type detection
                switch (element->GetType())
                {
                    case TileElementType::SmallScenery:
                        if (auto* small = element->AsSmallScenery())
                        {
                            const auto* entry = small->GetEntry();
                            if (entry != nullptr && entry->HasFlag(SMALL_SCENERY_FLAG_IS_TREE))
                            {
                                hasTree = true;
                            }
                            else
                            {
                                hasScenery = true;
                            }
                        }
                        else
                        {
                            hasScenery = true; // Fallback if cast fails
                        }
                        break;
                    case TileElementType::LargeScenery:
                    case TileElementType::Wall:
                    case TileElementType::Banner:
                        hasScenery = true;
                        break;
                    default:
                        break;
                }
            }

            if (hasTree)
            {
                return AreaGlyph{ 'T', "Tree or foliage" };
            }
            if (hasScenery)
            {
                return AreaGlyph{ 'S', "Scenery/building" };
            }
            return AreaGlyph{ '.', "No scenery" };
        }

        AreaGlyph DetermineAreaGlyphWater(const TileCoordsXY& tile)
        {
            auto coords = tile.ToCoordsXY();
            if (!MapIsLocationValid(coords))
            {
                return AreaGlyph{ '?', "Outside map bounds" };
            }

            auto* surface = MapGetSurfaceElementAt(tile);
            bool hasWater = false;
            if (surface != nullptr)
            {
                hasWater = surface->GetWaterHeight() > surface->GetBaseZ();
            }

            if (hasWater)
            {
                return AreaGlyph{ 'W', "Water" };
            }
            return AreaGlyph{ '.', "Land" };
        }

        AreaGlyph DetermineAreaGlyphShops(const TileCoordsXY& tile)
        {
            auto coords = tile.ToCoordsXY();
            if (!MapIsLocationValid(coords))
            {
                return AreaGlyph{ '?', "Outside map bounds" };
            }

            for (auto* element : TileElementsView<TileElement>(tile))
            {
                if (element == nullptr)
                {
                    break;
                }
                if (auto* track = element->AsTrack())
                {
                    auto rideIndex = track->GetRideIndex();
                    if (!rideIndex.IsNull())
                    {
                        auto* ride = GetRide(rideIndex);
                        if (ride != nullptr && ride->getClassification() == RideClassification::shopOrStall)
                        {
                            return AreaGlyph{ 'S', "Shop or stall" };
                        }
                    }
                }
            }

            return AreaGlyph{ '.', "Not a shop" };
        }

        json_t BuildMapAreaPayload(const TileCoordsXY& origin, const std::string& filter = "")
        {
            constexpr int32_t kGridSize = 16;
            json_t payload = json_t::object();
            payload["origin"] = json_t::object({ { "x", origin.x }, { "y", origin.y } });
            payload["width"] = kGridSize;
            payload["height"] = kGridSize;

            json_t rows = json_t::array();
            std::unordered_set<char> seenSymbols;
            std::vector<std::pair<char, std::string>> legendEntries;

            // Select glyph function based on filter
            std::function<AreaGlyph(const TileCoordsXY&)> glyphFunc;
            if (filter == "paths")
            {
                glyphFunc = DetermineAreaGlyphPaths;
            }
            else if (filter == "rides")
            {
                glyphFunc = DetermineAreaGlyphRides;
            }
            else if (filter == "ownership")
            {
                glyphFunc = DetermineAreaGlyphOwnership;
            }
            else if (filter == "scenery")
            {
                glyphFunc = DetermineAreaGlyphScenery;
            }
            else if (filter == "water")
            {
                glyphFunc = DetermineAreaGlyphWater;
            }
            else if (filter == "shops")
            {
                glyphFunc = DetermineAreaGlyphShops;
            }
            else
            {
                glyphFunc = DetermineAreaGlyph;
            }

            for (int32_t dy = 0; dy < kGridSize; ++dy)
            {
                std::string row;
                row.reserve(kGridSize);
                for (int32_t dx = 0; dx < kGridSize; ++dx)
                {
                    TileCoordsXY tile{ origin.x + dx, origin.y + dy };
                    auto glyph = glyphFunc(tile);
                    row.push_back(glyph.symbol);
                    if (seenSymbols.insert(glyph.symbol).second)
                    {
                        legendEntries.emplace_back(glyph.symbol, glyph.label);
                    }
                }
                rows.push_back(row);
            }
            payload["rows"] = rows;

            json_t legend = json_t::array();
            for (const auto& entry : legendEntries)
            {
                json_t node = json_t::object();
                node["symbol"] = std::string(1, entry.first);
                node["label"] = entry.second;
                legend.push_back(node);
            }
            payload["legend"] = legend;

            return payload;
        }

        json_t BuildMapStatusPayload()
        {
            const auto& gameState = getGameState();
            json_t payload = json_t::object();
            payload["width"] = gameState.mapSize.x;
            payload["height"] = gameState.mapSize.y;

            uint64_t ownedTiles = 0;
            uint64_t rightsTiles = 0;
            uint64_t waterTiles = 0;
            int32_t maxHeight = 0;
            int32_t minHeight = std::numeric_limits<int32_t>::max();

            for (int32_t y = 0; y < gameState.mapSize.y; ++y)
            {
                for (int32_t x = 0; x < gameState.mapSize.x; ++x)
                {
                    TileCoordsXY tile{ x, y };
                    if (auto* surface = MapGetSurfaceElementAt(tile))
                    {
                        const auto ownership = surface->GetOwnership();
                        if (ownership & OWNERSHIP_OWNED)
                        {
                            ownedTiles++;
                        }
                        if (ownership & OWNERSHIP_CONSTRUCTION_RIGHTS_OWNED)
                        {
                            rightsTiles++;
                        }
                        if (surface->GetWaterHeight() > surface->GetBaseZ())
                        {
                            waterTiles++;
                        }
                        maxHeight = std::max(maxHeight, surface->GetClearanceZ());
                        minHeight = std::min(minHeight, surface->GetBaseZ());
                    }
                }
            }

            payload["ownedTiles"] = ownedTiles;
            payload["constructionRightsTiles"] = rightsTiles;
            payload["waterTiles"] = waterTiles;
            payload["minHeight"] = WorldZToTileZ(minHeight);
            payload["maxHeight"] = WorldZToTileZ(maxHeight);

            return payload;
        }

        void UpdateBounds(BoundsAccumulator& bounds, int32_t x, int32_t y)
        {
            if (!bounds.hasBounds)
            {
                bounds.minX = bounds.maxX = x;
                bounds.minY = bounds.maxY = y;
                bounds.hasBounds = true;
            }
            else
            {
                bounds.minX = std::min(bounds.minX, x);
                bounds.minY = std::min(bounds.minY, y);
                bounds.maxX = std::max(bounds.maxX, x);
                bounds.maxY = std::max(bounds.maxY, y);
            }
            bounds.tiles++;
        }

        json_t BuildBoundsNode(const BoundsAccumulator& bounds)
        {
            if (!bounds.hasBounds)
            {
                return json_t();
            }

            json_t node = json_t::object();
            json_t minNode = json_t::object();
            minNode["x"] = bounds.minX;
            minNode["y"] = bounds.minY;
            json_t maxNode = json_t::object();
            maxNode["x"] = bounds.maxX;
            maxNode["y"] = bounds.maxY;
            node["min"] = minNode;
            node["max"] = maxNode;
            node["width"] = bounds.maxX - bounds.minX + 1;
            node["height"] = bounds.maxY - bounds.minY + 1;
            node["tiles"] = bounds.tiles;
            return node;
        }

        json_t BuildMapOwnershipPayload()
        {
            const auto& gameState = getGameState();
            BoundsAccumulator owned;
            BoundsAccumulator constructionRights;
            BoundsAccumulator landForSale;
            BoundsAccumulator rightsForSale;

            for (int32_t y = 0; y < gameState.mapSize.y; ++y)
            {
                for (int32_t x = 0; x < gameState.mapSize.x; ++x)
                {
                    TileCoordsXY tile{ x, y };
                    auto* surface = MapGetSurfaceElementAt(tile);
                    if (surface == nullptr)
                    {
                        continue;
                    }

                    const auto ownership = surface->GetOwnership();
                    if (ownership & OWNERSHIP_OWNED)
                    {
                        UpdateBounds(owned, x, y);
                    }
                    if (ownership & OWNERSHIP_CONSTRUCTION_RIGHTS_OWNED)
                    {
                        UpdateBounds(constructionRights, x, y);
                    }
                    if (ownership & OWNERSHIP_AVAILABLE)
                    {
                        UpdateBounds(landForSale, x, y);
                    }
                    if (ownership & OWNERSHIP_CONSTRUCTION_RIGHTS_AVAILABLE)
                    {
                        UpdateBounds(rightsForSale, x, y);
                    }
                }
            }

            json_t payload = json_t::object();
            payload["mapWidth"] = gameState.mapSize.x;
            payload["mapHeight"] = gameState.mapSize.y;
            payload["owned"] = BuildBoundsNode(owned);
            payload["constructionRights"] = BuildBoundsNode(constructionRights);
            payload["landForSale"] = BuildBoundsNode(landForSale);
            payload["constructionRightsForSale"] = BuildBoundsNode(rightsForSale);
            return payload;
        }

        json_t BuildGuestHeatmapPayload(size_t limit)
        {
            std::unordered_map<uint32_t, int32_t> tileCounts;
            int32_t totalGuests = 0;
            for (auto guest : EntityList<Guest>())
            {
                if (guest == nullptr || guest->OutsideOfPark)
                {
                    continue;
                }
                auto loc = guest->GetLocation();
                int32_t tileX = loc.x / kCoordsXYStep;
                int32_t tileY = loc.y / kCoordsXYStep;
                CoordsXY mapCoords{ tileX * kCoordsXYStep, tileY * kCoordsXYStep };
                if (!MapIsLocationValid(mapCoords))
                {
                    continue;
                }
                uint32_t key = (static_cast<uint32_t>(tileY) << 16) | static_cast<uint32_t>(tileX & 0xFFFF);
                tileCounts[key]++;
                totalGuests++;
            }

            std::vector<std::pair<uint32_t, int32_t>> entries(tileCounts.begin(), tileCounts.end());
            std::sort(entries.begin(), entries.end(), [](const auto& lhs, const auto& rhs) {
                return lhs.second > rhs.second;
            });

            json_t hotspots = json_t::array();
            size_t emitted = 0;
            for (const auto& entry : entries)
            {
                if (limit != 0 && emitted >= limit)
                {
                    break;
                }
                json_t node = json_t::object();
                node["x"] = static_cast<int32_t>(entry.first & 0xFFFF);
                node["y"] = static_cast<int32_t>(entry.first >> 16);
                node["count"] = entry.second;
                hotspots.push_back(node);
                emitted++;
            }

            json_t payload = json_t::object();
            payload["totalGuests"] = totalGuests;
            payload["hotspots"] = hotspots;
            payload["limit"] = limit;
            return payload;
        }

        // Handler functions
        RpcResult HandleMapStatus(const json_t& /*params*/)
        {
            auto payload = BuildMapStatusPayload();
            auto hint = MakeGenericWindowHint("map.status", "Viewed map overview", WindowClass::map, std::nullopt);
            hint.requestCameraFocus = false;
            return RpcResult::Ok(std::move(payload), std::move(hint));
        }

        RpcResult HandleMapTile(const json_t& params)
        {
            if (!params.is_object())
            {
                return RpcResult::Error(kErrorInvalidParams, "Params must be a JSON object");
            }
            auto xParam = GetIntParam(params, "x");
            auto yParam = GetIntParam(params, "y");
            if (!xParam || !yParam)
            {
                return RpcResult::Error(kErrorInvalidParams, "x and y are required");
            }
            TileCoordsXY tile{ *xParam, *yParam };
            auto payload = BuildMapTilePayload(tile);
            std::string contextLabel = "Inspected tile (" + std::to_string(*xParam) + "," + std::to_string(*yParam) + ")";
            auto hint = MakeTileHint("map.tile", std::move(contextLabel), tile, WindowClass::map);
            hint.requestWindowFocus = false;
            return RpcResult::Ok(payload, std::move(hint));
        }

        RpcResult HandleMapOwnership(const json_t& /*params*/)
        {
            auto payload = BuildMapOwnershipPayload();
            auto hint = MakeGenericWindowHint("map.ownership", "Reviewed land ownership", WindowClass::map, std::nullopt);
            hint.requestCameraFocus = false;
            return RpcResult::Ok(payload, std::move(hint));
        }

        RpcResult HandleMapArea(const json_t& params)
        {
            constexpr int32_t kGridSize = 16;
            if (!params.is_object())
            {
                return RpcResult::Error(kErrorInvalidParams, "Params must be a JSON object");
            }
            auto xParam = GetIntParam(params, "x");
            auto yParam = GetIntParam(params, "y");

            std::string filter = GetStringParam(params, "filter").value_or("");

            TileCoordsXY origin;
            std::string contextLabel;
            if (xParam && yParam)
            {
                origin = TileCoordsXY{ *xParam, *yParam };
                contextLabel = "Rendered map area at (" + std::to_string(*xParam) + "," + std::to_string(*yParam) + ")";
            }
            else
            {
                origin = GetParkBoundsCenter(kGridSize, 1);
                contextLabel = "Rendered map area (park center) at (" + std::to_string(origin.x) + ","
                    + std::to_string(origin.y) + ")";
            }

            auto payload = BuildMapAreaPayload(origin, filter);
            auto hint = MakeTileHint("map.area", std::move(contextLabel), origin, WindowClass::map, kGridSize, kGridSize);
            return RpcResult::Ok(payload, std::move(hint));
        }

        RpcResult HandleMapHeatmapGuests(const json_t& params)
        {
            size_t limit = ExtractLimitParam(params);
            if (limit == 0)
            {
                limit = 10; // Match CLI help text default
            }
            auto payload = BuildGuestHeatmapPayload(limit);
            Telemetry::AIAgentFollowHint hint = MakeGenericWindowHint(
                "map.heatmapGuests", "Viewed guest heatmap", WindowClass::map, std::nullopt);
            hint.requestCameraFocus = false;
            if (payload.contains("hotspots") && payload["hotspots"].is_array() && !payload["hotspots"].empty())
            {
                const auto& top = payload["hotspots"].front();
                if (top.contains("x") && top.contains("y"))
                {
                    TileCoordsXY tile{ top.value("x", 0), top.value("y", 0) };
                    std::string contextLabel = "Focused on busiest tile (" + std::to_string(tile.x) + ","
                        + std::to_string(tile.y) + ")";
                    hint = MakeTileHint("map.heatmapGuests", std::move(contextLabel), tile, WindowClass::map);
                }
            }
            return RpcResult::Ok(payload, std::move(hint));
        }

        RpcResult HandleTreeCatalog(const json_t& /*params*/)
        {
            auto* context = GetContext();
            if (context == nullptr)
            {
                return RpcResult::Error(kErrorServerError, "Game context is not available");
            }
            auto payload = BuildTreeCatalogPayload(*context);
            auto hint = MakeGenericWindowHint("trees.catalog", "Browsed tree catalog", WindowClass::scenery, std::nullopt);
            return RpcResult::Ok(payload, std::move(hint));
        }

        RpcResult HandleTreePlace(const json_t& params)
        {
            if (!params.is_object())
            {
                return RpcResult::Error(kErrorInvalidParams, "Params must be a JSON object");
            }

            auto xParam = GetIntParam(params, "x");
            auto yParam = GetIntParam(params, "y");
            if (!xParam || !yParam)
            {
                return RpcResult::Error(kErrorInvalidParams, "x and y tile coordinates are required");
            }

            auto coords = TileToCoords(*xParam, *yParam);
            if (!MapIsLocationValid(coords))
            {
                return RpcResult::Error(kErrorInvalidParams, "Coordinates are outside the current map bounds");
            }

            auto treeId = GetStringParam(params, "tree");
            if (!treeId)
            {
                return RpcResult::Error(kErrorInvalidParams, "tree identifier is required");
            }

            std::string errorMessage;
            auto entryIndexOpt = ResolveTreeEntryIndex(*treeId, errorMessage);
            if (!entryIndexOpt)
            {
                return RpcResult::Error(kErrorInvalidParams, errorMessage);
            }

            int32_t zCoord = 0;
            if (auto zParam = GetIntParam(params, "z"))
            {
                zCoord = TileZToWorldZ(*zParam);
            }

            CoordsXYZD loc{ coords.x, coords.y, zCoord, 0 };
            auto action = GameActions::SmallSceneryPlaceAction(loc, 0, entryIndexOpt.value(), 0, 0, 0);
            auto result = GameActions::Execute(&action, getGameState());
            if (result.Error != GameActions::Status::Ok)
            {
                return RpcResult::Error(kErrorActionFailed, BuildGameActionErrorMessage(result));
            }

            json_t payload = BuildActionSuccessPayload(result);
            payload["tree"] = BuildTreeDescriptor(entryIndexOpt.value(), *treeId);
            payload["tile"] = json_t::object({ { "x", *xParam }, { "y", *yParam } });
            std::string contextLabel = "Planted " + *treeId + " at (" + std::to_string(*xParam) + ","
                + std::to_string(*yParam) + ")";
            auto hint = MakeTileHint("trees.place", std::move(contextLabel), TileCoordsXY{ *xParam, *yParam }, WindowClass::scenery);
            return RpcResult::Ok(payload, std::move(hint));
        }

        RpcResult HandleSceneryCatalog(const json_t& /*params*/)
        {
            auto* context = GetContext();
            if (context == nullptr)
            {
                return RpcResult::Error(kErrorServerError, "Game context is not available");
            }
            auto payload = BuildSceneryCatalogPayload(*context);
            auto hint = MakeGenericWindowHint("scenery.catalog", "Browsed scenery catalog", WindowClass::scenery, std::nullopt);
            return RpcResult::Ok(payload, std::move(hint));
        }

        RpcResult HandleSceneryPlace(const json_t& params)
        {
            if (!params.is_object())
            {
                return RpcResult::Error(kErrorInvalidParams, "Params must be a JSON object");
            }

            auto xParam = GetIntParam(params, "x");
            auto yParam = GetIntParam(params, "y");
            if (!xParam || !yParam)
            {
                return RpcResult::Error(kErrorInvalidParams, "x and y tile coordinates are required");
            }

            auto coords = TileToCoords(*xParam, *yParam);
            if (!MapIsLocationValid(coords))
            {
                return RpcResult::Error(kErrorInvalidParams, "Coordinates are outside the current map bounds");
            }

            auto sceneryId = GetStringParam(params, "scenery");
            if (!sceneryId)
            {
                sceneryId = GetStringParam(params, "id");
            }
            if (!sceneryId)
            {
                return RpcResult::Error(kErrorInvalidParams, "scenery identifier is required (use --scenery-id)");
            }

            std::string errorMessage;
            auto resolved = ResolveSceneryEntry(*sceneryId, errorMessage);
            if (!resolved)
            {
                return RpcResult::Error(kErrorInvalidParams, errorMessage);
            }

            int32_t zCoord = 0;
            if (auto zParam = GetIntParam(params, "z"))
            {
                zCoord = TileZToWorldZ(*zParam);
            }

            uint8_t quadrant = 0;
            if (auto quadParam = GetIntParam(params, "quadrant"))
            {
                quadrant = static_cast<uint8_t>(*quadParam % 4);
            }

            Direction direction = 0;
            if (auto facingParam = GetStringParam(params, "facing"))
            {
                auto parsedDirection = DirectionFromString(*facingParam);
                if (!parsedDirection)
                {
                    return RpcResult::Error(kErrorInvalidParams, "Unknown facing (use north|south|east|west)");
                }
                direction = *parsedDirection;
            }

            uint8_t primaryColour = 0;
            if (auto colourParam = GetIntParam(params, "primaryColour"))
            {
                primaryColour = static_cast<uint8_t>(*colourParam);
            }

            uint8_t secondaryColour = 0;
            if (auto colourParam = GetIntParam(params, "secondaryColour"))
            {
                secondaryColour = static_cast<uint8_t>(*colourParam);
            }

            uint8_t tertiaryColour = 0;
            if (auto colourParam = GetIntParam(params, "tertiaryColour"))
            {
                tertiaryColour = static_cast<uint8_t>(*colourParam);
            }

            CoordsXYZD loc{ coords.x, coords.y, zCoord, direction };
            GameActions::Result result;
            if (resolved->isLarge)
            {
                auto action = GameActions::LargeSceneryPlaceAction(loc, resolved->entryIndex, primaryColour, secondaryColour, tertiaryColour);
                result = GameActions::Execute(&action, getGameState());
            }
            else
            {
                auto action = GameActions::SmallSceneryPlaceAction(loc, quadrant, resolved->entryIndex, primaryColour, secondaryColour, 0);
                result = GameActions::Execute(&action, getGameState());
            }

            if (result.Error != GameActions::Status::Ok)
            {
                return RpcResult::Error(kErrorActionFailed, BuildGameActionErrorMessage(result));
            }

            json_t payload = BuildActionSuccessPayload(result);
            payload["scenery"] = BuildSceneryDescriptor(resolved->entryIndex, *sceneryId);
            payload["scenery"]["type"] = resolved->isLarge ? "large" : "small";
            payload["tile"] = json_t::object({ { "x", *xParam }, { "y", *yParam } });
            std::string contextLabel = "Placed " + *sceneryId + " at (" + std::to_string(*xParam) + ","
                + std::to_string(*yParam) + ")";
            auto hint = MakeTileHint("scenery.place", std::move(contextLabel), TileCoordsXY{ *xParam, *yParam }, WindowClass::scenery);
            return RpcResult::Ok(payload, std::move(hint));
        }

        RpcResult HandlePathItemsCatalog(const json_t& params)
        {
            auto* context = GetContext();
            if (context == nullptr)
            {
                return RpcResult::Error(kErrorServerError, "Game context is not available");
            }

            std::optional<std::string> categoryFilter;
            if (params.is_object())
            {
                categoryFilter = GetStringParam(params, "category");
            }

            auto payload = BuildPathItemsCatalogPayload(*context, categoryFilter);

            std::string contextLabel = "Browsed path items catalog";
            if (categoryFilter)
            {
                contextLabel += " (category: " + *categoryFilter + ")";
            }
            auto hint = MakeGenericWindowHint("path-items.catalog", contextLabel, WindowClass::scenery, std::nullopt);
            return RpcResult::Ok(payload, std::move(hint));
        }

        RpcResult HandlePathItemsPlace(const json_t& params)
        {
            if (!params.is_object())
            {
                return RpcResult::Error(kErrorInvalidParams, "Params must be a JSON object");
            }

            auto xParam = GetIntParam(params, "x");
            auto yParam = GetIntParam(params, "y");
            if (!xParam || !yParam)
            {
                return RpcResult::Error(kErrorInvalidParams, "x and y tile coordinates are required");
            }

            auto coords = TileToCoords(*xParam, *yParam);
            if (!MapIsLocationValid(coords))
            {
                return RpcResult::Error(kErrorInvalidParams, "Coordinates are outside the current map bounds");
            }

            auto itemId = GetStringParam(params, "item");
            if (!itemId)
            {
                itemId = GetStringParam(params, "id");
            }
            if (!itemId)
            {
                return RpcResult::Error(kErrorInvalidParams, "item identifier is required (use --item-id)");
            }

            std::string errorMessage;
            auto entryIndexOpt = ResolvePathItemEntryIndex(*itemId, errorMessage);
            if (!entryIndexOpt)
            {
                return RpcResult::Error(kErrorInvalidParams, errorMessage);
            }

            // Path items require a path element at the location
            // Find the first path element at this XY, or use specified Z
            PathElement* pathElement = nullptr;
            int32_t zCoord = 0;

            if (auto zParam = GetIntParam(params, "z"))
            {
                // If Z is explicitly specified (in tile units), convert to world units and find the path element
                zCoord = TileZToWorldZ(*zParam);
                pathElement = MapGetFootpathElement(CoordsXYZ{ coords.x, coords.y, zCoord });
                if (pathElement == nullptr)
                {
                    return RpcResult::Error(kErrorInvalidParams, "No path found at the specified z-level");
                }
            }
            else
            {
                // Find any path element at this XY coordinate
                for (auto* element : TileElementsView<PathElement>(coords))
                {
                    pathElement = element;
                    break;
                }
                if (pathElement == nullptr)
                {
                    return RpcResult::Error(kErrorInvalidParams, "No path found at this location - path items can only be placed on paths");
                }
                zCoord = pathElement->GetBaseZ();
            }

            CoordsXYZ loc{ coords.x, coords.y, zCoord };
            auto action = GameActions::FootpathAdditionPlaceAction(loc, entryIndexOpt.value());
            auto result = GameActions::Execute(&action, getGameState());
            if (result.Error != GameActions::Status::Ok)
            {
                return RpcResult::Error(kErrorActionFailed, BuildGameActionErrorMessage(result));
            }

            // Resolve the actual identifier (in case an alias was used)
            std::string resolvedId = ResolvePathItemAlias(*itemId);

            json_t payload = BuildActionSuccessPayload(result);
            payload["item"] = BuildPathItemDescriptor(entryIndexOpt.value(), resolvedId);
            payload["tile"] = json_t::object({ { "x", *xParam }, { "y", *yParam } });
            payload["z"] = WorldZToTileZ(zCoord);
            std::string contextLabel = "Placed " + *itemId + " at (" + std::to_string(*xParam) + ","
                + std::to_string(*yParam) + ")";
            auto hint = MakeTileHint("path-items.place", std::move(contextLabel), TileCoordsXY{ *xParam, *yParam }, WindowClass::scenery);
            // Disable window focus to avoid flickering, but move camera to show placement
            hint.requestWindowFocus = false;
            hint.requestCameraFocus = true;
            return RpcResult::Ok(payload, std::move(hint));
        }

        RpcResult HandlePathItemsRemove(const json_t& params)
        {
            if (!params.is_object())
            {
                return RpcResult::Error(kErrorInvalidParams, "Params must be a JSON object");
            }

            auto xParam = GetIntParam(params, "x");
            auto yParam = GetIntParam(params, "y");
            if (!xParam || !yParam)
            {
                return RpcResult::Error(kErrorInvalidParams, "x and y tile coordinates are required");
            }

            auto coords = TileToCoords(*xParam, *yParam);
            if (!MapIsLocationValid(coords))
            {
                return RpcResult::Error(kErrorInvalidParams, "Coordinates are outside the current map bounds");
            }

            // Find the path element
            PathElement* pathElement = nullptr;
            int32_t zCoord = 0;

            if (auto zParam = GetIntParam(params, "z"))
            {
                // Convert tile units to world units for path element lookup
                zCoord = TileZToWorldZ(*zParam);
                pathElement = MapGetFootpathElement(CoordsXYZ{ coords.x, coords.y, zCoord });
                if (pathElement == nullptr)
                {
                    return RpcResult::Error(kErrorNotFound, "No path found at the specified z-level");
                }
            }
            else
            {
                // Find any path element at this XY coordinate
                for (auto* element : TileElementsView<PathElement>(coords))
                {
                    pathElement = element;
                    break;
                }
                if (pathElement == nullptr)
                {
                    return RpcResult::Error(kErrorNotFound, "No path found at this location");
                }
                zCoord = pathElement->GetBaseZ();
            }

            // Check if there's an addition on this path
            auto pathTileElement = pathElement->AsPath();
            if (pathTileElement == nullptr || !pathTileElement->HasAddition())
            {
                return RpcResult::Error(kErrorNotFound, "No path item found at this location");
            }

            ObjectEntryIndex entryIndex = pathTileElement->GetAdditionEntryIndex();
            std::string identifier = PathItemIdentifierFromEntry(entryIndex);

            CoordsXYZ loc{ coords.x, coords.y, zCoord };
            auto action = GameActions::FootpathAdditionRemoveAction(loc);
            auto result = GameActions::Execute(&action, getGameState());
            if (result.Error != GameActions::Status::Ok)
            {
                return RpcResult::Error(kErrorActionFailed, BuildGameActionErrorMessage(result));
            }

            json_t payload = BuildActionSuccessPayload(result);
            payload["item"] = BuildPathItemDescriptor(entryIndex, identifier);
            payload["tile"] = json_t::object({ { "x", *xParam }, { "y", *yParam } });
            payload["z"] = WorldZToTileZ(zCoord);
            std::string contextLabel = "Removed " + identifier + " at (" + std::to_string(*xParam) + ","
                + std::to_string(*yParam) + ")";
            auto hint = MakeTileHint("path-items.remove", std::move(contextLabel), TileCoordsXY{ *xParam, *yParam }, WindowClass::scenery);
            // Move camera to show the removal location
            hint.requestWindowFocus = false;
            hint.requestCameraFocus = true;
            return RpcResult::Ok(payload, std::move(hint));
        }

        RpcResult HandlePathsCatalog(const json_t& /*params*/)
        {
            auto* context = GetContext();
            if (context == nullptr)
            {
                return RpcResult::Error(kErrorServerError, "Game context is not available");
            }

            auto& manager = context->GetObjectManager();

            // Enumerate path surfaces
            json_t surfaces = json_t::array();
            const auto maxSurfaces = static_cast<ObjectEntryIndex>(getObjectEntryGroupCount(ObjectType::footpathSurface));
            for (ObjectEntryIndex i = 0; i < maxSurfaces; ++i)
            {
                auto* surface = manager.GetLoadedObject<FootpathSurfaceObject>(i);
                if (surface == nullptr)
                {
                    continue;
                }
                json_t node = json_t::object();
                node["entryIndex"] = i;
                node["identifier"] = std::string(surface->GetIdentifier());
                node["name"] = ResolveStringId(surface->NameStringId);
                surfaces.push_back(node);
            }

            // Enumerate path railings
            json_t railings = json_t::array();
            const auto maxRailings = static_cast<ObjectEntryIndex>(getObjectEntryGroupCount(ObjectType::footpathRailings));
            for (ObjectEntryIndex i = 0; i < maxRailings; ++i)
            {
                auto* railing = manager.GetLoadedObject<FootpathRailingsObject>(i);
                if (railing == nullptr)
                {
                    continue;
                }
                json_t node = json_t::object();
                node["entryIndex"] = i;
                node["identifier"] = std::string(railing->GetIdentifier());
                node["name"] = ResolveStringId(railing->NameStringId);
                railings.push_back(node);
            }

            json_t payload = json_t::object();
            payload["surfaces"] = surfaces;
            payload["surfaceCount"] = surfaces.size();
            payload["railings"] = railings;
            payload["railingsCount"] = railings.size();

            auto hint = MakeGenericWindowHint("paths.catalog", "Browsed path catalog", WindowClass::footpath, std::nullopt);
            return RpcResult::Ok(payload, std::move(hint));
        }

        RpcResult HandlePathsPlace(const json_t& params)
        {
            if (!params.is_object())
            {
                return RpcResult::Error(kErrorInvalidParams, "Params must be a JSON object");
            }

            auto xParam = GetIntParam(params, "x");
            auto yParam = GetIntParam(params, "y");
            if (!xParam || !yParam)
            {
                return RpcResult::Error(kErrorInvalidParams, "x and y tile coordinates are required");
            }

            auto surfaceParam = GetStringParam(params, "surface");
            if (!surfaceParam)
            {
                surfaceParam = GetStringParam(params, "surfaceId");
            }
            if (!surfaceParam)
            {
                return RpcResult::Error(kErrorInvalidParams, "surface identifier is required");
            }

            TileCoordsXY tile{ *xParam, *yParam };
            auto coords = tile.ToCoordsXY();
            if (!MapIsLocationValid(coords))
            {
                return RpcResult::Error(kErrorInvalidParams, "Tile is outside the current map bounds");
            }

            std::string errorMessage;
            auto surfaceSelection = ResolvePathSurfaceSelection(*surfaceParam, errorMessage);
            if (!surfaceSelection)
            {
                return RpcResult::Error(kErrorInvalidParams, errorMessage);
            }

            // Get optional parameters for elevated path mode
            auto zParam = GetIntParam(params, "z");
            auto slopeParam = GetStringParam(params, "slope");

            // Validate: --slope requires --z for elevated path placement
            if (slopeParam && !zParam)
            {
                return RpcResult::Error(
                    kErrorInvalidParams, "--slope requires --z for elevated path placement (slope direction only applies to "
                                         "elevated ramps)");
            }

            FootpathSlope slope{ FootpathSlopeType::flat, Direction{ 0 } };
            int32_t baseZ;
            bool isElevated = false;
            std::string slopeDescription = "flat";

            if (zParam)
            {
                // ELEVATED PATH MODE: explicit height (tile units), optional slope direction
                isElevated = true;
                baseZ = TileZToWorldZ(*zParam);

                if (slopeParam)
                {
                    auto dir = ParseSlopeDirection(*slopeParam);
                    if (!dir)
                    {
                        return RpcResult::Error(
                            kErrorInvalidParams, "--slope must be north, south, east, or west (direction path slopes down to)");
                    }
                    slope = { FootpathSlopeType::sloped, *dir };
                    slopeDescription = "sloped " + SlopeDirectionToString(*dir);
                }
            }
            else
            {
                // GROUND PATH MODE: auto-detect height and slope from terrain
                auto placement = FootpathGetOnTerrainPlacement(tile);
                if (!placement.isValid())
                {
                    return RpcResult::Error(kErrorInvalidParams, "Unable to determine terrain height for this tile");
                }

                baseZ = placement.baseZ;
                slope = placement.slope;

                auto* surfaceElement = MapGetSurfaceElementAt(tile);
                const bool hasWater = surfaceElement != nullptr && surfaceElement->GetWaterHeight() > surfaceElement->GetBaseZ();
                if (hasWater)
                {
                    baseZ = surfaceElement->GetWaterHeight();
                    slope = { FootpathSlopeType::flat, Direction{ 0 } };
                    slopeDescription = "flat";
                    isElevated = true;
                }
                else
                {
                    if (placement.slope.type == FootpathSlopeType::irregular)
                    {
                        return RpcResult::Error(
                            kErrorInvalidParams,
                            "Terrain at this tile is irregular - use construction land commands to flatten, or use --z for elevated "
                            "path");
                    }

                    if (slope.type == FootpathSlopeType::sloped)
                    {
                        slopeDescription = "sloped " + SlopeDirectionToString(slope.direction);
                    }
                }
            }

            std::optional<PathRailingsSelection> railingsSelection;
            if (auto railParam = GetStringParam(params, "railings"))
            {
                railingsSelection = ResolvePathRailingsSelection(*railParam, errorMessage);
                if (!railingsSelection)
                {
                    return RpcResult::Error(kErrorInvalidParams, errorMessage);
                }
            }
            else if (auto railAlias = GetStringParam(params, "railingsId"))
            {
                railingsSelection = ResolvePathRailingsSelection(*railAlias, errorMessage);
                if (!railingsSelection)
                {
                    return RpcResult::Error(kErrorInvalidParams, errorMessage);
                }
            }

            // Queue status is determined entirely by surface type
            const bool isQueue = surfaceSelection->isQueueSurface;
            PathConstructFlags constructFlags = 0;
            if (isQueue)
            {
                constructFlags |= PathConstructFlag::IsQueue;
            }
            if (surfaceSelection->isLegacy)
            {
                constructFlags |= PathConstructFlag::IsLegacyPathObject;
            }

            // Auto-select default railings for queue paths (queue paths look wrong without railings)
            if (isQueue && !railingsSelection)
            {
                const auto maxRailings = static_cast<ObjectEntryIndex>(getObjectEntryGroupCount(ObjectType::footpathRailings));
                for (ObjectEntryIndex i = 0; i < maxRailings; i++)
                {
                    auto* railingsObj = GetPathRailingsEntry(i);
                    if (railingsObj != nullptr)
                    {
                        PathRailingsSelection selection;
                        selection.entryIndex = i;
                        selection.identifier = railingsObj->GetIdentifier();
                        railingsSelection = selection;
                        break;
                    }
                }
            }

            CoordsXYZ location{ coords.x, coords.y, baseZ };
            ObjectEntryIndex railingsIndex = railingsSelection ? railingsSelection->entryIndex : kObjectEntryIndexNull;

            auto action = GameActions::FootpathPlaceAction(
                location, slope, surfaceSelection->entryIndex, railingsIndex, kInvalidDirection, constructFlags);
            auto result = GameActions::Execute(&action, getGameState());
            if (result.Error != GameActions::Status::Ok)
            {
                return RpcResult::Error(kErrorActionFailed, BuildGameActionErrorMessage(result));
            }

            json_t payload = BuildActionSuccessPayload(result);
            json_t tileNode = json_t::object();
            tileNode["x"] = tile.x;
            tileNode["y"] = tile.y;
            payload["tile"] = tileNode;
            payload["height"] = WorldZToTileZ(baseZ);
            payload["queue"] = isQueue;
            payload["elevated"] = isElevated;
            payload["slope"] = slopeDescription;
            payload["surface"] = BuildPathSurfaceDescriptor(*surfaceSelection);
            if (railingsSelection)
            {
                payload["railings"] = BuildRailingsDescriptor(*railingsSelection);
            }

            std::string contextLabel = std::string(isQueue ? "Placed queue tile " : "Placed path tile ") + "at ("
                + std::to_string(tile.x) + "," + std::to_string(tile.y) + ")";
            auto hint = MakeTileHint("paths.place", std::move(contextLabel), tile, WindowClass::footpath);
            return RpcResult::Ok(payload, std::move(hint));
        }

        RpcResult HandlePathsRemove(const json_t& params)
        {
            if (!params.is_object())
            {
                return RpcResult::Error(kErrorInvalidParams, "Params must be a JSON object");
            }

            auto xParam = GetIntParam(params, "x");
            auto yParam = GetIntParam(params, "y");
            if (!xParam || !yParam)
            {
                return RpcResult::Error(kErrorInvalidParams, "x and y tile coordinates are required");
            }

            TileCoordsXY tile{ *xParam, *yParam };
            auto coords = tile.ToCoordsXY();
            if (!MapIsLocationValid(coords))
            {
                return RpcResult::Error(kErrorInvalidParams, "Tile is outside the current map bounds");
            }

            // Find path element at this tile, optionally filtered by z
            auto zParam = GetIntParam(params, "z");
            PathElement* targetPath = nullptr;
            int32_t foundZ = 0;

            for (auto* path : TileElementsView<PathElement>(tile))
            {
                if (path == nullptr)
                    continue;

                int32_t pathZ = WorldZToTileZ(path->GetBaseZ());
                if (zParam && pathZ != *zParam)
                    continue;

                targetPath = path;
                foundZ = pathZ;
                break; // Take the first matching path (or first if no z filter)
            }

            if (targetPath == nullptr)
            {
                if (zParam)
                {
                    return RpcResult::Error(
                        kErrorNotFound,
                        "No footpath found at tile (" + std::to_string(tile.x) + ", " + std::to_string(tile.y)
                            + ") at height z=" + std::to_string(*zParam));
                }
                return RpcResult::Error(
                    kErrorNotFound,
                    "No footpath found at tile (" + std::to_string(tile.x) + ", " + std::to_string(tile.y) + ")");
            }

            // Capture path info before removal
            bool isQueue = targetPath->IsQueue();
            std::string surfaceName;
            std::string railingsName;

            // Get surface info safely
            if (targetPath->HasLegacyPathEntry())
            {
                auto* legacyEntry = targetPath->GetLegacyPathEntry();
                if (legacyEntry != nullptr)
                {
                    surfaceName = legacyEntry->GetName();
                }
            }
            else
            {
                auto surfaceIndex = targetPath->GetSurfaceEntryIndex();
                auto* surfaceObj = OpenRCT2::ObjectManager::GetObjectEntry<FootpathSurfaceObject>(surfaceIndex);
                if (surfaceObj != nullptr)
                {
                    surfaceName = surfaceObj->GetName();
                }

                auto railingsIndex = targetPath->GetRailingsEntryIndex();
                auto* railingsObj = OpenRCT2::ObjectManager::GetObjectEntry<FootpathRailingsObject>(railingsIndex);
                if (railingsObj != nullptr)
                {
                    railingsName = railingsObj->GetName();
                }
            }

            // Use ClearAction with footpath-only filter for a single tile
            // This is more reliable than FootpathRemoveAction directly
            auto anchor = tile.ToCoordsXY();
            MapRange range(anchor, anchor);
            auto action = GameActions::ClearAction(range, GameActions::CLEARABLE_ITEMS::kSceneryFootpath);
            auto result = GameActions::Execute(&action, getGameState());

            if (result.Error != GameActions::Status::Ok)
            {
                return RpcResult::Error(kErrorActionFailed, BuildGameActionErrorMessage(result));
            }

            // Build response payload
            json_t payload = json_t::object();
            json_t tileObj = json_t::object();
            tileObj["x"] = tile.x;
            tileObj["y"] = tile.y;
            payload["tile"] = tileObj;
            payload["height"] = foundZ;
            payload["queue"] = isQueue;
            payload["cost"] = static_cast<double>(result.Cost) / 10.0; // Convert to currency display format

            if (!surfaceName.empty())
            {
                payload["surfaceName"] = surfaceName;
            }
            if (!railingsName.empty())
            {
                payload["railingsName"] = railingsName;
            }

            std::string contextLabel = std::string(isQueue ? "Removed queue tile " : "Removed path tile ") + "at ("
                + std::to_string(tile.x) + "," + std::to_string(tile.y) + ")";
            auto hint = MakeTileHint("paths.remove", std::move(contextLabel), tile, WindowClass::footpath);
            return RpcResult::Ok(payload, std::move(hint));
        }

        // Construction helper types and functions
        MapRange BuildTileBrushRange(const TileCoordsXY& anchorTile, int32_t width, int32_t height)
        {
            auto anchor = anchorTile.ToCoordsXY();
            TileCoordsXY corner = anchorTile;
            corner.x += width - 1;
            corner.y += height - 1;
            auto farCorner = corner.ToCoordsXY();
            return MapRange(anchor, farCorner).Normalise();
        }

        struct RangeOwnershipInfo
        {
            int32_t ownedTiles = 0;
            int32_t skippedTiles = 0;
            std::vector<std::pair<int32_t, int32_t>> skippedCoords;
        };

        RangeOwnershipInfo GetRangeOwnershipInfo(const TileCoordsXY& anchorTile, int32_t width, int32_t height)
        {
            RangeOwnershipInfo info;
            for (int32_t dy = 0; dy < height; dy++)
            {
                for (int32_t dx = 0; dx < width; dx++)
                {
                    TileCoordsXY checkTile{ anchorTile.x + dx, anchorTile.y + dy };
                    auto* surface = MapGetSurfaceElementAt(checkTile);
                    if (surface == nullptr || !MapIsLocationInPark(checkTile.ToCoordsXY()))
                    {
                        info.skippedTiles++;
                        if (info.skippedCoords.size() < 10)
                        {
                            info.skippedCoords.emplace_back(checkTile.x, checkTile.y);
                        }
                    }
                    else
                    {
                        info.ownedTiles++;
                    }
                }
            }
            return info;
        }

        RpcResult HandleLandAdjust(const json_t& params, bool raise)
        {
            if (!params.is_object())
            {
                return RpcResult::Error(kErrorInvalidParams, "Params must be a JSON object");
            }
            auto xParam = GetIntParam(params, "x");
            auto yParam = GetIntParam(params, "y");
            if (!xParam || !yParam)
            {
                return RpcResult::Error(kErrorInvalidParams, "x and y are required");
            }
            int32_t width = GetIntParam(params, "width").value_or(1);
            int32_t height = GetIntParam(params, "height").value_or(1);
            if (width < 1 || height < 1)
            {
                return RpcResult::Error(kErrorInvalidParams, "width and height must be >= 1 tile");
            }

            TileCoordsXY tile{ *xParam, *yParam };
            auto ownershipInfo = GetRangeOwnershipInfo(tile, width, height);

            // Capture baseline heights BEFORE the action (reading back after has timing issues)
            auto* surfaceBefore = MapGetSurfaceElementAt(tile);
            int32_t baseHeightBefore = surfaceBefore ? WorldZToTileZ(surfaceBefore->GetBaseZ()) : 0;
            int32_t clearanceHeightBefore = surfaceBefore ? WorldZToTileZ(surfaceBefore->GetClearanceZ()) : 0;

            auto coords = tile.ToCoordsXY();
            MapRange range = BuildTileBrushRange(tile, width, height);
            MapSelectType selection = MapSelectType::full;

            GameActions::Result result;
            if (raise)
            {
                auto action = GameActions::LandRaiseAction(coords, range, selection);
                result = GameActions::Execute(&action, getGameState());
            }
            else
            {
                auto action = GameActions::LandLowerAction(coords, range, selection);
                result = GameActions::Execute(&action, getGameState());
            }

            if (result.Error != GameActions::Status::Ok)
            {
                return RpcResult::Error(kErrorActionFailed, BuildGameActionErrorMessage(result));
            }

            // Build payload and adjust surface heights to reflect the successful action
            // Land raise/lower changes height by 2 tile units per operation
            auto payload = BuildMapTilePayload(tile);
            constexpr int32_t kLandHeightDelta = 2; // tile units
            int32_t delta = raise ? kLandHeightDelta : -kLandHeightDelta;
            if (payload.contains("surface") && payload["surface"].is_object())
            {
                payload["surface"]["baseHeight"] = baseHeightBefore + delta;
                payload["surface"]["clearanceHeight"] = clearanceHeightBefore + delta;
                // Recalculate meters from the adjusted height
                payload["surface"]["baseMeters"] = HeightToMeters(TileZToWorldZ(baseHeightBefore + delta));
            }

            json_t coverage = json_t::object();
            coverage["tilesModified"] = ownershipInfo.ownedTiles;
            coverage["tilesSkipped"] = ownershipInfo.skippedTiles;
            if (!ownershipInfo.skippedCoords.empty())
            {
                json_t skipped = json_t::array();
                for (const auto& coord : ownershipInfo.skippedCoords)
                {
                    json_t tile_json = json_t::object();
                    tile_json["x"] = coord.first;
                    tile_json["y"] = coord.second;
                    skipped.push_back(tile_json);
                }
                coverage["skippedExamples"] = skipped;
                coverage["note"] = "Tiles outside park boundaries are not modified. Only owned land can be raised/lowered.";
            }
            payload["coverage"] = coverage;

            std::string contextLabel = std::string(raise ? "Raised land near (" : "Lowered land near (")
                + std::to_string(tile.x) + "," + std::to_string(tile.y) + ")";
            auto hint = MakeTileHint(
                raise ? "construction.landRaise" : "construction.landLower", std::move(contextLabel), tile,
                WindowClass::land, width, height);
            return RpcResult::Ok(payload, std::move(hint));
        }

        RpcResult HandleWaterAdjust(const json_t& params, bool raise)
        {
            if (!params.is_object())
            {
                return RpcResult::Error(kErrorInvalidParams, "Params must be a JSON object");
            }
            auto xParam = GetIntParam(params, "x");
            auto yParam = GetIntParam(params, "y");
            if (!xParam || !yParam)
            {
                return RpcResult::Error(kErrorInvalidParams, "x and y are required");
            }
            int32_t width = GetIntParam(params, "width").value_or(1);
            int32_t height = GetIntParam(params, "height").value_or(1);
            if (width < 1 || height < 1)
            {
                return RpcResult::Error(kErrorInvalidParams, "width and height must be >= 1 tile");
            }

            TileCoordsXY tile{ *xParam, *yParam };
            auto ownershipInfo = GetRangeOwnershipInfo(tile, width, height);

            // Capture baseline water height BEFORE the action (reading back after has timing issues)
            auto* surfaceBefore = MapGetSurfaceElementAt(tile);
            int32_t waterHeightBefore = surfaceBefore ? WorldZToTileZ(surfaceBefore->GetWaterHeight()) : 0;

            MapRange range = BuildTileBrushRange(tile, width, height);

            GameActions::Result result;
            if (raise)
            {
                auto action = GameActions::WaterRaiseAction(range);
                result = GameActions::Execute(&action, getGameState());
            }
            else
            {
                auto action = GameActions::WaterLowerAction(range);
                result = GameActions::Execute(&action, getGameState());
            }

            if (result.Error != GameActions::Status::Ok)
            {
                return RpcResult::Error(kErrorActionFailed, BuildGameActionErrorMessage(result));
            }

            // Build payload and adjust water height to reflect the successful action
            // Water raise/lower changes height by 2 tile units per operation
            auto payload = BuildMapTilePayload(tile);
            constexpr int32_t kWaterHeightDelta = 2; // tile units
            int32_t delta = raise ? kWaterHeightDelta : -kWaterHeightDelta;
            if (payload.contains("surface") && payload["surface"].is_object())
            {
                int32_t newWaterHeight = std::max(0, waterHeightBefore + delta);
                payload["surface"]["waterHeight"] = newWaterHeight;
            }

            json_t coverage = json_t::object();
            coverage["tilesModified"] = ownershipInfo.ownedTiles;
            coverage["tilesSkipped"] = ownershipInfo.skippedTiles;
            if (!ownershipInfo.skippedCoords.empty())
            {
                json_t skipped = json_t::array();
                for (const auto& coord : ownershipInfo.skippedCoords)
                {
                    json_t tile_json = json_t::object();
                    tile_json["x"] = coord.first;
                    tile_json["y"] = coord.second;
                    skipped.push_back(tile_json);
                }
                coverage["skippedExamples"] = skipped;
                coverage["note"] = "Tiles outside park boundaries are not modified. Only owned land can have water adjusted.";
            }
            payload["coverage"] = coverage;

            std::string contextLabel = std::string(raise ? "Raised water near (" : "Lowered water near (")
                + std::to_string(tile.x) + "," + std::to_string(tile.y) + ")";
            auto hint = MakeTileHint(
                raise ? "construction.waterRaise" : "construction.waterLower", std::move(contextLabel), tile,
                WindowClass::water, width, height);
            return RpcResult::Ok(payload, std::move(hint));
        }

        RpcResult HandleSceneryClear(const json_t& params)
        {
            if (!params.is_object())
            {
                return RpcResult::Error(kErrorInvalidParams, "Params must be a JSON object");
            }

            auto xParam = GetIntParam(params, "x");
            auto yParam = GetIntParam(params, "y");
            if (!xParam || !yParam)
            {
                return RpcResult::Error(kErrorInvalidParams, "x and y are required");
            }

            int32_t width = GetIntParam(params, "width").value_or(1);
            int32_t height = GetIntParam(params, "height").value_or(1);
            if (width < 1 || height < 1)
            {
                return RpcResult::Error(kErrorInvalidParams, "width and height must be >= 1 tile");
            }

            // Build clearable items bitmask from flags
            bool clearSmall = GetBoolParam(params, "small").value_or(false);
            bool clearLarge = GetBoolParam(params, "large").value_or(false);
            bool clearPaths = GetBoolParam(params, "paths").value_or(false);

            if (!clearSmall && !clearLarge && !clearPaths)
            {
                return RpcResult::Error(
                    kErrorInvalidParams,
                    "At least one filter flag is required: small (trees, scenery, walls), large (multi-tile structures), or paths (footpaths)");
            }

            GameActions::ClearableItems itemsToClear = 0;
            if (clearSmall)
            {
                itemsToClear |= GameActions::CLEARABLE_ITEMS::kScenerySmall;
            }
            if (clearLarge)
            {
                itemsToClear |= GameActions::CLEARABLE_ITEMS::kSceneryLarge;
            }
            if (clearPaths)
            {
                itemsToClear |= GameActions::CLEARABLE_ITEMS::kSceneryFootpath;
            }

            TileCoordsXY tile{ *xParam, *yParam };
            auto ownershipInfo = GetRangeOwnershipInfo(tile, width, height);

            MapRange range = BuildTileBrushRange(tile, width, height);

            auto action = GameActions::ClearAction(range, itemsToClear);
            auto result = GameActions::Execute(&action, getGameState());

            if (result.Error != GameActions::Status::Ok)
            {
                return RpcResult::Error(kErrorActionFailed, BuildGameActionErrorMessage(result));
            }

            // Build response payload
            json_t payload = json_t::object();
            payload["x"] = tile.x;
            payload["y"] = tile.y;
            payload["width"] = width;
            payload["height"] = height;
            payload["cost"] = result.Cost;

            // Build filter description
            std::vector<std::string> clearedTypes;
            if (clearSmall)
                clearedTypes.push_back("small scenery & walls");
            if (clearLarge)
                clearedTypes.push_back("large scenery");
            if (clearPaths)
                clearedTypes.push_back("footpaths");

            std::string filterDesc;
            for (size_t i = 0; i < clearedTypes.size(); i++)
            {
                if (i > 0)
                {
                    filterDesc += (i == clearedTypes.size() - 1) ? " and " : ", ";
                }
                filterDesc += clearedTypes[i];
            }
            payload["cleared"] = filterDesc;

            json_t coverage = json_t::object();
            coverage["tilesProcessed"] = ownershipInfo.ownedTiles;
            coverage["tilesSkipped"] = ownershipInfo.skippedTiles;
            if (!ownershipInfo.skippedCoords.empty())
            {
                json_t skipped = json_t::array();
                for (const auto& coord : ownershipInfo.skippedCoords)
                {
                    json_t tile_json = json_t::object();
                    tile_json["x"] = coord.first;
                    tile_json["y"] = coord.second;
                    skipped.push_back(tile_json);
                }
                coverage["skippedExamples"] = skipped;
                coverage["note"] = "Tiles outside park boundaries are not modified.";
            }
            payload["coverage"] = coverage;

            std::string contextLabel = "Cleared " + filterDesc + " near (" + std::to_string(tile.x) + ","
                + std::to_string(tile.y) + ")";
            auto hint = MakeTileHint("construction.sceneryClear", std::move(contextLabel), tile, WindowClass::clearScenery, width, height);

            return RpcResult::Ok(payload, std::move(hint));
        }

        // =============================================================================
        // Scan Handlers
        // =============================================================================

        TileCoordsXY GetParkBoundsCenter(int32_t gridSize, int32_t zoom)
        {
            auto& gameState = getGameState();
            int32_t minX = std::numeric_limits<int32_t>::max();
            int32_t minY = std::numeric_limits<int32_t>::max();
            int32_t maxX = std::numeric_limits<int32_t>::min();
            int32_t maxY = std::numeric_limits<int32_t>::min();
            bool hasOwnedTiles = false;

            auto mapSize = GetMapSizeUnits();
            for (int32_t y = 0; y < mapSize.y; y += kCoordsXYStep)
            {
                for (int32_t x = 0; x < mapSize.x; x += kCoordsXYStep)
                {
                    if (MapIsLocationOwned({ x, y, 0 }))
                    {
                        hasOwnedTiles = true;
                        int32_t tileX = x / kCoordsXYStep;
                        int32_t tileY = y / kCoordsXYStep;
                        if (tileX < minX) minX = tileX;
                        if (tileY < minY) minY = tileY;
                        if (tileX > maxX) maxX = tileX;
                        if (tileY > maxY) maxY = tileY;
                    }
                }
            }

            if (!hasOwnedTiles)
            {
                // Fall back to map center if no owned tiles
                return TileCoordsXY{ gameState.mapSize.x / 2, gameState.mapSize.y / 2 };
            }

            // Calculate center of owned bounds, then offset to get the scan origin (NW corner)
            int32_t centerX = (minX + maxX) / 2;
            int32_t centerY = (minY + maxY) / 2;
            int32_t scanExtent = (gridSize * zoom) / 2;
            return TileCoordsXY{
                std::max(0, centerX - scanExtent),
                std::max(0, centerY - scanExtent)
            };
        }

        json_t BuildScanPayload(const TileCoordsXY& origin, int32_t zoom, const std::string& scanType)
        {
            constexpr int32_t kGridSize = 16;
            json_t payload = json_t::object();
            payload["origin"] = json_t::object({ { "x", origin.x }, { "y", origin.y } });
            payload["zoom"] = zoom;
            payload["gridSize"] = kGridSize;
            payload["scanType"] = scanType;

            // Pre-compute guest density map if needed
            std::unordered_map<uint32_t, int32_t> guestDensity;
            if (scanType == "guests")
            {
                for (auto guest : EntityList<Guest>())
                {
                    if (guest == nullptr || guest->OutsideOfPark)
                    {
                        continue;
                    }
                    auto loc = guest->GetLocation();
                    int32_t tileX = loc.x / kCoordsXYStep;
                    int32_t tileY = loc.y / kCoordsXYStep;
                    CoordsXY mapCoords{ tileX * kCoordsXYStep, tileY * kCoordsXYStep };
                    if (!MapIsLocationValid(mapCoords))
                    {
                        continue;
                    }
                    uint32_t key = (static_cast<uint32_t>(tileY) << 16) | static_cast<uint32_t>(tileX & 0xFFFF);
                    guestDensity[key]++;
                }
            }

            // Scan blocks
            std::vector<BlockSummary> blocks;
            blocks.reserve(kGridSize * kGridSize);

            for (int32_t blockY = 0; blockY < kGridSize; ++blockY)
            {
                for (int32_t blockX = 0; blockX < kGridSize; ++blockX)
                {
                    BlockSummary summary;
                    TileCoordsXY blockOrigin{ origin.x + (blockX * zoom), origin.y + (blockY * zoom) };

                    // Scan all tiles in this block
                    for (int32_t dy = 0; dy < zoom; ++dy)
                    {
                        for (int32_t dx = 0; dx < zoom; ++dx)
                        {
                            TileCoordsXY tile{ blockOrigin.x + dx, blockOrigin.y + dy };
                            auto coords = tile.ToCoordsXY();
                            if (!MapIsLocationValid(coords))
                            {
                                continue;
                            }

                            if (scanType == "development")
                            {
                                // Count infrastructure tiles
                                for (auto* element : TileElementsView<TileElement>(tile))
                                {
                                    if (element == nullptr)
                                    {
                                        break;
                                    }
                                    if (element->AsTrack() != nullptr || element->AsPath() != nullptr
                                        || element->AsEntrance() != nullptr)
                                    {
                                        summary.developmentCount++;
                                        break; // Count each tile once
                                    }
                                }
                            }
                            else if (scanType == "guests")
                            {
                                // Sum guest counts
                                uint32_t key = (static_cast<uint32_t>(tile.y) << 16)
                                    | static_cast<uint32_t>(tile.x & 0xFFFF);
                                auto it = guestDensity.find(key);
                                if (it != guestDensity.end())
                                {
                                    summary.guestCount += it->second;
                                }
                            }
                        }
                    }
                    blocks.push_back(summary);
                }
            }

            // Generate symbols and legend
            json_t rows = json_t::array();
            std::unordered_set<char> seenSymbols;
            std::vector<std::pair<char, std::string>> legendEntries;

            for (int32_t blockY = 0; blockY < kGridSize; ++blockY)
            {
                std::string row;
                row.reserve(kGridSize);
                for (int32_t blockX = 0; blockX < kGridSize; ++blockX)
                {
                    const auto& summary = blocks[blockY * kGridSize + blockX];
                    char symbol = '.';
                    std::string label = "Empty";

                    if (scanType == "development")
                    {
                        int32_t tilesPerBlock = zoom * zoom;
                        float density = static_cast<float>(summary.developmentCount) / tilesPerBlock;
                        if (density >= 0.75f)
                        {
                            symbol = '#'; // Dense
                            label = "Dense development (75%+)";
                        }
                        else if (density >= 0.50f)
                        {
                            symbol = '+'; // High
                            label = "High development (50-75%)";
                        }
                        else if (density >= 0.25f)
                        {
                            symbol = '='; // Medium
                            label = "Medium development (25-50%)";
                        }
                        else if (density > 0.0f)
                        {
                            symbol = '-'; // Light
                            label = "Light development (1-25%)";
                        }
                        else
                        {
                            symbol = '.';
                            label = "Undeveloped";
                        }
                    }
                    else if (scanType == "guests")
                    {
                        if (summary.guestCount >= 20)
                        {
                            symbol = '#'; // Very busy
                            label = "Very busy (20+ guests)";
                        }
                        else if (summary.guestCount >= 10)
                        {
                            symbol = '+'; // Busy
                            label = "Busy (10-19 guests)";
                        }
                        else if (summary.guestCount >= 5)
                        {
                            symbol = '='; // Moderate
                            label = "Moderate traffic (5-9 guests)";
                        }
                        else if (summary.guestCount > 0)
                        {
                            symbol = '-'; // Light
                            label = "Light traffic (1-4 guests)";
                        }
                        else
                        {
                            symbol = '.';
                            label = "No guests";
                        }
                    }

                    row.push_back(symbol);
                    if (seenSymbols.insert(symbol).second)
                    {
                        legendEntries.emplace_back(symbol, label);
                    }
                }
                rows.push_back(row);
            }

            payload["rows"] = rows;

            json_t legend = json_t::array();
            for (const auto& entry : legendEntries)
            {
                json_t node = json_t::object();
                node["symbol"] = std::string(1, entry.first);
                node["label"] = entry.second;
                legend.push_back(node);
            }
            payload["legend"] = legend;

            return payload;
        }

        RpcResult HandleScanDevelopment(const json_t& params)
        {
            constexpr int32_t kGridSize = 16;
            if (!params.is_object())
            {
                return RpcResult::Error(kErrorInvalidParams, "Params must be a JSON object");
            }
            // Validate zoom first since it has a default - explicit invalid values should error early
            auto zoom = GetIntParam(params, "zoom").value_or(10);
            if (zoom != 10 && zoom != 20)
            {
                return RpcResult::Error(kErrorInvalidParams, "zoom must be 10 or 20");
            }
            auto xParam = GetIntParam(params, "x");
            auto yParam = GetIntParam(params, "y");

            TileCoordsXY origin;
            std::string contextLabel;
            if (xParam && yParam)
            {
                origin = TileCoordsXY{ *xParam, *yParam };
                contextLabel = "Development scan at (" + std::to_string(*xParam) + "," + std::to_string(*yParam)
                    + ") zoom=" + std::to_string(zoom);
            }
            else
            {
                origin = GetParkBoundsCenter(kGridSize, zoom);
                contextLabel = "Development scan (park center) at (" + std::to_string(origin.x) + ","
                    + std::to_string(origin.y) + ") zoom=" + std::to_string(zoom);
            }

            auto payload = BuildScanPayload(origin, zoom, "development");
            int32_t coverageTiles = kGridSize * zoom;
            auto hint = MakeTileHint("scan.development", std::move(contextLabel), origin, WindowClass::map, coverageTiles, coverageTiles);
            hint.requestCameraFocus = false;
            return RpcResult::Ok(payload, std::move(hint));
        }

        RpcResult HandleScanGuests(const json_t& params)
        {
            constexpr int32_t kGridSize = 16;
            if (!params.is_object())
            {
                return RpcResult::Error(kErrorInvalidParams, "Params must be a JSON object");
            }
            // Validate zoom first since it has a default - explicit invalid values should error early
            auto zoom = GetIntParam(params, "zoom").value_or(10);
            if (zoom != 10 && zoom != 20)
            {
                return RpcResult::Error(kErrorInvalidParams, "zoom must be 10 or 20");
            }
            auto xParam = GetIntParam(params, "x");
            auto yParam = GetIntParam(params, "y");

            TileCoordsXY origin;
            std::string contextLabel;
            if (xParam && yParam)
            {
                origin = TileCoordsXY{ *xParam, *yParam };
                contextLabel = "Guest density scan at (" + std::to_string(*xParam) + ","
                    + std::to_string(*yParam) + ") zoom=" + std::to_string(zoom);
            }
            else
            {
                origin = GetParkBoundsCenter(kGridSize, zoom);
                contextLabel = "Guest density scan (park center) at (" + std::to_string(origin.x) + ","
                    + std::to_string(origin.y) + ") zoom=" + std::to_string(zoom);
            }

            auto payload = BuildScanPayload(origin, zoom, "guests");
            int32_t coverageTiles = kGridSize * zoom;
            auto hint = MakeTileHint("scan.guests", std::move(contextLabel), origin, WindowClass::map, coverageTiles, coverageTiles);
            hint.requestCameraFocus = false;
            return RpcResult::Ok(payload, std::move(hint));
        }

        // Helper to classify path addition type from flags
        std::string ClassifyPathAdditionType(uint16_t flags)
        {
            if (flags & PATH_ADDITION_FLAG_IS_BENCH)
                return "bench";
            if (flags & PATH_ADDITION_FLAG_IS_BIN)
                return "bin";
            if (flags & PATH_ADDITION_FLAG_LAMP)
                return "lamp";
            if (flags & (PATH_ADDITION_FLAG_JUMPING_FOUNTAIN_WATER | PATH_ADDITION_FLAG_JUMPING_FOUNTAIN_SNOW))
                return "fountain";
            if (flags & PATH_ADDITION_FLAG_IS_QUEUE_SCREEN)
                return "queue_screen";
            return "other";
        }

        // Helper to describe bin fullness from AdditionStatus
        // AdditionStatus encodes 4 bins (one per quadrant) with 2 bits each:
        // 0 = empty, 1 = 1/3 full, 2 = 2/3 full, 3 = full
        std::string DescribeBinFullness(uint8_t additionStatus)
        {
            int totalCapacity = 12; // 4 bins * 3 units each
            int totalFill = 0;
            for (int i = 0; i < 4; i++)
            {
                int binLevel = (additionStatus >> (i * 2)) & 0x3;
                totalFill += binLevel;
            }
            int percentage = (totalFill * 100) / totalCapacity;
            if (percentage == 0)
                return "empty";
            if (percentage == 100)
                return "full";
            return std::to_string(percentage) + "%";
        }

        RpcResult HandlePathsList(const json_t& params)
        {
            const auto& gameState = getGameState();

            // Extract parameters
            size_t limit = params.is_object() ? ExtractLimitParam(params) : 50;
            if (limit == 0)
                limit = 50;

            std::string afterCursor;
            if (params.is_object())
            {
                if (auto cursor = GetStringParam(params, "after"))
                    afterCursor = *cursor;
            }

            std::optional<std::string> typeFilter;
            if (params.is_object())
            {
                if (auto t = GetStringParam(params, "type"))
                {
                    std::string lower = ToLower(*t);
                    if (lower != "all")
                        typeFilter = lower;
                }
            }

            bool brokenOnly = false;
            if (params.is_object())
            {
                brokenOnly = GetBoolParam(params, "broken").value_or(false);
            }

            std::string sortField = "type";
            std::string sortDirection = "asc";
            if (params.is_object())
            {
                if (auto order = GetStringParam(params, "order"))
                    sortField = ToLower(*order);
                if (auto dir = GetStringParam(params, "direction"))
                    sortDirection = ToLower(*dir);
            }

            // Structure to hold path addition info
            struct PathAdditionInfo
            {
                std::string id;
                std::string type;
                std::string objectName;
                int32_t x, y, z;
                bool broken;
                std::string binFullness;
            };

            std::vector<PathAdditionInfo> allAdditions;

            // Iterate all tiles looking for path elements with additions
            for (int32_t tileY = 0; tileY < gameState.mapSize.y; ++tileY)
            {
                for (int32_t tileX = 0; tileX < gameState.mapSize.x; ++tileX)
                {
                    TileCoordsXY tile{ tileX, tileY };
                    auto coords = tile.ToCoordsXY();
                    if (!MapIsLocationValid(coords))
                        continue;

                    for (auto* path : TileElementsView<PathElement>(tile))
                    {
                        if (path == nullptr || !path->HasAddition())
                            continue;

                        auto entryIndex = path->GetAdditionEntryIndex();
                        const auto* entry = path->GetAdditionEntry();
                        if (entry == nullptr)
                            continue;

                        PathAdditionInfo info;
                        int32_t baseZ = WorldZToTileZ(path->GetBaseZ());
                        info.id = std::to_string(tileX) + "," + std::to_string(tileY) + "," + std::to_string(baseZ);
                        info.type = ClassifyPathAdditionType(entry->flags);
                        info.objectName = PathItemNameFromEntry(entryIndex);
                        info.x = tileX;
                        info.y = tileY;
                        info.z = baseZ;
                        info.broken = path->IsBroken();

                        // Bin fullness only meaningful for bins
                        if (entry->flags & PATH_ADDITION_FLAG_IS_BIN)
                        {
                            info.binFullness = DescribeBinFullness(path->GetAdditionStatus());
                        }

                        // Apply filters
                        if (typeFilter && info.type != *typeFilter)
                            continue;
                        if (brokenOnly && !info.broken)
                            continue;

                        allAdditions.push_back(std::move(info));
                    }
                }
            }

            // Sort results
            auto compareFn = [&](const PathAdditionInfo& a, const PathAdditionInfo& b) -> bool {
                int cmp = 0;
                if (sortField == "type")
                    cmp = a.type.compare(b.type);
                else if (sortField == "broken")
                    cmp = static_cast<int>(a.broken) - static_cast<int>(b.broken);
                else if (sortField == "x")
                    cmp = a.x - b.x;
                else if (sortField == "y")
                    cmp = a.y - b.y;

                if (cmp == 0)
                {
                    // Secondary sort by ID for determinism
                    cmp = a.id.compare(b.id);
                }
                return sortDirection == "desc" ? cmp > 0 : cmp < 0;
            };
            std::sort(allAdditions.begin(), allAdditions.end(), compareFn);

            // Apply cursor pagination - find starting index
            size_t startIndex = 0;
            if (!afterCursor.empty())
            {
                for (size_t i = 0; i < allAdditions.size(); ++i)
                {
                    if (allAdditions[i].id == afterCursor)
                    {
                        startIndex = i + 1;
                        break;
                    }
                }
            }

            // Build response
            json_t items = json_t::array();
            size_t emitted = 0;
            bool hasMore = false;
            std::string nextCursor;

            for (size_t i = startIndex; i < allAdditions.size(); ++i)
            {
                if (emitted >= limit)
                {
                    hasMore = true;
                    break;
                }

                const auto& info = allAdditions[i];
                json_t item = json_t::object();
                item["id"] = info.id;
                item["type"] = info.type;
                item["objectName"] = info.objectName;
                item["x"] = info.x;
                item["y"] = info.y;
                item["z"] = info.z;
                item["broken"] = info.broken;
                if (!info.binFullness.empty())
                {
                    item["binFullness"] = info.binFullness;
                }

                items.push_back(item);
                nextCursor = info.id;
                emitted++;
            }

            json_t payload = json_t::object();
            payload["pathAdditions"] = items;
            payload["returned"] = emitted;
            payload["total"] = allAdditions.size();
            payload["hasMore"] = hasMore;
            if (hasMore && !nextCursor.empty())
            {
                payload["nextCursor"] = nextCursor;
            }

            std::string contextLabel = "Listed " + std::to_string(emitted) + " path additions";
            if (brokenOnly)
                contextLabel += " (broken only)";
            if (typeFilter)
                contextLabel += " (type: " + *typeFilter + ")";
            auto hint = MakeGenericWindowHint("paths.list", contextLabel, WindowClass::map, std::nullopt);
            return RpcResult::Ok(payload, std::move(hint));
        }

        // Static registration
        struct MapHandlerRegistrar
        {
            MapHandlerRegistrar()
            {
                auto& registry = HandlerRegistry::Instance();
                registry.Register("map.status", HandleMapStatus);
                registry.Register("map.tile", HandleMapTile);
                registry.Register("map.ownership", HandleMapOwnership);
                registry.Register("map.area", HandleMapArea);
                registry.Register("map.heatmapGuests", HandleMapHeatmapGuests);
                registry.Register("trees.catalog", HandleTreeCatalog);
                registry.Register("trees.place", HandleTreePlace);
                registry.Register("scenery.catalog", HandleSceneryCatalog);
                registry.Register("scenery.place", HandleSceneryPlace);
                registry.Register("path-items.catalog", HandlePathItemsCatalog);
                registry.Register("path-items.place", HandlePathItemsPlace);
                registry.Register("path-items.remove", HandlePathItemsRemove);
                registry.Register("paths.catalog", HandlePathsCatalog);
                registry.Register("paths.place", HandlePathsPlace);
                registry.Register("paths.remove", HandlePathsRemove);
                registry.Register("paths.list", HandlePathsList);
                registry.Register("construction.landRaise", [](const json_t& params) { return HandleLandAdjust(params, true); });
                registry.Register("construction.landLower", [](const json_t& params) { return HandleLandAdjust(params, false); });
                registry.Register("construction.waterRaise", [](const json_t& params) { return HandleWaterAdjust(params, true); });
                registry.Register("construction.waterLower", [](const json_t& params) { return HandleWaterAdjust(params, false); });
                registry.Register("construction.sceneryClear", HandleSceneryClear);
                registry.Register("scan.development", HandleScanDevelopment);
                registry.Register("scan.guests", HandleScanGuests);
            }
        } mapRegistrar;

    } // namespace

    void InitMapHandlers()
    {
        (void)mapRegistrar;
    }

} // namespace OpenRCT2::Scripting::Rpc::Handlers

#endif // ENABLE_SCRIPTING
