// MetaLuaWriter — extract engine metadata from an aiScene and write
// a `<model>.meta.lua` file that the synced sim can read directly.
//
// The sim never opens .glb files; at runtime it calls
// SolidObjectDef::LoadModel which reads the .meta.lua via the Lua
// parser and populates an S3DModel struct. Fields needed by the sim
// as of 2026-04:
//
//   metaVersion  — schema version; the reader branches on this
//   radius       — bounding sphere
//   height       — max Y - min Y
//   mins, maxs   — full AABB
//   midpos       — AABB centre (center-of-mass)
//   pieces[]     — piece tree: name, parent index, offset, mins/maxs
//   attachments  — named attachment points (aim_*, emit_*, hpoint_*)
//
// Once a `.meta.lua` file exists on disk it belongs to the author:
// modelimporter never mixes engine output into a hand-edited file.
// The driver (main.cpp) is responsible for checking whether the
// output file exists and whether it's stale before calling Write().
// Re-running modelimporter without `--update-meta` on an existing
// file leaves the file untouched; with `--update-meta` the file is
// overwritten with a fresh extraction.

#pragma once

#include <string>

struct aiScene;

namespace MetaLuaWriter {

/// Current meta schema version emitted by Write(). Bump whenever
/// the `.meta.lua` format changes in a way that older readers
/// wouldn't handle correctly (new required keys, renamed fields,
/// changed field semantics). The engine-side reader in
/// MetaLuaModelLoader has its own copy of this constant and warns
/// when the file's `metaVersion` is missing or older than its own.
constexpr int kCurrentMetaVersion = 1;

/// Extract metadata from `scene` and write `outPath`, overwriting
/// any existing file at that location. The caller is responsible
/// for checking existence and staleness (via source-mtime vs
/// meta-mtime, or an explicit `--update-meta` flag) before invoking.
///
/// Returns true on success, false if the file couldn't be opened
/// for writing.
bool Write(const aiScene* scene, const std::string& outPath);

} // namespace MetaLuaWriter
