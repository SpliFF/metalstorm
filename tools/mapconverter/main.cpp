// mapconverter — preprocess Spring maps for spring-web.
//
// Copies a map's source tree into data/maps/<id>/, then runs all
// conversion steps (SMF extraction, minimap WebP, feature model
// conversion, decal texture conversion, widget enumeration) and
// writes metadata to SQLite.
//
// After this tool has run, the lobby just reads pre-populated data/
// and SQLite metadata — no conversion code needed at runtime.
//
// Usage:
//   mapconverter [options] <map-dir>          # process one map
//   mapconverter [options] --all <maps-dir>   # process all maps under a directory
//
// The tool is idempotent: maps whose format version matches and whose
// heightmap.bin already exists are skipped unless --force is passed.

#include "Server/MapProcessor.h"
#include "System/SpringLog/SpringLog.h"
#include "System/SpringLog/SpringLogNet.h"

#include <sqlite3.h>
#include <filesystem>
#include <string>

#define LOG_SECTION "map-convert"

namespace fs = std::filesystem;

namespace {

std::string ToLower(std::string s) {
    for (auto& c : s)
        c = static_cast<char>(std::tolower(static_cast<unsigned char>(c)));
    return s;
}

/// Recursively copy `src` into `dst`, skipping files that already exist
/// and are newer than the source (so converted outputs aren't clobbered).
/// Creates `dst` if it doesn't exist.
void CopySourceTree(const fs::path& src, const fs::path& dst) {
    std::error_code ec;
    fs::create_directories(dst, ec);

    for (const auto& entry : fs::recursive_directory_iterator(src)) {
        const auto rel = fs::relative(entry.path(), src, ec);
        const auto target = dst / rel;

        if (entry.is_directory()) {
            fs::create_directories(target, ec);
            continue;
        }

        if (!entry.is_regular_file()) continue;

        // Skip if the target is newer (it's a converted output or
        // already copied and unchanged). Copy if missing or stale.
        if (fs::exists(target)) {
            auto srcTime = fs::last_write_time(entry.path(), ec);
            auto dstTime = fs::last_write_time(target, ec);
            if (!ec && dstTime >= srcTime) continue;
        }

        fs::copy_file(entry.path(), target,
                       fs::copy_options::overwrite_existing, ec);
        if (ec) {
            SLOG(SPRING_LOG_WARNING, "copy failed: %s -> %s: %s",
                entry.path().string().c_str(), target.string().c_str(),
                ec.message().c_str());
        }
    }
}

/// Process a single map: copy source tree to data/, run conversion,
/// store metadata in SQLite.
bool ProcessOneMap(const fs::path& mapDir, const std::string& dataDir,
                   sqlite3* db, bool force) {
    const std::string mapId = ToLower(mapDir.filename().string());
    const std::string processedDir = dataDir + "/maps/" + mapId;

    MapProcessor proc;

    // Check if already up-to-date (unless --force). A regenerated source
    // (newer than the processed dir's .processed-stamp) reprocesses
    // automatically — no --force needed after tools/mapgen runs.
    if (!force) {
        MapMetadata existing = proc.GetMap(db, mapId);
        bool filesExist = fs::exists(processedDir + "/heightmap.bin");
        bool sourceCurrent = MapProcessor::ProcessedOutputCurrent(
            mapDir.string(), processedDir + "/.processed-stamp");
        if (existing.formatVersion >= MAP_FORMAT_VERSION && filesExist && sourceCurrent) {
            SLOG(SPRING_LOG_DEBUG, "%s: up to date (v%d)",
                mapId.c_str(), existing.formatVersion);
            return true;
        }
    } else {
        // Delete existing SQLite entry so ScanAndProcess's internal
        // version check doesn't skip this map.
        sqlite3_stmt* stmt = nullptr;
        sqlite3_prepare_v2(db,
            "DELETE FROM maps WHERE id = ?", -1, &stmt, nullptr);
        if (stmt) {
            sqlite3_bind_text(stmt, 1, mapId.c_str(), -1, SQLITE_TRANSIENT);
            sqlite3_step(stmt);
            sqlite3_finalize(stmt);
        }
    }

    SLOG(SPRING_LOG_NOTICE, "processing map '%s' at %s",
        mapId.c_str(), mapDir.string().c_str());

    // Copy source tree to data/ so the lobby only needs data/
    SLOG(SPRING_LOG_INFO, "copying source tree -> %s", processedDir.c_str());
    CopySourceTree(mapDir, processedDir);

    // ScanAndProcess iterates subdirs of a maps directory and
    // processes any that need it. We point it at data/maps/ (which
    // now contains our copied source); other maps are skipped as
    // up-to-date.
    proc.ScanAndProcess(dataDir + "/maps", dataDir, db);

    // Verify it worked
    MapMetadata result = proc.GetMap(db, mapId);
    if (result.id.empty()) {
        SLOG(SPRING_LOG_ERROR, "%s: processing failed (no metadata in SQLite)",
            mapId.c_str());
        return false;
    }

    SLOG(SPRING_LOG_NOTICE, "%s: done (%d features, %d start positions)",
        mapId.c_str(), static_cast<int>(result.features.size()),
        static_cast<int>(result.startPositions.size()));
    return true;
}

void PrintUsage(const char* argv0) {
    SLOG(SPRING_LOG_NOTICE,
        "preprocess Spring maps for spring-web.\n"
        "\n"
        "usage:\n"
        "  %s [options] <map-dir>            process one map\n"
        "  %s [options] --all <maps-dir>     process all maps under a directory\n"
        "\n"
        "  <map-dir>    path to a single map, e.g. content/maps/wanderlust2.1\n"
        "  <maps-dir>   path to a directory of maps, e.g. content/maps\n"
        "\n"
        "options:\n"
        "  --data-dir D     Output data directory (default: data).\n"
        "  --db D           SQLite database path (default: data/spring-server.db).\n"
        "  --force          Reprocess even if format version matches.\n"
        "  --log-server U   Send logs to a springlog server.\n"
        "  --log-level L    Set minimum log level (debug/info/notice/warning/error).\n"
        "\n"
        "Each map is idempotent: re-running on a processed map is a no-op\n"
        "unless --force is passed or MAP_FORMAT_VERSION has incremented.",
        argv0, argv0);
}

} // namespace

