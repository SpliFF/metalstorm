// FeatureProcessor — extracts and converts map feature definitions and
// placements during map preprocessing.
//
// Pipeline (per map):
//   1. Walk `features/*.lua` and parse each FeatureDef table via the
//      embedded Lua interpreter (using LuaVFSSimple for VFS resolution).
//      Populates `MapMetadata::featureDefs` and pre-seeds `featureTypes`.
//   2. Run `mapconfig/featureplacer/config.lua` if it exists, parse its
//      `objectlist` table, and append the placements to
//      `MapMetadata::features` (registering new type indices on the fly).
//      This is what most modern Spring maps use instead of embedding
//      placements in the SMF binary section.
//   3. For each unique FeatureDef referenced by a placement, convert
//      its `.s3o` model to `.glb` via the `any2gltf` CLI, and convert
//      the referenced texture (`.tga`/`.dds`/etc.) to `.png` via
//      ImageMagick. Outputs land in `processedDir/features/`.
//
// All steps are best-effort: a missing model or unsupported texture
// format leaves the def in place but with empty `modelFile` /
// `textureFile`, and the client falls back to a placeholder for that
// type.

#pragma once

struct MapMetadata;

namespace FeatureProcessor {

/// Run all four steps end-to-end. Reads from `meta.sourcePath` and writes
/// converted assets into `meta.processedDir/features/`. Mutates `meta` in
/// place: appends to `featureTypes`, `features`, populates `featureDefs`.
void Process(MapMetadata& meta);

} // namespace FeatureProcessor
