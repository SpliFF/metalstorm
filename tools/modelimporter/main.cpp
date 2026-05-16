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

/// Walk the JSON chunk of a freshly-written .glb and adapt it so the
/// file is a spec-compliant glTF 2.0 document for every loader:
///
///   1. Append a sibling `<stem>.png` image entry next to every
///      `<stem>.ktx2` image entry — that's the fallback our pipeline
///      ships for loaders without KHR_texture_basisu.
///   2. Rewrite each `textures[]` entry so the top-level `source`
///      points at the PNG fallback, and `extensions.KHR_texture_basisu.source`
///      carries the KTX2 reference. (Assimp's exporter writes only
///      the top-level source; runtimes that understand the extension
///      use it preferentially, others see the PNG.)
///   3. Remove `KHR_texture_basisu` from `extensionsRequired` — the
///      PNG fallback means the extension is optional. Keep it in
///      `extensionsUsed`.
///
/// Why this matters: Blender, gltf-viewer, gltf-pipeline, and any
/// other spec-correct loader must refuse a file whose
/// `extensionsRequired` lists an extension they don't implement.
/// Before this routine landed, `KHR_texture_basisu` was required and
/// no fallback existed, so every third-party tool rejected our .glbs.
/// The PNG fallback closes that complaint without giving up the
/// runtime KTX2 path.
///
/// Hand-rolled JSON edits — no external dependency. The shape of
/// Assimp's output is well-known; the helpers above are sufficient.
/// The BIN chunk (vertex/index buffers) is preserved verbatim.
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

    // Early-out: nothing to do if there's no KTX2 reference anywhere.
    if (js.find(".ktx2") == std::string::npos) return true;

    // ---- Step 1: enumerate images, find .ktx2 entries, build PNG siblings.
    const size_t imgValPos = FindFieldValue(js, "images");
    if (imgValPos == std::string::npos || js[imgValPos] != '[') return false;
    const size_t imgClosePos = FindMatching(js, imgValPos);
    if (imgClosePos == std::string::npos) return false;
    const std::string imgBody = js.substr(imgValPos + 1,
                                          imgClosePos - imgValPos - 1);
    std::vector<std::string> imgEntries = SplitArrayEntries(imgBody);

    // Map from KTX2 image index → new PNG image index.
    std::vector<int> ktx2Indices;
    std::vector<std::string> pngEntries;
    for (size_t i = 0; i < imgEntries.size(); ++i) {
        const std::string uri = ExtractUri(imgEntries[i]);
        if (uri.size() < 5) continue;
        const std::string tail = uri.substr(uri.size() - 5);
        // Lower-case compare so `.KTX2` etc. also match (Assimp lowercases
        // but the source path the URI was rewritten from might not).
        std::string tl = tail;
        for (char& c : tl) c = static_cast<char>(std::tolower((unsigned char)c));
        if (tl != ".ktx2") continue;

        ktx2Indices.push_back(static_cast<int>(i));
        const std::string pngUri = uri.substr(0, uri.size() - 5) + ".png";
        pngEntries.push_back("{\"uri\":\"" + pngUri + "\"}");
    }

    if (ktx2Indices.empty()) return true;  // nothing to do

    // ktx2 -> png lookup, sized inline for clarity.
    auto pngIndexFor = [&](int ktx2Idx) -> int {
        for (size_t p = 0; p < ktx2Indices.size(); ++p) {
            if (ktx2Indices[p] == ktx2Idx) {
                return static_cast<int>(imgEntries.size() + p);
            }
        }
        return -1;
    };

    // Rebuild images array: existing entries verbatim + new PNG entries.
    std::string newImgBody = "\n    ";
    bool first = true;
    for (auto& e : imgEntries) {
        if (!first) newImgBody += ",\n    ";
        newImgBody += Trim(e);
        first = false;
    }
    for (auto& e : pngEntries) {
        if (!first) newImgBody += ",\n    ";
        newImgBody += e;
        first = false;
    }
    newImgBody += "\n  ";
    js = js.substr(0, imgValPos + 1) + newImgBody + js.substr(imgClosePos);

    // ---- Step 2: rewrite textures[]. For each entry, locate the KTX2
    // image index (either from a top-level `"source": N` Assimp left in
    // place, or from `extensions.KHR_texture_basisu.source: N`). Insert
    // a top-level `"source": pngIdx` and ensure the KHR extension
    // references the KTX2 index.
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

        int ktx2Idx = -1;

        // Case A: extension already in place (post-Assimp post-processing
        // shape, or re-run of this fix). Find KHR_texture_basisu's source.
        size_t basisuPos = e.find("\"KHR_texture_basisu\"");
        if (basisuPos != std::string::npos) {
            int v = -1; size_t kp = 0, ve = 0;
            if (findIntField(e, basisuPos, "source", v, kp, ve)) {
                ktx2Idx = v;
            }
        }

        // Case B: bare Assimp output — top-level `"source": N` and no
        // extension block yet. Lift the source into the extension and
        // remember N for the PNG redirect.
        if (ktx2Idx < 0) {
            int v = -1; size_t kp = 0, ve = 0;
            if (findIntField(e, 0, "source", v, kp, ve)) {
                ktx2Idx = v;
                // Erase the `"source": N` plus its adjacent comma.
                size_t eraseStart = kp;
                size_t eraseEnd = ve;
                if (eraseEnd < e.size() && e[eraseEnd] == ',') ++eraseEnd;
                else if (eraseStart > 0 && e[eraseStart - 1] == ',') --eraseStart;
                e.erase(eraseStart, eraseEnd - eraseStart);
                // Insert the extensions block before the closing `}`.
                size_t closeBrace = e.find_last_of('}');
                const std::string insertion =
                    std::string(closeBrace > 0 && e[closeBrace - 1] != '{' ? "," : "")
                    + "\"extensions\":{\"KHR_texture_basisu\":{\"source\":"
                    + std::to_string(ktx2Idx) + "}}";
                e.insert(closeBrace, insertion);
            }
        }

        // Add the top-level PNG fallback `"source": pngIdx`. Insert
        // before `"extensions"` so the field ordering stays
        // human-readable.
        if (ktx2Idx >= 0) {
            const int pngIdx = pngIndexFor(ktx2Idx);
            if (pngIdx >= 0) {
                const std::string fallback =
                    "\"source\":" + std::to_string(pngIdx) + ",";
                size_t extPos = e.find("\"extensions\"");
                if (extPos != std::string::npos) {
                    e.insert(extPos, fallback);
                } else {
                    // Fallback insertion before closing brace.
                    size_t closeBrace = e.find_last_of('}');
                    e.insert(closeBrace, std::string(",") + fallback);
                }
            }
        }

        newTxEntries.push_back(e);
    }

    std::string newTxBody = "\n    ";
    first = true;
    for (auto& e : newTxEntries) {
        if (!first) newTxBody += ",\n    ";
        newTxBody += e;
        first = false;
    }
    newTxBody += "\n  ";
    // Recompute textures array bounds because Step 1 shifted positions.
    const size_t txValPos2 = FindFieldValue(js, "textures");
    const size_t txClosePos2 = FindMatching(js, txValPos2);
    js = js.substr(0, txValPos2 + 1) + newTxBody + js.substr(txClosePos2);

    // ---- Step 3: remove KHR_texture_basisu from extensionsRequired.
    const size_t reqValPos = FindFieldValue(js, "extensionsRequired");
    if (reqValPos != std::string::npos && js[reqValPos] == '[') {
        const size_t reqClosePos = FindMatching(js, reqValPos);
        const std::string reqBody = js.substr(reqValPos + 1,
                                              reqClosePos - reqValPos - 1);
        std::vector<std::string> reqEntries = SplitArrayEntries(reqBody);
        std::vector<std::string> keep;
        for (auto& r : reqEntries) {
            const std::string t = Trim(r);
            if (t == "\"KHR_texture_basisu\"" || t.empty()) continue;
            keep.push_back(t);
        }
        std::string newReqBody;
        for (size_t i = 0; i < keep.size(); ++i) {
            if (i > 0) newReqBody += ",";
            newReqBody += keep[i];
        }
        js = js.substr(0, reqValPos + 1) + newReqBody + js.substr(reqClosePos);
    }

    // Re-pad to 4-byte alignment.
    std::vector<uint8_t> jsonBytes(js.begin(), js.end());
    while (jsonBytes.size() % 4 != 0) jsonBytes.push_back(' ');

    // Preserve the BIN chunk (and any subsequent chunks) verbatim.
    std::vector<uint8_t> rest(data.begin() + 20 + jsonLen, data.end());

    const uint32_t newTotal = 12 + 8 + static_cast<uint32_t>(jsonBytes.size())
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
