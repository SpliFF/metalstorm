// MapProcessor — SMF/SMT → KTX2 + SQLite metadata pipeline.

#include "MapProcessor.h"
#include <sqlite3.h>
#include <cstdio>
#include <cstring>
#include <filesystem>
#include <fstream>

namespace fs = std::filesystem;

// KTX2 constants
static const uint8_t KTX2_MAGIC[12] = {
    0xAB, 0x4B, 0x54, 0x58, 0x20, 0x32, 0x30, 0xBB, 0x0D, 0x0A, 0x1A, 0x0A
};
constexpr uint32_t VK_FORMAT_BC1_RGB_UNORM_BLOCK = 131;

// SMF constants
constexpr int SQUARE_SIZE = 8;
constexpr int TILE_PIXELS = 32;
constexpr int DXT1_BLOCK_SIZE = 8;     // bytes per 4x4 block
constexpr int BLOCKS_PER_TILE = (32/4) * (32/4); // 64 blocks per 32x32 tile
constexpr int TILE_MIP0_SIZE = BLOCKS_PER_TILE * DXT1_BLOCK_SIZE; // 512 bytes
constexpr int SMALL_TILE_SIZE = 680;   // 512 + 128 + 32 + 8 (4 mip levels)

// BC1 data size for a given pixel dimension
static int bc1Size(int w, int h) {
    int bw = (w + 3) / 4;
    int bh = (h + 3) / 4;
    return bw * bh * DXT1_BLOCK_SIZE;
}

void MapProcessor::EnsureTable(sqlite3* db) {
    sqlite3_exec(db, R"(
        CREATE TABLE IF NOT EXISTS maps (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            smf_path TEXT,
            smt_path TEXT,
            mapx INTEGER, mapy INTEGER,
            width_elmos INTEGER, height_elmos INTEGER,
            min_height REAL, max_height REAL,
            num_tiles INTEGER,
            tiles_x INTEGER, tiles_z INTEGER,
            format_version INTEGER,
            processed_dir TEXT
        );
    )", nullptr, nullptr, nullptr);
}

