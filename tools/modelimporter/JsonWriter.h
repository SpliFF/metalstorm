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
//   3 — also reads tex1 / tex2 from a sibling Spring author-config
//       file (`<sourceModel>.<ext>.lua`). Required for Collada and
//       similar formats whose Assimp importer doesn't carry Spring-
//       style texture bindings. Bumping the version forces a one-shot
//       regeneration of every v2 file so the new fallback is applied.
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
///
/// 2026-05-14: v4 — S3O importer emits `alphaMode: "MASK"` on the
/// base material so alpha-cutout decals (tank-track wheels, fan
/// blades) punch through instead of rendering as opaque black.
/// Existing v3 .glb files don't carry the alphaMode key and need to
/// be re-converted on the next gameconverter / lobby launch.
constexpr int kCurrentConfigVersion = 4;

/// Extract metadata from `scene` and write `outPath`, overwriting
/// any existing file at that location. Callers are responsible for
/// checking existence and the `--update-meta` flag before invoking.
///
/// `sourceModelPath` is the file Assimp imported. When a sibling
/// Spring author-config exists at `<sourceModelPath>.lua` (the
/// legacy `<modelname>.<ext>.lua` convention used by Collada / FBX
/// archives that don't carry texture bindings in the model file
/// itself), tex1/tex2/invertteamcolor are pulled from there as a
/// fallback when Assimp didn't fill in AI_MATKEY_TEXTURE_*. Pass an
/// empty string to skip the .lua lookup.
bool Write(const aiScene* scene,
           const std::string& outPath,
           const std::string& sourceModelPath = {});

} // namespace JsonWriter
