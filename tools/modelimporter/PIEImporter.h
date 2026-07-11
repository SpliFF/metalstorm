// Open Asset Import Library (assimp)
// ----------------------------------------------------------------------
//
// PIE importer — Warzone 2100 unit/structure model format.
//
// This file is structured as a drop-in module for upstream Assimp, exactly
// like S3OImporter.{h,cpp}. It implements `BaseImporter` and reads a
// Warzone 2100 `.pie` file (or a `.wzasm` multi-component assembly manifest)
// into an `aiScene`. The importer is registered at runtime by the host
// application via `Assimp::Importer::RegisterLoader(new PIEImporter())`, so
// it does not require any modification to the Assimp source tree.
//
// ----------------------------------------------------------------------
//
// `.pie` text format (one component per file; see the WZ2100 wiki):
//
//   PIE <version>              // 2 = int coords + pixel-space UVs (/tex-dim)
//                              // 3 = float coords + normalised UVs
//                              // 4 = adds TCMASK (team-colour mask page)
//   TYPE <flags>
//   TEXTURE 0 <page.png> [w h] // diffuse page; w/h declared for PIE2 (256 256)
//   TCMASK 0 <page_tcmask.png> // optional (PIE4): greyscale team-colour mask
//   LEVELS <n>
//   LEVEL 1                    // we ingest LEVEL 1 only (later = damage/LOD)
//     POINTS <n>  <x y z> ...          // shared vertex list (model-local)
//     NORMALS <n> ...                  // skipped — we recompute flat normals
//     POLYGONS <n>                     // <flags npts i0..iN u0 v0 .. uN vN [anim]>
//     CONNECTORS <n> <x y z> ...       // attachment points (muzzle mounts)
//
// Coordinates: WZ is Y-up, +Z-forward, left-handed — passed through here
// VERBATIM, exactly as `S3OImporter` passes S3O through. modelimporter's
// export step (`aiProcess_MakeLeftHanded | aiProcess_FlipWindingOrder`)
// converts to glTF's RH convention, reproducing what the old
// `pie_to_glb.py` did by hand (negate Z + reverse winding).
//
// `.wzasm` assembly manifest (JSON) — replaces the old `assemblies.json` +
// the assembly half of `pie_to_glb.py`. One manifest → one complete
// multi-component unit:
//
//   { "wzassembly": 1, "name": "wz_tank", "target_metres": 8.5,
//     "dominant_axis": "z", "pie_dir": "pie",
//     "parts": [
//       { "pie": "drhbod09.pie", "node": "body" },
//       { "pie": "prhltrk3.pie", "node": "tracks_l", "parent": "body" },
//       { "pie": "trhcan.pie",  "node": "turret", "parent": "body",
//         "mount": { "pie": "drhbod09.pie", "connector": 0 },
//         "add_muzzle": true } ] }
//
// A bare `.pie` input is the degenerate one-part assembly (identity mount,
// no rescale) and shares the assembly code path.
//
// Textures: one `aiMaterial` per distinct diffuse page (named after the page
// stem), referenced by every part that uses it. A part carrying a TCMASK
// attaches the mask page on the `aiTextureType_LIGHTMAP` slot (→ glTF
// `occlusionTexture`) as a carrier; modelimporter's post-fix relocates any
// `*_tcmask` texture into the `SPRINGRTS_team_color` material extension.

#pragma once

#include <assimp/BaseImporter.h>
#include <assimp/types.h>

#include <array>
#include <string>
#include <vector>

struct aiNode;
struct aiMesh;
struct aiScene;

namespace Assimp {

class PIEImporter : public BaseImporter {
public:
    PIEImporter();
    ~PIEImporter() override;

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
    // ---- Parsed .pie component ----
    struct Tri {
        std::array<aiVector3D, 3> pos;   // WZ-space positions (verbatim)
        std::array<aiVector3D, 3> uv;    // normalised UVs (z unused)
    };
    struct Component {
        std::string name;                // node name from the manifest / stem
        std::vector<Tri> tris;
        std::vector<aiVector3D> connectors;
        std::string texPage;             // diffuse page filename
        std::string tcmaskPage;          // team-colour mask page (may be empty)
        int pieVersion = 2;
    };

    // ---- Assembly spec (from a .wzasm manifest, or synthesised for a
    //      bare .pie) ----
    struct PartSpec {
        std::string pie;
        std::string node;
        std::string parent;              // empty = root
        bool hasMount = false;
        std::string mountPie;
        int mountConnector = 0;
        bool addMuzzle = false;
    };
    struct AssemblySpec {
        std::string name;
        float targetMetres = 0.0f;       // 0 = no rescale
        char dominantAxis = 'z';         // 'x' | 'y' | 'z'
        std::string pieDir = "pie";
        std::vector<PartSpec> parts;
    };

    /// Read a whole file into a string via the IO handler.
    static std::string ReadTextFile(IOSystem* io, const std::string& path);

    /// Parse one `.pie` text blob into a Component (LEVEL 1 only).
    static Component ParsePie(const std::string& text, const std::string& nodeName);

    /// Build a one-part AssemblySpec for a bare `.pie` input.
    static AssemblySpec SinglePartSpec(const std::string& pieFile);

    /// Parse a `.wzasm` JSON manifest into an AssemblySpec.
    static AssemblySpec ParseManifest(const std::string& json);

    /// Turn an AssemblySpec + its resolved components into the aiScene.
    void BuildScene(const AssemblySpec& spec,
                    aiScene* pScene,
                    IOSystem* pIOHandler,
                    const std::string& baseDir);
};

} // namespace Assimp
