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
constexpr int MAP_FORMAT_VERSION = 3;

struct MapStartPosition {
    float x = 0, z = 0;
};

struct MapFeatureData {
    int featureType = 0;
    float x = 0, y = 0, z = 0;
    float rotation = 0;
    float relativeSize = 1.0f;
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
    std::vector<std::string> featureTypes;
    std::vector<MapFeatureData> features;
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
    bool ExtractFeatures(MapMetadata& meta);
    bool ProcessMap(MapMetadata& meta);
    void StoreMetadata(sqlite3* db, const MapMetadata& meta);
    static void EnsureTable(sqlite3* db);
};
