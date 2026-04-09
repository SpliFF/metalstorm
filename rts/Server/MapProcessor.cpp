// MapProcessor — SMF/SMT → PNG/KTX2 via external tools (magick, basisu).

#include "MapProcessor.h"
#include <sqlite3.h>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <filesystem>
#include <fstream>

namespace fs = std::filesystem;

// SMF constants
constexpr int SQUARE_SIZE = 8;
constexpr int TILE_PIXELS = 32;
constexpr int DXT1_BLOCK_SIZE = 8;
constexpr int BLOCKS_PER_TILE = (32/4) * (32/4);
constexpr int TILE_MIP0_SIZE = BLOCKS_PER_TILE * DXT1_BLOCK_SIZE; // 512
constexpr int SMALL_TILE_SIZE = 680;

static int bc1Size(int w, int h) {
    return ((w+3)/4) * ((h+3)/4) * DXT1_BLOCK_SIZE;
}

/// Write a DDS file header for DXT1 data. This is a well-defined format
/// that ImageMagick and other tools can read reliably.
static bool writeDDS(const std::string& path, int width, int height,
                     const uint8_t* dxt1Data, int dataSize) {
    std::ofstream f(path, std::ios::binary);
    if (!f.is_open()) return false;

    uint8_t header[128] = {};
    memcpy(header, "DDS ", 4);
    auto w32 = [&](int off, uint32_t v) { memcpy(&header[off], &v, 4); };
    w32(4, 124);  // dwSize
    w32(8, 0x1 | 0x2 | 0x4 | 0x1000 | 0x80000); // flags
    w32(12, height);
    w32(16, width);
    w32(20, dataSize); // pitchOrLinearSize
    w32(76, 32); // pfSize
    w32(80, 0x4); // pfFlags: FOURCC
    memcpy(&header[84], "DXT1", 4);
    w32(108, 0x1000); // caps: TEXTURE

    f.write(reinterpret_cast<const char*>(header), 128);
    f.write(reinterpret_cast<const char*>(dxt1Data), dataSize);
    return f.good();
}

/// Run a shell command, return true if exit code 0.
static bool runCmd(const std::string& cmd) {
    int rc = std::system(cmd.c_str());
    return (rc == 0);
}

// ============================================================
// SQLite operations
// ============================================================

void MapProcessor::EnsureTable(sqlite3* db) {
    sqlite3_exec(db, R"(
        CREATE TABLE IF NOT EXISTS maps (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            smf_path TEXT, smt_path TEXT,
            mapx INTEGER, mapy INTEGER,
            width_elmos INTEGER, height_elmos INTEGER,
            min_height REAL, max_height REAL,
            num_tiles INTEGER, tiles_x INTEGER, tiles_z INTEGER,
            format_version INTEGER, processed_dir TEXT
        );
    )", nullptr, nullptr, nullptr);
}

void MapProcessor::StoreMetadata(sqlite3* db, const MapMetadata& m) {
    sqlite3_stmt* stmt;
    sqlite3_prepare_v2(db, R"(
        INSERT OR REPLACE INTO maps
        (id,name,smf_path,smt_path,mapx,mapy,width_elmos,height_elmos,
         min_height,max_height,num_tiles,tiles_x,tiles_z,format_version,processed_dir)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    )", -1, &stmt, nullptr);
    sqlite3_bind_text(stmt, 1, m.id.c_str(), -1, SQLITE_TRANSIENT);
    sqlite3_bind_text(stmt, 2, m.name.c_str(), -1, SQLITE_TRANSIENT);
    sqlite3_bind_text(stmt, 3, m.smfPath.c_str(), -1, SQLITE_TRANSIENT);
    sqlite3_bind_text(stmt, 4, m.smtPath.c_str(), -1, SQLITE_TRANSIENT);
    sqlite3_bind_int(stmt, 5, m.mapx);
    sqlite3_bind_int(stmt, 6, m.mapy);
    sqlite3_bind_int(stmt, 7, m.widthElmos);
    sqlite3_bind_int(stmt, 8, m.heightElmos);
    sqlite3_bind_double(stmt, 9, m.minHeight);
    sqlite3_bind_double(stmt, 10, m.maxHeight);
    sqlite3_bind_int(stmt, 11, m.numTiles);
    sqlite3_bind_int(stmt, 12, m.tilesX);
    sqlite3_bind_int(stmt, 13, m.tilesZ);
    sqlite3_bind_int(stmt, 14, m.formatVersion);
    sqlite3_bind_text(stmt, 15, m.processedDir.c_str(), -1, SQLITE_TRANSIENT);
    sqlite3_step(stmt);
    sqlite3_finalize(stmt);
}

