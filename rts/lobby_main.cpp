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
#include "Server/RatingSystem.h"
#include "Server/PerfMetrics.h"

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

    pid_t pid = fork();
    if (pid == 0) {
        // Child process — exec the game server
        std::string portStr = std::to_string(inst.port);
        execlp(serverBin.c_str(), serverBin.c_str(),
               "--port", portStr.c_str(),
               "--game", gamePath.c_str(),
               "--map", mapPath.c_str(),
               "--db", dbPath.c_str(),
               nullptr);
        // If execlp returns, it failed
        std::fprintf(stderr, "[lobby] ERROR: failed to exec game server: %s\n", serverBin.c_str());
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

    // --- Game server instances ---
    std::unordered_map<uint32_t, GameServerInstance> gameServers; // roomId → instance

    // --- Network ---
    NetworkServer net;

    // Available maps endpoint
    net.AddHttpGet("/api/maps", [&mapsDir](const std::string&) -> HttpResponse {
        namespace fs = std::filesystem;
        std::string json = "[";
        bool first = true;
        if (!fs::is_directory(mapsDir))
            return {.contentType = "application/json", .body = {'[', ']'}, .status = 200};

        for (auto& mapDir : fs::directory_iterator(mapsDir)) {
            if (!mapDir.is_directory()) continue;
            std::string smfPath;
            for (auto& entry : fs::recursive_directory_iterator(mapDir.path())) {
                if (entry.is_regular_file() && entry.path().extension() == ".smf") {
                    smfPath = entry.path().string();
                    break;
                }
            }
            if (smfPath.empty()) continue;

            int mapx = 0, mapy = 0;
            {
                std::ifstream f(smfPath, std::ios::binary);
                if (f.is_open()) {
                    f.seekg(24); // skip magic(16) + version(4) + mapid(4)
                    f.read(reinterpret_cast<char*>(&mapx), 4);
                    f.read(reinterpret_cast<char*>(&mapy), 4);
                }
            }

            std::string dirName = mapDir.path().filename().string();
            if (!first) json += ",";
            first = false;
            char buf[256];
            snprintf(buf, sizeof(buf),
                "{\"id\":\"%s\",\"name\":\"%s\",\"mapx\":%d,\"mapy\":%d,"
                "\"widthElmos\":%d,\"heightElmos\":%d}",
                dirName.c_str(), dirName.c_str(), mapx, mapy, mapx * 8, mapy * 8);
            json += buf;
        }
        json += "]";
        std::vector<uint8_t> body(json.begin(), json.end());
        return {.contentType = "application/json", .body = std::move(body), .status = 200};
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
                return {.contentType = (ext == ".png") ? "image/png" : "image/jpeg",
                        .body = std::move(data), .status = 200};
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

                    auto user = db.FindUser(username);
                    if (!user) {
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
