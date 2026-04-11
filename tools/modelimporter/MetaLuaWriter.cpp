// MetaLuaWriter — see header for rationale.

#include "MetaLuaWriter.h"

#include <assimp/scene.h>
#include <assimp/postprocess.h>

#include <algorithm>
#include <cmath>
#include <cstdio>
#include <cstring>
#include <fstream>
#include <limits>
#include <string>
#include <vector>

namespace {

// -----------------------------------------------------------------
// Geometry extraction
// -----------------------------------------------------------------

/// Axis-aligned bounding box in model space.
struct Aabb {
    float minX =  std::numeric_limits<float>::infinity();
    float minY =  std::numeric_limits<float>::infinity();
    float minZ =  std::numeric_limits<float>::infinity();
    float maxX = -std::numeric_limits<float>::infinity();
    float maxY = -std::numeric_limits<float>::infinity();
    float maxZ = -std::numeric_limits<float>::infinity();

    void Add(float x, float y, float z) {
        if (x < minX) minX = x;
        if (y < minY) minY = y;
        if (z < minZ) minZ = z;
        if (x > maxX) maxX = x;
        if (y > maxY) maxY = y;
        if (z > maxZ) maxZ = z;
    }

    bool Valid() const { return minX <= maxX; }
    void MakeZeroIfInvalid() {
        if (!Valid()) {
            minX = minY = minZ = 0;
            maxX = maxY = maxZ = 0;
        }
    }
};

/// Apply a transform to a vector by multiplying through the matrix,
/// ignoring the w row since Assimp scene transforms are affine.
inline void TransformPoint(const aiMatrix4x4& m, float x, float y, float z,
                           float& ox, float& oy, float& oz)
{
    ox = m.a1 * x + m.a2 * y + m.a3 * z + m.a4;
    oy = m.b1 * x + m.b2 * y + m.b3 * z + m.b4;
    oz = m.c1 * x + m.c2 * y + m.c3 * z + m.c4;
}

/// Accumulate vertices from every mesh referenced by `node` (and all
/// its descendants) into `out`, transformed into the model's root
/// coordinate space by composing node transforms along the way.
void CollectWorldspaceVertices(const aiScene* scene,
                               const aiNode* node,
                               const aiMatrix4x4& parentXform,
                               Aabb& out)
{
    const aiMatrix4x4 xform = parentXform * node->mTransformation;

    for (unsigned int i = 0; i < node->mNumMeshes; ++i) {
        const aiMesh* mesh = scene->mMeshes[node->mMeshes[i]];
        for (unsigned int v = 0; v < mesh->mNumVertices; ++v) {
            const auto& p = mesh->mVertices[v];
            float wx, wy, wz;
            TransformPoint(xform, p.x, p.y, p.z, wx, wy, wz);
            out.Add(wx, wy, wz);
        }
    }
    for (unsigned int c = 0; c < node->mNumChildren; ++c) {
        CollectWorldspaceVertices(scene, node->mChildren[c], xform, out);
    }
}

/// Compute a bounding sphere radius around the model origin from an
/// AABB. Not the tightest possible — a full Welzl sphere is overkill
/// for a preprocess step, and the sim only needs an upper bound.
float RadiusFromAabb(const Aabb& b) {
    const float ax = std::max(std::fabs(b.minX), std::fabs(b.maxX));
    const float ay = std::max(std::fabs(b.minY), std::fabs(b.maxY));
    const float az = std::max(std::fabs(b.minZ), std::fabs(b.maxZ));
    return std::sqrt(ax * ax + ay * ay + az * az);
}

// -----------------------------------------------------------------
// Piece tree
// -----------------------------------------------------------------

struct PieceRecord {
    std::string name;
    int parentIndex = -1;         // -1 for root
    float offsetX = 0, offsetY = 0, offsetZ = 0;
    Aabb localBounds;
};

/// Walk the aiNode hierarchy starting at `node` in pre-order,
/// flattening it into `pieces`. Each piece's offset is taken from
/// the local translation component of its node transform; mins/maxs
/// are the AABB of this node's direct meshes (not including
/// descendants, which become separate pieces).
void FlattenPieces(const aiScene* scene,
                   const aiNode* node,
                   int parentIndex,
                   std::vector<PieceRecord>& pieces)
{
    const aiMatrix4x4& m = node->mTransformation;
    PieceRecord rec;
    rec.name = node->mName.C_Str();
    rec.parentIndex = parentIndex;
    rec.offsetX = m.a4;
    rec.offsetY = m.b4;
    rec.offsetZ = m.c4;

    // Direct-mesh bounds (in the node's own local space, not world).
    for (unsigned int i = 0; i < node->mNumMeshes; ++i) {
        const aiMesh* mesh = scene->mMeshes[node->mMeshes[i]];
        for (unsigned int v = 0; v < mesh->mNumVertices; ++v) {
            const auto& p = mesh->mVertices[v];
            rec.localBounds.Add(p.x, p.y, p.z);
        }
    }
    rec.localBounds.MakeZeroIfInvalid();

    const int myIndex = static_cast<int>(pieces.size());
    pieces.push_back(std::move(rec));

    for (unsigned int c = 0; c < node->mNumChildren; ++c) {
        FlattenPieces(scene, node->mChildren[c], myIndex, pieces);
    }
}

// -----------------------------------------------------------------
// Attachment points
// -----------------------------------------------------------------

/// Classify a piece name as an attachment point. Matches Spring's
/// piece-naming conventions plus the common modeller shorthands:
///   aimpos, aim_<N>    — weapon aim positions
///   firepos, fire_<N>  — projectile emission points
///   emit_<name>        — particle emitters
///   hp_<name>, hpoint_ — generic hardpoints
bool IsAttachmentName(const std::string& name, std::string& outKind) {
    auto startsWith = [&](const char* prefix) {
        const size_t n = std::strlen(prefix);
        return name.size() >= n && std::equal(name.begin(), name.begin() + n, prefix,
            [](char a, char b) { return std::tolower(a) == std::tolower(b); });
    };
    if (startsWith("aim"))   { outKind = "aim";   return true; }
    if (startsWith("fire"))  { outKind = "fire";  return true; }
    if (startsWith("emit"))  { outKind = "emit";  return true; }
    if (startsWith("hp_"))   { outKind = "hp";    return true; }
    if (startsWith("hpoint")){ outKind = "hp";    return true; }
    return false;
}

// -----------------------------------------------------------------
// Lua serialiser
// -----------------------------------------------------------------

/// Header comment emitted at the top of every generated file. Makes
/// it obvious at a glance that the file is engine output and also
/// serves as a human-readable pointer to the --update-meta flow.
constexpr const char* kGeneratorMarker =
    "-- Generated by modelimporter. Edit freely — re-run with\n"
    "-- `modelimporter --update-meta <input> <output>` to regenerate\n"
    "-- from the source model. Without --update-meta, an existing\n"
    "-- meta file is never overwritten.";

/// Format a float for the lua output. We want enough precision for
/// collision / rendering needs (~5 decimal digits) but not so much
/// that the files become illegible.
std::string FloatLit(float v) {
    char buf[32];
    std::snprintf(buf, sizeof(buf), "%.5g", v);
    return buf;
}

/// Escape a string for inclusion inside a double-quoted lua literal.
/// We only need to handle \ and " — piece names never contain
/// control characters in any real content.
std::string EscapeString(const std::string& s) {
    std::string out;
    out.reserve(s.size() + 2);
    for (char c : s) {
        if (c == '\\' || c == '"') out.push_back('\\');
        out.push_back(c);
    }
    return out;
}

} // namespace

