// PIE importer for Assimp — implementation.
//
// See PIEImporter.h for the format spec and the WZ→glTF coordinate notes.
// Ported from the retired tools/scripts/pie_to_glb.py, but this keeps the
// real per-vertex UVs and texture-page references (pie_to_glb discarded them
// and flat-coloured every piece with a grey palette swatch — the reason the
// baseline rendered "untextured").

#include "PIEImporter.h"

#include <assimp/IOSystem.hpp>
#include <assimp/IOStream.hpp>
#include <assimp/importerdesc.h>
#include <assimp/scene.h>
#include <assimp/material.h>
#include <assimp/GltfMaterial.h>
#include <assimp/DefaultLogger.hpp>

#include <nlohmann/json.hpp>

#include <algorithm>
#include <cctype>
#include <cstdlib>
#include <cstring>
#include <map>
#include <memory>
#include <sstream>

namespace Assimp {

namespace {

using json = nlohmann::json;

// WZ `.pie` UVs use a top-left image origin (V=0 at the visual top). Our
// runtime samples KTX2 with V=0 at the visual bottom (KTX2 stored top-down +
// Babylon `Texture(invertY=true)` — see GeometryExtractor.h's flip notes), and
// modelimporter's per-material ShouldFlipUv pass does NOT fire for `.pie`
// sources (their pages don't live in a Spring `unittextures/` sibling). So the
// V flip is owned here. Verified against the rendered pages; toggle only if a
// texture comes out vertically mirrored.
constexpr bool kFlipV = true;

std::vector<std::string> Tokenize(const std::string& line) {
    std::vector<std::string> out;
    std::stringstream ss(line);
    std::string tok;
    while (ss >> tok) out.push_back(tok);
    return out;
}

float ToF(const std::string& s) { return std::strtof(s.c_str(), nullptr); }
long  ToL(const std::string& s) { return std::strtol(s.c_str(), nullptr, 0); }

/// WZ2100 `TYPE` is a HEXADECIMAL bitfield (doc/PIE.md), so it needs an
/// explicit base-16 parse — `ToL`'s base-0 auto-detect would read the
/// unprefixed `10200` as decimal ten-thousand-two-hundred and lose the flag.
long ToHex(const std::string& s) { return std::strtol(s.c_str(), nullptr, 16); }

/// PIE `TYPE` flag: the model is team-coloured through a `page-N_tcmask.png`
/// companion of its diffuse page (doc/PIE.md; `iV_IMD_TCMASK` in WZ2100's
/// lib/ivis_opengl/imd.h). PIE4 states the mask page outright with a `TCMASK`
/// directive; PIE2/PIE3 only set this flag and leave the name to convention.
constexpr long kPieTypeTCMask = 0x10000;

/// WZ2100's `pie_MakeTexPageTCMaskName`: a page named `page-<N>-<whatever>.png`
/// masks through `page-<N>_tcmask.png` — the numeric prefix is the whole key,
/// the descriptive tail is dropped. Returns empty for a page that does not
/// follow the `page-` convention (nothing sane to derive).
std::string TCMaskNameFor(const std::string& page) {
    if (page.rfind("page-", 0) != 0) return {};
    size_t i = 5;
    while (i < page.size() && std::isdigit(static_cast<unsigned char>(page[i]))) ++i;
    if (i == 5) return {};   // "page-" with no number — nothing to key on
    return page.substr(0, i) + "_tcmask.png";
}

std::string StemOf(const std::string& name) {
    size_t slash = name.find_last_of("/\\");
    std::string base = (slash == std::string::npos) ? name : name.substr(slash + 1);
    size_t dot = base.find_last_of('.');
    return (dot == std::string::npos) ? base : base.substr(0, dot);
}

std::string DirOf(const std::string& path) {
    size_t slash = path.find_last_of("/\\");
    return (slash == std::string::npos) ? std::string(".") : path.substr(0, slash);
}

aiVector3D FaceNormal(const aiVector3D& a, const aiVector3D& b, const aiVector3D& c) {
    aiVector3D n = (b - a) ^ (c - a);   // WZ-space cross product
    float len = n.Length();
    return (len > 1e-8f) ? (n / len) : aiVector3D(0.0f, 1.0f, 0.0f);
}

} // namespace

// ---------------------------------------------------------------------
// Importer descriptor / introspection
// ---------------------------------------------------------------------

static const aiImporterDesc s_desc = {
    "Warzone 2100 PIE Importer",
    "Spring/Spring RTS Web",
    "",
    "Loads Warzone 2100 .pie models and .wzasm assembly manifests",
    aiImporterFlags_SupportTextFlavour,
    0, 0, 0, 0,
    "pie wzasm"
};

PIEImporter::PIEImporter() = default;
PIEImporter::~PIEImporter() = default;

const aiImporterDesc* PIEImporter::GetInfo() const {
    return &s_desc;
}

bool PIEImporter::CanRead(const std::string& pFile,
                          IOSystem* pIOHandler,
                          bool checkSig) const {
    if (!checkSig) {
        return SimpleExtensionCheck(pFile, "pie") ||
               SimpleExtensionCheck(pFile, "wzasm");
    }
    if (!pIOHandler) return false;
    std::unique_ptr<IOStream> file(pIOHandler->Open(pFile, "rb"));
    if (!file) return false;
    char head[256] = {0};
    const size_t n = file->Read(head, 1, sizeof(head) - 1);
    if (n == 0) return false;
    std::string s(head, n);
    // `.pie` starts with "PIE " (after any leading whitespace); `.wzasm`
    // manifests carry the "wzassembly" key near the top.
    size_t i = 0;
    while (i < s.size() && (s[i] == ' ' || s[i] == '\t' || s[i] == '\r' || s[i] == '\n')) ++i;
    if (s.compare(i, 4, "PIE ") == 0) return true;
    return s.find("wzassembly") != std::string::npos;
}

// ---------------------------------------------------------------------
// File IO
// ---------------------------------------------------------------------

std::string PIEImporter::ReadTextFile(IOSystem* io, const std::string& path) {
    std::unique_ptr<IOStream> f(io->Open(path, "rb"));
    if (!f) throw DeadlyImportError("PIE: failed to open ", path);
    const size_t sz = f->FileSize();
    std::string s(sz, '\0');
    if (sz > 0 && f->Read(&s[0], 1, sz) != sz) {
        throw DeadlyImportError("PIE: short read on ", path);
    }
    return s;
}

// ---------------------------------------------------------------------
// .pie parser (LEVEL 1 only) — keeps real UVs + connectors
// ---------------------------------------------------------------------

PIEImporter::Component PIEImporter::ParsePie(const std::string& text,
                                             const std::string& nodeName) {
    Component comp;
    comp.name = nodeName;

    float texW = 256.0f, texH = 256.0f;

    // Split into trimmed lines.
    std::vector<std::string> lines;
    {
        std::stringstream ss(text);
        std::string ln;
        while (std::getline(ss, ln)) {
            while (!ln.empty() && (ln.back() == '\r' || ln.back() == ' ' || ln.back() == '\t'))
                ln.pop_back();
            lines.push_back(ln);
        }
    }

    // Shared vertex list for the level currently being ingested.
    std::vector<aiVector3D> points;
    int level = 0;          // 0 = no LEVEL directive yet (single-level file)
    auto ingesting = [&]() { return level <= 1; };

    // Row-count directives come from untrusted text: a negative or garbage
    // count must fail the import here, not wrap through int→size_t into
    // reserve()/line-skips and escape as std::length_error/bad_alloc.
    constexpr long kMaxRows = 1000000;
    auto rowCount = [&](const std::vector<std::string>& t, const char* what) -> int {
        const long n = (t.size() >= 2) ? ToL(t[1]) : 0;
        if (n < 0 || n > kMaxRows) {
            throw DeadlyImportError("PIE: bad ", what, " count ", std::to_string(n),
                                    " in ", nodeName);
        }
        return static_cast<int>(n);
    };

    for (size_t i = 0; i < lines.size(); ++i) {
        const std::vector<std::string> t = Tokenize(lines[i]);
        if (t.empty()) continue;
        std::string kw = t[0];
        for (char& c : kw) c = static_cast<char>(std::toupper(static_cast<unsigned char>(c)));

        if (kw == "PIE") {
            if (t.size() >= 2) comp.pieVersion = static_cast<int>(ToL(t[1]));
        } else if (kw == "TEXTURE") {
            // TEXTURE <n> <page> [w h]
            if (t.size() >= 3) comp.texPage = t[2];
            if (t.size() >= 5) {
                float w = ToF(t[3]), h = ToF(t[4]);
                if (w > 0 && h > 0) { texW = w; texH = h; }
            }
        } else if (kw == "TYPE") {
            // TYPE <hex flags> — only the TCMASK bit matters to us.
            if (t.size() >= 2) comp.typeFlags = ToHex(t[1]);
        } else if (kw == "TCMASK") {
            // TCMASK <n> <page>
            if (t.size() >= 3) comp.tcmaskPage = t[2];
        } else if (kw == "LEVEL") {
            if (t.size() >= 2) level = static_cast<int>(ToL(t[1]));
            else level = (level == 0) ? 1 : level + 1;
            points.clear();
        } else if (kw == "LEVELS") {
            // declares the count only; ignore
        } else if (kw == "POINTS") {
            const int count = rowCount(t, "POINTS");
            if (!ingesting()) { i += count; continue; }
            points.clear();
            points.reserve(count);
            for (int j = 0; j < count && i + 1 < lines.size(); ++j) {
                const std::vector<std::string> p = Tokenize(lines[++i]);
                if (p.size() >= 3) points.emplace_back(ToF(p[0]), ToF(p[1]), ToF(p[2]));
                else points.emplace_back(0.0f, 0.0f, 0.0f);
            }
        } else if (kw == "NORMALS") {
            // Skip its rows — we recompute flat normals for the low-poly look.
            const int count = rowCount(t, "NORMALS");
            i += count;
        } else if (kw == "POLYGONS") {
            const int count = rowCount(t, "POLYGONS");
            if (!ingesting()) { i += count; continue; }
            for (int j = 0; j < count && i + 1 < lines.size(); ++j) {
                const std::vector<std::string> p = Tokenize(lines[++i]);
                if (p.size() < 2) continue;
                const int npts = static_cast<int>(ToL(p[1]));
                if (npts < 3) continue;
                // Layout: flags npts | idx[npts] | uv[npts*2] | [anim trailer]
                const size_t idxBase = 2;
                const size_t uvBase  = idxBase + static_cast<size_t>(npts);
                if (p.size() < uvBase + static_cast<size_t>(npts) * 2) continue;
                std::vector<int> idx(npts);
                std::vector<aiVector3D> uv(npts);
                bool ok = true;
                for (int k = 0; k < npts; ++k) {
                    idx[k] = static_cast<int>(ToL(p[idxBase + k]));
                    if (idx[k] < 0 || idx[k] >= static_cast<int>(points.size())) { ok = false; break; }
                    float u = ToF(p[uvBase + k * 2]);
                    float v = ToF(p[uvBase + k * 2 + 1]);
                    if (comp.pieVersion <= 2) { u /= texW; v /= texH; }
                    if (kFlipV) v = 1.0f - v;
                    uv[k] = aiVector3D(u, v, 0.0f);
                }
                if (!ok) continue;
                // Fan-triangulate, WZ winding verbatim (export flips it).
                for (int k = 1; k < npts - 1; ++k) {
                    Tri tri;
                    tri.pos = { points[idx[0]], points[idx[k]], points[idx[k + 1]] };
                    tri.uv  = { uv[0], uv[k], uv[k + 1] };
                    comp.tris.push_back(tri);
                }
            }
        } else if (kw == "CONNECTORS") {
            const int count = rowCount(t, "CONNECTORS");
            const bool take = ingesting() && comp.connectors.empty();
            for (int j = 0; j < count && i + 1 < lines.size(); ++j) {
                const std::vector<std::string> p = Tokenize(lines[++i]);
                if (take && p.size() >= 3)
                    comp.connectors.emplace_back(ToF(p[0]), ToF(p[1]), ToF(p[2]));
            }
        }
        // EVENT / SHADOWPOINTS / INTERPOLATE / etc. ignored.
    }

    // PIE2/PIE3 have no `TCMASK` directive — they announce the mask through
    // the TYPE bitfield and leave the page name to WZ's naming convention.
    // Honour that, so a flagged PIE2/3 part is not silently imported untinted.
    if (comp.tcmaskPage.empty() && (comp.typeFlags & kPieTypeTCMask) != 0)
        comp.tcmaskPage = TCMaskNameFor(comp.texPage);

    return comp;
}

// ---------------------------------------------------------------------
// Assembly specs
// ---------------------------------------------------------------------

PIEImporter::AssemblySpec PIEImporter::SinglePartSpec(const std::string& pieFile) {
    AssemblySpec spec;
    spec.name = StemOf(pieFile);
    spec.targetMetres = 0.0f;   // no rescale for a bare component
    spec.pieDir = "";           // the .pie sits at the input path directly
    PartSpec part;
    part.pie = pieFile;
    part.node = "body";
    spec.parts.push_back(part);
    return spec;
}

PIEImporter::AssemblySpec PIEImporter::ParseManifest(const std::string& jsonText) {
    json doc;
    try {
        doc = json::parse(jsonText);
    } catch (const json::parse_error& e) {
        throw DeadlyImportError("PIE: bad .wzasm JSON: ", e.what());
    }
    AssemblySpec spec;
    spec.name = doc.value("name", std::string("wz_model"));
    spec.targetMetres = doc.value("target_metres", 0.0f);
    spec.pieDir = doc.value("pie_dir", std::string("pie"));
    const std::string axis = doc.value("dominant_axis", std::string("z"));
    spec.dominantAxis = axis.empty() ? 'z' : axis[0];

    // Optional `"tcmask": { "<diffuse page>": "<mask page>" }` — an
    // assembly-level team-colour mask, overriding whatever the `.pie` parts
    // declare (PIE4 directive) or imply (PIE2/3 TYPE flag). This is how
    // AUTHORED masks reach a WZ model: the stock droid mask pages are all but
    // empty over the hull/turret islands these assemblies use, so relying on
    // upstream would import a unit with no usable team identification.
    if (doc.contains("tcmask")) {
        if (!doc["tcmask"].is_object())
            throw DeadlyImportError("PIE: .wzasm \"tcmask\" must be an object");
        for (const auto& kv : doc["tcmask"].items()) {
            if (!kv.value().is_string())
                throw DeadlyImportError("PIE: .wzasm \"tcmask\" entry \"", kv.key(),
                                        "\" must map to a mask page filename");
            spec.tcmaskByPage[kv.key()] = kv.value().get<std::string>();
        }
    }

    if (!doc.contains("parts") || !doc["parts"].is_array() || doc["parts"].empty())
        throw DeadlyImportError("PIE: .wzasm has no parts[]");

    for (const auto& p : doc["parts"]) {
        PartSpec part;
        part.pie = p.value("pie", std::string());
        part.node = p.value("node", StemOf(part.pie));
        part.parent = p.value("parent", std::string());
        part.addMuzzle = p.value("add_muzzle", false);
        if (p.contains("mount") && p["mount"].is_object()) {
            part.hasMount = true;
            part.mountPie = p["mount"].value("pie", std::string());
            part.mountConnector = p["mount"].value("connector", 0);
        }
        if (part.pie.empty())
            throw DeadlyImportError("PIE: .wzasm part missing \"pie\"");
        spec.parts.push_back(part);
    }
    return spec;
}

// ---------------------------------------------------------------------
// Scene assembly
// ---------------------------------------------------------------------

void PIEImporter::BuildScene(const AssemblySpec& spec,
                             aiScene* pScene,
                             IOSystem* pIOHandler,
                             const std::string& baseDir) {
    // ---- Parse every component, keyed by both node name and pie filename ----
    std::map<std::string, Component> byNode;   // node name -> component
    std::map<std::string, Component> byPie;    // pie filename -> component (for mounts)
    for (const auto& part : spec.parts) {
        if (byNode.count(part.node)) {
            throw DeadlyImportError("PIE: duplicate part node \"", part.node,
                                    "\" in ", spec.name);
        }
        std::string piePath = part.pie;
        if (!spec.pieDir.empty()) piePath = baseDir + "/" + spec.pieDir + "/" + part.pie;
        else if (!baseDir.empty()) piePath = baseDir + "/" + part.pie;
        Component c = ParsePie(ReadTextFile(pIOHandler, piePath), part.node);
        byPie[part.pie] = c;
        byNode[part.node] = std::move(c);
    }

    // ---- WZ-space world offset for each part (accumulated mount chain) ----
    std::map<std::string, PartSpec> partByNode;
    for (const auto& part : spec.parts) partByNode[part.node] = part;

    // Validate the parent graph before any offset walks or wiring: a
    // `parent` naming an undeclared node, or a chain that never reaches a
    // root (cycle), must fail the import — silently dropping the child
    // would export e.g. a tank without its turret at exit 0. The 16-hop
    // bound matches the offset walk's guard below.
    for (const auto& part : spec.parts) {
        std::string parent = part.parent;
        int hops = 0;
        while (!parent.empty()) {
            auto pit = partByNode.find(parent);
            if (pit == partByNode.end()) {
                throw DeadlyImportError("PIE: part \"", part.node,
                                        "\" references unknown parent node \"", parent,
                                        "\" in ", spec.name);
            }
            if (++hops > 16) {
                throw DeadlyImportError("PIE: parent chain for part \"", part.node,
                                        "\" exceeds 16 hops (cycle?) in ", spec.name);
            }
            parent = pit->second.parent;
        }
    }

    auto mountOffset = [&](const PartSpec& part) -> aiVector3D {
        if (part.hasMount) {
            auto it = byPie.find(part.mountPie);
            if (it != byPie.end() &&
                part.mountConnector >= 0 &&
                part.mountConnector < static_cast<int>(it->second.connectors.size())) {
                return it->second.connectors[part.mountConnector];
            }
        }
        return aiVector3D(0.0f, 0.0f, 0.0f);
    };

    std::map<std::string, aiVector3D> worldOffset;
    for (const auto& part : spec.parts) {
        aiVector3D off = mountOffset(part);
        // Walk parents (shallow in practice) to accumulate.
        std::string parent = part.parent;
        int guard = 0;
        while (!parent.empty() && guard++ < 16) {
            auto pit = partByNode.find(parent);
            if (pit == partByNode.end()) break;
            off = off + mountOffset(pit->second);
            parent = pit->second.parent;
        }
        worldOffset[part.node] = off;
    }

    // ---- Scale factor from the assembled WZ-space extent along the axis ----
    const int axis = (spec.dominantAxis == 'x') ? 0 : (spec.dominantAxis == 'y') ? 1 : 2;
    float mn = 1e30f, mx = -1e30f;
    for (const auto& part : spec.parts) {
        const Component& c = byNode[part.node];
        const aiVector3D wo = worldOffset[part.node];
        for (const Tri& tri : c.tris) {
            for (const aiVector3D& v : tri.pos) {
                const float coord = (&v.x)[axis] + (&wo.x)[axis];
                mn = std::min(mn, coord);
                mx = std::max(mx, coord);
            }
        }
    }
    const float extent = (mx > mn) ? (mx - mn) : 1.0f;
    const float factor = (spec.targetMetres > 0.0f) ? (spec.targetMetres / extent) : 1.0f;

    // ---- Materials: one per distinct diffuse page ----
    std::map<std::string, unsigned int> pageToMat;     // page filename -> material idx
    std::map<std::string, std::string> pageToTcmask;   // page filename -> tcmask page
    std::vector<aiMaterial*> materials;
    for (const auto& part : spec.parts) {
        const Component& c = byNode[part.node];
        if (c.texPage.empty()) continue;
        // The manifest wins over the `.pie`: authored art is the deliberate
        // choice, the `.pie`-derived page is the upstream default.
        auto ovr = spec.tcmaskByPage.find(c.texPage);
        const std::string& mask = (ovr != spec.tcmaskByPage.end()) ? ovr->second : c.tcmaskPage;
        if (!mask.empty() && pageToTcmask.find(c.texPage) == pageToTcmask.end())
            pageToTcmask[c.texPage] = mask;
        if (pageToMat.count(c.texPage)) continue;
        pageToMat[c.texPage] = static_cast<unsigned int>(materials.size());
        materials.push_back(nullptr);   // filled below (need tcmask resolved first)
    }
    // Materials with no page at all still need one slot (fallback).
    for (auto& kv : pageToMat) {
        const std::string& page = kv.first;
        auto* mat = new aiMaterial();
        aiString matName(StemOf(page));
        mat->AddProperty(&matName, AI_MATKEY_NAME);
        aiString diffuse(page);
        mat->AddProperty(&diffuse, AI_MATKEY_TEXTURE_DIFFUSE(0));
        mat->AddProperty(&diffuse, AI_MATKEY_TEXTURE(aiTextureType_BASE_COLOR, 0));
        // Team-colour mask (PIE4 TCMASK): carry on the LIGHTMAP slot
        // (→ glTF occlusionTexture) so the exporter writes it as a real
        // texture; modelimporter's post-fix relocates any *_tcmask texture
        // into the SPRINGRTS_team_color extension.
        auto tcit = pageToTcmask.find(page);
        if (tcit != pageToTcmask.end() && !tcit->second.empty()) {
            aiString tc(tcit->second);
            mat->AddProperty(&tc, AI_MATKEY_TEXTURE(aiTextureType_LIGHTMAP, 0));
        }
        int twoSided = 1;   // WZ low-poly reads better two-sided
        mat->AddProperty(&twoSided, 1, AI_MATKEY_TWOSIDED);
        materials[kv.second] = mat;
    }
    if (materials.empty()) {
        // No textured parts at all — emit a single bare material.
        auto* mat = new aiMaterial();
        aiString matName("wz_untextured");
        mat->AddProperty(&matName, AI_MATKEY_NAME);
        materials.push_back(mat);
    }

    // ---- Meshes + nodes ----
    std::vector<aiMesh*> meshes;
    std::map<std::string, aiNode*> nodeByName;

    auto makeMesh = [&](const Component& c, unsigned int matIdx) -> int {
        if (c.tris.empty()) return -1;
        const unsigned int nv = static_cast<unsigned int>(c.tris.size() * 3);
        auto* mesh = new aiMesh();
        mesh->mMaterialIndex = matIdx;
        mesh->mPrimitiveTypes = aiPrimitiveType_TRIANGLE;
        mesh->mNumVertices = nv;
        mesh->mVertices = new aiVector3D[nv];
        mesh->mNormals  = new aiVector3D[nv];
        mesh->mTextureCoords[0] = new aiVector3D[nv];
        mesh->mNumUVComponents[0] = 2;
        mesh->mNumFaces = static_cast<unsigned int>(c.tris.size());
        mesh->mFaces = new aiFace[mesh->mNumFaces];
        unsigned int vi = 0;
        for (unsigned int f = 0; f < c.tris.size(); ++f) {
            const Tri& tri = c.tris[f];
            const aiVector3D n = FaceNormal(tri.pos[0], tri.pos[1], tri.pos[2]);
            auto& face = mesh->mFaces[f];
            face.mNumIndices = 3;
            face.mIndices = new unsigned int[3];
            for (int k = 0; k < 3; ++k) {
                mesh->mVertices[vi] = tri.pos[k] * factor;   // bake scale
                mesh->mNormals[vi]  = n;
                mesh->mTextureCoords[0][vi] = tri.uv[k];
                face.mIndices[k] = vi;
                ++vi;
            }
        }
        meshes.push_back(mesh);
        return static_cast<int>(meshes.size() - 1);
    };

    for (const auto& part : spec.parts) {
        const Component& c = byNode[part.node];
        auto* node = new aiNode();
        node->mName = aiString(part.node);
        // Local translation relative to parent. For a mounted child the
        // mount host is its parent, so the LOCAL offset is just this part's
        // own mount offset (scaled); root parts sit at the origin.
        const aiVector3D localOff = mountOffset(part) * factor;
        aiMatrix4x4 t;
        aiMatrix4x4::Translation(localOff, t);
        node->mTransformation = t;

        unsigned int matIdx = 0;
        auto mit = pageToMat.find(c.texPage);
        if (mit != pageToMat.end()) matIdx = mit->second;
        const int meshIdx = makeMesh(c, matIdx);
        if (meshIdx >= 0) {
            node->mNumMeshes = 1;
            node->mMeshes = new unsigned int[1];
            node->mMeshes[0] = static_cast<unsigned int>(meshIdx);
        }

        // Optional muzzle empty node (weapon connector[0] or barrel tip).
        if (part.addMuzzle) {
            aiVector3D muzzle;
            bool have = false;
            if (!c.connectors.empty()) { muzzle = c.connectors[0]; have = true; }
            else if (!c.tris.empty()) {
                float zmax = -1e30f, ymin = 1e30f, ymax = -1e30f;
                for (const Tri& tri : c.tris)
                    for (const aiVector3D& v : tri.pos) {
                        zmax = std::max(zmax, v.z);
                        ymin = std::min(ymin, v.y);
                        ymax = std::max(ymax, v.y);
                    }
                muzzle = aiVector3D(0.0f, (ymin + ymax) * 0.5f, zmax);
                have = true;
            }
            if (have) {
                auto* mz = new aiNode();
                mz->mName = aiString(std::string("muzzle"));
                aiMatrix4x4 mt;
                aiMatrix4x4::Translation(muzzle * factor, mt);
                mz->mTransformation = mt;
                node->mNumChildren = 1;
                node->mChildren = new aiNode*[1];
                node->mChildren[0] = mz;
                mz->mParent = node;
            }
        }

        nodeByName[part.node] = node;
    }

    // ---- Wire parent/child (append to any existing muzzle child) ----
    std::map<std::string, std::vector<aiNode*>> childrenOf;
    std::vector<aiNode*> roots;
    for (const auto& part : spec.parts) {
        if (part.parent.empty()) roots.push_back(nodeByName[part.node]);
        else childrenOf[part.parent].push_back(nodeByName[part.node]);
    }
    for (auto& kv : childrenOf) {
        aiNode* parent = nodeByName[kv.first];
        if (!parent) continue;
        std::vector<aiNode*> kids;
        for (unsigned int i = 0; i < parent->mNumChildren; ++i) kids.push_back(parent->mChildren[i]);
        for (aiNode* c : kv.second) kids.push_back(c);
        delete[] parent->mChildren;
        parent->mNumChildren = static_cast<unsigned int>(kids.size());
        parent->mChildren = new aiNode*[kids.size()];
        for (size_t i = 0; i < kids.size(); ++i) { parent->mChildren[i] = kids[i]; kids[i]->mParent = parent; }
    }

    // ---- Scene root wrapper (matches other importers; skipped by
    //      GeometryExtractor's meshless/single-child/identity check) ----
    auto* sceneRoot = new aiNode();
    sceneRoot->mName = aiString(std::string("PIE_") + spec.name);
    if (roots.empty())
        throw DeadlyImportError("PIE: no root part in ", spec.name);
    sceneRoot->mNumChildren = static_cast<unsigned int>(roots.size());
    sceneRoot->mChildren = new aiNode*[roots.size()];
    for (size_t i = 0; i < roots.size(); ++i) { sceneRoot->mChildren[i] = roots[i]; roots[i]->mParent = sceneRoot; }
    pScene->mRootNode = sceneRoot;

    // ---- Hand meshes + materials to the scene ----
    pScene->mNumMeshes = static_cast<unsigned int>(meshes.size());
    if (!meshes.empty()) {
        pScene->mMeshes = new aiMesh*[meshes.size()];
        for (size_t i = 0; i < meshes.size(); ++i) pScene->mMeshes[i] = meshes[i];
    }
    pScene->mNumMaterials = static_cast<unsigned int>(materials.size());
    pScene->mMaterials = new aiMaterial*[materials.size()];
    for (size_t i = 0; i < materials.size(); ++i) pScene->mMaterials[i] = materials[i];

    if (pScene->mNumMeshes == 0)
        throw DeadlyImportError("PIE: no geometry produced from ", spec.name);
}

// ---------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------

void PIEImporter::InternReadFile(const std::string& pFile,
                                 aiScene* pScene,
                                 IOSystem* pIOHandler) {
    const std::string text = ReadTextFile(pIOHandler, pFile);
    const std::string baseDir = DirOf(pFile);

    AssemblySpec spec;
    if (SimpleExtensionCheck(pFile, "wzasm") || text.find("wzassembly") != std::string::npos) {
        spec = ParseManifest(text);
        BuildScene(spec, pScene, pIOHandler, baseDir);
    } else {
        // Bare .pie: one-part assembly. The .pie sits at pFile itself, so
        // parse it directly rather than re-resolving through pieDir.
        spec = SinglePartSpec(pFile.substr(pFile.find_last_of("/\\") + 1));
        // BuildScene resolves parts relative to baseDir with an empty pieDir,
        // i.e. `<baseDir>/<pie>` == pFile.
        BuildScene(spec, pScene, pIOHandler, baseDir);
    }
}

} // namespace Assimp
