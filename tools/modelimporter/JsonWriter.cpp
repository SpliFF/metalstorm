// JsonWriter — see header for schema and ownership rules.

#include "JsonWriter.h"

#include <assimp/scene.h>
#include <assimp/material.h>

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
// Geometry extraction (identical to the old .meta.lua writer — the
// schema fields are the same, only the serialiser changed)
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

/// Transform a point by a 4x4 affine matrix (ignore the w row).
inline void TransformPoint(const aiMatrix4x4& m, float x, float y, float z,
                           float& ox, float& oy, float& oz)
{
    ox = m.a1 * x + m.a2 * y + m.a3 * z + m.a4;
    oy = m.b1 * x + m.b2 * y + m.b3 * z + m.b4;
    oz = m.c1 * x + m.c2 * y + m.c3 * z + m.c4;
}

/// Accumulate world-space mesh vertices under `node` into `out`.
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

/// Bounding sphere around the model origin, derived from the AABB.
/// Not the tightest possible — a full Welzl sphere is overkill for
/// a preprocess step and the sim only needs an upper bound.
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
/// are the AABB of this node's direct meshes only (descendants
/// become separate pieces).
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
// Attachment point detection
// -----------------------------------------------------------------

/// Classify a piece name as an attachment point. Case-insensitive.
/// Matches the common Spring modelling conventions:
///   aim, aim_<N>      — weapon aim positions
///   fire, fire_<N>    — projectile emission points
///   emit_<name>       — particle emitters
///   hp_<name>,
///   hpoint_<name>     — generic hardpoints
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
// JSON serialiser — we only emit numbers, strings, arrays and
// objects, and both the keys and field names are ASCII, so a
// minimal handrolled writer is simpler than pulling in a JSON
// library. All state flows through a single `std::ostream&`.
// -----------------------------------------------------------------

/// Format a float for JSON output. ~5 significant digits is enough
/// for collision/rendering needs and keeps the files diffable.
std::string JsonNumber(float v) {
    char buf[32];
    std::snprintf(buf, sizeof(buf), "%.5g", v);
    // JSON requires the literal values `Infinity`/`NaN` (non-standard
    // extensions) or simply doesn't allow them. Our float fields are
    // always finite by construction (we seed AABB with infinity but
    // MakeZeroIfInvalid zeroes it out before we get here), but clamp
    // defensively anyway so we never emit `inf` / `nan`.
    if (std::strcmp(buf, "inf")  == 0 ||
        std::strcmp(buf, "-inf") == 0 ||
        std::strcmp(buf, "nan")  == 0) {
        return "0";
    }
    return buf;
}

/// Escape a string for inclusion inside a JSON "…" literal. Follows
/// RFC 8259 escaping rules: `\"`, `\\`, control chars as `\uXXXX`.
std::string JsonString(const std::string& s) {
    std::string out;
    out.reserve(s.size() + 2);
    out.push_back('"');
    for (unsigned char c : s) {
        switch (c) {
            case '"':  out += "\\\""; break;
            case '\\': out += "\\\\"; break;
            case '\b': out += "\\b";  break;
            case '\f': out += "\\f";  break;
            case '\n': out += "\\n";  break;
            case '\r': out += "\\r";  break;
            case '\t': out += "\\t";  break;
            default:
                if (c < 0x20) {
                    char buf[8];
                    std::snprintf(buf, sizeof(buf), "\\u%04x", c);
                    out += buf;
                } else {
                    out.push_back(static_cast<char>(c));
                }
        }
    }
    out.push_back('"');
    return out;
}

/// Helper for writing a `[x, y, z]` triple on one line.
std::string Vec3(float x, float y, float z) {
    return "[" + JsonNumber(x) + ", " + JsonNumber(y) + ", " + JsonNumber(z) + "]";
}

} // namespace

// =====================================================================

