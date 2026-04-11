/* This file is part of the Spring engine (GPL v2 or later), see LICENSE.html */

/**
 * MetaLuaModelLoader — populate an S3DModel from a `.meta.lua` file
 * written by the modelimporter preprocess tool.
 *
 * The sim never reads binary model files directly. At content-
 * preprocess time modelimporter converts each source model to a
 * `.glb` for the client and emits a sibling `.meta.lua` containing
 * the engine-relevant fields (bounding sphere, height, mid-position,
 * piece tree, attachment points). SolidObjectDef::LoadModel calls
 * into this loader at unit/feature spawn time to read that file.
 *
 * The loader is a pure wrapper around Spring's `LuaParser` — no
 * Assimp dependency in spring-server. File parse errors are logged
 * to stderr and a default-initialised model is returned so the
 * sim keeps running.
 */

#pragma once

#include <string>

struct S3DModel;

namespace MetaLuaModelLoader {

/// Load a `.meta.lua` into an `S3DModel`. Returns nullptr if the
/// file doesn't exist or can't be parsed. Logged errors land on
/// stderr. Caller owns the returned model.
S3DModel* Load(const std::string& metaPath);

/// Populate `out` (already-allocated) from a `.meta.lua` file.
/// Returns true on success, false on any error. Leaves `out` in
/// its default-initialised state on failure.
bool LoadInto(S3DModel& out, const std::string& metaPath);

} // namespace MetaLuaModelLoader
