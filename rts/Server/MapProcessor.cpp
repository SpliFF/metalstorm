// MapProcessor — full map data extraction from SMF/SMT/mapinfo.lua.

#include "MapProcessor.h"
#include "FeatureProcessor.h"
#include "System/SpringLog/SpringLog.h"

// Lua compiled as C++
#include "lua.h"
#include "lualib.h"
#include "lauxlib.h"

#include "System/FileSystem/DetailTexDc.h"
#include "System/FileSystem/LuaVFSSimple.h"
#include "System/FileSystem/FileHandler.h"

#include <nlohmann/json.hpp>

#include <sqlite3.h>
#include <algorithm>
#include <cmath>
#include <cstdint>
#include <cstdio>
#include <cstring>
#include <filesystem>
#include <fstream>
#include <system_error>
#include <unordered_map>

// Absolute path to the textureconverter binary, injected at build time
// via target_compile_definitions. Falls back to a bare name.
#ifndef TEXTURECONVERTER_BINARY_PATH
#define TEXTURECONVERTER_BINARY_PATH "textureconverter"
#endif

#define LOG_SECTION "map-proc"

namespace fs = std::filesystem;

constexpr int SQUARE_SIZE = 8;
constexpr int TILE_MIP0_SIZE = 512;
constexpr int SMALL_TILE_SIZE = 680;
// Spring SMT tile records carry 4 mip levels per 32x32-texel tile:
// mip0 32x32 (8x8 DXT1 blocks = 512B), mip1 16x16 (128B), mip2 8x8 (32B),
// mip3 4x4 (8B) = 680B total, matching SMALL_TILE_SIZE.
constexpr int TILE_NUM_MIPS = 4;
constexpr int TILE_MIP_SIZE[TILE_NUM_MIPS] = { 512, 128, 32, 8 };

// ============================================================
// Region graph geometry — mirrors LuaRules/Gadgets/regions/partition.lua's
// pointInPolygon/isSelfIntersecting exactly (PLAN-metalstorm-regions.md §5:
// this export is a static re-serialisation of the same data the sim
// validates, and the two validators must agree on which provider — grid or
// graph — ends up active, or the client mirror would lie about ownership
// costs relative to what the sim actually charges).
// ============================================================

struct RegionPoint { float x = 0, z = 0; };

struct RegionRecord {
    std::string key;
    std::string name;
    std::vector<RegionPoint> polygon;
    float value = 0;
    std::vector<std::string> tags;
    std::vector<std::string> neighbors;
};

static float RegionCross(float ox, float oz, float ax, float az, float bx, float bz) {
    return (ax - ox) * (bz - oz) - (az - oz) * (bx - ox);
}

static bool RegionSegmentsIntersect(const RegionPoint& p1, const RegionPoint& p2,
                                     const RegionPoint& p3, const RegionPoint& p4) {
    const float d1 = RegionCross(p3.x, p3.z, p4.x, p4.z, p1.x, p1.z);
    const float d2 = RegionCross(p3.x, p3.z, p4.x, p4.z, p2.x, p2.z);
    const float d3 = RegionCross(p1.x, p1.z, p2.x, p2.z, p3.x, p3.z);
    const float d4 = RegionCross(p1.x, p1.z, p2.x, p2.z, p4.x, p4.z);
    const bool cross1 = (d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0);
    const bool cross2 = (d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0);
    return cross1 && cross2;
}

/// True if non-adjacent edges of `poly` cross. Degenerate (<3 vertices)
/// counts as self-intersecting. Same adjacency-skip logic as the Lua
/// validator: edge i and edge i+1 (mod n) always share a vertex and are
/// skipped; the wrap pair (edge 0, edge n-1) is skipped explicitly.
static bool RegionIsSelfIntersecting(const std::vector<RegionPoint>& poly) {
    const size_t n = poly.size();
    if (n < 3) return true;
    for (size_t i = 0; i < n; i++) {
        const RegionPoint& a1 = poly[i];
        const RegionPoint& a2 = poly[(i + 1) % n];
        for (size_t j = i + 2; j < n; j++) {
            if (i == 0 && j == n - 1) continue;
            const RegionPoint& b1 = poly[j];
            const RegionPoint& b2 = poly[(j + 1) % n];
            if (RegionSegmentsIntersect(a1, a2, b1, b2)) return true;
        }
    }
    return false;
}

constexpr int REGION_MIN_PER_AXIS = 2;               // E5: degenerate-grid clamp
constexpr float REGION_DEFAULT_GRID_SIZE = 2048.0f;

/// Same clamp as partition.lua's `gridRegionSize` — kept in sync so the
/// grid-fallback descriptor exported here matches what the sim itself
/// computes at runtime from the same map dimensions.
static float RegionGridSize(float mapWidth, float mapHeight) {
    const float maxSize = std::min(mapWidth, mapHeight) / REGION_MIN_PER_AXIS;
    return std::min(REGION_DEFAULT_GRID_SIZE, maxSize);
}

// ============================================================
// Lua helpers for reading table fields
// ============================================================

static std::string luaGetString(lua_State* L, const char* field) {
    lua_getfield(L, -1, field);
    std::string result = lua_isstring(L, -1) ? lua_tostring(L, -1) : "";
    lua_pop(L, 1);
    return result;
}

static float luaGetFloat(lua_State* L, const char* field, float def = 0) {
    lua_getfield(L, -1, field);
    float result = lua_isnumber(L, -1) ? static_cast<float>(lua_tonumber(L, -1)) : def;
    lua_pop(L, 1);
    return result;
}

// ============================================================
// mapinfo.lua parsing via Lua 5.4
// ============================================================