void MapProcessor::StoreMetadata(sqlite3* db, const MapMetadata& m) {
    sqlite3_stmt* stmt;
    sqlite3_prepare_v2(db, R"(
        INSERT OR REPLACE INTO maps
        (id, name, smf_path, smt_path, mapx, mapy, width_elmos, height_elmos,
         min_height, max_height, num_tiles, tiles_x, tiles_z, format_version, processed_dir)
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

bool MapProcessor::ReadMapHeaders(const std::string& mapDir, MapMetadata& meta) {
    // Find .smf and .smt files
    for (auto& entry : fs::recursive_directory_iterator(mapDir)) {
        if (!entry.is_regular_file()) continue;
        auto ext = entry.path().extension().string();
        if (ext == ".smf" && meta.smfPath.empty()) meta.smfPath = entry.path().string();
        if (ext == ".smt" && meta.smtPath.empty()) meta.smtPath = entry.path().string();
    }
    if (meta.smfPath.empty()) return false;

    // Read SMF header
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

bool MapProcessor::WriteKTX2(const std::string& path, int width, int height,
                              const std::vector<uint8_t>& bc1Data, int mipLevels) {
    // Calculate mip sizes
    struct MipInfo { int w, h, size, offset; };
    std::vector<MipInfo> mips;
    int totalDataSize = 0;
    int mw = width, mh = height;
    int dataOffset = 0;
    for (int i = 0; i < mipLevels; i++) {
        int s = bc1Size(mw, mh);
        mips.push_back({mw, mh, s, dataOffset});
        dataOffset += s;
        totalDataSize += s;
        mw = std::max(1, mw / 2);
        mh = std::max(1, mh / 2);
    }

    // Header: 80 bytes + level index (24 bytes per level)
    int headerSize = 80;
    int levelIndexSize = mipLevels * 24;
    int dataStart = headerSize + levelIndexSize;
    // Align data start to 16 bytes
    dataStart = (dataStart + 15) & ~15;

    std::vector<uint8_t> file(dataStart + totalDataSize, 0);

    // Write header
    memcpy(&file[0], KTX2_MAGIC, 12);
    auto w32 = [&](int off, uint32_t v) { memcpy(&file[off], &v, 4); };
    auto w64 = [&](int off, uint64_t v) { memcpy(&file[off], &v, 8); };

    w32(12, VK_FORMAT_BC1_RGB_UNORM_BLOCK);
    w32(16, 1);                // typeSize
    w32(20, width);            // pixelWidth
    w32(24, height);           // pixelHeight
    w32(28, 0);                // pixelDepth
    w32(32, 0);                // layerCount
    w32(36, 1);                // faceCount
    w32(40, mipLevels);        // levelCount
    w32(44, 0);                // supercompressionScheme = none
    // DFD/KVD/SGD all zero (offsets 48-79 already zeroed)

    // Write level index
    int levelOffset = dataStart;
    for (int i = 0; i < mipLevels; i++) {
        int idxOff = headerSize + i * 24;
        w64(idxOff, static_cast<uint64_t>(levelOffset));
        w64(idxOff + 8, static_cast<uint64_t>(mips[i].size));
        w64(idxOff + 16, static_cast<uint64_t>(mips[i].size)); // uncompressed = compressed (no supercompression)
        levelOffset += mips[i].size;
    }

    // Write BC1 data
    if (static_cast<int>(bc1Data.size()) >= totalDataSize) {
        memcpy(&file[dataStart], bc1Data.data(), totalDataSize);
    }

    // Write to disk
    std::ofstream out(path, std::ios::binary);
    if (!out.is_open()) return false;
    out.write(reinterpret_cast<const char*>(file.data()), file.size());
    return out.good();
}

bool MapProcessor::ProcessMinimap(const MapMetadata& meta) {
    std::ifstream f(meta.smfPath, std::ios::binary);
    if (!f.is_open()) return false;

    // Read minimapPtr from header (offset 52 in SMF header)
    f.seekg(52);
    int minimapPtr = 0;
    f.read(reinterpret_cast<char*>(&minimapPtr), 4);
    if (minimapPtr <= 0) return false;

    // Minimap is 1024x1024 DXT1 with 9 mip levels
    // Mip 0: 1024x1024 = 524288 bytes (BC1)
    // Total: MINIMAP_SIZE = 699048
    f.seekg(minimapPtr);
    int mip0Size = bc1Size(1024, 1024); // 524288
    std::vector<uint8_t> data(mip0Size);
    f.read(reinterpret_cast<char*>(data.data()), mip0Size);
    if (!f.good()) return false;

    std::string outPath = meta.processedDir + "/minimap.ktx2";
    return WriteKTX2(outPath, 1024, 1024, data, 1);
}

bool MapProcessor::ProcessMapTexture(const MapMetadata& meta) {
    if (meta.smtPath.empty()) return false;

    // Read SMT header
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

    // Read all tile mip0 data from SMT (skip higher mips — 512 bytes per tile at mip0)
    std::vector<std::vector<uint8_t>> tileMip0(smtNumTiles);
    for (int i = 0; i < smtNumTiles; i++) {
        tileMip0[i].resize(TILE_MIP0_SIZE);
        smtFile.read(reinterpret_cast<char*>(tileMip0[i].data()), TILE_MIP0_SIZE);
        // Skip remaining mip levels (128 + 32 + 8 = 168 bytes)
        smtFile.seekg(SMALL_TILE_SIZE - TILE_MIP0_SIZE, std::ios::cur);
    }

    // Read tile index from SMF
    std::ifstream smfFile(meta.smfPath, std::ios::binary);
    if (!smfFile.is_open()) return false;

    // tilesPtr is at offset 56 in SMF header
    smfFile.seekg(56);
    int tilesPtr = 0;
    smfFile.read(reinterpret_cast<char*>(&tilesPtr), 4);
    smfFile.seekg(tilesPtr);

    // Read MapTileHeader
    int numTileFiles, totalTiles;
    smfFile.read(reinterpret_cast<char*>(&numTileFiles), 4);
    smfFile.read(reinterpret_cast<char*>(&totalTiles), 4);

    // Skip tile file entries (each: int numTiles + zero-terminated filename)
    for (int i = 0; i < numTileFiles; i++) {
        int n;
        smfFile.read(reinterpret_cast<char*>(&n), 4);
        char c;
        do { smfFile.read(&c, 1); } while (c != 0);
    }

    // Read tile index: int[tilesX * tilesZ]
    int numIndices = meta.tilesX * meta.tilesZ;
    std::vector<int> tileIndex(numIndices);
    smfFile.read(reinterpret_cast<char*>(tileIndex.data()), numIndices * 4);

    // Composite tiles into texture chunks.
    // Full texture: tilesX*32 x tilesZ*32 pixels.
    // We produce one KTX2 file per chunk (e.g. 8x8 tiles = 256x256 pixels per chunk).
    constexpr int CHUNK_TILES = 8; // 8x8 tiles = 256x256 pixel chunks
    int chunksX = (meta.tilesX + CHUNK_TILES - 1) / CHUNK_TILES;
    int chunksZ = (meta.tilesZ + CHUNK_TILES - 1) / CHUNK_TILES;

    std::fprintf(stderr, "[mapproc] compositing %dx%d tiles into %dx%d chunks (%d total)\n",
        meta.tilesX, meta.tilesZ, chunksX, chunksZ, chunksX * chunksZ);

    for (int cz = 0; cz < chunksZ; cz++) {
        for (int cx = 0; cx < chunksX; cx++) {
            int startTX = cx * CHUNK_TILES;
            int startTZ = cz * CHUNK_TILES;
            int endTX = std::min(startTX + CHUNK_TILES, meta.tilesX);
            int endTZ = std::min(startTZ + CHUNK_TILES, meta.tilesZ);
            int chunkW = (endTX - startTX) * TILE_PIXELS;
            int chunkH = (endTZ - startTZ) * TILE_PIXELS;

            // Compose BC1 data for this chunk.
            // Each tile is 32x32 = 8x8 blocks. Each block row is 8 blocks * 8 bytes = 64 bytes.
            // A chunk of 8x8 tiles is 256x256 = 64x64 blocks = 64*64*8 = 32768 bytes.
            int chunkBC1Size = bc1Size(chunkW, chunkH);
            std::vector<uint8_t> chunkData(chunkBC1Size, 0);

            int chunkBlocksW = chunkW / 4;

            for (int tz = startTZ; tz < endTZ; tz++) {
                for (int tx = startTX; tx < endTX; tx++) {
                    int tileIdx = tileIndex[tz * meta.tilesX + tx];
                    if (tileIdx < 0 || tileIdx >= smtNumTiles) continue;

                    const auto& tile = tileMip0[tileIdx];
                    int localTX = tx - startTX;
                    int localTZ = tz - startTZ;
                    int tileBlocksW = TILE_PIXELS / 4; // 8

                    // Copy 8x8 blocks from tile into the chunk at the right position
                    for (int bz = 0; bz < tileBlocksW; bz++) {
                        int srcOff = bz * tileBlocksW * DXT1_BLOCK_SIZE;
                        int dstBlockX = localTX * tileBlocksW;
                        int dstBlockZ = localTZ * tileBlocksW + bz;
                        int dstOff = (dstBlockZ * chunkBlocksW + dstBlockX) * DXT1_BLOCK_SIZE;
                        memcpy(&chunkData[dstOff], &tile[srcOff], tileBlocksW * DXT1_BLOCK_SIZE);
                    }
                }
            }

            char fname[64];
            snprintf(fname, sizeof(fname), "chunk_%d_%d.ktx2", cx, cz);
            std::string outPath = meta.processedDir + "/" + fname;
            WriteKTX2(outPath, chunkW, chunkH, chunkData, 1);
        }
    }

    // Write chunk layout metadata
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

        // Check if already processed at current version
        MapMetadata existing = GetMap(db, mapId);
        if (existing.formatVersion >= MAP_FORMAT_VERSION) {
            std::fprintf(stderr, "[mapproc] %s: up to date (v%d)\n", mapId.c_str(), existing.formatVersion);
            continue;
        }

        // Read headers
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
