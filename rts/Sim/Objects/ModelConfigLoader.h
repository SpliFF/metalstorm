/* This file is part of the Spring engine (GPL v2 or later), see LICENSE.html */

/**
 * ModelConfigLoader — populate an S3DModel from the canonical
 * `<stem>.gltf` produced by tools/modelimporter.
 *
 * The sim doesn't read mesh data — it pulls bounding sphere, height,
 * mid-position, AABB, and piece tree (offsets, names, hierarchy) out
 * of the document-level `SPRINGRTS_geometry` extension embedded in
 * the `.gltf`. The legacy `.config.lua` / `.config.json` sidecars
 * have been retired; the `.gltf` is the single source of truth.
 *
 * SolidObjectDef::LoadModel calls into this loader at unit/feature
 * spawn time. File parse errors are logged and nullptr is returned
 * so the caller can fall back to its own defaults.
 */

#pragma once

#include <string>

struct S3DModel;

namespace ModelConfigLoader {

/// Load model config into a fresh `S3DModel`, given the *base path*
/// (no `.gltf` suffix). Returns nullptr if the `.gltf` is missing,
/// fails to parse, or lacks `SPRINGRTS_geometry`. Caller owns the
/// result.
S3DModel* Load(const std::string& basePath);

/// Populate `out` (already allocated) from `<basePath>.gltf`. Returns
/// true on success, false on any error; leaves `out` in its default-
/// initialised state on failure.
bool LoadInto(S3DModel& out, const std::string& basePath);

} // namespace ModelConfigLoader
