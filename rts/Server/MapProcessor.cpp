// MapProcessor — full map data extraction from SMF/SMT/mapinfo.lua.

#include "MapProcessor.h"
#include "FeatureProcessor.h"

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
#include <sstream>

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
        auto savedRoots = CFileHandler::GetContentRoots();
        CFileHandler::AddContentRoot(mapDir);

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
            std::fprintf(stderr, "[mapproc] lua error in %s: %s\n",
                mapInfoPath.c_str(), lua_tostring(L, -1));
            lua_close(L);
            // Restore content roots
            CFileHandler::ClearContentRoots();
            for (const auto& r : savedRoots) CFileHandler::AddContentRoot(r);
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

                std::fprintf(stderr, "[mapproc] mapinfo.lua: name='%s' author='%s' %zu start positions\n",
                    meta.name.c_str(), meta.author.c_str(), meta.startPositions.size());
            } else {
                std::fprintf(stderr, "[mapproc] mapinfo.lua did not return a table\n");
            }
            lua_close(L);
            // Restore content roots
            CFileHandler::ClearContentRoots();
            for (const auto& r : savedRoots) CFileHandler::AddContentRoot(r);
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
    f.read(reinterpret_cast<char*>(&meta.minHeight), 4);
    f.read(reinterpret_cast<char*>(&meta.maxHeight), 4);

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

    std::fprintf(stderr, "[mapproc] extracting: mapx=%d mapy=%d hmPtr=%d hmSize=%d\n",
        meta.mapx, meta.mapy, heightmapPtr, hmSize);

    bool ok = true;
    if (!extractRawBytes(meta.smfPath, heightmapPtr, hmSize, meta.processedDir + "/heightmap.bin"))
        std::fprintf(stderr, "[mapproc]   heightmap extraction failed\n");
    if (!extractRawBytes(meta.smfPath, minimapPtr, 524288, meta.processedDir + "/minimap.dxt1"))
        std::fprintf(stderr, "[mapproc]   minimap extraction failed\n");
    if (!extractRawBytes(meta.smfPath, typeMapPtr, halfSize, meta.processedDir + "/typemap.bin"))
        std::fprintf(stderr, "[mapproc]   typemap extraction failed\n");
    if (!extractRawBytes(meta.smfPath, metalmapPtr, halfSize, meta.processedDir + "/metalmap.bin"))
        std::fprintf(stderr, "[mapproc]   metalmap extraction failed\n");
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

    // Tile mip0 data from SMT
    if (!meta.smtPath.empty()) {
        std::ifstream smt(meta.smtPath, std::ios::binary);
        smt.seekg(16); // skip magic
        int smtVersion, smtNumTiles;
        smt.read(reinterpret_cast<char*>(&smtVersion), 4);
        smt.read(reinterpret_cast<char*>(&smtNumTiles), 4);
        smt.seekg(32); // tile data starts after 32-byte header

        std::ofstream out(meta.processedDir + "/tiles.dxt1", std::ios::binary);
        std::vector<char> tileBuf(TILE_MIP0_SIZE);
        for (int i = 0; i < smtNumTiles; i++) {
            smt.read(tileBuf.data(), TILE_MIP0_SIZE);
            out.write(tileBuf.data(), TILE_MIP0_SIZE);
            smt.seekg(SMALL_TILE_SIZE - TILE_MIP0_SIZE, std::ios::cur);
        }
        ok &= out.good();
        std::fprintf(stderr, "[mapproc] extracted %d tile mip0s (%d bytes each)\n",
            smtNumTiles, TILE_MIP0_SIZE);
    }

    return ok;
}

// ============================================================
// Decal texture extraction (splat system)
//
// Converts source textures (.tga/.dds/.bmp/.png) referenced by mapinfo.lua
// into PNG files in the processed directory with stable filenames:
//   detail.png, specular.png, splat_distr.png,
//   splat_detail.png, splat_normal_{0..3}.png, detail_normal.png
// The metadata fields are rewritten to these stable filenames so the game
// server and client don't need to know the original names/formats.
// ============================================================