std::vector<MapMetadata> MapProcessor::GetAllMaps(sqlite3* db) {
    EnsureTable(db);
    std::vector<MapMetadata> result;
    sqlite3_stmt* stmt;
    sqlite3_prepare_v2(db, "SELECT * FROM maps", -1, &stmt, nullptr);
    while (sqlite3_step(stmt) == SQLITE_ROW) {
        MapMetadata m;
        m.id = reinterpret_cast<const char*>(sqlite3_column_text(stmt, 0));
        m.name = reinterpret_cast<const char*>(sqlite3_column_text(stmt, 1));
        m.smfPath = reinterpret_cast<const char*>(sqlite3_column_text(stmt, 2));
        m.smtPath = reinterpret_cast<const char*>(sqlite3_column_text(stmt, 3));
        m.mapx = sqlite3_column_int(stmt, 4);
        m.mapy = sqlite3_column_int(stmt, 5);
        m.widthElmos = sqlite3_column_int(stmt, 6);
        m.heightElmos = sqlite3_column_int(stmt, 7);
        m.minHeight = static_cast<float>(sqlite3_column_double(stmt, 8));
        m.maxHeight = static_cast<float>(sqlite3_column_double(stmt, 9));
        m.numTiles = sqlite3_column_int(stmt, 10);
        m.tilesX = sqlite3_column_int(stmt, 11);
        m.tilesZ = sqlite3_column_int(stmt, 12);
        m.formatVersion = sqlite3_column_int(stmt, 13);
        m.processedDir = reinterpret_cast<const char*>(sqlite3_column_text(stmt, 14));
        result.push_back(std::move(m));
    }
    sqlite3_finalize(stmt);
    return result;
}

MapMetadata MapProcessor::GetMap(sqlite3* db, const std::string& mapId) {
    EnsureTable(db);
    MapMetadata m;
    sqlite3_stmt* stmt;
    sqlite3_prepare_v2(db, "SELECT * FROM maps WHERE id = ?", -1, &stmt, nullptr);
    sqlite3_bind_text(stmt, 1, mapId.c_str(), -1, SQLITE_TRANSIENT);
    if (sqlite3_step(stmt) == SQLITE_ROW) {
        m.id = reinterpret_cast<const char*>(sqlite3_column_text(stmt, 0));
        m.name = reinterpret_cast<const char*>(sqlite3_column_text(stmt, 1));
        m.mapx = sqlite3_column_int(stmt, 4);
        m.mapy = sqlite3_column_int(stmt, 5);
        m.widthElmos = sqlite3_column_int(stmt, 6);
        m.heightElmos = sqlite3_column_int(stmt, 7);
        m.minHeight = static_cast<float>(sqlite3_column_double(stmt, 8));
        m.maxHeight = static_cast<float>(sqlite3_column_double(stmt, 9));
        m.tilesX = sqlite3_column_int(stmt, 11);
        m.tilesZ = sqlite3_column_int(stmt, 12);
        m.formatVersion = sqlite3_column_int(stmt, 13);
        m.processedDir = reinterpret_cast<const char*>(sqlite3_column_text(stmt, 14));
    }
    sqlite3_finalize(stmt);
    return m;
}

