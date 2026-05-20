// JsonWriter — see header for schema and ownership rules.
//
// Transitional code: Phase 1 of PLAN-pbr-mapping.md will replace this
// entirely by embedding the same fields in a `SPRINGRTS_geometry`
// document-level extension inside the .gltf itself. Until then we
// still emit a sibling `<stem>.config.json` for the runtime to read.

#include "JsonWriter.h"

#include <assimp/scene.h>
#include <assimp/material.h>

#include <nlohmann/json.hpp>

#include <algorithm>
#include <cmath>
#include <cstdio>
#include <cstring>
#include <fstream>
#include <limits>
#include <string>
#include <vector>

namespace {

using json = nlohmann::json;

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
// Numeric formatting — match the legacy 5-significant-digit float
// formatting so the regenerated files stay byte-identical (modulo
// nlohmann's known ordering) to the baseline. nlohmann's default
// dump() uses up to 17 digits for doubles; for our 5-digit budget we
// pre-round each float and store it as a `json` number via the
// `dump(precision)` overload? That overload doesn't exist — instead
// we round into a string, parse back, and store.
// -----------------------------------------------------------------

/// Round `v` to 5 significant digits and return it as a JSON number
/// node. NaN and infinities are coerced to 0 (the legacy code did the
/// same, and AABBs are zeroed before reaching here).
json JsonFloat(float v) {
    if (!std::isfinite(v)) return json(0);
    char buf[32];
    std::snprintf(buf, sizeof(buf), "%.5g", v);
    // Re-parse so nlohmann stores it as a number, not a string. The
    // serialiser will emit it without trailing zeros.
    try {
        return json::parse(buf);
    } catch (const json::parse_error&) {
        return json(0);
    }
}

/// Build a `[x, y, z]` JSON array using the same 5-digit formatting.
json JsonVec3(float x, float y, float z) {
    return json::array({ JsonFloat(x), JsonFloat(y), JsonFloat(z) });
}

} // namespace

// =====================================================================

bool JsonWriter::Write(const aiScene* scene,
                       const std::string& outPath,
                       const std::string& sourceModelPath)
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
    //
    // Filenames are rewritten to `.ktx2` here so the runtime always
    // resolves a single canonical extension regardless of what the
    // source archive happened to ship.
    auto rewriteToKtx2 = [](std::string& name) {
        if (name.empty()) return;
        const auto dot = name.find_last_of('.');
        const auto slash = name.find_last_of("/\\");
        if (dot == std::string::npos ||
            (slash != std::string::npos && dot < slash)) {
            name += ".ktx2";
        } else {
            name = name.substr(0, dot) + ".ktx2";
        }
    };
    std::string tex1, tex2;
    if (scene->mNumMaterials > 0 && scene->mMaterials != nullptr) {
        const aiMaterial* mat = scene->mMaterials[0];
        aiString s;
        if (mat->GetTexture(aiTextureType_DIFFUSE, 0, &s) == AI_SUCCESS) {
            tex1.assign(s.C_Str(), s.length);
            rewriteToKtx2(tex1);
        }
        if (mat->GetTexture(aiTextureType_SPECULAR, 0, &s) == AI_SUCCESS) {
            tex2.assign(s.C_Str(), s.length);
            rewriteToKtx2(tex2);
        }
    }

    // Spring author-config fallback: legacy `.dae` / `.fbx` archives
    // store tex1 / tex2 in a sibling `<modelname>.<ext>.lua` file
    // because the on-disk model format has no native Spring-style
    // texture binding. Assimp can't see those — we parse them out by
    // simple string matching (the file is small and the keys are
    // unambiguous). Only consulted when Assimp didn't already pick
    // up a texture for that slot, so S3O imports keep their existing
    // behaviour.
    if ((tex1.empty() || tex2.empty()) && !sourceModelPath.empty()) {
        const std::string springLua = sourceModelPath + ".lua";
        std::ifstream lua(springLua, std::ios::binary);
        if (lua) {
            const std::string txt{std::istreambuf_iterator<char>(lua),
                                  std::istreambuf_iterator<char>()};
            auto readLuaField = [&](const std::string& key) -> std::string {
                size_t k = txt.find(key);
                if (k == std::string::npos) return {};
                size_t q1 = txt.find('"', k + key.size());
                if (q1 == std::string::npos) return {};
                size_t q2 = txt.find('"', q1 + 1);
                if (q2 == std::string::npos) return {};
                return txt.substr(q1 + 1, q2 - q1 - 1);
            };
            if (tex1.empty()) {
                tex1 = readLuaField("tex1");
                rewriteToKtx2(tex1);
            }
            if (tex2.empty()) {
                tex2 = readLuaField("tex2");
                rewriteToKtx2(tex2);
            }
        }
    }

    // ---- Build the JSON document ----
    //
    // nlohmann::json's `ordered_json` is overkill here — the engine
    // reader doesn't care about field order. We use the default
    // unordered `json` for normal use; the key order in the output
    // is deterministic (alphabetical) and stable across runs.
    //
    // Z-axis values are RH-canonical: offsets are negated and min/max Z
    // values are swapped-and-negated so the AABB stays valid under the
    // LH→RH flip the .glb itself receives at export time. See
    // PLAN-coordinate-system.md.
    json doc;
    doc["configVersion"] = JsonWriter::kCurrentConfigVersion;
    doc["radius"] = JsonFloat(radius);
    doc["height"] = JsonFloat(height);
    doc["midpos"] = JsonVec3(midX, midY, -midZ);
    doc["mins"]   = JsonVec3(bounds.minX, bounds.minY, -bounds.maxZ);
    doc["maxs"]   = JsonVec3(bounds.maxX, bounds.maxY, -bounds.minZ);

    if (!tex1.empty()) doc["tex1"] = tex1;
    if (!tex2.empty()) doc["tex2"] = tex2;

    json piecesArray = json::array();
    for (const auto& p : pieces) {
        json pj;
        pj["name"]   = p.name;
        pj["parent"] = p.parentIndex;
        pj["offset"] = JsonVec3(p.offsetX, p.offsetY, -p.offsetZ);
        pj["mins"]   = JsonVec3(p.localBounds.minX,
                                p.localBounds.minY,
                                -p.localBounds.maxZ);
        pj["maxs"]   = JsonVec3(p.localBounds.maxX,
                                p.localBounds.maxY,
                                -p.localBounds.minZ);
        piecesArray.push_back(std::move(pj));
    }
    doc["pieces"] = std::move(piecesArray);

    if (!attachments.empty()) {
        json attArray = json::array();
        for (const auto& a : attachments) {
            json aj;
            aj["kind"]  = a.kind;
            aj["name"]  = a.name;
            aj["piece"] = a.pieceIndex;
            attArray.push_back(std::move(aj));
        }
        doc["attachments"] = std::move(attArray);
    }

    // ---- Write the JSON file ----
    std::ofstream out(outPath, std::ios::binary);
    if (!out) {
        std::fprintf(stderr,
            "modelimporter: failed to open %s for writing\n",
            outPath.c_str());
        return false;
    }
    out << doc.dump(2) << '\n';
    return out.good();
}
