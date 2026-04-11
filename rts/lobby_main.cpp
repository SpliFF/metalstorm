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
#include <sys/wait.h>
#include <unistd.h>

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
/// `aiSlots` is the room's AI roster at game-start time. Each slot is
/// passed to the child process as a `--ai <id>:<team>` argument; the
/// server runs its own AIDiscovery against the same game path and
/// resolves each id to a main.lua it can actually run.
static GameServerInstance spawnGameServer(
    uint32_t roomId, const std::string& gamePath,
    const std::string& mapPath, const std::string& dbPath,
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

    // Assemble the --ai arguments outside the fork so their string
    // storage outlives the execvp call in the child. Each slot becomes
    // two argv entries: "--ai" followed by "<id>:<team>".
    std::vector<std::string> aiArgStorage;
    aiArgStorage.reserve(aiSlots.size());
    for (const auto& slot : aiSlots) {
        aiArgStorage.push_back(slot.aiId + ":" + std::to_string(slot.team));
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

        // Close all other inherited file descriptors. uWebSockets sockets
        // (our listen socket, all established WS client connections) do not
        // get FD_CLOEXEC by default on macOS, so without this the child
        // process ends up holding the parent's listen socket + every active
        // WebSocket. That leaks state into spring-server and causes
        // cross-talk between the lobby and game server.
        int maxFd = static_cast<int>(sysconf(_SC_OPEN_MAX));
        if (maxFd < 1024) maxFd = 1024;
        for (int fd = 3; fd < maxFd; fd++) close(fd);

        std::string portStr = std::to_string(inst.port);

        // Build argv: fixed args first, then one "--ai <spec>" pair
        // per AI slot. The trailing nullptr terminates for execvp.
        std::vector<const char*> argv;
        argv.push_back(serverBin.c_str());
        argv.push_back("--port"); argv.push_back(portStr.c_str());
        argv.push_back("--game"); argv.push_back(gamePath.c_str());
        argv.push_back("--map");  argv.push_back(mapPath.c_str());
        argv.push_back("--db");   argv.push_back(dbPath.c_str());
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
        std::fprintf(stderr, "[lobby] spawned game server pid=%d port=%d for room %u (%zu AI)\n",
            pid, inst.port, roomId, aiSlots.size());
    } else {
        std::fprintf(stderr, "[lobby] ERROR: fork failed\n");
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

    int port = 8011;
    std::string dbPath = "data/spring-server.db";
    std::string gamesDir = "content/games";
    std::string mapsDir = "content/maps";

    for (int i = 1; i < argc; i++) {
        std::string arg = argv[i];
        if (arg == "--port" && i + 1 < argc) port = std::atoi(argv[++i]);
        else if (arg == "--db" && i + 1 < argc) dbPath = argv[++i];
        else if (arg == "--games-dir" && i + 1 < argc) gamesDir = argv[++i];
        else if (arg == "--maps" && i + 1 < argc) mapsDir = argv[++i];
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

    std::fprintf(stderr, "[lobby] starting on port %d...\n", port);

    // --- Database ---
    Database db;
    if (!db.Open(dbPath)) {
        std::fprintf(stderr, "[lobby] ERROR: failed to open database\n");
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

    if (!net.Start(port)) {
        std::fprintf(stderr, "[lobby] ERROR: failed to start network\n");
        return 1;
    }

    std::fprintf(stderr, "[lobby] running (port %d)\n", port);

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
                    std::fprintf(stderr, "[lobby] handshake from client %u: v%d\n",
                        msg.clientId, hs->protocol_version());
                    break;
                }
                case SpringWeb::ClientPayload_AuthRequest: {
                    auto* auth = clientMsg->payload_as_AuthRequest();
                    const char* username = auth->username() ? auth->username()->c_str() : "";
                    const char* passHash = auth->password_hash() ? auth->password_hash()->c_str() : "";

                    // Try token-based reconnection first
                    bool hasToken = auth->token() && auth->token()->size() > 0;
                    std::fprintf(stderr, "[lobby] auth: user='%s' hasToken=%d passLen=%zu\n",
                        username, hasToken, strlen(passHash));
                    if (hasToken) {
                        int64_t userId = db.ValidateSession(auth->token()->str());
                        std::fprintf(stderr, "[lobby] token validation: userId=%lld\n", userId);
                        if (userId > 0) {
                            auto user = db.FindUser(username);
                            if (user && user->id == userId) {
                                auto resp = Protocol::BuildAuthResponse(
                                    SpringWeb::AuthStatus_OK, auth->token()->str(),
                                    static_cast<uint32_t>(userId));
                                net.Send(msg.clientId, resp.data(), resp.size());
                                sessions.AddSession(msg.clientId, userId, user->username, user->role);
                                std::fprintf(stderr, "[lobby] '%s' reconnected via token\n", username);

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
                        std::fprintf(stderr, "[lobby] registered new user '%s'\n", username);
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
                    std::fprintf(stderr, "[lobby] '%s' authenticated (id=%lld)\n", username, user->id);

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
                        std::fprintf(stderr,
                            "[lobby] RoomStartGame: unknown game '%s' for room %u\n",
                            room->gameName.c_str(), room->id);
                        break;
                    }
                    const std::string& roomGamePath = gpIt->second;

                    // Spawn game server, handing off the AI slot
                    // roster so the sim can load each plugin for the
                    // team the host assigned it to.
                    auto inst = spawnGameServer(room->id, roomGamePath, mapPath, dbPath, room->aiSlots);
                    gameServers[room->id] = inst;

                    // Store port on the room so clients get it via RoomStateUpdate
                    room->gameServerPort = static_cast<uint16_t>(inst.port);

                    BROADCAST_ROOM_UPDATE(room);

                    std::fprintf(stderr, "[lobby] room %u: game server on port %d\n",
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
                        std::fprintf(stderr,
                            "[lobby] RoomEndGame rejected: user %lld not host of room %u\n",
                            static_cast<long long>(session->userId), room->id);
                        break;
                    }
                    if (room->state != ERoomState::Loading &&
                        room->state != ERoomState::Active) {
                        std::fprintf(stderr,
                            "[lobby] RoomEndGame rejected: room %u not in game state\n",
                            room->id);
                        break;
                    }
                    auto it = gameServers.find(room->id);
                    if (it != gameServers.end() && isProcessAlive(it->second.pid)) {
                        kill(it->second.pid, SIGTERM);
                        std::fprintf(stderr,
                            "[lobby] host ended game for room %u (pid %d)\n",
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
                        std::fprintf(stderr,
                            "[lobby] RoomAddAI rejected: room %u has unknown game '%s'\n",
                            room->id, room->gameName.c_str());
                        break;
                    }
                    const std::string requestedId = addAI->ai_id()->str();
                    const AIDiscovery::AIInfo* match = nullptr;
                    for (const auto& ai : it->second) {
                        if (ai.id == requestedId) { match = &ai; break; }
                    }
                    if (!match) {
                        std::fprintf(stderr,
                            "[lobby] RoomAddAI rejected: unknown AI id '%s' for game '%s'\n",
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
                    std::fprintf(stderr, "[lobby] game server for room %u (pid %d) has exited\n",
                        roomId, inst.pid);
                    rooms.SetRoomState(roomId, ERoomState::Ended);
                }
            }
        }
    }

    std::fprintf(stderr, "[lobby] shutting down...\n");

    // Kill any running game servers
    for (auto& [roomId, inst] : gameServers) {
        if (isProcessAlive(inst.pid)) {
            kill(inst.pid, SIGTERM);
            std::fprintf(stderr, "[lobby] killed game server pid %d\n", inst.pid);
        }
    }

    net.Stop();
    db.Close();
    std::fprintf(stderr, "[lobby] exited cleanly\n");
    return 0;
}