// ============================================================
// Map reading
// ============================================================

bool MapProcessor::ReadMapHeaders(const std::string& mapDir, MapMetadata& meta) {
    for (auto& entry : fs::recursive_directory_iterator(mapDir)) {
        if (!entry.is_regular_file()) continue;
        auto ext = entry.path().extension().string();
        if (ext == ".smf" && meta.smfPath.empty()) meta.smfPath = entry.path().string();
        if (ext == ".smt" && meta.smtPath.empty()) meta.smtPath = entry.path().string();
    }
    if (meta.smfPath.empty()) return false;

    std::ifstream f(meta.smfPath, std::ios::binary);
    if (!f.is_open()) return false;

    char magic[16];
    f.read(magic, 16);
    int version, mapid;
    f.read(reinterpret_cast<char*>(&version), 4);
    f.read(reinterpret_cast<char*>(&mapid), 4);
    f.read(reinterpret_cast<char*>(&meta.mapx), 4);
    f.read(reinterpret_cast<char*>(&meta.mapy), 4);
    f.seekg(12, std::ios::cur); // squareSize, texelPerSquare, tilesize
    f.read(reinterpret_cast<char*>(&meta.minHeight), 4);
    f.read(reinterpret_cast<char*>(&meta.maxHeight), 4);

    meta.widthElmos = meta.mapx * SQUARE_SIZE;
    meta.heightElmos = meta.mapy * SQUARE_SIZE;
    meta.tilesX = meta.mapx / 4;
    meta.tilesZ = meta.mapy / 4;
    meta.numTiles = meta.tilesX * meta.tilesZ;
    return true;
}

// ============================================================
// Processing: minimap
// ============================================================

bool MapProcessor::ProcessMinimap(const MapMetadata& meta) {
    std::ifstream f(meta.smfPath, std::ios::binary);
    if (!f.is_open()) return false;

    f.seekg(52);
    int minimapPtr = 0;
    f.read(reinterpret_cast<char*>(&minimapPtr), 4);
    if (minimapPtr <= 0) return false;

    f.seekg(minimapPtr);
    int mip0Size = bc1Size(1024, 1024);
    std::vector<uint8_t> data(mip0Size);
    f.read(reinterpret_cast<char*>(data.data()), mip0Size);
    if (!f.good()) return false;

    // Write as DDS (reliable format that tools understand)
    std::string ddsPath = meta.processedDir + "/minimap.dds";
    if (!writeDDS(ddsPath, 1024, 1024, data.data(), mip0Size)) return false;

    // Convert DDS → PNG via ImageMagick
    std::string pngPath = meta.processedDir + "/minimap.png";
    if (!runCmd("magick \"" + ddsPath + "\" \"" + pngPath + "\" 2>/dev/null")) {
        std::fprintf(stderr, "[mapproc] WARNING: magick failed for minimap, trying convert\n");
        runCmd("convert \"" + ddsPath + "\" \"" + pngPath + "\" 2>/dev/null");
    }

    // Convert PNG → KTX2 via basisu
    std::string ktx2Path = meta.processedDir + "/minimap.ktx2";
    runCmd("basisu \"" + pngPath + "\" -output_file \"" + ktx2Path + "\" -ktx2 -q 200 2>/dev/null");

    // Keep the PNG as fallback (browsers load it natively)
    // Clean up DDS
    fs::remove(ddsPath);

    return fs::exists(pngPath);
}

// ============================================================
// Processing: map texture tiles
// ============================================================

