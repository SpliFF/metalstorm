/* This file is part of the Spring engine (GPL v2 or later), see LICENSE.html */

#include "ModelConfigLoader.h"

#include "Lua/LuaConfigLoader.h"
#include "Lua/LuaParser.h"
#include "Sim/Units/Scripts/LocalModelPieceStub.h"

#include <cstdio>
#include <memory>

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

    // LuaConfig::Load tries <basePath>.config.lua first, then
    // <basePath>.config.json. Both end up in the same LuaParser-backed
    // representation so the rest of this function is format-agnostic.
    std::unique_ptr<LuaParser> parser = LuaConfig::Load(basePath);
    if (!parser) {
        // Caller is expected to have probed for the file already; a
        // silent miss here just means "no config, keep defaults".
        return false;
    }

    const LuaTable root = parser->GetRoot();
    if (!root.IsValid()) {
        std::fprintf(stderr,
            "[config] %s: root is not a table (did the file forget "
            "`return <table>`?)\n",
            basePath.c_str());
        return false;
    }

    // ---- Schema version check ----
    // `configVersion` is mandatory on files produced by the current
    // modelimporter. A missing key means the file was produced by a
    // pre-versioning build and should be regenerated. An older-
    // than-current version means the file is from an earlier schema
    // and the reader may need to apply a workaround — there's
    // nothing to work around yet (we're at v1), so we just log and
    // carry on. For one release we also accept the legacy
    // `metaVersion` key that the pre-rename modelimporter emitted,
    // so caches under data/ keep working until they're refreshed.
    constexpr int kSupportedConfigVersion = 1;
    int configVersion = root.GetInt("configVersion", 0);
    if (configVersion == 0)
        configVersion = root.GetInt("metaVersion", 0);

    if (configVersion == 0) {
        std::fprintf(stderr,
            "[config] %s: no `configVersion` field — file predates the "
            "versioned schema. Run `modelimporter --update-meta` to "
            "regenerate.\n",
            basePath.c_str());
    } else if (configVersion < kSupportedConfigVersion) {
        std::fprintf(stderr,
            "[config] %s: configVersion=%d is older than this engine "
            "supports (%d). Run `modelimporter --update-meta` to "
            "regenerate; the sim will continue with best-effort "
            "parsing.\n",
            basePath.c_str(), configVersion, kSupportedConfigVersion);
    } else if (configVersion > kSupportedConfigVersion) {
        std::fprintf(stderr,
            "[config] %s: configVersion=%d is newer than this engine "
            "understands (%d). Some fields may be ignored.\n",
            basePath.c_str(), configVersion, kSupportedConfigVersion);
    }

    // ---- Top-level bounds ----
    out.radius    = root.GetFloat("radius", 1.0f);
    out.height    = root.GetFloat("height", 1.0f);
    out.relMidPos = ReadFloat3Field(root, "midpos", float3(0, 0, 0));
    out.mins      = ReadFloat3Field(root, "mins",   float3(-1, -1, -1));
    out.maxs      = ReadFloat3Field(root, "maxs",   float3( 1,  1,  1));

    // ---- Piece tree ----
    const LuaTable pieces = root.SubTable("pieces");
    if (pieces.IsValid()) {
        const int numPieces = pieces.GetLength();
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
            piece.name   = p.GetString("name", "");
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

    std::fprintf(stderr,
        "[config] loaded %s: radius=%.2f height=%.2f pieces=%d\n",
        basePath.c_str(), out.radius, out.height, out.numPieces);
    return true;
}
