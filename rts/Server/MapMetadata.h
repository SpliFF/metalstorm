// MapMetadata — data structures and read-only DB access for map metadata.
//
// Shared by lobby, game server, and tools. The full conversion pipeline
// (MapProcessor) lives in MapProcessor.h and is only linked into the
// mapconverter CLI tool.
#pragma once

#include <string>
#include <vector>

struct sqlite3;

/// Increment to reprocess all maps.
/// v15 changed legacy-Z conversion in MapProcessor::ProcessMap from negation
/// (`z → -z`, putting values in `[-mapZ, 0]`) to reflection through mapZ/2
/// (`z → mapZ - z`, keeping values in `[0, mapZ]`) — same logical purpose
/// (convert legacy LH author intent to engine RH convention) but the
/// engine's world bounds are now positive-quadrant per PLAN-coordinate-
/// system-option-a.md, so persisted MapMetadata records must follow suit.
/// v16 adds the `regions.json` export (PLAN-metalstorm-regions.md §5/§8
/// R1) — a static re-serialisation of the map's authored region graph
/// (`mapdata/regions.lua`), or a grid fallback descriptor when no graph is
/// authored / it fails validation. Sibling of heightmap.bin etc. in the
/// processed map directory.
/// PLAN-metalstorm-impostors.md M10 investigated bumping this to force a
/// reprocess after `features/impostors.json` started shipping (e55f0d9400)
/// and deliberately did NOT: `mapconverter --all` calls `ProcessOneMap` per
/// map, and each call's own `ScanAndProcess(dataDir + "/maps", ...)` scans
/// *every* already-existing map dir as a side effect, not just the one it
/// was asked to convert. A version bump makes every already-processed map
/// stale at once, so the side-effect scan triggered by the FIRST map in
/// the `--all` loop reprocesses every later map too — using whatever stale
/// content is already sitting in its `data/maps/<id>/` from the previous
/// run, since that later map's own `CopySourceTree` (which would have
/// pulled in the new source file) hasn't run yet. That reprocess still
/// bumps the stored format version, so when the outer loop finally reaches
/// the later map, its own fast-path check now reads "already current" and
/// skips it — `CopySourceTree` never runs, and the new source file never
/// lands. Confirmed live: an `--all` run against a scratch checkout seeded
/// at v16 left meridian_basin and skerry_reach without `impostors.json`
/// even though every map's stored formatVersion read 17 afterward; a
/// direct single-map `mapconverter content/maps/meridian_basin` run (no
/// version differential to race) produced it correctly. The existing
/// `.processed-stamp` freshness check (MapProcessor::ProcessedOutputCurrent)
/// doesn't have this problem — it's driven by each map's own real content
/// mtime, so a side-effect scan of a not-yet-recopied map still correctly
/// reads "unchanged, current" and defers to that map's own turn in the
/// `--all` loop, where `CopySourceTree` runs BEFORE the reprocess check.
/// Known residual gap, not fixed here: a processed dir from *before* the
/// stamp mechanism existed (pre-98fbd46bda, 2026-07-29) has no stamp file,
/// and a missing stamp reads as "current" (ProcessedOutputCurrent's
/// deliberate no-force default) — such a checkout would need the fix
/// above anyway (a version bump would just hit the same race), so the
/// actual fix is restructuring `tools/mapconverter/main.cpp`'s `--all`
/// mode to run every map's `CopySourceTree` before any map's
/// `ScanAndProcess`. Out of scope here (main.cpp is not part of the
/// impostors/map-pipeline file scope this fix touched) and moot for every
/// checkout observed 2026-08-03 (main + every active clone already has a
/// `.processed-stamp` newer than 98fbd46bda and older than e55f0d9400).
/// 17: MapDecalData::splatDetailNormalDiffuseAlpha (D48 — the client needs
///     Recoil's SMF_DETAIL_NORMAL_DIFFUSE_ALPHA flag to pick the right
///     branch of GetDetailTextureColor for splat-normal maps).
constexpr int MAP_FORMAT_VERSION = 17;

struct MapStartPosition {
    float x = 0, z = 0;
};

struct MapFeatureData {
    int featureType = 0;
    float x = 0, y = 0, z = 0;
    float rotation = 0;
    float relativeSize = 1.0f;
};

/// Definition of a feature type referenced by `MapFeatureData::featureType`.
/// Parsed from the map's `features/*.lua` files (Spring's `featureDefs` table)
/// and converted to web-ready assets by FeatureProcessor:
///   - the original `.s3o` model is converted to a `.glb` via modelimporter
///   - the original `.tga`/`.dds` texture is converted to `.png` via magick
///
/// Filenames in `modelFile`/`textureFile` are relative to the map's processed
/// data directory (`processedDir/features/`); the client fetches them via
/// `/api/maps/data/{mapId}/features/{filename}`.
struct MapFeatureDef {
    std::string name;          // canonical name (lowercased Spring def key)
    std::string modelFile;     // e.g. "GreyRock1.glb" — empty if no model
    std::string textureFile;   // e.g. "GreyRock1.png" — empty if no texture
    int   footprintX = 1;
    int   footprintZ = 1;
    float height = 0;          // visual height in elmos (from def)
    float radius = 0;          // collision/picking radius in elmos
    bool  blocking = true;
    bool  reclaimable = false;
    int   metal = 0;
    int   energy = 0;
    int   damage = 0;          // hit points
};

