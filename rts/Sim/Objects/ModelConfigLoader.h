/* This file is part of the Spring engine (GPL v2 or later), see LICENSE.html */

/**
 * ModelConfigLoader — populate an S3DModel from the project's
 * standard config-file convention (`.config.lua` / `.config.json`).
 *
 * The sim never reads binary model files directly. At content-
 * preprocess time modelimporter converts each source model to a
 * `.glb` for the client and emits a sibling `<stem>.config.json`
 * containing the engine-relevant fields (bounding sphere, height,
 * mid-position, piece tree, attachment points). Authors who want
 * dynamic metadata can drop a `<stem>.config.lua` alongside; the
 * Lua form wins over the JSON form if both exist. Both are
 * resolved through `LuaConfig::Load`.
 *
 * SolidObjectDef::LoadModel calls into this loader at unit/feature
 * spawn time to read whichever form is present. File parse errors
 * are logged to stderr and a default-initialised model is returned
 * so the sim keeps running.
 */

#pragma once

#include <string>

struct S3DModel;

namespace ModelConfigLoader {

/// Load model config into a fresh `S3DModel`, given the *base path*
/// (no `.config.lua`/`.config.json` suffix). Returns nullptr if
/// neither form exists or parsing fails. Caller owns the result.
S3DModel* Load(const std::string& basePath);

/// Populate `out` (already allocated) from a model config file at
/// `basePath`. Returns true on success, false on any error; leaves
/// `out` in its default-initialised state on failure.
bool LoadInto(S3DModel& out, const std::string& basePath);

} // namespace ModelConfigLoader