// =====================================================================

bool MetaLuaWriter::Write(const aiScene* scene,
                          const std::string& outPath)
{
    // ---- Extract bounding box and bounding sphere ----
    Aabb bounds;
    if (scene->mRootNode != nullptr) {
        CollectWorldspaceVertices(scene, scene->mRootNode, aiMatrix4x4{}, bounds);
    }
    bounds.MakeZeroIfInvalid();

    const float radius = RadiusFromAabb(bounds);
    const float height = bounds.maxY - bounds.minY;
    const float midX = (bounds.minX + bounds.maxX) * 0.5f;
    const float midY = (bounds.minY + bounds.maxY) * 0.5f;
    const float midZ = (bounds.minZ + bounds.maxZ) * 0.5f;

    // ---- Flatten the piece tree ----
    //
    // Most Assimp importers — ours included — wrap the real model
    // root in a synthetic scene-root `aiNode` for scene-graph
    // hygiene (a glTF export needs a root and various post-
    // processing steps assume one). Our S3O importer does the
    // same, producing a meshless `S3O_<filename>` node with the
    // actual piece tree as its single child. The wrapper has no
    // meaning to the sim: every piece consumer downstream
    // (Spring.GetUnitPieceList, COB script indices, Shatter)
    // sees it as a phantom first entry that game authors can't
    // meaningfully reference and would have to work around.
    //
    // Skip the scene root only if it's unambiguously a synthetic
    // wrapper:
    //   - meshless
    //   - exactly one child
    //   - identity transform (no offset/rotation/scale that we'd
    //     lose by descending past it)
    // Any other shape — a real multi-root model, a root with its
    // own geometry, or a pass-through node with a non-trivial
    // transform — keeps the original root so we don't silently
    // drop authored data.
    std::vector<PieceRecord> pieces;
    if (scene->mRootNode != nullptr) {
        const aiNode* pieceRoot = scene->mRootNode;
        const aiMatrix4x4& rt = pieceRoot->mTransformation;
        const bool identity =
            rt.a1 == 1 && rt.a2 == 0 && rt.a3 == 0 && rt.a4 == 0 &&
            rt.b1 == 0 && rt.b2 == 1 && rt.b3 == 0 && rt.b4 == 0 &&
            rt.c1 == 0 && rt.c2 == 0 && rt.c3 == 1 && rt.c4 == 0;

        if (pieceRoot->mNumMeshes == 0 &&
            pieceRoot->mNumChildren == 1 &&
            identity) {
            pieceRoot = pieceRoot->mChildren[0];
        }

        FlattenPieces(scene, pieceRoot, -1, pieces);
    }

    // ---- Collect attachment points from the piece tree ----
    struct Attachment {
        std::string kind;
        std::string name;
        int pieceIndex;
    };
    std::vector<Attachment> attachments;
    for (size_t i = 0; i < pieces.size(); ++i) {
        std::string kind;
        if (IsAttachmentName(pieces[i].name, kind)) {
            attachments.push_back({kind, pieces[i].name, static_cast<int>(i)});
        }
    }

    // ---- Write the meta.lua ----
    std::ofstream out(outPath, std::ios::binary);
    if (!out) {
        std::fprintf(stderr,
            "modelimporter: failed to open %s for writing\n",
            outPath.c_str());
        return false;
    }

    out << kGeneratorMarker << "\n\n";

    out << "local meta = {\n";

    // Schema version — the engine-side reader branches on this.
    // Bump `kCurrentMetaVersion` in MetaLuaWriter.h whenever the
    // layout changes in a way an older reader wouldn't handle.
    out << "    metaVersion = " << MetaLuaWriter::kCurrentMetaVersion << ",\n\n";

    // Bounds
    out << "    radius = " << FloatLit(radius) << ",\n";
    out << "    height = " << FloatLit(height) << ",\n";
    out << "    midpos = {" << FloatLit(midX) << ", " << FloatLit(midY) << ", " << FloatLit(midZ) << "},\n";
    out << "    mins   = {" << FloatLit(bounds.minX) << ", " << FloatLit(bounds.minY) << ", " << FloatLit(bounds.minZ) << "},\n";
    out << "    maxs   = {" << FloatLit(bounds.maxX) << ", " << FloatLit(bounds.maxY) << ", " << FloatLit(bounds.maxZ) << "},\n";

    // Pieces — flat list ordered by pre-order walk. Parent index
    // refers back into the same list (0-based); lua consumers add 1
    // when addressing. -1 for the root.
    out << "\n    pieces = {\n";
    for (size_t i = 0; i < pieces.size(); ++i) {
        const auto& p = pieces[i];
        out << "        { name = \"" << EscapeString(p.name) << "\""
            << ", parent = " << p.parentIndex
            << ", offset = {" << FloatLit(p.offsetX) << ", " << FloatLit(p.offsetY) << ", " << FloatLit(p.offsetZ) << "}"
            << ", mins = {" << FloatLit(p.localBounds.minX) << ", " << FloatLit(p.localBounds.minY) << ", " << FloatLit(p.localBounds.minZ) << "}"
            << ", maxs = {" << FloatLit(p.localBounds.maxX) << ", " << FloatLit(p.localBounds.maxY) << ", " << FloatLit(p.localBounds.maxZ) << "}"
            << " },\n";
    }
    out << "    },\n";

    // Attachments (optional — only written if any were discovered).
    if (!attachments.empty()) {
        out << "\n    attachments = {\n";
        for (const auto& a : attachments) {
            out << "        { kind = \"" << EscapeString(a.kind) << "\""
                << ", name = \"" << EscapeString(a.name) << "\""
                << ", piece = " << a.pieceIndex
                << " },\n";
        }
        out << "    },\n";
    }

    out << "}\n\n";
    out << "return meta\n";
    return out.good();
}
