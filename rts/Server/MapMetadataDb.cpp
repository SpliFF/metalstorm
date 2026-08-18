// MapMetadataDb — SQLite read/write for map metadata.
//
// Extracted from MapProcessor.cpp so the lobby and game server can
// query pre-processed map data without linking the full conversion
// pipeline (Lua, ImageMagick, modelimporter, FeatureProcessor).

#include "MapMetadata.h"
#include "System/SpringLog/SpringLog.h"

#include <sqlite3.h>
#include <cstdio>
#include <cstring>
#include <sstream>
#include <string>

#define LOG_SECTION "map-db"

// ============================================================
// SQLite table management
// ============================================================

void MapMetadataDb::EnsureTable(sqlite3* db) {
    // Check whether the existing schema matches the current format version.
    // If it doesn't (missing columns from a schema bump), drop the table so
    // it gets recreated and all maps reprocessed. We detect "needs rebuild"
    // by querying for a column that was added in the latest schema.
    {
        sqlite3_stmt* stmt = nullptr;
        int rc = sqlite3_prepare_v2(db,
            "SELECT ground_tex FROM maps LIMIT 1", -1, &stmt, nullptr);
        sqlite3_finalize(stmt);
        if (rc != SQLITE_OK) {
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
            -- Recoil SMF_DETAIL_NORMAL_DIFFUSE_ALPHA: the splat detail
            -- normals' alpha channel doubles as the ground albedo detail.
            splat_detail_normal_diffuse_alpha INTEGER,
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
            widgets TEXT,
            -- Map-wide reverb preset (mapinfo.lua → sound.preset). Empty
            -- or "default" means no reverb. Client maps the name to a
            -- ConvolverNode IR fetched from sounds/efx/<preset>.webm.
            sound_preset TEXT,
            -- True (default) when the map's source files (mapinfo.lua,
            -- featureplacer/*.lua, SMF feature placements) are authored
            -- against Spring's LH frame (+Z forward). Persisted only as
            -- diagnostic / so Lua VFS reads of raw map content can pick
            -- the right adapter — positions on the record itself are
            -- already RH after the importer.
            legacy_coord_system INTEGER,
            -- Map-space ground albedo (PLAN-maps §2n): the processed-dir
            -- filename, or empty when the map delivers its ground colour
            -- through the SMT tile dictionary as Spring does.
            ground_tex TEXT
        );
    )", nullptr, nullptr, nullptr);
}

// ============================================================
// Store metadata
// ============================================================

void MapMetadataDb::StoreMetadata(sqlite3* db, const MapMetadata& m) {
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

    // Feature defs: pipe-delimited records
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
         splat_detail_normal_diffuse_alpha,
         feature_types,features_blob,feature_defs,
         water_base_color,water_surface_color,water_min_color,
         water_surface_alpha,water_damage,void_water,
         widgets,sound_preset,legacy_coord_system,ground_tex)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,
                ?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,
                ?,?,?,?,?,?,
                ?,?,?,?)
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
    sqlite3_bind_int(stmt, i++, m.decals.splatDetailNormalDiffuseAlpha ? 1 : 0);
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
    sqlite3_bind_text(stmt, i++, m.soundPreset.c_str(), -1, SQLITE_TRANSIENT);
    sqlite3_bind_int(stmt, i++, m.legacyCoordSystem ? 1 : 0);
    sqlite3_bind_text(stmt, i++, m.groundTex.c_str(), -1, SQLITE_TRANSIENT);
    sqlite3_step(stmt);
    sqlite3_finalize(stmt);
}

// ============================================================
// Read metadata
// ============================================================

// Parse "a,b,c,d" into out[0..n-1]. Missing entries left at defaults.
static void parseFloats(const char* s, float* out, int n) {
    if (!s || !*s) return;
    std::istringstream ss(s);
    std::string tok;
    for (int i = 0; i < n && std::getline(ss, tok, ','); i++) {
        try { out[i] = std::stof(tok); } catch (...) {}
    }
}

std::vector<MapMetadata> MapMetadataDb::GetAllMaps(sqlite3* db, bool* ok) {
    if (ok) *ok = true;
    if (!db) {
        if (ok) *ok = false;
        SLOG(SPRING_LOG_ERROR, "GetAllMaps: no database handle");
        return {};
    }
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
        "splat_detail_normal_diffuse_alpha,"
        "feature_types,features_blob,feature_defs,"
        "water_base_color,water_surface_color,water_min_color,"
        "water_surface_alpha,water_damage,void_water,widgets,sound_preset,"
        "legacy_coord_system,ground_tex FROM maps", -1, &stmt, nullptr);
    if (rc != SQLITE_OK) {
        if (ok) *ok = false;
        SLOG(SPRING_LOG_ERROR, "GetAllMaps: SQL prepare failed (%d): %s",
            rc, sqlite3_errmsg(db));
        return result;
    }

    int stepRc;
    while ((stepRc = sqlite3_step(stmt)) == SQLITE_ROW) {
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
        m.decals.splatDetailNormalDiffuseAlpha = sqlite3_column_int(stmt, i++) != 0;

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

        // Feature defs blob
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

        // Map sound preset (mapinfo.lua → sound.preset).
        m.soundPreset = maybeStr(i++);

        // legacyCoordSystem opt-in (defaults true if the column is NULL —
        // i.e. data persisted by an older importer that pre-dated the
        // field; those records were necessarily LH since RH is opt-in).
        if (sqlite3_column_type(stmt, i) == SQLITE_NULL) {
            m.legacyCoordSystem = true;
            i++;
        } else {
            m.legacyCoordSystem = sqlite3_column_int(stmt, i++) != 0;
        }

        // Map-space ground albedo (PLAN-maps §2n); empty = SMT tile path.
        m.groundTex = maybeStr(i++);

        result.push_back(std::move(m));
    }
    // A read that dies partway (or immediately) reports SQLITE_DONE only on
    // a clean walk. Anything else — SQLITE_NOTADB (26) above all — means the
    // vector is short or empty for a reason the caller must not read as
    // "that's all the maps there are".
    if (stepRc != SQLITE_DONE) {
        if (ok) *ok = false;
        SLOG(SPRING_LOG_ERROR, "GetAllMaps: step failed (%d): %s — returning "
            "%zu partial row(s); this is a DB fault, not an empty map set",
            stepRc, sqlite3_errmsg(db), result.size());
    }
    sqlite3_finalize(stmt);
    return result;
}

MapMetadata MapMetadataDb::GetMap(sqlite3* db, const std::string& mapId) {
    auto all = GetAllMaps(db);
    for (auto& m : all)
        if (m.id == mapId) return m;
    return {};
}