bool MapProcessor::ReadMapInfo(const std::string& mapDir, MapMetadata& meta) {
    // Find SMF/SMT files
    for (auto& entry : fs::recursive_directory_iterator(mapDir)) {
        if (!entry.is_regular_file()) continue;
        auto ext = entry.path().extension().string();
        if (ext == ".smf" && meta.smfPath.empty()) meta.smfPath = entry.path().string();
        if (ext == ".smt" && meta.smtPath.empty()) meta.smtPath = entry.path().string();
    }
    meta.hasLuaGaia = fs::is_directory(fs::path(mapDir) / "LuaGaia");

    // Find and execute mapinfo.lua
    std::string mapInfoPath;
    for (auto& entry : fs::directory_iterator(mapDir)) {
        if (entry.is_regular_file() && entry.path().filename() == "mapinfo.lua")
            mapInfoPath = entry.path().string();
    }

    if (!mapInfoPath.empty()) {
        // Save existing content roots, add map directory for VFS resolution
        auto savedRoots = CFileHandler::GetCategorizedRoots();
        CFileHandler::AddContentRoot(mapDir, RootCategory::Map);

        lua_State* L = luaL_newstate();
        luaL_openlibs(L);

        // Lua 5.1 compat
        luaL_dostring(L,
            "unpack = unpack or table.unpack\n"
            "loadstring = loadstring or load\n"
            "if not setfenv then\n"
            "  setfenv = function(f, t) return f end\n"
            "  getfenv = function(f) return _G end\n"
            "end\n"
            "module = module or function() end\n"
            "Spring = Spring or { Echo = print }\n"
        );

        // Real VFS backed by CFileHandler (plain directories)
        LuaVFSSimple::Register(L);

        // Common Lua utility functions that maps expect
        luaL_dostring(L,
            "function lowerkeys(t)\n"
            "  local out = {}\n"
            "  for k,v in pairs(t) do\n"
            "    if type(k) == 'string' then out[k:lower()] = v\n"
            "    else out[k] = v end\n"
            "  end\n"
            "  return out\n"
            "end\n"
            "function tmerge(dst, src)\n"
            "  for k,v in pairs(src) do\n"
            "    if type(v) == 'table' and type(dst[k]) == 'table' then tmerge(dst[k], v)\n"
            "    else dst[k] = v end\n"
            "  end\n"
            "end\n"
        );

        if (luaL_dofile(L, mapInfoPath.c_str()) != LUA_OK) {
            SLOG(SPRING_LOG_ERROR, "lua error in %s: %s",
                mapInfoPath.c_str(), lua_tostring(L, -1));
            lua_close(L);
            // Restore content roots
            CFileHandler::ClearContentRoots();
            for (const auto& r : savedRoots) CFileHandler::AddContentRoot(r.path, r.category);
        } else {
            // mapinfo.lua typically returns a table
            if (!lua_istable(L, -1))
                lua_getglobal(L, "mapinfo");

            if (lua_istable(L, -1)) {
                // Keys may be lowercased by lowerkeys() in mapinfo.lua
                auto getString = [&](const char* lower, const char* camel) {
                    std::string s = luaGetString(L, lower);
                    if (s.empty() && camel) s = luaGetString(L, camel);
                    return s;
                };
                auto getFloat = [&](const char* lower, const char* camel, float def) {
                    // luaGetFloat returns def when missing; we can't distinguish missing from default,
                    // so just try lower first, if it returns def try camel.
                    float v = luaGetFloat(L, lower, def);
                    if (v == def && camel) v = luaGetFloat(L, camel, def);
                    return v;
                };
                meta.name = getString("name", nullptr);
                meta.shortName = getString("shortname", nullptr);
                meta.description = getString("description", nullptr);
                meta.author = getString("author", nullptr);
                meta.version = getString("version", nullptr);
                meta.gravity = getFloat("gravity", nullptr, 130);
                meta.tidalStrength = getFloat("tidalstrength", "tidalStrength", 0);
                meta.maxMetal = getFloat("maxmetal", "maxMetal", 2.0f);
                meta.extractorRadius = getFloat("extractorradius", "extractorRadius", 100.0f);

                // Per-map coordinate frame opt-in. Defaults to LH (`true`)
                // when the field is absent so every existing Spring map
                // (whose mapinfo.lua, featureplacer/*.lua, etc. were
                // authored against +Z forward) gets its positions
                // flipped on import. New RH-native maps set
                // `legacyCoordSystem = false` to opt out. See
                // PLAN-coordinate-system.md.
                {
                    lua_getfield(L, -1, "legacycoordsystem");
                    if (lua_isnil(L, -1)) { lua_pop(L, 1); lua_getfield(L, -1, "legacyCoordSystem"); }
                    if (!lua_isnil(L, -1))
                        meta.legacyCoordSystem = lua_toboolean(L, -1) != 0;
                    lua_pop(L, 1);
                }

                // voidWater lives at the root
                lua_getfield(L, -1, "voidwater");
                if (lua_isnil(L, -1)) { lua_pop(L, 1); lua_getfield(L, -1, "voidWater"); }
                meta.water.voidWater = lua_toboolean(L, -1) != 0;
                lua_pop(L, 1);

                // water = { baseColor = {r,g,b}, surfaceColor = ..., damage = ... }
                lua_getfield(L, -1, "water");
                if (lua_istable(L, -1)) {
                    auto readColor = [&](const char* lower, const char* camel, float* out) {
                        lua_getfield(L, -1, lower);
                        if (lua_isnil(L, -1) && camel) { lua_pop(L, 1); lua_getfield(L, -1, camel); }
                        if (lua_istable(L, -1)) {
                            for (int i = 0; i < 3; i++) {
                                lua_rawgeti(L, -1, i + 1);
                                if (lua_isnumber(L, -1)) out[i] = static_cast<float>(lua_tonumber(L, -1));
                                lua_pop(L, 1);
                            }
                        }
                        lua_pop(L, 1);
                    };
                    readColor("basecolor",    "baseColor",    meta.water.baseColor);
                    readColor("surfacecolor", "surfaceColor", meta.water.surfaceColor);
                    readColor("mincolor",     "minColor",     meta.water.minColor);
                    meta.water.surfaceAlpha = luaGetFloat(L, "surfacealpha", meta.water.surfaceAlpha);
                    if (meta.water.surfaceAlpha == 0.55f) // default unchanged, try camelCase
                        meta.water.surfaceAlpha = luaGetFloat(L, "surfaceAlpha", meta.water.surfaceAlpha);
                    meta.water.damage = luaGetFloat(L, "damage", 0.0f);
                }
                lua_pop(L, 1); // pop water

                // Read splat/decal textures: resources = { ... }
                // Map scripts typically call lowerkeys(mapinfo), so keys are lowercase.
                // We try lowercase first then fall back to camelCase.
                auto getTex = [&](const char* lower, const char* camel) {
                    std::string s = luaGetString(L, lower);
                    if (s.empty() && camel) s = luaGetString(L, camel);
                    return s;
                };
                lua_getfield(L, -1, "resources");
                if (lua_istable(L, -1)) {
                    meta.decals.detailTex       = getTex("detailtex",       "detailTex");
                    meta.decals.specularTex     = getTex("speculartex",     "specularTex");
                    meta.decals.splatDetailTex  = getTex("splatdetailtex",  "splatDetailTex");
                    meta.decals.splatDistrTex   = getTex("splatdistrtex",   "splatDistrTex");
                    meta.decals.detailNormalTex = getTex("detailnormaltex", "detailNormalTex");
                    meta.decals.splatDetailNormalTex[0] = getTex("splatdetailnormaltex1", "splatDetailNormalTex1");
                    meta.decals.splatDetailNormalTex[1] = getTex("splatdetailnormaltex2", "splatDetailNormalTex2");
                    meta.decals.splatDetailNormalTex[2] = getTex("splatdetailnormaltex3", "splatDetailNormalTex3");
                    meta.decals.splatDetailNormalTex[3] = getTex("splatdetailnormaltex4", "splatDetailNormalTex4");
                    // Some maps typo "platDetailNormalTex3" (seen in pools_of_ilys)
                    if (meta.decals.splatDetailNormalTex[2].empty())
                        meta.decals.splatDetailNormalTex[2] = getTex("platdetailnormaltex3", "platDetailNormalTex3");

                    // SMF_DETAIL_NORMAL_DIFFUSE_ALPHA. Recoil accepts two
                    // authoring forms (CMapInfo::ReadSMF): the sub-table
                    // `splatDetailNormalTex = { alpha = true, [1] = ... }`
                    // wins where it exists, otherwise the flat
                    // `splatDetailNormalDiffuseAlpha` key beside the
                    // `splatDetailNormalTexN` entries. Only the flat form is
                    // used by any map here, but read both so the precedence
                    // matches. Lua `1`/`true` both count.
                    lua_getfield(L, -1, "splatdetailnormaltex");
                    if (!lua_istable(L, -1)) { lua_pop(L, 1); lua_getfield(L, -1, "splatDetailNormalTex"); }
                    if (lua_istable(L, -1)) {
                        lua_getfield(L, -1, "alpha");
                        meta.decals.splatDetailNormalDiffuseAlpha =
                            lua_isnumber(L, -1) ? lua_tonumber(L, -1) != 0 : lua_toboolean(L, -1) != 0;
                        lua_pop(L, 1);
                        lua_pop(L, 1);
                    } else {
                        lua_pop(L, 1);
                        lua_getfield(L, -1, "splatdetailnormaldiffusealpha");
                        if (lua_isnil(L, -1)) { lua_pop(L, 1); lua_getfield(L, -1, "splatDetailNormalDiffuseAlpha"); }
                        meta.decals.splatDetailNormalDiffuseAlpha =
                            lua_isnumber(L, -1) ? lua_tonumber(L, -1) != 0 : lua_toboolean(L, -1) != 0;
                        lua_pop(L, 1);
                    }
                }
                lua_pop(L, 1); // pop resources

                // Read splats = { texScales = {...}, texMults = {...} }
                lua_getfield(L, -1, "splats");
                if (lua_istable(L, -1)) {
                    auto readFloatArray = [&](const char* field, float* out, int n) {
                        lua_getfield(L, -1, field);
                        if (lua_istable(L, -1)) {
                            for (int i = 0; i < n; i++) {
                                lua_rawgeti(L, -1, i + 1);
                                if (lua_isnumber(L, -1)) out[i] = static_cast<float>(lua_tonumber(L, -1));
                                lua_pop(L, 1);
                            }
                        }
                        lua_pop(L, 1);
                    };
                    readFloatArray("texscales", meta.decals.splatScales, 4);
                    readFloatArray("texmults",  meta.decals.splatMults,  4);
                    // Fall back to camelCase
                    float zero[4] = {0};
                    if (memcmp(meta.decals.splatScales, zero, sizeof(zero)) == 0)
                        readFloatArray("texScales", meta.decals.splatScales, 4);
                    if (memcmp(meta.decals.splatMults, zero, sizeof(zero)) == 0)
                        readFloatArray("texMults",  meta.decals.splatMults,  4);
                }
                lua_pop(L, 1); // pop splats

                // smf = { minheight, maxheight } — the sim reads these
                // as overrides for the SMF header's baked-in height
                // range (see SMFReadMap::LoadHeightMap). We have to
                // mirror that here or the client-side terrain is
                // rendered at a different scale from the sim, and
                // units spawn above or below the visible ground.
                lua_getfield(L, -1, "smf");
                if (lua_istable(L, -1)) {
                    // mapinfo.lua files use lowerkeys() so lowercase is
                    // canonical; fall back to camelCase just in case.
                    auto hasKey = [&](const char* k) {
                        lua_getfield(L, -1, k);
                        const bool present = !lua_isnil(L, -1);
                        lua_pop(L, 1);
                        return present;
                    };
                    const bool hasMin = hasKey("minheight") || hasKey("minHeight");
                    const bool hasMax = hasKey("maxheight") || hasKey("maxHeight");
                    if (hasMin || hasMax) {
                        meta.mapInfoHeightOverride = true;
                        // If only one of the two is set we keep the
                        // other at 0 until ReadSMFHeader fills it in
                        // from the SMF header (unusual but possible).
                        if (hasMin) {
                            float v = luaGetFloat(L, "minheight", 0);
                            if (v == 0) v = luaGetFloat(L, "minHeight", 0);
                            meta.minHeight = v;
                        }
                        if (hasMax) {
                            float v = luaGetFloat(L, "maxheight", 0);
                            if (v == 0) v = luaGetFloat(L, "maxHeight", 0);
                            meta.maxHeight = v;
                        }
                    }
                }
                lua_pop(L, 1); // pop smf

                // sound = { preset = "...", passfilter = {...}, reverb = {...} }
                // Only the preset name flows to the client today — the
                // detailed reverb / passfilter knobs are OpenAL EFX
                // specific and we don't have a 1:1 Web Audio mapping.
                // The plumbing for `Spring.SetSoundEffectParams(table)`
                // is in place on the client; map authors who need fine
                // control can call that from a gadget instead.
                lua_getfield(L, -1, "sound");
                if (lua_istable(L, -1)) {
                    std::string preset = luaGetString(L, "preset");
                    if (preset.empty()) preset = luaGetString(L, "Preset");
                    meta.soundPreset = preset;
                }
                lua_pop(L, 1); // pop sound

                // Read start positions: teams = { [0] = {startPos = {x=..., z=...}}, ... }
                lua_getfield(L, -1, "teams");
                if (lua_istable(L, -1)) {
                    lua_pushnil(L);
                    while (lua_next(L, -2) != 0) {
                        int teamIdx = -1;
                        if (lua_isinteger(L, -2)) teamIdx = static_cast<int>(lua_tointeger(L, -2));
                        else if (lua_isnumber(L, -2)) teamIdx = static_cast<int>(lua_tonumber(L, -2));

                        if (teamIdx >= 0 && lua_istable(L, -1)) {
                            // Try both "startPos" (original) and "startpos" (lowercased by Spring)
                            lua_getfield(L, -1, "startPos");
                            if (lua_isnil(L, -1)) { lua_pop(L, 1); lua_getfield(L, -1, "startpos"); }
                            if (lua_istable(L, -1)) {
                                MapStartPosition sp;
                                sp.x = luaGetFloat(L, "x", 0);
                                sp.z = luaGetFloat(L, "z", 0);
                                if (teamIdx >= static_cast<int>(meta.startPositions.size()))
                                    meta.startPositions.resize(teamIdx + 1);
                                meta.startPositions[teamIdx] = sp;
                            }
                            lua_pop(L, 1); // pop startPos
                        }
                        lua_pop(L, 1); // pop value, keep key
                    }
                }
                lua_pop(L, 1); // pop teams

                SLOG(SPRING_LOG_INFO, "mapinfo.lua: name='%s' author='%s' %zu start positions",
                    meta.name.c_str(), meta.author.c_str(), meta.startPositions.size());
            } else {
                SLOG(SPRING_LOG_WARNING, "mapinfo.lua did not return a table");
            }
            lua_close(L);
            // Restore content roots
            CFileHandler::ClearContentRoots();
            for (const auto& r : savedRoots) CFileHandler::AddContentRoot(r.path, r.category);
        }
    }

    if (meta.name.empty()) meta.name = meta.id;
    return !meta.smfPath.empty();
}

