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
// Coordinate convention is RH-canonical (glTF-native): Z values are
// negated relative to the LH source data. The on-disk .gltf is also
// RH (modelimporter passes aiProcess_MakeLeftHanded at export).
//
// The extractor is pure: no filesystem access, no Lua, no logging.
// Inputs are an aiScene; output is a nlohmann::json.

#pragma once

#include <nlohmann/json.hpp>

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
constexpr int kCurrentSchemaVersion = 7;

/// Build the SPRINGRTS_geometry payload from `scene`. Returns a JSON
/// object suitable for placement at `extensions.SPRINGRTS_geometry`
/// in the document's root.
nlohmann::json BuildExtensionJson(const aiScene* scene);

} // namespace GeometryExtractor