int main(int argc, char* argv[]) {
    springlog_init("mapconverter", SPRING_LOG_OUTPUT_CONSOLE);

    std::string mapDirArg;
    std::string dataDir = "data";
    std::string dbPath;
    std::string logServerUrl;
    bool force = false;
    bool allMode = false;

    for (int i = 1; i < argc; ++i) {
        const std::string arg = argv[i];
        if (arg == "--force") force = true;
        else if (arg == "--all") allMode = true;
        else if (arg == "--data-dir" && i + 1 < argc) dataDir = argv[++i];
        else if (arg == "--db" && i + 1 < argc) dbPath = argv[++i];
        else if (arg == "--log-server" && i + 1 < argc) logServerUrl = argv[++i];
        else if (arg == "--log-level" && i + 1 < argc) {
            const std::string lvl = argv[++i];
            if (lvl == "debug")        springlog_set_min_level(SPRING_LOG_DEBUG);
            else if (lvl == "info")    springlog_set_min_level(SPRING_LOG_INFO);
            else if (lvl == "notice")  springlog_set_min_level(SPRING_LOG_NOTICE);
            else if (lvl == "warning") springlog_set_min_level(SPRING_LOG_WARNING);
            else if (lvl == "error")   springlog_set_min_level(SPRING_LOG_ERROR);
        }
        else if (arg == "-h" || arg == "--help") {
            PrintUsage(argv[0]);
            springlog_shutdown();
            return 0;
        }
        else if (!arg.empty() && arg[0] == '-') {
            SLOG(SPRING_LOG_ERROR, "unknown option: %s", arg.c_str());
            PrintUsage(argv[0]);
            springlog_shutdown();
            return 2;
        }
        else mapDirArg = arg;
    }

    if (!logServerUrl.empty()) {
        springlog_net_init(logServerUrl.c_str(), "");
    }

    if (mapDirArg.empty()) {
        PrintUsage(argv[0]);
        springlog_shutdown();
        return 2;
    }

    if (dbPath.empty())
        dbPath = dataDir + "/spring-server.db";

    const fs::path inputDir = fs::absolute(mapDirArg);
    if (!fs::exists(inputDir) || !fs::is_directory(inputDir)) {
        SLOG(SPRING_LOG_ERROR, "not a directory: %s", inputDir.string().c_str());
        springlog_shutdown();
        return 1;
    }

    // Ensure data directory exists
    std::error_code ec;
    fs::create_directories(dataDir + "/maps", ec);

    // Open SQLite
    sqlite3* db = nullptr;
    if (sqlite3_open(dbPath.c_str(), &db) != SQLITE_OK) {
        SLOG(SPRING_LOG_ERROR, "failed to open database: %s", dbPath.c_str());
        springlog_shutdown();
        return 1;
    }

    int failed = 0;

    if (allMode) {
        // Process all subdirectories under the given maps directory.
        // Copy each source tree to data/maps/ then process.
        SLOG(SPRING_LOG_NOTICE, "scanning %s for maps...",
            inputDir.string().c_str());
        int total = 0;
        for (auto& entry : fs::directory_iterator(inputDir)) {
            if (!entry.is_directory()) continue;
            total++;
            if (!ProcessOneMap(entry.path(), dataDir, db, force))
                failed++;
        }
        SLOG(SPRING_LOG_NOTICE, "%d map(s) scanned, %d failed", total, failed);
    } else {
        // Single map mode
        if (!ProcessOneMap(inputDir, dataDir, db, force))
            failed = 1;
    }

    sqlite3_close(db);
    SLOG(SPRING_LOG_NOTICE, "done (%d failures)", failed);
    springlog_shutdown();
    return failed == 0 ? 0 : 1;
}