bool JsonWriter::Write(const aiScene* scene, const std::string& outPath)
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
    // hygiene (glTF expects a root, various post-processing steps
    // assume one). Skip that wrapper only if it's unambiguously
    // synthetic: meshless, single-child, identity-transformed. Any
    // other shape keeps the original root so we don't silently drop
    // authored data.
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

    // ---- Collect attachment points ----
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

    // ---- Extract texture references from the first material ----
    //
    // S3OImporter populates a single material per scene with the original
    // texture filenames Spring expects to find under `unittextures/`:
    //   AI_MATKEY_TEXTURE_DIFFUSE(0)  → tex1 (diffuse)
    //   AI_MATKEY_TEXTURE_SPECULAR(0) → tex2 (team-colour mask)
    // For non-S3O formats the slot mapping is whatever Assimp's importer
    // for that format chose; we read the same slots and accept whatever
    // we find there. Hand-authored .config.lua files always win when
    // present (modelimporter skips emitting JSON in that case), so this
    // only affects machine-converted models.
    std::string tex1, tex2;
    if (scene->mNumMaterials > 0 && scene->mMaterials != nullptr) {
        const aiMaterial* mat = scene->mMaterials[0];
        aiString s;
        if (mat->GetTexture(aiTextureType_DIFFUSE, 0, &s) == AI_SUCCESS) {
            tex1.assign(s.C_Str(), s.length);
        }
        if (mat->GetTexture(aiTextureType_SPECULAR, 0, &s) == AI_SUCCESS) {
            tex2.assign(s.C_Str(), s.length);
        }
    }

    // ---- Write the JSON file ----
    std::ofstream out(outPath, std::ios::binary);
    if (!out) {
        std::fprintf(stderr,
            "modelimporter: failed to open %s for writing\n",
            outPath.c_str());
        return false;
    }

    // Hand-indented for readability — the file is small and the
    // schema is fixed, so a pretty-printer would be overkill.
    out << "{\n";

    // Schema version — the engine-side reader branches on this.
    out << "  \"configVersion\": " << JsonWriter::kCurrentConfigVersion << ",\n";
    out << "\n";

    // Bounds
    out << "  \"radius\": " << JsonNumber(radius) << ",\n";
    out << "  \"height\": " << JsonNumber(height) << ",\n";
    out << "  \"midpos\": " << Vec3(midX, midY, midZ) << ",\n";
    out << "  \"mins\":   " << Vec3(bounds.minX, bounds.minY, bounds.minZ) << ",\n";
    out << "  \"maxs\":   " << Vec3(bounds.maxX, bounds.maxY, bounds.maxZ) << ",\n";

    // Texture references — only emitted when present in the source.
    // These are bare filenames as recorded in the original model file
    // (e.g. `commrecon.dds`); the client resolves them via the game's
    // `unittextures/` directory.
    if (!tex1.empty()) out << "\n  \"tex1\": " << JsonString(tex1) << ",\n";
    if (!tex2.empty()) out << "  \"tex2\": " << JsonString(tex2) << ",\n";

    // Pieces — flat list ordered by pre-order walk.
    out << "\n  \"pieces\": [\n";
    for (size_t i = 0; i < pieces.size(); ++i) {
        const auto& p = pieces[i];
        out << "    { \"name\": " << JsonString(p.name)
            << ", \"parent\": " << p.parentIndex
            << ", \"offset\": " << Vec3(p.offsetX, p.offsetY, p.offsetZ)
            << ", \"mins\": "   << Vec3(p.localBounds.minX, p.localBounds.minY, p.localBounds.minZ)
            << ", \"maxs\": "   << Vec3(p.localBounds.maxX, p.localBounds.maxY, p.localBounds.maxZ)
            << " }";
        if (i + 1 < pieces.size()) out << ",";
        out << "\n";
    }
    out << "  ]";

    // Attachments (optional — only emitted if any were discovered).
    if (!attachments.empty()) {
        out << ",\n\n  \"attachments\": [\n";
        for (size_t i = 0; i < attachments.size(); ++i) {
            const auto& a = attachments[i];
            out << "    { \"kind\": " << JsonString(a.kind)
                << ", \"name\": " << JsonString(a.name)
                << ", \"piece\": " << a.pieceIndex
                << " }";
            if (i + 1 < attachments.size()) out << ",";
            out << "\n";
        }
        out << "  ]";
    }

    out << "\n}\n";
    return out.good();
}
