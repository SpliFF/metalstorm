// GameProcessor — extracts and converts per-game model assets during
// lobby-time preprocessing, mirroring the pattern used by FeatureProcessor
// for map features.
//
// Pipeline (per game):
//   1. Walk `<gamePath>/objects3d/` (case-insensitive) for every
//      Assimp-supported 3D file (`.s3o`, `.obj`, `.fbx`, `.dae`,
//      `.blend`, `.3ds`, `.gltf`/`.glb`, ...).
//   2. For S3O sources only: read the `tex1` diffuse basename out of
//      the file header, resolve it against the game's `unittextures/`
//      directory, and convert the texture to `.png` via ImageMagick.
//   3. Shell out to the `modelimporter` CLI to convert the model to
//      glTF 2.0 binary and emit a sibling `.meta.lua` containing the
//      engine-metadata the synced sim needs (bounding sphere, height,
//      piece tree, attachment points).
//
// Outputs land under `<dataDir>/games/<gameId>/models/`, and that
// directory is added as a content root by spring-server at startup
// so `SolidObjectDef::LoadModel` resolves each unit's `.meta.lua` via
// the existing content-root search path — see rts/server_main.cpp.
//
// The step is idempotent: a file is only re-converted when its source
// mtime is newer than the existing outputs. Per-file failures are
// logged to stderr and don't abort the scan.

#pragma once

#include <string>

namespace GameProcessor {

/// Scan and convert every model under `<gamePath>/objects3d/`, writing
/// results to `<dataDir>/games/<gameId>/models/`. Safe to call on every
/// lobby startup; up-to-date files are skipped.
void Process(const std::string& gamePath,
             const std::string& gameId,
             const std::string& dataDir);

} // namespace GameProcessor