// ============================================================
// SMF header reading
// ============================================================

bool MapProcessor::ReadSMFHeader(MapMetadata& meta) {
    std::ifstream f(meta.smfPath, std::ios::binary);
    if (!f.is_open()) return false;

    f.seekg(24); // skip magic(16) + version(4) + mapid(4)
    f.read(reinterpret_cast<char*>(&meta.mapx), 4);
    f.read(reinterpret_cast<char*>(&meta.mapy), 4);
    f.seekg(12, std::ios::cur); // squareSize, texelPerSquare, tilesize

    // If mapinfo.lua provided height overrides, keep them — we read
    // the SMF values into throwaway locals so the file cursor still
    // advances. Otherwise fill meta.min/maxHeight from the SMF.
    float smfMinHeight = 0.0f, smfMaxHeight = 0.0f;
    f.read(reinterpret_cast<char*>(&smfMinHeight), 4);
    f.read(reinterpret_cast<char*>(&smfMaxHeight), 4);
    if (!meta.mapInfoHeightOverride) {
        meta.minHeight = smfMinHeight;
        meta.maxHeight = smfMaxHeight;
    }

    meta.widthElmos = meta.mapx * SQUARE_SIZE;
    meta.heightElmos = meta.mapy * SQUARE_SIZE;
    meta.tilesX = meta.mapx / 4;
    meta.tilesZ = meta.mapy / 4;
    meta.numTiles = meta.tilesX * meta.tilesZ;
    return true;
}

// ============================================================
// Binary data extraction
// ============================================================

static bool extractRawBytes(const std::string& srcPath, int offset, int size, const std::string& dstPath) {
    std::ifstream in(srcPath, std::ios::binary);
    if (!in.is_open()) return false;
    in.seekg(offset);
    std::vector<char> buf(size);
    in.read(buf.data(), size);
    if (!in.good()) return false;
    std::ofstream out(dstPath, std::ios::binary);
    out.write(buf.data(), size);
    return out.good();
}


bool MapProcessor::ExtractBinaryData(const MapMetadata& meta) {
    std::ifstream smf(meta.smfPath, std::ios::binary);
    if (!smf.is_open()) return false;

    // Data pointers start at offset 52 in SMF header
    // (after magic[16] + version[4] + mapid[4] + mapx[4] + mapy[4] +
    //  squareSize[4] + texelPerSquare[4] + tilesize[4] + minHeight[4] + maxHeight[4])
    smf.seekg(52);
    int heightmapPtr, typeMapPtr, tilesPtr, minimapPtr, metalmapPtr, featurePtr;
    smf.read(reinterpret_cast<char*>(&heightmapPtr), 4);
    smf.read(reinterpret_cast<char*>(&typeMapPtr), 4);
    smf.read(reinterpret_cast<char*>(&tilesPtr), 4);
    smf.read(reinterpret_cast<char*>(&minimapPtr), 4);
    smf.read(reinterpret_cast<char*>(&metalmapPtr), 4);
    smf.read(reinterpret_cast<char*>(&featurePtr), 4);
    smf.close();

    int hmSize = (meta.mapx + 1) * (meta.mapy + 1) * 2;
    int halfSize = (meta.mapx / 2) * (meta.mapy / 2);

    SLOG(SPRING_LOG_INFO, "extracting: mapx=%d mapy=%d hmPtr=%d hmSize=%d",
        meta.mapx, meta.mapy, heightmapPtr, hmSize);

    bool ok = true;
    if (!extractRawBytes(meta.smfPath, heightmapPtr, hmSize, meta.processedDir + "/heightmap.bin"))
        SLOG(SPRING_LOG_ERROR, "heightmap extraction failed");
    // Note: the raw 1024² DXT1 minimap is no longer extracted to disk —
    // ExtractMinimapWebP() decodes it straight to a WebP thumbnail for
    // the lobby preview. Nothing in the client ever consumed minimap.dxt1.
    if (!extractRawBytes(meta.smfPath, typeMapPtr, halfSize, meta.processedDir + "/typemap.bin"))
        SLOG(SPRING_LOG_ERROR, "typemap extraction failed");
    if (!extractRawBytes(meta.smfPath, metalmapPtr, halfSize, meta.processedDir + "/metalmap.bin"))
        SLOG(SPRING_LOG_ERROR, "metalmap extraction failed");
    ok = true; // individual failures logged above

    // Tile index
    {
        std::ifstream sf(meta.smfPath, std::ios::binary);
        sf.seekg(tilesPtr);
        int numTileFiles, totalTiles;
        sf.read(reinterpret_cast<char*>(&numTileFiles), 4);
        sf.read(reinterpret_cast<char*>(&totalTiles), 4);
        for (int i = 0; i < numTileFiles; i++) {
            int n; sf.read(reinterpret_cast<char*>(&n), 4);
            char c; do { sf.read(&c, 1); } while (c != 0);
        }
        int indexSize = meta.tilesX * meta.tilesZ * 4;
        std::vector<char> idx(indexSize);
        sf.read(idx.data(), indexSize);
        std::ofstream out(meta.processedDir + "/tileindex.bin", std::ios::binary);
        out.write(idx.data(), indexSize);
        ok &= out.good();
    }

    // Tile mip chain data from SMT — each tile carries 4 independently
    // precomputed mip levels (32/16/8/4 texels), which avoids the
    // atlas-bleeding that would result from downsampling the whole strip
    // as one image (adjacent, unrelated tiles would blend at low mips).
    // Per level, tiles are concatenated into a `(levelTexels *
    // smtNumTiles) x levelTexels` strip; levels are concatenated in
    // level order (mip0 first) and wrapped as a single multi-level KTX2
    // (BC1_RGB, no transcode) via textureconverter --raw-dxt1
    // --mip-levels. WebGL2 cannot runtime-generate mipmaps for a
    // compressed-format texture (gl.generateMipmap() only supports
    // uncompressed formats), so the full chain must ship pre-baked.
    if (!meta.smtPath.empty()) {
        std::ifstream smt(meta.smtPath, std::ios::binary);
        smt.seekg(16); // skip magic
        int smtVersion, smtNumTiles;
        smt.read(reinterpret_cast<char*>(&smtVersion), 4);
        smt.read(reinterpret_cast<char*>(&smtNumTiles), 4);
        smt.seekg(32); // tile data starts after 32-byte header

        // Read tile-major (as stored in the SMT) into per-level buffers,
        // then write level-major (as textureconverter's --mip-levels
        // input expects: level 0 for all tiles, then level 1, ...).
        std::vector<std::vector<char>> levelBuf(TILE_NUM_MIPS);
        for (int lvl = 0; lvl < TILE_NUM_MIPS; lvl++)
            levelBuf[lvl].resize((size_t)TILE_MIP_SIZE[lvl] * smtNumTiles);

        std::vector<char> tileBuf(SMALL_TILE_SIZE);
        for (int i = 0; i < smtNumTiles; i++) {
            smt.read(tileBuf.data(), SMALL_TILE_SIZE);
            int off = 0;
            for (int lvl = 0; lvl < TILE_NUM_MIPS; lvl++) {
                std::memcpy(levelBuf[lvl].data() + (size_t)i * TILE_MIP_SIZE[lvl],
                    tileBuf.data() + off, TILE_MIP_SIZE[lvl]);
                off += TILE_MIP_SIZE[lvl];
            }
        }

        const std::string rawPath = meta.processedDir + "/tiles.raw";
        std::ofstream out(rawPath, std::ios::binary);
        for (int lvl = 0; lvl < TILE_NUM_MIPS; lvl++)
            out.write(levelBuf[lvl].data(), levelBuf[lvl].size());
        ok &= out.good();
        out.close();

        // The KTX2 holds one logical 32-row-tall level-0 image; width is
        // `32 * smtNumTiles`. Both dims are multiples of 4 by
        // construction (down to the 4x4 mip3) so no padding is needed.
        const int ktxW = 32 * smtNumTiles;
        const int ktxH = 32;
        const std::string ktxPath = meta.processedDir + "/tiles.ktx2";
        char dimsBuf[32];
        snprintf(dimsBuf, sizeof(dimsBuf), "%dx%d", ktxW, ktxH);
        // --no-zstd keeps every level as a flat DXT1 block stream so the
        // client can pull the raw blocks out of the KTX2 with a tiny
        // header parser (no Zstd dep in the browser). Atlas
        // compositing still happens client-side via compressedTexSubImage2D.
        const std::string cmd =
            std::string("\"") + TEXTURECONVERTER_BINARY_PATH + "\""
            " --raw-dxt1 " + dimsBuf
            + " --mip-levels " + std::to_string(TILE_NUM_MIPS)
            + " --no-zstd"
            + " \"" + rawPath + "\""
            + " \"" + ktxPath + "\" 2>&1";
        FILE* p = popen(cmd.c_str(), "r");
        if (!p) {
            SLOG(SPRING_LOG_ERROR, "tiles: popen(textureconverter) failed");
            ok = false;
        } else {
            char readBuf[256];
            std::string out2;
            while (fgets(readBuf, sizeof(readBuf), p)) out2 += readBuf;
            const int rc = pclose(p);
            if (rc != 0) {
                SLOG(SPRING_LOG_ERROR,
                    "tiles: textureconverter --raw-dxt1 failed (rc=%d): %s",
                    rc, out2.c_str());
                ok = false;
            }
        }
        // Drop the temporary raw block stream — the KTX2 supersedes it.
        std::error_code rmEc;
        std::filesystem::remove(rawPath, rmEc);

        SLOG(SPRING_LOG_INFO, "extracted %d tiles (%d mip levels) as %s",
            smtNumTiles, TILE_NUM_MIPS, ktxPath.c_str());
    }

    return ok;
}

