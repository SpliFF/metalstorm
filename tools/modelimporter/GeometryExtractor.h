// GeometryExtractor — pull engine-relevant simulation metadata out of
// an aiScene and return it as a JSON document ready to drop into a
// glTF `SPRINGRTS_geometry` document-level extension.
//
// Shape (configVersion 7):
//
//     {
//       "configVersion": 7,
//       "radius": 50.131,
//       "height": 56.492,
//       "midpos": [mx, my, mz],
//       "mins":   [x1, y1, z1],
//       "maxs":   [x2, y2, z2],
//       "tex1": "armcom_color.ktx2",    // transitional; removed in Phase 1d
//       "tex2": "armcom_color2.ktx2",   // transitional; removed in Phase 1d
//       "pieces": [
//         { "name": "base",   "parent": -1, "offset": [...], "mins": [...], "maxs": [...] },
//         { "name": "holder", "parent":  3, "offset": [...], "rot": [r00..r22], ... },
//         ...
//       ],
//       "attachments": [
//         { "kind": "aim", "name": "aimpos1", "piece": 2 },
//         ...
//       ]
//     }
//
// `tex1` / `tex2` are kept in the extension while the gameconverter still
// resolves the team mask (tex2) through a Spring-conventional bare-stem
// lookup. Once Phase 1d wires tex2 in as a proper glTF image reference
// under the `SPRINGRTS_team_color` extension, both fields drop out.
//
// Coordinate convention is RH-canonical (glTF-native): Z values are
// negated relative to the LH source data. The on-disk .gltf is also
// RH (modelimporter passes aiProcess_MakeLeftHanded at export).

#pragma once

#include <nlohmann/json.hpp>

#include <string>

struct aiScene;

