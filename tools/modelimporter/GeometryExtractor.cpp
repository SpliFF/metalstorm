// GeometryExtractor — see header for the produced schema.
//
// Lifted from JsonWriter.cpp (which is being retired). The same
// numeric output is produced for any given scene; only the surrounding
// container differs (in-gltf extension vs. sibling .config.json).

#include "GeometryExtractor.h"

#include <assimp/scene.h>

#include <algorithm>
#include <cmath>
#include <cstdio>
#include <cstring>
#include <limits>
#include <string>
#include <vector>

namespace {

using json = nlohmann::json;

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

inline void TransformPoint(const aiMatrix4x4& m, float x, float y, float z,
                           float& ox, float& oy, float& oz) {
    ox = m.a1 * x + m.a2 * y + m.a3 * z + m.a4;
    oy = m.b1 * x + m.b2 * y + m.b3 * z + m.b4;
    oz = m.c1 * x + m.c2 * y + m.c3 * z + m.c4;
}

void CollectWorldspaceVertices(const aiScene* scene,
                               const aiNode* node,
                               const aiMatrix4x4& parentXform,
                               Aabb& out) {
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

float RadiusFromAabb(const Aabb& b) {
    const float ax = std::max(std::fabs(b.minX), std::fabs(b.maxX));
    const float ay = std::max(std::fabs(b.minY), std::fabs(b.maxY));
    const float az = std::max(std::fabs(b.minZ), std::fabs(b.maxZ));
    return std::sqrt(ax * ax + ay * ay + az * az);
}

struct PieceRecord {
    std::string name;
    int parentIndex = -1;
    float offsetX = 0, offsetY = 0, offsetZ = 0;
    Aabb localBounds;
};

void FlattenPieces(const aiScene* scene,
                   const aiNode* node,
                   int parentIndex,
                   std::vector<PieceRecord>& pieces) {
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

/// Round `v` to 5 significant digits and return it as a JSON number
/// node. NaN and infinities are coerced to 0. Pre-rounding matches the
/// legacy JsonWriter output so regenerated files diff cleanly against
/// the v6 baseline.
json JsonFloat(float v) {
    if (!std::isfinite(v)) return json(0);
    char buf[32];
    std::snprintf(buf, sizeof(buf), "%.5g", v);
    try {
        return json::parse(buf);
    } catch (const json::parse_error&) {
        return json(0);
    }
}

json JsonVec3(float x, float y, float z) {
    return json::array({ JsonFloat(x), JsonFloat(y), JsonFloat(z) });
}

} // namespace

nlohmann::json GeometryExtractor::BuildExtensionJson(const aiScene* scene) {
    Aabb bounds;
    if (scene != nullptr && scene->mRootNode != nullptr) {
        CollectWorldspaceVertices(scene, scene->mRootNode, aiMatrix4x4{}, bounds);
    }
    bounds.MakeZeroIfInvalid();

    const float radius = RadiusFromAabb(bounds);
    const float height = bounds.maxY - bounds.minY;
    const float midX = (bounds.minX + bounds.maxX) * 0.5f;
    const float midY = (bounds.minY + bounds.maxY) * 0.5f;
    const float midZ = (bounds.minZ + bounds.maxZ) * 0.5f;

    // Flatten piece tree. Skip the synthetic scene-root wrapper most
    // Assimp importers add — recognise it as: meshless, single child,
    // identity transform.
    std::vector<PieceRecord> pieces;
    if (scene != nullptr && scene->mRootNode != nullptr) {
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

    // Coordinate convention: RH-canonical. Z axis is negated, AABB
    // min/max swap-and-negate to keep min <= max under the flip.
    json doc;
    doc["configVersion"] = GeometryExtractor::kCurrentSchemaVersion;
    doc["radius"] = JsonFloat(radius);
    doc["height"] = JsonFloat(height);
    doc["midpos"] = JsonVec3(midX, midY, -midZ);
    doc["mins"]   = JsonVec3(bounds.minX, bounds.minY, -bounds.maxZ);
    doc["maxs"]   = JsonVec3(bounds.maxX, bounds.maxY, -bounds.minZ);

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

    return doc;
}
