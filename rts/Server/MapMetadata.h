// MapMetadata — data structures and read-only DB access for map metadata.
//
// Shared by lobby, game server, and tools. The full conversion pipeline
// (MapProcessor) lives in MapProcessor.h and is only linked into the
// mapconverter CLI tool.
#pragma once

#include <string>
#include <vector>

struct sqlite3;

/// Increment to reprocess all maps. v15 changes legacy-Z conversion
/// in MapProcessor::ProcessMap from negation (`z → -z`, putting values
/// in `[-mapZ, 0]`) to reflection through mapZ/2 (`z → mapZ - z`,
/// keeping values in `[0, mapZ]`) — same logical purpose (convert
/// legacy LH author intent to engine RH convention) but the engine's
/// world bounds are now positive-quadrant per PLAN-coordinate-system-
/// option-a.md, so persisted MapMetadata records must follow suit.
constexpr int MAP_FORMAT_VERSION = 15;

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
    std::vector<MapMetadata> GetAllMaps(sqlite3* db);
    MapMetadata GetMap(sqlite3* db, const std::string& mapId);
    void StoreMetadata(sqlite3* db, const MapMetadata& meta);
    static void EnsureTable(sqlite3* db);
};