namespace GeometryExtractor {

/// Schema version embedded in the extension payload. Bump whenever
/// the field shape changes in a way older readers wouldn't handle.
/// The engine-side reader in `rts/Sim/Objects/ModelConfigLoader.cpp`
/// has its own copy of this constant — keep them in sync.
///
/// 7 — initial form, moved from a sibling `<stem>.config.json` (where
///     it lived as `configVersion: 6`) into a document-level glTF
///     extension on the model's `.gltf` file. The .config.json sidecar
///     is no longer emitted; the .gltf is now the complete record.
/// 8 — `radius` now computed as the AABB half-diagonal (Recoil's
///     `(maxs - midpos).Length()`), matching the bounding sphere
///     centred on `midpos` that Recoil uses for collisions. Older
///     bumps used `length(maxs)` from the local origin, inflating the
///     radius for ground-anchored / tall models (e.g. zenith went
///     160 → 112).
///
/// Additive since 8 (no version bump — older readers ignore it):
///     pieces carry an optional `rot` field, the piece's rest rotation
///     (the linear 3×3 of the source node's local transform), row-major,
///     in the same glTF-native RH frame as `offset`. Only emitted for
///     pieces whose rest rotation deviates from identity — notably the
///     up-axis conversion node (Z-up→Y-up on Collada sources) and any
///     rotated intermediate turret piece. A reader that predates the
///     field drops these rotations and accumulates translations only, so
///     muzzle/attachment pieces under a rotated parent land in the wrong
///     frame (barrels resolve to the unit centre instead of the elevated
///     tip). The client always had this data (it reads the glTF node
///     matrices directly); the field brings the sim into agreement.
///     Unlike the 7→8 radius change (a *semantic* change to an existing
///     field, which forced a bump), this is purely additive, so the
///     version stays 8 — S3O games (BAR: axis-aligned, all-identity rot)
///     don't need regenerating, and a mixed v8 fleet stays loadable.
constexpr int kCurrentSchemaVersion = 8;

/// World-scale contract: **8 elmos = 1 metre** (PLAN-world-scale.md §5
/// Option A, USER-DECIDED 2026-08-27; DESIGN-MODEL-BUILDING.md §4/§12).
/// The sim consumes every SPRINGRTS_geometry length — radius, height,
/// midpos, mins/maxs, piece offsets — as ELMOS, and builds the collision
/// AND selection volumes from them (rts/Sim/Objects/ModelConfigLoader.cpp
/// → Unit.cpp), so the scale can never be render-only. Sources authored
/// in metres (1 glTF unit = 1 m — the metalstorm native corpus) must be
/// multiplied by this constant at import (`modelimporter --metres` scales
/// the whole aiScene — vertices, node translations, animation position
/// keys — before extraction/export). Sources already authored in elmos
/// (Spring S3O/BAR content, the map-feature corpus) must NOT be scaled.
/// Emitted files carry `units: "elmos"` (additive field — older readers
/// ignore it). The same constant lives in
/// tools/fable-model-forge/gltf_export.py (ELMOS_PER_METRE) and
/// tools/scripts/rescale_models_to_elmos.py; the engine's own
/// ELMOS_TO_METERS (rts/Sim/Misc/GlobalConstants.h) is its inverse.
constexpr float kElmosPerMetre = 8.0f;

/// Build the SPRINGRTS_geometry payload from `scene`. Returns a JSON
/// object suitable for placement at `extensions.SPRINGRTS_geometry`
/// in the document's root.
///
/// `sourceModelPath` is the path the importer read (e.g.
/// `data/games/zk/Objects3d/armcom1.s3o`). When non-empty and Assimp's
/// material slots leave tex1 / tex2 unset (true for `.dae` and similar
/// archive formats), the extractor consults the sibling Spring author-
/// config `<sourceModelPath>.lua` for tex1 / tex2 strings — matching
/// the legacy JsonWriter behaviour.
///
/// `normaltexOverride` lets a caller supply the normal-map texture for
/// sources that carry no per-model sidecar `normaltex` — notably BAR,
/// where the normal map is authored in the *unitDef* (`customParams.
/// normaltex`), not the model. gameconverter scans the unitdefs and
/// passes the model's normaltex here. Only the basename is used (the
/// emitted glTF image URI is a bare `<stem>.ktx2` resolved against the
/// models/ dir). When non-empty it takes precedence over any sidecar
/// `normaltex`; empty leaves the existing sidecar path untouched.
nlohmann::json BuildExtensionJson(const aiScene* scene,
                                  const std::string& sourceModelPath = {},
                                  const std::string& normaltexOverride = {});

/// Decide whether the V coordinate of texture coordinates should be
/// flipped (V → 1.0 - V) at conversion time for the given source model
/// and tex1 reference.
///
/// Encapsulates the per-asset rule that bridges Spring's per-format
/// texture-loading conventions to our spec-compliant glTF+KTX2 output:
///
///   * Spring's nv_dds path always vertically flips DDS during load
///     (Bitmap.cpp ddsimage.load(filename, flipDDS=true)), so DDS
///     texture memory ends up bottom-up regardless of the parser's
///     `invertAxis` flag. Effective UV V=0 in Spring lands on the
///     visual bottom of the source DDS.
///   * Spring's IL path loads TGA/PNG/JPG with IL_ORIGIN_UPPER_LEFT
///     (top-down in memory). A subsequent bitmap->ReverseYAxis() is
///     only invoked when the parser passes `invertAxis=true`
///     (AssParser default true; S3OParser hardcodes false; GLTFParser
///     default false). When ReverseYAxis runs the memory flips to
///     bottom-up; otherwise it stays top-down. So effective Spring
///     UV V=0 lands on the visual bottom for TGA/PNG with
///     fliptextures=true, but on the visual top with fliptextures=false.
///
/// Our pipeline normalises every KTX2 to top-down storage (stb_image
/// flips bottom-up TGAs on decode; the DXT decoder leaves DDS top-down).
/// Babylon uploads textures with UNPACK_FLIP_Y_WEBGL=true (its
/// `Texture(invertY=true)` constructor default), so WebGL UV V=0
/// reliably samples the visual bottom of the source data for every
/// `.ktx2` we ship.
///
/// Matching Spring therefore requires inverting the UV only when
/// Spring would have sampled the visual top — non-DDS textures loaded
/// without ReverseYAxis. The decision table:
///
///   tex1 ext   | effective fliptextures | UV flip needed
///   -----------+------------------------+----------------
///   .dds       | (any)                  | no
///   non-.dds   | true                   | no
///   non-.dds   | false                  | YES
///
/// `effective_fliptextures` is the sidecar `fliptextures = X` value
/// when present, else the per-format default: false for `.s3o` and
/// `.gltf`/`.glb` (matches Recoil's S3OParser hardcode and GLTFParser
/// default), true for everything else (matches AssParser's "true is
/// the incorrect default, but has to be retained to be compatible"
/// comment at AssParser.cpp:591).
///
/// `sourceModelPath` is the file the importer read (e.g.
/// `content/games/zk/Objects3d/noruas.s3o`); used to locate the
/// `unittextures/` sibling and the `<sourceModelPath>.lua` author
/// sidecar.
///
/// `tex1Name` is the bare tex1 filename from the Assimp material's
/// `AI_MATKEY_TEXTURE_DIFFUSE(0)` (the S3OImporter populates this
/// from the .s3o header; for `.dae` it usually comes from the sidecar
/// after `ReadSidecarFields` runs). When empty, the function falls
/// back to the Spring naming convention (`<modelStem>1.<ext>`) before
/// declaring "no tex" (in which case the flip can't affect anything
/// and the answer is false).
///
/// Returns true to flip every V coord on materials backed by this
/// tex1; false to pass UVs through unchanged.
bool ShouldFlipUv(const std::string& sourceModelPath,
                  const std::string& tex1Name);

} // namespace GeometryExtractor
