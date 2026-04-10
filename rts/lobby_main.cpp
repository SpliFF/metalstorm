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

/// Decode DXT1 minimap from SMF file and return as BMP bytes.
static std::vector<uint8_t> extractSMFMinimapBMP(const std::string& smfPath) {
    std::ifstream f(smfPath, std::ios::binary);
    if (!f.is_open()) return {};

    f.seekg(52); // offset to minimapPtr in SMF header
    int minimapPtr = 0;
    f.read(reinterpret_cast<char*>(&minimapPtr), 4);
    if (minimapPtr <= 0) return {};

    const int W = 1024, H = 1024;
    f.seekg(minimapPtr);
    std::vector<uint8_t> dxt(W * H / 2);
    f.read(reinterpret_cast<char*>(dxt.data()), dxt.size());
    if (!f.good()) return {};

    // Decode DXT1 to RGB
    std::vector<uint8_t> rgb(W * H * 3);
    for (int by = 0; by < H / 4; by++) {
        for (int bx = 0; bx < W / 4; bx++) {
            const uint8_t* src = &dxt[(by * (W/4) + bx) * 8];
            uint16_t c0 = src[0] | (src[1] << 8);
            uint16_t c1 = src[2] | (src[3] << 8);
            uint32_t bits = src[4] | (src[5]<<8) | (src[6]<<16) | (src[7]<<24);

            uint8_t colors[4][3];
            colors[0][0]=((c0>>11)&0x1f)*255/31; colors[0][1]=((c0>>5)&0x3f)*255/63; colors[0][2]=(c0&0x1f)*255/31;
            colors[1][0]=((c1>>11)&0x1f)*255/31; colors[1][1]=((c1>>5)&0x3f)*255/63; colors[1][2]=(c1&0x1f)*255/31;
            if (c0 > c1) {
                for (int i=0;i<3;i++) { colors[2][i]=(2*colors[0][i]+colors[1][i])/3; colors[3][i]=(colors[0][i]+2*colors[1][i])/3; }
            } else {
                for (int i=0;i<3;i++) colors[2][i]=(colors[0][i]+colors[1][i])/2;
                colors[3][0]=colors[3][1]=colors[3][2]=0;
            }

            for (int py=0;py<4;py++) for (int px=0;px<4;px++) {
                int idx = (bits >> (2*(py*4+px))) & 3;
                int x=bx*4+px, y=by*4+py, o=(y*W+x)*3;
                rgb[o]=colors[idx][0]; rgb[o+1]=colors[idx][1]; rgb[o+2]=colors[idx][2];
            }
        }
    }

    // Encode as BMP (top-down, 24bpp)
    int rowBytes = W * 3, padRow = (4-(rowBytes%4))%4;
    int imgSize = (rowBytes+padRow)*H, fileSize = 54+imgSize;
    std::vector<uint8_t> bmp(fileSize, 0);
    bmp[0]='B'; bmp[1]='M';
    memcpy(&bmp[2], &fileSize, 4);
    int off=54; memcpy(&bmp[10], &off, 4);
    int dib=40; memcpy(&bmp[14], &dib, 4);
    memcpy(&bmp[18], &W, 4);
    int negH=-H; memcpy(&bmp[22], &negH, 4);
    short planes=1, bpp=24;
    memcpy(&bmp[26], &planes, 2); memcpy(&bmp[28], &bpp, 2);
    memcpy(&bmp[34], &imgSize, 4);
    int d=54;
    for (int y=0;y<H;y++) {
        for (int x=0;x<W;x++) { int s=(y*W+x)*3; bmp[d++]=rgb[s+2]; bmp[d++]=rgb[s+1]; bmp[d++]=rgb[s]; }
        d += padRow;
    }
    return bmp;
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
static GameServerInstance spawnGameServer(
    uint32_t roomId, const std::string& gamePath,
    const std::string& mapPath, const std::string& dbPath)
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
        execlp(serverBin.c_str(), serverBin.c_str(),
               "--port", portStr.c_str(),
               "--game", gamePath.c_str(),
               "--map", mapPath.c_str(),
               "--db", dbPath.c_str(),
               nullptr);
        // If execlp returns, it failed
        fprintf(stderr, "ERROR: failed to exec game server: %s\n", serverBin.c_str());
        _exit(1);
    } else if (pid > 0) {
        inst.pid = pid;
        inst.state = GameServerInstance::Starting;
        std::fprintf(stderr, "[lobby] spawned game server pid=%d port=%d for room %u\n",
            pid, inst.port, roomId);
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
    std::string gamePath = "content/games/papertanks";
    std::string mapsDir = "content/maps";

    for (int i = 1; i < argc; i++) {
        std::string arg = argv[i];
        if (arg == "--port" && i + 1 < argc) port = std::atoi(argv[++i]);
        else if (arg == "--db" && i + 1 < argc) dbPath = argv[++i];
        else if (arg == "--game" && i + 1 < argc) gamePath = argv[++i];
        else if (arg == "--maps" && i + 1 < argc) mapsDir = argv[++i];
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

        return {
            .contentType = ct,
            .body = std::move(data),
            .status = 200,
            .cacheControl = "public, max-age=3600",
        };
    });

    // Map thumbnail endpoint
    net.AddHttpGet("/api/maps/thumb/*", [&mapsDir](const std::string& url) -> HttpResponse {
        std::string mapId = url.substr(std::string("/api/maps/thumb/").size());
        namespace fs = std::filesystem;
        fs::path mapDir = fs::path(mapsDir) / mapId;
        if (!fs::is_directory(mapDir))
            return {.contentType = "text/plain", .body = {}, .status = 404};
        for (auto& entry : fs::recursive_directory_iterator(mapDir)) {
            if (!entry.is_regular_file()) continue;
            auto fname = entry.path().filename().string();
            auto ext = entry.path().extension().string();
            if (fname.find("minimap") != std::string::npos && (ext == ".png" || ext == ".jpg")) {
                std::ifstream f(entry.path(), std::ios::binary);
                std::vector<uint8_t> data((std::istreambuf_iterator<char>(f)),
                                           std::istreambuf_iterator<char>());
                return {
                    .contentType = (ext == ".png") ? "image/png" : "image/jpeg",
                    .body = std::move(data),
                    .status = 200,
                    .cacheControl = "public, max-age=3600",
                };
            }
        }
        // Fallback: extract minimap from SMF file
        for (auto& entry : fs::recursive_directory_iterator(mapDir)) {
            if (entry.is_regular_file() && entry.path().extension() == ".smf") {
                auto bmp = extractSMFMinimapBMP(entry.path().string());
                if (!bmp.empty())
                    return {
                        .contentType = "image/bmp",
                        .body = std::move(bmp),
                        .status = 200,
                        .cacheControl = "public, max-age=3600",
                    };
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
                    uint32_t roomId = rooms.CreateRoom(
                        rc->name() ? rc->name()->str() : "Game",
                        rc->map_name() ? rc->map_name()->str() : "",
                        rc->game_name() ? rc->game_name()->str() : "",
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

                    // Spawn game server
                    auto inst = spawnGameServer(room->id, gamePath, mapPath, dbPath);
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
