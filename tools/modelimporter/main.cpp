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

// --------------------------------------------------------------------
// Minimal JSON-string scanning helpers used by FixGlbBasisuTextures.
// We don't pull in a JSON library — the Assimp glb2 exporter output
// has a well-known shape and we only need to read/replace a handful
// of top-level fields. The helpers are local to this file so the
// surface area stays small.
// --------------------------------------------------------------------

size_t SkipWs(const std::string& js, size_t i) {
    while (i < js.size() && std::isspace(static_cast<unsigned char>(js[i]))) ++i;
    return i;
}

std::string Trim(const std::string& s) {
    size_t b = 0, e = s.size();
    while (b < e && std::isspace(static_cast<unsigned char>(s[b]))) ++b;
    while (e > b && std::isspace(static_cast<unsigned char>(s[e - 1]))) --e;
    return s.substr(b, e - b);
}

/// Locate `"<key>"` followed by `:` (whitespace allowed) at the top
/// level of `js` and return the position of the first non-whitespace
/// character of the value. Returns npos if not found.
size_t FindFieldValue(const std::string& js, const std::string& key) {
    const std::string needle = "\"" + key + "\"";
    size_t pos = 0;
    while (true) {
        size_t k = js.find(needle, pos);
        if (k == std::string::npos) return std::string::npos;
        size_t after = k + needle.size();
        size_t colon = SkipWs(js, after);
        if (colon < js.size() && js[colon] == ':') {
            return SkipWs(js, colon + 1);
        }
        pos = k + 1;
    }
}

/// Given the position of an opening `[` or `{` in `js`, find the
/// matching close bracket, honouring nested brackets and string
/// literals.
size_t FindMatching(const std::string& js, size_t openPos) {
    if (openPos >= js.size()) return std::string::npos;
    const char open  = js[openPos];
    const char close = (open == '[') ? ']' : '}';
    int depth = 0;
    bool inStr = false, esc = false;
    for (size_t i = openPos; i < js.size(); ++i) {
        const char c = js[i];
        if (inStr) {
            if (esc) esc = false;
            else if (c == '\\') esc = true;
            else if (c == '"') inStr = false;
            continue;
        }
        if (c == '"') { inStr = true; continue; }
        if (c == open)  ++depth;
        else if (c == close) {
            --depth;
            if (depth == 0) return i;
        }
    }
    return std::string::npos;
}

/// Split the contents of a JSON array (the text between `[` and `]`,
/// exclusive) into its top-level entries. Whitespace is preserved
/// inside each entry; callers should Trim() when they care.
std::vector<std::string> SplitArrayEntries(const std::string& body) {
    std::vector<std::string> out;
    int depth = 0;
    bool inStr = false, esc = false;
    std::string cur;
    for (char c : body) {
        if (inStr) {
            cur.push_back(c);
            if (esc) esc = false;
            else if (c == '\\') esc = true;
            else if (c == '"') inStr = false;
            continue;
        }
        if (c == '"') { cur.push_back(c); inStr = true; continue; }
        if (c == '{' || c == '[') { ++depth; cur.push_back(c); continue; }
        if (c == '}' || c == ']') { --depth; cur.push_back(c); continue; }
        if (c == ',' && depth == 0) {
            out.push_back(cur);
            cur.clear();
            continue;
        }
        cur.push_back(c);
    }
    out.push_back(cur);
    // Drop trailing empty entries from a trailing comma or whitespace-only tail.
    while (!out.empty() && Trim(out.back()).empty()) out.pop_back();
    return out;
}

/// Extract the value of `"uri":"<string>"` from a JSON object literal
/// (`{...}` as text). Returns empty if not found or not parseable.
std::string ExtractUri(const std::string& objLiteral) {
    const std::string k = "\"uri\"";
    size_t p = objLiteral.find(k);
    if (p == std::string::npos) return {};
    size_t c = objLiteral.find(':', p + k.size());
    if (c == std::string::npos) return {};
    size_t q1 = objLiteral.find('"', c + 1);
    if (q1 == std::string::npos) return {};
    size_t q2 = objLiteral.find('"', q1 + 1);
    if (q2 == std::string::npos) return {};
    return objLiteral.substr(q1 + 1, q2 - q1 - 1);
}

