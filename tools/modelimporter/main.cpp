// modelimporter — convert any Assimp-supported model file to glTF 2.0.
//
// Pipeline:
//     <input>  -> Assimp Importer (built-in formats + S3O plugin)
//                 -> aiScene
//                 -> Assimp glTF2 Exporter
//                 -> <output>
//
// Usage:
//     modelimporter <input> <output>
//
// Output format is selected from the extension of <output>:
//     .gltf  -> "gltf2" exporter (JSON + sidecar .bin)
//     .glb   -> "glb2"  exporter (single binary file)

#include "S3OImporter.h"
#include "JsonWriter.h"
#include "SpringLog.h"
#include "SpringLogNet.h"

#include <fstream>
#include <iterator>
#include <cctype>

#define LOG_SECTION "model-import"

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
#include <filesystem>
#include <string>
#include <system_error>
#include <vector>

namespace {

void PrintUsage(const char* argv0) {
    SLOG(SPRING_LOG_NOTICE,
        "convert any model file to glTF 2.0 and emit\n"
        "                a sibling .config.json engine-metadata file.\n"
        "\n"
        "usage: %s [options] <input> <output>\n"
        "\n"
        "  <input>   path to a model file Assimp can read.\n"
        "            Spring RTS .s3o files are supported via the\n"
        "            built-in S3O importer plugin. The full list of\n"
        "            supported formats is whatever upstream Assimp\n"
        "            v6.0.4 bundles (OBJ, FBX, COLLADA/DAE, BLEND,\n"
        "            3DS, LWO, STL, PLY, glTF/glTF2, X, MD2/MD3/MD5,\n"
        "            and ~40 others).\n"
        "  <output>  path to write — extension selects format:\n"
        "              .gltf  -> JSON + sidecar .bin\n"
        "              .glb   -> single binary file\n"
        "\n"
        "            A sibling <stem>.config.json is also written with\n"
        "            the engine metadata the synced sim needs at\n"
        "            runtime (bounding sphere/box, piece tree,\n"
        "            attachment points). Ownership rules:\n"
        "              - If <stem>.config.lua exists, the importer\n"
        "                writes nothing — the author owns the meta.\n"
        "              - Else if <stem>.config.json exists, it's\n"
        "                preserved unless --update-meta is passed.\n"
        "              - Else a fresh .config.json is written.\n"
        "\n"
        "options:\n"
        "  --texture-ext <ext>   Rewrite all referenced texture file\n"
        "                        extensions to <ext> (e.g. \"png\", \"webp\").\n"
        "                        Useful when the source file points at\n"
        "                        legacy .tga assets that are being\n"
        "                        converted in a sibling pipeline step.\n"
        "  --update-meta         Overwrite the output .config.json even\n"
        "                        if it already exists. Has no effect\n"
        "                        if a .config.lua exists — that always\n"
        "                        wins.\n"
        "  --no-meta             Do not touch the sibling config file\n"
        "                        at all. Only useful if the caller\n"
        "                        manages metadata out-of-band.\n"
        "  --log-server <url>    Send logs to a springlog server.\n"
        "  --log-level <level>   Set minimum log level (debug/info/\n"
        "                        notice/warning/error).", argv0);
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

/// Walk every material in `scene` and rewrite each texture URI's
/// extension to `newExt`, optionally prepending `prefix` so the URI
/// resolves to a sibling directory rather than the model's own
/// directory. Used by gameconverter to point game-unit GLB URIs at
/// `../unittextures/<stem>.ktx2` while leaving feature-model URIs
/// (which sit alongside their textures) as bare filenames.
void RewriteTextureExtensions(aiScene* scene, const std::string& newExt,
                              const std::string& prefix) {
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

            std::string updated = ReplaceExtension(current, newExt);
            if (!prefix.empty()) {
                // Strip any directory component the source filename
                // already carried (S3O references are typically bare
                // names but a few authored model files include a
                // path) before prepending the desired prefix.
                const auto slash = updated.find_last_of("/\\");
                if (slash != std::string::npos) {
                    updated = updated.substr(slash + 1);
                }
                updated = prefix + updated;
            }
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

/// Read 4 little-endian bytes at `data + off` into a uint32_t.
uint32_t ReadU32LE(const uint8_t* data, size_t off) {
    uint32_t v = 0;
    std::memcpy(&v, data + off, sizeof(v));
    return v;
}

/// Write a uint32_t as 4 little-endian bytes into `out` at `off`.
void WriteU32LE(std::vector<uint8_t>& out, size_t off, uint32_t v) {
    std::memcpy(out.data() + off, &v, sizeof(v));
}

/// Walk the JSON chunk of a freshly-written .glb and rewrite every
/// texture entry whose source image has a `.ktx2` URI so the source
/// reference moves into `extensions.KHR_texture_basisu.source`.
///
/// Why we need this: Assimp's glb2 exporter emits texture entries as
/// `{"source": N, "sampler": N}` and *also* lists `KHR_texture_basisu`
/// in `extensionsRequired`. Per glTF spec these can't coexist —
/// when the extension is required the top-level `source` must move
/// into the extension. Babylon's strict glTF loader trips on the
/// inconsistency and throws a `null.length` exception while resolving
/// the texture, which silently demotes the projectile to a procedural
/// cone visual. Walking the JSON chunk and patching it in place is
/// cheaper than rewiring the Assimp exporter and keeps the BIN chunk
/// (vertex/index buffers) untouched.
///
/// Hand-rolled JSON edits — no external dependency. The replacements
/// are textual ("source":N → into extension shape), kept simple by
/// the well-known structure Assimp produces. If a future Assimp version
/// emits already-spec-compliant texture entries, the routine becomes a
/// no-op (the `"source":` substring won't appear inside `"textures":`).
bool FixGlbBasisuTextures(const std::string& path) {
    std::ifstream in(path, std::ios::binary);
    if (!in) return false;
    std::vector<uint8_t> data((std::istreambuf_iterator<char>(in)),
                               std::istreambuf_iterator<char>());
    in.close();

    if (data.size() < 20) return false;
    if (std::memcmp(data.data(), "glTF", 4) != 0) return false;
    if (ReadU32LE(data.data(), 4) != 2) return false;

    const uint32_t jsonLen = ReadU32LE(data.data(), 12);
    if (std::memcmp(data.data() + 16, "JSON", 4) != 0) return false;
    if (20u + jsonLen > data.size()) return false;

    // Extract JSON as a string, strip trailing space-padding (the spec
    // requires 4-byte chunk alignment via 0x20 padding).
    std::string js(reinterpret_cast<const char*>(data.data() + 20), jsonLen);
    while (!js.empty() && js.back() == ' ') js.pop_back();

    // Find the textures array and decide whether anything needs patching.
    // The well-known shape of Assimp output:
    //   "textures":[{"source":N,"sampler":N},…]
    // We only patch when the JSON also references a .ktx2 image, which
    // is the trigger Assimp uses to add KHR_texture_basisu in
    // `extensionsRequired`. (Without .ktx2 sources the patched
    // structure would actually be wrong — leave plain PNG/JPG textures
    // alone.)
    if (js.find(".ktx2") == std::string::npos) return false;
    if (js.find("\"textures\":") == std::string::npos) return false;

    // Replace each `{"source":N,"sampler":M}` (or `{"sampler":M,"source":N}`)
    // with `{"sampler":M,"extensions":{"KHR_texture_basisu":{"source":N}}}`.
    // We walk character-by-character looking for the texture-entry pattern
    // so we don't accidentally rewrite occurrences in image URIs etc.
    std::string out;
    out.reserve(js.size() + 256);
    size_t i = 0;
    bool changed = false;
    const std::string texturesKey = "\"textures\":";
    const size_t texturesStart = js.find(texturesKey);

    if (texturesStart == std::string::npos) return false;

    out.append(js, 0, texturesStart);
    i = texturesStart;

    // Walk through `"textures":[ … ]` and patch each `{ … }` entry.
    out.append(texturesKey);
    i += texturesKey.size();
    if (i >= js.size() || js[i] != '[') {
        // Unexpected structure — bail without modifying.
        return false;
    }
    out.push_back('[');
    i++;
    int depth = 1;
    std::string entry;
    while (i < js.size() && depth > 0) {
        const char c = js[i];
        if (c == '{') {
            if (entry.empty() && depth == 1) {
                // Start of one texture entry.
                entry.push_back(c);
                i++;
                int eDepth = 1;
                while (i < js.size() && eDepth > 0) {
                    const char ec = js[i];
                    entry.push_back(ec);
                    if (ec == '{') eDepth++;
                    else if (ec == '}') eDepth--;
                    i++;
                }
                // entry now holds the full `{…}` of this texture.
                std::string patched = entry;
                // Look for `"source":<digits>` inside the entry.
                const size_t sPos = patched.find("\"source\":");
                if (sPos != std::string::npos) {
                    size_t numStart = sPos + 9;
                    size_t numEnd = numStart;
                    while (numEnd < patched.size()
                           && std::isdigit(static_cast<unsigned char>(patched[numEnd])))
                        numEnd++;
                    if (numEnd > numStart) {
                        const std::string src(patched, numStart, numEnd - numStart);
                        // Erase `"source":N` plus an adjacent comma if any.
                        size_t eraseStart = sPos;
                        size_t eraseEnd = numEnd;
                        if (eraseEnd < patched.size() && patched[eraseEnd] == ',') {
                            eraseEnd++;
                        } else if (eraseStart > 0 && patched[eraseStart - 1] == ',') {
                            eraseStart--;
                        }
                        patched.erase(eraseStart, eraseEnd - eraseStart);
                        // Insert the extensions block before the closing `}`.
                        const size_t closeBrace = patched.find_last_of('}');
                        const std::string insertion =
                            std::string(patched.size() > 1 && patched[closeBrace - 1] != '{'
                                        ? "," : "")
                            + "\"extensions\":{\"KHR_texture_basisu\":{\"source\":"
                            + src + "}}";
                        patched.insert(closeBrace, insertion);
                        if (patched != entry) changed = true;
                    }
                }
                out.append(patched);
                entry.clear();
                continue;
            }
        } else if (c == '[') {
            depth++;
        } else if (c == ']') {
            depth--;
        }
        out.push_back(c);
        i++;
    }
    // Append the rest of the JSON verbatim.
    out.append(js, i, std::string::npos);

    if (!changed) return true; // nothing to do — file already compliant

    // Re-pad to 4-byte alignment.
    std::vector<uint8_t> jsonBytes(out.begin(), out.end());
    while (jsonBytes.size() % 4 != 0) jsonBytes.push_back(' ');

    // Preserve the BIN chunk (and any subsequent chunks) verbatim.
    std::vector<uint8_t> rest(data.begin() + 20 + jsonLen, data.end());

    const uint32_t newTotal = 12 + 8 + static_cast<uint32_t>(jsonBytes.size())
                            + static_cast<uint32_t>(rest.size());
    std::vector<uint8_t> outFile;
    outFile.reserve(newTotal);
    // Header.
    outFile.insert(outFile.end(), {'g','l','T','F'});
    outFile.resize(outFile.size() + 4); WriteU32LE(outFile, 4, 2);
    outFile.resize(outFile.size() + 4); WriteU32LE(outFile, 8, newTotal);
    // JSON chunk header.
    outFile.resize(outFile.size() + 4);
    WriteU32LE(outFile, 12, static_cast<uint32_t>(jsonBytes.size()));
    outFile.insert(outFile.end(), {'J','S','O','N'});
    outFile.insert(outFile.end(), jsonBytes.begin(), jsonBytes.end());
    // BIN chunk + tail.
    outFile.insert(outFile.end(), rest.begin(), rest.end());

    const std::string tmp = path + ".tmp";
    std::ofstream of(tmp, std::ios::binary | std::ios::trunc);
    if (!of) return false;
    of.write(reinterpret_cast<const char*>(outFile.data()),
             static_cast<std::streamsize>(outFile.size()));
    if (!of) return false;
    of.close();
    std::error_code ec;
    std::filesystem::rename(tmp, path, ec);
    return !ec;
}

} // namespace

int main(int argc, char** argv) {
    springlog_init("modelimporter", SPRING_LOG_OUTPUT_CONSOLE);

    std::string inPath, outPath;
    // KTX2 is the only texture format the runtime accepts; rewrite all
    // glb-embedded URIs to point at sibling .ktx2 files unconditionally.
    // The flag is kept so callers can be explicit, but it's a single
    // legal value (passing anything else is rejected at parse time).
    std::string textureExt = "ktx2";
    // Optional path prefix prepended to every rewritten texture URI.
    // gameconverter passes "../unittextures/" so unit-model GLBs
    // resolve their textures from the canonical unittextures/ folder.
    // FeatureProcessor passes nothing — feature GLBs and their
    // textures sit in the same directory.
    std::string texturePrefix;
    std::string logServerUrl;
    bool emitMeta = true;
    bool updateMeta = false;

    // Tiny hand-rolled arg parser — keeps the binary dependency-free.
    for (int i = 1; i < argc; ++i) {
        const std::string a = argv[i];
        if (a == "--texture-ext" && i + 1 < argc) {
            textureExt = argv[++i];
            // strip any leading dot the user typed
            if (!textureExt.empty() && textureExt[0] == '.') {
                textureExt.erase(0, 1);
            }
            if (textureExt != "ktx2") {
                SLOG(SPRING_LOG_ERROR,
                    "--texture-ext only accepts 'ktx2' (got '%s')",
                    textureExt.c_str());
                springlog_shutdown();
                return 2;
            }
        } else if (a == "--texture-prefix" && i + 1 < argc) {
            texturePrefix = argv[++i];
        } else if (a == "--no-meta") {
            emitMeta = false;
        } else if (a == "--update-meta") {
            updateMeta = true;
        } else if (a == "--log-server" && i + 1 < argc) {
            logServerUrl = argv[++i];
        } else if (a == "--log-level" && i + 1 < argc) {
            const std::string lvl = argv[++i];
            if (lvl == "debug")        springlog_set_min_level(SPRING_LOG_DEBUG);
            else if (lvl == "info")    springlog_set_min_level(SPRING_LOG_INFO);
            else if (lvl == "notice")  springlog_set_min_level(SPRING_LOG_NOTICE);
            else if (lvl == "warning") springlog_set_min_level(SPRING_LOG_WARNING);
            else if (lvl == "error")   springlog_set_min_level(SPRING_LOG_ERROR);
        } else if (a == "-h" || a == "--help") {
            PrintUsage(argv[0]);
            springlog_shutdown();
            return 0;
        } else if (inPath.empty()) {
            inPath = a;
        } else if (outPath.empty()) {
            outPath = a;
        } else {
            SLOG(SPRING_LOG_ERROR, "unexpected argument '%s'", a.c_str());
            PrintUsage(argv[0]);
            springlog_shutdown();
            return 1;
        }
    }

    if (!logServerUrl.empty()) {
        springlog_net_init(logServerUrl.c_str(), "");
    }

    if (inPath.empty() || outPath.empty()) {
        PrintUsage(argv[0]);
        springlog_shutdown();
        return 1;
    }

    const char* exporterId = PickExporter(outPath);
    if (!exporterId) {
        SLOG(SPRING_LOG_ERROR,
            "output extension must be .gltf or .glb (got '%s')",
            outPath.c_str());
        springlog_shutdown();
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
        SLOG(SPRING_LOG_ERROR, "failed to read '%s': %s",
             inPath.c_str(), importer.GetErrorString());
        Assimp::DefaultLogger::kill();
        springlog_shutdown();
        return 3;
    }

    // Handle the sibling <output>.config.json. The file follows the
    // project-wide .config.lua / .config.json ownership rules, in
    // priority order:
    //
    //   1. If <output>.config.lua exists → do nothing. The author has
    //      taken full control of this model's metadata via Lua and we
    //      never mix engine output into hand-edited files.
    //   2. Else if <output>.config.json does not exist → write a fresh
    //      extraction.
    //   3. Else if its configVersion is older than kCurrentConfigVersion
    //      → overwrite (auto-upgrade stale schemas).
    //   4. Else if --update-meta was passed → overwrite.
    //   5. Else → leave the existing .config.json untouched.
    //
    // The JSON write happens BEFORE RewriteTextureExtensions so the
    // tex1/tex2 fields keep their original filenames (e.g.
    // `commrecon.dds`) — the client resolves those through
    // `unittextures/`, while the GLB itself references the rewritten
    // `.png` URI for self-contained scene loading.
    //
    // --no-meta opts out of everything in this block.
    if (emitMeta) {
        namespace fs = std::filesystem;
        const fs::path outP = outPath;
        // .config.json isn't a single dotted extension to `replace_extension`;
        // strip the .glb/.gltf with stem() and append the full suffix.
        const fs::path luaConfigPath  = outP.parent_path() / (outP.stem().string() + ".config.lua");
        const fs::path jsonConfigPath = outP.parent_path() / (outP.stem().string() + ".config.json");

        const bool hasLua  = fs::exists(luaConfigPath);
        const bool hasJson = fs::exists(jsonConfigPath);

        // Detect stale configs (v1 written before tex1/tex2 extraction,
        // or pre-rename files using `metaVersion`). Cheap text scan —
        // we only need to find the integer; full JSON parsing would be
        // overkill for a single field.
        bool staleVersion = false;
        if (hasJson) {
            std::ifstream in(jsonConfigPath, std::ios::binary);
            if (in) {
                const std::string contents{
                    std::istreambuf_iterator<char>(in),
                    std::istreambuf_iterator<char>(),
                };
                auto findVersion = [&](const char* key) -> int {
                    const std::string needle = std::string("\"") + key + "\"";
                    auto p = contents.find(needle);
                    if (p == std::string::npos) return -1;
                    p = contents.find(':', p);
                    if (p == std::string::npos) return -1;
                    ++p;
                    while (p < contents.size() && std::isspace(static_cast<unsigned char>(contents[p]))) ++p;
                    int v = 0;
                    bool any = false;
                    while (p < contents.size() && std::isdigit(static_cast<unsigned char>(contents[p]))) {
                        v = v * 10 + (contents[p] - '0');
                        ++p;
                        any = true;
                    }
                    return any ? v : -1;
                };
                int v = findVersion("configVersion");
                if (v < 0) v = findVersion("metaVersion");
                if (v < JsonWriter::kCurrentConfigVersion) staleVersion = true;
            }
        }

        const char* metaStatus = nullptr;
        if (hasLua) {
            metaStatus = " [author-owned .config.lua, skipped]";
        } else if (!hasJson) {
            if (!JsonWriter::Write(scene, jsonConfigPath.string(), inPath)) {
                SLOG(SPRING_LOG_ERROR, "failed to write %s",
                    jsonConfigPath.string().c_str());
                Assimp::DefaultLogger::kill();
                springlog_shutdown();
                return 5;
            }
            metaStatus = " [fresh]";
        } else if (staleVersion) {
            if (!JsonWriter::Write(scene, jsonConfigPath.string(), inPath)) {
                SLOG(SPRING_LOG_ERROR, "failed to write %s",
                    jsonConfigPath.string().c_str());
                Assimp::DefaultLogger::kill();
                springlog_shutdown();
                return 5;
            }
            metaStatus = " [upgraded]";
        } else if (updateMeta) {
            if (!JsonWriter::Write(scene, jsonConfigPath.string(), inPath)) {
                SLOG(SPRING_LOG_ERROR, "failed to write %s",
                    jsonConfigPath.string().c_str());
                Assimp::DefaultLogger::kill();
                springlog_shutdown();
                return 5;
            }
            metaStatus = " [updated]";
        } else {
            metaStatus = " [kept existing]";
        }

        const fs::path& displayedPath = hasLua ? luaConfigPath : jsonConfigPath;
        SLOG(SPRING_LOG_NOTICE, "%s -> %s (%u meshes, %u materials) + %s%s",
            inPath.c_str(), outPath.c_str(),
            scene->mNumMeshes, scene->mNumMaterials,
            displayedPath.filename().string().c_str(),
            metaStatus);
    } else {
        SLOG(SPRING_LOG_NOTICE, "%s -> %s (%u meshes, %u materials)",
            inPath.c_str(), outPath.c_str(),
            scene->mNumMeshes, scene->mNumMaterials);
    }

    // Rewrite texture URIs (e.g. `.dds` → `.png`) AFTER the JSON config
    // is written, so the JSON keeps the original filenames the client
    // resolves via `unittextures/` while the GLB references the
    // rewritten extension that gameconverter will produce alongside it.
    if (!textureExt.empty()) {
        // The Importer owns the scene as a non-const aiScene under the hood;
        // for our use case (post-import rewrite before export) the const_cast
        // is safe and idiomatic in Assimp tooling.
        RewriteTextureExtensions(const_cast<aiScene*>(scene), textureExt,
                                 texturePrefix);
    }

    // Export-time LH → RH conversion. Spring's source-data convention
    // (S3O author convention; +Z forward, LH cross-product) does not
    // match glTF 2.0 which mandates RH (-Z forward, CCW winding from
    // the front, UV origin upper-left). Passing these post-processing
    // flags to Exporter::Export tells Assimp the *scene* data is in
    // its native LH convention and must be flipped to RH before write.
    //
    // Per the Assimp docs (Exporter.hpp): "Specifying those flags for
    // exporting has the opposite effect" — at import they convert
    // RH→LH for users who want LH; at export they convert LH→RH so
    // the emitted file matches the spec.
    //
    // Result: every .glb written from here on is a spec-compliant
    // glTF 2.0 file that loads correctly in Blender, gltf-viewer, and
    // any other third-party tool. The engine compensates on the
    // sidecar side (JsonWriter negates Z so .config.json carries RH-
    // canonical offsets) and on the loader side (ModelConfigLoader
    // negates Z back to LH at read-time so engine internals are
    // unaffected — Phase 1d bridge, removed in Phase 2 when the sim
    // and client flip to RH natively).
    constexpr unsigned int kExportFlags =
        aiProcess_MakeLeftHanded   |   // LH source geometry → RH
        aiProcess_FlipWindingOrder |   // compensate winding flip
        aiProcess_FlipUVs;             // UV origin upper-left → lower-left

    Assimp::Exporter exporter;
    const aiReturn rc = exporter.Export(scene, exporterId, outPath,
                                        kExportFlags);
    if (rc != aiReturn_SUCCESS) {
        SLOG(SPRING_LOG_ERROR, "glTF export failed: %s",
             exporter.GetErrorString());
        Assimp::DefaultLogger::kill();
        springlog_shutdown();
        return 4;
    }

    // Post-fix: Assimp's glb2 exporter writes texture entries as
    // `{"source": N, "sampler": N}` even for .ktx2 images, while
    // simultaneously listing `KHR_texture_basisu` in `extensionsRequired`.
    // Per the glTF spec that combination is invalid — when the extension
    // is required, `source` must move INSIDE `extensions.KHR_texture_basisu`
    // on the texture entry. Babylon's strict glTF loader trips on the
    // mismatch and throws `null.length` while resolving the texture,
    // which silently falls back to a procedural cone for every projectile.
    // Walk the freshly-written .glb's JSON chunk and rewrite the texture
    // entries in place. Idempotent — running it again is a no-op.
    if (textureExt == "ktx2" && EndsWith(outPath, ".glb")) {
        if (!FixGlbBasisuTextures(outPath)) {
            SLOG(SPRING_LOG_WARNING,
                 "post-fix of KHR_texture_basisu textures in %s failed; "
                 "client may render projectile as procedural cone",
                 outPath.c_str());
        }
    }

    Assimp::DefaultLogger::kill();
    springlog_shutdown();
    return 0;
}
