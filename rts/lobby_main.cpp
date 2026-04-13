/**
 * spring-lobby — lightweight lobby server.
 *
 * Handles authentication, room management, and chat.
 * When a room starts, spawns a spring-server process for the game
 * and tells clients which port to connect to.
 *
 * No simulation code — just networking, SQLite, and process management.
 */

#include "Server/NetworkServer.h"
#include "Server/Protocol.h"
#include "Server/Database.h"
#include "Server/ClientSession.h"
#include "Server/RoomManager.h"
#include "Server/MapProcessor.h"
#include "Server/GameProcessor.h"
#include "Server/AI/AIDiscovery.h"
#include "Server/GameDiscovery.h"
#include "System/SpringLog/SpringLog.h"
#include <cctype>

#include <sqlite3.h>

#include <csignal>
#include <cstdio>
#include <cstdlib>
#include <atomic>
#include <chrono>
#include <filesystem>
#include <fstream>
#include <random>
#include <string>
#include <thread>
#include <unordered_map>

#include <sys/types.h>
#include <cstring>
#include <sys/wait.h>
#include <unistd.h>

#define LOG_SECTION "lobby"

static std::atomic<bool> keepRunning{true};
static void signalHandler(int) { keepRunning.store(false); }

static std::string generateToken(int length = 32) {
    static const char hex[] = "0123456789abcdef";
    static std::mt19937 rng(std::random_device{}());
    std::uniform_int_distribution<int> dist(0, 15);
    std::string token;
    token.reserve(length);
    for (int i = 0; i < length; i++) token += hex[dist(rng)];
    return token;
}

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
    std::signal(SIGINT, signalHandler);
    std::signal(SIGTERM, signalHandler);
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

    SLOG(SPRING_LOG_NOTICE, "starting on port %d...", port);

    // --- Database ---
    Database db;
    if (!db.Open(dbPath)) {
        SLOG(SPRING_LOG_ERROR, "failed to open database");
        springlog_shutdown();
        return 1;
    }

    // --- Sessions & Rooms ---
    SessionManager sessions;
    RoomManager rooms;

    // --- Map processing ---
    // Access the raw sqlite3* handle for MapProcessor
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

    {
        MapProcessor mapProc;
        mapProc.ScanAndProcess(mapsDir, "data", mapDb);
    }

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

    // --- Per-game processing & AI discovery ---
    // Each discovered game gets:
    //   1. a GameProcessor run over its objects3d/ directory so any
    //      .s3o models get converted to .glb + .config.json before
    //      spring-server loads them,
    //   2. an AIDiscovery scan covering content/engine/ai and the
    //      game's own ai/ folder, cached by game id so AIListRequest
    //      replies are cheap per-room lookups rather than rescans.
    std::unordered_map<std::string, std::string> gamePathsById;
    std::unordered_map<std::string, std::vector<AIDiscovery::AIInfo>> aisByGame;
    for (const auto& g : availableGames) {
        gamePathsById[g.id] = g.folderPath;
        GameProcessor::Process(g.folderPath, g.id, "data");
        aisByGame[g.id] = AIDiscovery::Discover(enginePath, g.folderPath);
    }

    // --- Game server instances ---
    std::unordered_map<uint32_t, GameServerInstance> gameServers; // roomId → instance

    // --- Network ---
    NetworkServer net;

    // Maps endpoint — full metadata from SQLite
    net.AddHttpGet("/api/maps", [mapDb](const std::string&) -> HttpResponse {
        MapProcessor proc;
        auto maps = proc.GetAllMaps(mapDb);
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

    // Serve original map source files straight from content/maps/.
    // Used by client-side Lua widgets for mapinfo.lua, LuaUI/Widgets/*.lua,
    // and any image assets the widget references via Spring paths like
    // ":a:LuaUI\\Images\\foo.png". No transformation — pure pass-through.
    net.AddHttpGet("/api/maps/source/*", [mapsDir](const std::string& url) -> HttpResponse {
        // URL: /api/maps/source/{mapId}/{relative/path}
        std::string rest = url.substr(std::string("/api/maps/source/").size());
        // Security: reject path traversal.
        if (rest.find("..") != std::string::npos)
            return {.contentType = "text/plain", .body = {}, .status = 403};

        namespace fs = std::filesystem;
        fs::path filePath = fs::path(mapsDir) / rest;
        if (!fs::exists(filePath) || !fs::is_regular_file(filePath))
            return {.contentType = "text/plain", .body = {}, .status = 404};

        std::ifstream f(filePath, std::ios::binary);
        std::vector<uint8_t> data((std::istreambuf_iterator<char>(f)),
                                   std::istreambuf_iterator<char>());

        std::string ext = filePath.extension().string();
        std::string ct = "application/octet-stream";
        if (ext == ".lua") ct = "text/x-lua; charset=utf-8";
        else if (ext == ".png") ct = "image/png";
        else if (ext == ".jpg" || ext == ".jpeg") ct = "image/jpeg";
        else if (ext == ".tga") ct = "image/x-tga";
        else if (ext == ".dds") ct = "image/vnd-ms.dds";

        return {
            .contentType = ct,
            .body = std::move(data),
            .status = 200,
            .cacheControl = "public, max-age=300",
        };
    });

    // Serve GAME-VFS files (modinfo.lua, LuaUI/*, LuaRules/*, gamedata/*,
    // units/*, weapons/*, etc.) from content/games/{gameId}/. In Spring's
    // VFS layering this is the GAME archive — widgets, gadgets, and map
    // scripts `include()` files from here, and the game can override
    // engine defaults by placing its own copy under LuaUI/.
    //
    // Paper Tanks' minimal base lives at content/games/papertanks/LuaUI/
    // and the client pre-fetches it before running any map widgets so
    // globals like `WG` and `widgetHandler` are visible.
    net.AddHttpGet("/api/vfs/game/*", [](const std::string& url) -> HttpResponse {
        // URL: /api/vfs/game/{gameId}/{relative/path}
        std::string rest = url.substr(std::string("/api/vfs/game/").size());
        if (rest.find("..") != std::string::npos)
            return {.contentType = "text/plain", .body = {}, .status = 403};

        namespace fs = std::filesystem;
        fs::path filePath = fs::path("content") / "games" / rest;
        if (!fs::exists(filePath) || !fs::is_regular_file(filePath))
            return {.contentType = "text/plain", .body = {}, .status = 404};

        std::ifstream f(filePath, std::ios::binary);
        std::vector<uint8_t> data((std::istreambuf_iterator<char>(f)),
                                   std::istreambuf_iterator<char>());

        std::string ext = filePath.extension().string();
        std::string ct = "application/octet-stream";
        if (ext == ".lua") ct = "text/x-lua; charset=utf-8";
        else if (ext == ".png") ct = "image/png";
        else if (ext == ".jpg" || ext == ".jpeg") ct = "image/jpeg";
        else if (ext == ".json") ct = "application/json";
        else if (ext == ".html") ct = "text/html; charset=utf-8";
        else if (ext == ".css") ct = "text/css; charset=utf-8";
        else if (ext == ".js") ct = "application/javascript; charset=utf-8";

        return {
            .contentType = ct,
            .body = std::move(data),
            .status = 200,
            .cacheControl = "public, max-age=300",
        };
    });

    // Serve processed map files (DXT1 tiles, heightmap, splat textures, etc.)
    // These are static binary assets — safe to cache for long periods.
    net.AddHttpGet("/api/maps/data/*", [](const std::string& url) -> HttpResponse {
        // URL: /api/maps/data/{mapId}/{filename}
        std::string rest = url.substr(std::string("/api/maps/data/").size());
        std::string filePath = "data/maps/" + rest;

        // Security: reject path traversal
        if (filePath.find("..") != std::string::npos)
            return {.contentType = "text/plain", .body = {}, .status = 403};

        namespace fs = std::filesystem;
        if (!fs::exists(filePath) || !fs::is_regular_file(filePath))
            return {.contentType = "text/plain", .body = {}, .status = 404};

        std::ifstream f(filePath, std::ios::binary);
        std::vector<uint8_t> data((std::istreambuf_iterator<char>(f)),
                                   std::istreambuf_iterator<char>());

        // Content type from extension
        std::string ext = fs::path(filePath).extension().string();
        std::string ct = "application/octet-stream";
        if (ext == ".ktx2") ct = "image/ktx2";
        else if (ext == ".json") ct = "application/json";
        else if (ext == ".png") ct = "image/png";
        else if (ext == ".webp") ct = "image/webp";
        else if (ext == ".glb") ct = "model/gltf-binary";
        else if (ext == ".gltf") ct = "model/gltf+json";

        return {
            .contentType = ct,
            .body = std::move(data),
            .status = 200,
            .cacheControl = "public, max-age=3600",
        };
    });

    // Serve processed game files (unit models, textures, etc.)
    // Parallel to /api/maps/data/* but for game content preprocessed
    // by GameProcessor into data/games/<gameId>/models/.
    net.AddHttpGet("/api/games/data/*", [](const std::string& url) -> HttpResponse {
        // URL: /api/games/data/{gameId}/models/{filename}
        std::string rest = url.substr(std::string("/api/games/data/").size());
        std::string filePath = "data/games/" + rest;

        if (filePath.find("..") != std::string::npos)
            return {.contentType = "text/plain", .body = {}, .status = 403};

        namespace fs = std::filesystem;
        if (!fs::exists(filePath) || !fs::is_regular_file(filePath))
            return {.contentType = "text/plain", .body = {}, .status = 404};

        std::ifstream f(filePath, std::ios::binary);
        std::vector<uint8_t> data((std::istreambuf_iterator<char>(f)),
                                   std::istreambuf_iterator<char>());

        std::string ext = fs::path(filePath).extension().string();
        std::string ct = "application/octet-stream";
        if (ext == ".glb") ct = "model/gltf-binary";
        else if (ext == ".gltf") ct = "model/gltf+json";
        else if (ext == ".png") ct = "image/png";
        else if (ext == ".json") ct = "application/json";

        return {
            .contentType = ct,
            .body = std::move(data),
            .status = 200,
            .cacheControl = "public, max-age=3600",
        };
    });

    // Map thumbnail endpoint. Serves the preprocessed small WebP
    // (aspect-correct, max 256px on the longer axis) that
    // MapProcessor::ExtractMinimapWebP wrote to
    // data/maps/<id>/thumbnail.webp at preprocess time. The full-size
    // minimap.webp sits next to it for consumers that want the larger
    // version via the generic /api/maps/data/* route.
    //
    // The shipped-*minimap.png/jpg fallback is preserved for maps
    // where preprocess failed (e.g. missing magick) — most modern
    // maps never hit it.
    net.AddHttpGet("/api/maps/thumb/*", [&mapsDir](const std::string& url) -> HttpResponse {
        const std::string mapId = url.substr(std::string("/api/maps/thumb/").size());
        if (mapId.find("..") != std::string::npos)
            return {.contentType = "text/plain", .body = {}, .status = 403};

        namespace fs = std::filesystem;

        // Primary: preprocessed small WebP (256px on the longer axis)
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
                .cacheControl = "public, max-age=3600",
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
                        .cacheControl = "public, max-age=3600",
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

    if (!net.Start(port)) {
        SLOG(SPRING_LOG_ERROR, "failed to start network");
        springlog_shutdown();
        return 1;
    }

    SLOG(SPRING_LOG_NOTICE, "running (port %d)", port);

    // --- Main loop (10 Hz for lobby, no sim) ---
    while (keepRunning.load()) {
        std::this_thread::sleep_for(std::chrono::milliseconds(100));

        // Drain inbound messages
        auto messages = net.DrainInbound();
        for (auto& msg : messages) {
            auto* clientMsg = Protocol::ParseClientMessage(msg.data.data(), msg.data.size());
            if (!clientMsg || !clientMsg->payload()) {
                auto err = Protocol::BuildServerError(400, "Invalid message");
                net.Send(msg.clientId, err.data(), err.size());
                continue;
            }

            switch (clientMsg->payload_type()) {
                case SpringWeb::ClientPayload_Ping: {
                    auto* ping = clientMsg->payload_as_Ping();
                    auto pong = Protocol::BuildPong(ping->client_time(), 0);
                    net.Send(msg.clientId, pong.data(), pong.size());
                    break;
                }
                case SpringWeb::ClientPayload_Handshake: {
                    auto* hs = clientMsg->payload_as_Handshake();
                    SLOG(SPRING_LOG_INFO, "handshake from client %u: v%d",
                        msg.clientId, hs->protocol_version());
                    break;
                }
                case SpringWeb::ClientPayload_AuthRequest: {
                    auto* auth = clientMsg->payload_as_AuthRequest();
                    const char* username = auth->username() ? auth->username()->c_str() : "";
                    const char* passHash = auth->password_hash() ? auth->password_hash()->c_str() : "";

                    // Try token-based reconnection first
                    bool hasToken = auth->token() && auth->token()->size() > 0;
                    SLOG(SPRING_LOG_DEBUG, "auth: user='%s' hasToken=%d passLen=%zu",
                        username, hasToken, strlen(passHash));
                    if (hasToken) {
                        int64_t userId = db.ValidateSession(auth->token()->str());
                        SLOG(SPRING_LOG_DEBUG, "token validation: userId=%lld", userId);
                        if (userId > 0) {
                            auto user = db.FindUser(username);
                            if (user && user->id == userId) {
                                auto resp = Protocol::BuildAuthResponse(
                                    SpringWeb::AuthStatus_OK, auth->token()->str(),
                                    static_cast<uint32_t>(userId));
                                net.Send(msg.clientId, resp.data(), resp.size());
                                sessions.AddSession(msg.clientId, userId, user->username, user->role);
                                SLOG(SPRING_LOG_INFO, "'%s' reconnected via token", username);

                                auto allRooms = rooms.GetAllRooms();
                                auto listMsg = Protocol::BuildRoomListUpdate(allRooms);
                                net.Send(msg.clientId, listMsg.data(), listMsg.size());

                                // Send map list (FlatBuffer) so the client can show the browser
                                {
                                    MapProcessor proc;
                                    auto allMaps = proc.GetAllMaps(mapDb);
                                    auto mapListMsg = Protocol::BuildMapListUpdate(allMaps);
                                    net.Send(msg.clientId, mapListMsg.data(), mapListMsg.size());
                                }
                                break;
                            }
                        }
                        // Token invalid — fall through to password auth
                        // If password is empty, reject (this was a token-only attempt)
                        if (strlen(passHash) == 0) {
                            auto resp = Protocol::BuildAuthResponse(
                                SpringWeb::AuthStatus_InvalidCredentials, "", 0, "Session expired");
                            net.Send(msg.clientId, resp.data(), resp.size());
                            break;
                        }
                    }

                    auto user = db.FindUser(username);
                    if (!user) {
                        if (strlen(passHash) == 0) {
                            auto resp = Protocol::BuildAuthResponse(SpringWeb::AuthStatus_InvalidCredentials, "", 0, "Enter a password");
                            net.Send(msg.clientId, resp.data(), resp.size());
                            break;
                        }
                        int64_t newId = db.CreateUser(username, passHash);
                        if (newId == 0) {
                            auto resp = Protocol::BuildAuthResponse(SpringWeb::AuthStatus_InvalidCredentials, "", 0, "Registration failed");
                            net.Send(msg.clientId, resp.data(), resp.size());
                            break;
                        }
                        user = db.FindUser(username);
                        SLOG(SPRING_LOG_NOTICE, "registered new user '%s'", username);
                    }
                    if (user->passwordHash != passHash) {
                        auto resp = Protocol::BuildAuthResponse(SpringWeb::AuthStatus_InvalidCredentials, "", 0, "Wrong password");
                        net.Send(msg.clientId, resp.data(), resp.size());
                        break;
                    }

                    std::string token = generateToken();
                    db.CreateSession(user->id, token);
                    auto resp = Protocol::BuildAuthResponse(SpringWeb::AuthStatus_OK, token, static_cast<uint32_t>(user->id));
                    net.Send(msg.clientId, resp.data(), resp.size());
                    sessions.AddSession(msg.clientId, user->id, user->username, user->role);
                    SLOG(SPRING_LOG_INFO, "'%s' authenticated (id=%lld)", username, user->id);

                    // Send room list
                    auto allRooms = rooms.GetAllRooms();
                    auto listMsg = Protocol::BuildRoomListUpdate(allRooms);
                    net.Send(msg.clientId, listMsg.data(), listMsg.size());

                    // Send map list (FlatBuffer)
                    {
                        MapProcessor proc;
                        auto allMaps = proc.GetAllMaps(mapDb);
                        auto mapListMsg = Protocol::BuildMapListUpdate(allMaps);
                        net.Send(msg.clientId, mapListMsg.data(), mapListMsg.size());
                    }
                    break;
                }

                // --- Room handlers ---
                #define REQUIRE_SESSION(var) \
                    auto* var = sessions.GetSession(msg.clientId); \
                    if (!var) { auto e = Protocol::BuildServerError(401, "Auth required"); net.Send(msg.clientId, e.data(), e.size()); break; }

                #define BROADCAST_ROOM_UPDATE(roomPtr) do { \
                    if (roomPtr) { \
                        auto _sm = Protocol::BuildRoomStateUpdate(*roomPtr); \
                        for (const auto& _p : roomPtr->players) \
                            net.Send(_p.clientId, _sm.data(), _sm.size()); \
                    } \
                    auto _all = rooms.GetAllRooms(); \
                    auto _lm = Protocol::BuildRoomListUpdate(_all); \
                    net.Broadcast(_lm.data(), _lm.size()); \
                } while(0)

                case SpringWeb::ClientPayload_RoomCreate: {
                    REQUIRE_SESSION(session);
                    auto* rc = clientMsg->payload_as_RoomCreate();

                    // Validate that the requested game is one the
                    // lobby actually discovered. If the client passes
                    // an empty game name we pick the first available
                    // one as a convenience default (matches how older
                    // clients that haven't fetched the game list
                    // behave). An unknown name is a hard rejection
                    // so the room never enters a state we can't
                    // launch from.
                    std::string requestedGame = rc->game_name() ? rc->game_name()->str() : "";
                    if (requestedGame.empty() && !availableGames.empty()) {
                        requestedGame = availableGames[0].id;
                    }
                    if (gamePathsById.find(requestedGame) == gamePathsById.end()) {
                        auto e = Protocol::BuildServerError(400,
                            requestedGame.empty()
                                ? "No games available on this lobby"
                                : "Unknown game");
                        net.Send(msg.clientId, e.data(), e.size());
                        break;
                    }

                    uint32_t roomId = rooms.CreateRoom(
                        rc->name() ? rc->name()->str() : "Game",
                        rc->map_name() ? rc->map_name()->str() : "",
                        requestedGame,
                        rc->max_players() > 0 ? rc->max_players() : 8,
                        rc->password() ? rc->password()->str() : "",
                        static_cast<uint32_t>(session->userId), msg.clientId, session->username);
                    BROADCAST_ROOM_UPDATE(rooms.GetRoom(roomId));
                    break;
                }
                case SpringWeb::ClientPayload_RoomJoin: {
                    REQUIRE_SESSION(session);
                    auto* rj = clientMsg->payload_as_RoomJoin();
                    if (!rooms.JoinRoom(rj->room_id(), static_cast<uint32_t>(session->userId),
                                        msg.clientId, session->username,
                                        rj->password() ? rj->password()->str() : "")) {
                        auto e = Protocol::BuildServerError(403, "Cannot join room");
                        net.Send(msg.clientId, e.data(), e.size());
                        break;
                    }
                    BROADCAST_ROOM_UPDATE(rooms.GetRoom(rj->room_id()));
                    break;
                }
                case SpringWeb::ClientPayload_RoomLeave: {
                    REQUIRE_SESSION(session);
                    auto* room = rooms.FindRoomByClient(msg.clientId);
                    if (room) {
                        uint32_t rid = room->id;
                        rooms.LeaveRoom(rid, static_cast<uint32_t>(session->userId));
                        BROADCAST_ROOM_UPDATE(rooms.GetRoom(rid));
                    }
                    break;
                }
                case SpringWeb::ClientPayload_RoomTeamSelect: {
                    REQUIRE_SESSION(session);
                    auto* room = rooms.FindRoomByClient(msg.clientId);
                    if (room) {
                        rooms.SetTeam(room->id, static_cast<uint32_t>(session->userId),
                                      clientMsg->payload_as_RoomTeamSelect()->team());
                        BROADCAST_ROOM_UPDATE(room);
                    }
                    break;
                }
                case SpringWeb::ClientPayload_RoomReady: {
                    REQUIRE_SESSION(session);
                    auto* room = rooms.FindRoomByClient(msg.clientId);
                    if (room) {
                        rooms.SetReady(room->id, static_cast<uint32_t>(session->userId),
                                       clientMsg->payload_as_RoomReady()->ready());
                        BROADCAST_ROOM_UPDATE(room);
                    }
                    break;
                }
                case SpringWeb::ClientPayload_RoomStartGame: {
                    REQUIRE_SESSION(session);
                    auto* room = rooms.FindRoomByClient(msg.clientId);
                    if (!room || !rooms.StartGame(room->id, static_cast<uint32_t>(session->userId)))
                        break;

                    // Resolve map path
                    std::string mapPath;
                    if (!room->mapName.empty()) {
                        namespace fs = std::filesystem;
                        fs::path candidate = fs::path(mapsDir) / room->mapName;
                        if (fs::is_directory(candidate))
                            mapPath = candidate.string();
                    }

                    // Look up the map's start-position count so
                    // auto-assignment knows the upper bound before
                    // we hand the roster off to the game server.
                    // Empty-map rooms go through with maxStartPos=0
                    // and the game server falls back to its own
                    // defaults for spawn placement.
                    int8_t maxStartPos = 0;
                    if (!room->mapName.empty()) {
                        MapProcessor proc;
                        auto mapMeta = proc.GetMap(mapDb, room->mapName);
                        maxStartPos = static_cast<int8_t>(
                            std::min<size_t>(mapMeta.startPositions.size(), 127));
                    }

                    // Any slots still at startPos=-1 get assigned
                    // concrete indices now, using the same rules as
                    // a manual set (ascending, first-available).
                    // This keeps backwards compatibility with the
                    // old "click Start Game and the host didn't
                    // touch the dropdown" flow.
                    rooms.AutoAssignStartPositions(room->id, maxStartPos);

                    // Save original player roster for reconnection
                    for (const auto& p : room->players) {
                        if (!p.isSpectator)
                            room->originalRoster[p.playerId] = p.team;
                    }

                    // Resolve the room's game id to its on-disk path.
                    // Unknown game name is a silent fail rather than a
                    // crash — the RoomCreate handler validates this
                    // when the room is first created, so hitting the
                    // unknown path here means something corrupted the
                    // room state between create and start.
                    auto gpIt = gamePathsById.find(room->gameName);
                    if (gpIt == gamePathsById.end()) {
                        SLOG(SPRING_LOG_WARNING, "RoomStartGame: unknown game '%s' for room %u",
                            room->gameName.c_str(), room->id);
                        break;
                    }
                    const std::string& roomGamePath = gpIt->second;

                    // Spawn game server, handing off both the
                    // player roster and the AI slot roster so the
                    // sim can map connecting sessions back to
                    // their lobby-assigned teams and spawn units
                    // at each team's chosen start position.
                    std::vector<RoomPlayer> playerRoster;
                    for (const auto& p : room->players) {
                        if (!p.isSpectator) playerRoster.push_back(p);
                    }
                    auto inst = spawnGameServer(room->id, roomGamePath, mapPath, dbPath,
                                                playerRoster, room->aiSlots);
                    gameServers[room->id] = inst;

                    // Store port on the room so clients get it via RoomStateUpdate
                    room->gameServerPort = static_cast<uint16_t>(inst.port);

                    BROADCAST_ROOM_UPDATE(room);

                    SLOG(SPRING_LOG_NOTICE, "room %u: game server on port %d",
                        room->id, inst.port);
                    break;
                }
                case SpringWeb::ClientPayload_RoomKick: {
                    REQUIRE_SESSION(session);
                    auto* room = rooms.FindRoomByClient(msg.clientId);
                    if (room) {
                        rooms.KickPlayer(room->id, static_cast<uint32_t>(session->userId),
                                         clientMsg->payload_as_RoomKick()->player_id());
                        BROADCAST_ROOM_UPDATE(room);
                    }
                    break;
                }
                case SpringWeb::ClientPayload_RoomCloseRoom: {
                    // Host-only: delete the entire room. Kills the
                    // game subprocess if one is running, then wipes
                    // the room from the RoomManager and broadcasts
                    // a room list update so every client refreshes
                    // the browser view. Former members notice that
                    // their cached `currentRoom.id` is no longer in
                    // the list and fall back to the browser
                    // automatically (see handleRoomList on the
                    // client).
                    REQUIRE_SESSION(session);
                    auto* room = rooms.FindRoomByClient(msg.clientId);
                    if (!room) break;
                    const uint32_t closingRoomId = room->id;
                    if (room->hostPlayerId != static_cast<uint32_t>(session->userId)) {
                        SLOG(SPRING_LOG_WARNING, "RoomCloseRoom rejected: user %lld not host of room %u",
                            static_cast<long long>(session->userId), closingRoomId);
                        break;
                    }

                    // Snapshot the member client ids BEFORE closing
                    // the room — once RoomManager::CloseRoom returns,
                    // the room vector is gone and we need these ids
                    // to send the room-list refresh to each former
                    // member individually.
                    std::vector<ClientID> formerMembers;
                    formerMembers.reserve(room->players.size());
                    for (const auto& p : room->players)
                        formerMembers.push_back(p.clientId);

                    // Kill the associated game subprocess if it's
                    // still running. If Close Room is used mid-game
                    // we don't want an orphan child process sitting
                    // in the process table — the player might well
                    // try to create a new room on the same port.
                    auto gsIt = gameServers.find(closingRoomId);
                    if (gsIt != gameServers.end() && isProcessAlive(gsIt->second.pid)) {
                        kill(gsIt->second.pid, SIGTERM);
                        SLOG(SPRING_LOG_NOTICE, "closing room %u: killed game server pid %d",
                            closingRoomId, gsIt->second.pid);
                    }
                    if (gsIt != gameServers.end())
                        gameServers.erase(gsIt);

                    if (!rooms.CloseRoom(closingRoomId,
                            static_cast<uint32_t>(session->userId))) {
                        // Shouldn't happen — we verified host above
                        // and hold no cross-process locks — but if
                        // it does, at least don't leak the game
                        // server state.
                        SLOG(SPRING_LOG_WARNING, "RoomCloseRoom: CloseRoom unexpectedly failed for room %u",
                            closingRoomId);
                        break;
                    }

                    // Refresh the room list for every former member
                    // so their browser view drops the closed room.
                    // We also broadcast to everyone else in the
                    // lobby so the browser room count stays
                    // accurate.
                    auto allRooms = rooms.GetAllRooms();
                    auto listMsg = Protocol::BuildRoomListUpdate(allRooms);
                    for (ClientID cid : formerMembers)
                        net.Send(cid, listMsg.data(), listMsg.size());
                    net.Broadcast(listMsg.data(), listMsg.size());
                    break;
                }
                case SpringWeb::ClientPayload_RoomEndGame: {
                    // Host-only: terminate a running game subprocess.
                    // Authorisation: sender must be the room host, and
                    // the room must be in a game-in-progress state
                    // (Loading or Active). We kill the subprocess via
                    // SIGTERM; the health-check loop below reaps it and
                    // transitions the room to Ended, which broadcasts
                    // the room update to all remaining clients.
                    REQUIRE_SESSION(session);
                    auto* room = rooms.FindRoomByClient(msg.clientId);
                    if (!room) break;
                    if (room->hostPlayerId != static_cast<uint32_t>(session->userId)) {
                        SLOG(SPRING_LOG_WARNING, "RoomEndGame rejected: user %lld not host of room %u",
                            static_cast<long long>(session->userId), room->id);
                        break;
                    }
                    if (room->state != ERoomState::Loading &&
                        room->state != ERoomState::Active) {
                        SLOG(SPRING_LOG_WARNING, "RoomEndGame rejected: room %u not in game state",
                            room->id);
                        break;
                    }
                    auto it = gameServers.find(room->id);
                    if (it != gameServers.end() && isProcessAlive(it->second.pid)) {
                        kill(it->second.pid, SIGTERM);
                        SLOG(SPRING_LOG_NOTICE, "host ended game for room %u (pid %d)",
                            room->id, it->second.pid);
                    } else {
                        // No subprocess to kill — transition the room
                        // directly. Unusual but shouldn't leave the
                        // room stuck in Loading/Active forever.
                        rooms.SetRoomState(room->id, ERoomState::Ended);
                        BROADCAST_ROOM_UPDATE(room);
                    }
                    break;
                }
                case SpringWeb::ClientPayload_GameListRequest: {
                    // Any authenticated client can fetch the game
                    // list — the lobby UI requests it on first
                    // login so the create-room dropdown has content
                    // before the user clicks "New Game".
                    REQUIRE_SESSION(session);
                    auto listMsg = Protocol::BuildGameListUpdate(availableGames);
                    net.Send(msg.clientId, listMsg.data(), listMsg.size());
                    break;
                }
                case SpringWeb::ClientPayload_AIListRequest: {
                    // Anyone in a session can ask for the AI list —
                    // the lobby UI needs it for the host-only "Add AI"
                    // dropdown, but non-host clients also render AI
                    // display names next to slots, so everyone gets it.
                    // The list is per-game: each game has its own
                    // ai/ folder which merges with the engine's, so
                    // we look up by the caller's current room's game
                    // name. A client that isn't in any room gets an
                    // empty reply (they shouldn't have a reason to
                    // ask before joining a room, but sending an
                    // empty list is cheaper than a special-case
                    // error).
                    REQUIRE_SESSION(session);
                    auto* room = rooms.FindRoomByClient(msg.clientId);
                    static const std::vector<AIDiscovery::AIInfo> emptyList;
                    const std::vector<AIDiscovery::AIInfo>* list = &emptyList;
                    if (room) {
                        auto it = aisByGame.find(room->gameName);
                        if (it != aisByGame.end()) list = &it->second;
                    }
                    auto listMsg = Protocol::BuildAIListUpdate(*list);
                    net.Send(msg.clientId, listMsg.data(), listMsg.size());
                    break;
                }
                case SpringWeb::ClientPayload_RoomAddAI: {
                    REQUIRE_SESSION(session);
                    auto* room = rooms.FindRoomByClient(msg.clientId);
                    if (!room) break;
                    auto* addAI = clientMsg->payload_as_RoomAddAI();
                    if (!addAI || !addAI->ai_id()) break;

                    // Resolve the requested id against the discovered
                    // set FOR THIS ROOM'S GAME so we can reject typos
                    // and cross-game leakage (an id that exists in
                    // game A's ai/ folder shouldn't be addable to a
                    // game B room).
                    auto it = aisByGame.find(room->gameName);
                    if (it == aisByGame.end()) {
                        SLOG(SPRING_LOG_WARNING, "RoomAddAI rejected: room %u has unknown game '%s'",
                            room->id, room->gameName.c_str());
                        break;
                    }
                    const std::string requestedId = addAI->ai_id()->str();
                    const AIDiscovery::AIInfo* match = nullptr;
                    for (const auto& ai : it->second) {
                        if (ai.id == requestedId) { match = &ai; break; }
                    }
                    if (!match) {
                        SLOG(SPRING_LOG_WARNING, "RoomAddAI rejected: unknown AI id '%s' for game '%s'",
                            requestedId.c_str(), room->gameName.c_str());
                        break;
                    }

                    if (rooms.AddAISlot(room->id,
                                        static_cast<uint32_t>(session->userId),
                                        match->id, match->displayName,
                                        addAI->team())) {
                        BROADCAST_ROOM_UPDATE(room);
                    }
                    break;
                }
                case SpringWeb::ClientPayload_RoomRemoveAI: {
                    REQUIRE_SESSION(session);
                    auto* room = rooms.FindRoomByClient(msg.clientId);
                    if (!room) break;
                    auto* rmAI = clientMsg->payload_as_RoomRemoveAI();
                    if (!rmAI) break;
                    if (rooms.RemoveAISlot(room->id,
                                           static_cast<uint32_t>(session->userId),
                                           rmAI->slot_index())) {
                        BROADCAST_ROOM_UPDATE(room);
                    }
                    break;
                }
                case SpringWeb::ClientPayload_RoomSetAITeam: {
                    // Host-only: re-assign an existing AI slot to a
                    // different team. Start position is preserved.
                    REQUIRE_SESSION(session);
                    auto* room = rooms.FindRoomByClient(msg.clientId);
                    if (!room) break;
                    auto* sat = clientMsg->payload_as_RoomSetAITeam();
                    if (!sat) break;
                    if (rooms.SetAITeam(room->id,
                                        static_cast<uint32_t>(session->userId),
                                        sat->slot_index(),
                                        sat->team())) {
                        BROADCAST_ROOM_UPDATE(room);
                    }
                    break;
                }
                case SpringWeb::ClientPayload_RoomSetStartPos: {
                    // Assign a map start position to a player or AI
                    // slot. Looks up the room's map to find the max
                    // start-pos index, then delegates to RoomManager
                    // which handles permission + occupancy. Either
                    // targetPlayerId or targetAiSlot must identify
                    // the target (mutually exclusive).
                    REQUIRE_SESSION(session);
                    auto* room = rooms.FindRoomByClient(msg.clientId);
                    if (!room) break;
                    auto* sp = clientMsg->payload_as_RoomSetStartPos();
                    if (!sp) break;

                    // Resolve the map for this room to get the
                    // start-pos count. Empty mapName is a hard
                    // reject: there's no pool to pick from.
                    if (room->mapName.empty()) break;
                    MapProcessor proc;
                    auto mapMeta = proc.GetMap(mapDb, room->mapName);
                    const int8_t maxStartPos = static_cast<int8_t>(
                        std::min<size_t>(mapMeta.startPositions.size(), 127));
                    if (maxStartPos <= 0) {
                        SLOG(SPRING_LOG_WARNING, "RoomSetStartPos rejected: map '%s' has no start positions",
                            room->mapName.c_str());
                        break;
                    }

                    const uint32_t requesterId = static_cast<uint32_t>(session->userId);
                    const int8_t posIndex = sp->pos_index();
                    bool ok = false;
                    if (sp->target_ai_slot() >= 0) {
                        ok = rooms.SetAIStartPos(room->id, requesterId,
                            static_cast<uint8_t>(sp->target_ai_slot()),
                            posIndex, maxStartPos);
                    } else {
                        ok = rooms.SetPlayerStartPos(room->id, requesterId,
                            sp->target_player_id(), posIndex, maxStartPos);
                    }
                    if (ok) BROADCAST_ROOM_UPDATE(room);
                    break;
                }
                case SpringWeb::ClientPayload_ConsoleCommand: {
                    auto* cc = clientMsg->payload_as_ConsoleCommand();
                    if (!cc) break;
                    std::string scope = cc->scope() ? cc->scope()->str() : "";
                    std::string command = cc->command() ? cc->command()->str() : "";
                    uint32_t reqId = cc->request_id();

                    if (scope == "sql") {
                        // Read-only SQL query proxy
                        // Simple keyword check to reject mutations
                        std::string upper = command;
                        for (auto& c : upper) c = (char)toupper((unsigned char)c);
                        bool rejected = false;
                        for (const char* kw : {"INSERT", "UPDATE", "DELETE", "DROP", "ALTER", "CREATE"}) {
                            if (upper.find(kw) != std::string::npos) { rejected = true; break; }
                        }
                        if (rejected) {
                            auto resp = Protocol::BuildConsoleResponse(reqId, scope, false,
                                "Read-only: mutation queries not allowed");
                            net.Send(msg.clientId, resp.data(), resp.size());
                            break;
                        }
                        // Execute query
                        std::string result;
                        char* errMsg = nullptr;
                        auto callback = [](void* data, int ncols, char** vals, char** names) -> int {
                            auto* out = static_cast<std::string*>(data);
                            if (!out->empty()) *out += "\n";
                            for (int i = 0; i < ncols; i++) {
                                if (i > 0) *out += " | ";
                                *out += std::string(names[i]) + "=" + (vals[i] ? vals[i] : "NULL");
                            }
                            return 0;
                        };
                        int rc = sqlite3_exec(mapDb, command.c_str(), callback, &result, &errMsg);
                        if (rc != SQLITE_OK) {
                            std::string err = errMsg ? errMsg : "unknown error";
                            if (errMsg) sqlite3_free(errMsg);
                            auto resp = Protocol::BuildConsoleResponse(reqId, scope, false, err);
                            net.Send(msg.clientId, resp.data(), resp.size());
                        } else {
                            if (result.empty()) result = "(no results)";
                            auto resp = Protocol::BuildConsoleResponse(reqId, scope, true, result);
                            net.Send(msg.clientId, resp.data(), resp.size());
                        }
                    }
                    else if (scope == "lobby") {
                        // Built-in lobby commands
                        std::string result;
                        if (command == "rooms") {
                            auto allRooms = rooms.GetAllRooms();
                            for (const auto* r : allRooms) {
                                if (!r) continue;
                                if (!result.empty()) result += "\n";
                                result += "Room " + std::to_string(r->id) + ": " + r->name
                                    + " (" + std::to_string(r->players.size()) + " players)";
                            }
                            if (result.empty()) result = "(no rooms)";
                        }
                        else if (command == "process list") {
                            for (const auto& [rid, inst] : gameServers) {
                                if (!result.empty()) result += "\n";
                                result += "Room " + std::to_string(rid)
                                    + ": pid=" + std::to_string(inst.pid)
                                    + " port=" + std::to_string(inst.port);
                            }
                            if (result.empty()) result = "(no game servers)";
                        }
                        else {
                            result = "unknown lobby command: " + command;
                        }
                        auto resp = Protocol::BuildConsoleResponse(reqId, scope, true, result);
                        net.Send(msg.clientId, resp.data(), resp.size());
                    }
                    else {
                        auto resp = Protocol::BuildConsoleResponse(reqId, scope, false,
                            "unknown scope (lobby handles: sql, lobby)");
                        net.Send(msg.clientId, resp.data(), resp.size());
                    }
                    break;
                }

                default:
                    break;

                #undef REQUIRE_SESSION
                #undef BROADCAST_ROOM_UPDATE
            }
        }

        // Check game server health every loop iteration
        for (auto& [roomId, inst] : gameServers) {
            if (inst.state == GameServerInstance::Starting || inst.state == GameServerInstance::Running) {
                if (!isProcessAlive(inst.pid)) {
                    inst.state = GameServerInstance::Ended;
                    SLOG(SPRING_LOG_NOTICE, "game server for room %u (pid %d) has exited",
                        roomId, inst.pid);

                    // Recycle the room: transition back to Filling,
                    // clear ready flags, zero gameServerPort, drop
                    // reconnection roster. This lets the same room
                    // host another game without being closed and
                    // recreated. See RoomManager::ResetRoomForNextGame
                    // for the full state reset.
                    rooms.ResetRoomForNextGame(roomId);

                    // Broadcast the new state so clients render
                    // pregame room UI (Ready / Start Game /
                    // Close Room) instead of the stale Rejoin /
                    // End Game controls. Without this the room
                    // transitions internally but clients never
                    // find out and appear stuck showing the
                    // in-game buttons. Same shape as the
                    // BROADCAST_ROOM_UPDATE macro used inside the
                    // message handler switch — the macro is
                    // scoped to that switch and #undef'd before
                    // we get here, so we inline the body.
                    if (auto* room = rooms.GetRoom(roomId)) {
                        auto stateMsg = Protocol::BuildRoomStateUpdate(*room);
                        for (const auto& p : room->players)
                            net.Send(p.clientId, stateMsg.data(), stateMsg.size());
                    }
                    auto allRooms = rooms.GetAllRooms();
                    auto listMsg = Protocol::BuildRoomListUpdate(allRooms);
                    net.Broadcast(listMsg.data(), listMsg.size());
                }
            }
        }
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
    springlog_shutdown();
    return 0;
}
