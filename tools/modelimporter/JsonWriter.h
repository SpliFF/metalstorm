// JsonWriter — extract engine metadata from an aiScene and write a
// `<model>.config.json` file that the synced sim can read directly
// via `LuaConfig::Load`.
//
// JSON is the canonical form for every engine-side configuration
// file in this project. The format is chosen for easy consumption
// by third-party tools (model viewers, data editors, build
// pipelines in other languages) — the engine itself decodes the
// file back into a Lua table via the vendored json-lua library,
// so the sim code reading the fields stays in the existing
// `LuaTable` world.
//
// Schema (as of kCurrentConfigVersion = 2):
//
//     {
//       "configVersion": 2,
//       "radius": 50.131,
//       "height": 56.492,
//       "midpos": [mx, my, mz],
//       "mins":   [x1, y1, z1],
//       "maxs":   [x2, y2, z2],
//       "tex1": "commrecon.dds",       // optional, present when the
//       "tex2": "commrecon2.dds",      // source file referenced one
//       "pieces": [
//         { "name": "base",   "parent": -1, "offset": [...], "mins": [...], "maxs": [...] },
//         { "name": "turret", "parent":  0, "offset": [...], "mins": [...], "maxs": [...] },
//         ...
//       ],
//       "attachments": [
//         { "kind": "aim",  "name": "aimpos1", "piece": 2 },
//         ...
//       ]
//     }
//
// Schema versions:
//   1 — initial form, geometry + pieces + attachments.
//   2 — added tex1 / tex2 from the source material's diffuse/specular
//       texture slots. modelimporter automatically overwrites a v1
//       file on its next run so existing trees self-upgrade.
//
// Once a `.config.json` file exists on disk it belongs to the
// author: the importer never rewrites it unless `--update-meta` is
// passed explicitly. And if a sibling `.config.lua` exists, the
// importer writes nothing at all — the Lua file signals that the
// author has taken full control of this model's metadata.

#pragma once

#include <string>

struct aiScene;

namespace JsonWriter {

/// Current config schema version emitted by Write(). Bump whenever
/// the `.config.json` format changes in a way older readers
/// wouldn't handle correctly. The engine-side reader in
/// ModelConfigLoader has its own copy of this constant and warns
/// when the file's `configVersion` is missing or older than its own.
/// modelimporter treats a configVersion strictly older than this
/// as "needs regeneration" and overwrites the file on its next run,
/// so trees of stale configs self-upgrade without --update-meta.
constexpr int kCurrentConfigVersion = 2;

/// Extract metadata from `scene` and write `outPath`, overwriting
/// any existing file at that location. Callers are responsible for
/// checking existence and the `--update-meta` flag before invoking.
bool Write(const aiScene* scene, const std::string& outPath);

} // namespace JsonWriter
