// FeatureProcessor — see header for pipeline overview.

#include "FeatureProcessor.h"
#include "MapProcessor.h"

#include "lua.h"
#include "lualib.h"
#include "lauxlib.h"

#include "System/FileSystem/LuaVFSSimple.h"
#include "System/FileSystem/FileHandler.h"
#include "System/SpringLog/SpringLog.h"

#define LOG_SECTION "feature-proc"

#include <algorithm>
#include <cctype>
#include <cstdio>
#include <cstring>
#include <filesystem>
#include <string>
#include <unordered_map>
#include <vector>

// Absolute path to the modelimporter binary, injected at build time
// via target_compile_definitions in the top-level CMakeLists. Falls
// back to a bare name for source-tree-relative invocations where
// the binary happens to be on $PATH (unit tests, manual runs).
#ifndef MODELIMPORTER_BINARY_PATH
#define MODELIMPORTER_BINARY_PATH "modelimporter"
#endif

#ifndef TEXTURECONVERTER_BINARY_PATH
#define TEXTURECONVERTER_BINARY_PATH "textureconverter"
#endif

namespace fs = std::filesystem;

namespace {

// ============================================================
// Lua helpers
// ============================================================

std::string luaGetString(lua_State* L, const char* field) {
    lua_getfield(L, -1, field);
    std::string s = lua_isstring(L, -1) ? lua_tostring(L, -1) : "";
    lua_pop(L, 1);
    return s;
}

float luaGetFloat(lua_State* L, const char* field, float def = 0.0f) {
    lua_getfield(L, -1, field);
    float v = def;
    if (lua_isnumber(L, -1)) {
        v = static_cast<float>(lua_tonumber(L, -1));
    } else if (lua_isstring(L, -1)) {
        // Spring def files often quote numeric fields ("17", "26").
        try { v = std::stof(lua_tostring(L, -1)); } catch (...) {}
    }
    lua_pop(L, 1);
    return v;
}

int luaGetInt(lua_State* L, const char* field, int def = 0) {
    return static_cast<int>(luaGetFloat(L, field, static_cast<float>(def)));
}

bool luaGetBool(lua_State* L, const char* field, bool def = false) {
    lua_getfield(L, -1, field);
    bool v = def;
    if (lua_isboolean(L, -1)) v = lua_toboolean(L, -1) != 0;
    else if (lua_isnumber(L, -1)) v = lua_tonumber(L, -1) != 0;
    lua_pop(L, 1);
    return v;
}

std::string toLower(std::string s) {
    std::transform(s.begin(), s.end(), s.begin(),
                   [](unsigned char c) { return std::tolower(c); });
    return s;
}

// Boilerplate Lua state initialiser used by both feature-def loading and
// the featureplacer execution. Sets up Spring 5.1 compatibility shims and
// the LuaVFSSimple bindings backed by `mapDir` as a content root.
lua_State* CreateMapLuaState(const std::string& mapDir) {
    CFileHandler::AddContentRoot(mapDir, RootCategory::Map);

    lua_State* L = luaL_newstate();
    luaL_openlibs(L);
    luaL_dostring(L,
        "unpack = unpack or table.unpack\n"
        "loadstring = loadstring or load\n"
        "if not setfenv then\n"
        "  setfenv = function(f, t) return f end\n"
        "  getfenv = function(f) return _G end\n"
        "end\n"
        "module = module or function() end\n"
        "Spring = Spring or { Echo = print, GetGameFrame = function() return 0 end }\n"
        "function lowerkeys(t)\n"
        "  if type(t) ~= 'table' then return t end\n"
        "  local out = {}\n"
        "  for k,v in pairs(t) do\n"
        "    if type(k) == 'string' then out[k:lower()] = v\n"
        "    else out[k] = v end\n"
        "  end\n"
        "  return out\n"
        "end\n"
    );
    LuaVFSSimple::Register(L);
    return L;
}

void CloseMapLuaState(lua_State* L) {
    lua_close(L);
    // The map dir was added as a content root in CreateMapLuaState; the
    // caller restores root state by clearing then re-adding any prior
    // roots. Each call here pushes one root, so popping the back keeps
    // global VFS state consistent.
    auto roots = CFileHandler::GetCategorizedRoots();
    if (!roots.empty()) {
        roots.pop_back();
        CFileHandler::ClearContentRoots();
        for (const auto& r : roots) CFileHandler::AddContentRoot(r.path, r.category);
    }
}

// ============================================================
// Step 1 — parse features/*.lua
// ============================================================
//
// A typical Spring feature def file looks like:
//
//     return lowerkeys({
//       GreyRock1 = { object = "GreyRock1.s3o", footprintX = 9, ... },
//       GreyRock2 = { ... },
//     })
//
// We `dofile` each `.lua` under `features/`, expect a table return value,
// and walk top-level keys as feature def names.

void ParseFeatureDef(lua_State* L,
                     const std::string& key,
                     std::vector<MapFeatureDef>& out) {
    if (!lua_istable(L, -1)) return;

    MapFeatureDef def;
    def.name = toLower(key);

    // Spring source field is `object` (relative path of .s3o, optional
    // subdirectory like `objects3d/foo.s3o` or just `foo.s3o`).
    def.modelFile = luaGetString(L, "object");

    def.footprintX = luaGetInt(L, "footprintx", 1);
    if (def.footprintX <= 0) def.footprintX = luaGetInt(L, "footprintX", 1);
    def.footprintZ = luaGetInt(L, "footprintz", 1);
    if (def.footprintZ <= 0) def.footprintZ = luaGetInt(L, "footprintZ", 1);

    def.height = luaGetFloat(L, "height", 0);
    def.radius = luaGetFloat(L, "radius", 0);

    def.blocking    = luaGetBool(L, "blocking",    true);
    def.reclaimable = luaGetBool(L, "reclaimable", false);
    def.metal  = luaGetInt(L, "metal",  0);
    def.energy = luaGetInt(L, "energy", 0);
    def.damage = luaGetInt(L, "damage", 0);

    out.push_back(std::move(def));
}

void ParseFeatureDefFile(lua_State* L,
                         const fs::path& path,
                         std::vector<MapFeatureDef>& out) {
    if (luaL_dofile(L, path.string().c_str()) != LUA_OK) {
        SLOG(SPRING_LOG_ERROR, "lua error in %s: %s",
            path.string().c_str(), lua_tostring(L, -1));
        lua_pop(L, 1);
        return;
    }
    if (!lua_istable(L, -1)) {
        lua_pop(L, 1);
        return;
    }

    // Iterate top-level keys → each is one feature def name.
    lua_pushnil(L);
    while (lua_next(L, -2) != 0) {
        if (lua_isstring(L, -2) && lua_istable(L, -1)) {
            ParseFeatureDef(L, lua_tostring(L, -2), out);
        }
        lua_pop(L, 1); // value, keep key
    }
    lua_pop(L, 1); // pop table
}

// ============================================================
// Heightmap sampling
// ============================================================
//
// Feature Y is part of the synced sim state — pathfinding, collision
// volumes, line-of-sight, and projectile hits all care about it, so
// the server must resolve it at preprocess time rather than leaving
// it to the client. We read the raw uint16 corner heightmap that
// ExtractBinaryData already wrote to <processedDir>/heightmap.bin and
// bilinearly sample it at each featureplacer (x, z), applying the
// same `minHeight + (raw/65535) * hRange` decode the client terrain
// mesh uses so features end up flush with the rendered ground.

struct HeightmapSampler {
    std::vector<uint16_t> data;
    int hmW = 0;     // (mapx + 1)
    int hmH = 0;     // (mapy + 1)
    float minHeight = 0;
    float maxHeight = 0;
    float squareSize = 8.0f;

