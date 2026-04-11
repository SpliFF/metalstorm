/* This file is part of the Spring engine (GPL v2 or later), see LICENSE.html */

#include "MetaLuaModelLoader.h"

#include "Lua/LuaParser.h"
#include "Sim/Units/Scripts/LocalModelPieceStub.h"

#include <cstdio>
#include <filesystem>

namespace {

/// Pull a float3 field from a piece sub-table. `.meta.lua` stores
/// pieces as `{ offset = {x,y,z}, mins = {...}, maxs = {...} }`
/// which LuaParser exposes as nested sub-tables indexed by 1/2/3.
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

S3DModel* MetaLuaModelLoader::Load(const std::string& metaPath) {
    auto* model = new S3DModel();
    if (!LoadInto(*model, metaPath)) {
        delete model;
        return nullptr;
    }
    return model;
}

bool MetaLuaModelLoader::LoadInto(S3DModel& out, const std::string& metaPath) {
    namespace fs = std::filesystem;

    if (metaPath.empty() || !fs::exists(metaPath)) {
        // Caller is expected to have probed the file already; a
        // silent miss here just means "no metadata, keep defaults".
        return false;
    }

    // LuaParser wants an accessMode + fileMode pair for VFS
    // routing. Neither applies to our plain-directory filesystem;
    // SPRING_VFS_RAW lets it open the file directly without
    // searching content roots.
    LuaParser parser(
        metaPath,
        SPRING_VFS_RAW,
        SPRING_VFS_RAW,
        LuaParser::boolean{false},  // not synced — parsed at unit load
        LuaParser::boolean{true});  // auto-setup

    if (!parser.Execute()) {
        std::fprintf(stderr,
            "[meta] failed to parse %s:\n"
            "       %s\n",
            metaPath.c_str(), parser.GetErrorLog().c_str());
        return false;
    }
    if (!parser.GetErrorLog().empty()) {
        std::fprintf(stderr,
            "[meta] non-fatal warnings parsing %s:\n"
            "       %s\n",
            metaPath.c_str(), parser.GetErrorLog().c_str());
    }

    const LuaTable root = parser.GetRoot();
    if (!root.IsValid()) {
        std::fprintf(stderr,
            "[meta] %s: root is not a table (did the file forget "
            "`return meta`?)\n",
            metaPath.c_str());
        return false;
    }

    // ---- Schema version check ----
    // `metaVersion` is mandatory on new files (emitted by the
    // current MetaLuaWriter). A missing key means the file was
    // produced by a pre-versioning build of modelimporter and
    // should be regenerated. An older-than-current version means
    // the file is from an earlier schema and the reader may need
    // to apply a workaround — there's nothing to work around yet
    // (we're at v1), so we just log and carry on.
    constexpr int kSupportedMetaVersion = 1;
    const int metaVersion = root.GetInt("metaVersion", 0);
    if (metaVersion == 0) {
        std::fprintf(stderr,
            "[meta] %s: no `metaVersion` field — file predates the "
            "versioned schema. Run `modelimporter --update-meta` "
            "to regenerate.\n",
            metaPath.c_str());
    } else if (metaVersion < kSupportedMetaVersion) {
        std::fprintf(stderr,
            "[meta] %s: metaVersion=%d is older than this engine "
            "supports (%d). Run `modelimporter --update-meta` to "
            "regenerate; the sim will continue with best-effort "
            "parsing.\n",
            metaPath.c_str(), metaVersion, kSupportedMetaVersion);
    } else if (metaVersion > kSupportedMetaVersion) {
        std::fprintf(stderr,
            "[meta] %s: metaVersion=%d is newer than this engine "
            "understands (%d). Some fields may be ignored.\n",
            metaPath.c_str(), metaVersion, kSupportedMetaVersion);
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
        // pointers yet because pushing into the vector may
        // reallocate and invalidate earlier addresses.
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

        // Second pass: link parent/children. `parent` index from
        // the meta file is 0-based; -1 marks the root.
        for (size_t i = 0; i < out.pieces.size(); ++i) {
            const int parentIdx = parentIndices[i];
            if (parentIdx >= 0 && static_cast<size_t>(parentIdx) < out.pieces.size()) {
                out.pieces[i].parent = &out.pieces[parentIdx];
                out.pieces[parentIdx].children.push_back(&out.pieces[i]);
            }
        }

        out.numPieces = static_cast<int>(out.pieces.size());
    }

    out.metaPath = metaPath;

    std::fprintf(stderr,
        "[meta] loaded %s: radius=%.2f height=%.2f pieces=%d\n",
        metaPath.c_str(), out.radius, out.height, out.numPieces);
    return true;
}