/// Adjust the JSON of a freshly-written .glb or .gltf so KTX2 textures
/// are referenced through the KHR_texture_basisu extension exactly as
/// the extension spec mandates:
///
///   - Each `textures[]` entry whose `source` points at a `.ktx2` image
///     has the top-level `source` removed and replaced with
///     `"extensions":{"KHR_texture_basisu":{"source":N}}`.
///   - `KHR_texture_basisu` is added to both `extensionsRequired` and
///     `extensionsUsed` (creating the arrays if absent). Empty entries
///     left over by upstream tooling are pruned so the document
///     validates clean (no `EMPTY_ENTITY` warnings).
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
/// Hand-rolled JSON edits — no external dependency. The shape of
/// Assimp's output is well-known and the helpers above are enough.
bool FixGlbBasisuTextures(const std::string& path) {
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

    // ---- Step 1: identify which images are KTX2 so we know which
    // textures need the extension lift.
    const size_t imgValPos = FindFieldValue(js, "images");
    if (imgValPos == std::string::npos || js[imgValPos] != '[') return false;
    const size_t imgClosePos = FindMatching(js, imgValPos);
    if (imgClosePos == std::string::npos) return false;
    const std::string imgBody = js.substr(imgValPos + 1,
                                          imgClosePos - imgValPos - 1);
    std::vector<std::string> imgEntries = SplitArrayEntries(imgBody);

    std::vector<bool> isKtx2(imgEntries.size(), false);
    bool sawAnyKtx2 = false;
    for (size_t i = 0; i < imgEntries.size(); ++i) {
        const std::string uri = ExtractUri(imgEntries[i]);
        if (uri.size() < 5) continue;
        std::string tl = uri.substr(uri.size() - 5);
        for (char& c : tl) c = static_cast<char>(std::tolower((unsigned char)c));
        if (tl == ".ktx2") { isKtx2[i] = true; sawAnyKtx2 = true; }
    }
    if (!sawAnyKtx2) return true;

    // ---- Step 1b: rewrite images[] so every KTX2 entry carries a
    // `mimeType: "image/ktx2"`. The KHR_texture_basisu spec mandates
    // this field on URI-referenced KTX2 images, and the Blender
    // tonis2/glTF-KTX-texture addon gates its decode hook on
    // `gltf_img.mime_type == "image/ktx2"` — without it, Blender's
    // stock importer tries to load the .ktx2 as a regular image and
    // ends up with an Empty datablock. Idempotent: entries that
    // already carry the field pass through.
    {
        bool anyChanged = false;
        for (size_t i = 0; i < imgEntries.size(); ++i) {
            if (!isKtx2[i]) continue;
            std::string& e = imgEntries[i];
            if (e.find("\"mimeType\"") != std::string::npos) continue;
            const size_t close = e.find_last_of('}');
            if (close == std::string::npos) continue;
            bool needsComma = false;
            for (size_t k = close; k > 0; --k) {
                char c = e[k - 1];
                if (c == '{') break;
                if (!std::isspace(static_cast<unsigned char>(c))) {
                    needsComma = true;
                    break;
                }
            }
            const std::string insertion =
                std::string(needsComma ? "," : "")
                + "\"mimeType\":\"image/ktx2\"";
            e.insert(close, insertion);
            anyChanged = true;
        }
        if (anyChanged) {
            std::string newImgBody = "\n    ";
            bool first = true;
            for (auto& e : imgEntries) {
                const std::string t = Trim(e);
                if (t.empty()) continue;
                if (!first) newImgBody += ",\n    ";
                newImgBody += t;
                first = false;
            }
            newImgBody += "\n  ";
            js = js.substr(0, imgValPos + 1) + newImgBody + js.substr(imgClosePos);
        }
    }

    // ---- Step 2: rewrite textures[]. For each entry whose top-level
    // `source` points at a KTX2 image, remove the top-level field and
    // move the reference into `extensions.KHR_texture_basisu.source`.
    // Entries that already have the extension in place are passed
    // through unchanged (idempotent on re-runs).
    const size_t txValPos = FindFieldValue(js, "textures");
    if (txValPos == std::string::npos || js[txValPos] != '[') return false;
    const size_t txClosePos = FindMatching(js, txValPos);
    if (txClosePos == std::string::npos) return false;
    const std::string txBody = js.substr(txValPos + 1,
                                         txClosePos - txValPos - 1);
    std::vector<std::string> txEntries = SplitArrayEntries(txBody);

    auto findIntField = [](const std::string& obj, size_t startFrom,
                           const std::string& key, int& outVal,
                           size_t& outKeyPos, size_t& outValEnd) -> bool {
        const std::string needle = "\"" + key + "\"";
        size_t p = obj.find(needle, startFrom);
        if (p == std::string::npos) return false;
        size_t c = obj.find(':', p + needle.size());
        if (c == std::string::npos) return false;
        size_t s = SkipWs(obj, c + 1);
        size_t e = s;
        while (e < obj.size() && std::isdigit(static_cast<unsigned char>(obj[e]))) ++e;
        if (e == s) return false;
        outVal = std::stoi(obj.substr(s, e - s));
        outKeyPos = p;
        outValEnd = e;
        return true;
    };

    std::vector<std::string> newTxEntries;
    for (auto& raw : txEntries) {
        std::string e = Trim(raw);
        if (e.empty()) continue;

        // Already in extension form — leave alone (idempotent on re-runs).
        if (e.find("\"KHR_texture_basisu\"") != std::string::npos) {
            newTxEntries.push_back(e);
            continue;
        }

        // Look for top-level "source": N pointing at a KTX2 image.
        int srcIdx = -1; size_t keyPos = 0, valEnd = 0;
        if (!findIntField(e, 0, "source", srcIdx, keyPos, valEnd)
            || srcIdx < 0
            || srcIdx >= static_cast<int>(isKtx2.size())
            || !isKtx2[srcIdx])
        {
            newTxEntries.push_back(e);
            continue;
        }

        // Erase the top-level "source": N (plus an adjacent comma).
        size_t eraseStart = keyPos;
        size_t eraseEnd = valEnd;
        if (eraseEnd < e.size() && e[eraseEnd] == ',') ++eraseEnd;
        else if (eraseStart > 0 && e[eraseStart - 1] == ',') --eraseStart;
        e.erase(eraseStart, eraseEnd - eraseStart);

        // Insert the extension block before the closing brace. If the
        // object still has other fields, prepend a comma.
        size_t closeBrace = e.find_last_of('}');
        bool needsComma = false;
        for (size_t i = closeBrace; i > 0; --i) {
            char c = e[i - 1];
            if (c == '{') break;
            if (!std::isspace(static_cast<unsigned char>(c))) {
                needsComma = true;
                break;
            }
        }
        std::string insertion =
            std::string(needsComma ? "," : "")
            + "\"extensions\":{\"KHR_texture_basisu\":{\"source\":"
            + std::to_string(srcIdx) + "}}";
        e.insert(closeBrace, insertion);
        newTxEntries.push_back(e);
    }

    std::string newTxBody = "\n    ";
    {
        bool first = true;
        for (auto& e : newTxEntries) {
            if (!first) newTxBody += ",\n    ";
            newTxBody += e;
            first = false;
        }
        newTxBody += "\n  ";
    }
    js = js.substr(0, txValPos + 1) + newTxBody + js.substr(txClosePos);

    // ---- Step 3: ensure KHR_texture_basisu appears in both
    // extensionsRequired and extensionsUsed. Prune empty entries.
    auto ensureExtListContains =
        [&](const std::string& fieldName, const std::string& ext) {
        const size_t fvPos = FindFieldValue(js, fieldName);
        if (fvPos == std::string::npos) {
            // Field missing — inject one right after the opening `{` of
            // the document.
            size_t docOpen = js.find('{');
            if (docOpen == std::string::npos) return;
            const std::string injection =
                std::string("\"") + fieldName + "\":[\"" + ext + "\"],";
            js.insert(docOpen + 1, injection);
            return;
        }
        if (js[fvPos] != '[') return;  // unexpected shape — leave alone
        const size_t fvClose = FindMatching(js, fvPos);
        if (fvClose == std::string::npos) return;
        const std::string body = js.substr(fvPos + 1, fvClose - fvPos - 1);
        std::vector<std::string> entries = SplitArrayEntries(body);
        std::vector<std::string> keep;
        bool hasExt = false;
        const std::string quoted = "\"" + ext + "\"";
        for (auto& r : entries) {
            const std::string t = Trim(r);
            if (t.empty()) continue;            // prune EMPTY_ENTITY
            if (t == quoted) hasExt = true;
            keep.push_back(t);
        }
        if (!hasExt) keep.push_back(quoted);
        std::string newBody;
        for (size_t i = 0; i < keep.size(); ++i) {
            if (i > 0) newBody += ",";
            newBody += keep[i];
        }
        js = js.substr(0, fvPos + 1) + newBody + js.substr(fvClose);
    };
    ensureExtListContains("extensionsRequired", "KHR_texture_basisu");
    ensureExtListContains("extensionsUsed",     "KHR_texture_basisu");

    // ---- Step 3b: strip `"alphaMode": "MASK"` from materials. Assimp
    // emits MASK whenever the source diffuse texture has an alpha
    // channel, but in Spring S3O the alpha channel encodes team-color
    // blend amount — NOT transparency. With MASK plus the default
    // 0.5 cutoff, any glTF-spec-compliant viewer (Blender, Khronos
    // sample, gltf-viewer.donmccurdy.com) discards ~93% of fragments
    // and the unit appears almost fully invisible. Our runtime
    // sampler reads alpha explicitly, so stripping the field
    // (defaulting to OPAQUE) loses no information.
    {
        const std::string needle = "\"alphaMode\"";
        size_t pos = 0;
        while ((pos = js.find(needle, pos)) != std::string::npos) {
            size_t colon = js.find(':', pos + needle.size());
            if (colon == std::string::npos) break;
            size_t vs = SkipWs(js, colon + 1);
            if (vs >= js.size() || js[vs] != '"') { pos = colon + 1; continue; }
            size_t ve = js.find('"', vs + 1);
            if (ve == std::string::npos) break;
            size_t eraseStart = pos;
            size_t eraseEnd = ve + 1;
            // Eat a trailing comma if there's another field after us.
            // Else walk back over whitespace to absorb the preceding
            // comma — pretty-printed JSON puts \n + indent between
            // fields, so the comma is several chars before `pos`.
            size_t afterWs = eraseEnd;
            while (afterWs < js.size()
                && std::isspace(static_cast<unsigned char>(js[afterWs])))
                ++afterWs;
            if (afterWs < js.size() && js[afterWs] == ',') {
                eraseEnd = afterWs + 1;
            } else {
                size_t backWs = eraseStart;
                while (backWs > 0
                    && std::isspace(static_cast<unsigned char>(js[backWs - 1])))
                    --backWs;
                if (backWs > 0 && js[backWs - 1] == ',') {
                    eraseStart = backWs - 1;
                }
            }
            js.erase(eraseStart, eraseEnd - eraseStart);
            pos = eraseStart;
        }
    }

    // ---- Step 4: write back. For .gltf this is a straight overwrite;
    // for .glb we re-pad and re-emit the binary container.
    const std::string tmp = path + ".tmp";
    std::ofstream of(tmp, std::ios::binary | std::ios::trunc);
    if (!of) return false;
    if (isGlb) {
        std::vector<uint8_t> jsonBytes(js.begin(), js.end());
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
        of.write(js.data(), static_cast<std::streamsize>(js.size()));
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
    if (textureExt == "ktx2"
        && (EndsWith(outPath, ".glb") || EndsWith(outPath, ".gltf")))
    {
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
