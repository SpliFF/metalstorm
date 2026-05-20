/* This file is part of the Spring engine (GPL v2 or later), see LICENSE.html */

#include "ModelConfigLoader.h"

#include "Lua/LuaConfigLoader.h"
#include "Lua/LuaParser.h"
#include "Sim/Units/Scripts/LocalModelPieceStub.h"
#include "System/SpringLog/SpringLog.h"

#define LOG_SECTION "model-config"

#include <nlohmann/json.hpp>

#include <cstdio>
#include <filesystem>
#include <fstream>
#include <memory>
#include <string>
#include <vector>

namespace {

/// Pull a float3 field from a sub-table. Both the Lua and JSON
/// forms of the config expose a `{x, y, z}` triple as a nested
/// sub-table indexed by 1/2/3 — Friedl's JSON decoder maps JSON
/// arrays to 1-indexed Lua tables, which is exactly what
/// `LuaTable` expects.
float3 ReadFloat3Field(const LuaTable& parent, const char* key, const float3& fallback) {
    const LuaTable t = parent.SubTable(key);
    if (!t.IsValid())
        return fallback;
    return float3(
        t.Get(1, fallback.x),
        t.Get(2, fallback.y),
        t.Get(3, fallback.z));
}

/// Read `[x, y, z]` out of `node[key]`. Falls back cleanly when the
/// key is absent or the value isn't a 3-element numeric array.
float3 ReadFloat3FromJson(const nlohmann::json& node, const char* key, const float3& fallback) {
    if (!node.contains(key)) return fallback;
    const auto& arr = node[key];
    if (!arr.is_array() || arr.size() < 3) return fallback;
    auto pick = [](const nlohmann::json& v, float fb) -> float {
        if (v.is_number()) return v.get<float>();
        return fb;
    };
    return float3(
        pick(arr[0], fallback.x),
        pick(arr[1], fallback.y),
        pick(arr[2], fallback.z));
}

/// Load an S3DModel from the SPRINGRTS_geometry document-level
/// extension embedded in `<basePath>.gltf`. Returns true on success;
/// false if the .gltf is absent, doesn't parse, or lacks the extension
/// (caller falls back to the legacy .config.lua / .config.json path).
bool LoadFromGltfExtension(S3DModel& out, const std::string& basePath) {
    const std::string gltfPath = basePath + ".gltf";
    std::ifstream in(gltfPath, std::ios::binary);
    if (!in) return false;

    nlohmann::json doc;
    try {
        in >> doc;
    } catch (const nlohmann::json::parse_error& e) {
        SLOG(SPRING_LOG_ERROR,
            "%s: failed to parse glTF JSON: %s",
            gltfPath.c_str(), e.what());
        return false;
    }

    if (!doc.contains("extensions")) return false;
    const auto& exts = doc["extensions"];
    if (!exts.is_object() || !exts.contains("SPRINGRTS_geometry")) return false;
    const auto& geom = exts["SPRINGRTS_geometry"];
    if (!geom.is_object()) return false;

    // Schema-version check. The engine accepts exactly the version it
    // understands; newer files log a notice (forward-compatible by
    // default) and older files are refused — they need re-conversion
    // because the field shape may have changed.
    constexpr int kSupportedSchemaVersion = 7;
    int schemaVersion = 0;
    if (geom.contains("configVersion") && geom["configVersion"].is_number_integer()) {
        schemaVersion = geom["configVersion"].get<int>();
    }
    if (schemaVersion < kSupportedSchemaVersion) {
        SLOG(SPRING_LOG_WARNING,
            "%s: SPRINGRTS_geometry configVersion=%d is older than this "
            "engine supports (%d). Re-run gameconverter to regenerate.",
            gltfPath.c_str(), schemaVersion, kSupportedSchemaVersion);
        return false;
    }
    if (schemaVersion > kSupportedSchemaVersion) {
        SLOG(SPRING_LOG_NOTICE,
            "%s: SPRINGRTS_geometry configVersion=%d is newer than this "
            "engine understands (%d). Some fields may be ignored.",
            gltfPath.c_str(), schemaVersion, kSupportedSchemaVersion);
    }

    out.radius    = geom.value("radius", 1.0f);
    out.height    = geom.value("height", 1.0f);
    out.relMidPos = ReadFloat3FromJson(geom, "midpos", float3(0, 0, 0));
    out.mins      = ReadFloat3FromJson(geom, "mins",   float3(-1, -1, -1));
    out.maxs      = ReadFloat3FromJson(geom, "maxs",   float3( 1,  1,  1));

    out.pieces.clear();
    if (geom.contains("pieces") && geom["pieces"].is_array()) {
        const auto& piecesArr = geom["pieces"];
        out.pieces.reserve(piecesArr.size());

        std::vector<int> parentIndices;
        parentIndices.reserve(piecesArr.size());

        for (const auto& p : piecesArr) {
            if (!p.is_object()) continue;
            S3DModelPiece piece;
            piece.name   = p.value("name", std::string{});
            piece.offset = ReadFloat3FromJson(p, "offset", float3(0, 0, 0));
            piece.mins   = ReadFloat3FromJson(p, "mins",   float3(0, 0, 0));
            piece.maxs   = ReadFloat3FromJson(p, "maxs",   float3(0, 0, 0));
            parentIndices.push_back(p.value("parent", -1));
            out.pieces.push_back(std::move(piece));
        }
        // Second pass: link parent / children pointers. Indices are
        // 0-based into the flat list; -1 marks the root.
        for (size_t i = 0; i < out.pieces.size(); ++i) {
            const int parentIdx = parentIndices[i];
            if (parentIdx >= 0 && static_cast<size_t>(parentIdx) < out.pieces.size()) {
                out.pieces[i].parent = &out.pieces[parentIdx];
                out.pieces[parentIdx].children.push_back(&out.pieces[i]);
            }
        }
        out.numPieces = static_cast<int>(out.pieces.size());
    }

    out.metaPath = basePath;
    SLOG(SPRING_LOG_INFO,
        "loaded %s.gltf (SPRINGRTS_geometry v%d): radius=%.2f height=%.2f pieces=%d",
        basePath.c_str(), schemaVersion, out.radius, out.height, out.numPieces);
    return true;
}

} // namespace