    bool valid() const { return !data.empty() && hmW > 0 && hmH > 0; }

    /// Bilinear sample at world (x, z) in elmos. Clamps to map bounds.
    float sample(float x, float z) const {
        if (!valid()) return 0.0f;
        float gxF = x / squareSize;
        float gzF = z / squareSize;
        if (gxF < 0) gxF = 0;
        if (gzF < 0) gzF = 0;
        if (gxF > hmW - 1.001f) gxF = hmW - 1.001f;
        if (gzF > hmH - 1.001f) gzF = hmH - 1.001f;
        const int gx0 = static_cast<int>(gxF);
        const int gz0 = static_cast<int>(gzF);
        const float fx = gxF - gx0;
        const float fz = gzF - gz0;

        const uint16_t h00 = data[gz0 * hmW + gx0];
        const uint16_t h10 = data[gz0 * hmW + gx0 + 1];
        const uint16_t h01 = data[(gz0 + 1) * hmW + gx0];
        const uint16_t h11 = data[(gz0 + 1) * hmW + gx0 + 1];

        const float raw =
            h00 * (1 - fx) * (1 - fz) +
            h10 * fx       * (1 - fz) +
            h01 * (1 - fx) * fz +
            h11 * fx       * fz;

        return minHeight + (raw / 65535.0f) * (maxHeight - minHeight);
    }
};

HeightmapSampler LoadHeightmap(const MapMetadata& meta) {
    HeightmapSampler s;
    s.hmW = meta.mapx + 1;
    s.hmH = meta.mapy + 1;
    s.minHeight = meta.minHeight;
    s.maxHeight = meta.maxHeight;
    s.squareSize = 8.0f;

    const std::string path = meta.processedDir + "/heightmap.bin";
    std::ifstream f(path, std::ios::binary);
    if (!f.is_open()) {
        SLOG(SPRING_LOG_WARNING, "heightmap.bin missing at %s, "
            "feature Y will be 0 (expect sunken rocks)", path.c_str());
        return s;
    }
    const size_t count = static_cast<size_t>(s.hmW) * s.hmH;
    s.data.resize(count);
    f.read(reinterpret_cast<char*>(s.data.data()),
           static_cast<std::streamsize>(count * sizeof(uint16_t)));
    if (!f) {
        SLOG(SPRING_LOG_WARNING, "short read on heightmap.bin");
        s.data.clear();
    }
    return s;
}

// ============================================================
// Step 2 — run mapconfig/featureplacer/config.lua
// ============================================================
//
//     return {
//       objectlist = {
//         { name = 'GreyRock3', x = 1600, z = 300, rot = "10000" },
//         ...
//       },
//       unitlist = {}, buildinglist = {},
//     }
//
// Each entry's `rot` is in Spring's int "heading" units (16-bit angle):
// 0..65535 maps to 0..2π. We convert to radians here.

float HeadingToRadians(float h) {
    return h * (2.0f * 3.14159265358979323846f / 65536.0f);
}

/// Matches the +5 elmo offset Spring's own `FP_featureplacer.lua`
/// gadget adds: `CreateFeature(name, x, GetGroundHeight(x,z) + 5, z, rot)`.
/// Keeps features from z-fighting with the terrain mesh underneath.
constexpr float GROUND_PLACEMENT_OFFSET = 5.0f;

void ParseFeaturePlacements(lua_State* L,
                            MapMetadata& meta,
                            std::unordered_map<std::string, int>& nameToIndex,
                            const HeightmapSampler& heightmap) {
    const std::string configPath =
        meta.sourcePath + "/mapconfig/featureplacer/config.lua";
    if (!fs::exists(configPath)) return;

    if (luaL_dofile(L, configPath.c_str()) != LUA_OK) {
        SLOG(SPRING_LOG_ERROR, "featureplacer error: %s",
            lua_tostring(L, -1));
        lua_pop(L, 1);
        return;
    }
    if (!lua_istable(L, -1)) { lua_pop(L, 1); return; }

    lua_getfield(L, -1, "objectlist");
    if (!lua_istable(L, -1)) {
        lua_pop(L, 2);
        return;
    }

    int added = 0;
    int skipped = 0;
    const int len = static_cast<int>(lua_rawlen(L, -1));
    for (int i = 1; i <= len; ++i) {
        lua_rawgeti(L, -1, i);
        if (lua_istable(L, -1)) {
            std::string name = toLower(luaGetString(L, "name"));
            float x   = luaGetFloat(L, "x", 0);
            float z   = luaGetFloat(L, "z", 0);
            float rot = luaGetFloat(L, "rot", 0);

            if (name.empty()) {
                ++skipped;
            } else {
                auto it = nameToIndex.find(name);
                int typeIndex;
                if (it == nameToIndex.end()) {
                    // Unknown name (no def file loaded for it). Register a
                    // type entry anyway so the wire format is consistent —
                    // the client will fall back to a placeholder.
                    typeIndex = static_cast<int>(meta.featureTypes.size());
                    meta.featureTypes.push_back(name);
                    nameToIndex[name] = typeIndex;
                } else {
                    typeIndex = it->second;
                }
                MapFeatureData inst;
                inst.featureType = typeIndex;
                inst.x = x;
                // Sample the ground at this (x, z) so the feature's Y
                // ends up part of the synced sim state — pathfinding,
                // LOS, projectile collision etc. all need a real Y, not
                // zero. Matches Spring's LuaGaia featureplacer, which
                // calls CreateFeature(name, x, GetGroundHeight(x,z)+5, z, rot).
                inst.y = heightmap.sample(x, z) + GROUND_PLACEMENT_OFFSET;
                inst.z = z;
                inst.rotation = HeadingToRadians(rot);
                inst.relativeSize = 1.0f;
                meta.features.push_back(inst);
                ++added;
            }
        }
        lua_pop(L, 1); // pop entry
    }
    lua_pop(L, 2); // pop objectlist + outer table

    SLOG(SPRING_LOG_INFO,
        "featureplacer: %d placement(s) added, %d skipped",
        added, skipped);
}

// ============================================================
// Step 3 — convert assets via modelimporter + magick
// ============================================================

/// Run a shell command, capturing combined stdout+stderr. Returns the
/// exit code; the captured output is logged on failure.
int RunCommand(const std::string& cmd) {
    FILE* p = popen(cmd.c_str(), "r");
    if (!p) return -1;
    char buf[256];
    std::string out;
    while (fgets(buf, sizeof(buf), p)) out += buf;
    int rc = pclose(p);
    if (rc != 0) {
        SLOG(SPRING_LOG_ERROR, "command failed (%d): %s\n  %s",
            rc, cmd.c_str(), out.c_str());
    }
    return rc;
}

/// Find the source S3O file referenced by a feature def. Spring resolves
/// `object = "GreyRock1.s3o"` against `objects3d/`, but some maps drop
/// the prefix or use absolute-from-map paths. Try a small list of
/// candidates and return the first hit.
std::string ResolveModelPath(const std::string& mapDir, const std::string& ref) {
    if (ref.empty()) return {};
    std::vector<fs::path> candidates;
    candidates.push_back(fs::path(mapDir) / ref);
    candidates.push_back(fs::path(mapDir) / "objects3d" / ref);
    if (ref.rfind("objects3d/", 0) == 0)
        candidates.push_back(fs::path(mapDir) / ref.substr(strlen("objects3d/")));

    for (const auto& p : candidates) {
        if (fs::exists(p)) return p.string();
    }
    // Case-insensitive last resort: scan objects3d/.
    fs::path objDir = fs::path(mapDir) / "objects3d";
    if (fs::is_directory(objDir)) {
        const std::string wantLower = toLower(fs::path(ref).filename().string());
        for (auto& entry : fs::directory_iterator(objDir)) {
            if (!entry.is_regular_file()) continue;
            if (toLower(entry.path().filename().string()) == wantLower)
                return entry.path().string();
        }
    }
    return {};
}

/// Find the texture referenced by an S3O. The S3O file's tex1 field is
/// just a basename (e.g. "GreyRock1.tga"); Spring searches `unittextures/`
/// for it. Return the first matching path on disk.
std::string ResolveTexturePath(const std::string& mapDir, const std::string& basename) {
    if (basename.empty()) return {};
    std::vector<fs::path> candidates;
    candidates.push_back(fs::path(mapDir) / "unittextures" / basename);
    candidates.push_back(fs::path(mapDir) / basename);
    candidates.push_back(fs::path(mapDir) / "objects3d" / basename);

    for (const auto& p : candidates) {
        if (fs::exists(p)) return p.string();
    }
    // Case-insensitive scan of unittextures/.
    fs::path texDir = fs::path(mapDir) / "unittextures";
    if (fs::is_directory(texDir)) {
        const std::string wantLower = toLower(basename);
        for (auto& entry : fs::directory_iterator(texDir)) {
            if (!entry.is_regular_file()) continue;
            if (toLower(entry.path().filename().string()) == wantLower)
                return entry.path().string();
        }
    }
    return {};
}

/// Read the diffuse texture filename out of an S3O header without parsing
/// the rest of the file. Used to know which texture to convert before
/// (or after) running modelimporter.
std::string ReadS3OTexture1(const std::string& s3oPath) {
    FILE* f = std::fopen(s3oPath.c_str(), "rb");
    if (!f) return {};
    char header[52];
    if (std::fread(header, 1, sizeof(header), f) != sizeof(header)) {
        std::fclose(f);
        return {};
    }
    if (std::memcmp(header, "Spring unit", 11) != 0) {
        std::fclose(f);
        return {};
    }
    uint32_t tex1Off;
    std::memcpy(&tex1Off, header + 44, 4);
    if (tex1Off == 0) { std::fclose(f); return {}; }
    if (std::fseek(f, tex1Off, SEEK_SET) != 0) { std::fclose(f); return {}; }
    char buf[256] = {0};
    std::fread(buf, 1, sizeof(buf) - 1, f);
    std::fclose(f);
    return std::string(buf);
}

void ConvertAssetsForDef(MapMetadata& meta, MapFeatureDef& def) {
    const std::string srcModel = ResolveModelPath(meta.sourcePath, def.modelFile);
    if (srcModel.empty()) {
        SLOG(SPRING_LOG_WARNING, "%s: model not found ('%s'), skipping",
            def.name.c_str(), def.modelFile.c_str());
        def.modelFile.clear();
        return;
    }

    fs::path featuresDir = fs::path(meta.processedDir) / "features";
    fs::create_directories(featuresDir);

    // ---- Texture: read the S3O's tex1 field, find on disk, convert ----
    std::string texBasename = ReadS3OTexture1(srcModel);
    std::string convertedTextureName;
    if (!texBasename.empty()) {
        const std::string srcTex = ResolveTexturePath(meta.sourcePath, texBasename);
        if (!srcTex.empty()) {
            // Output filename: same stem, .png extension.
            const std::string stem = fs::path(texBasename).stem().string();
            convertedTextureName = stem + ".png";
            const fs::path dstTex = featuresDir / convertedTextureName;
            // Skip if up-to-date.
            if (!fs::exists(dstTex) ||
                fs::last_write_time(srcTex) > fs::last_write_time(dstTex)) {
                std::string cmd = std::string("\"") + TEXTURECONVERTER_BINARY_PATH + "\""
                                  " \"" + srcTex + "\" \"" +
                                  dstTex.string() + "\" 2>&1";
                if (RunCommand(cmd) != 0) {
                    convertedTextureName.clear();
                }
            }
        } else {
            SLOG(SPRING_LOG_WARNING, "%s: texture '%s' not found in unittextures/",
                def.name.c_str(), texBasename.c_str());
        }
    }
    def.textureFile = convertedTextureName;

    // ---- Model: modelimporter src.s3o features/Name.glb [--texture-ext png] ----
    const std::string stem = fs::path(srcModel).stem().string();
    const std::string dstName = stem + ".glb";
    const fs::path dst = featuresDir / dstName;
    if (!fs::exists(dst) ||
        fs::last_write_time(srcModel) > fs::last_write_time(dst)) {
        std::string cmd = std::string("\"") + MODELIMPORTER_BINARY_PATH + "\"";
        if (!convertedTextureName.empty()) {
            cmd += " --texture-ext png";
        }
        cmd += " \"" + srcModel + "\" \"" + dst.string() + "\" 2>&1";
        if (RunCommand(cmd) != 0) {
            SLOG(SPRING_LOG_ERROR, "%s: modelimporter failed, no model",
                def.name.c_str());
            def.modelFile.clear();
            return;
        }
    }
    def.modelFile = dstName;
}

} // namespace

