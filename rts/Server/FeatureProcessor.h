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
//   3. For each unique FeatureDef referenced by a placement, produce the
//      runtime asset set under `processedDir/features/`:
//        - `.s3o` sources are converted to `.gltf` via the `modelimporter`
//          CLI, and the texture named by the S3O's tex1 field is converted
//          to `.ktx2` via `textureconverter`.
//        - `.gltf` / `.glb` sources are already in the runtime's native
//          form (authored by tools/fable-model-forge or
//          tools/mapgen/gen_vegetation_models.py) and are installed
//          verbatim along with the sidecars they reference — buffers,
//          KTX2 images, and `<stem>_impostor.*` atlases. No Assimp
//          round-trip, and `textureFile` stays empty because the document
//          carries its own image URIs.
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