// ============================================================
// Minimap extraction via textureconverter
// ============================================================

bool MapProcessor::ExtractMinimapWebP(const MapMetadata& meta) {
    // textureconverter --smf-minimap pulls the 1024x1024 DXT1 minimap
    // out of the SMF and wraps it as a KTX2 (BC1_RGB, no transcode).
    // The lobby UI preview thumbnail is no longer produced here —
    // browsers can't render KTX2 in <img>, so the lobby falls back to
    // the engine's existing *minimap.png/jpg the map author shipped,
    // or to no thumbnail at all. (Adding libwebp for a 30% smaller
    // thumbnail is left as a follow-up.)
    const std::string fullPath = meta.processedDir + "/minimap.ktx2";
    const std::string cmd =
        std::string("\"") + TEXTURECONVERTER_BINARY_PATH + "\""
        " --smf-minimap"
        " \"" + meta.smfPath + "\""
        " \"" + fullPath + "\" 2>&1";
    FILE* p = popen(cmd.c_str(), "r");
    if (!p) {
        SLOG(SPRING_LOG_ERROR, "minimap: popen(textureconverter) failed");
        return false;
    }
    char buf[256];
    std::string out;
    while (fgets(buf, sizeof(buf), p)) out += buf;
    const int rc = pclose(p);
    if (rc != 0) {
        SLOG(SPRING_LOG_ERROR, "minimap: textureconverter failed (rc=%d): %s",
            rc, out.c_str());
        return false;
    }
    SLOG(SPRING_LOG_INFO, "extracted minimap as KTX2: %s", fullPath.c_str());
    return true;
}

// ============================================================
// Decal texture extraction (splat system)
//
// Copies or converts source textures referenced by mapinfo.lua into
// the processed directory with stable filenames. DDS files are copied
// as-is (GPU-compressed, served directly to the client for WebGL
// compressed texture loading). TGA/BMP files are converted to PNG via
// textureconverter.
// ============================================================

/// Resolve a texture reference from mapinfo.lua to an on-disk path.
/// Spring looks in the map's "maps/" subdirectory first, then relative to mapinfo.
/// Falls back to extension-insensitive matching (mapinfo often references .tga
/// when the file is actually .png, or similar).
static std::string resolveTexturePath(const std::string& mapDir, const std::string& ref) {
    if (ref.empty()) return {};

    // Candidate directories to search
    std::vector<fs::path> candidates;
    candidates.push_back(fs::path(mapDir) / ref);
    candidates.push_back(fs::path(mapDir) / "maps" / ref);
    if (ref.rfind("maps/", 0) == 0)
        candidates.push_back(fs::path(mapDir) / ref.substr(5));

    for (const auto& p : candidates) {
        if (fs::exists(p)) return p.string();
    }

    // Extension fallback: try same basename with .png/.tga/.dds/.bmp/.jpg
    static const char* EXTS[] = {".png", ".tga", ".dds", ".bmp", ".jpg", ".jpeg"};
    for (const auto& p : candidates) {
        fs::path stem = p;
        stem.replace_extension();
        for (const char* ext : EXTS) {
            fs::path tryP = stem;
            tryP += ext;
            if (fs::exists(tryP)) return tryP.string();
        }
    }
    return {};
}

/// Pull `textureconverter --signed-dc-report`'s one machine-readable line out
/// of its captured output. Fills `topMean[3]` (the smallest mip level's
/// per-channel mean — the constant that survives every viewing distance) and
/// `baseMean[3]` (level 0 — what the map author actually authored). Returns
/// false if the tool did not emit the line, which is the normal case for DDS
/// sources: those are wrapped block-for-block, never decoded, so there is
/// nothing to measure.
static bool ParseSignedDcReport(const std::string& out,
                                double baseMean[3], double topMean[3]) {
    const size_t at = out.find("signed-dc:");
    if (at == std::string::npos) return false;
    int levels = 0, tw = 0, th = 0;
    const int n = std::sscanf(out.c_str() + at,
        "signed-dc: levels=%d base=%lf,%lf,%lf top=%dx%d:%lf,%lf,%lf",
        &levels, &baseMean[0], &baseMean[1], &baseMean[2], &tw, &th,
        &topMean[0], &topMean[1], &topMean[2]);
    return n == 9;
}

