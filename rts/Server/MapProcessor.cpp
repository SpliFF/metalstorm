// MapProcessor — full map data extraction from SMF/SMT/mapinfo.lua.

#include "MapProcessor.h"

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
                meta.name = luaGetString(L, "name");
                meta.shortName = luaGetString(L, "shortname");
                meta.description = luaGetString(L, "description");
                meta.author = luaGetString(L, "author");
                meta.version = luaGetString(L, "version");
                meta.gravity = luaGetFloat(L, "gravity", 130);
                meta.tidalStrength = luaGetFloat(L, "tidalStrength", 0);
                meta.maxMetal = luaGetFloat(L, "maxMetal", 2.0f);
                meta.extractorRadius = luaGetFloat(L, "extractorRadius", 100.0f);

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
            processed_dir TEXT, source_path TEXT
        );
    )", nullptr, nullptr, nullptr);
}

void MapProcessor::StoreMetadata(sqlite3* db, const MapMetadata& m) {
    std::string spStr;
    for (const auto& sp : m.startPositions) {
        if (!spStr.empty()) spStr += ";";
        spStr += std::to_string(sp.x) + "," + std::to_string(sp.z);
    }

    sqlite3_stmt* stmt;
    sqlite3_prepare_v2(db, R"(
        INSERT OR REPLACE INTO maps
        (id,name,short_name,description,author,version,
         mapx,mapy,width_elmos,height_elmos,min_height,max_height,
         gravity,tidal_strength,max_metal,extractor_radius,
         tiles_x,tiles_z,num_tiles,has_lua_gaia,
         num_features,num_feature_types,start_positions,
         format_version,processed_dir,source_path)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
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
    sqlite3_step(stmt);
    sqlite3_finalize(stmt);
}

std::vector<MapMetadata> MapProcessor::GetAllMaps(sqlite3* db) {
    EnsureTable(db);
    std::vector<MapMetadata> result;
    sqlite3_stmt* stmt;
    sqlite3_prepare_v2(db, "SELECT id,name,short_name,description,author,version,"
        "mapx,mapy,width_elmos,height_elmos,min_height,max_height,"
        "gravity,tidal_strength,max_metal,extractor_radius,"
        "tiles_x,tiles_z,num_tiles,has_lua_gaia,"
        "start_positions,format_version,processed_dir FROM maps", -1, &stmt, nullptr);

    while (sqlite3_step(stmt) == SQLITE_ROW) {
        MapMetadata m;
        int i = 0;
        m.id = reinterpret_cast<const char*>(sqlite3_column_text(stmt, i++));
        m.name = reinterpret_cast<const char*>(sqlite3_column_text(stmt, i++));
        auto maybeStr = [&](int col) -> std::string {
            auto t = sqlite3_column_text(stmt, col);
            return t ? reinterpret_cast<const char*>(t) : "";
        };
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
        const char* spStr = reinterpret_cast<const char*>(sqlite3_column_text(stmt, i++));
        if (spStr && strlen(spStr) > 0) {
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

    ExtractFeatures(meta);
    return true;
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
