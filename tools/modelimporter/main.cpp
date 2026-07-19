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
#include "PIEImporter.h"
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
#include <functional>
#include <set>
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
        "  --normaltex <file>    Normal-map texture (basename) to lift into\n"
        "                        the glTF material.normalTexture. For sources\n"
        "                        whose normal map lives in the unitDef\n"
        "                        (customParams.normaltex), not a sidecar.\n"
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

/// Rewrite a single string-typed material texture property in place.
/// Reallocates `prop->mData` to fit `newName` and updates `mDataLength`.
/// Shared by `RewriteTextureExtensions` and `ExtractEmbeddedTextures`.
void OverwriteTextureProperty(aiMaterialProperty* prop, const std::string& newName) {
    const uint32_t newLen = static_cast<uint32_t>(newName.size());
    const size_t   newBytes = sizeof(uint32_t) + newLen + 1;
    char* newData = new char[newBytes];
    std::memcpy(newData, &newLen, sizeof(uint32_t));
    std::memcpy(newData + sizeof(uint32_t), newName.data(), newLen);
    newData[sizeof(uint32_t) + newLen] = '\0';

    delete[] prop->mData;
    prop->mData = newData;
    prop->mDataLength = static_cast<unsigned int>(newBytes);
}

/// Walk every embedded texture in the scene and dump it to a file next
/// to the output .gltf, then rewrite every material URI from Assimp's
/// `"*N"` embedded-index reference to the on-disk filename. Covers the
/// .glb and gltf-embedded-data-URI cases — Blender's default export
/// path bakes textures into the .glb binary chunk so they ride along
/// with the geometry. Without this pass the downstream pipeline can't
/// see those textures (gameconverter only knows how to resolve sources
/// from on-disk `.png` / `.dds` / etc.).
///
/// Compressed textures (PNG / JPG / DDS / etc., signalled by
/// mHeight == 0) get their raw payload dumped verbatim using the
/// loader's `achFormatHint` for the file extension. Uncompressed
/// textures (mHeight > 0, raw ARGB8888 pixels) are skipped with a
/// warning — modelimporter doesn't link a PNG/TGA encoder; that
/// branch hasn't come up in real Blender exports yet.
///
/// `outPath` is the .gltf the importer is about to write. The
/// extracted files land in its parent directory with a stable
/// naming scheme: `<outStem>__emb<index>.<ext>`. The double-
/// underscore separator keeps them visually distinct from the
/// modelimporter's other sibling outputs (`<stem>_diffuse.ktx2`,
/// etc.) and is reserved for this use.
void ExtractEmbeddedTextures(aiScene* scene, const std::string& outPath) {
    if (scene->mNumTextures == 0) return;
    namespace fs = std::filesystem;
    const fs::path outDir = fs::path(outPath).parent_path();
    const std::string outStem = fs::path(outPath).stem().string();
    std::error_code ec;
    fs::create_directories(outDir, ec);

    // Build the index → extracted-URI map first so material rewriting
    // is a single pass that can also recognise textures it skipped.
    std::vector<std::string> embeddedUris(scene->mNumTextures);
    unsigned extracted = 0;
    for (unsigned i = 0; i < scene->mNumTextures; ++i) {
        const aiTexture* t = scene->mTextures[i];
        if (!t) continue;

        if (t->mHeight != 0) {
            SLOG(SPRING_LOG_WARNING,
                "embedded texture *%u is uncompressed (%ux%u) — skipping; "
                "no in-tool PNG/TGA encoder is linked. Re-export the source "
                "with compressed textures (PNG/JPG) if possible.",
                i, t->mWidth, t->mHeight);
            continue;
        }

        std::string ext = (t->achFormatHint[0] != 0)
            ? std::string(t->achFormatHint) : std::string("bin");
        // Some loaders pad achFormatHint with trailing whitespace; trim.
        while (!ext.empty() && (ext.back() == ' ' || ext.back() == '\0')) {
            ext.pop_back();
        }
        if (ext.empty()) ext = "bin";

        const std::string fname = outStem + "__emb" + std::to_string(i) + "." + ext;
        const fs::path target = outDir / fname;

        std::ofstream f(target, std::ios::binary);
        if (!f) {
            SLOG(SPRING_LOG_ERROR,
                "failed to write embedded texture: %s",
                target.string().c_str());
            continue;
        }
        f.write(reinterpret_cast<const char*>(t->pcData),
                static_cast<std::streamsize>(t->mWidth));
        f.close();

        embeddedUris[i] = fname;
        ++extracted;
        SLOG(SPRING_LOG_INFO,
            "extracted embedded texture *%u (%u bytes, .%s) -> %s",
            i, t->mWidth, ext.c_str(), fname.c_str());
    }
    if (extracted == 0) return;

    // Rewrite materials. Assimp encodes embedded references as a
    // single asterisk followed by the decimal index — match that
    // exact shape and look the index up in our map.
    for (unsigned m = 0; m < scene->mNumMaterials; ++m) {
        aiMaterial* mat = scene->mMaterials[m];
        for (unsigned p = 0; p < mat->mNumProperties; ++p) {
            aiMaterialProperty* prop = mat->mProperties[p];
            if (prop->mType != aiPTI_String) continue;
            if (std::strcmp(prop->mKey.C_Str(), _AI_MATKEY_TEXTURE_BASE) != 0) continue;
            if (prop->mDataLength < sizeof(uint32_t) + 2) continue;

            uint32_t len = 0;
            std::memcpy(&len, prop->mData, sizeof(uint32_t));
            if (len + sizeof(uint32_t) + 1 > prop->mDataLength) continue;
            const char* s = prop->mData + sizeof(uint32_t);
            if (len < 2 || s[0] != '*') continue;

            unsigned idx = 0;
            try {
                idx = static_cast<unsigned>(std::stoul(std::string(s + 1, len - 1)));
            } catch (...) {
                continue;
            }
            if (idx >= embeddedUris.size() || embeddedUris[idx].empty()) continue;

            OverwriteTextureProperty(prop, embeddedUris[idx]);
        }
    }
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
            OverwriteTextureProperty(prop, updated);
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
/// the extension spec mandates, and (for Spring S3O sources) synthesise
/// the four-output PBR material layout described in PLAN-pbr-mapping.md:
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
///   - When `springGeometry` carries `tex1` / `tex2` (Spring S3O-style
///     channel packing), the function replaces the document's
///     `images[]`, `textures[]`, and `materials[0]` arrays with the
///     four-output PBR layout:
///         baseColorTexture          → <tex1stem>_diffuse.ktx2
///         emissiveTexture           → <tex2stem>_emissive.ktx2
///         metallicRoughnessTexture  → <tex2stem>_orm.ktx2 (also referenced
///         occlusionTexture            from occlusionTexture; the spec
///                                     explicitly allows two slots to point
///                                     at one texture)
///         SPRINGRTS_team_color
///           .maskTexture            → <tex1stem>_team.ktx2
///     The four KTX2 files do not exist yet at modelimporter time;
///     gameconverter produces them in a separate pass.
///   - `alphaMode` (and `alphaCutoff`) are stripped from every material
///     unconditionally. Spring's model shader gates alpha test on a
///     runtime `alphaCtrl` uniform that defaults to "always pass" —
///     the engine only toggles cutout for specific render passes
///     (shadow gen, alpha-blend bin) that a static glTF can't
///     replicate. tex1.A is the team-color mask and tex2.A is sparse
///     engine-side data; neither is a transparency channel. Without
///     this sweep, Assimp's eager MASK default discards ~90% of
///     fragments on assets where tex2.A is mostly zero (most ZK
///     content). Defaulting to OPAQUE matches the in-engine look.
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

    json doc;
    try {
        doc = json::parse(js);
    } catch (const json::parse_error& e) {
        SLOG(SPRING_LOG_ERROR, "FixGlbBasisuTextures: failed to parse JSON: %s",
             e.what());
        return false;
    }

    // Helper to add `ext` to a top-level string-array field, creating
    // the array if absent and pruning empty entries that upstream
    // tooling sometimes leaves behind.
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

    // Even when there are no KTX2 references to lift (e.g. a `.dae`
    // source that gave Assimp nothing to bind), we still need to fall
    // through for SPRINGRTS_geometry injection. The two KTX2 passes
    // below early-skip cleanly when their arrays don't exist.
    const bool hasImages   = doc.contains("images")   && doc["images"].is_array();
    const bool hasTextures = doc.contains("textures") && doc["textures"].is_array();

    if (hasImages) {
        // ---- Step 1: identify which images are KTX2 so we know which
        // textures need the extension lift, AND patch in mimeType.
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

        if (sawAnyKtx2 && hasTextures) {
            // ---- Step 2: rewrite textures[]. For each entry whose
            // top-level `source` points at a KTX2 image, remove the
            // top-level field and move the reference into
            // `extensions.KHR_texture_basisu.source`. Entries that
            // already have the extension in place are passed through
            // unchanged (idempotent on re-runs).
            for (auto& tx : doc["textures"]) {
                if (!tx.is_object()) continue;
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
            // extensionsRequired and extensionsUsed.
            ensureExtListContains("extensionsRequired", "KHR_texture_basisu");
            ensureExtListContains("extensionsUsed",     "KHR_texture_basisu");
        }
    }

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

    // ---- Step 3b: S3O-style PBR channel split + SPRINGRTS_team_color.
    //
    // When SPRINGRTS_geometry carries `tex1` (and optionally `tex2`),
    // the source is a Spring S3O-style asset whose two source textures
    // pack 8 channels of authoring data — diffuse RGB + team mask in
    // tex1.A, glow + spec + reflectivity + translucency across tex2.
    // Split those across four spec-compliant glTF PBR slots so a third-
    // party viewer (Blender, gltf-viewer.donmccurdy.com) renders the
    // unit correctly out of the box. The team mask is a first-class
    // glTF texture referenced via the custom `SPRINGRTS_team_color`
    // extension (optional — viewers without support still see the base
    // color, just without team tinting).
    //
    // The four KTX2 outputs (<stem>_diffuse, <stem>_team, <stem>_emissive,
    // <stem>_orm) do not exist on disk yet — gameconverter produces them
    // in a subsequent pass by re-running textureconverter with the
    // appropriate --channel-op. From the .gltf's perspective they are
    // simply image URIs the runtime will fetch.
    bool didChannelSplit = false;
    if (springGeometry != nullptr && springGeometry->is_object()) {
        auto stemOf = [](const std::string& ktx2Name) -> std::string {
            const size_t dot = ktx2Name.find_last_of('.');
            return (dot == std::string::npos) ? ktx2Name : ktx2Name.substr(0, dot);
        };

        std::string tex1, tex2, normaltex;
        if (springGeometry->contains("tex1") && (*springGeometry)["tex1"].is_string()) {
            tex1 = (*springGeometry)["tex1"].get<std::string>();
        }
        if (springGeometry->contains("tex2") && (*springGeometry)["tex2"].is_string()) {
            tex2 = (*springGeometry)["tex2"].get<std::string>();
        }
        if (springGeometry->contains("normaltex") && (*springGeometry)["normaltex"].is_string()) {
            normaltex = (*springGeometry)["normaltex"].get<std::string>();
        }

        if (!tex1.empty()) {
            const std::string s1 = stemOf(tex1);
            const std::string s2 = tex2.empty() ? std::string{} : stemOf(tex2);

            // Replace images[] with the four channel-split entries.
            // Order matters: indices below reference these slots.
            json images = json::array();
            images.push_back({
                {"uri",      s1 + "_diffuse.ktx2"},
                {"mimeType", "image/ktx2"},
            });
            const int diffuseImg = 0;
            int emissiveImg = -1, ormImg = -1;
            if (!s2.empty()) {
                images.push_back({
                    {"uri",      s2 + "_emissive.ktx2"},
                    {"mimeType", "image/ktx2"},
                });
                emissiveImg = static_cast<int>(images.size()) - 1;
                images.push_back({
                    {"uri",      s2 + "_orm.ktx2"},
                    {"mimeType", "image/ktx2"},
                });
                ormImg = static_cast<int>(images.size()) - 1;
            }
            images.push_back({
                {"uri",      s1 + "_team.ktx2"},
                {"mimeType", "image/ktx2"},
            });
            const int teamImg = static_cast<int>(images.size()) - 1;
            // Optional normal map — routed straight through as a regular
            // pass-through KTX2 (no channel-split surgery). gameconverter
            // doesn't recognise the URI's stem as a split suffix and
            // falls back to a plain --no-channel-op encode against the
            // source bitmap, preserving RGB for the normal map.
            int normalImg = -1;
            if (!normaltex.empty()) {
                images.push_back({
                    {"uri",      normaltex},
                    {"mimeType", "image/ktx2"},
                });
                normalImg = static_cast<int>(images.size()) - 1;
            }
            doc["images"] = std::move(images);

            // Reuse the existing sampler when present (Assimp emits one
            // default sampler when textures are bound); fall back to
            // sampler index 0 (the spec allows omitting the sampler ref
            // entirely, but most viewers prefer an explicit index).
            int samplerIdx = 0;
            const bool hasSamplers = doc.contains("samplers")
                                  && doc["samplers"].is_array()
                                  && !doc["samplers"].empty();
            if (!hasSamplers) {
                doc["samplers"] = json::array({ json::object() });  // single default sampler
            }

            auto makeTexture = [&](int imgIdx) {
                json tx = json::object();
                if (hasSamplers || true) tx["sampler"] = samplerIdx;
                tx["extensions"]["KHR_texture_basisu"]["source"] = imgIdx;
                return tx;
            };

            json textures = json::array();
            textures.push_back(makeTexture(diffuseImg));
            const int diffuseTex = 0;
            int emissiveTex = -1, ormTex = -1;
            if (emissiveImg >= 0) {
                textures.push_back(makeTexture(emissiveImg));
                emissiveTex = static_cast<int>(textures.size()) - 1;
            }
            if (ormImg >= 0) {
                textures.push_back(makeTexture(ormImg));
                ormTex = static_cast<int>(textures.size()) - 1;
            }
            textures.push_back(makeTexture(teamImg));
            const int teamTex = static_cast<int>(textures.size()) - 1;
            int normalTex = -1;
            if (normalImg >= 0) {
                textures.push_back(makeTexture(normalImg));
                normalTex = static_cast<int>(textures.size()) - 1;
            }
            doc["textures"] = std::move(textures);

            // Rebuild materials[0]. S3O sources only ever emit one
            // material (S3OImporter.cpp creates a single aiMaterial),
            // so replacing index 0 is safe. If the document somehow
            // has zero materials, create one.
            if (!doc.contains("materials") || !doc["materials"].is_array()
                || doc["materials"].empty()) {
                doc["materials"] = json::array({ json::object() });
            }
            json& mat = doc["materials"][0];
            // Preserve the material name if Assimp set one (the S3O
            // importer stamps `s3o_<filename>`).
            json preservedName;
            if (mat.is_object() && mat.contains("name")) {
                preservedName = mat["name"];
            }
            mat = json::object();
            if (!preservedName.is_null()) mat["name"] = preservedName;

            json pbr = json::object();
            pbr["baseColorTexture"]  = { {"index", diffuseTex} };
            pbr["metallicFactor"]    = 1.0;
            pbr["roughnessFactor"]   = 1.0;
            if (ormTex >= 0) {
                pbr["metallicRoughnessTexture"] = { {"index", ormTex} };
            }
            mat["pbrMetallicRoughness"] = std::move(pbr);

            if (emissiveTex >= 0) {
                mat["emissiveTexture"] = { {"index", emissiveTex} };
                mat["emissiveFactor"]  = json::array({ 1.0, 1.0, 1.0 });
            }
            if (ormTex >= 0) {
                mat["occlusionTexture"] = { {"index", ormTex} };
            }
            if (normalTex >= 0) {
                mat["normalTexture"] = { {"index", normalTex} };
            }
            // Render OPAQUE by default. Spring's model shader computes
            // `alpha = teamCol.a * float(tex2.a >= 0.5)` then conditionally
            // discards via an `alphaCtrl` uniform that defaults to
            // "always pass" — so in normal opaque draws the alpha test
            // never fires. The engine only enables it for specific
            // passes (shadow gen, alpha-blend bin). A static glTF can't
            // toggle per-pass, and emitting MASK + 0.5 unconditionally
            // discarded ~90% of fragments for assets where tex2.A is
            // sparse/zero (most ZK content, e.g. strikecom has 86% of
            // tex2.A == 0). The tex2.A overlay still lands in
            // baseColorTexture.A for future per-pass use, but stays
            // ignored at render time. `alphaMode` is omitted (defaults
            // to OPAQUE per glTF 2.0 §5.19.3).

            mat["extensions"]["SPRINGRTS_team_color"]["maskTexture"] =
                json::object({ {"index", teamTex} });

            // Lift the optional `invertTeamColor` flag out of
            // SPRINGRTS_geometry and onto the material extension where
            // the spec puts it. Only emit when true — the default is
            // false and omitting the key keeps the JSON tidy.
            if (springGeometry->contains("invertTeamColor")
                && (*springGeometry)["invertTeamColor"].is_boolean()
                && (*springGeometry)["invertTeamColor"].get<bool>()) {
                mat["extensions"]["SPRINGRTS_team_color"]["invertMask"] = true;
            }

            // Every material we just synthesised references KTX2 images
            // via KHR_texture_basisu — make sure it lands in both the
            // used and required lists. SPRINGRTS_team_color goes to
            // `used` only since viewers without it still render the
            // base color (just without team tinting).
            ensureExtListContains("extensionsRequired", "KHR_texture_basisu");
            ensureExtListContains("extensionsUsed",     "KHR_texture_basisu");
            ensureExtListContains("extensionsUsed",     "SPRINGRTS_team_color");

            didChannelSplit = true;
        }
    }

    // ---- Step 3b': relocate a `*_tcmask` texture into the
    // SPRINGRTS_team_color extension (plain-diffuse team-colour path).
    //
    // For Warzone `.pie` sources the S3O channel-split above never runs
    // (no packed tex1/tex2). Instead the PIE importer carried the PIE4
    // `TCMASK` page on a spare standard texture slot (LIGHTMAP →
    // occlusionTexture) so it survives Assimp export as an ordinary
    // texture. Assimp can't emit our custom material extension, so — like
    // the S3O team mask — we inject it here: find any material whose
    // referenced texture image URI matches `*_tcmask.*`, move that texture
    // reference into `material.extensions.SPRINGRTS_team_color.maskTexture`,
    // and erase the carrier PBR slot. The mask is greyscale (`.r` = team
    // blend amount, white = team region), so no `invertMask`. The renderer
    // reads it per-material (entity-renderer's fetchModelConfig), composing
    // with per-piece materials automatically.
    {
        auto imageUriForTexture = [&](int texIdx) -> std::string {
            if (!doc.contains("textures") || !doc["textures"].is_array()) return {};
            if (texIdx < 0 || texIdx >= static_cast<int>(doc["textures"].size())) return {};
            const json& tx = doc["textures"][texIdx];
            int imgIdx = -1;
            if (tx.contains("extensions") && tx["extensions"].is_object()
                && tx["extensions"].contains("KHR_texture_basisu")
                && tx["extensions"]["KHR_texture_basisu"].contains("source")
                && tx["extensions"]["KHR_texture_basisu"]["source"].is_number_integer()) {
                imgIdx = tx["extensions"]["KHR_texture_basisu"]["source"].get<int>();
            } else if (tx.contains("source") && tx["source"].is_number_integer()) {
                imgIdx = tx["source"].get<int>();
            }
            if (imgIdx < 0 || !doc.contains("images") || !doc["images"].is_array()
                || imgIdx >= static_cast<int>(doc["images"].size())) return {};
            const json& img = doc["images"][imgIdx];
            return (img.contains("uri") && img["uri"].is_string())
                ? img["uri"].get<std::string>() : std::string{};
        };
        auto isTcmask = [](std::string uri) {
            for (char& c : uri) c = static_cast<char>(std::tolower((unsigned char)c));
            return uri.find("_tcmask") != std::string::npos;
        };
        auto tryRelocate = [&](json& holder, const char* key, json& mat) -> bool {
            if (!holder.contains(key) || !holder[key].is_object()) return false;
            const json& slot = holder[key];
            if (!slot.contains("index") || !slot["index"].is_number_integer()) return false;
            const int texIdx = slot["index"].get<int>();
            if (!isTcmask(imageUriForTexture(texIdx))) return false;
            mat["extensions"]["SPRINGRTS_team_color"]["maskTexture"] =
                json::object({ {"index", texIdx} });
            holder.erase(key);
            return true;
        };
        bool anyTeam = false;
        if (doc.contains("materials") && doc["materials"].is_array()) {
            for (auto& mat : doc["materials"]) {
                if (!mat.is_object()) continue;
                // Sequenced (no bitwise |): every slot must be tried, and
                // when two carrier slots hold a *_tcmask the LAST one tried
                // must win deterministically — `|` leaves the evaluation
                // order (and thus the maskTexture winner) compiler-defined.
                bool moved = tryRelocate(mat, "occlusionTexture", mat);
                moved = tryRelocate(mat, "emissiveTexture", mat) || moved;
                moved = tryRelocate(mat, "normalTexture", mat) || moved;
                if (mat.contains("pbrMetallicRoughness") && mat["pbrMetallicRoughness"].is_object())
                    moved = tryRelocate(mat["pbrMetallicRoughness"], "metallicRoughnessTexture", mat) || moved;
                if (moved) {
                    // A stolen emissiveTexture would leave a stray white
                    // emissiveFactor; drop it so the piece isn't self-lit.
                    mat.erase("emissiveFactor");
                    anyTeam = true;
                }
            }
        }
        if (anyTeam) ensureExtListContains("extensionsUsed", "SPRINGRTS_team_color");
    }

    // ---- Step 3c: strip `alphaMode` from every material. Assimp emits
    // MASK whenever the source diffuse texture has an alpha channel,
    // but in Spring S3O tex1.A encodes team-color blend amount and
    // tex2.A is sparse engine-side data — NEITHER is a transparency
    // mask. The Spring shader gates alpha test on a runtime uniform
    // (`alphaCtrl`) that defaults to "always pass"; the engine only
    // toggles cutout for specific render passes we can't replicate
    // from a static glTF. Emitting MASK + 0.5 here discards ~90% of
    // fragments on assets where tex2.A is mostly zero. The synthesised
    // PBR layout doesn't emit alphaMode either, so this sweep covers
    // both didChannelSplit and legacy/pass-through cases.
    if (doc.contains("materials") && doc["materials"].is_array()) {
        for (auto& mat : doc["materials"]) {
            if (mat.is_object()) {
                mat.erase("alphaMode");
                mat.erase("alphaCutoff");
            }
        }
    }

    // ---- Step 3d: prune `extensionsUsed` / `extensionsRequired` entries
    // that no longer appear in any `extensions: {...}` block. Assimp's
    // glTF exporter eagerly declares extensions it inferred from the
    // source (KHR_materials_volume, KHR_materials_ior, KHR_materials_specular,
    // FB_ngon_encoding) even when the resulting material/mesh data
    // doesn't actually use them — and replacing materials[0] in step 3b
    // strands those declarations. Khronos validator (correctly) warns
    // about declared-but-unused extensions; this sweep keeps the list
    // honest. Walk the document recursively, collect every name that
    // appears as a key inside an `extensions` block, then filter the
    // top-level lists against that set.
    {
        std::set<std::string> referenced;
        std::function<void(const json&)> collect = [&](const json& node) {
            if (node.is_object()) {
                auto it = node.find("extensions");
                if (it != node.end() && it->is_object()) {
                    for (auto& kv : it->items()) {
                        referenced.insert(kv.key());
                    }
                }
                for (auto& kv : node.items()) {
                    if (kv.key() == "extensions") continue;  // already walked
                    collect(kv.value());
                }
            } else if (node.is_array()) {
                for (const auto& v : node) collect(v);
            }
        };
        collect(doc);

        auto pruneList = [&](const char* fieldName) {
            if (!doc.contains(fieldName) || !doc[fieldName].is_array()) return;
            json keep = json::array();
            for (const auto& v : doc[fieldName]) {
                if (!v.is_string()) continue;
                const std::string name = v.get<std::string>();
                if (name.empty()) continue;
                if (referenced.count(name) == 0) continue;
                keep.push_back(name);
            }
            if (keep.empty()) {
                doc.erase(fieldName);
            } else {
                doc[fieldName] = std::move(keep);
            }
        };
        pruneList("extensionsUsed");
        pruneList("extensionsRequired");
    }

    // ---- Step 3e: lift any sidecar piece-offset overrides onto the
    // matching .gltf node's transform. The same overrides already
    // reshape SPRINGRTS_geometry.pieces[] for sim-side consumers
    // (server-side firing, attachment offsets) — this step mirrors
    // them onto the visual side so the renderer agrees with the sim.
    //
    // Dominant case: strikecom-family commanders ship with the .dae
    // origin at the model's centre rather than its feet, and the
    // sidecar's `Scene.offset = {0, 31, 0}` is the author's lift to
    // land the model on the ground. Without this mirror, the .gltf
    // node hierarchy preserves Assimp's (0,0,0) translation on the
    // Scene node and the visual model sinks halfway underground at
    // runtime.
    //
    // Strategy: look up each piece name in `nodes[]`, then either
    // patch the matrix translation (cols 12/13/14, col-major) if the
    // node uses a matrix, or set the TRS `translation` field if not.
    // Replaces — does not accumulate — so re-runs land idempotently.
    if (springGeometry &&
        springGeometry->contains("pieceOverrides") &&
        (*springGeometry)["pieceOverrides"].is_object() &&
        doc.contains("nodes") && doc["nodes"].is_array())
    {
        const auto& po = (*springGeometry)["pieceOverrides"];
        auto& nodes = doc["nodes"];
        for (auto it = po.begin(); it != po.end(); ++it) {
            const std::string& name = it.key();
            const auto& off = it.value();
            if (!off.is_array() || off.size() != 3) continue;
            if (!off[0].is_number() || !off[1].is_number() || !off[2].is_number())
                continue;
            const double ox = off[0].get<double>();
            const double oy = off[1].get<double>();
            const double oz = off[2].get<double>();
            for (auto& node : nodes) {
                if (!node.is_object()) continue;
                auto nameIt = node.find("name");
                if (nameIt == node.end() || !nameIt->is_string()) continue;
                if (nameIt->get<std::string>() != name) continue;
                if (node.contains("matrix") && node["matrix"].is_array() &&
                    node["matrix"].size() == 16) {
                    node["matrix"][12] = ox;
                    node["matrix"][13] = oy;
                    node["matrix"][14] = oz;
                } else {
                    node["translation"] = json::array({ox, oy, oz});
                    node.erase("matrix");
                }
                break;
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
    // Normal-map texture for sources whose normal map is authored in the
    // unitDef (`customParams.normaltex`) rather than a per-model sidecar
    // — BAR's S3O units. gameconverter resolves the model→normaltex map
    // from the unitdefs and passes it here. Lifted into the glTF
    // `material.normalTexture` via SPRINGRTS_geometry, same as a sidecar
    // `normaltex`. Empty for assets that carry their own sidecar.
    std::string normaltexArg;
    // Emit the raw Assimp glTF2 exporter output verbatim — skip our
    // post-fix that rewrites texture references through
    // `KHR_texture_basisu`, injects `SPRINGRTS_geometry` /
    // `SPRINGRTS_team_color`, performs the S3O channel split, and
    // prunes unused extensions. Used to capture minimal reproducers
    // for upstream Assimp bug reports. Not a production code path.
    bool noPostfix = false;

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
        } else if (a == "--no-postfix") {
            noPostfix = true;
        } else if (a == "--texture-prefix" && i + 1 < argc) {
            texturePrefix = argv[++i];
        } else if (a == "--normaltex" && i + 1 < argc) {
            normaltexArg = argv[++i];
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

    // Register the S3O + PIE plugins. Assimp takes ownership.
    importer.RegisterLoader(new Assimp::S3OImporter());
    importer.RegisterLoader(new Assimp::PIEImporter());

    // Common post-processing flags. Triangulate is critical (we already
    // emit triangles for S3O but other importers may not). The rest are
    // friendly defaults for downstream renderers.
    //
    // aiProcess_GenSmoothNormals is kept as the fallback for source
    // meshes that ship without a NORMAL attribute (rare — most DCC
    // tool exports include one). It's a no-op on meshes that already
    // have normals (Assimp's GenVertexNormalsProcess explicitly skips
    // them), so authored split edges + smoothing groups from
    // Blender / Max / Maya survive intact.
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

    // Extract embedded textures from .glb / gltf-embedded sources to
    // sibling files of the output .gltf, and rewrite Assimp's "*N"
    // texture references to point at the on-disk filenames. The rest
    // of the pipeline (RewriteTextureExtensions → KTX2 rename, the
    // export, gameconverter's source-resolution probe) treats them
    // identically to externally-referenced textures from there on.
    ExtractEmbeddedTextures(const_cast<aiScene*>(scene), outPath);

    // Decide per-material whether to flip every UV V coordinate, then
    // apply the flip to each mesh that references a flagged material.
    //
    // Rationale: Spring's runtime convention for "what does UV V=0
    // sample" varies per source texture format — nv_dds always flips
    // DDS to bottom-up on load, while IL keeps TGA/PNG top-down unless
    // a parser-driven ReverseYAxis runs. Our pipeline normalises every
    // KTX2 to top-down storage, and Babylon uploads with FLIP_Y=true,
    // so V=0 always lands on the visual bottom of the source data.
    // Matching Spring's effective semantics therefore needs a flip
    // only for the cases where Spring sampled the visual top — that's
    // the case for non-DDS textures whose source parser had
    // `fliptextures = false` in effect. See
    // GeometryExtractor::ShouldFlipUv for the full decision table.
    //
    // A multi-material scene (rare in S3O, possible in .dae with mixed
    // DDS + TGA materials) gets a per-material verdict so each mesh
    // ends up with the right answer.
    {
        auto* mutScene = const_cast<aiScene*>(scene);
        std::vector<bool> matFlip(mutScene->mNumMaterials, false);

        // Read each material's tex1 reference and ask the helper.
        // ShouldFlipUv falls back to the Spring naming convention
        // (`<modelStem>1.<ext>`) when the material has no tex1 slot —
        // which is the typical .dae path before the sidecar lookup
        // runs in GeometryExtractor.
        for (unsigned m = 0; m < mutScene->mNumMaterials; ++m) {
            const aiMaterial* mat = mutScene->mMaterials[m];
            std::string tex1;
            if (mat != nullptr) {
                aiString s;
                if (mat->GetTexture(aiTextureType_DIFFUSE, 0, &s) == AI_SUCCESS) {
                    tex1.assign(s.C_Str(), s.length);
                } else if (mat->GetTexture(aiTextureType_BASE_COLOR, 0, &s) == AI_SUCCESS) {
                    tex1.assign(s.C_Str(), s.length);
                }
            }
            matFlip[m] = GeometryExtractor::ShouldFlipUv(inPath, tex1);
        }

        unsigned flippedMeshes = 0;
        for (unsigned m = 0; m < mutScene->mNumMeshes; ++m) {
            aiMesh* mesh = mutScene->mMeshes[m];
            if (!mesh) continue;
            if (mesh->mMaterialIndex >= matFlip.size()) continue;
            if (!matFlip[mesh->mMaterialIndex]) continue;
            for (unsigned ch = 0; ch < AI_MAX_NUMBER_OF_TEXTURECOORDS; ++ch) {
                aiVector3D* uvs = mesh->mTextureCoords[ch];
                if (!uvs) continue;
                for (unsigned i = 0; i < mesh->mNumVertices; ++i) {
                    uvs[i].y = 1.0f - uvs[i].y;
                }
            }
            ++flippedMeshes;
        }

        if (flippedMeshes > 0) {
            SLOG(SPRING_LOG_INFO,
                "fliptextures: V-flipped %u/%u meshes in %s",
                flippedMeshes, mutScene->mNumMeshes, inPath.c_str());
        }
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
    //
    // UV V flip is intentionally NOT delegated to aiProcess_FlipUVs.
    // glTF 2.0 mandates V=0 at the UPPER-LEFT of the texture image,
    // but Spring's effective V semantic varies per source texture
    // format (DDS vs TGA/PNG) and per parser-supplied `fliptextures`
    // value. The flip happens per material above (after ReadFile, in
    // the GeometryExtractor::ShouldFlipUv loop), so each mesh ends
    // up with UVs in the canonical glTF orientation. A blanket
    // aiProcess_FlipUVs at export time would double-flip everything
    // we already corrected and silently undo the per-material work.
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
    if (!noPostfix) {
        const nlohmann::json springGeometryJson =
            GeometryExtractor::BuildExtensionJson(scene, inPath, normaltexArg);
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
    }

    Assimp::DefaultLogger::kill();
    springlog_shutdown();
    return 0;
}