bool MapProcessor::ExtractDecalTextures(MapMetadata& meta) {
    // Filled by the `detailTex` conversion below and judged after every
    // field is resolved, because whether a non-neutral DC matters at all
    // depends on which detail branch the map ends up selecting.
    bool haveDetailDc = false;
    double detailBaseMean[3] = {0, 0, 0};
    double detailTopMean[3] = {0, 0, 0};

    // For each decal texture: resolve the source, then run textureconverter
    // to produce a `.ktx2` with a stable output name. textureconverter
    // auto-routes DDS-as-blocks vs RGBA-encode internally; we just hand it
    // the source path and the desired output.
    auto convertField = [&](std::string& field, const char* baseName) {
        if (field.empty()) return;
        std::string src = resolveTexturePath(meta.sourcePath, field);
        if (src.empty()) {
            // Declared means the mapper intended it; failing to resolve it is a
            // content bug, and at DEBUG the whole pipeline reads as wired from
            // the logs (PLAN-terrain-detailtex.md §1) — that is how the dead
            // `detailTex` path stayed invisible.
            SLOG(SPRING_LOG_WARNING, "decal '%s' declared but unresolvable: %s",
                baseName, field.c_str());
            field.clear();
            return;
        }

        std::string dstName = std::string(baseName) + ".ktx2";
        std::string dstPath = meta.processedDir + "/" + dstName;

        // --mipmaps: Recoil's near-field detail is signed (tex*2-1), so it
        // self-fades to nothing as the mip chain averages it towards mid-grey.
        // That chain IS the distance falloff — there is no fade uniform in
        // SMFFragProg — so a level-1 decal KTX2 aliases at full strength all
        // the way to the horizon. DDS sources keep whatever chain they ship
        // (the flag only reaches the RGBA8 encode path).
        // --signed-dc-report is only asked of `detailTex`: it is the one
        // decal the shader adds unmodulated (`baseColor += tex*2-1`, no
        // distribution map in front of it), so its mean is a flat tint on
        // the whole map. See DetailTexDc.h.
        const bool wantDc = (std::strcmp(baseName, "detail") == 0);

        std::string cmd = std::string("\"") + TEXTURECONVERTER_BINARY_PATH + "\""
            " --encoding uastc --mipmaps"
            + (wantDc ? " --signed-dc-report" : "") +
            " \"" + src + "\" \"" + dstPath + "\" 2>&1";
        FILE* p = popen(cmd.c_str(), "r");
        if (!p) { field.clear(); return; }
        char buf[256];
        std::string out;
        while (fgets(buf, sizeof(buf), p)) out += buf;
        int rc = pclose(p);
        if (rc != 0) {
            SLOG(SPRING_LOG_WARNING, "textureconverter failed (%d): %s  %s",
                rc, src.c_str(), out.c_str());
            field.clear();
            return;
        }
        if (wantDc)
            haveDetailDc = ParseSignedDcReport(out, detailBaseMean, detailTopMean);
        field = dstName;
    };

    convertField(meta.decals.detailTex,       "detail");
    convertField(meta.decals.specularTex,     "specular");
    convertField(meta.decals.splatDetailTex,  "splat_detail");
    convertField(meta.decals.splatDistrTex,   "splat_distr");
    convertField(meta.decals.detailNormalTex, "detail_normal");
    convertField(meta.decals.splatDetailNormalTex[0], "splat_normal_0");
    convertField(meta.decals.splatDetailNormalTex[1], "splat_normal_1");
    convertField(meta.decals.splatDetailNormalTex[2], "splat_normal_2");
    convertField(meta.decals.splatDetailNormalTex[3], "splat_normal_3");

    // DC-neutrality of the plain `detailTex`, judged only when that branch is
    // the one the client will actually take. `attachTerrainDetailFromDecals`
    // (client/src/core/terrain.ts) reproduces SMFFragProg's `#ifdef` nesting:
    // splat *normals* wrap the whole detail section and suppress
    // GetDetailTextureColor entirely, and inside it the splat pair wins over
    // the plain branch. A tint warning about a texture the shader never
    // samples is noise, so mirror the precedence here.
    const bool hasSplatNormals =
        !meta.decals.splatDistrTex.empty() &&
        (!meta.decals.splatDetailNormalTex[0].empty() ||
         !meta.decals.splatDetailNormalTex[1].empty() ||
         !meta.decals.splatDetailNormalTex[2].empty() ||
         !meta.decals.splatDetailNormalTex[3].empty());
    const bool hasSplatPair =
        !meta.decals.splatDetailTex.empty() && !meta.decals.splatDistrTex.empty();
    const bool plainDetailIsLive =
        !meta.decals.detailTex.empty() && !hasSplatNormals && !hasSplatPair;

    if (haveDetailDc && plainDetailIsLive) {
        static const char* CHAN[3] = {"R", "G", "B"};
        for (int c = 0; c < 3; ++c) {
            if (detailtex::IsDcNeutral(detailTopMean[c])) continue;
            const double levels =
                detailtex::DcInLevels(detailtex::SignedDcFromMean(detailTopMean[c]));
            SLOG(SPRING_LOG_WARNING,
                "%s: detailTex %s mean is %.2f (authored %.2f), not the neutral "
                "%.1f — the shader adds it as tex*2-1 with no fade, so this is a "
                "permanent %+.1f-level tint on the whole map at every distance. "
                "Re-author the texture so its mean lands on %.1f.",
                meta.id.c_str(), CHAN[c], detailTopMean[c], detailBaseMean[c],
                detailtex::kNeutralMean, levels, detailtex::kNeutralMean);
        }
    }

    int found = 0;
    if (!meta.decals.detailTex.empty())         found++;
    if (!meta.decals.specularTex.empty())       found++;
    if (!meta.decals.splatDetailTex.empty())    found++;
    if (!meta.decals.splatDistrTex.empty())     found++;
    if (!meta.decals.detailNormalTex.empty())   found++;
    for (int i = 0; i < 4; i++)
        if (!meta.decals.splatDetailNormalTex[i].empty()) found++;
    SLOG(SPRING_LOG_INFO, "extracted %d decal textures", found);
    return true;
}

// ============================================================
// Feature extraction
// ============================================================

bool MapProcessor::ExtractFeatures(MapMetadata& meta) {
    std::ifstream smf(meta.smfPath, std::ios::binary);
    if (!smf.is_open()) return false;

    smf.seekg(72); // featurePtr is at offset 72 in SMF header
    int featurePtr;
    smf.read(reinterpret_cast<char*>(&featurePtr), 4);
    smf.seekg(featurePtr);

    int numFeatureTypes, numFeatures;
    smf.read(reinterpret_cast<char*>(&numFeatureTypes), 4);
    smf.read(reinterpret_cast<char*>(&numFeatures), 4);

    meta.featureTypes.clear();
    for (int i = 0; i < numFeatureTypes; i++) {
        std::string name;
        char c;
        while (smf.read(&c, 1) && c != 0) name += c;
        meta.featureTypes.push_back(name);
    }

    meta.features.clear();
    meta.features.reserve(numFeatures);
    for (int i = 0; i < numFeatures; i++) {
        MapFeatureData feat;
        smf.read(reinterpret_cast<char*>(&feat.featureType), 4);
        smf.read(reinterpret_cast<char*>(&feat.x), 4);
        smf.read(reinterpret_cast<char*>(&feat.y), 4);
        smf.read(reinterpret_cast<char*>(&feat.z), 4);
        smf.read(reinterpret_cast<char*>(&feat.rotation), 4);
        smf.read(reinterpret_cast<char*>(&feat.relativeSize), 4);
        meta.features.push_back(feat);
    }

    SLOG(SPRING_LOG_INFO, "extracted %d features (%d types)",
        numFeatures, numFeatureTypes);
    return true;
}

