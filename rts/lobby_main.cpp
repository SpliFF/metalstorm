/**
 * spring-lobby — lightweight lobby server.
 *
 * Handles authentication, room management, and game server spawning
 * via HTTP REST endpoints. When a room starts, spawns a spring-server
 * process and returns the port to clients.
 *
 * No simulation code — just HTTP serving, SQLite, and process management.
 */

#include "Server/NetworkServer.h"
#include "Server/Database.h"
#include "Server/RoomManager.h"
#include "Server/MapProcessor.h"

#include "Server/AI/AIDiscovery.h"
#include "Server/GameDiscovery.h"
#include "Server/HttpAuth.h"
#include "Server/CacheControl.h"
#include "System/SpringLog/SpringLog.h"
#include "System/SpringLog/SpringLogSqlite.h"
#include <cctype>

#include <sqlite3.h>

#include <csignal>
#include <cstdio>
#include <cstdlib>
#include <atomic>
#include <chrono>
#include <filesystem>
#include <fstream>
#include <string>
#include <thread>
#include <unordered_map>

#include <sys/types.h>
#include <cstring>
#include <sys/wait.h>
#include <unistd.h>

#define LOG_SECTION "lobby"

static std::atomic<bool> keepRunning{true};
static std::atomic<bool> restartRequested{false};
static void signalHandler(int) { keepRunning.store(false); }
static void restartHandler(int) { restartRequested.store(true); keepRunning.store(false); }

// Saved for self-restart via execvp
static int savedArgc = 0;
static char** savedArgv = nullptr;

/// Tracks a spawned game server process.
struct GameServerInstance {
    uint32_t roomId = 0;
    int port = 0;
    pid_t pid = 0;
    std::string mapPath;
    std::string gamePath;
    enum State { Starting, Running, Ended, Crashed } state = Starting;
};

/// Find a free port by trying to bind briefly.
static int findFreePort(int base = 9100) {
    // Simple: increment from base, skip ports already in use
    // A proper implementation would use SO_REUSEADDR + bind + close
    static int nextPort = base;
    return nextPort++;
}

/// Spawn a spring-server process for a game room.
///
/// `playerRoster` is the list of human players the lobby accepted
/// into the room (non-spectators). Each one becomes a
/// `--player <username>:<team>:<posIdx>` argument pair; the sim
/// uses this to map authenticated WebSocket sessions back to
/// their lobby-assigned team.
///
/// `aiSlots` is the room's AI roster at game-start time. Each slot
/// becomes a `--ai <id>:<team>:<posIdx>` argument pair; the sim
/// runs its own AIDiscovery against the same game path and
/// resolves each id to a main.lua it can actually run.
///
/// Both rosters must have `startPos` populated (or -1 if the map
/// has no start positions at all). The lobby calls
/// AutoAssignStartPositions before this function to fill in any
/// -1 values, so a well-formed handoff always carries a concrete
/// slot assignment per team.
static GameServerInstance spawnGameServer(
    uint32_t roomId, const std::string& gamePath,
    const std::string& mapPath, const std::string& dbPath,
    const std::vector<RoomPlayer>& playerRoster,
    const std::vector<RoomAISlot>& aiSlots)
{
    GameServerInstance inst;
    inst.roomId = roomId;
    inst.port = findFreePort();
    inst.mapPath = mapPath;
    inst.gamePath = gamePath;

    // Build the command
    std::string serverBin = "./build/debug/spring-server";
    // Check if release build exists
    if (std::filesystem::exists("./build/release/spring-server"))
        serverBin = "./build/release/spring-server";

    // Create log directory
    std::filesystem::create_directories("data/logs");
    std::string logPath = "data/logs/game-" + std::to_string(roomId) + ".log";

    // Assemble the --player and --ai arguments outside the fork so
    // their string storage outlives the execvp call in the child.
    // Player spec format:  <username>:<team>:<posIdx>
    // AI spec format:      <id>:<team>:<posIdx>
    std::vector<std::string> playerArgStorage;
    playerArgStorage.reserve(playerRoster.size());
    for (const auto& p : playerRoster) {
        playerArgStorage.push_back(
            p.username + ":" +
            std::to_string(static_cast<int>(p.team)) + ":" +
            std::to_string(static_cast<int>(p.startPos)));
    }
    std::vector<std::string> aiArgStorage;
    aiArgStorage.reserve(aiSlots.size());
    for (const auto& slot : aiSlots) {
        aiArgStorage.push_back(
            slot.aiId + ":" +
            std::to_string(static_cast<int>(slot.team)) + ":" +
            std::to_string(static_cast<int>(slot.startPos)));
    }

    pid_t pid = fork();
    if (pid == 0) {
        // Child process — redirect stdout/stderr to log file
        FILE* logFile = fopen(logPath.c_str(), "w");
        if (logFile) {
            dup2(fileno(logFile), STDOUT_FILENO);
            dup2(fileno(logFile), STDERR_FILENO);
            fclose(logFile);
        }

        // Close all inherited file descriptors (except stdin/out/err).
        // uWebSockets sockets (our listen socket, all established WS client
        // connections) do not get FD_CLOEXEC by default on macOS, so without
        // this the child process ends up holding the parent's listen socket
        // + every active WebSocket. That leaks state into spring-server and
        // causes cross-talk between the lobby and game server.
        int maxFd = static_cast<int>(sysconf(_SC_OPEN_MAX));
        if (maxFd < 1024) maxFd = 1024;
        for (int fd = 3; fd < maxFd; fd++) {
            close(fd);
        }

        std::string portStr = std::to_string(inst.port);

        // Build argv: fixed args first, then one "--player <spec>"
        // pair per human slot, then one "--ai <spec>" pair per AI
        // slot. Player args come first so spring-server's own arg
        // parser doesn't care about ordering — it reads them into
        // separate vectors either way.
        std::vector<const char*> argv;
        argv.push_back(serverBin.c_str());
        argv.push_back("--port"); argv.push_back(portStr.c_str());
        argv.push_back("--game"); argv.push_back(gamePath.c_str());
        argv.push_back("--map");  argv.push_back(mapPath.c_str());
        argv.push_back("--db");   argv.push_back(dbPath.c_str());
        for (const auto& spec : playerArgStorage) {
            argv.push_back("--player");
            argv.push_back(spec.c_str());
        }
        for (const auto& spec : aiArgStorage) {
            argv.push_back("--ai");
            argv.push_back(spec.c_str());
        }
        argv.push_back(nullptr);

        execvp(serverBin.c_str(), const_cast<char* const*>(argv.data()));
        // If execvp returns, it failed
        fprintf(stderr, "ERROR: failed to exec game server: %s\n", serverBin.c_str());
        _exit(1);
    } else if (pid > 0) {
        inst.pid = pid;
        inst.state = GameServerInstance::Starting;
        SLOG(SPRING_LOG_NOTICE, "spawned game server pid=%d port=%d for room %u "
            "(%zu players, %zu AI)",
            pid, inst.port, roomId, playerRoster.size(), aiSlots.size());
    } else {
        SLOG(SPRING_LOG_ERROR, "fork failed");
        inst.state = GameServerInstance::Crashed;
    }

    return inst;
}

