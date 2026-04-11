// MetaLuaWriter — extract engine metadata from an aiScene and write
// a `<model>.meta.lua` file that the synced sim can read directly.
//
// The sim never opens .glb files; at runtime it calls
// SolidObjectDef::LoadModel which reads the .meta.lua via the Lua
// parser and populates an S3DModel struct. Fields needed by the sim
// as of 2026-04:
//
//   radius       — bounding sphere
//   height       — max Y - min Y
//   mins, maxs   — full AABB
//   midpos       — AABB centre (center-of-mass)
//   pieces[]     — piece tree: name, parent index, offset, mins/maxs
//   attachments  — named attachment points (aim_*, emit_*, hpoint_*)
//
// If the source tree already has an authored `<source>.meta.lua`
// next to the source model, the writer merges it on top of the
// auto-extracted values — authored fields always win.
#pragma once

#include <string>

struct aiScene;

namespace MetaLuaWriter {

/// Extract metadata from `scene` and write `outPath`. If
/// `authoredSource` is non-empty and the file exists, parse it as
/// a lua return-table and overlay its fields on top of the
/// extracted ones before writing the merged output.
///
/// Returns true on success, false if the file couldn't be opened
/// for writing.
bool Write(const aiScene* scene,
           const std::string& outPath,
           const std::string& authoredSource = "");

} // namespace MetaLuaWriter