// ============================================================
// Region graph — mapdata/regions.lua → regions.json (engine ask R1,
// PLAN-metalstorm-regions.md §5/§8/§9 task 5)
// ============================================================
//
// Trivial Lua→JSON re-serialisation of the map-authored region graph, or a
// grid-fallback descriptor when the map has no graph (or it fails
// validation — E2, loud log + fallback). Written as a static sibling of
// heightmap.bin etc.; the client mirror (ui/lib/regions.js) fetches it once
// and builds the same lookup grid the sim uses internally.
//
// COORDINATE-FRAME CAVEAT (legacy maps): ExtractRegions runs BEFORE the
// legacyCoordSystem Z-reflection in ProcessMap (which flips only start
// positions and features, LH→RH), and region polygons are NOT reflected. On a
// map with `legacyCoordSystem = true`, mapdata/regions.lua polygon vertices
// must therefore be authored in the engine's RH frame (visual north = low Z),
// even though sibling legacy files (mapinfo.lua, featureplacer/*) are LH. The
// sim reads the same regions.lua directly, so both sides agree — but a legacy
// author porting a map must hand-convert region Z. (Matters for the Meridian
// Basin generator; native RH maps are unaffected.)
void MapProcessor::ExtractRegions(const MapMetadata& meta) {
    const float mapWidth = static_cast<float>(meta.widthElmos);
    const float mapHeight = static_cast<float>(meta.heightElmos);

    std::vector<RegionRecord> regions;
    bool haveGraph = false;

    const fs::path regionsLuaPath = fs::path(meta.sourcePath) / "mapdata" / "regions.lua";
    if (fs::exists(regionsLuaPath)) {
        auto savedRoots = CFileHandler::GetCategorizedRoots();
        CFileHandler::AddContentRoot(meta.sourcePath, RootCategory::Map);

        lua_State* L = luaL_newstate();
        luaL_openlibs(L);
        luaL_dostring(L,
            "unpack = unpack or table.unpack\n"
            "loadstring = loadstring or load\n"
            "if not setfenv then\n"
            "  setfenv = function(f, t) return f end\n"
            "  getfenv = function(f) return _G end\n"
            "end\n"
        );
        LuaVFSSimple::Register(L);

        if (luaL_dofile(L, regionsLuaPath.string().c_str()) != LUA_OK) {
            SLOG(SPRING_LOG_ERROR, "%s: mapdata/regions.lua error: %s",
                meta.id.c_str(), lua_tostring(L, -1));
            lua_pop(L, 1);
        } else if (lua_istable(L, -1)) {
            lua_getfield(L, -1, "regions");
            if (lua_istable(L, -1)) {
                const int n = static_cast<int>(lua_rawlen(L, -1));
                for (int i = 1; i <= n; i++) {
                    lua_rawgeti(L, -1, i);
                    if (lua_istable(L, -1)) {
                        RegionRecord r;
                        r.key = luaGetString(L, "key");
                        r.name = luaGetString(L, "name");
                        r.value = luaGetFloat(L, "value", 0);

                        lua_getfield(L, -1, "polygon");
                        if (lua_istable(L, -1)) {
                            const int pn = static_cast<int>(lua_rawlen(L, -1));
                            for (int p = 1; p <= pn; p++) {
                                lua_rawgeti(L, -1, p);
                                if (lua_istable(L, -1)) {
                                    RegionPoint pt;
                                    pt.x = luaGetFloat(L, "x", 0);
                                    pt.z = luaGetFloat(L, "z", 0);
                                    r.polygon.push_back(pt);
                                }
                                lua_pop(L, 1);
                            }
                        }
                        lua_pop(L, 1); // polygon

                        lua_getfield(L, -1, "tags");
                        if (lua_istable(L, -1)) {
                            const int tn = static_cast<int>(lua_rawlen(L, -1));
                            for (int t = 1; t <= tn; t++) {
                                lua_rawgeti(L, -1, t);
                                if (lua_isstring(L, -1)) r.tags.push_back(lua_tostring(L, -1));
                                lua_pop(L, 1);
                            }
                        }
                        lua_pop(L, 1); // tags

                        lua_getfield(L, -1, "neighbors");
                        if (lua_istable(L, -1)) {
                            const int nn = static_cast<int>(lua_rawlen(L, -1));
                            for (int nb = 1; nb <= nn; nb++) {
                                lua_rawgeti(L, -1, nb);
                                if (lua_isstring(L, -1)) r.neighbors.push_back(lua_tostring(L, -1));
                                lua_pop(L, 1);
                            }
                        }
                        lua_pop(L, 1); // neighbors

                        regions.push_back(std::move(r));
                    }
                    lua_pop(L, 1); // region entry
                }
                haveGraph = !regions.empty();
            }
            lua_pop(L, 1); // regions field
        }
        lua_close(L);

        CFileHandler::ClearContentRoots();
        for (const auto& r0 : savedRoots) CFileHandler::AddContentRoot(r0.path, r0.category);
    }

    std::string provider = "grid";

    if (haveGraph) {
        // Validate — mirrors regions/partition.lua's validateGraph exactly.
        std::unordered_map<std::string, const RegionRecord*> byKey;
        for (const auto& r : regions) byKey[r.key] = &r;

        std::unordered_map<std::string, int> seen;
        std::vector<std::string> errors;
        for (const auto& r : regions) {
            if (r.key.empty()) {
                errors.push_back("region with empty/missing key");
            } else if (r.key == "wilds") {
                // "wilds" is the synthetic catch-all region; an authored region
                // may not claim it (mirrors regions/partition.lua validateGraph).
                errors.push_back("region uses reserved key 'wilds'");
            } else if (seen[r.key]++ > 0) {
                errors.push_back("duplicate key: " + r.key);
            }

            for (const auto& pt : r.polygon) {
                if (pt.x < 0 || pt.x > mapWidth || pt.z < 0 || pt.z > mapHeight) {
                    errors.push_back(r.key + ": vertex out of map bounds");
                    break;
                }
            }
            if (RegionIsSelfIntersecting(r.polygon)) {
                errors.push_back(r.key + ": self-intersecting polygon");
            }
            for (const auto& nb : r.neighbors) {
                auto it = byKey.find(nb);
                if (it == byKey.end()) {
                    errors.push_back(r.key + ": neighbor '" + nb + "' does not exist");
                } else {
                    bool found = false;
                    for (const auto& back : it->second->neighbors) {
                        if (back == r.key) { found = true; break; }
                    }
                    if (!found) errors.push_back(r.key + ": asymmetric neighbor '" + nb + "'");
                }
            }
        }

        if (errors.empty()) {
            provider = "graph";
        } else {
            SLOG(SPRING_LOG_WARNING, "%s: mapdata/regions.lua failed validation, falling back to grid:", meta.id.c_str());
            for (const auto& e : errors) SLOG(SPRING_LOG_WARNING, "%s:   %s", meta.id.c_str(), e.c_str());
        }
    }

    nlohmann::json j;
    j["provider"] = provider;
    j["mapWidth"] = mapWidth;
    j["mapHeight"] = mapHeight;

    if (provider == "graph") {
        j["regions"] = nlohmann::json::array();
        for (const auto& r : regions) {
            nlohmann::json rj;
            rj["key"] = r.key;
            rj["name"] = r.name;
            rj["value"] = r.value;
            rj["tags"] = r.tags;
            rj["neighbors"] = r.neighbors;
            rj["polygon"] = nlohmann::json::array();
            for (const auto& pt : r.polygon) rj["polygon"].push_back({{"x", pt.x}, {"z", pt.z}});
            j["regions"].push_back(std::move(rj));
        }
        SLOG(SPRING_LOG_INFO, "%s: exported regions.json (graph, %zu regions)", meta.id.c_str(), regions.size());
    } else {
        const float regionSize = RegionGridSize(mapWidth, mapHeight);
        const int gridW = std::max(REGION_MIN_PER_AXIS, static_cast<int>(std::ceil(mapWidth / regionSize)));
        const int gridH = std::max(REGION_MIN_PER_AXIS, static_cast<int>(std::ceil(mapHeight / regionSize)));
        j["regionSize"] = regionSize;
        j["gridW"] = gridW;
        j["gridH"] = gridH;
        SLOG(SPRING_LOG_INFO, "%s: exported regions.json (grid %dx%d @ %.0f elmos)",
            meta.id.c_str(), gridW, gridH, regionSize);
    }

    std::ofstream out(meta.processedDir + "/regions.json");
    out << j.dump();
}

// Region graph validation (mapdata/regions.lua) — E1 slope-consistency
//
// PLAN-metalstorm-beta-map.md §4 E1: "generator/regions drift after
// hand-edits to the heightmap ... the validator + a new check (region
// polygon slope-consistency: a region tagged `corridor` must be passable
// for its intended class) run in the map-processing step — drift fails
// the build, not the playtest." Mirrors the Python self-check in
// tools/mapgen/meridian.py (selfcheck_slope_bands) so the generator and
// this validator agree on the rule.
//
// Validation-only: does not persist a regions.json/DB row. A separate,
// fuller region-control lane (commit 0838b8066b, "implement region
// control") already adds a more complete ExtractRegions with a static
// regions.json export + DB-side validation, but that commit is not an
// ancestor of this branch (not merged here yet) — this implementation is
// deliberately additive/small so the two can be reconciled later rather
// than colliding.
// ============================================================

namespace {

/// Standard even-odd ray-casting point-in-polygon test.
bool PointInPolygon(const std::vector<RegionPoint>& poly, float px, float pz) {
    bool inside = false;
    for (size_t i = 0, j = poly.size() - 1; i < poly.size(); j = i++) {
        const float xi = poly[i].x, zi = poly[i].z;
        const float xj = poly[j].x, zj = poly[j].z;
        if (((zi > pz) != (zj > pz)) &&
            (px < (xj - xi) * (pz - zi) / (zj - zi) + xi)) {
            inside = !inside;
        }
    }
    return inside;
}

// infantry_only/heavy_restricted are about DRY ridge terrain passability;
// corridor/choke ford decks are the opposite — deliberately shallow water
// over flat ground, so their check must NOT exclude wet samples (that
// would throw away the flat crossing itself and count only the steep dry
// banks). See tools/mapgen/meridian.py's TAGS_DRY_ONLY comment for the
// same rule on the generator side.
const char* ExpectedBandForTag(const std::string& tag, bool& dryOnly) {
    if (tag == "infantry_only") { dryOnly = true; return "infantry"; }
    if (tag == "heavy_restricted") { dryOnly = true; return "veh"; }
    if (tag == "corridor") { dryOnly = false; return "flat"; }
    if (tag == "choke") { dryOnly = false; return "flat"; }
    return nullptr;
}

const char* SlopeBandName(float deg) {
    if (deg <= 24.0f) return "flat";
    if (deg <= 32.0f) return "veh";
    if (deg <= 45.0f) return "infantry";
    return "cliff";
}

} // namespace

