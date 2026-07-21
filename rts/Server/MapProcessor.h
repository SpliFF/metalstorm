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
    /// Validates `mapdata/regions.lua` against the decoded heightmap (E1,
    /// PLAN-metalstorm-beta-map.md §4): region keys unique, polygons within
    /// map bounds, neighbor adjacency symmetric, and — the slope-consistency
    /// extension — a region tagged `infantry_only`/`heavy_restricted`/
    /// `corridor`/`choke` must have its dominant terrain slope band match
    /// what that tag requires. No-ops (returns true) if the map ships no
    /// mapdata/regions.lua. Validation-only: writes no output file and does
    /// not touch the maps SQLite table — see the field notes in
    /// PLAN-metalstorm-beta-map.md for why (a separate, more complete
    /// region-control lane's own ExtractRegions/regions.json exporter is
    /// not yet merged into this branch).
    bool ValidateRegions(MapMetadata& meta);
    bool ProcessMap(MapMetadata& meta);
};
