// JsonWriter — see header for schema and ownership rules.
//
// Transitional code: the next milestone (PLAN-pbr-mapping.md Phase 1d)
// removes this file entirely, replacing the sibling `.config.json`
// sidecar with a `SPRINGRTS_geometry` document-level extension inside
// the .gltf. Until then both sources of truth are written so the
// runtime can transition without coordinated edits.

#include "JsonWriter.h"
#include "GeometryExtractor.h"

#include <assimp/scene.h>
#include <assimp/material.h>

#include <nlohmann/json.hpp>

#include <cstdio>
#include <fstream>
#include <string>

namespace {

using json = nlohmann::json;

/// Rewrite a texture filename's extension to `.ktx2`. Used for the
/// optional tex1/tex2 fields the .config.json carries during the
/// transition; the actual on-disk KTX2s are encoded by gameconverter.
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

} // namespace

bool JsonWriter::Write(const aiScene* scene,
                       const std::string& outPath,
                       const std::string& sourceModelPath) {
    // Geometry + pieces + attachments come from the shared extractor —
    // same numeric output as the in-gltf SPRINGRTS_geometry extension.
    json geom = GeometryExtractor::BuildExtensionJson(scene);

    // ---- Texture references ----
    //
    // S3OImporter populates a single material per scene with the original
    // texture filenames Spring expects to find under `unittextures/`:
    //   AI_MATKEY_TEXTURE_DIFFUSE(0)  → tex1 (diffuse)
    //   AI_MATKEY_TEXTURE_SPECULAR(0) → tex2 (team-colour mask)
    // For non-S3O formats the slot mapping is whatever Assimp's importer
    // for that format chose; we read the same slots and accept whatever
    // we find there. Hand-authored .config.lua files always win when
    // present (modelimporter skips emitting JSON in that case), so this
    // only affects machine-converted models.
    //
    // Filenames are rewritten to `.ktx2` here so the runtime always
    // resolves a single canonical extension regardless of what the
    // source archive happened to ship.
    std::string tex1, tex2;
    if (scene != nullptr && scene->mNumMaterials > 0 && scene->mMaterials != nullptr) {
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

    // Spring author-config fallback: legacy `.dae` / `.fbx` archives
    // store tex1 / tex2 in a sibling `<modelname>.<ext>.lua` file
    // because the on-disk model format has no native Spring-style
    // texture binding. Assimp can't see those — we parse them out by
    // simple string matching (the file is small and the keys are
    // unambiguous). Only consulted when Assimp didn't already pick
    // up a texture for that slot, so S3O imports keep their existing
    // behaviour.
    if ((tex1.empty() || tex2.empty()) && !sourceModelPath.empty()) {
        const std::string springLua = sourceModelPath + ".lua";
        std::ifstream lua(springLua, std::ios::binary);
        if (lua) {
            const std::string txt{std::istreambuf_iterator<char>(lua),
                                  std::istreambuf_iterator<char>()};
            auto readLuaField = [&](const std::string& key) -> std::string {
                size_t k = txt.find(key);
                if (k == std::string::npos) return {};
                size_t q1 = txt.find('"', k + key.size());
                if (q1 == std::string::npos) return {};
                size_t q2 = txt.find('"', q1 + 1);
                if (q2 == std::string::npos) return {};
                return txt.substr(q1 + 1, q2 - q1 - 1);
            };
            if (tex1.empty()) {
                tex1 = readLuaField("tex1");
                RewriteToKtx2(tex1);
            }
            if (tex2.empty()) {
                tex2 = readLuaField("tex2");
                RewriteToKtx2(tex2);
            }
        }
    }

    // ---- Build the .config.json document ----
    //
    // configVersion stays at 6 here — the .config.json file represents
    // the v6 sidecar layout. The .gltf extension carries the
    // equivalent data under configVersion 7. ModelConfigLoader prefers
    // the .gltf extension when present and falls back to .config.json
    // for any model that hasn't been re-converted yet.
    json doc;
    doc["configVersion"] = JsonWriter::kCurrentConfigVersion;
    // Copy geometry fields out of the extractor's output. The piece
    // tree, attachments, midpos and AABB all reuse the same numeric
    // form so consumers reading either source get identical values.
    doc["radius"] = geom.at("radius");
    doc["height"] = geom.at("height");
    doc["midpos"] = geom.at("midpos");
    doc["mins"]   = geom.at("mins");
    doc["maxs"]   = geom.at("maxs");
    if (!tex1.empty()) doc["tex1"] = tex1;
    if (!tex2.empty()) doc["tex2"] = tex2;
    doc["pieces"] = geom.at("pieces");
    if (geom.contains("attachments")) {
        doc["attachments"] = geom.at("attachments");
    }

    std::ofstream out(outPath, std::ios::binary);
    if (!out) {
        std::fprintf(stderr,
            "modelimporter: failed to open %s for writing\n",
            outPath.c_str());
        return false;
    }
    out << doc.dump(2) << '\n';
    return out.good();
}