bool MapProcessor::ValidateRegions(MapMetadata& meta) {
    const std::string regionsPath = meta.sourcePath + "/mapdata/regions.lua";
    if (!fs::exists(regionsPath)) {
        SLOG(SPRING_LOG_DEBUG, "%s: no mapdata/regions.lua, skipping region validation",
            meta.id.c_str());
        return true;
    }

    lua_State* L = luaL_newstate();
    luaL_openlibs(L);
    if (luaL_dofile(L, regionsPath.c_str()) != LUA_OK) {
        SLOG(SPRING_LOG_ERROR, "%s: mapdata/regions.lua: lua error: %s",
            meta.id.c_str(), lua_tostring(L, -1));
        lua_close(L);
        return false;
    }
    if (!lua_istable(L, -1)) {
        SLOG(SPRING_LOG_ERROR, "%s: mapdata/regions.lua did not return a table",
            meta.id.c_str());
        lua_close(L);
        return false;
    }

    std::vector<RegionRecord> regions;
    lua_getfield(L, -1, "regions");
    if (lua_istable(L, -1)) {
        lua_pushnil(L);
        while (lua_next(L, -2) != 0) {
            // stack: ... regions regionKey regionTable
            if (lua_istable(L, -1)) {
                RegionRecord r;
                lua_getfield(L, -1, "key");
                if (lua_isstring(L, -1)) r.key = lua_tostring(L, -1);
                lua_pop(L, 1);
                lua_getfield(L, -1, "name");
                if (lua_isstring(L, -1)) r.name = lua_tostring(L, -1);
                lua_pop(L, 1);
                lua_getfield(L, -1, "value");
                if (lua_isnumber(L, -1)) r.value = static_cast<float>(lua_tonumber(L, -1));
                lua_pop(L, 1);

                lua_getfield(L, -1, "polygon");
                if (lua_istable(L, -1)) {
                    lua_pushnil(L);
                    while (lua_next(L, -2) != 0) {
                        if (lua_istable(L, -1)) {
                            RegionPoint p;
                            lua_getfield(L, -1, "x");
                            if (lua_isnumber(L, -1)) p.x = static_cast<float>(lua_tonumber(L, -1));
                            lua_pop(L, 1);
                            lua_getfield(L, -1, "z");
                            if (lua_isnumber(L, -1)) p.z = static_cast<float>(lua_tonumber(L, -1));
                            lua_pop(L, 1);
                            r.polygon.push_back(p);
                        }
                        lua_pop(L, 1);
                    }
                }
                lua_pop(L, 1); // pop polygon

                lua_getfield(L, -1, "tags");
                if (lua_istable(L, -1)) {
                    lua_pushnil(L);
                    while (lua_next(L, -2) != 0) {
                        if (lua_isstring(L, -1)) r.tags.push_back(lua_tostring(L, -1));
                        lua_pop(L, 1);
                    }
                }
                lua_pop(L, 1); // pop tags

                lua_getfield(L, -1, "neighbors");
                if (lua_istable(L, -1)) {
                    lua_pushnil(L);
                    while (lua_next(L, -2) != 0) {
                        if (lua_isstring(L, -1)) r.neighbors.push_back(lua_tostring(L, -1));
                        lua_pop(L, 1);
                    }
                }
                lua_pop(L, 1); // pop neighbors

                regions.push_back(std::move(r));
            }
            lua_pop(L, 1); // pop regionTable, keep regionKey for lua_next
        }
    }
    lua_pop(L, 1); // pop "regions" field
    lua_close(L);

    bool ok = true;

    // Basic graph validation: unique keys, in-bounds polygons, symmetric
    // neighbors, non-negative values.
    std::unordered_map<std::string, const RegionRecord*> byKey;
    for (const auto& r : regions) {
        if (r.key.empty()) {
            SLOG(SPRING_LOG_ERROR, "%s: regions.lua has a region with no key", meta.id.c_str());
            ok = false;
            continue;
        }
        if (byKey.count(r.key)) {
            SLOG(SPRING_LOG_ERROR, "%s: regions.lua: duplicate region key '%s'",
                meta.id.c_str(), r.key.c_str());
            ok = false;
        }
        byKey[r.key] = &r;
        if (r.value < 0.0f) {
            SLOG(SPRING_LOG_ERROR, "%s: region '%s' has negative value %.2f",
                meta.id.c_str(), r.key.c_str(), r.value);
            ok = false;
        }
        for (const auto& p : r.polygon) {
            if (p.x < 0.0f || p.x > static_cast<float>(meta.widthElmos) ||
                p.z < 0.0f || p.z > static_cast<float>(meta.heightElmos)) {
                SLOG(SPRING_LOG_ERROR,
                    "%s: region '%s' polygon vertex (%.0f,%.0f) outside map bounds [0,%d]x[0,%d]",
                    meta.id.c_str(), r.key.c_str(), p.x, p.z, meta.widthElmos, meta.heightElmos);
                ok = false;
            }
        }
    }
    for (const auto& r : regions) {
        for (const auto& n : r.neighbors) {
            auto it = byKey.find(n);
            if (it == byKey.end()) {
                SLOG(SPRING_LOG_ERROR, "%s: region '%s' neighbors unknown region '%s'",
                    meta.id.c_str(), r.key.c_str(), n.c_str());
                ok = false;
                continue;
            }
            const RegionRecord* other = it->second;
            bool reciprocated = std::find(other->neighbors.begin(), other->neighbors.end(), r.key)
                != other->neighbors.end();
            if (!reciprocated) {
                SLOG(SPRING_LOG_ERROR,
                    "%s: adjacency not symmetric: '%s' -> '%s' but not back",
                    meta.id.c_str(), r.key.c_str(), n.c_str());
                ok = false;
            }
        }
    }

    // E1: slope-consistency. Decode the heightmap ExtractBinaryData already
    // wrote to processedDir/heightmap.bin and sample each tagged region.
    const int hmW = meta.mapx + 1;
    const int hmH = meta.mapy + 1;
    std::vector<float> hm;
    {
        std::ifstream f(meta.processedDir + "/heightmap.bin", std::ios::binary);
        if (f.is_open()) {
            std::vector<uint16_t> raw(static_cast<size_t>(hmW) * hmH);
            f.read(reinterpret_cast<char*>(raw.data()), raw.size() * 2);
            hm.resize(raw.size());
            const float scale = (meta.maxHeight - meta.minHeight) / 65535.0f;
            for (size_t i = 0; i < raw.size(); i++)
                hm[i] = meta.minHeight + raw[i] * scale;
        }
    }

    auto slopeDegAt = [&](int vx, int vz) -> float {
        const int x0 = std::max(vx - 1, 0), x1 = std::min(vx + 1, hmW - 1);
        const int z0 = std::max(vz - 1, 0), z1 = std::min(vz + 1, hmH - 1);
        const float dhdx = (hm[vz * hmW + x1] - hm[vz * hmW + x0]) / static_cast<float>((x1 - x0) * SQUARE_SIZE ? (x1 - x0) * SQUARE_SIZE : 1);
        const float dhdz = (hm[z1 * hmW + vx] - hm[z0 * hmW + vx]) / static_cast<float>((z1 - z0) * SQUARE_SIZE ? (z1 - z0) * SQUARE_SIZE : 1);
        return std::atan(std::sqrt(dhdx * dhdx + dhdz * dhdz)) * 180.0f / static_cast<float>(M_PI);
    };

    int checkedCount = 0, okCount = 0;
    if (!hm.empty()) {
        for (const auto& r : regions) {
            const char* expected = nullptr;
            bool dryOnly = false;
            for (const auto& tag : r.tags) {
                expected = ExpectedBandForTag(tag, dryOnly);
                if (expected) break;
            }
            if (!expected || r.polygon.empty()) continue;

            float x0 = r.polygon[0].x, x1 = r.polygon[0].x;
            float z0 = r.polygon[0].z, z1 = r.polygon[0].z;
            for (const auto& p : r.polygon) {
                x0 = std::min(x0, p.x); x1 = std::max(x1, p.x);
                z0 = std::min(z0, p.z); z1 = std::max(z1, p.z);
            }

            std::unordered_map<std::string, int> counts;
            const float step = 64.0f;
            for (float z = z0 + step / 2; z < z1; z += step) {
                for (float x = x0 + step / 2; x < x1; x += step) {
                    if (!PointInPolygon(r.polygon, x, z)) continue;
                    const int vx = std::min(static_cast<int>(std::lround(x / SQUARE_SIZE)), hmW - 1);
                    const int vz = std::min(static_cast<int>(std::lround(z / SQUARE_SIZE)), hmH - 1);
                    const float h = hm[vz * hmW + vx];
                    const float waterDepth = std::max(0.0f, -h);
                    if (dryOnly && waterDepth > 0.0f) continue;
                    const std::string band = SlopeBandName(slopeDegAt(vx, vz));
                    counts[band]++;
                }
            }
            if (counts.empty()) continue;
            std::string dominant;
            int best = -1;
            for (const auto& [band, n] : counts) {
                if (n > best) { best = n; dominant = band; }
            }
            checkedCount++;
            const bool regionOk = dominant == expected;
            if (regionOk) okCount++;
            SLOG(regionOk ? SPRING_LOG_INFO : SPRING_LOG_ERROR,
                "%s: E1 region '%s': expected dominant band '%s', got '%s' (%s)",
                meta.id.c_str(), r.key.c_str(), expected, dominant.c_str(),
                regionOk ? "OK" : "MISMATCH — regenerate/hand-tune the heightmap");
            if (!regionOk) ok = false;
        }
    }

    SLOG(ok ? SPRING_LOG_NOTICE : SPRING_LOG_ERROR,
        "%s: regions.lua validated: %zu region(s), E1 slope-consistency %d/%d OK — %s",
        meta.id.c_str(), regions.size(), okCount, checkedCount, ok ? "PASS" : "FAIL");

    return ok;
}

