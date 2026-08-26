// GeometryExtractor — see header for the produced schema.
//
// Builds the `SPRINGRTS_geometry` payload modelimporter embeds into
// every output .gltf as a document-level extension.

#include "GeometryExtractor.h"

#include <assimp/scene.h>
#include <assimp/material.h>

#include <algorithm>
#include <array>
#include <cctype>
#include <cmath>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <filesystem>
#include <fstream>
#include <limits>
#include <map>
#include <optional>
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

// Bounding-sphere radius around the AABB centre (midpos), matching Recoil's
// `S3DModel::SetMidAndRadius` (`(maxs - midpos).Length()`). The previous
// formula used `length(maxs)` from the model's local origin (0,0,0), which
// over-estimated by the midpos offset — e.g. zenith.s3o (132 tall,
// ground-anchored) got radius 160 instead of the correct 112.
float RadiusFromAabb(const Aabb& b) {
    const float hx = (b.maxX - b.minX) * 0.5f;
    const float hy = (b.maxY - b.minY) * 0.5f;
    const float hz = (b.maxZ - b.minZ) * 0.5f;
    return std::sqrt(hx * hx + hy * hy + hz * hz);
}

struct PieceRecord {
    std::string name;
    int parentIndex = -1;
    float offsetX = 0, offsetY = 0, offsetZ = 0;
    /// Raw linear 3×3 of the source node's local transform, row-major
    /// (`rot[0..2]` = row 0, etc.). Stored pre-mirror; the RH Z-mirror
    /// that matches `aiProcess_MakeLeftHanded`'s export flip is applied
    /// at emit time, exactly like `offset`'s Z-flip. Identity by default.
    float rot[9] = {1, 0, 0, 0, 1, 0, 0, 0, 1};
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
    // Linear part (rotation, possibly with scale). aiMatrix4x4 is
    // row-major: a1..a3 = row 0, b1..b3 = row 1, c1..c3 = row 2.
    rec.rot[0] = m.a1; rec.rot[1] = m.a2; rec.rot[2] = m.a3;
    rec.rot[3] = m.b1; rec.rot[4] = m.b2; rec.rot[5] = m.b3;
    rec.rot[6] = m.c1; rec.rot[7] = m.c2; rec.rot[8] = m.c3;

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

namespace {

/// Rewrite a texture filename's extension to `.ktx2`. The runtime
/// resolves a single canonical extension regardless of what the
/// source archive happened to ship; gameconverter encodes the actual
/// KTX2 in a separate pass.
void RewriteToKtx2(std::string& name) {
    if (name.empty()) return;
    const auto dot = name.find_last_of('.');
    const auto slash = name.find_last_of("/\\");
    if (dot == std::string::npos ||
        (slash != std::string::npos && dot < slash)) {
        name += ".ktx2";
    } else {
        name = name.substr(0, dot) + ".ktx2";
    }
}

/// Probe the Spring-conventional `<gameRoot>/unittextures/` directory
/// for `<stem><N>.<ext>` where N is 1 or 2 and `<ext>` is one of the
/// bitmap formats Spring archives typically ship. Used by `.dae` and
/// other formats whose Assimp importer leaves the material slots
/// empty and whose sidecar `.dae.lua` carries only geometry overrides
/// (the `factoryveh` case in PLAN-pbr-mapping.md). Case-insensitive
/// to tolerate mixed-case content authoring on Windows.
///
/// Also probes for `<stem>1_invert.<ext>` — a marker file Spring's
/// convention uses to flip the team-mask interpretation. When found,
/// sets `invertTeamColor=true`. The flag is only updated when a
/// marker is found; absence leaves the caller's value unchanged so a
/// sidecar override (which runs after this) wins on conflict.
void ProbeUnittexturesByConvention(const std::string& sourceModelPath,
                                   std::string& tex1, std::string& tex2,
                                   std::optional<bool>& invertTeamColor) {
    if (sourceModelPath.empty()) return;
    namespace fs = std::filesystem;
    const fs::path src(sourceModelPath);
    // <gameRoot>/Objects3d/<stem>.dae → <gameRoot>/unittextures/
    const fs::path unittex = src.parent_path().parent_path() / "unittextures";
    std::error_code ec;
    if (!fs::is_directory(unittex, ec)) return;

    const std::string stem = src.stem().string();
    auto stemLower = [](std::string s) {
        for (char& c : s) c = static_cast<char>(std::tolower(static_cast<unsigned char>(c)));
        return s;
    };

    static const char* const kExts[] = {
        ".png", ".dds", ".tga", ".bmp", ".jpg", ".jpeg", ".webp",
    };

    auto lookup = [&](int suffix) -> std::string {
        const std::string targetStem = stem + std::to_string(suffix);
        const std::string targetLower = stemLower(targetStem);
        // Direct hit first — cheap path.
        for (const char* ext : kExts) {
            if (fs::exists(unittex / (targetStem + ext), ec)) {
                return targetStem + ".ktx2";
            }
        }
        // Case-insensitive directory walk fallback.
        for (const auto& entry : fs::directory_iterator(unittex, ec)) {
            if (!entry.is_regular_file()) continue;
            const std::string fname = entry.path().filename().string();
            const std::string fstem = entry.path().stem().string();
            if (stemLower(fstem) == targetLower) {
                return targetStem + ".ktx2";  // runtime canonical extension
            }
        }
        return {};
    };

    if (tex1.empty()) tex1 = lookup(1);
    if (tex2.empty()) tex2 = lookup(2);

    // Inversion marker: `<stem>1_invert.<ext>` next to the regular
    // tex1. One ZK asset (factoryveh) ships this; the convention is
    // documented in PLAN-pbr-mapping.md.
    const std::string invertStem = stem + "1_invert";
    const std::string invertStemLower = stemLower(invertStem);
    for (const char* ext : kExts) {
        if (fs::exists(unittex / (invertStem + ext), ec)) {
            if (!invertTeamColor.has_value()) invertTeamColor = true;
            return;
        }
    }
    for (const auto& entry : fs::directory_iterator(unittex, ec)) {
        if (!entry.is_regular_file()) continue;
        const std::string fstem = entry.path().stem().string();
        if (stemLower(fstem) == invertStemLower) {
            if (!invertTeamColor.has_value()) invertTeamColor = true;
            return;
        }
    }
}

/// Bag of optional author-overridable fields extracted from the Spring
/// author-config sidecar (`<sourceModelPath>.lua`). Every field is
/// `std::optional` so absence ("computed default wins") is distinct from
/// presence ("author intent wins"). `std::nullopt` is the default.
struct SidecarOverrides {
    std::optional<float>                radius;
    std::optional<float>                height;
    std::optional<std::array<float, 3>> midpos;
    std::optional<std::array<float, 3>> mins;
    std::optional<std::array<float, 3>> maxs;
    /// Bare filename of the normal map (e.g. `bomberheavy_normals.dds`).
    /// Spring author convention; routed to glTF `material.normalTexture`
    /// at synthesis time. RewriteToKtx2 is applied on read.
    std::string                         normaltex;
    /// `fliptextures` sidecar flag, mirrored from Recoil's AssParser.
    /// In Recoil this asks the engine to call `bitmap->ReverseYAxis()`
    /// on the loaded texture before upload; mathematically equivalent
    /// to inverting V at UV-read time, which is what our pipeline does
    /// (we emit static .gltf + .bin so flipping at conversion time is
    /// cheaper than carrying a runtime flag and the result is identical).
    /// Caller resolves the default per input format:
    /// - S3O: handled inside S3OImporter (always flips, sidecar ignored)
    /// - DAE/FBX/OBJ via Assimp: default `true` (legacy compatibility,
    ///   matches Recoil's AssParser.cpp:591)
    /// - glTF input: default `false` (matches GLTFParser.cpp:437)
    std::optional<bool>                 flipTextures;
    /// Per-piece offset overrides from the sidecar `pieces` block.
    /// In ZK content this is dominated by root-piece "Scene" overrides
    /// (e.g. strikecom's `Scene.offset = {0, 31, 0}`) that lift the
    /// model so its base sits on the ground; the .dae was authored
    /// with origin at the model's centre, not its feet. Values are
    /// in sidecar/Spring coords (Y-up, LH) — caller applies the Z
    /// flip to land them in RH/glTF space.
    std::map<std::string, std::array<float, 3>> pieceOffsets;
};

/// Pull all author-overridable fields from a Spring author-config
/// sibling (`<sourceModelPath>.lua`, e.g. `strikecom.dae.lua`). Legacy
/// .dae/.fbx archives store texture bindings and engine-side overrides
/// here because their native format has no slot for Spring metadata.
/// The file is small and the keys are unambiguous, so plain string
/// scanning suffices.
///
/// `tex1`/`tex2` are filled in only when the caller's value is empty
/// (the naming-convention probe runs first and might already have
/// resolved them). `invertteamcolor` always wins from the sidecar when
/// present. The bound overrides (`radius`/`height`/`midpos`/`mins`/`maxs`)
/// land in `overrides` as `std::optional` so the caller distinguishes
/// "use sidecar value" from "fall back to computed".
void ReadSidecarFields(const std::string& sourceModelPath,
                       std::string& tex1, std::string& tex2,
                       std::optional<bool>& invertTeamColor,
                       SidecarOverrides& overrides) {
    if (sourceModelPath.empty()) return;
    const std::string springLua = sourceModelPath + ".lua";
    std::ifstream lua(springLua, std::ios::binary);
    if (!lua) return;
    const std::string txt{std::istreambuf_iterator<char>(lua),
                          std::istreambuf_iterator<char>()};

    // Quoted-string field reader — matches `key = "..."` for the
    // texture bindings.
    auto readString = [&](const std::string& key) -> std::string {
        size_t k = txt.find(key);
        if (k == std::string::npos) return {};
        size_t q1 = txt.find('"', k + key.size());
        if (q1 == std::string::npos) return {};
        size_t q2 = txt.find('"', q1 + 1);
        if (q2 == std::string::npos) return {};
        return txt.substr(q1 + 1, q2 - q1 - 1);
    };

    // Scalar number reader — matches `key = <num>` (no quotes).
    // Returns std::nullopt if the key isn't present or the value isn't
    // parseable; the caller distinguishes that from a sidecar value of 0.
    auto readNumber = [&](const std::string& key) -> std::optional<float> {
        size_t k = txt.find(key);
        if (k == std::string::npos) return std::nullopt;
        size_t eq = txt.find('=', k + key.size());
        if (eq == std::string::npos) return std::nullopt;
        size_t v = eq + 1;
        while (v < txt.size() && (txt[v] == ' ' || txt[v] == '\t')) ++v;
        if (v >= txt.size()) return std::nullopt;
        // Reject if the value starts a quote/brace — that's a string
        // or table, not a number, and the key probably collided with a
        // longer key by prefix match. (e.g. `radius` shouldn't pick up
        // `radiusscale = "..."`.)
        if (txt[v] == '"' || txt[v] == '{') return std::nullopt;
        char* end = nullptr;
        const float parsed = std::strtof(txt.c_str() + v, &end);
        if (end == txt.c_str() + v) return std::nullopt;
        return parsed;
    };

    // Vec3 reader — matches `key = { x, y, z }`. The .dae.lua dialect
    // uses Lua-table syntax for vectors. Whitespace and trailing
    // commas are tolerated.
    auto readVec3 = [&](const std::string& key)
        -> std::optional<std::array<float, 3>>
    {
        size_t k = txt.find(key);
        if (k == std::string::npos) return std::nullopt;
        size_t open = txt.find('{', k + key.size());
        if (open == std::string::npos) return std::nullopt;
        size_t close = txt.find('}', open + 1);
        if (close == std::string::npos) return std::nullopt;
        const std::string body = txt.substr(open + 1, close - open - 1);
        std::array<float, 3> out{};
        int n = 0;
        size_t pos = 0;
        while (pos < body.size() && n < 3) {
            while (pos < body.size() &&
                   (body[pos] == ' ' || body[pos] == '\t' || body[pos] == ',' ||
                    body[pos] == '\n' || body[pos] == '\r')) ++pos;
            if (pos >= body.size()) break;
            char* end = nullptr;
            out[n] = std::strtof(body.c_str() + pos, &end);
            if (end == body.c_str() + pos) break;
            pos = end - body.c_str();
            ++n;
        }
        if (n != 3) return std::nullopt;
        return out;
    };

    if (tex1.empty()) { tex1 = readString("tex1"); RewriteToKtx2(tex1); }
    if (tex2.empty()) { tex2 = readString("tex2"); RewriteToKtx2(tex2); }

    // Normaltex routes straight to glTF `material.normalTexture` at
    // synthesis time; no team-color/AO-style channel surgery needed.
    if (overrides.normaltex.empty()) {
        overrides.normaltex = readString("normaltex");
        RewriteToKtx2(overrides.normaltex);
    }

    // Generic boolean reader for `<key> = true|false`. Returns
    // std::nullopt if the key is absent or the value isn't `true`
    // / `false` verbatim — caller distinguishes "sidecar didn't say"
    // from "sidecar said false".
    auto readBool = [&](const std::string& key) -> std::optional<bool> {
        size_t kp = txt.find(key);
        if (kp == std::string::npos) return std::nullopt;
        size_t eq = txt.find('=', kp + key.size());
        if (eq == std::string::npos) return std::nullopt;
        size_t v = eq + 1;
        while (v < txt.size() && (txt[v] == ' ' || txt[v] == '\t')) ++v;
        if (txt.compare(v, 4, "true") == 0) return true;
        if (txt.compare(v, 5, "false") == 0) return false;
        return std::nullopt;
    };

    // `invertteamcolor` overrides anything the naming probe set —
    // if the key is present, take its value verbatim.
    if (auto b = readBool("invertteamcolor"); b.has_value())
        invertTeamColor = *b;

    // `fliptextures` — Spring's per-asset flag for textures that need
    // the engine to vertically reverse them before upload. Routed to
    // overrides for the caller to apply at UV-read time (equivalent).
    if (auto b = readBool("fliptextures"); b.has_value())
        overrides.flipTextures = *b;

    // Bound overrides. Author intent supersedes the AABB-derived values
    // computed by the caller. 91.6% of ZK .dae.lua sidecars carry a
    // radius override that differs from the mesh AABB by >20% (skinny
    // units with antennas, models with decorative outliers, gameplay-
    // constant landing pads, etc.) — these are not vestigial values,
    // they shape spatial queries / LOS / pathing in real ways.
    if (auto v = readNumber("radius")) overrides.radius = *v;
    if (auto v = readNumber("height")) overrides.height = *v;
    if (auto v = readVec3("midpos"))   overrides.midpos = *v;
    if (auto v = readVec3("mins"))     overrides.mins   = *v;
    if (auto v = readVec3("maxs"))     overrides.maxs   = *v;

    // Piece offset overrides. Walks the `pieces = { ... }` block and
    // captures every `<Name> = { ... offset = { x, y, z } ... }`
    // pattern, regardless of nesting depth. The dominant case in ZK
    // is a root-piece "Scene" entry on commander/`.dae`-sourced units
    // whose author origin sits at the model's centre rather than its
    // feet (strikecom family: `Scene.offset = {0, 31, 0}` lifts the
    // model so its base lands on the ground). Sub-piece offsets in
    // nested blocks (geo.dae.lua: `base.wheel.offset`) are picked up
    // by the same scan — only matters when non-zero, which in ZK
    // they aren't. Commented-out blocks (`--pieces = {`) are tolerated
    // because the body scan still runs but no `<Name> = {` patterns
    // emerge from a comment-prefixed body. The scan uses brace
    // counting to find the matching close of `pieces = {`, then
    // walks every `offset` keyword and resolves its enclosing block's
    // identifier via reverse brace tracking.
    {
        const size_t piecesKw = txt.find("pieces");
        if (piecesKw != std::string::npos) {
            const size_t eq = txt.find('=', piecesKw + 6);
            if (eq != std::string::npos) {
                const size_t open = txt.find('{', eq);
                if (open != std::string::npos) {
                    int depth = 1;
                    size_t pos = open + 1;
                    while (pos < txt.size() && depth > 0) {
                        if (txt[pos] == '{') ++depth;
                        else if (txt[pos] == '}') {
                            if (--depth == 0) break;
                        }
                        ++pos;
                    }
                    if (pos < txt.size()) {
                        const std::string body = txt.substr(open + 1, pos - open - 1);
                        size_t scan = 0;
                        while (scan < body.size()) {
                            const size_t offKw = body.find("offset", scan);
                            if (offKw == std::string::npos) break;
                            // Find immediately-enclosing '{' by walking
                            // back with a brace counter.
                            int d = 0;
                            size_t bracePos = std::string::npos;
                            for (long i = static_cast<long>(offKw) - 1; i >= 0; --i) {
                                const char c = body[i];
                                if (c == '}') ++d;
                                else if (c == '{') {
                                    if (d == 0) { bracePos = static_cast<size_t>(i); break; }
                                    --d;
                                }
                            }
                            if (bracePos == std::string::npos) { scan = offKw + 6; continue; }
                            // Resolve `<name>` that precedes that '{'.
                            long i = static_cast<long>(bracePos) - 1;
                            while (i >= 0 && (body[i] == ' ' || body[i] == '\t' ||
                                              body[i] == '\n' || body[i] == '\r')) --i;
                            if (i < 0 || body[i] != '=') { scan = offKw + 6; continue; }
                            --i;
                            while (i >= 0 && (body[i] == ' ' || body[i] == '\t')) --i;
                            const long nameEnd = i + 1;
                            while (i >= 0 && (std::isalnum(static_cast<unsigned char>(body[i])) ||
                                              body[i] == '_')) --i;
                            const long nameStart = i + 1;
                            if (nameStart >= nameEnd) { scan = offKw + 6; continue; }
                            const std::string name = body.substr(nameStart, nameEnd - nameStart);
                            // Parse `offset = { x, y, z }`.
                            const size_t offEq = body.find('=', offKw + 6);
                            if (offEq == std::string::npos) { scan = offKw + 6; continue; }
                            const size_t offOpen = body.find('{', offEq);
                            const size_t offClose = (offOpen != std::string::npos)
                                ? body.find('}', offOpen) : std::string::npos;
                            if (offOpen == std::string::npos || offClose == std::string::npos) {
                                scan = offKw + 6;
                                continue;
                            }
                            std::array<float, 3> vec{};
                            int n = 0;
                            size_t p = offOpen + 1;
                            while (p < offClose && n < 3) {
                                while (p < offClose &&
                                       (body[p] == ' ' || body[p] == '\t' ||
                                        body[p] == ',' || body[p] == '\n' ||
                                        body[p] == '\r')) ++p;
                                if (p >= offClose) break;
                                char* endPtr = nullptr;
                                vec[n] = std::strtof(body.c_str() + p, &endPtr);
                                if (endPtr == body.c_str() + p) break;
                                p = static_cast<size_t>(endPtr - body.c_str());
                                ++n;
                            }
                            if (n == 3) {
                                overrides.pieceOffsets[name] = vec;
                            }
                            scan = offClose + 1;
                        }
                    }
                }
            }
        }
    }
}

} // namespace

nlohmann::json GeometryExtractor::BuildExtensionJson(const aiScene* scene,
                                                    const std::string& sourceModelPath,
                                                    const std::string& normaltexOverride) {
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

    // ---- Texture references (transitional; removed in Phase 1d) ----
    //
    // The `tex1`/`tex2` fields drive the S3O 8-channel PBR split in
    // FixGlbBasisuTextures (diffuse RGB + team-mask alpha in tex1, glow/
    // spec/reflectivity across tex2). That packing is an S3O-format
    // concept: S3O fills aiTextureType_DIFFUSE/SPECULAR here, and `.dae`
    // etc. resolve tex1/tex2 through the Spring `unittextures/` convention.
    //
    // Plain-diffuse sources (Warzone `.pie`/`.wzasm`) reference each page
    // directly as a per-material base-colour texture and carry NO packed
    // channels, so we must NOT emit tex1/tex2 for them — otherwise the
    // channel-split would clobber the multi-material `images/textures/
    // materials` layout the exporter wrote. Their material texture refs are
    // lifted verbatim into KHR_texture_basisu by FixGlbBasisuTextures'
    // step-1/2 pass instead.
    const bool plainDiffuseSource = [&] {
        namespace fs = std::filesystem;
        std::string ext = fs::path(sourceModelPath).extension().string();
        for (char& c : ext) c = static_cast<char>(std::tolower(static_cast<unsigned char>(c)));
        return ext == ".pie" || ext == ".wzasm";
    }();

    std::string tex1, tex2;
    if (!plainDiffuseSource &&
        scene != nullptr && scene->mNumMaterials > 0 && scene->mMaterials != nullptr) {
        const aiMaterial* mat = scene->mMaterials[0];
        aiString s;
        if (mat->GetTexture(aiTextureType_DIFFUSE, 0, &s) == AI_SUCCESS) {
            tex1.assign(s.C_Str(), s.length);
            RewriteToKtx2(tex1);
        }
        if (mat->GetTexture(aiTextureType_SPECULAR, 0, &s) == AI_SUCCESS) {
            tex2.assign(s.C_Str(), s.length);
            RewriteToKtx2(tex2);
        }
    }
    // `invertteamcolor` is layered across two sources: the naming-
    // convention probe (presence of `<stem>1_invert.<ext>`) and the
    // .dae.lua / .config.lua-style author sidecar. The sidecar always
    // wins on conflict, so run the probe first and let the sidecar
    // overwrite. Both helpers are no-ops when their inputs are absent;
    // call them unconditionally so the flag gets discovered even when
    // tex1 / tex2 came from an Assimp material slot.
    std::optional<bool> invertTeamColor;
    SidecarOverrides overrides;
    // Caller-supplied normal map (gameconverter feeding BAR's unitDef
    // `customParams.normaltex`, which has no per-model sidecar). Seed it
    // BEFORE ReadSidecarFields — that function only fills `normaltex`
    // when it's still empty, so seeding here makes the authored unitDef
    // value win and skips the sidecar read. Store just the basename
    // (the emitted glTF image URI is a bare `<stem>.ktx2` resolved in
    // models/); the casing snap below fixes it against unittextures/.
    if (!normaltexOverride.empty()) {
        overrides.normaltex =
            std::filesystem::path(normaltexOverride).filename().string();
        RewriteToKtx2(overrides.normaltex);
    }
    ProbeUnittexturesByConvention(sourceModelPath, tex1, tex2, invertTeamColor);
    ReadSidecarFields(sourceModelPath, tex1, tex2, invertTeamColor, overrides);

    // Snap the basename of tex1/tex2 to whatever casing the source file
    // actually has on disk. Sidecars (.dae.lua) vary in case — staticrearm
    // writes `tex1 = "core_color.dds"` while pad_jump writes
    // `Core_color.dds` — but both resolve to the same `Core_color.dds`
    // file. Without this normalisation, the channel-split outputs
    // (`Core_color_diffuse.ktx2` etc.) get declared with whichever casing
    // each sidecar happened to use, then 404 on case-sensitive Linux
    // deployments where only one casing exists on disk.
    if (!sourceModelPath.empty()) {
        namespace fs = std::filesystem;
        const fs::path unittex =
            fs::path(sourceModelPath).parent_path().parent_path() / "unittextures";
        std::error_code ec;
        if (fs::is_directory(unittex, ec)) {
            auto stemLower = [](std::string s) {
                for (char& c : s)
                    c = static_cast<char>(std::tolower(static_cast<unsigned char>(c)));
                return s;
            };
            auto snap = [&](std::string& name) {
                if (name.empty()) return;
                const fs::path p(name);
                const std::string stem = p.stem().string();
                const std::string want = stemLower(stem);
                for (const auto& entry : fs::directory_iterator(unittex, ec)) {
                    if (!entry.is_regular_file()) continue;
                    const std::string fstem = entry.path().stem().string();
                    if (stemLower(fstem) == want) {
                        name = fstem + p.extension().string();  // p.extension == ".ktx2"
                        return;
                    }
                }
            };
            snap(tex1);
            snap(tex2);
            snap(overrides.normaltex);
        }
    }

    // Coordinate convention: RH-canonical. Z axis is negated, AABB
    // min/max swap-and-negate to keep min <= max under the flip.
    //
    // Sidecar overrides supersede AABB-derived values where present —
    // 91.6% of ZK .dae.lua sidecars carry a radius override that
    // differs from the mesh AABB by >20% (skinny units with antennas,
    // gameplay-constant landing pads, etc.) Sidecar values are stored
    // in source coordinates (LH, matching .dae) so the Z-flip applies
    // identically to whichever source wins.
    auto flipZ = [](const std::array<float, 3>& v) {
        return std::array<float, 3>{v[0], v[1], -v[2]};
    };
    // For mins/maxs the Z flip also swaps which one is "min" — the
    // axis polarity inverts. Override mins.z becomes -override maxs.z
    // for an axis-flipped consistent pair. Apply to overrides too so
    // they land in the same RH frame as the computed values.
    std::array<float, 3> outMins{
        overrides.mins ? (*overrides.mins)[0] : bounds.minX,
        overrides.mins ? (*overrides.mins)[1] : bounds.minY,
        overrides.maxs ? -(*overrides.maxs)[2] : -bounds.maxZ,
    };
    std::array<float, 3> outMaxs{
        overrides.maxs ? (*overrides.maxs)[0] : bounds.maxX,
        overrides.maxs ? (*overrides.maxs)[1] : bounds.maxY,
        overrides.mins ? -(*overrides.mins)[2] : -bounds.minZ,
    };
    std::array<float, 3> outMidpos = overrides.midpos
        ? flipZ(*overrides.midpos)
        : std::array<float, 3>{midX, midY, -midZ};

    json doc;
    doc["configVersion"] = GeometryExtractor::kCurrentSchemaVersion;
    // Additive field (older readers ignore it): the emitted extents are in
    // ELMOS — the world-scale contract (kElmosPerMetre in the header).
    // Metre-authored sources must have been pre-scaled by the caller
    // (modelimporter --metres) before this runs; elmo-authored sources
    // (S3O/BAR, map features) pass through unscaled. The marker lets
    // tools/scripts/rescale_models_to_elmos.py refuse to double-scale.
    doc["units"] = "elmos";
    doc["radius"] = JsonFloat(overrides.radius.value_or(radius));
    doc["height"] = JsonFloat(overrides.height.value_or(height));
    doc["midpos"] = JsonVec3(outMidpos[0], outMidpos[1], outMidpos[2]);
    doc["mins"]   = JsonVec3(outMins[0],   outMins[1],   outMins[2]);
    doc["maxs"]   = JsonVec3(outMaxs[0],   outMaxs[1],   outMaxs[2]);
    if (!tex1.empty()) doc["tex1"] = tex1;
    if (!tex2.empty()) doc["tex2"] = tex2;
    if (!overrides.normaltex.empty()) doc["normaltex"] = overrides.normaltex;
    // Transitional field: invertTeamColor goes into SPRINGRTS_geometry
    // here, then FixGlbBasisuTextures lifts it into the material's
    // SPRINGRTS_team_color block at synthesis time. Once .dae sources
    // are retired in favour of glTF-direct authoring, this hop
    // disappears (the author writes SPRINGRTS_team_color directly).
    if (invertTeamColor.has_value()) {
        doc["invertTeamColor"] = *invertTeamColor;
    }

    json piecesArray = json::array();
    for (const auto& p : pieces) {
        json pj;
        pj["name"]   = p.name;
        pj["parent"] = p.parentIndex;
        // Sidecar piece-offset override wins. Z is flipped here just
        // like every other vector emit — sidecar values are in Spring
        // LH coords, we land them in RH. The same override map also
        // flows into a transitional `pieceOverrides` block below so
        // FixGlbBasisuTextures can mirror the change onto the matching
        // .gltf node's matrix (visual-side parity with the SPRINGRTS
        // sim-side data here).
        const auto pit = overrides.pieceOffsets.find(p.name);
        if (pit != overrides.pieceOffsets.end()) {
            pj["offset"] = JsonVec3(pit->second[0],
                                    pit->second[1],
                                    -pit->second[2]);
        } else {
            pj["offset"] = JsonVec3(p.offsetX, p.offsetY, -p.offsetZ);
        }
        pj["mins"]   = JsonVec3(p.localBounds.minX,
                                p.localBounds.minY,
                                -p.localBounds.maxZ);
        pj["maxs"]   = JsonVec3(p.localBounds.maxX,
                                p.localBounds.maxY,
                                -p.localBounds.minZ);

        // Rest rotation (optional additive field). Apply the same Z-mirror that
        // `aiProcess_MakeLeftHanded` applies at export — negate the Z
        // off-diagonal terms (row 2 cols 0/1, and row 0/1 col 2), leaving
        // the XY block and the (2,2) term — so the emitted matrix lands in
        // the same glTF-native RH frame the exporter writes to the node.
        // (Mirror is its own inverse, hence the pre-export raw stored above
        // becomes the exported-node rotation after this step.) Only emit
        // when it deviates from identity: keeps files/diffs tidy and lets
        // the server default to identity for the common static-piece case.
        const float r[9] = {
            p.rot[0],  p.rot[1], -p.rot[2],
            p.rot[3],  p.rot[4], -p.rot[5],
           -p.rot[6], -p.rot[7],  p.rot[8],
        };
        static const float kIdentity3x3[9] = {1, 0, 0, 0, 1, 0, 0, 0, 1};
        bool isIdentity = true;
        for (int k = 0; k < 9; ++k) {
            if (std::fabs(r[k] - kIdentity3x3[k]) > 1e-4f) { isIdentity = false; break; }
        }
        if (!isIdentity) {
            json rj = json::array();
            for (int k = 0; k < 9; ++k) rj.push_back(JsonFloat(r[k]));
            pj["rot"] = std::move(rj);
        }
        piecesArray.push_back(std::move(pj));
    }
    doc["pieces"] = std::move(piecesArray);

    // Transitional field consumed by FixGlbBasisuTextures: the same
    // sidecar piece-offset overrides, Z-flipped to RH, keyed by piece
    // name. Drives the .gltf node matrix update so the rendered model
    // sits where the SPRINGRTS_geometry data says it does. Absent when
    // the sidecar carries no piece overrides — keeps the JSON tidy.
    if (!overrides.pieceOffsets.empty()) {
        json pieceOverrides = json::object();
        for (const auto& kv : overrides.pieceOffsets) {
            pieceOverrides[kv.first] = JsonVec3(kv.second[0],
                                                kv.second[1],
                                                -kv.second[2]);
        }
        doc["pieceOverrides"] = std::move(pieceOverrides);
    }

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

namespace {

/// Locate the actual on-disk source file backing a tex1 reference and
/// return its lowercase extension (without dot). Used by ShouldFlipUv
/// to distinguish DDS (Spring path always nv_dds-flips → memory ends
/// up bottom-up) from TGA/PNG/JPG (Spring IL keeps top-down unless
/// ReverseYAxis runs). When the tex1 string is empty, falls back to
/// the Spring naming convention `<modelStem>1.<ext>` so .dae models
/// without a populated material slot still get a verdict. Returns
/// empty when nothing matches — the caller treats "no texture" as
/// "no flip needed".
std::string LookupTex1SourceExt(const std::string& sourceModelPath,
                                const std::string& tex1Name) {
    if (sourceModelPath.empty()) return {};
    namespace fs = std::filesystem;
    const fs::path src(sourceModelPath);
    const fs::path unittex = src.parent_path().parent_path() / "unittextures";
    std::error_code ec;
    if (!fs::is_directory(unittex, ec)) return {};

    auto stemLower = [](std::string s) {
        for (char& c : s)
            c = static_cast<char>(std::tolower(static_cast<unsigned char>(c)));
        return s;
    };

    // The tex1 string the caller passes in carries whichever extension
    // the source archive happened to ship (`.dds`, `.tga`, `.ktx2` if
    // the sidecar already pre-resolved, or empty). We only care about
    // the stem; the extension on disk is what determines Spring's
    // loader path, not the extension the model file claimed.
    std::string stem;
    if (!tex1Name.empty()) {
        // Strip any directory and extension from tex1Name. Spring s3o /
        // .dae sidecars typically carry bare filenames but tolerate a
        // few archive-relative paths.
        fs::path t(tex1Name);
        stem = t.stem().string();
    } else {
        // Fall back to the naming-convention probe: <modelStem>1.
        stem = src.stem().string() + "1";
    }
    if (stem.empty()) return {};
    const std::string stemLow = stemLower(stem);

    // Direct hit on common extensions first — fast path that avoids
    // the directory walk for the typical case.
    static const char* const kExts[] = {
        "dds", "tga", "png", "bmp", "jpg", "jpeg", "webp",
    };
    for (const char* ext : kExts) {
        if (fs::exists(unittex / (stem + "." + ext), ec)) return ext;
    }
    // Case-insensitive fallback — ZK content mixes `Core_color.dds`
    // (file) with `core_color.dds` (sidecar reference) freely.
    for (const auto& entry : fs::directory_iterator(unittex, ec)) {
        if (!entry.is_regular_file()) continue;
        const std::string fstem = entry.path().stem().string();
        if (stemLower(fstem) != stemLow) continue;
        std::string ext = entry.path().extension().string();
        if (!ext.empty() && ext[0] == '.') ext.erase(0, 1);
        return stemLower(std::move(ext));
    }
    return {};
}

/// Per-source-format default for `fliptextures`. Mirrors Recoil:
///   - S3O               : false (S3OParser hardcodes invertAxis=false)
///   - glTF / glb input  : false (GLTFParser.cpp:437)
///   - DAE / FBX / OBJ / etc.: true (AssParser.cpp:591 — "true is the
///     incorrect default, but has to be retained to be compatible")
bool DefaultFlipTexturesForSource(const std::string& sourceModelPath) {
    namespace fs = std::filesystem;
    std::string ext = fs::path(sourceModelPath).extension().string();
    for (char& c : ext)
        c = static_cast<char>(std::tolower(static_cast<unsigned char>(c)));
    if (ext == ".s3o")  return false;
    if (ext == ".gltf") return false;
    if (ext == ".glb")  return false;
    return true;
}

} // namespace

bool GeometryExtractor::ShouldFlipUv(const std::string& sourceModelPath,
                                     const std::string& tex1Name) {
    if (sourceModelPath.empty()) return false;

    // Resolve the effective fliptextures value: sidecar wins over the
    // per-source-format default. Reuse the full sidecar reader so the
    // parse rules live in one place; everything else it returns gets
    // discarded.
    std::string scratchTex1 = tex1Name;
    std::string scratchTex2;
    std::optional<bool> scratchInvertTeamColor;
    SidecarOverrides scratchOverrides;
    ReadSidecarFields(sourceModelPath,
                      scratchTex1, scratchTex2,
                      scratchInvertTeamColor,
                      scratchOverrides);
    const bool effectiveFlipTextures = scratchOverrides.flipTextures.value_or(
        DefaultFlipTexturesForSource(sourceModelPath));

    // Find the actual on-disk source extension for tex1. ReadSidecarFields
    // may have filled scratchTex1 from the .dae.lua, so prefer that over
    // the raw `tex1Name` the caller gave us.
    const std::string srcExt = LookupTex1SourceExt(sourceModelPath, scratchTex1);

    // The decision table from the header doc:
    //   tex1 ext   | effective fliptextures | UV flip needed
    //   .dds       | (any)                  | no
    //   non-.dds   | true                   | no
    //   non-.dds   | false                  | YES
    //
    // Unknown / missing source extension: assume the texture exists in
    // some non-DDS form (typical for .dae sources that ship .png or
    // .tga unittextures) and let the fliptextures value decide. This
    // keeps the rule conservative — a model with no resolvable tex1
    // gets the format-default behaviour rather than silently skipping.
    const bool isDds = (srcExt == "dds");
    if (isDds) return false;
    return !effectiveFlipTextures;
}
