// MapProcessor — full map conversion pipeline.
//
// Depends on Lua, ImageMagick (magick), modelimporter, and
// FeatureProcessor. Only linked into the mapconverter CLI tool.
// The lobby and game server include MapMetadata.h instead.
#pragma once

#include "MapMetadata.h"

/// Full map conversion pipeline.
class MapProcessor : public MapMetadataDb {
public:
    void ScanAndProcess(const std::string& mapsDir, const std::string& dataDir, sqlite3* db);

private:
    bool ReadMapInfo(const std::string& mapDir, MapMetadata& meta);
    bool ReadSMFHeader(MapMetadata& meta);
    bool ExtractBinaryData(const MapMetadata& meta);
    bool ExtractMinimapWebP(const MapMetadata& meta);
    bool ExtractFeatures(MapMetadata& meta);
    bool ExtractDecalTextures(MapMetadata& meta);
    void EnumerateWidgets(MapMetadata& meta);
    void ExtractRegions(const MapMetadata& meta);
    bool ProcessMap(MapMetadata& meta);
};