/// Reason a decal texture couldn't be extracted. Used for quieter logging
/// of expected failures (missing optional assets, unsupported DDS variants).
enum class DecalFailReason { None, MissingFile, UnsupportedFormat, ConvertError };

/// Detect known-unsupported DDS variants so we can skip them quietly.
/// RXGB is a GIMP-DDS normal-map format (DXT5 with swizzled channels).
/// ImageMagick's DDS reader doesn't handle it.
static bool isUnsupportedDds(const std::string& path) {
    std::ifstream f(path, std::ios::binary);
    if (!f.is_open()) return false;
    char header[0x60];
    f.read(header, sizeof(header));
    if (f.gcount() < 0x58) return false;
    if (memcmp(header, "DDS ", 4) != 0) return false;
    // FourCC is at offset 0x54
    char fourcc[5] = {0};
    memcpy(fourcc, header + 0x54, 4);
    if (strcmp(fourcc, "RXGB") == 0) return true;   // swizzled DXT5 normal
    if (strcmp(fourcc, "ATI2") == 0) return true;   // BC5 normal
    if (strcmp(fourcc, "BC5U") == 0) return true;
    if (strcmp(fourcc, "BC4U") == 0) return true;
    return false;
}

static DecalFailReason shellEscapeAndConvert(const std::string& srcPath, const std::string& dstPath) {
    if (srcPath.empty()) return DecalFailReason::MissingFile;
    if (!fs::exists(srcPath)) return DecalFailReason::MissingFile;
    if (isUnsupportedDds(srcPath)) return DecalFailReason::UnsupportedFormat;

    // Use magick to convert to PNG. Quote both paths.
    std::string cmd = "magick \"" + srcPath + "\" \"" + dstPath + "\" 2>&1";
    FILE* p = popen(cmd.c_str(), "r");
    if (!p) return DecalFailReason::ConvertError;
    char buf[256];
    std::string out;
    while (fgets(buf, sizeof(buf), p)) out += buf;
    int rc = pclose(p);
    if (rc != 0) {
        std::fprintf(stderr, "[mapproc]   magick failed (%d): %s => %s\n  %s\n",
            rc, srcPath.c_str(), dstPath.c_str(), out.c_str());
        return DecalFailReason::ConvertError;
    }
    return DecalFailReason::None;
}

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
    auto convertField = [&](std::string& field, const char* dstName) {
        if (field.empty()) return;
        std::string src = resolveTexturePath(meta.sourcePath, field);
        if (src.empty()) {
            // Optional asset — quiet log, just mark it as unavailable
            std::fprintf(stderr, "[mapproc]   decal '%s' missing: %s\n", dstName, field.c_str());
            field.clear();
            return;
        }
        std::string dst = meta.processedDir + "/" + dstName;
        DecalFailReason r = shellEscapeAndConvert(src, dst);
        if (r == DecalFailReason::UnsupportedFormat) {
            std::fprintf(stderr, "[mapproc]   decal '%s' unsupported format (skipped): %s\n",
                dstName, field.c_str());
            field.clear();
            return;
        }
        if (r != DecalFailReason::None) {
            field.clear();
            return;
        }
        field = dstName;
    };

    convertField(meta.decals.detailTex,       "detail.png");
    convertField(meta.decals.specularTex,     "specular.png");
    convertField(meta.decals.splatDetailTex,  "splat_detail.png");
    convertField(meta.decals.splatDistrTex,   "splat_distr.png");
    convertField(meta.decals.detailNormalTex, "detail_normal.png");
    convertField(meta.decals.splatDetailNormalTex[0], "splat_normal_0.png");
    convertField(meta.decals.splatDetailNormalTex[1], "splat_normal_1.png");
    convertField(meta.decals.splatDetailNormalTex[2], "splat_normal_2.png");
    convertField(meta.decals.splatDetailNormalTex[3], "splat_normal_3.png");

    int found = 0;
    if (!meta.decals.detailTex.empty())         found++;
    if (!meta.decals.specularTex.empty())       found++;
    if (!meta.decals.splatDetailTex.empty())    found++;
    if (!meta.decals.splatDistrTex.empty())     found++;
    if (!meta.decals.detailNormalTex.empty())   found++;
    for (int i = 0; i < 4; i++)
        if (!meta.decals.splatDetailNormalTex[i].empty()) found++;
    std::fprintf(stderr, "[mapproc] extracted %d decal textures\n", found);
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

    std::fprintf(stderr, "[mapproc] extracted %d features (%d types)\n",
        numFeatures, numFeatureTypes);
    return true;
}

