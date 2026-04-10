// any2gltf — convert any Assimp-supported model file to glTF 2.0.
//
// Pipeline:
//     <input>  -> Assimp Importer (built-in formats + S3O plugin)
//                 -> aiScene
//                 -> Assimp glTF2 Exporter
//                 -> <output>
//
// Usage:
//     any2gltf <input> <output>
//
// Output format is selected from the extension of <output>:
//     .gltf  -> "gltf2" exporter (JSON + sidecar .bin)
//     .glb   -> "glb2"  exporter (single binary file)

#include "S3OImporter.h"

#include <assimp/Importer.hpp>
#include <assimp/Exporter.hpp>
#include <assimp/postprocess.h>
#include <assimp/scene.h>
#include <assimp/material.h>
#include <assimp/DefaultLogger.hpp>
#include <assimp/Logger.hpp>

#include <algorithm>
#include <cctype>
#include <cstdio>
#include <cstring>
#include <string>

namespace {

void PrintUsage(const char* argv0) {
    std::fprintf(stderr,
        "any2gltf — convert any model file to glTF 2.0\n"
        "\n"
        "usage: %s [options] <input> <output>\n"
        "\n"
        "  <input>   path to a model file Assimp can read.\n"
        "            Spring RTS .s3o files are supported via the\n"
        "            built-in S3O importer plugin.\n"
        "  <output>  path to write — extension selects format:\n"
        "              .gltf  -> JSON + sidecar .bin\n"
        "              .glb   -> single binary file\n"
        "\n"
        "options:\n"
        "  --texture-ext <ext>   Rewrite all referenced texture file\n"
        "                        extensions to <ext> (e.g. \"png\", \"webp\").\n"
        "                        Useful when the source file points at\n"
        "                        legacy .tga assets that are being\n"
        "                        converted in a sibling pipeline step.\n"
        "\n", argv0);
}

/// Replace the file extension of `path` with `newExt` (no leading dot needed).
/// Returns the original path unchanged if it has no extension.
std::string ReplaceExtension(const std::string& path, const std::string& newExt) {
    const size_t dot = path.find_last_of('.');
    const size_t slash = path.find_last_of("/\\");
    if (dot == std::string::npos || (slash != std::string::npos && dot < slash)) {
        return path;
    }
    return path.substr(0, dot + 1) + newExt;
}

/// Walk every material in `scene` and replace each texture URI's extension
/// with `newExt`. The aiMaterial property table stores texture filenames
/// for each `aiTextureType_*` slot — we visit them all.
void RewriteTextureExtensions(aiScene* scene, const std::string& newExt) {
    for (unsigned int m = 0; m < scene->mNumMaterials; ++m) {
        aiMaterial* mat = scene->mMaterials[m];
        for (unsigned int p = 0; p < mat->mNumProperties; ++p) {
            aiMaterialProperty* prop = mat->mProperties[p];
            if (prop->mType != aiPTI_String) continue;
            if (std::strcmp(prop->mKey.C_Str(), _AI_MATKEY_TEXTURE_BASE) != 0) continue;

            // String properties are stored as: uint32 length, char data[length+1]
            if (prop->mDataLength < sizeof(uint32_t) + 1) continue;
            uint32_t len = 0;
            std::memcpy(&len, prop->mData, sizeof(uint32_t));
            if (len + sizeof(uint32_t) + 1 > prop->mDataLength) continue;
            std::string current(prop->mData + sizeof(uint32_t), len);

            const std::string updated = ReplaceExtension(current, newExt);
            if (updated == current) continue;

            // Re-encode and replace the in-place buffer (grow if needed).
            const uint32_t newLen = static_cast<uint32_t>(updated.size());
            const size_t   newBytes = sizeof(uint32_t) + newLen + 1;
            char* newData = new char[newBytes];
            std::memcpy(newData, &newLen, sizeof(uint32_t));
            std::memcpy(newData + sizeof(uint32_t), updated.data(), newLen);
            newData[sizeof(uint32_t) + newLen] = '\0';

            delete[] prop->mData;
            prop->mData = newData;
            prop->mDataLength = static_cast<unsigned int>(newBytes);
        }
    }
}

bool EndsWith(const std::string& s, const char* suffix) {
    const size_t n = std::strlen(suffix);
    if (s.size() < n) return false;
    return std::equal(s.end() - n, s.end(), suffix,
                      [](char a, char b) { return std::tolower(a) == std::tolower(b); });
}

const char* PickExporter(const std::string& outPath) {
    if (EndsWith(outPath, ".glb"))  return "glb2";
    if (EndsWith(outPath, ".gltf")) return "gltf2";
    return nullptr;
}

} // namespace

