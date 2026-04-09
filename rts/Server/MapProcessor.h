// MapProcessor — processes Spring maps into web-ready formats.
//
// On first encounter (or when map_format version changes), reads
// the SMF/SMT files and produces:
//   - KTX2 texture tiles (BC1/DXT1, direct from SMT data)
//   - KTX2 minimap (1024x1024 BC1 from SMF embedded minimap)
//   - Metadata stored in SQLite maps table
//
// Processed data is stored in data/maps/{map_id}/ and served via HTTP.
#pragma once

#include <cstdint>
#include <string>
#include <vector>

struct sqlite3;

/// Current map processing format version. Increment to reprocess all maps.
constexpr int MAP_FORMAT_VERSION = 1;

struct MapMetadata {
    std::string id;          // directory name
    std::string name;        // display name
    std::string smfPath;     // path to .smf file
    std::string smtPath;     // path to .smt file
    int mapx = 0;
    int mapy = 0;
    int widthElmos = 0;
    int heightElmos = 0;
    float minHeight = 0;
    float maxHeight = 0;
    int numTiles = 0;
    int tilesX = 0;          // tile grid width (mapx/4)
    int tilesZ = 0;          // tile grid height (mapy/4)
    int formatVersion = 0;
    std::string processedDir; // data/maps/{id}/
};

class MapProcessor {
public:
    /// Scan a maps directory, process any new/outdated maps, store metadata in DB.
    void ScanAndProcess(const std::string& mapsDir, const std::string& dataDir, sqlite3* db);

    /// Get all map metadata from DB.
    std::vector<MapMetadata> GetAllMaps(sqlite3* db);

    /// Get a single map's metadata by ID.
    MapMetadata GetMap(sqlite3* db, const std::string& mapId);

private:
    /// Read SMF header and locate SMT file.
    bool ReadMapHeaders(const std::string& mapDir, MapMetadata& meta);

    /// Process a single map: extract textures to KTX2.
    bool ProcessMap(const MapMetadata& meta);

    /// Write a KTX2 file containing BC1/DXT1 data.
    bool WriteKTX2(const std::string& path, int width, int height,
                   const std::vector<uint8_t>& bc1Data, int mipLevels = 1);

    /// Composite SMT tiles into a full-map KTX2 texture (tiled into chunks).
    bool ProcessMapTexture(const MapMetadata& meta);

    /// Extract minimap from SMF as KTX2.
    bool ProcessMinimap(const MapMetadata& meta);

    /// Store metadata in SQLite.
    void StoreMetadata(sqlite3* db, const MapMetadata& meta);

    /// Create the maps table if it doesn't exist.
    static void EnsureTable(sqlite3* db);
};