// ============================================================
// SQLite
// ============================================================

void MapProcessor::EnsureTable(sqlite3* db) {
    // Check whether the existing schema matches the current format version.
    // If it doesn't (missing columns from a schema bump), drop the table so
    // it gets recreated and all maps reprocessed. We detect "needs rebuild"
    // by querying for a column that was added in the latest schema.
    {
        sqlite3_stmt* stmt = nullptr;
        int rc = sqlite3_prepare_v2(db,
            "SELECT feature_defs FROM maps LIMIT 1", -1, &stmt, nullptr);
        sqlite3_finalize(stmt);
        if (rc != SQLITE_OK) {
            // Table missing or out-of-date schema — drop and recreate.
            // sqlite3_prepare_v2 also fails if the table simply doesn't exist
            // (that's fine — CREATE TABLE IF NOT EXISTS below handles both).
            sqlite3_exec(db, "DROP TABLE IF EXISTS maps", nullptr, nullptr, nullptr);
        }
    }
    sqlite3_exec(db, R"(
        CREATE TABLE IF NOT EXISTS maps (
            id TEXT PRIMARY KEY,
            name TEXT, short_name TEXT, description TEXT,
            author TEXT, version TEXT,
            mapx INTEGER, mapy INTEGER,
            width_elmos INTEGER, height_elmos INTEGER,
            min_height REAL, max_height REAL,
            gravity REAL, tidal_strength REAL,
            max_metal REAL, extractor_radius REAL,
            tiles_x INTEGER, tiles_z INTEGER, num_tiles INTEGER,
            has_lua_gaia INTEGER,
            num_features INTEGER, num_feature_types INTEGER,
            start_positions TEXT,
            format_version INTEGER,
            processed_dir TEXT, source_path TEXT,
            -- Decal/splat textures (stable filenames in processed_dir)
            detail_tex TEXT, specular_tex TEXT,
            splat_detail_tex TEXT, splat_distr_tex TEXT,
            splat_normal_0 TEXT, splat_normal_1 TEXT,
            splat_normal_2 TEXT, splat_normal_3 TEXT,
            detail_normal_tex TEXT,
            splat_scales TEXT, splat_mults TEXT,
            -- Features stored as pipe-delimited type list + semi-delimited instance list
            feature_types TEXT, features_blob TEXT,
            -- FeatureDef list, parallel to feature_types. Each record is
            --   name,model,texture,footX,footZ,height,radius,blocking,reclaim,metal,energy,damage
            -- with records pipe-separated.
            feature_defs TEXT,
            -- Water (Spring's water system, also used for lava/acid)
            water_base_color TEXT, water_surface_color TEXT, water_min_color TEXT,
            water_surface_alpha REAL, water_damage REAL, void_water INTEGER,
            -- Client-side Lua widgets shipped by the map (pipe-delimited paths)
            widgets TEXT
        );
    )", nullptr, nullptr, nullptr);
}

void MapProcessor::StoreMetadata(sqlite3* db, const MapMetadata& m) {
    std::string spStr;
    for (const auto& sp : m.startPositions) {
        if (!spStr.empty()) spStr += ";";
        spStr += std::to_string(sp.x) + "," + std::to_string(sp.z);
    }

    // Feature types: pipe-delimited ("tree|rock|...")
    std::string typesStr;
    for (const auto& t : m.featureTypes) {
        if (!typesStr.empty()) typesStr += "|";
        typesStr += t;
    }

    // Features: semi-colon-delimited records "type,x,y,z,rot,size"
    std::string featuresStr;
    featuresStr.reserve(m.features.size() * 32);
    for (const auto& f : m.features) {
        if (!featuresStr.empty()) featuresStr += ";";
        char buf[96];
        snprintf(buf, sizeof(buf), "%d,%.1f,%.1f,%.1f,%.3f,%.3f",
            f.featureType, f.x, f.y, f.z, f.rotation, f.relativeSize);
        featuresStr += buf;
    }

    // Feature defs: pipe-delimited records, one per featureType. Each
    // record is comma-separated:
    //   name,model,texture,footX,footZ,height,radius,blocking,reclaim,metal,energy,damage
    // Empty model/texture fields are written as empty (e.g. "GreyRock1,,,...").
    std::string defsStr;
    {
        for (const auto& d : m.featureDefs) {
            if (!defsStr.empty()) defsStr += "|";
            char buf[256];
            snprintf(buf, sizeof(buf),
                "%s,%s,%s,%d,%d,%.3f,%.3f,%d,%d,%d,%d,%d",
                d.name.c_str(), d.modelFile.c_str(), d.textureFile.c_str(),
                d.footprintX, d.footprintZ, d.height, d.radius,
                d.blocking ? 1 : 0, d.reclaimable ? 1 : 0,
                d.metal, d.energy, d.damage);
            defsStr += buf;
        }
    }

    // Splat params: comma-separated
    auto floatsToStr = [](const float* v, int n) {
        std::string s;
        for (int i = 0; i < n; i++) {
            if (i > 0) s += ",";
            char b[32]; snprintf(b, sizeof(b), "%.6f", v[i]);
            s += b;
        }
        return s;
    };
    std::string splatScalesStr  = floatsToStr(m.decals.splatScales, 4);
    std::string splatMultsStr   = floatsToStr(m.decals.splatMults,  4);
    std::string waterBaseStr    = floatsToStr(m.water.baseColor,    3);
    std::string waterSurfaceStr = floatsToStr(m.water.surfaceColor, 3);
    std::string waterMinStr     = floatsToStr(m.water.minColor,     3);

    // Widgets: pipe-delimited list of relative paths
    std::string widgetsStr;
    for (const auto& w : m.widgets) {
        if (!widgetsStr.empty()) widgetsStr += "|";
        widgetsStr += w;
    }

    sqlite3_stmt* stmt;
    sqlite3_prepare_v2(db, R"(
        INSERT OR REPLACE INTO maps
        (id,name,short_name,description,author,version,
         mapx,mapy,width_elmos,height_elmos,min_height,max_height,
         gravity,tidal_strength,max_metal,extractor_radius,
         tiles_x,tiles_z,num_tiles,has_lua_gaia,
         num_features,num_feature_types,start_positions,
         format_version,processed_dir,source_path,
         detail_tex,specular_tex,splat_detail_tex,splat_distr_tex,
         splat_normal_0,splat_normal_1,splat_normal_2,splat_normal_3,
         detail_normal_tex,splat_scales,splat_mults,
         feature_types,features_blob,feature_defs,
         water_base_color,water_surface_color,water_min_color,
         water_surface_alpha,water_damage,void_water,
         widgets)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,
                ?,?,?,?,?,?,?,?,?,?,?,?,?,?,
                ?,?,?,?,?,?,
                ?)
    )", -1, &stmt, nullptr);

    int i = 1;
    sqlite3_bind_text(stmt, i++, m.id.c_str(), -1, SQLITE_TRANSIENT);
    sqlite3_bind_text(stmt, i++, m.name.c_str(), -1, SQLITE_TRANSIENT);
    sqlite3_bind_text(stmt, i++, m.shortName.c_str(), -1, SQLITE_TRANSIENT);
    sqlite3_bind_text(stmt, i++, m.description.c_str(), -1, SQLITE_TRANSIENT);
    sqlite3_bind_text(stmt, i++, m.author.c_str(), -1, SQLITE_TRANSIENT);
    sqlite3_bind_text(stmt, i++, m.version.c_str(), -1, SQLITE_TRANSIENT);
    sqlite3_bind_int(stmt, i++, m.mapx);
    sqlite3_bind_int(stmt, i++, m.mapy);
    sqlite3_bind_int(stmt, i++, m.widthElmos);
    sqlite3_bind_int(stmt, i++, m.heightElmos);
    sqlite3_bind_double(stmt, i++, m.minHeight);
    sqlite3_bind_double(stmt, i++, m.maxHeight);
    sqlite3_bind_double(stmt, i++, m.gravity);
    sqlite3_bind_double(stmt, i++, m.tidalStrength);
    sqlite3_bind_double(stmt, i++, m.maxMetal);
    sqlite3_bind_double(stmt, i++, m.extractorRadius);
    sqlite3_bind_int(stmt, i++, m.tilesX);
    sqlite3_bind_int(stmt, i++, m.tilesZ);
    sqlite3_bind_int(stmt, i++, m.numTiles);
    sqlite3_bind_int(stmt, i++, m.hasLuaGaia ? 1 : 0);
    sqlite3_bind_int(stmt, i++, static_cast<int>(m.features.size()));
    sqlite3_bind_int(stmt, i++, static_cast<int>(m.featureTypes.size()));
    sqlite3_bind_text(stmt, i++, spStr.c_str(), -1, SQLITE_TRANSIENT);
    sqlite3_bind_int(stmt, i++, m.formatVersion);
    sqlite3_bind_text(stmt, i++, m.processedDir.c_str(), -1, SQLITE_TRANSIENT);
    sqlite3_bind_text(stmt, i++, m.sourcePath.c_str(), -1, SQLITE_TRANSIENT);
    sqlite3_bind_text(stmt, i++, m.decals.detailTex.c_str(),        -1, SQLITE_TRANSIENT);
    sqlite3_bind_text(stmt, i++, m.decals.specularTex.c_str(),      -1, SQLITE_TRANSIENT);
    sqlite3_bind_text(stmt, i++, m.decals.splatDetailTex.c_str(),   -1, SQLITE_TRANSIENT);
    sqlite3_bind_text(stmt, i++, m.decals.splatDistrTex.c_str(),    -1, SQLITE_TRANSIENT);
    sqlite3_bind_text(stmt, i++, m.decals.splatDetailNormalTex[0].c_str(), -1, SQLITE_TRANSIENT);
    sqlite3_bind_text(stmt, i++, m.decals.splatDetailNormalTex[1].c_str(), -1, SQLITE_TRANSIENT);
    sqlite3_bind_text(stmt, i++, m.decals.splatDetailNormalTex[2].c_str(), -1, SQLITE_TRANSIENT);
    sqlite3_bind_text(stmt, i++, m.decals.splatDetailNormalTex[3].c_str(), -1, SQLITE_TRANSIENT);
    sqlite3_bind_text(stmt, i++, m.decals.detailNormalTex.c_str(),  -1, SQLITE_TRANSIENT);
    sqlite3_bind_text(stmt, i++, splatScalesStr.c_str(), -1, SQLITE_TRANSIENT);
    sqlite3_bind_text(stmt, i++, splatMultsStr.c_str(),  -1, SQLITE_TRANSIENT);
    sqlite3_bind_text(stmt, i++, typesStr.c_str(),       -1, SQLITE_TRANSIENT);
    sqlite3_bind_text(stmt, i++, featuresStr.c_str(),    -1, SQLITE_TRANSIENT);
    sqlite3_bind_text(stmt, i++, defsStr.c_str(),        -1, SQLITE_TRANSIENT);
    sqlite3_bind_text(stmt, i++, waterBaseStr.c_str(),    -1, SQLITE_TRANSIENT);
    sqlite3_bind_text(stmt, i++, waterSurfaceStr.c_str(), -1, SQLITE_TRANSIENT);
    sqlite3_bind_text(stmt, i++, waterMinStr.c_str(),     -1, SQLITE_TRANSIENT);
    sqlite3_bind_double(stmt, i++, m.water.surfaceAlpha);
    sqlite3_bind_double(stmt, i++, m.water.damage);
    sqlite3_bind_int(stmt, i++, m.water.voidWater ? 1 : 0);
    sqlite3_bind_text(stmt, i++, widgetsStr.c_str(), -1, SQLITE_TRANSIENT);
    sqlite3_step(stmt);
    sqlite3_finalize(stmt);
}

