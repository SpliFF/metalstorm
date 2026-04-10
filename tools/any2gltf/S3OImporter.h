// Open Asset Import Library (assimp)
// ----------------------------------------------------------------------
//
// S3O importer — Spring RTS unit/feature model format.
//
// This file is structured as a drop-in module for upstream Assimp. It
// implements `BaseImporter` and reads a Spring `.s3o` file into an
// `aiScene`. The importer is registered at runtime by the host
// application via `Assimp::Importer::RegisterLoader(new S3OImporter())`,
// so it does not require any modification to the Assimp source tree.
//
// To upstream this module: drop the .h and .cpp into
// `assimp/code/AssetLib/S3O/`, add a one-line entry to
// `code/Common/ImporterRegistry.cpp` (guarded by
// `#ifndef ASSIMP_BUILD_NO_S3O_IMPORTER`), and add a matching
// `ADD_ASSIMP_IMPORTER(S3O ...)` line in `code/CMakeLists.txt`.
//
// ----------------------------------------------------------------------
//
// S3O binary layout (little-endian throughout):
//
//   Header (52 bytes)
//     char     magic[12]    // "Spring unit\0"
//     uint32   version      // 0
//     float    radius
//     float    height
//     float    midx, midy, midz
//     uint32   rootPieceOffset
//     uint32   collisionDataOffset      // 0 = none
//     uint32   texture1Offset           // offset of NUL-terminated diffuse name
//     uint32   texture2Offset           // offset of NUL-terminated team-colour name
//
//   Piece (52 bytes)
//     uint32   nameOffset
//     uint32   numChildren
//     uint32   childrenOffset           // -> uint32[numChildren] piece offsets
//     uint32   numVertices
//     uint32   verticesOffset           // -> S3OVertex[numVertices]
//     uint32   vertexType               // 0 = standard
//     uint32   primitiveType            // 0=tris, 1=strips, 2=quads
//     uint32   vertexTableSize          // index count
//     uint32   vertexTableOffset        // -> uint32[vertexTableSize]
//     uint32   collisionDataOffset
//     float    xoffset, yoffset, zoffset // local offset from parent
//
//   Vertex (32 bytes)
//     float    pos[3]
//     float    normal[3]
//     float    uv[2]
//
// Pieces form a tree rooted at `header.rootPieceOffset`. Each piece's
// vertex positions are model-local; the cumulative chain of parent
// `xoffset/yoffset/zoffset` values gives its world transform. Texture
// references are bare filenames (typically `.tga`). VFS resolution is
// the host application's responsibility — we emit them verbatim into
// `aiMaterial::AI_MATKEY_TEXTURE_DIFFUSE(0)` / `_SPECULAR(0)`.

#pragma once

#include <assimp/BaseImporter.h>
#include <assimp/types.h>

#include <cstdint>
#include <string>
#include <vector>

struct aiNode;
struct aiMesh;

namespace Assimp {

class S3OImporter : public BaseImporter {
public:
    S3OImporter();
    ~S3OImporter() override;

    /// `BaseImporter` contract: cheap signature/extension check.
    bool CanRead(const std::string& pFile,
                 IOSystem* pIOHandler,
                 bool checkSig) const override;

    const aiImporterDesc* GetInfo() const override;

protected:
    /// `BaseImporter` contract: parse the file into `pScene`. Throws
    /// `DeadlyImportError` on malformed input.
    void InternReadFile(const std::string& pFile,
                        aiScene* pScene,
                        IOSystem* pIOHandler) override;

private:
    /// Bound-checked read of an arbitrary trivially-copyable value from
    /// the file buffer at `offset`. Throws on out-of-range.
    template <typename T>
    static T Read(const std::vector<uint8_t>& buf, size_t offset);

    /// Read a NUL-terminated string starting at `offset`.
    static std::string ReadString(const std::vector<uint8_t>& buf, size_t offset);

    /// Recursively walk the piece tree, building `aiNode` hierarchy and
    /// `aiMesh` entries into the supplied vectors. Returns the new node.
    /// `parentX/Y/Z` are the cumulative parent offsets in S3O space, used
    /// only for diagnostics — the local offset is stored on the node.
    aiNode* ReadPiece(const std::vector<uint8_t>& buf,
                      size_t pieceOffset,
                      std::vector<aiMesh*>& meshes,
                      unsigned int materialIndex,
                      const std::string& fileName);
};

} // namespace Assimp