bool MapProcessor::ProcessMapTexture(const MapMetadata& meta) {
    if (meta.smtPath.empty()) return false;

    std::ifstream smtFile(meta.smtPath, std::ios::binary);
    if (!smtFile.is_open()) return false;

    char smtMagic[16];
    smtFile.read(smtMagic, 16);
    int smtVersion, smtNumTiles, smtTileSize, smtCompression;
    smtFile.read(reinterpret_cast<char*>(&smtVersion), 4);
    smtFile.read(reinterpret_cast<char*>(&smtNumTiles), 4);
    smtFile.read(reinterpret_cast<char*>(&smtTileSize), 4);
    smtFile.read(reinterpret_cast<char*>(&smtCompression), 4);

    std::fprintf(stderr, "[mapproc] SMT: %d tiles, %dx%d, compression=%d\n",
        smtNumTiles, smtTileSize, smtTileSize, smtCompression);

    // Read all tile mip0 data
    std::vector<std::vector<uint8_t>> tileMip0(smtNumTiles);
    for (int i = 0; i < smtNumTiles; i++) {
        tileMip0[i].resize(TILE_MIP0_SIZE);
        smtFile.read(reinterpret_cast<char*>(tileMip0[i].data()), TILE_MIP0_SIZE);
        smtFile.seekg(SMALL_TILE_SIZE - TILE_MIP0_SIZE, std::ios::cur);
    }

    // Read tile index from SMF
    std::ifstream smfFile(meta.smfPath, std::ios::binary);
    if (!smfFile.is_open()) return false;

    smfFile.seekg(56);
    int tilesPtr = 0;
    smfFile.read(reinterpret_cast<char*>(&tilesPtr), 4);
    smfFile.seekg(tilesPtr);

    int numTileFiles, totalTiles;
    smfFile.read(reinterpret_cast<char*>(&numTileFiles), 4);
    smfFile.read(reinterpret_cast<char*>(&totalTiles), 4);

    for (int i = 0; i < numTileFiles; i++) {
        int n; smfFile.read(reinterpret_cast<char*>(&n), 4);
        char c; do { smfFile.read(&c, 1); } while (c != 0);
    }

    int numIndices = meta.tilesX * meta.tilesZ;
    std::vector<int> tileIndex(numIndices);
    smfFile.read(reinterpret_cast<char*>(tileIndex.data()), numIndices * 4);

    // Composite tiles into DDS chunk files, then convert via tools
    constexpr int CHUNK_TILES = 8;
    int chunksX = (meta.tilesX + CHUNK_TILES - 1) / CHUNK_TILES;
    int chunksZ = (meta.tilesZ + CHUNK_TILES - 1) / CHUNK_TILES;

    std::fprintf(stderr, "[mapproc] compositing %dx%d tiles into %dx%d chunks\n",
        meta.tilesX, meta.tilesZ, chunksX, chunksZ);

    for (int cz = 0; cz < chunksZ; cz++) {
        for (int cx = 0; cx < chunksX; cx++) {
            int startTX = cx * CHUNK_TILES;
            int startTZ = cz * CHUNK_TILES;
            int endTX = std::min(startTX + CHUNK_TILES, meta.tilesX);
            int endTZ = std::min(startTZ + CHUNK_TILES, meta.tilesZ);
            int chunkW = (endTX - startTX) * TILE_PIXELS;
            int chunkH = (endTZ - startTZ) * TILE_PIXELS;

            int chunkBC1Size = bc1Size(chunkW, chunkH);
            std::vector<uint8_t> chunkData(chunkBC1Size, 0);
            int chunkBlocksW = chunkW / 4;

            for (int tz = startTZ; tz < endTZ; tz++) {
                for (int tx = startTX; tx < endTX; tx++) {
                    int tIdx = tileIndex[tz * meta.tilesX + tx];
                    if (tIdx < 0 || tIdx >= smtNumTiles) continue;
                    const auto& tile = tileMip0[tIdx];
                    int localTX = tx - startTX;
                    int localTZ = tz - startTZ;
                    int tileBlocksW = TILE_PIXELS / 4;

                    for (int bz = 0; bz < tileBlocksW; bz++) {
                        int srcOff = bz * tileBlocksW * DXT1_BLOCK_SIZE;
                        int dstBlockX = localTX * tileBlocksW;
                        int dstBlockZ = localTZ * tileBlocksW + bz;
                        int dstOff = (dstBlockZ * chunkBlocksW + dstBlockX) * DXT1_BLOCK_SIZE;
                        memcpy(&chunkData[dstOff], &tile[srcOff], tileBlocksW * DXT1_BLOCK_SIZE);
                    }
                }
            }

            // Write chunk as DDS, convert to PNG via magick
            char fname[64];
            snprintf(fname, sizeof(fname), "chunk_%d_%d", cx, cz);
            std::string ddsPath = meta.processedDir + "/" + fname + ".dds";
            std::string pngPath = meta.processedDir + "/" + fname + ".png";

            writeDDS(ddsPath, chunkW, chunkH, chunkData.data(), chunkBC1Size);
            runCmd("magick \"" + ddsPath + "\" \"" + pngPath + "\" 2>/dev/null");
            fs::remove(ddsPath);
        }
    }

    // Write layout
    {
        char buf[256];
        snprintf(buf, sizeof(buf),
            "{\"chunksX\":%d,\"chunksZ\":%d,\"chunkTiles\":%d,\"chunkPixels\":%d,"
            "\"tilesX\":%d,\"tilesZ\":%d,\"tilePixels\":%d}",
            chunksX, chunksZ, CHUNK_TILES, CHUNK_TILES * TILE_PIXELS,
            meta.tilesX, meta.tilesZ, TILE_PIXELS);
        std::ofstream layoutFile(meta.processedDir + "/layout.json");
        layoutFile << buf;
    }

    return true;
}