int main(int argc, char** argv) {
    std::string inPath, outPath, textureExt;

    // Tiny hand-rolled arg parser — keeps the binary dependency-free.
    for (int i = 1; i < argc; ++i) {
        const std::string a = argv[i];
        if (a == "--texture-ext" && i + 1 < argc) {
            textureExt = argv[++i];
            // strip any leading dot the user typed
            if (!textureExt.empty() && textureExt[0] == '.') {
                textureExt.erase(0, 1);
            }
        } else if (a == "-h" || a == "--help") {
            PrintUsage(argv[0]);
            return 0;
        } else if (inPath.empty()) {
            inPath = a;
        } else if (outPath.empty()) {
            outPath = a;
        } else {
            std::fprintf(stderr, "any2gltf: unexpected argument '%s'\n", a.c_str());
            PrintUsage(argv[0]);
            return 1;
        }
    }
    if (inPath.empty() || outPath.empty()) {
        PrintUsage(argv[0]);
        return 1;
    }

    const char* exporterId = PickExporter(outPath);
    if (!exporterId) {
        std::fprintf(stderr,
            "any2gltf: output extension must be .gltf or .glb (got '%s')\n",
            outPath.c_str());
        return 2;
    }

    // Send Assimp's logs to stderr at "info" level so users see what's
    // happening on first run / on errors.
    Assimp::DefaultLogger::create("", Assimp::Logger::NORMAL,
                                  aiDefaultLogStream_STDERR);

    Assimp::Importer importer;

    // Register the S3O plugin. Assimp takes ownership.
    importer.RegisterLoader(new Assimp::S3OImporter());

    // Common post-processing flags. Triangulate is critical (we already
    // emit triangles for S3O but other importers may not). The rest are
    // friendly defaults for downstream renderers.
    constexpr unsigned int kFlags =
        aiProcess_Triangulate                |
        aiProcess_JoinIdenticalVertices      |
        aiProcess_GenSmoothNormals           |
        aiProcess_ImproveCacheLocality       |
        aiProcess_RemoveRedundantMaterials   |
        aiProcess_FindInvalidData            |
        aiProcess_GenUVCoords                |
        aiProcess_OptimizeMeshes;

    const aiScene* scene = importer.ReadFile(inPath, kFlags);
    if (!scene) {
        std::fprintf(stderr, "any2gltf: failed to read '%s': %s\n",
                     inPath.c_str(), importer.GetErrorString());
        Assimp::DefaultLogger::kill();
        return 3;
    }

    if (!textureExt.empty()) {
        // The Importer owns the scene as a non-const aiScene under the hood;
        // for our use case (post-import rewrite before export) the const_cast
        // is safe and idiomatic in Assimp tooling.
        RewriteTextureExtensions(const_cast<aiScene*>(scene), textureExt);
    }

    Assimp::Exporter exporter;
    const aiReturn rc = exporter.Export(scene, exporterId, outPath);
    if (rc != aiReturn_SUCCESS) {
        std::fprintf(stderr, "any2gltf: glTF export failed: %s\n",
                     exporter.GetErrorString());
        Assimp::DefaultLogger::kill();
        return 4;
    }

    std::fprintf(stderr, "any2gltf: %s -> %s (%u meshes, %u materials)\n",
                 inPath.c_str(), outPath.c_str(),
                 scene->mNumMeshes, scene->mNumMaterials);
    Assimp::DefaultLogger::kill();
    return 0;
}