/// Check if a game server process is still running.
static bool isProcessAlive(pid_t pid) {
    if (pid <= 0) return false;
    int status;
    pid_t result = waitpid(pid, &status, WNOHANG);
    return (result == 0); // 0 means still running
}

int main(int argc, char* argv[])
{
    savedArgc = argc;
    savedArgv = argv;

    std::signal(SIGINT, signalHandler);
    std::signal(SIGTERM, signalHandler);
    std::signal(SIGHUP, restartHandler);
    // Ignore SIGPIPE. The lobby writes to a handful of things that
    // can get their peer closed under us: WebSocket client sockets,
    // stdout/stderr (captured by mprocs or similar), and — not yet
    // but soon — outbound connections to game servers as part of
    // the restart-recovery work. Default SIGPIPE action terminates
    // the process the first time any of those hit a closed peer,
    // which turns a transient write failure into a lobby crash.
    // Ignoring it means write() returns EPIPE instead, which every
    // reasonable caller already handles as "peer went away".
    std::signal(SIGPIPE, SIG_IGN);

    int port = 8011;
    std::string dbPath = "data/spring-server.db";
    std::string gamesDir = "content/games";
    std::string mapsDir = "content/maps";
    std::string logFile;
    int logLevel = SPRING_LOG_NOTICE;
    bool debugMode = false;

    for (int i = 1; i < argc; i++) {
        std::string arg = argv[i];
        if (arg == "--port" && i + 1 < argc) port = std::atoi(argv[++i]);
        else if (arg == "--db" && i + 1 < argc) dbPath = argv[++i];
        else if (arg == "--games-dir" && i + 1 < argc) gamesDir = argv[++i];
        else if (arg == "--maps" && i + 1 < argc) mapsDir = argv[++i];
        else if (arg == "--log-file" && i + 1 < argc) logFile = argv[++i];
        else if (arg == "--log-level" && i + 1 < argc) logLevel = std::atoi(argv[++i]);
        else if (arg == "--debug") { debugMode = true; logLevel = SPRING_LOG_DEBUG; }
        else if (arg == "--no-cache") { CacheControl::SetNoCache(true); }
        else if (arg == "--game" && i + 1 < argc) {
            // Back-compat: `--game <path>` is translated into
            // `--games-dir <parent>` so existing scripts that point
            // at a single game folder still work. The lobby now
            // always scans a root directory of games rather than
            // running one-game-at-a-time.
            const std::string single = argv[++i];
            namespace fs = std::filesystem;
            const fs::path p(single);
            if (p.has_parent_path())
                gamesDir = p.parent_path().string();
        }
    }

    // --- Logging ---
    uint32_t logOutputs = SPRING_LOG_OUTPUT_CONSOLE;
    if (!logFile.empty())
        logOutputs |= SPRING_LOG_OUTPUT_FILE;
    springlog_init("spring-lobby", logOutputs);
    springlog_set_min_level(logLevel);
    if (!logFile.empty())
        springlog_set_file(logFile.c_str());

    // Enable SQLite log sink so logs are visible in the debug console.
    // Uses the same debug.db as the log server and game servers.
    springlog_sqlite_init("data/debug.db");

    SLOG(SPRING_LOG_NOTICE, "starting on port %d...", port);

    // --- Database ---
    Database db;
    if (!db.Open(dbPath)) {
        SLOG(SPRING_LOG_ERROR, "failed to open database");
        springlog_shutdown();
        return 1;
    }

    // Clean up expired sessions on startup
    int cleaned = db.CleanExpiredSessions(86400); // 24h
    if (cleaned > 0) SLOG(SPRING_LOG_INFO, "cleaned %d expired session(s)", cleaned);

    // --- Rooms ---
    RoomManager rooms;

    // --- Map processing ---
    // Access the raw sqlite3* handle for MapMetadataDb
    // (Database wrapper doesn't expose it, so we open a second connection)
    sqlite3* mapDb = nullptr;
    sqlite3_open(dbPath.c_str(), &mapDb);

    // Create game_servers table for lobby restart resilience
    if (mapDb) {
        sqlite3_exec(mapDb,
            "CREATE TABLE IF NOT EXISTS game_servers ("
            "  room_id INTEGER PRIMARY KEY,"
            "  port INTEGER NOT NULL,"
            "  pid INTEGER NOT NULL,"
            "  map_path TEXT,"
            "  game_path TEXT,"
            "  started_at INTEGER DEFAULT (strftime('%s','now')),"
            "  state TEXT DEFAULT 'starting'"
            ")", nullptr, nullptr, nullptr);
        // Clean up stale entries from a previous lobby run
        sqlite3_exec(mapDb, "DELETE FROM game_servers", nullptr, nullptr, nullptr);
    }

    // Map processing is handled offline by tools/mapconverter.
    // The lobby reads pre-populated data/ + SQLite metadata.
    MapMetadataDb::EnsureTable(mapDb);

    // --- Game discovery ---
    // Enumerate every subdirectory of `gamesDir` that ships a
    // game.config.lua (or .json) via ConfigReader. This builds the
    // list shown in the lobby's "create game" dropdown and, for each
    // game, the set of AI plugins that game + the engine provide.
    // The result is immutable for the lifetime of the lobby process
    // — authors who add a new game must restart the lobby.
    const std::string enginePath = "content/engine";
    const std::vector<GameDiscovery::GameInfo> availableGames =
        GameDiscovery::Discover(gamesDir);

    // --- Per-game AI discovery ---
    // Game model conversion is handled offline by tools/gameconverter.
    // The lobby just discovers games and their AI plugins.
    std::unordered_map<std::string, std::string> gamePathsById;
    std::unordered_map<std::string, std::vector<AIDiscovery::AIInfo>> aisByGame;
    for (const auto& g : availableGames) {
        gamePathsById[g.id] = g.folderPath;
        aisByGame[g.id] = AIDiscovery::Discover(enginePath, g.folderPath);
    }

    // --- Game server instances ---
    std::unordered_map<uint32_t, GameServerInstance> gameServers; // roomId → instance

    // --- Network ---
    NetworkServer net;

    // Maps endpoint — full metadata from SQLite
    net.AddHttpGet("/api/maps", [mapDb](const std::string&) -> HttpResponse {
        MapMetadataDb db;
        auto maps = db.GetAllMaps(mapDb);
        std::string json = "[";
        bool first = true;
        for (const auto& m : maps) {
            if (!first) json += ",";
            first = false;

            // Start positions array
            std::string spJson = "[";
            for (size_t i = 0; i < m.startPositions.size(); i++) {
                if (i > 0) spJson += ",";
                char spBuf[64];
                snprintf(spBuf, sizeof(spBuf), "{\"x\":%.0f,\"z\":%.0f}",
                    m.startPositions[i].x, m.startPositions[i].z);
                spJson += spBuf;
            }
            spJson += "]";

            // Escape description for JSON (basic: replace " and newlines)
            std::string desc = m.description;
            for (size_t p = 0; (p = desc.find('"', p)) != std::string::npos; p += 2)
                desc.replace(p, 1, "\\\"");
            for (size_t p = 0; (p = desc.find('\n', p)) != std::string::npos; p += 2)
                desc.replace(p, 1, "\\n");

            char buf[1024];
            snprintf(buf, sizeof(buf),
                "{\"id\":\"%s\",\"name\":\"%s\",\"shortName\":\"%s\","
                "\"description\":\"%s\",\"author\":\"%s\",\"version\":\"%s\","
                "\"mapx\":%d,\"mapy\":%d,\"widthElmos\":%d,\"heightElmos\":%d,"
                "\"minHeight\":%.1f,\"maxHeight\":%.1f,"
                "\"gravity\":%.1f,\"tidalStrength\":%.1f,"
                "\"maxMetal\":%.2f,\"extractorRadius\":%.1f,"
                "\"tilesX\":%d,\"tilesZ\":%d,\"numTiles\":%d,"
                "\"maxPlayers\":%zu,\"startPositions\":%s,"
                "\"hasLuaGaia\":%s,"
                "\"minimapUrl\":\"/api/maps/data/%s/minimap.dxt1\"}",
                m.id.c_str(), m.name.c_str(), m.shortName.c_str(),
                desc.c_str(), m.author.c_str(), m.version.c_str(),
                m.mapx, m.mapy, m.widthElmos, m.heightElmos,
                m.minHeight, m.maxHeight,
                m.gravity, m.tidalStrength,
                m.maxMetal, m.extractorRadius,
                m.tilesX, m.tilesZ, m.numTiles,
                m.startPositions.size(), spJson.c_str(),
                m.hasLuaGaia ? "true" : "false",
                m.id.c_str());
            json += buf;
        }
        json += "]";
        std::vector<uint8_t> body(json.begin(), json.end());
        return {.contentType = "application/json", .body = std::move(body), .status = 200};
    });

    // /api/maps/source/* and /api/vfs/game/* are retired — use
    // /api/maps/data/* and /api/games/data/* for all content.
    // The offline converters (tools/mapconverter, tools/gameconverter)
    // copy source files + converted assets into data/.

    // Serve processed map files (DXT1 tiles, heightmap, splat textures, etc.)
    // These are static binary assets — safe to cache for long periods.
    // Also serves a dynamically generated metadata.json for each map,
    // containing all lightweight map info (dimensions, features, decals,
    // water, etc.) so the client can fetch map data via HTTP instead of
    // receiving it over the WebRTC data channel (which has a 256KB SCTP
    // message size limit).
    net.AddHttpGet("/api/maps/data/*", [mapDb](const std::string& url) -> HttpResponse {
        // URL: /api/maps/data/{mapId}/{filename}
        std::string rest = url.substr(std::string("/api/maps/data/").size());

        // Security: reject path traversal
        if (rest.find("..") != std::string::npos)
            return {.contentType = "text/plain", .body = {}, .status = 403};

        // Dynamic metadata.json endpoint — returns JSON with all
        // lightweight map info. Binary arrays (heightmap, tileindex,
        // typemap, metalmap) are fetched separately as .bin files.
        auto slashPos = rest.find('/');
        if (slashPos != std::string::npos) {
            std::string mapId = rest.substr(0, slashPos);
            std::string filename = rest.substr(slashPos + 1);
            if (filename == "metadata.json") {
                MapMetadataDb db;
                auto m = db.GetMap(mapDb, mapId);
                if (m.id.empty())
                    return {.contentType = "text/plain", .body = {}, .status = 404};

                // Build JSON metadata
                std::string json = "{";
                char buf[256];
                snprintf(buf, sizeof(buf),
                    "\"mapx\":%d,\"mapy\":%d,\"squareSize\":8,"
                    "\"minHeight\":%.6f,\"maxHeight\":%.6f,"
                    "\"tilesX\":%d,\"tilesZ\":%d,\"numTiles\":%d,\"tileSize\":32",
                    m.mapx, m.mapy, m.minHeight, m.maxHeight,
                    m.tilesX, m.tilesZ, m.numTiles);
                json += buf;

                // Start positions
                json += ",\"startPositions\":[";
                for (size_t i = 0; i < m.startPositions.size(); i++) {
                    if (i > 0) json += ",";
                    snprintf(buf, sizeof(buf), "{\"x\":%.1f,\"z\":%.1f}",
                        m.startPositions[i].x, m.startPositions[i].z);
                    json += buf;
                }
                json += "]";

                // Feature types
                json += ",\"featureTypes\":[";
                for (size_t i = 0; i < m.featureTypes.size(); i++) {
                    if (i > 0) json += ",";
                    json += "\"" + HttpAuth::JsonEscape(m.featureTypes[i]) + "\"";
                }
                json += "]";

                // Features
                json += ",\"features\":[";
                for (size_t i = 0; i < m.features.size(); i++) {
                    if (i > 0) json += ",";
                    const auto& f = m.features[i];
                    snprintf(buf, sizeof(buf),
                        "{\"typeIndex\":%d,\"x\":%.2f,\"y\":%.2f,\"z\":%.2f,"
                        "\"rotation\":%.4f,\"relativeSize\":%.4f}",
                        f.featureType, f.x, f.y, f.z, f.rotation, f.relativeSize);
                    json += buf;
                }
                json += "]";

                // Feature defs
                json += ",\"featureDefs\":[";
                for (size_t i = 0; i < m.featureDefs.size(); i++) {
                    if (i > 0) json += ",";
                    const auto& d = m.featureDefs[i];
                    std::string modelUrl = d.modelFile.empty()
                        ? "" : "/api/maps/data/" + m.id + "/features/" + d.modelFile;
                    std::string texUrl = d.textureFile.empty()
                        ? "" : "/api/maps/data/" + m.id + "/features/" + d.textureFile;
                    json += "{\"name\":\"" + HttpAuth::JsonEscape(d.name) + "\""
                        + ",\"modelUrl\":\"" + HttpAuth::JsonEscape(modelUrl) + "\""
                        + ",\"textureUrl\":\"" + HttpAuth::JsonEscape(texUrl) + "\""
                        + ",\"footprintX\":" + std::to_string(d.footprintX)
                        + ",\"footprintZ\":" + std::to_string(d.footprintZ);
                    snprintf(buf, sizeof(buf),
                        ",\"height\":%.2f,\"radius\":%.2f,"
                        "\"blocking\":%s,\"reclaimable\":%s,"
                        "\"metal\":%d,\"energy\":%d,\"damage\":%d}",
                        d.height, d.radius,
                        d.blocking ? "true" : "false",
                        d.reclaimable ? "true" : "false",
                        d.metal, d.energy, d.damage);
                    json += buf;
                }
                json += "]";

                // Decals
                auto decalUrl = [&](const std::string& f) -> std::string {
                    if (f.empty()) return "";
                    return "/api/maps/data/" + m.id + "/" + f;
                };
                json += ",\"decals\":{"
                    "\"detailTex\":\"" + HttpAuth::JsonEscape(decalUrl(m.decals.detailTex)) + "\""
                    + ",\"specularTex\":\"" + HttpAuth::JsonEscape(decalUrl(m.decals.specularTex)) + "\""
                    + ",\"splatDetailTex\":\"" + HttpAuth::JsonEscape(decalUrl(m.decals.splatDetailTex)) + "\""
                    + ",\"splatDistrTex\":\"" + HttpAuth::JsonEscape(decalUrl(m.decals.splatDistrTex)) + "\""
                    + ",\"splatNormal\":["
                    + "\"" + HttpAuth::JsonEscape(decalUrl(m.decals.splatDetailNormalTex[0])) + "\""
                    + ",\"" + HttpAuth::JsonEscape(decalUrl(m.decals.splatDetailNormalTex[1])) + "\""
                    + ",\"" + HttpAuth::JsonEscape(decalUrl(m.decals.splatDetailNormalTex[2])) + "\""
                    + ",\"" + HttpAuth::JsonEscape(decalUrl(m.decals.splatDetailNormalTex[3])) + "\""
                    + "]"
                    + ",\"detailNormalTex\":\"" + HttpAuth::JsonEscape(decalUrl(m.decals.detailNormalTex)) + "\"";
                snprintf(buf, sizeof(buf),
                    ",\"splatScales\":[%.6f,%.6f,%.6f,%.6f]"
                    ",\"splatMults\":[%.6f,%.6f,%.6f,%.6f]}",
                    m.decals.splatScales[0], m.decals.splatScales[1],
                    m.decals.splatScales[2], m.decals.splatScales[3],
                    m.decals.splatMults[0], m.decals.splatMults[1],
                    m.decals.splatMults[2], m.decals.splatMults[3]);
                json += buf;

                // Water
                snprintf(buf, sizeof(buf),
                    ",\"water\":{"
                    "\"baseColor\":[%.6f,%.6f,%.6f]"
                    ",\"surfaceColor\":[%.6f,%.6f,%.6f]"
                    ",\"minColor\":[%.6f,%.6f,%.6f]"
                    ",\"surfaceAlpha\":%.6f"
                    ",\"damage\":%.6f"
                    ",\"voidWater\":%s}",
                    m.water.baseColor[0], m.water.baseColor[1], m.water.baseColor[2],
                    m.water.surfaceColor[0], m.water.surfaceColor[1], m.water.surfaceColor[2],
                    m.water.minColor[0], m.water.minColor[1], m.water.minColor[2],
                    m.water.surfaceAlpha, m.water.damage,
                    m.water.voidWater ? "true" : "false");
                json += buf;

                // hasLuaGaia
                json += std::string(",\"hasLuaGaia\":") + (m.hasLuaGaia ? "true" : "false");

                // Widgets
                json += ",\"widgets\":[";
                for (size_t i = 0; i < m.widgets.size(); i++) {
                    if (i > 0) json += ",";
                    json += "\"" + HttpAuth::JsonEscape(m.widgets[i]) + "\"";
                }
                json += "]";

                // URLs for binary data and source assets
                json += ",\"minimapUrl\":\"/api/maps/data/" + m.id + "/minimap.dxt1\"";
                json += ",\"tilesUrl\":\"/api/maps/data/" + m.id + "/tiles.dxt1\"";
                json += ",\"mapDataUrl\":\"/api/maps/data/" + m.id + "\"";
                json += ",\"mapSourceUrl\":\"/api/maps/data/" + m.id + "\"";

                json += "}";

                std::vector<uint8_t> body(json.begin(), json.end());
                return {
                    .contentType = "application/json",
                    .body = std::move(body),
                    .status = 200,
                    .cacheControl = CacheControl::StaticAssetHeader(),
                };
            }
        }

        // Serve the file from disk
        std::string filePath = "data/maps/" + rest;
        namespace fs = std::filesystem;
        if (!fs::exists(filePath) || !fs::is_regular_file(filePath))
            return {.contentType = "text/plain", .body = {}, .status = 404};

        std::ifstream f(filePath, std::ios::binary);
        std::vector<uint8_t> data((std::istreambuf_iterator<char>(f)),
                                   std::istreambuf_iterator<char>());

        // Content type from extension
        std::string ext = fs::path(filePath).extension().string();
        std::string ct = "application/octet-stream";
        if (ext == ".lua") ct = "text/x-lua; charset=utf-8";
        else if (ext == ".json") ct = "application/json";
        else if (ext == ".png") ct = "image/png";
        else if (ext == ".jpg" || ext == ".jpeg") ct = "image/jpeg";
        else if (ext == ".webp") ct = "image/webp";
        else if (ext == ".ktx2") ct = "image/ktx2";
        else if (ext == ".tga") ct = "image/x-tga";
        else if (ext == ".dds") ct = "image/vnd-ms.dds";
        else if (ext == ".glb") ct = "model/gltf-binary";
        else if (ext == ".gltf") ct = "model/gltf+json";
        else if (ext == ".html") ct = "text/html; charset=utf-8";
        else if (ext == ".css") ct = "text/css; charset=utf-8";
        else if (ext == ".js") ct = "application/javascript; charset=utf-8";
        else if (ext == ".txt") ct = "text/plain; charset=utf-8";

        return {
            .contentType = ct,
            .body = std::move(data),
            .status = 200,
            .cacheControl = CacheControl::StaticAssetHeader(),
        };
    });

    // Serve processed game files (unit models, textures, etc.)
    // Parallel to /api/maps/data/* but for game content preprocessed
    // by GameProcessor into data/games/<gameId>/models/.
    // Serve all game content from data/games/. The offline converter
    // (tools/gameconverter) populates this with source + converted files.
    net.AddHttpGet("/api/games/data/*", [](const std::string& url) -> HttpResponse {
        std::string rest = url.substr(std::string("/api/games/data/").size());
        if (rest.find("..") != std::string::npos)
            return {.contentType = "text/plain", .body = {}, .status = 403};

        std::string filePath = "data/games/" + rest;
        namespace fs = std::filesystem;
        if (!fs::exists(filePath) || !fs::is_regular_file(filePath))
            return {.contentType = "text/plain", .body = {}, .status = 404};

        std::ifstream f(filePath, std::ios::binary);
        std::vector<uint8_t> data((std::istreambuf_iterator<char>(f)),
                                   std::istreambuf_iterator<char>());

        std::string ext = fs::path(filePath).extension().string();
        std::string ct = "application/octet-stream";
        if (ext == ".lua") ct = "text/x-lua; charset=utf-8";
        else if (ext == ".json") ct = "application/json";
        else if (ext == ".png") ct = "image/png";
        else if (ext == ".jpg" || ext == ".jpeg") ct = "image/jpeg";
        else if (ext == ".glb") ct = "model/gltf-binary";
        else if (ext == ".gltf") ct = "model/gltf+json";
        else if (ext == ".html") ct = "text/html; charset=utf-8";
        else if (ext == ".css") ct = "text/css; charset=utf-8";
        else if (ext == ".js") ct = "application/javascript; charset=utf-8";

        return {
            .contentType = ct,
            .body = std::move(data),
            .status = 200,
            .cacheControl = CacheControl::StaticAssetHeader(),
        };
    });

    // Map thumbnail endpoint. Serves the preprocessed small PNG
    // (aspect-correct, max 256px on the longer axis) that
    // mapconverter wrote to data/maps/<id>/thumbnail.png at preprocess
    // time. The full-size minimap.png sits next to it for consumers
    // that want the larger version via the generic /api/maps/data/*.
    //
    // The shipped-*minimap.png/jpg fallback is preserved for maps
    // where preprocess failed — most modern maps never hit it.
    net.AddHttpGet("/api/maps/thumb/*", [&mapsDir](const std::string& url) -> HttpResponse {
        const std::string mapId = url.substr(std::string("/api/maps/thumb/").size());
        if (mapId.find("..") != std::string::npos)
            return {.contentType = "text/plain", .body = {}, .status = 403};

        namespace fs = std::filesystem;

        // Primary: preprocessed small PNG (256px on the longer axis)
        const fs::path processedPng =
            fs::path("data") / "maps" / mapId / "thumbnail.png";
        if (fs::is_regular_file(processedPng)) {
            std::ifstream f(processedPng, std::ios::binary);
            std::vector<uint8_t> data(
                (std::istreambuf_iterator<char>(f)),
                std::istreambuf_iterator<char>());
            return {
                .contentType = "image/png",
                .body = std::move(data),
                .status = 200,
                .cacheControl = CacheControl::StaticAssetHeader(),
            };
        }
        // Fallback: legacy WebP from previous mapconverter runs
        const fs::path processedWebp =
            fs::path("data") / "maps" / mapId / "thumbnail.webp";
        if (fs::is_regular_file(processedWebp)) {
            std::ifstream f(processedWebp, std::ios::binary);
            std::vector<uint8_t> data(
                (std::istreambuf_iterator<char>(f)),
                std::istreambuf_iterator<char>());
            return {
                .contentType = "image/webp",
                .body = std::move(data),
                .status = 200,
                .cacheControl = CacheControl::StaticAssetHeader(),
            };
        }

        // Fallback: a *minimap.png/jpg shipped alongside the SMF by
        // the map author. Kept for resilience against preprocess
        // failure; most modern maps will never hit this path.
        fs::path mapDir = fs::path(mapsDir) / mapId;
        if (fs::is_directory(mapDir)) {
            for (auto& entry : fs::recursive_directory_iterator(mapDir)) {
                if (!entry.is_regular_file()) continue;
                const auto fname = entry.path().filename().string();
                const auto ext = entry.path().extension().string();
                if (fname.find("minimap") != std::string::npos &&
                    (ext == ".png" || ext == ".jpg")) {
                    std::ifstream f(entry.path(), std::ios::binary);
                    std::vector<uint8_t> data(
                        (std::istreambuf_iterator<char>(f)),
                        std::istreambuf_iterator<char>());
                    return {
                        .contentType = (ext == ".png") ? "image/png" : "image/jpeg",
                        .body = std::move(data),
                        .status = 200,
                        .cacheControl = CacheControl::StaticAssetHeader(),
                    };
                }
            }
        }
        return {.contentType = "text/plain", .body = {}, .status = 404};
    });

    // --- Process management API ---
    net.AddHttpGet("/api/processes", [&gameServers](const std::string&) -> HttpResponse {
        std::string json = "[";
        bool first = true;
        for (const auto& [roomId, inst] : gameServers) {
            if (!first) json += ",";
            first = false;
            const char* stateStr = "unknown";
            switch (inst.state) {
                case GameServerInstance::Starting: stateStr = "starting"; break;
                case GameServerInstance::Running:  stateStr = "running"; break;
                case GameServerInstance::Ended:    stateStr = "ended"; break;
                case GameServerInstance::Crashed:  stateStr = "crashed"; break;
            }
            char buf[256];
            snprintf(buf, sizeof(buf),
                R"({"room_id":%u,"port":%d,"pid":%d,"state":"%s","map":"%s","game":"%s"})",
                roomId, inst.port, (int)inst.pid, stateStr,
                inst.mapPath.c_str(), inst.gamePath.c_str());
            json += buf;
        }
        json += "]";
        return {.contentType = "application/json", .body = {json.begin(), json.end()}, .status = 200,
                .cacheControl = "no-cache"};
    });

    // --- HTTP auth endpoints ---
    HttpAuth::RegisterEndpoints(net, db);

    // Version endpoint — clients use this to get the build stamp for cache-busting
    net.AddHttpGet("/api/version", [](const std::string&) -> HttpResponse {
        std::string json = std::string("{\"engine\":\"springweb\"")
            + ",\"stamp\":\"" + CacheControl::BuildStamp() + "\""
            + ",\"no_cache\":" + (CacheControl::IsNoCache() ? "true" : "false") + "}";
        return {.contentType = "application/json",
                .body = {json.begin(), json.end()}, .status = 200,
                .cacheControl = CacheControl::DynamicHeader()};
    });

    // --- HTTP exec endpoint (for CLI/curl access to lobby commands) ---
    net.AddHttpPost("/api/exec", [&rooms, &gameServers, mapDb, &db](const std::string&, const std::string& body, const HttpRequestHeaders& headers) -> HttpResponse {
        // Validate auth token
        int64_t userId = HttpAuth::ValidateToken(db, headers.authorization);
        if (userId <= 0) {
            return HttpAuth::JsonResponse(401, R"({"error":"unauthorized — use POST /api/auth/login first"})");
        }

        std::string scope = HttpAuth::JsonField(body, "scope");
        std::string code = HttpAuth::JsonField(body, "code");
        bool success = true;
        std::string output;

        if (scope == "sql") {
            std::string upper = code;
            for (auto& c : upper) c = (char)toupper((unsigned char)c);
            bool rejected = false;
            for (const char* kw : {"INSERT", "UPDATE", "DELETE", "DROP", "ALTER", "CREATE"}) {
                if (upper.find(kw) != std::string::npos) { rejected = true; break; }
            }
            if (rejected) {
                output = "read-only: mutation queries not allowed";
                success = false;
            } else {
                char* errMsg = nullptr;
                auto callback = [](void* data, int ncols, char** vals, char** names) -> int {
                    auto* out = static_cast<std::string*>(data);
                    if (!out->empty()) *out += "\\n";
                    for (int i = 0; i < ncols; i++) {
                        if (i > 0) *out += " | ";
                        *out += std::string(names[i]) + "=" + (vals[i] ? vals[i] : "NULL");
                    }
                    return 0;
                };
                int rc = sqlite3_exec(mapDb, code.c_str(), callback, &output, &errMsg);
                if (rc != SQLITE_OK) {
                    output = errMsg ? errMsg : "unknown error";
                    if (errMsg) sqlite3_free(errMsg);
                    success = false;
                }
                if (output.empty()) output = "(no results)";
            }
        } else if (scope == "lobby") {
            if (code == "rooms") {
                auto allRooms = rooms.GetAllRooms();
                for (const auto* r : allRooms) {
                    if (!r) continue;
                    if (!output.empty()) output += "\\n";
                    output += "Room " + std::to_string(r->id) + ": " + r->name
                        + " (" + std::to_string(r->players.size()) + " players)";
                }
                if (output.empty()) output = "(no rooms)";
            } else if (code == "process list") {
                for (const auto& [rid, inst] : gameServers) {
                    if (!output.empty()) output += "\\n";
                    output += "Room " + std::to_string(rid)
                        + ": pid=" + std::to_string(inst.pid)
                        + " port=" + std::to_string(inst.port);
                }
                if (output.empty()) output = "(no game servers)";
            } else if (code == "restart") {
                output = "restarting lobby server...";
                restartRequested.store(true);
                keepRunning.store(false);
            } else {
                output = "unknown lobby command: " + code;
                success = false;
            }
        } else {
            output = "unknown scope (lobby handles: sql, lobby)";
            success = false;
        }

        std::string json = "{\"success\":" + std::string(success ? "true" : "false")
            + ",\"output\":\"" + HttpAuth::JsonEscape(output) + "\"}";
        return HttpAuth::JsonResponse(200, json);
    });

    // --- Room management HTTP endpoints ---
    // These mirror the WebSocket room commands for CLI/automation access.

    // Helper: get userId from auth header, return 0 + send 401 if invalid
    auto requireAuth = [&db](const HttpRequestHeaders& headers) -> int64_t {
        return HttpAuth::ValidateToken(db, headers.authorization);
    };

    // Helper: find a player's room by their userId
    auto findPlayerRoom = [&rooms](uint32_t userId) -> GameRoom* {
        // RoomManager doesn't have a FindRoomByUserId, so scan all rooms
        for (auto* room : rooms.GetAllRooms()) {
            if (!room) continue;
            if (room->FindPlayer(userId)) return room;
        }
        return nullptr;
    };

    // Helper: JSON-serialize a room for API responses
    auto roomToJson = [](const GameRoom* room) -> std::string {
        if (!room) return "null";
        std::string json = "{\"id\":" + std::to_string(room->id)
            + ",\"name\":\"" + HttpAuth::JsonEscape(room->name) + "\""
            + ",\"map\":\"" + HttpAuth::JsonEscape(room->mapName) + "\""
            + ",\"game\":\"" + HttpAuth::JsonEscape(room->gameName) + "\""
            + ",\"state\":" + std::to_string(static_cast<int>(room->state))
            + ",\"players\":[";
        bool first = true;
        for (const auto& p : room->players) {
            if (!first) json += ",";
            first = false;
            json += "{\"player_id\":" + std::to_string(p.playerId)
                + ",\"username\":\"" + HttpAuth::JsonEscape(p.username) + "\""
                + ",\"team\":" + std::to_string(p.team)
                + ",\"ready\":" + (p.ready ? "true" : "false")
                + ",\"is_host\":" + (p.isHost ? "true" : "false")
                + ",\"start_pos\":" + std::to_string(p.startPos) + "}";
        }
        json += "],\"ai_slots\":[";
        first = true;
        for (const auto& ai : room->aiSlots) {
            if (!first) json += ",";
            first = false;
            json += "{\"ai_id\":\"" + HttpAuth::JsonEscape(ai.aiId) + "\""
                + ",\"name\":\"" + HttpAuth::JsonEscape(ai.displayName) + "\""
                + ",\"team\":" + std::to_string(ai.team)
                + ",\"start_pos\":" + std::to_string(ai.startPos) + "}";
        }
        json += "]";
        if (room->gameServerPort > 0)
            json += ",\"game_server_port\":" + std::to_string(room->gameServerPort);
        json += "}";
        return json;
    };

    #define HTTP_ROOM_AUTH() \
        int64_t userId = requireAuth(headers); \
        if (userId <= 0) return HttpAuth::JsonResponse(401, R"({"error":"unauthorized"})");

    // POST /api/rooms — create a room
    net.AddHttpPost("/api/rooms", [&](const std::string&, const std::string& body, const HttpRequestHeaders& headers) -> HttpResponse {
        HTTP_ROOM_AUTH();
        auto user = db.FindUserById(userId);
        if (!user) return HttpAuth::JsonResponse(500, R"({"error":"user not found"})");

        std::string name = HttpAuth::JsonField(body, "name");
        std::string mapName = HttpAuth::JsonField(body, "map");
        std::string gameName = HttpAuth::JsonField(body, "game");
        if (name.empty()) name = "Game";
        if (gameName.empty() && !availableGames.empty()) gameName = availableGames[0].id;

        uint32_t roomId = rooms.CreateRoom(name, mapName, gameName, 8, "",
            static_cast<uint32_t>(userId), 0 /*no WS clientId*/, user->username);
        auto* room = rooms.GetRoom(roomId);
        return HttpAuth::JsonResponse(200, roomToJson(room));
    });

    // GET /api/rooms — list rooms
    net.AddHttpGet("/api/rooms", [&](const std::string&) -> HttpResponse {
        auto allRooms = rooms.GetAllRooms();
        std::string json = "[";
        bool first = true;
        for (const auto* r : allRooms) {
            if (!r) continue;
            if (!first) json += ",";
            first = false;
            json += roomToJson(r);
        }
        json += "]";
        return HttpAuth::JsonResponse(200, json);
    });

    // GET /api/games — list available games
    net.AddHttpGet("/api/games", [&availableGames](const std::string&) -> HttpResponse {
        std::string json = "[";
        bool first = true;
        for (const auto& g : availableGames) {
            if (!first) json += ",";
            first = false;
            json += "{\"id\":\"" + HttpAuth::JsonEscape(g.id) + "\""
                + ",\"displayName\":\"" + HttpAuth::JsonEscape(g.displayName) + "\""
                + ",\"description\":\"" + HttpAuth::JsonEscape(g.description) + "\""
                + ",\"version\":\"" + HttpAuth::JsonEscape(g.version) + "\"}";
        }
        json += "]";
        return HttpAuth::JsonResponse(200, json);
    });

    // GET /api/ai/* — list AI plugins for a game
    net.AddHttpGet("/api/ai/*", [&aisByGame](const std::string& url) -> HttpResponse {
        std::string gameId = url.substr(std::string("/api/ai/").size());
        if (gameId.empty())
            return HttpAuth::JsonResponse(400, R"({"error":"missing game id"})");

        auto it = aisByGame.find(gameId);
        if (it == aisByGame.end())
            return HttpAuth::JsonResponse(404, R"({"error":"game not found"})");

        std::string json = "[";
        bool first = true;
        for (const auto& ai : it->second) {
            if (!first) json += ",";
            first = false;
            json += "{\"id\":\"" + HttpAuth::JsonEscape(ai.id) + "\""
                + ",\"displayName\":\"" + HttpAuth::JsonEscape(ai.displayName) + "\""
                + ",\"description\":\"" + HttpAuth::JsonEscape(ai.description) + "\""
                + ",\"isEngineProvided\":" + (ai.isEngineProvided ? "true" : "false") + "}";
        }
        json += "]";
        return HttpAuth::JsonResponse(200, json);
    });

    // POST /api/rooms/end — end a running game (host-only, keeps room)
    net.AddHttpPost("/api/rooms/end", [&](const std::string&, const std::string& body, const HttpRequestHeaders& headers) -> HttpResponse {
        int64_t userId = HttpAuth::ValidateAuth(db, headers.authorization);
        if (userId <= 0)
            return HttpAuth::JsonResponse(401, R"({"error":"unauthorized"})");

        auto* room = findPlayerRoom(static_cast<uint32_t>(userId));
        if (!room)
            return HttpAuth::JsonResponse(404, R"({"error":"not in a room"})");

        // Only the host can end the game
        auto* player = room->FindPlayer(static_cast<uint32_t>(userId));
        if (!player || !player->isHost)
            return HttpAuth::JsonResponse(403, R"({"error":"only the host can end the game"})");

        // Find and kill the game server process
        auto gsIt = gameServers.find(room->id);
        if (gsIt == gameServers.end() ||
            (gsIt->second.state != GameServerInstance::Starting &&
             gsIt->second.state != GameServerInstance::Running))
            return HttpAuth::JsonResponse(400, R"({"error":"no running game server for this room"})");

        kill(gsIt->second.pid, SIGTERM);
        gsIt->second.state = GameServerInstance::Ended;
        SLOG(SPRING_LOG_NOTICE, "host ended game for room %u (killed pid %d)",
            room->id, gsIt->second.pid);

        // Reset the room back to Filling so it can be reused
        rooms.ResetRoomForNextGame(room->id);

        return HttpAuth::JsonResponse(200, roomToJson(rooms.GetRoom(room->id)));
    });

    // POST /api/rooms/join — join a room
    net.AddHttpPost("/api/rooms/join", [&](const std::string&, const std::string& body, const HttpRequestHeaders& headers) -> HttpResponse {
        HTTP_ROOM_AUTH();
        auto user = db.FindUserById(userId);
        if (!user) return HttpAuth::JsonResponse(500, R"({"error":"user not found"})");

        std::string ridStr = HttpAuth::JsonField(body, "room_id");
        uint32_t roomId = ridStr.empty() ? 0 : (uint32_t)std::atoi(ridStr.c_str());
        std::string password = HttpAuth::JsonField(body, "password");

        if (!rooms.JoinRoom(roomId, static_cast<uint32_t>(userId), 0, user->username, password))
            return HttpAuth::JsonResponse(403, R"({"error":"cannot join room"})");

        return HttpAuth::JsonResponse(200, roomToJson(rooms.GetRoom(roomId)));
    });

    // POST /api/rooms/leave
    net.AddHttpPost("/api/rooms/leave", [&](const std::string&, const std::string& body, const HttpRequestHeaders& headers) -> HttpResponse {
        HTTP_ROOM_AUTH();
        auto* room = findPlayerRoom(static_cast<uint32_t>(userId));
        if (!room) return HttpAuth::JsonResponse(404, R"({"error":"not in a room"})");
        uint32_t rid = room->id;
        rooms.LeaveRoom(rid, static_cast<uint32_t>(userId));
        return HttpAuth::JsonResponse(200, R"({"ok":true})");
    });

    // POST /api/rooms/ready
    net.AddHttpPost("/api/rooms/ready", [&](const std::string&, const std::string& body, const HttpRequestHeaders& headers) -> HttpResponse {
        HTTP_ROOM_AUTH();
        auto* room = findPlayerRoom(static_cast<uint32_t>(userId));
        if (!room) return HttpAuth::JsonResponse(404, R"({"error":"not in a room"})");
        std::string readyStr = HttpAuth::JsonField(body, "ready");
        bool ready = (readyStr == "true" || readyStr == "1");
        rooms.SetReady(room->id, static_cast<uint32_t>(userId), ready);
        return HttpAuth::JsonResponse(200, roomToJson(rooms.GetRoom(room->id)));
    });

    // POST /api/rooms/team
    net.AddHttpPost("/api/rooms/team", [&](const std::string&, const std::string& body, const HttpRequestHeaders& headers) -> HttpResponse {
        HTTP_ROOM_AUTH();
        auto* room = findPlayerRoom(static_cast<uint32_t>(userId));
        if (!room) return HttpAuth::JsonResponse(404, R"({"error":"not in a room"})");
        std::string teamStr = HttpAuth::JsonField(body, "team");
        uint8_t team = teamStr.empty() ? 0 : (uint8_t)std::atoi(teamStr.c_str());
        rooms.SetTeam(room->id, static_cast<uint32_t>(userId), team);
        return HttpAuth::JsonResponse(200, roomToJson(rooms.GetRoom(room->id)));
    });

    // POST /api/rooms/startpos
    net.AddHttpPost("/api/rooms/startpos", [&](const std::string&, const std::string& body, const HttpRequestHeaders& headers) -> HttpResponse {
        HTTP_ROOM_AUTH();
        auto* room = findPlayerRoom(static_cast<uint32_t>(userId));
        if (!room) return HttpAuth::JsonResponse(404, R"({"error":"not in a room"})");
        std::string posStr = HttpAuth::JsonField(body, "pos");
        int8_t pos = posStr.empty() ? 0 : (int8_t)std::atoi(posStr.c_str());
        // Find the target player — default to self
        std::string targetStr = HttpAuth::JsonField(body, "target_player_id");
        uint32_t target = targetStr.empty() ? static_cast<uint32_t>(userId) : (uint32_t)std::atoi(targetStr.c_str());
        rooms.SetPlayerStartPos(room->id, static_cast<uint32_t>(userId), target, pos, 6);
        return HttpAuth::JsonResponse(200, roomToJson(rooms.GetRoom(room->id)));
    });

    // POST /api/rooms/kick
    net.AddHttpPost("/api/rooms/kick", [&](const std::string&, const std::string& body, const HttpRequestHeaders& headers) -> HttpResponse {
        HTTP_ROOM_AUTH();
        auto* room = findPlayerRoom(static_cast<uint32_t>(userId));
        if (!room) return HttpAuth::JsonResponse(404, R"({"error":"not in a room"})");
        std::string targetStr = HttpAuth::JsonField(body, "target_player_id");
        uint32_t target = targetStr.empty() ? 0 : (uint32_t)std::atoi(targetStr.c_str());
        if (!rooms.KickPlayer(room->id, static_cast<uint32_t>(userId), target))
            return HttpAuth::JsonResponse(403, R"({"error":"cannot kick"})");
        return HttpAuth::JsonResponse(200, roomToJson(rooms.GetRoom(room->id)));
    });

    // POST /api/rooms/close
    net.AddHttpPost("/api/rooms/close", [&](const std::string&, const std::string& body, const HttpRequestHeaders& headers) -> HttpResponse {
        HTTP_ROOM_AUTH();
        auto* room = findPlayerRoom(static_cast<uint32_t>(userId));
        if (!room) return HttpAuth::JsonResponse(404, R"({"error":"not in a room"})");
        if (!rooms.CloseRoom(room->id, static_cast<uint32_t>(userId)))
            return HttpAuth::JsonResponse(403, R"({"error":"cannot close room"})");
        return HttpAuth::JsonResponse(200, R"({"ok":true})");
    });

    // POST /api/rooms/ai/add
    net.AddHttpPost("/api/rooms/ai/add", [&](const std::string&, const std::string& body, const HttpRequestHeaders& headers) -> HttpResponse {
        HTTP_ROOM_AUTH();
        auto* room = findPlayerRoom(static_cast<uint32_t>(userId));
        if (!room) return HttpAuth::JsonResponse(404, R"({"error":"not in a room"})");
        std::string aiId = HttpAuth::JsonField(body, "ai_id");
        std::string aiName = HttpAuth::JsonField(body, "name");
        if (aiName.empty()) aiName = aiId;
        std::string teamStr = HttpAuth::JsonField(body, "team");
        uint8_t team = teamStr.empty() ? 0 : (uint8_t)std::atoi(teamStr.c_str());
        if (!rooms.AddAISlot(room->id, static_cast<uint32_t>(userId), aiId, aiName, team))
            return HttpAuth::JsonResponse(400, R"({"error":"cannot add AI"})");
        return HttpAuth::JsonResponse(200, roomToJson(rooms.GetRoom(room->id)));
    });

    // POST /api/rooms/ai/remove
    net.AddHttpPost("/api/rooms/ai/remove", [&](const std::string&, const std::string& body, const HttpRequestHeaders& headers) -> HttpResponse {
        HTTP_ROOM_AUTH();
        auto* room = findPlayerRoom(static_cast<uint32_t>(userId));
        if (!room) return HttpAuth::JsonResponse(404, R"({"error":"not in a room"})");
        std::string indexStr = HttpAuth::JsonField(body, "slot_index");
        uint8_t slotIndex = indexStr.empty() ? 0 : (uint8_t)std::atoi(indexStr.c_str());
        if (!rooms.RemoveAISlot(room->id, static_cast<uint32_t>(userId), slotIndex))
            return HttpAuth::JsonResponse(400, R"({"error":"cannot remove AI"})");
        return HttpAuth::JsonResponse(200, roomToJson(rooms.GetRoom(room->id)));
    });

    // POST /api/rooms/start — start the game
    net.AddHttpPost("/api/rooms/start", [&](const std::string&, const std::string& body, const HttpRequestHeaders& headers) -> HttpResponse {
        HTTP_ROOM_AUTH();
        auto* room = findPlayerRoom(static_cast<uint32_t>(userId));
        if (!room) return HttpAuth::JsonResponse(404, R"({"error":"not in a room"})");
        if (!rooms.StartGame(room->id, static_cast<uint32_t>(userId)))
            return HttpAuth::JsonResponse(400, R"({"error":"cannot start game"})");

        // Spawn game server (same logic as WS path)
        std::string mapPath;
        if (!room->mapName.empty()) {
            namespace fs = std::filesystem;
            fs::path candidate = fs::path(mapsDir) / room->mapName;
            if (fs::is_directory(candidate)) mapPath = candidate.string();
        }

        std::string gamePath;
        auto it = gamePathsById.find(room->gameName);
        if (it != gamePathsById.end()) gamePath = it->second;

        if (!gamePath.empty()) {
            auto inst = spawnGameServer(room->id, gamePath, mapPath, dbPath,
                room->players, room->aiSlots);
            gameServers[room->id] = inst;
            room->gameServerPort = inst.port;
        }

        return HttpAuth::JsonResponse(200, roomToJson(rooms.GetRoom(room->id)));
    });

    #undef HTTP_ROOM_AUTH

    if (!net.Start(port)) {
        SLOG(SPRING_LOG_ERROR, "failed to start network");
        springlog_shutdown();
        return 1;
    }

    SLOG(SPRING_LOG_NOTICE, "running (port %d)", port);

    // --- Main loop (10 Hz for lobby — HTTP serving + process management) ---
    while (keepRunning.load()) {
        std::this_thread::sleep_for(std::chrono::milliseconds(100));

        // Check game server health every loop iteration
        for (auto& [roomId, inst] : gameServers) {
            if (inst.state == GameServerInstance::Starting || inst.state == GameServerInstance::Running) {
                if (!isProcessAlive(inst.pid)) {
                    inst.state = GameServerInstance::Ended;
                    SLOG(SPRING_LOG_NOTICE, "game server for room %u (pid %d) has exited",
                        roomId, inst.pid);

                    // Recycle the room: transition back to Filling,
                    // clear ready flags, zero gameServerPort, drop
                    // reconnection roster.
                    rooms.ResetRoomForNextGame(roomId);
                }
            }
        }
    }

    if (restartRequested.load()) {
        SLOG(SPRING_LOG_NOTICE, "restart requested — persisting game server state...");

        // Persist running game servers to SQLite so the new process
        // can re-adopt them without killing active games.
        if (mapDb) {
            sqlite3_exec(mapDb, "DELETE FROM game_servers", nullptr, nullptr, nullptr);
            for (auto& [rid, inst] : gameServers) {
                if (inst.state == GameServerInstance::Starting ||
                    inst.state == GameServerInstance::Running) {
                    std::string sql = "INSERT INTO game_servers (room_id, port, pid) VALUES ("
                        + std::to_string(rid) + "," + std::to_string(inst.port)
                        + "," + std::to_string(inst.pid) + ")";
                    sqlite3_exec(mapDb, sql.c_str(), nullptr, nullptr, nullptr);
                    SLOG(SPRING_LOG_NOTICE, "persisted game server room=%u port=%d pid=%d",
                        rid, inst.port, inst.pid);
                }
            }
            sqlite3_close(mapDb);
            mapDb = nullptr;
        }

        net.Stop();
        db.Close();
        SLOG(SPRING_LOG_NOTICE, "re-exec'ing: %s", savedArgv[0]);
        springlog_sqlite_shutdown();
        springlog_shutdown();

        // Re-exec with the same arguments — replaces this process
        // in-place, so PID is preserved and process managers don't
        // see a crash.
        execvp(savedArgv[0], savedArgv);
        // If execvp returns, it failed
        fprintf(stderr, "ERROR: restart failed: %s\n", strerror(errno));
        return 1;
    }

    SLOG(SPRING_LOG_NOTICE, "shutting down...");

    // Kill any running game servers
    for (auto& [roomId, inst] : gameServers) {
        if (isProcessAlive(inst.pid)) {
            kill(inst.pid, SIGTERM);
            SLOG(SPRING_LOG_NOTICE, "killed game server pid %d", inst.pid);
        }
    }

    net.Stop();
    db.Close();
    SLOG(SPRING_LOG_NOTICE, "exited cleanly");
    springlog_sqlite_shutdown();
    springlog_shutdown();
    return 0;
}
