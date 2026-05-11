// MapProcessor — full map data extraction from SMF/SMT/mapinfo.lua.

#include "MapProcessor.h"
#include "FeatureProcessor.h"
#include "System/SpringLog/SpringLog.h"

// Lua compiled as C++
#include "lua.h"
#include "lualib.h"
#include "lauxlib.h"

#include "System/FileSystem/LuaVFSSimple.h"
#include "System/FileSystem/FileHandler.h"

#include <sqlite3.h>
#include <cstdio>
#include <cstring>
#include <filesystem>
#include <fstream>

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

    // Tile mip0 data from SMT — concatenated DXT1 blocks, then
    // wrapped as a single KTX2 (BC1_RGB, no transcode) via the
    // textureconverter --raw-dxt1 path. Each Spring tile is 32x32
    // texels = 64 DXT1 blocks = 512 bytes; concatenated they form
    // a (32 * smtNumTiles)x32 strip the client unpacks at load time.
    if (!meta.smtPath.empty()) {
        std::ifstream smt(meta.smtPath, std::ios::binary);
        smt.seekg(16); // skip magic
        int smtVersion, smtNumTiles;
        smt.read(reinterpret_cast<char*>(&smtVersion), 4);
        smt.read(reinterpret_cast<char*>(&smtNumTiles), 4);
        smt.seekg(32); // tile data starts after 32-byte header

        const std::string rawPath = meta.processedDir + "/tiles.raw";
        std::ofstream out(rawPath, std::ios::binary);
        std::vector<char> tileBuf(TILE_MIP0_SIZE);
        for (int i = 0; i < smtNumTiles; i++) {
            smt.read(tileBuf.data(), TILE_MIP0_SIZE);
            out.write(tileBuf.data(), TILE_MIP0_SIZE);
            smt.seekg(SMALL_TILE_SIZE - TILE_MIP0_SIZE, std::ios::cur);
        }
        ok &= out.good();
        out.close();

        // The KTX2 holds one logical 32-row-tall image; width is
        // `32 * smtNumTiles`. Both dims are multiples of 4 by
        // construction so no padding is needed.
        const int ktxW = 32 * smtNumTiles;
        const int ktxH = 32;
        const std::string ktxPath = meta.processedDir + "/tiles.ktx2";
        char dimsBuf[32];
        snprintf(dimsBuf, sizeof(dimsBuf), "%dx%d", ktxW, ktxH);
        // --no-zstd keeps level 0 as a flat DXT1 block stream so the
        // client can pull the raw blocks out of the KTX2 with a tiny
        // header parser (no Zstd dep in the browser). Atlas
        // compositing still happens client-side via compressedTexSubImage2D.
        const std::string cmd =
            std::string("\"") + TEXTURECONVERTER_BINARY_PATH + "\""
            " --raw-dxt1 " + dimsBuf
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

        SLOG(SPRING_LOG_INFO, "extracted %d tile mip0s as %s",
            smtNumTiles, ktxPath.c_str());
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

bool MapProcessor::ExtractDecalTextures(MapMetadata& meta) {
    // For each decal texture: resolve the source, then run textureconverter
    // to produce a `.ktx2` with a stable output name. textureconverter
    // auto-routes DDS-as-blocks vs RGBA-encode internally; we just hand it
    // the source path and the desired output.
    auto convertField = [&](std::string& field, const char* baseName) {
        if (field.empty()) return;
        std::string src = resolveTexturePath(meta.sourcePath, field);
        if (src.empty()) {
            SLOG(SPRING_LOG_DEBUG, "decal '%s' missing: %s", baseName, field.c_str());
            field.clear();
            return;
        }

        std::string dstName = std::string(baseName) + ".ktx2";
        std::string dstPath = meta.processedDir + "/" + dstName;

        std::string cmd = std::string("\"") + TEXTURECONVERTER_BINARY_PATH + "\""
            " --encoding uastc"
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

    ExtractFeatures(meta);             // SMF-embedded placements (binary)
    FeatureProcessor::Process(meta);   // Lua defs + featureplacer + asset conversion
    ExtractMinimapWebP(meta);          // 1024² thumbnail for the lobby browser
    ExtractDecalTextures(meta);
    EnumerateWidgets(meta);
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

        if (existing.formatVersion >= MAP_FORMAT_VERSION && filesExist) {
            SLOG(SPRING_LOG_DEBUG, "%s: up to date (v%d)", mapId.c_str(), existing.formatVersion);
            continue;
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
            SLOG(SPRING_LOG_INFO, "%s: done (%d features, %d start positions, luaGaia=%s)",
                mapId.c_str(), static_cast<int>(meta.features.size()),
                static_cast<int>(meta.startPositions.size()),
                meta.hasLuaGaia ? "yes" : "no");
        }
    }
}