/// Spring's splat detail texture system — 4 detail normal textures blended
/// by a distribution map. This IS the map "decal" asset system.
/// Filenames are the relative names in the processed dir (e.g. "splat_distr.png").
/// Empty strings mean the texture is not defined by the map.
struct MapDecalData {
    std::string detailTex;             // fallback single detail texture
    std::string specularTex;
    std::string splatDetailTex;        // single splat texture (old mode)
    std::string splatDistrTex;         // RGBA distribution map
    std::string splatDetailNormalTex[4]; // 4 channel detail+normal+tangent+specular
    std::string detailNormalTex;       // global detail normal map
    float splatScales[4] = {0.02f, 0.02f, 0.02f, 0.02f};
    float splatMults[4]  = {1.0f, 1.0f, 1.0f, 1.0f};
    /// mapinfo `resources.splatDetailNormalDiffuseAlpha` (or the
    /// `splatDetailNormalTex` sub-table's `alpha` key). Recoil's
    /// SMF_DETAIL_NORMAL_DIFFUSE_ALPHA: when set, the alpha channel of the
    /// blended splat detail *normals* supplies the ground's near-field
    /// albedo detail; when clear, that branch contributes no albedo at all.
    /// See CMapInfo::ReadSMF and SMFRenderState.cpp:115.
    bool splatDetailNormalDiffuseAlpha = false;
};

/// Water rendering properties. Spring's "water" system is also used for
/// lava/acid/void-fill etc. — just the colour and damage tell you what it is.
/// The water plane is at world Y = 0 by default; terrain below that is flooded.
struct MapWaterData {
    float baseColor[3]    = {0.0f, 0.4f, 0.7f};  // bulk colour at depth
    float surfaceColor[3] = {0.75f, 0.8f, 0.85f}; // colour at the surface
    float minColor[3]     = {0.0f, 0.2f, 0.4f};
    float surfaceAlpha = 0.55f;
    float damage = 0.0f;   // damage/sec to units in the water (lava = high)
    bool  voidWater = false; // true = don't render water plane (void below)
};

struct MapMetadata {
    std::string id;
    std::string name;
    std::string shortName;
    std::string description;
    std::string author;
    std::string version;
    int mapx = 0, mapy = 0;
    int widthElmos = 0, heightElmos = 0;
    float minHeight = 0, maxHeight = 0;
    /// If the map's `mapinfo.lua` provides `smf.minheight`/`smf.maxheight`
    /// the sim uses those values instead of the SMF header's baked-in
    /// range when decoding the uint16 heightmap. We mirror that behaviour
    /// here so the client-side terrain render scale matches the sim's,
    /// otherwise units spawned at ground y=f(heightmap) float above or
    /// sink below the visually rendered terrain.
    bool mapInfoHeightOverride = false;
    float gravity = 130;
    float tidalStrength = 0;
    float maxMetal = 2.0f;
    float extractorRadius = 100.0f;
    int tilesX = 0, tilesZ = 0;
    int numTiles = 0;
    int formatVersion = 0;
    std::string processedDir;
    std::string sourcePath;   // map directory
    std::string smfPath;
    std::string smtPath;
    bool hasLuaGaia = false;
    /// `mapinfo.lua → legacyCoordSystem` — true (default) when the
    /// map's source files (`mapinfo.lua`, `featureplacer/*.lua`, etc.)
    /// are authored in Spring's legacy LH frame, i.e. `+Z` forward.
    /// The importer mirrors `z` (and feature `rotation`) on read so
    /// every record persisted here is RH-canonical regardless. The
    /// flag is preserved so downstream Lua-VFS reads of raw map data
    /// know whether the on-disk Lua source still speaks LH (legacy)
    /// or RH (new content).
    bool legacyCoordSystem = true;

    std::vector<MapStartPosition> startPositions;
    /// Type names — strings indexed by `MapFeatureData::featureType`.
    /// Populated from both SMF-embedded features and the Lua featureplacer.
    std::vector<std::string> featureTypes;
    /// Per-instance placements (position, rotation, etc.).
    std::vector<MapFeatureData> features;
    /// Definitions for each unique feature type referenced above.
    /// Parallel to `featureTypes` (same indices) but contains the model
    /// path, footprint, etc. parsed from the map's `features/*.lua`.
    std::vector<MapFeatureDef> featureDefs;
    MapDecalData decals;
    MapWaterData water;
    /// `mapinfo.lua → sound.preset` — names an OpenAL EFX preset that
    /// Recoil binds to the map-wide reverb chain. Client side, we map
    /// this to a ConvolverNode impulse-response fetched from
    /// `sounds/efx/<preset>.webm`. Empty / `"default"` = no reverb.
    std::string soundPreset;
    /// Relative paths (from the map source dir) to any .lua widgets the
    /// map ships under LuaUI/Widgets/. Client fetches each one from
    /// /api/maps/data/{id}/{path}.
    std::vector<std::string> widgets;
};

/// Read-only SQLite access for map metadata. Used by the lobby and
/// game server to query pre-processed map data without needing any
/// conversion dependencies (Lua, ImageMagick, modelimporter).
class MapMetadataDb {
public:
    /// `ok` (optional) distinguishes "the maps table is genuinely empty"
    /// from "the read failed". They are not the same thing, and conflating
    /// them is what made D33 invisible: a faulted handle returned an empty
    /// vector, /api/maps answered `200 []`, and the Create Game dialog said
    /// "No maps found in content/maps/" — pointing every reader at the
    /// content directory while the real fault was the DB handle. Callers
    /// that surface maps to a user MUST pass this and report a failed read
    /// as an error, not as an empty list.
    std::vector<MapMetadata> GetAllMaps(sqlite3* db, bool* ok = nullptr);
    MapMetadata GetMap(sqlite3* db, const std::string& mapId);
    void StoreMetadata(sqlite3* db, const MapMetadata& meta);
    static void EnsureTable(sqlite3* db);
};
