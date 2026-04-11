// S3O importer for Assimp — implementation.
//
// See S3OImporter.h for the format spec and upstreaming notes.

#include "S3OImporter.h"

#include <assimp/IOSystem.hpp>
#include <assimp/IOStream.hpp>
#include <assimp/importerdesc.h>
#include <assimp/scene.h>
#include <assimp/material.h>
#include <assimp/DefaultLogger.hpp>
#include <assimp/Importer.hpp>

// Internal headers — these aren't part of the public API but are
// expected to be available to importer modules built inside the Assimp
// tree. They are also exported by the source distribution and resolve
// fine when including Assimp via FetchContent.
#include <assimp/DefaultIOSystem.h>

#include <cstring>
#include <memory>

namespace Assimp {

// ---------------------------------------------------------------------
// Format constants
// ---------------------------------------------------------------------

static constexpr char  S3O_MAGIC[12]   = { 'S','p','r','i','n','g',' ','u','n','i','t','\0' };
static constexpr size_t S3O_HEADER_SIZE = 52;
static constexpr size_t S3O_PIECE_SIZE  = 52;
static constexpr size_t S3O_VERTEX_SIZE = 32;

enum S3OPrimitiveType : uint32_t {
    S3O_PRIM_TRIANGLES      = 0,
    S3O_PRIM_TRIANGLE_STRIP = 1,
    S3O_PRIM_QUADS          = 2,
};

// ---------------------------------------------------------------------
// Importer descriptor
// ---------------------------------------------------------------------

static const aiImporterDesc s_desc = {
    "Spring RTS S3O Importer",
    "Spring/Spring RTS Web",
    "",                                            // maintainer
    "Loads Spring RTS unit/feature .s3o files",    // comments
    aiImporterFlags_SupportBinaryFlavour,
    0, 0, 0, 0,
    "s3o"
};

// ---------------------------------------------------------------------
// Construction / introspection
// ---------------------------------------------------------------------

S3OImporter::S3OImporter() = default;
S3OImporter::~S3OImporter() = default;

const aiImporterDesc* S3OImporter::GetInfo() const {
    return &s_desc;
}

bool S3OImporter::CanRead(const std::string& pFile,
                          IOSystem* pIOHandler,
                          bool checkSig) const {
    // Cheap path: extension match alone.
    if (!checkSig) {
        return SimpleExtensionCheck(pFile, "s3o");
    }
    // Signature path: open and look for "Spring unit\0".
    if (!pIOHandler) {
        return false;
    }
    std::unique_ptr<IOStream> file(pIOHandler->Open(pFile, "rb"));
    if (!file) {
        return false;
    }
    char header[12] = {0};
    if (file->Read(header, 1, sizeof(header)) != sizeof(header)) {
        return false;
    }
    return std::memcmp(header, S3O_MAGIC, 12) == 0;
}

// ---------------------------------------------------------------------
// Bound-checked little-endian read helpers
// ---------------------------------------------------------------------

template <typename T>
T S3OImporter::Read(const std::vector<uint8_t>& buf, size_t offset) {
    static_assert(std::is_trivially_copyable_v<T>, "trivially copyable required");
    if (offset + sizeof(T) > buf.size()) {
        throw DeadlyImportError("S3O: read past end of file at offset ",
                                std::to_string(offset));
    }
    T value;
    std::memcpy(&value, buf.data() + offset, sizeof(T));
    return value; // assumed little-endian; no host-swap (Spring is LE-only)
}

std::string S3OImporter::ReadString(const std::vector<uint8_t>& buf, size_t offset) {
    if (offset >= buf.size()) {
        return {};
    }
    const auto* p = reinterpret_cast<const char*>(buf.data() + offset);
    const size_t maxLen = buf.size() - offset;
    const size_t len = ::strnlen(p, maxLen);
    return std::string(p, len);
}

// ---------------------------------------------------------------------
// Piece tree → aiNode hierarchy + aiMesh list
// ---------------------------------------------------------------------

aiNode* S3OImporter::ReadPiece(const std::vector<uint8_t>& buf,
                               size_t pieceOffset,
                               std::vector<aiMesh*>& meshes,
                               unsigned int materialIndex,
                               const std::string& fileName) {
    if (pieceOffset + S3O_PIECE_SIZE > buf.size()) {
        throw DeadlyImportError("S3O: piece offset out of range in ", fileName);
    }

    const uint32_t nameOffset          = Read<uint32_t>(buf, pieceOffset +  0);
    const uint32_t numChildren         = Read<uint32_t>(buf, pieceOffset +  4);
    const uint32_t childrenOffset      = Read<uint32_t>(buf, pieceOffset +  8);
    const uint32_t numVertices         = Read<uint32_t>(buf, pieceOffset + 12);
    const uint32_t verticesOffset      = Read<uint32_t>(buf, pieceOffset + 16);
    /*const uint32_t vertexType*/        Read<uint32_t>(buf, pieceOffset + 20);
    const uint32_t primitiveType       = Read<uint32_t>(buf, pieceOffset + 24);
    const uint32_t vertexTableSize     = Read<uint32_t>(buf, pieceOffset + 28);
    const uint32_t vertexTableOffset   = Read<uint32_t>(buf, pieceOffset + 32);
    /*const uint32_t collisionDataOff*/  Read<uint32_t>(buf, pieceOffset + 36);
    const float    xoffset             = Read<float>(buf,    pieceOffset + 40);
    const float    yoffset             = Read<float>(buf,    pieceOffset + 44);
    const float    zoffset             = Read<float>(buf,    pieceOffset + 48);

    auto* node = new aiNode();
    node->mName = aiString(ReadString(buf, nameOffset));
    if (node->mName.length == 0) {
        node->mName = aiString(std::string("piece_") + std::to_string(pieceOffset));
    }

    // Local translation in S3O space. S3O uses Y-up, right-handed, same
    // as glTF — pass through directly.
    aiMatrix4x4 t;
    aiMatrix4x4::Translation(aiVector3D(xoffset, yoffset, zoffset), t);
    node->mTransformation = t;

    // ---- Geometry: build an aiMesh if this piece has any vertices ----
    if (numVertices > 0 && vertexTableSize > 0) {
        // Bounds check
        if (verticesOffset + numVertices * S3O_VERTEX_SIZE > buf.size()) {
            throw DeadlyImportError("S3O: vertex array out of range in ", fileName);
        }
        if (vertexTableOffset + vertexTableSize * sizeof(uint32_t) > buf.size()) {
            throw DeadlyImportError("S3O: index array out of range in ", fileName);
        }

        auto* mesh = new aiMesh();
        mesh->mMaterialIndex = materialIndex;
        mesh->mPrimitiveTypes = aiPrimitiveType_TRIANGLE;
        mesh->mNumVertices = numVertices;
        mesh->mVertices  = new aiVector3D[numVertices];
        mesh->mNormals   = new aiVector3D[numVertices];
        mesh->mTextureCoords[0]   = new aiVector3D[numVertices];
        mesh->mNumUVComponents[0] = 2;

        for (uint32_t i = 0; i < numVertices; ++i) {
            const size_t vo = verticesOffset + i * S3O_VERTEX_SIZE;
            mesh->mVertices[i] = aiVector3D(
                Read<float>(buf, vo +  0),
                Read<float>(buf, vo +  4),
                Read<float>(buf, vo +  8));
            mesh->mNormals[i] = aiVector3D(
                Read<float>(buf, vo + 12),
                Read<float>(buf, vo + 16),
                Read<float>(buf, vo + 20));
            mesh->mTextureCoords[0][i] = aiVector3D(
                Read<float>(buf, vo + 24),
                Read<float>(buf, vo + 28),
                0.0f);
        }

        // Read raw index list once.
        std::vector<uint32_t> indices(vertexTableSize);
        for (uint32_t i = 0; i < vertexTableSize; ++i) {
            indices[i] = Read<uint32_t>(buf, vertexTableOffset + i * sizeof(uint32_t));
        }

        // Convert primitive type → triangle list of aiFace.
        std::vector<std::array<uint32_t, 3>> tris;
        switch (primitiveType) {
            case S3O_PRIM_TRIANGLES: {
                tris.reserve(vertexTableSize / 3);
                for (uint32_t i = 0; i + 2 < vertexTableSize; i += 3) {
                    tris.push_back({indices[i], indices[i+1], indices[i+2]});
                }
                break;
            }
            case S3O_PRIM_TRIANGLE_STRIP: {
                // Standard strip → triangles, with primitive-restart on
                // duplicated indices (Spring's strip convention) and a
                // winding flip every other triangle.
                tris.reserve(vertexTableSize);
                for (uint32_t i = 0; i + 2 < vertexTableSize; ++i) {
                    const uint32_t a = indices[i];
                    const uint32_t b = indices[i+1];
                    const uint32_t c = indices[i+2];
                    // Degenerate triangle = strip restart marker; skip.
                    if (a == b || b == c || a == c) continue;
                    if ((i & 1u) == 0u) {
                        tris.push_back({a, b, c});
                    } else {
                        tris.push_back({a, c, b});
                    }
                }
                break;
            }
            case S3O_PRIM_QUADS: {
                tris.reserve((vertexTableSize / 4) * 2);
                for (uint32_t i = 0; i + 3 < vertexTableSize; i += 4) {
                    tris.push_back({indices[i],   indices[i+1], indices[i+2]});
                    tris.push_back({indices[i],   indices[i+2], indices[i+3]});
                }
                break;
            }
            default:
                throw DeadlyImportError("S3O: unsupported primitive type ",
                                        std::to_string(primitiveType),
                                        " in piece ", node->mName.C_Str());
        }

        mesh->mNumFaces = static_cast<unsigned int>(tris.size());
        mesh->mFaces    = new aiFace[mesh->mNumFaces];
        for (unsigned int f = 0; f < mesh->mNumFaces; ++f) {
            auto& face = mesh->mFaces[f];
            face.mNumIndices = 3;
            face.mIndices = new unsigned int[3];
            face.mIndices[0] = tris[f][0];
            face.mIndices[1] = tris[f][1];
            face.mIndices[2] = tris[f][2];
        }

        const unsigned int meshIndex = static_cast<unsigned int>(meshes.size());
        meshes.push_back(mesh);

        node->mNumMeshes = 1;
        node->mMeshes = new unsigned int[1];
        node->mMeshes[0] = meshIndex;
    }

    // ---- Recurse into children ----
    if (numChildren > 0) {
        if (childrenOffset + numChildren * sizeof(uint32_t) > buf.size()) {
            throw DeadlyImportError("S3O: child offset table out of range in ", fileName);
        }
        node->mNumChildren = numChildren;
        node->mChildren = new aiNode*[numChildren];
        for (uint32_t i = 0; i < numChildren; ++i) {
            const uint32_t childOff = Read<uint32_t>(buf,
                childrenOffset + i * sizeof(uint32_t));
            aiNode* child = ReadPiece(buf, childOff, meshes, materialIndex, fileName);
            child->mParent = node;
            node->mChildren[i] = child;
        }
    }

    return node;
}

// ---------------------------------------------------------------------
// Top-level entry point
// ---------------------------------------------------------------------

void S3OImporter::InternReadFile(const std::string& pFile,
                                 aiScene* pScene,
                                 IOSystem* pIOHandler) {
    std::unique_ptr<IOStream> file(pIOHandler->Open(pFile, "rb"));
    if (!file) {
        throw DeadlyImportError("S3O: failed to open ", pFile);
    }

    const size_t fileSize = file->FileSize();
    if (fileSize < S3O_HEADER_SIZE) {
        throw DeadlyImportError("S3O: file too small to contain header: ", pFile);
    }

    std::vector<uint8_t> buf(fileSize);
    if (file->Read(buf.data(), 1, fileSize) != fileSize) {
        throw DeadlyImportError("S3O: short read on ", pFile);
    }

    // Magic check
    if (std::memcmp(buf.data(), S3O_MAGIC, 12) != 0) {
        throw DeadlyImportError("S3O: bad magic in ", pFile);
    }

    // Header fields
    const uint32_t version            = Read<uint32_t>(buf, 12);
    /*const float radius            =*/Read<float>(buf, 16);
    /*const float height            =*/Read<float>(buf, 20);
    /*const float midx              =*/Read<float>(buf, 24);
    /*const float midy              =*/Read<float>(buf, 28);
    /*const float midz              =*/Read<float>(buf, 32);
    const uint32_t rootPieceOffset    = Read<uint32_t>(buf, 36);
    /*const uint32_t collisionDataOff =*/Read<uint32_t>(buf, 40);
    const uint32_t texture1Offset     = Read<uint32_t>(buf, 44);
    const uint32_t texture2Offset     = Read<uint32_t>(buf, 48);

    if (version != 0) {
        ASSIMP_LOG_WARN("S3O: unexpected version ", version,
                        " (only version 0 is documented)");
    }

    // ---- Build single material with the two texture references ----
    auto* material = new aiMaterial();
    {
        aiString matName(std::string("s3o_") +
                         pFile.substr(pFile.find_last_of("/\\") + 1));
        material->AddProperty(&matName, AI_MATKEY_NAME);

        // Spring uses unlit-style diffuse + a separate team-colour mask.
        // Map them to glTF as base color + specular slots respectively;
        // downstream content tooling can re-route as needed.
        if (texture1Offset != 0) {
            const std::string tex1 = ReadString(buf, texture1Offset);
            if (!tex1.empty()) {
                aiString s(tex1);
                // The glTF2 exporter promotes diffuse → baseColorTexture
                // automatically, and also routes it through aiTextureType_BASE_COLOR.
                material->AddProperty(&s, AI_MATKEY_TEXTURE_DIFFUSE(0));
                material->AddProperty(&s, AI_MATKEY_TEXTURE(aiTextureType_BASE_COLOR, 0));
            }
        }
        if (texture2Offset != 0) {
            const std::string tex2 = ReadString(buf, texture2Offset);
            if (!tex2.empty()) {
                aiString s(tex2);
                // Team-colour / spec mask. Stored as the metallic-roughness
                // texture slot for glTF — closest semantic match.
                material->AddProperty(&s, AI_MATKEY_TEXTURE_SPECULAR(0));
            }
        }

        // Treat S3O models as single-sided lit surfaces by default.
        int twoSided = 0;
        material->AddProperty(&twoSided, 1, AI_MATKEY_TWOSIDED);
    }

    pScene->mNumMaterials = 1;
    pScene->mMaterials = new aiMaterial*[1];
    pScene->mMaterials[0] = material;

    // ---- Recurse the piece tree ----
    std::vector<aiMesh*> meshes;
    aiNode* root = ReadPiece(buf, rootPieceOffset, meshes, /*materialIndex=*/0, pFile);

    // Hand off mesh list to the scene
    pScene->mNumMeshes = static_cast<unsigned int>(meshes.size());
    pScene->mMeshes = new aiMesh*[pScene->mNumMeshes];
    for (unsigned int i = 0; i < pScene->mNumMeshes; ++i) {
        pScene->mMeshes[i] = meshes[i];
    }

    // Wrap the imported root in a scene root node so we can stamp the
    // file basename on it (matches what other Assimp importers do).
    auto* sceneRoot = new aiNode();
    sceneRoot->mName = aiString(std::string("S3O_") +
                                pFile.substr(pFile.find_last_of("/\\") + 1));
    sceneRoot->mNumChildren = 1;
    sceneRoot->mChildren = new aiNode*[1];
    sceneRoot->mChildren[0] = root;
    root->mParent = sceneRoot;

    pScene->mRootNode = sceneRoot;

    if (pScene->mNumMeshes == 0) {
        // Assimp considers an empty scene a hard error. S3O files always
        // have at least one piece with geometry, so this is malformed.
        throw DeadlyImportError("S3O: no meshes produced from ", pFile);
    }
}

} // namespace Assimp
