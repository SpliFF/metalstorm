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
#include "GeometryExtractor.h"
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

#include <nlohmann/json.hpp>

#include <algorithm>
#include <cctype>
#include <cstdio>
#include <cstring>
#include <filesystem>
#include <string>
#include <system_error>
#include <vector>

using json = nlohmann::json;

namespace {

void PrintUsage(const char* argv0) {
    SLOG(SPRING_LOG_NOTICE,
        "convert any model file to glTF 2.0 with embedded engine\n"
        "                simulation metadata.\n"
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
        "            The output .gltf carries a document-level\n"
        "            `SPRINGRTS_geometry` extension with the simulation\n"
        "            metadata the engine reads at runtime (bounding\n"
        "            sphere/box, piece tree, attachment points). A\n"
        "            hand-authored `<stem>.config.lua` alongside the\n"
        "            output overrides individual fields at load time;\n"
        "            it stays untouched by this tool.\n"
        "\n"
        "options:\n"
        "  --texture-ext <ext>   Rewrite all referenced texture file\n"
        "                        extensions to <ext>. Currently only\n"
        "                        'ktx2' is accepted.\n"
        "  --texture-prefix <p>  Prepend <p> to every rewritten texture\n"
        "                        URI (e.g. '../unittextures/').\n"
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

/// Adjust the JSON of a freshly-written .glb or .gltf so KTX2 textures
/// are referenced through the KHR_texture_basisu extension exactly as
/// the extension spec mandates:
///
///   - Each `textures[]` entry whose `source` points at a `.ktx2` image
///     has the top-level `source` removed and replaced with
///     `"extensions":{"KHR_texture_basisu":{"source":N}}`.
///   - Each KTX2 `images[]` entry gets `"mimeType": "image/ktx2"` —
///     the spec mandates the field and the Blender KTX2 addon gates
///     its decode hook on it.
///   - `KHR_texture_basisu` is added to both `extensionsRequired` and
///     `extensionsUsed` (creating the arrays if absent). Empty entries
///     left over by upstream tooling are pruned so the document
///     validates clean (no `EMPTY_ENTITY` warnings).
///   - `alphaMode` is stripped from every material. In Spring S3O the
///     diffuse alpha channel encodes team-color blend amount, not
///     transparency; Assimp's MASK default would discard ~93% of
///     fragments in a spec-compliant viewer (Phase 1 reinstates MASK
///     with binarised alpha as part of the PBR-mapping work).
///
/// No PNG fallback is emitted — our runtime (Babylon), Blender 4.2+,
/// gltf-viewer.donmccurdy.com and three.js all support
/// KHR_texture_basisu natively. Tools that don't are expected to
/// refuse the file, which is the spec-correct behaviour when the
/// extension is required.
///
/// Container handling: a .glb starts with the `glTF\x02\x00\x00\x00`
/// magic + 12-byte header. A .gltf is plain JSON. Both shapes are
/// supported so the post-fix is exporter-agnostic. The BIN chunk of a
/// .glb (vertex/index buffers) is preserved verbatim.
///
/// JSON manipulation uses nlohmann/json — the operations below are
/// structurally trivial DOM edits and the library's serialiser
/// guarantees we never emit a stray trailing comma the way the
/// previous hand-rolled surgery occasionally did.
///
/// `springGeometry` is the SPRINGRTS_geometry payload to inject as a
/// document-level extension (radius, height, midpos, mins, maxs,
/// pieces[], attachments[]). When non-null it lands at
/// `doc.extensions.SPRINGRTS_geometry` and the extension name is
/// appended to `extensionsUsed`. `extensionsRequired` is NOT touched
/// — third-party renderers don't need the extension to display the
/// mesh; only the engine relies on it.
bool FixGlbBasisuTextures(const std::string& path,
                          const nlohmann::json* springGeometry) {
    std::ifstream in(path, std::ios::binary);
    if (!in) return false;
    std::vector<uint8_t> data((std::istreambuf_iterator<char>(in)),
                               std::istreambuf_iterator<char>());
    in.close();

    // Detect container. .glb starts with `glTF` magic, version 2.
    // Anything else we treat as plain .gltf JSON.
    bool isGlb = false;
    uint32_t jsonLen = 0;
    std::string js;
    std::vector<uint8_t> rest;  // BIN chunk + anything after, .glb-only

    if (data.size() >= 20
        && std::memcmp(data.data(), "glTF", 4) == 0
        && ReadU32LE(data.data(), 4) == 2
        && std::memcmp(data.data() + 16, "JSON", 4) == 0)
    {
        isGlb = true;
        jsonLen = ReadU32LE(data.data(), 12);
        if (20u + jsonLen > data.size()) return false;
        js.assign(reinterpret_cast<const char*>(data.data() + 20), jsonLen);
        // Strip trailing 0x20 padding the spec requires for chunk alignment.
        while (!js.empty() && js.back() == ' ') js.pop_back();
        rest.assign(data.begin() + 20 + jsonLen, data.end());
    } else {
        js.assign(data.begin(), data.end());
    }

    // Early-out: nothing to do if there's no KTX2 reference anywhere.
    if (js.find(".ktx2") == std::string::npos) return true;

    json doc;
    try {
        doc = json::parse(js);
    } catch (const json::parse_error& e) {
        SLOG(SPRING_LOG_ERROR, "FixGlbBasisuTextures: failed to parse JSON: %s",
             e.what());
        return false;
    }

    // ---- Step 1: identify which images are KTX2 so we know which
    // textures need the extension lift, AND patch in mimeType.
    if (!doc.contains("images") || !doc["images"].is_array()) return false;
    json& images = doc["images"];

    std::vector<bool> isKtx2(images.size(), false);
    bool sawAnyKtx2 = false;
    for (size_t i = 0; i < images.size(); ++i) {
        json& img = images[i];
        if (!img.is_object() || !img.contains("uri")) continue;
        if (!img["uri"].is_string()) continue;
        std::string uri = img["uri"].get<std::string>();
        if (uri.size() < 5) continue;
        std::string tail = uri.substr(uri.size() - 5);
        for (char& c : tail) c = static_cast<char>(std::tolower((unsigned char)c));
        if (tail != ".ktx2") continue;
        isKtx2[i] = true;
        sawAnyKtx2 = true;
        // Stamp mimeType if absent (idempotent on re-runs).
        if (!img.contains("mimeType")) {
            img["mimeType"] = "image/ktx2";
        }
    }
    if (!sawAnyKtx2) return true;

    // ---- Step 2: rewrite textures[]. For each entry whose top-level
    // `source` points at a KTX2 image, remove the top-level field and
    // move the reference into `extensions.KHR_texture_basisu.source`.
    // Entries that already have the extension in place are passed
    // through unchanged (idempotent on re-runs).
    if (!doc.contains("textures") || !doc["textures"].is_array()) return false;
    json& textures = doc["textures"];

    for (auto& tx : textures) {
        if (!tx.is_object()) continue;
        // Already in extension form — leave alone.
        if (tx.contains("extensions")
            && tx["extensions"].is_object()
            && tx["extensions"].contains("KHR_texture_basisu")) {
            continue;
        }
        if (!tx.contains("source") || !tx["source"].is_number_integer()) continue;
        const int srcIdx = tx["source"].get<int>();
        if (srcIdx < 0
            || static_cast<size_t>(srcIdx) >= isKtx2.size()
            || !isKtx2[srcIdx]) {
            continue;
        }
        tx.erase("source");
        tx["extensions"]["KHR_texture_basisu"]["source"] = srcIdx;
    }

    // ---- Step 3: ensure KHR_texture_basisu appears in both
    // extensionsRequired and extensionsUsed. Prune empty entries.
    auto ensureExtListContains = [&](const char* fieldName, const char* ext) {
        json arr = json::array();
        if (doc.contains(fieldName) && doc[fieldName].is_array()) {
            for (const auto& v : doc[fieldName]) {
                if (v.is_string() && !v.get<std::string>().empty()) {
                    arr.push_back(v);
                }
            }
        }
        bool hasExt = false;
        for (const auto& v : arr) {
            if (v.is_string() && v.get<std::string>() == ext) {
                hasExt = true;
                break;
            }
        }
        if (!hasExt) arr.push_back(ext);
        doc[fieldName] = std::move(arr);
    };
    ensureExtListContains("extensionsRequired", "KHR_texture_basisu");
    ensureExtListContains("extensionsUsed",     "KHR_texture_basisu");

    // ---- Step 3a: inject the SPRINGRTS_geometry document-level
    // extension. Carries the simulation metadata (radius, midpos, piece
    // tree, attachment points) the engine needs at runtime. Third-party
    // renderers ignore it — extensionsRequired is intentionally NOT
    // touched. Idempotent on re-runs: overwrites any existing payload
    // so the data stays in lock-step with the freshly-extracted scene.
    if (springGeometry != nullptr && !springGeometry->is_null()) {
        doc["extensions"]["SPRINGRTS_geometry"] = *springGeometry;
        ensureExtListContains("extensionsUsed", "SPRINGRTS_geometry");
    }

    // ---- Step 3b: strip `alphaMode` from every material. Assimp
    // emits "MASK" whenever the source diffuse texture has an alpha
    // channel, but in Spring S3O the alpha channel encodes team-color
    // blend amount — NOT transparency. With MASK plus the default
    // 0.5 cutoff, any glTF-spec-compliant viewer discards ~93% of
    // fragments. Our runtime sampler reads alpha explicitly, so
    // stripping the field (defaulting to OPAQUE) loses no information.
    if (doc.contains("materials") && doc["materials"].is_array()) {
        for (auto& mat : doc["materials"]) {
            if (mat.is_object()) {
                mat.erase("alphaMode");
            }
        }
    }

    // ---- Step 4: serialise and write back. For .gltf this is a
    // straight overwrite; for .glb we re-pad and re-emit the binary
    // container. Use indent=-1 for compact output matching what Assimp
    // emits (one line per top-level field is too verbose for big arrays).
    // The previous hand-rolled path emitted pretty-printed JSON with
    // 2-space indent — keep that to preserve diff-friendliness.
    const std::string outJson = doc.dump(2);

    const std::string tmp = path + ".tmp";
    std::ofstream of(tmp, std::ios::binary | std::ios::trunc);
    if (!of) return false;
    if (isGlb) {
        std::vector<uint8_t> jsonBytes(outJson.begin(), outJson.end());
        while (jsonBytes.size() % 4 != 0) jsonBytes.push_back(' ');
        const uint32_t newTotal = 12 + 8
            + static_cast<uint32_t>(jsonBytes.size())
            + static_cast<uint32_t>(rest.size());
        std::vector<uint8_t> outFile;
        outFile.reserve(newTotal);
        outFile.insert(outFile.end(), {'g','l','T','F'});
        outFile.resize(outFile.size() + 4); WriteU32LE(outFile, 4, 2);
        outFile.resize(outFile.size() + 4); WriteU32LE(outFile, 8, newTotal);
        outFile.resize(outFile.size() + 4);
        WriteU32LE(outFile, 12, static_cast<uint32_t>(jsonBytes.size()));
        outFile.insert(outFile.end(), {'J','S','O','N'});
        outFile.insert(outFile.end(), jsonBytes.begin(), jsonBytes.end());
        outFile.insert(outFile.end(), rest.begin(), rest.end());
        of.write(reinterpret_cast<const char*>(outFile.data()),
                 static_cast<std::streamsize>(outFile.size()));
    } else {
        of.write(outJson.data(), static_cast<std::streamsize>(outJson.size()));
    }
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
        } else if (a == "--no-meta" || a == "--update-meta") {
            // No-op: legacy flags from the .config.json era. The
            // SPRINGRTS_geometry extension is always emitted into the
            // .gltf, and the .config.lua override file (when present)
            // is consulted by the engine at load time, not at convert
            // time. Kept as accepted-but-ignored so existing callers
            // (gameconverter --update-meta) don't break.
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

    // Sweep up any legacy `.config.json` sidecar from before the
    // SPRINGRTS_geometry extension landed in the .gltf. The .gltf is now
    // the canonical record; leaving the stale sidecar around would lead
    // to silent drift on the next run (engine prefers the .gltf extension
    // but third-party tools might still pick up the .json). A hand-
    // authored `.config.lua` is left alone — it remains the override
    // layer over the .gltf-embedded defaults.
    {
        namespace fs = std::filesystem;
        const fs::path outP = outPath;
        const fs::path luaConfigPath  = outP.parent_path() / (outP.stem().string() + ".config.lua");
        const fs::path jsonConfigPath = outP.parent_path() / (outP.stem().string() + ".config.json");

        std::error_code ec;
        if (fs::exists(jsonConfigPath)) {
            fs::remove(jsonConfigPath, ec);
            if (ec) {
                SLOG(SPRING_LOG_WARNING,
                    "failed to remove legacy %s: %s",
                    jsonConfigPath.string().c_str(), ec.message().c_str());
            }
        }

        SLOG(SPRING_LOG_NOTICE, "%s -> %s (%u meshes, %u materials)%s",
            inPath.c_str(), outPath.c_str(),
            scene->mNumMeshes, scene->mNumMaterials,
            fs::exists(luaConfigPath)
                ? " [.config.lua override present]"
                : "");
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
    // any other third-party tool. The `SPRINGRTS_geometry` extension's
    // numeric fields (offsets, mins/maxs) are also RH-canonical (see
    // GeometryExtractor.cpp), so engine and renderer agree on a single
    // glTF-native convention.
    // glTF 2.0 spec mandates UV origin (0,0) at the UPPER-LEFT of the
    // texture image — same convention as DirectX, KTX2 (rd orientation),
    // and the original S3O sources. Do NOT pass aiProcess_FlipUVs: it
    // inverts V into the lower-left (OpenGL) origin and makes every
    // sampling face read from the wrong half of the texture atlas
    // (wheel texture ends up on the body and similar symptoms).
    constexpr unsigned int kExportFlags =
        aiProcess_MakeLeftHanded   |   // LH source geometry → RH
        aiProcess_FlipWindingOrder;    // compensate winding flip

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

    // Post-fix: Assimp's glb2/gltf2 exporter writes texture entries as
    // `{"source": N, "sampler": N}` even for .ktx2 images, while
    // simultaneously listing `KHR_texture_basisu` in `extensionsRequired`.
    // Per the glTF spec that combination is invalid — when the extension
    // is required, `source` must move INSIDE `extensions.KHR_texture_basisu`
    // on the texture entry. Babylon's strict glTF loader trips on the
    // mismatch and throws `null.length` while resolving the texture,
    // which silently falls back to a procedural cone for every projectile.
    // Walk the freshly-written file's JSON and rewrite the texture
    // entries in place. Idempotent — running it again is a no-op.
    //
    // The same post-fix pass also injects the SPRINGRTS_geometry
    // document-level extension built from the imported scene, so the
    // .gltf becomes a complete record of mesh + materials + simulation
    // metadata in a single file.
    const nlohmann::json springGeometryJson =
        GeometryExtractor::BuildExtensionJson(scene, inPath);
    if (textureExt == "ktx2"
        && (EndsWith(outPath, ".glb") || EndsWith(outPath, ".gltf")))
    {
        if (!FixGlbBasisuTextures(outPath, &springGeometryJson)) {
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