// Parse "a,b,c,d" into out[0..n-1]. Missing entries left at defaults.
static void parseFloats(const char* s, float* out, int n) {
    if (!s || !*s) return;
    std::istringstream ss(s);
    std::string tok;
    for (int i = 0; i < n && std::getline(ss, tok, ','); i++) {
        try { out[i] = std::stof(tok); } catch (...) {}
    }
}

std::vector<MapMetadata> MapProcessor::GetAllMaps(sqlite3* db) {
    EnsureTable(db);
    std::vector<MapMetadata> result;
    sqlite3_stmt* stmt = nullptr;
    int rc = sqlite3_prepare_v2(db, "SELECT id,name,short_name,description,author,version,"
        "mapx,mapy,width_elmos,height_elmos,min_height,max_height,"
        "gravity,tidal_strength,max_metal,extractor_radius,"
        "tiles_x,tiles_z,num_tiles,has_lua_gaia,"
        "start_positions,format_version,processed_dir,"
        "detail_tex,specular_tex,splat_detail_tex,splat_distr_tex,"
        "splat_normal_0,splat_normal_1,splat_normal_2,splat_normal_3,"
        "detail_normal_tex,splat_scales,splat_mults,"
        "feature_types,features_blob,feature_defs,"
        "water_base_color,water_surface_color,water_min_color,"
        "water_surface_alpha,water_damage,void_water,widgets FROM maps", -1, &stmt, nullptr);
    if (rc != SQLITE_OK) {
        std::fprintf(stderr, "[mapproc] GetAllMaps: SQL prepare failed: %s\n",
            sqlite3_errmsg(db));
        return result;
    }

    while (sqlite3_step(stmt) == SQLITE_ROW) {
        MapMetadata m;
        int i = 0;
        auto maybeStr = [&](int col) -> std::string {
            auto t = sqlite3_column_text(stmt, col);
            return t ? reinterpret_cast<const char*>(t) : "";
        };
        m.id = maybeStr(i++);
        m.name = maybeStr(i++);
        m.shortName = maybeStr(i++);
        m.description = maybeStr(i++);
        m.author = maybeStr(i++);
        m.version = maybeStr(i++);
        m.mapx = sqlite3_column_int(stmt, i++);
        m.mapy = sqlite3_column_int(stmt, i++);
        m.widthElmos = sqlite3_column_int(stmt, i++);
        m.heightElmos = sqlite3_column_int(stmt, i++);
        m.minHeight = static_cast<float>(sqlite3_column_double(stmt, i++));
        m.maxHeight = static_cast<float>(sqlite3_column_double(stmt, i++));
        m.gravity = static_cast<float>(sqlite3_column_double(stmt, i++));
        m.tidalStrength = static_cast<float>(sqlite3_column_double(stmt, i++));
        m.maxMetal = static_cast<float>(sqlite3_column_double(stmt, i++));
        m.extractorRadius = static_cast<float>(sqlite3_column_double(stmt, i++));
        m.tilesX = sqlite3_column_int(stmt, i++);
        m.tilesZ = sqlite3_column_int(stmt, i++);
        m.numTiles = sqlite3_column_int(stmt, i++);
        m.hasLuaGaia = sqlite3_column_int(stmt, i++) != 0;
        // Parse start positions
        std::string spStr = maybeStr(i++);
        if (!spStr.empty()) {
            std::istringstream ss(spStr);
            std::string pair;
            while (std::getline(ss, pair, ';')) {
                auto comma = pair.find(',');
                if (comma != std::string::npos) {
                    MapStartPosition sp;
                    sp.x = std::stof(pair.substr(0, comma));
                    sp.z = std::stof(pair.substr(comma + 1));
                    m.startPositions.push_back(sp);
                }
            }
        }
        m.formatVersion = sqlite3_column_int(stmt, i++);
        m.processedDir = maybeStr(i++);

        // Decal textures
        m.decals.detailTex     = maybeStr(i++);
        m.decals.specularTex   = maybeStr(i++);
        m.decals.splatDetailTex= maybeStr(i++);
        m.decals.splatDistrTex = maybeStr(i++);
        m.decals.splatDetailNormalTex[0] = maybeStr(i++);
        m.decals.splatDetailNormalTex[1] = maybeStr(i++);
        m.decals.splatDetailNormalTex[2] = maybeStr(i++);
        m.decals.splatDetailNormalTex[3] = maybeStr(i++);
        m.decals.detailNormalTex = maybeStr(i++);
        parseFloats(maybeStr(i++).c_str(), m.decals.splatScales, 4);
        parseFloats(maybeStr(i++).c_str(), m.decals.splatMults,  4);

        // Feature types
        std::string typesStr = maybeStr(i++);
        if (!typesStr.empty()) {
            std::istringstream ss(typesStr);
            std::string t;
            while (std::getline(ss, t, '|'))
                m.featureTypes.push_back(t);
        }

        // Features blob: "type,x,y,z,rot,size;type,..."
        std::string featBlob = maybeStr(i++);
        if (!featBlob.empty()) {
            std::istringstream ss(featBlob);
            std::string rec;
            while (std::getline(ss, rec, ';')) {
                MapFeatureData f;
                char* p = rec.data();
                char* end = p + rec.size();
                auto nextField = [&](float& out) {
                    char* comma = (char*)memchr(p, ',', end - p);
                    if (comma) *comma = 0;
                    try { out = std::stof(p); } catch (...) {}
                    p = comma ? comma + 1 : end;
                };
                float typeF = 0;
                nextField(typeF);
                f.featureType = static_cast<int>(typeF);
                nextField(f.x);
                nextField(f.y);
                nextField(f.z);
                nextField(f.rotation);
                nextField(f.relativeSize);
                m.features.push_back(f);
            }
        }

        // Feature defs blob: pipe-delimited records, each comma-separated:
        //   name,model,texture,footX,footZ,height,radius,blocking,reclaim,metal,energy,damage
        std::string defsBlob = maybeStr(i++);
        if (!defsBlob.empty()) {
            std::istringstream ss(defsBlob);
            std::string rec;
            while (std::getline(ss, rec, '|')) {
                MapFeatureDef d;
                std::vector<std::string> fields;
                {
                    std::istringstream rs(rec);
                    std::string tok;
                    while (std::getline(rs, tok, ',')) fields.push_back(tok);
                }
                if (fields.size() >= 12) {
                    d.name        = fields[0];
                    d.modelFile   = fields[1];
                    d.textureFile = fields[2];
                    try { d.footprintX  = std::stoi(fields[3]); } catch (...) {}
                    try { d.footprintZ  = std::stoi(fields[4]); } catch (...) {}
                    try { d.height      = std::stof(fields[5]); } catch (...) {}
                    try { d.radius      = std::stof(fields[6]); } catch (...) {}
                    d.blocking    = fields[7] != "0";
                    d.reclaimable = fields[8] != "0";
                    try { d.metal       = std::stoi(fields[9]); } catch (...) {}
                    try { d.energy      = std::stoi(fields[10]); } catch (...) {}
                    try { d.damage      = std::stoi(fields[11]); } catch (...) {}
                    m.featureDefs.push_back(std::move(d));
                }
            }
        }

        // Water
        parseFloats(maybeStr(i++).c_str(), m.water.baseColor,    3);
        parseFloats(maybeStr(i++).c_str(), m.water.surfaceColor, 3);
        parseFloats(maybeStr(i++).c_str(), m.water.minColor,     3);
        m.water.surfaceAlpha = static_cast<float>(sqlite3_column_double(stmt, i++));
        m.water.damage       = static_cast<float>(sqlite3_column_double(stmt, i++));
        m.water.voidWater    = sqlite3_column_int(stmt, i++) != 0;

        // Widgets (pipe-delimited)
        std::string widgetsStr = maybeStr(i++);
        if (!widgetsStr.empty()) {
            std::istringstream ss(widgetsStr);
            std::string w;
            while (std::getline(ss, w, '|'))
                if (!w.empty()) m.widgets.push_back(w);
        }

        result.push_back(std::move(m));
    }
    sqlite3_finalize(stmt);
    return result;
}

