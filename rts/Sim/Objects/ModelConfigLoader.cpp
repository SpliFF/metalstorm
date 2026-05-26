/* This file is part of the Spring engine (GPL v2 or later), see LICENSE.html */

#include "ModelConfigLoader.h"

#include "Sim/Units/Scripts/LocalModelPieceStub.h"
#include "System/SpringLog/SpringLog.h"

#define LOG_SECTION "model-config"

#include <nlohmann/json.hpp>

#include <fstream>
#include <string>
#include <vector>

namespace {

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

    const std::string gltfPath = basePath + ".gltf";
    std::ifstream in(gltfPath, std::ios::binary);
    if (!in) {
        SLOG(SPRING_LOG_WARNING,
            "%s: file not found — run gameconverter to regenerate",
            gltfPath.c_str());
        return false;
    }

    nlohmann::json doc;
    try {
        in >> doc;
    } catch (const nlohmann::json::parse_error& e) {
        SLOG(SPRING_LOG_ERROR,
            "%s: failed to parse glTF JSON: %s",
            gltfPath.c_str(), e.what());
        return false;
    }

    if (!doc.contains("extensions")) {
        SLOG(SPRING_LOG_WARNING,
            "%s: glTF has no `extensions` block",
            gltfPath.c_str());
        return false;
    }
    const auto& exts = doc["extensions"];
    if (!exts.is_object() || !exts.contains("SPRINGRTS_geometry")) {
        SLOG(SPRING_LOG_WARNING,
            "%s: glTF has no `SPRINGRTS_geometry` extension — "
            "re-run gameconverter to regenerate",
            gltfPath.c_str());
        return false;
    }
    const auto& geom = exts["SPRINGRTS_geometry"];
    if (!geom.is_object()) {
        SLOG(SPRING_LOG_ERROR,
            "%s: `SPRINGRTS_geometry` is not a JSON object",
            gltfPath.c_str());
        return false;
    }

    // Schema-version check. The engine accepts exactly the version it
    // understands; newer files log a notice (forward-compatible by
    // default) and older files are refused — they need re-conversion
    // because the field shape may have changed.
    constexpr int kSupportedSchemaVersion = 8;
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