S3DModel* ModelConfigLoader::Load(const std::string& basePath) {
    auto* model = new S3DModel();
    if (!LoadInto(*model, basePath)) {
        delete model;
        return nullptr;
    }
    return model;
}

bool ModelConfigLoader::LoadInto(S3DModel& out, const std::string& basePath) {
    if (basePath.empty())
        return false;

    // SPRINGRTS_geometry extension is the canonical source under
    // PLAN-pbr-mapping.md. Try it first unless a hand-authored
    // .config.lua exists (the Lua file always wins — author intent
    // overrides machine-extracted data).
    namespace fs = std::filesystem;
    const std::string luaConfigPath = basePath + LuaConfig::kLuaSuffix;
    if (!fs::exists(luaConfigPath)) {
        if (LoadFromGltfExtension(out, basePath)) {
            return true;
        }
        // No .gltf or no extension: fall through to the legacy
        // .config.json path below. Once .config.json is retired in
        // milestone B this becomes a hard failure.
    }

    // LuaConfig::Load tries <basePath>.config.lua first, then
    // <basePath>.config.json. Both end up in the same LuaParser-backed
    // representation so the rest of this function is format-agnostic.
    std::unique_ptr<LuaParser> parser = LuaConfig::Load(basePath);
    if (!parser) {
        // Caller is expected to have probed for the file already; a
        // silent miss here just means "no config, keep defaults".
        return false;
    }

    // If the .config.lua was loaded but produces no piece array (legacy
    // sidecar that only has overrides like textures/midpos), also load
    // the .config.json for the full piece tree generated by modelimporter.
    // We'll use jsonParser for pieces if the primary parser has none.
    std::unique_ptr<LuaParser> jsonParser;
    {
        namespace fs = std::filesystem;
        const std::string luaPath  = basePath + LuaConfig::kLuaSuffix;
        const std::string jsonPath = basePath + LuaConfig::kJsonSuffix;
        if (fs::exists(luaPath) && fs::exists(jsonPath)) {
            jsonParser = LuaConfig::LoadJson(basePath);
        }
    }

    const LuaTable root = parser->GetRoot();
    if (!root.IsValid()) {
        SLOG(SPRING_LOG_ERROR,
            "%s: root is not a table (did the file forget "
            "`return <table>`?)",
            basePath.c_str());
        return false;
    }

    // ---- Schema version check ----
    // `configVersion` is mandatory on files produced by the current
    // modelimporter. A missing key means the file was produced by a
    // pre-versioning build and should be regenerated. Older versions
    // are accepted as best-effort. The newest accepted version is
    // tracked here so future bumps that aren't yet wired don't
    // silently produce wrong data.
    //
    // v5 (2026-05-16) flipped the on-disk coordinate convention from
    // Spring-native LH to glTF-native RH. Phase 2 made the sim RH
    // internally, so v5+ sidecars are consumed as-is. v4 and earlier
    // files are LH and are no longer supported — re-run gameconverter
    // to regenerate.
    //
    // v6 (2026-05-17) switched modelimporter output from self-contained
    // `.glb` to glTF Separate form (`.gltf` + sibling `.bin` + sibling
    // `.ktx2` in the same models/ folder) and dropped the bogus
    // aiProcess_FlipUVs flag. No field-shape changes from v5 — the
    // sidecar JSON layout is identical, just a marker that the model's
    // on-disk container has switched. Same loader, no behaviour change.
    constexpr int kSupportedConfigVersion = 6;
    int configVersion = root.GetInt("configVersion", 0);
    if (configVersion == 0)
        configVersion = root.GetInt("metaVersion", 0);

    if (configVersion == 0) {
        SLOG(SPRING_LOG_WARNING,
            "%s: no `configVersion` field — file predates the "
            "versioned schema. Run `modelimporter --update-meta` to "
            "regenerate.",
            basePath.c_str());
    } else if (configVersion < kSupportedConfigVersion) {
        SLOG(SPRING_LOG_WARNING,
            "%s: configVersion=%d is LH-era and is no longer supported. "
            "Re-run gameconverter to regenerate at v%d (RH).",
            basePath.c_str(), configVersion, kSupportedConfigVersion);
    } else if (configVersion > kSupportedConfigVersion) {
        SLOG(SPRING_LOG_NOTICE,
            "%s: configVersion=%d is newer than this engine "
            "understands (%d). Some fields may be ignored.",
            basePath.c_str(), configVersion, kSupportedConfigVersion);
    }

    // ---- Top-level bounds ----
    out.radius    = root.GetFloat("radius", 1.0f);
    out.height    = root.GetFloat("height", 1.0f);
    out.relMidPos = ReadFloat3Field(root, "midpos", float3(0, 0, 0));
    out.mins      = ReadFloat3Field(root, "mins",   float3(-1, -1, -1));
    out.maxs      = ReadFloat3Field(root, "maxs",   float3( 1,  1,  1));

    // ---- Piece tree ----
    // Try pieces from the primary config first. If the primary config
    // (often a legacy .config.lua sidecar) has a pieces table that's
    // keyed by name (not an array), GetLength() returns 0 and we get
    // no pieces. In that case, fall back to the JSON config which has
    // the full piece array generated by modelimporter.
    LuaTable pieces = root.SubTable("pieces");
    int numPieces = pieces.IsValid() ? pieces.GetLength() : 0;
    if (numPieces == 0 && jsonParser) {
        const LuaTable jsonRoot = jsonParser->GetRoot();
        if (jsonRoot.IsValid()) {
            pieces = jsonRoot.SubTable("pieces");
            numPieces = pieces.IsValid() ? pieces.GetLength() : 0;
        }
    }
    if (pieces.IsValid() && numPieces > 0) {
        out.pieces.clear();
        out.pieces.reserve(numPieces);

        // First pass: copy fields. We can't set up parent/children
        // pointers yet because pushing into the vector may reallocate
        // and invalidate earlier addresses.
        std::vector<int> parentIndices;
        parentIndices.reserve(numPieces);

        for (int i = 1; i <= numPieces; ++i) {
            const LuaTable p = pieces.SubTable(i);
            if (!p.IsValid()) continue;

            S3DModelPiece piece;
            piece.name = p.GetString("name", "");

            piece.offset = ReadFloat3Field(p, "offset", float3(0, 0, 0));
            piece.mins   = ReadFloat3Field(p, "mins",   float3(0, 0, 0));
            piece.maxs   = ReadFloat3Field(p, "maxs",   float3(0, 0, 0));

            parentIndices.push_back(p.GetInt("parent", -1));
            out.pieces.push_back(std::move(piece));
        }

        // Second pass: link parent/children. `parent` index is
        // 0-based into the flat list; -1 marks the root.
        for (size_t i = 0; i < out.pieces.size(); ++i) {
            const int parentIdx = parentIndices[i];
            if (parentIdx >= 0 && static_cast<size_t>(parentIdx) < out.pieces.size()) {
                out.pieces[i].parent = &out.pieces[parentIdx];
                out.pieces[parentIdx].children.push_back(&out.pieces[i]);
            }
        }

        out.numPieces = static_cast<int>(out.pieces.size());
    }

    out.metaPath = basePath;

    SLOG(SPRING_LOG_INFO,
        "loaded %s: radius=%.2f height=%.2f pieces=%d",
        basePath.c_str(), out.radius, out.height, out.numPieces);
    return true;
}