MapMetadata MapProcessor::GetMap(sqlite3* db, const std::string& mapId) {
    auto all = GetAllMaps(db);
    for (auto& m : all)
        if (m.id == mapId) return m;
    return {};
}

// ============================================================
// Top-level
// ============================================================

bool MapProcessor::ProcessMap(MapMetadata& meta) {
    fs::create_directories(meta.processedDir);

    if (!ReadSMFHeader(meta)) {
        std::fprintf(stderr, "[mapproc] failed to read SMF header\n");
        return false;
    }

    if (!ExtractBinaryData(meta)) {
        std::fprintf(stderr, "[mapproc] failed to extract binary data\n");
        return false;
    }

    ExtractFeatures(meta);             // SMF-embedded placements (binary)
    FeatureProcessor::Process(meta);   // Lua defs + featureplacer + asset conversion
    ExtractDecalTextures(meta);
    EnumerateWidgets(meta);
    return true;
}

// Walk LuaUI/Widgets/ and collect all .lua filenames. These are shipped
// to the client in MapData; the client fetches each one from the HTTP
// source handler and runs it through fengari. No file copying or
// preprocessing — .lua is text, served straight from content/maps.
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
    std::fprintf(stderr, "[mapproc] %s: found %zu LuaUI widget(s)\n",
        meta.id.c_str(), meta.widgets.size());
}