// ============================================================
// Top-level processing
// ============================================================

bool MapProcessor::ProcessMap(const MapMetadata& meta) {
    fs::create_directories(meta.processedDir);

    bool ok = true;
    if (!ProcessMinimap(meta)) {
        std::fprintf(stderr, "[mapproc] WARNING: failed to process minimap for %s\n", meta.id.c_str());
        ok = false;
    }
    if (!ProcessMapTexture(meta)) {
        std::fprintf(stderr, "[mapproc] WARNING: failed to process textures for %s\n", meta.id.c_str());
        ok = false;
    }
    return ok;
}

void MapProcessor::ScanAndProcess(const std::string& mapsDir, const std::string& dataDir, sqlite3* db) {
    EnsureTable(db);
    if (!fs::is_directory(mapsDir)) {
        std::fprintf(stderr, "[mapproc] maps directory not found: %s\n", mapsDir.c_str());
        return;
    }

    for (auto& mapDir : fs::directory_iterator(mapsDir)) {
        if (!mapDir.is_directory()) continue;
        std::string mapId = mapDir.path().filename().string();

        MapMetadata existing = GetMap(db, mapId);
        if (existing.formatVersion >= MAP_FORMAT_VERSION) {
            std::fprintf(stderr, "[mapproc] %s: up to date (v%d)\n", mapId.c_str(), existing.formatVersion);
            continue;
        }

        MapMetadata meta;
        meta.id = mapId;
        meta.name = mapId;
        meta.processedDir = dataDir + "/maps/" + mapId;
        meta.formatVersion = MAP_FORMAT_VERSION;

        if (!ReadMapHeaders(mapDir.path().string(), meta)) {
            std::fprintf(stderr, "[mapproc] %s: no SMF file found, skipping\n", mapId.c_str());
            continue;
        }

        std::fprintf(stderr, "[mapproc] processing %s (%dx%d, %d tiles)...\n",
            mapId.c_str(), meta.mapx, meta.mapy, meta.numTiles);

        ProcessMap(meta);
        StoreMetadata(db, meta);
        std::fprintf(stderr, "[mapproc] %s: done\n", mapId.c_str());
    }
}