// ============================================================
// Public entry point
// ============================================================

namespace FeatureProcessor {

void Process(MapMetadata& meta) {
    // ---- Step 1: parse features/*.lua to populate featureDefs ----
    fs::path featuresDir = fs::path(meta.sourcePath) / "features";
    if (!fs::is_directory(featuresDir)) {
        // Some maps have no Lua feature defs (only SMF-embedded features).
        // That's fine — we still want to run the placer pass below in case
        // it references defs from a sibling game.
    } else {
        auto savedRoots = CFileHandler::GetCategorizedRoots();
        lua_State* L = CreateMapLuaState(meta.sourcePath);

        for (auto& entry : fs::directory_iterator(featuresDir)) {
            if (!entry.is_regular_file()) continue;
            if (entry.path().extension() != ".lua") continue;
            ParseFeatureDefFile(L, entry.path(), meta.featureDefs);
        }

        CloseMapLuaState(L);
        // Restore exact pre-call state of content roots.
        CFileHandler::ClearContentRoots();
        for (const auto& r : savedRoots) CFileHandler::AddContentRoot(r.path, r.category);

        SLOG(SPRING_LOG_INFO, "parsed %zu feature def(s) from %s/features/",
            meta.featureDefs.size(), meta.id.c_str());
    }

    // ---- Step 2: register featureTypes from defs (so type indices are
    //               consistent across the SMF-extracted features and the
    //               featureplacer-extracted ones) ----
    std::unordered_map<std::string, int> nameToIndex;
    for (size_t i = 0; i < meta.featureTypes.size(); ++i) {
        nameToIndex[toLower(meta.featureTypes[i])] = static_cast<int>(i);
    }
    for (auto& def : meta.featureDefs) {
        if (nameToIndex.find(def.name) == nameToIndex.end()) {
            const int idx = static_cast<int>(meta.featureTypes.size());
            meta.featureTypes.push_back(def.name);
            nameToIndex[def.name] = idx;
        }
    }

    // ---- Step 3: parse mapconfig/featureplacer/config.lua ----
    // Load the heightmap first so ParseFeaturePlacements can resolve
    // each placement's Y against the real terrain. ExtractBinaryData
    // has already written heightmap.bin earlier in the pipeline.
    if (fs::exists(meta.sourcePath + "/mapconfig/featureplacer/config.lua")) {
        HeightmapSampler heightmap = LoadHeightmap(meta);
        auto savedRoots = CFileHandler::GetCategorizedRoots();
        lua_State* L = CreateMapLuaState(meta.sourcePath);
        ParseFeaturePlacements(L, meta, nameToIndex, heightmap);
        CloseMapLuaState(L);
        CFileHandler::ClearContentRoots();
        for (const auto& r : savedRoots) CFileHandler::AddContentRoot(r.path, r.category);
    }

    // ---- Step 4: re-align featureDefs to be parallel to featureTypes ----
    // featureTypes is the canonical index list; featureDefs is what we
    // serialise alongside it. Build a parallel-indexed defs vector.
    std::vector<MapFeatureDef> alignedDefs(meta.featureTypes.size());
    for (size_t i = 0; i < meta.featureTypes.size(); ++i) {
        alignedDefs[i].name = meta.featureTypes[i];
    }
    for (const auto& def : meta.featureDefs) {
        auto it = nameToIndex.find(def.name);
        if (it != nameToIndex.end()) {
            alignedDefs[it->second] = def;
        }
    }
    meta.featureDefs = std::move(alignedDefs);

    // ---- Step 5: convert assets for each def that has a model ----
    int converted = 0;
    int skipped = 0;
    for (auto& def : meta.featureDefs) {
        if (def.modelFile.empty()) { ++skipped; continue; }
        ConvertAssetsForDef(meta, def);
        if (!def.modelFile.empty()) ++converted;
    }
    SLOG(SPRING_LOG_INFO,
        "%s: %d def(s) converted, %d skipped, %zu placement(s)",
        meta.id.c_str(), converted, skipped, meta.features.size());
}

} // namespace FeatureProcessor
