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

    /// True when no file under the source map dir is newer than the map's
    /// `.processed-stamp` (written at the end of processing). A regenerated
    /// SMF/SMT/mapinfo/featureplacer config bumps a source mtime and makes
    /// this false, so mapconverter reprocesses without --force. A missing
    /// stamp (legacy processed dir) counts as current.
    static bool ProcessedOutputCurrent(const std::string& srcDir, const std::string& stampPath);

private:
    bool ReadMapInfo(const std::string& mapDir, MapMetadata& meta);
    bool ReadSMFHeader(MapMetadata& meta);
    bool ExtractBinaryData(const MapMetadata& meta);
    bool ExtractMinimapWebP(const MapMetadata& meta);
    bool ExtractFeatures(MapMetadata& meta);
    bool ExtractDecalTextures(MapMetadata& meta);
    /// The map-space ground albedo (PLAN-maps §2n). Runs before
    /// ExtractBinaryData, which skips the SMT tile dictionary for a map that
    /// ships one.
    bool ExtractGroundTexture(MapMetadata& meta);
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
