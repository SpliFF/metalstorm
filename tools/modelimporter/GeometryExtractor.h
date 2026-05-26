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
constexpr int kCurrentSchemaVersion = 8;

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
nlohmann::json BuildExtensionJson(const aiScene* scene,
                                  const std::string& sourceModelPath = {});

} // namespace GeometryExtractor