void MapProcessor::ScanAndProcess(const std::string& mapsDir, const std::string& dataDir, sqlite3* db) {
    EnsureTable(db);
    if (!fs::is_directory(mapsDir)) {
        std::fprintf(stderr, "[mapproc] maps directory not found: %s\n", mapsDir.c_str());
        return;
    }

    for (auto& mapDir : fs::directory_iterator(mapsDir)) {
        if (!mapDir.is_directory()) continue;
        std::string mapId = mapDir.path().filename().string();

        MapMetadata existing = GetMap(db, mapId);
        std::string processedDir = dataDir + "/maps/" + mapId;
        bool filesExist = fs::exists(processedDir + "/heightmap.bin");
        if (existing.formatVersion >= MAP_FORMAT_VERSION && filesExist) {
            std::fprintf(stderr, "[mapproc] %s: up to date (v%d)\n", mapId.c_str(), existing.formatVersion);
            continue;
        }

        MapMetadata meta;
        meta.id = mapId;
        meta.sourcePath = mapDir.path().string();
        meta.processedDir = dataDir + "/maps/" + mapId;
        meta.formatVersion = MAP_FORMAT_VERSION;

        if (!ReadMapInfo(mapDir.path().string(), meta)) {
            std::fprintf(stderr, "[mapproc] %s: no SMF file found, skipping\n", mapId.c_str());
            continue;
        }

        std::fprintf(stderr, "[mapproc] processing %s \"%s\" (%dx%d)...\n",
            mapId.c_str(), meta.name.c_str(), meta.mapx, meta.mapy);

        if (ProcessMap(meta)) {
            StoreMetadata(db, meta);
            std::fprintf(stderr, "[mapproc] %s: done (%d features, %d start positions, luaGaia=%s)\n",
                mapId.c_str(), static_cast<int>(meta.features.size()),
                static_cast<int>(meta.startPositions.size()),
                meta.hasLuaGaia ? "yes" : "no");
        }
    }
}