// ============================================================
// Top-level
// ============================================================

bool MapProcessor::ProcessMap(MapMetadata& meta) {
    fs::create_directories(meta.processedDir);

    if (!ReadSMFHeader(meta)) {
        SLOG(SPRING_LOG_ERROR, "failed to read SMF header");
        return false;
    }

    if (!ExtractBinaryData(meta)) {
        SLOG(SPRING_LOG_ERROR, "failed to extract binary data");
        return false;
    }

    if (!ValidateRegions(meta)) {
        SLOG(SPRING_LOG_ERROR, "%s: region validation failed (E1) — aborting build",
            meta.id.c_str());
        return false;
    }

    ExtractFeatures(meta);             // SMF-embedded placements (binary)
    FeatureProcessor::Process(meta);   // Lua defs + featureplacer + asset conversion
    ExtractMinimapWebP(meta);          // 1024² thumbnail for the lobby browser
    ExtractDecalTextures(meta);
    EnumerateWidgets(meta);
    ExtractRegions(meta);              // mapdata/regions.lua → regions.json (R1)

    // RH content-preprocessing: legacy LH map source files (mapinfo.lua,
    // featureplacer/*.lua, SMF-embedded features) author position Z in
    // the visual-north-positive convention: low Z = top of the minimap.
    // The engine runs in glTF-native RH (camera looks down -Z) but
    // keeps world bounds positive-quadrant `[0, mapZ]` — so visual
    // "north" sits at low world Z, and a legacy author who placed a
    // spawn at `z = 2000` on a 4096-tall map meant the north half of
    // the map. Reflect through mapZ/2 (i.e. `z → mapZ - z`) so the
    // persisted MapMetadata record is RH-canonical regardless of
    // source convention — downstream consumers (lobby, sim, Lua bridge)
    // all see the same RH-frame positive-Z coordinates without any
    // per-call adapter for map content.
    //
    // Feature rotations (heading units) are NOT flipped: under both
    // conventions a given numeric heading names the same screen-top
    // direction (`heading = 0` originally meant +Z under LH and is now
    // -Z under RH, i.e. the visual "front" direction; a feature
    // authored with `rot = 16384` (90°) still faces +X / "east" in
    // either frame).
    if (meta.legacyCoordSystem) {
        const float mapZ = static_cast<float>(meta.mapy * SQUARE_SIZE);
        for (auto& sp : meta.startPositions)
            sp.z = mapZ - sp.z;
        for (auto& f : meta.features)
            f.z = mapZ - f.z;
        SLOG(SPRING_LOG_INFO,
            "%s: legacyCoordSystem=true — reflected Z through mapZ/2 on %zu start positions and %zu features (LH → RH)",
            meta.id.c_str(), meta.startPositions.size(), meta.features.size());
    }

    return true;
}

// Walk LuaUI/Widgets/ and collect all .lua filenames. These are shipped
// to the client in MapData; the client fetches each one from
// /api/maps/data/{id}/ and runs it through fengari.
void MapProcessor::EnumerateWidgets(MapMetadata& meta) {
    meta.widgets.clear();
    fs::path widgetsDir = fs::path(meta.sourcePath) / "LuaUI" / "Widgets";
    if (!fs::is_directory(widgetsDir)) return;
    for (auto& entry : fs::directory_iterator(widgetsDir)) {
        if (!entry.is_regular_file()) continue;
        if (entry.path().extension() != ".lua") continue;
        // Store as path relative to the map source dir so the client
        // can fetch it via `${mapSourceUrl}/${widget}`.
        std::string rel = "LuaUI/Widgets/" + entry.path().filename().string();
        meta.widgets.push_back(rel);
    }
    SLOG(SPRING_LOG_INFO, "%s: found %zu LuaUI widget(s)",
        meta.id.c_str(), meta.widgets.size());
}

// True when the regions.json export is up to date with its mapdata/regions.lua
// source. The general freshness gate (formatVersion + heightmap.bin) does not
// notice an edit to regions.lua — the sim reads regions.lua live each game
// start, so a stale export would silently desync client geometry from the sim.
// If the map has no regions.lua there is nothing to stale; if it has one but no
// export (or the source is newer than the export), reprocess.
static bool RegionsExportFresh(const std::string& sourcePath, const std::string& processedDir) {
    const fs::path src = fs::path(sourcePath) / "mapdata" / "regions.lua";
    if (!fs::exists(src)) return true;
    const fs::path out = fs::path(processedDir) / "regions.json";
    if (!fs::exists(out)) return false;
    std::error_code ec;
    const auto srcTime = fs::last_write_time(src, ec);
    if (ec) return true;   // can't stat source → don't force a reprocess loop
    const auto outTime = fs::last_write_time(out, ec);
    if (ec) return true;
    return outTime >= srcTime;
}

bool MapProcessor::ProcessedOutputCurrent(const std::string& srcDir, const std::string& stampPath) {
    std::error_code ec;
    const auto stampTime = fs::last_write_time(stampPath, ec);
    if (ec) return true;   // no stamp (legacy processed dir) → don't force
    auto it = fs::recursive_directory_iterator(
        srcDir, fs::directory_options::skip_permission_denied, ec);
    if (ec) return true;   // can't scan source → don't force a reprocess loop
    for (; it != fs::recursive_directory_iterator(); it.increment(ec)) {
        if (ec) break;
        if (!it->is_regular_file(ec)) continue;
        const auto t = fs::last_write_time(it->path(), ec);
        if (!ec && t > stampTime) return false;
    }
    return true;
}

/// (Re)write the end-of-processing stamp ProcessedOutputCurrent compares
/// against. Written strictly after every processed output file.
static void TouchProcessedStamp(const std::string& processedDir) {
    std::ofstream f(processedDir + "/.processed-stamp", std::ios::trunc);
    f << "ok\n";
}

void MapProcessor::ScanAndProcess(const std::string& mapsDir, const std::string& dataDir, sqlite3* db) {
    EnsureTable(db);
    if (!fs::is_directory(mapsDir)) {
        SLOG(SPRING_LOG_ERROR, "maps directory not found: %s", mapsDir.c_str());
        return;
    }

    for (auto& mapDir : fs::directory_iterator(mapsDir)) {
        if (!mapDir.is_directory()) continue;
        std::string mapId = mapDir.path().filename().string();

        MapMetadata existing = GetMap(db, mapId);
        std::string processedDir = dataDir + "/maps/" + mapId;
        bool filesExist = fs::exists(processedDir + "/heightmap.bin");
        bool regionsFresh = RegionsExportFresh(mapDir.path().string(), processedDir);
        bool sourceCurrent = !filesExist || ProcessedOutputCurrent(
            mapDir.path().string(), processedDir + "/.processed-stamp");

        if (existing.formatVersion >= MAP_FORMAT_VERSION && filesExist && regionsFresh && sourceCurrent) {
            SLOG(SPRING_LOG_DEBUG, "%s: up to date (v%d)", mapId.c_str(), existing.formatVersion);
            continue;
        }
        if (existing.formatVersion >= MAP_FORMAT_VERSION && filesExist) {
            SLOG(SPRING_LOG_INFO, "%s: %s — reprocessing", mapId.c_str(),
                 !sourceCurrent ? "source content changed"
                                : "mapdata/regions.lua changed");
        }

        MapMetadata meta;
        meta.id = mapId;
        meta.sourcePath = mapDir.path().string();
        meta.processedDir = dataDir + "/maps/" + mapId;
        meta.formatVersion = MAP_FORMAT_VERSION;

        if (!ReadMapInfo(mapDir.path().string(), meta)) {
            SLOG(SPRING_LOG_WARNING, "%s: no SMF file found, skipping", mapId.c_str());
            continue;
        }

        SLOG(SPRING_LOG_INFO, "processing %s \"%s\" (%dx%d)...",
            mapId.c_str(), meta.name.c_str(), meta.mapx, meta.mapy);

        if (ProcessMap(meta)) {
            StoreMetadata(db, meta);
            TouchProcessedStamp(meta.processedDir);
            SLOG(SPRING_LOG_INFO, "%s: done (%d features, %d start positions, luaGaia=%s)",
                mapId.c_str(), static_cast<int>(meta.features.size()),
                static_cast<int>(meta.startPositions.size()),
                meta.hasLuaGaia ? "yes" : "no");
        }
    }
}
