// MapProcessor — processes Spring maps into web-ready formats.
//
// On first encounter (or when MAP_FORMAT_VERSION increments):
//   1. Parses mapinfo.lua for metadata (name, author, start positions, etc.)
//   2. Reads SMF header for dimensions and data offsets
//   3. Extracts binary data files:
//      - heightmap.bin (raw uint16[])
//      - minimap.dxt1 (raw DXT1 1024x1024 mip0)
//      - tileindex.bin (raw int32[])
//      - typemap.bin (raw uint8[])
//      - metalmap.bin (raw uint8[])
//      - tiles.dxt1 (all tile mip0 concatenated, 512 bytes each)
//   4. Extracts feature placements from SMF
//   5. Stores all metadata in SQLite maps table
//
// Processed data served via HTTP (binary files) and FlatBuffers (metadata).
#pragma once

#include <cstdint>
#include <string>
#include <vector>

struct sqlite3;

/// Increment to reprocess all maps.
constexpr int MAP_FORMAT_VERSION = 10;

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
    /// Relative paths (from the map source dir) to any .lua widgets the
    /// map ships under LuaUI/Widgets/. Client fetches each one from
    /// /api/maps/source/{id}/{path}.
    std::vector<std::string> widgets;
};

class MapProcessor {
public:
    void ScanAndProcess(const std::string& mapsDir, const std::string& dataDir, sqlite3* db);
    std::vector<MapMetadata> GetAllMaps(sqlite3* db);
    MapMetadata GetMap(sqlite3* db, const std::string& mapId);

private:
    bool ReadMapInfo(const std::string& mapDir, MapMetadata& meta);
    bool ReadSMFHeader(MapMetadata& meta);
    bool ExtractBinaryData(const MapMetadata& meta);
    /// Decode the SMF's 1024×1024 DXT1 minimap and pipe the raw RGB
    /// into `magick` to write `<processedDir>/minimap.webp`. Done once
    /// at preprocess time — the /api/maps/thumb/<id> handler just
    /// serves the resulting file directly.
    bool ExtractMinimapWebP(const MapMetadata& meta);
    bool ExtractFeatures(MapMetadata& meta);
    bool ExtractDecalTextures(MapMetadata& meta);
    void EnumerateWidgets(MapMetadata& meta);
    bool ProcessMap(MapMetadata& meta);
    void StoreMetadata(sqlite3* db, const MapMetadata& meta);
    static void EnsureTable(sqlite3* db);
};
