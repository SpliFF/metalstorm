/**
 * spring-server entry point
 *
 * Headless authoritative game server. Runs the simulation at a fixed
 * 30 Hz tick rate with a WebSocket server for client connections.
 */

#include "Server/Simulation.h"
#include "Server/NetworkServer.h"
#include "Server/Protocol.h"
#include "Server/Database.h"
#include "Server/ClientSession.h"
#include "Server/EntityStateSerializer.h"
#include "Server/ContentServer.h"
#include "Server/CombatEventCollector.h"
#include "Server/StandingOrders.h"
#include "Server/AI/AIRuntimePool.h"
#include "Server/PerfMetrics.h"
#include "Sim/Units/UnitHandler.h"
#include "Sim/Units/Unit.h"
#include "Sim/Units/CommandAI/CommandAI.h"
#include "Sim/Units/CommandAI/Command.h"
#include "Sim/Misc/GlobalConstants.h"
#include "Map/ReadMap.h"
#include "System/FileSystem/FileHandler.h"
#include "System/Misc/SpringTime.h"

#include <csignal>
#include <cstdio>
#include <atomic>
#include <chrono>
#include <filesystem>
#include <random>
#include <thread>

static std::atomic<bool> keepRunning{true};

static void signalHandler(int) {
    keepRunning.store(false);
}

/// Generate a random hex session token.
static std::string generateToken(int length = 32) {
    static const char hex[] = "0123456789abcdef";
    static std::mt19937 rng(std::random_device{}());
    std::uniform_int_distribution<int> dist(0, 15);
    std::string token;
    token.reserve(length);
    for (int i = 0; i < length; i++)
        token += hex[dist(rng)];
    return token;
}

int main(int argc, char* argv[])
{
    std::signal(SIGINT, signalHandler);
    std::signal(SIGTERM, signalHandler);

    int port = 9001;
    std::string gamePath;
    std::string mapPath;
    std::string dbPath = "data/spring-server.db";

    // Simple arg parsing: --port N, --game PATH, --map PATH, --db PATH
    for (int i = 1; i < argc; i++) {
        std::string arg = argv[i];
        if (arg == "--port" && i + 1 < argc) {
            port = std::atoi(argv[++i]);
        } else if (arg == "--game" && i + 1 < argc) {
            gamePath = argv[++i];
        } else if (arg == "--map" && i + 1 < argc) {
            mapPath = argv[++i];
        } else if (arg == "--db" && i + 1 < argc) {
            dbPath = argv[++i];
        } else if (arg[0] != '-') {
            // Legacy: bare number = port
            port = std::atoi(argv[i]);
        }
    }

    std::fprintf(stderr, "[spring-server] starting...\n");

    // Initialise Spring's time system
    spring_clock::PushTickRate(true);
    spring_time::setstarttime(spring_time::gettime(true));

    // --- Content roots ---
    // Game content is searched first, then map, then cwd
    if (!gamePath.empty()) {
        CFileHandler::AddContentRoot(gamePath);
        std::fprintf(stderr, "[spring-server] game content: %s\n", gamePath.c_str());
    }
    if (!mapPath.empty()) {
        CFileHandler::AddContentRoot(mapPath);
        std::fprintf(stderr, "[spring-server] map content: %s\n", mapPath.c_str());
    }
    // Engine base content (gamedata/defs.lua, system.lua, gadgets, etc.)
    CFileHandler::AddContentRoot("cont/base/springcontent");
    // Always search cwd as fallback
    CFileHandler::AddContentRoot(".");

    // --- Database ---
    Database db;
    if (!db.Open(dbPath)) {
        std::fprintf(stderr, "[spring-server] ERROR: failed to open database\n");
        return 1;
    }

    // --- Sessions ---
    SessionManager sessions;

    // --- AI ---
    AIRuntimePool aiPool;

    // --- Network ---
    NetworkServer net;

    // HTTP endpoints for terrain data (handlers check readMap at request time)
    net.AddHttpGet("/api/map/heightmap", [](const std::string&) -> HttpResponse {
        if (readMap == nullptr)
            return {.contentType = "text/plain", .body = {}, .status = 404};

        const float* hm = readMap->GetCornerHeightMapSynced();
        int w = mapDims.mapxp1;
        int h = mapDims.mapyp1;

        // Binary format: u32 width, u32 height, then f32[w*h] row-major
        size_t headerSize = 8;
        size_t dataSize = w * h * sizeof(float);
        std::vector<uint8_t> body(headerSize + dataSize);

        uint32_t wu = static_cast<uint32_t>(w);
        uint32_t hu = static_cast<uint32_t>(h);
        memcpy(body.data(), &wu, 4);
        memcpy(body.data() + 4, &hu, 4);
        memcpy(body.data() + 8, hm, dataSize);

        return {.contentType = "application/octet-stream", .body = std::move(body), .status = 200};
    });

    net.AddHttpGet("/api/map/info", [](const std::string&) -> HttpResponse {
        if (readMap == nullptr)
            return {.contentType = "text/plain", .body = {}, .status = 404};

        // Simple JSON with map dimensions
        char buf[256];
        int len = snprintf(buf, sizeof(buf),
            "{\"mapx\":%d,\"mapy\":%d,\"squareSize\":%d,\"widthElmos\":%d,\"heightElmos\":%d}",
            mapDims.mapx, mapDims.mapy, SQUARE_SIZE,
            mapDims.mapx * SQUARE_SIZE, mapDims.mapy * SQUARE_SIZE);

        std::vector<uint8_t> body(buf, buf + len);
        return {.contentType = "application/json", .body = std::move(body), .status = 200};
    });

    // Performance metrics endpoint
    net.AddHttpGet("/api/metrics", [](const std::string&) -> HttpResponse {
        std::string json = perfMetrics.ToJSON();
        std::vector<uint8_t> body(json.begin(), json.end());
        return {.contentType = "application/json", .body = std::move(body), .status = 200};
    });

    // --- Content server ---
    ContentServer content;
    {
        std::vector<std::string> contentRoots;
        if (!gamePath.empty()) contentRoots.push_back(gamePath);
        if (!mapPath.empty()) contentRoots.push_back(mapPath);
        content.Init(net, contentRoots);
    }

    if (!net.Start(port)) {
        std::fprintf(stderr, "[spring-server] ERROR: failed to start network server\n");
        return 1;
    }

    // --- Simulation ---
    // Find .smf file in the map directory
    std::string smfPath;
    if (!mapPath.empty()) {
        namespace fs = std::filesystem;
        for (auto& entry : fs::recursive_directory_iterator(mapPath)) {
            if (entry.is_regular_file() && entry.path().extension() == ".smf") {
                smfPath = entry.path().string();
                break;
            }
        }
        if (smfPath.empty())
            std::fprintf(stderr, "[spring-server] WARNING: no .smf file found in %s\n", mapPath.c_str());
    }

    CSimulation sim;
    sim.Init(smfPath);

    // --- Fixed-timestep loop at GAME_SPEED Hz (30 Hz) ---
    const auto tickInterval = std::chrono::microseconds(1'000'000 / GAME_SPEED);
    auto nextTick = std::chrono::steady_clock::now();

    std::fprintf(stderr, "[spring-server] entering sim loop at %d Hz (port %d)\n", GAME_SPEED, port);

    while (keepRunning.load()) {
        // Wait for next tick
        auto now = std::chrono::steady_clock::now();
        if (now < nextTick) {
            std::this_thread::sleep_until(nextTick);
        }
        nextTick += tickInterval;

        // If we fell behind, skip ticks rather than accumulating
        now = std::chrono::steady_clock::now();
        if (now > nextTick + tickInterval) {
            int skipped = 0;
            while (nextTick + tickInterval < now) {
                nextTick += tickInterval;
                skipped++;
            }
            if (skipped > 0) {
                std::fprintf(stderr, "[spring-server] WARNING: sim fell behind, skipped %d ticks\n", skipped);
            }
        }

        perfMetrics.BeginTick();
        sessions.ResetTickCounters();

        // Drain inbound messages from clients
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
                    auto pong = Protocol::BuildPong(
                        ping->client_time(),
                        static_cast<uint64_t>(sim.GetFrameNum()));
                    net.Send(msg.clientId, pong.data(), pong.size());
                    break;
                }
                case SpringWeb::ClientPayload_Handshake: {
                    auto* hs = clientMsg->payload_as_Handshake();
                    std::fprintf(stderr, "[spring-server] handshake from client %u: v%d %s\n",
                        msg.clientId,
                        hs->protocol_version(),
                        hs->client_version() ? hs->client_version()->c_str() : "unknown");
                    break;
                }
                case SpringWeb::ClientPayload_AuthRequest: {
                    auto* auth = clientMsg->payload_as_AuthRequest();
                    const char* username = auth->username() ? auth->username()->c_str() : "";
                    const char* passHash = auth->password_hash() ? auth->password_hash()->c_str() : "";

                    // Try token-based reconnection first
                    if (auth->token() && auth->token()->size() > 0) {
                        int64_t userId = db.ValidateSession(auth->token()->str());
                        if (userId > 0) {
                            auto resp = Protocol::BuildAuthResponse(
                                SpringWeb::AuthStatus_OK, auth->token()->str(),
                                static_cast<uint32_t>(userId));
                            net.Send(msg.clientId, resp.data(), resp.size());
                            std::fprintf(stderr, "[auth] client %u reconnected as user %lld\n",
                                msg.clientId, userId);
                            break;
                        }
                    }

                    // Look up or create user
                    auto user = db.FindUser(username);
                    if (!user) {
                        // Auto-register for now (Phase 1 MVP)
                        int64_t newId = db.CreateUser(username, passHash);
                        if (newId == 0) {
                            auto resp = Protocol::BuildAuthResponse(
                                SpringWeb::AuthStatus_InvalidCredentials, "", 0,
                                "Registration failed");
                            net.Send(msg.clientId, resp.data(), resp.size());
                            break;
                        }
                        user = db.FindUser(username);
                    }

                    // Check password
                    if (user->passwordHash != passHash) {
                        auto resp = Protocol::BuildAuthResponse(
                            SpringWeb::AuthStatus_InvalidCredentials, "", 0,
                            "Wrong password");
                        net.Send(msg.clientId, resp.data(), resp.size());
                        break;
                    }

                    // Check ban
                    if (user->isBanned) {
                        auto resp = Protocol::BuildAuthResponse(
                            SpringWeb::AuthStatus_AccountBanned, "", 0,
                            "Account banned");
                        net.Send(msg.clientId, resp.data(), resp.size());
                        break;
                    }

                    // Create session
                    std::string token = generateToken();
                    db.CreateSession(user->id, token);

                    auto resp = Protocol::BuildAuthResponse(
                        SpringWeb::AuthStatus_OK, token,
                        static_cast<uint32_t>(user->id));
                    net.Send(msg.clientId, resp.data(), resp.size());
                    sessions.AddSession(msg.clientId, user->id, user->username, user->role);
                    std::fprintf(stderr, "[auth] client %u authenticated as '%s' (id=%lld)\n",
                        msg.clientId, username, user->id);
                    break;
                }
                case SpringWeb::ClientPayload_PlayerCommand: {
                    auto* session = sessions.GetSession(msg.clientId);
                    if (!session) {
                        auto err = Protocol::BuildServerError(401, "Not authenticated");
                        net.Send(msg.clientId, err.data(), err.size());
                        break;
                    }

                    // Rate limiting
                    if (session->commandsThisTick >= SessionManager::MAX_COMMANDS_PER_TICK) {
                        auto err = Protocol::BuildServerError(429, "Command rate limit exceeded");
                        net.Send(msg.clientId, err.data(), err.size());
                        break;
                    }
                    session->commandsThisTick++;

                    auto* cmd = clientMsg->payload_as_PlayerCommand();

                    // Sequence validation (must be monotonically increasing)
                    if (cmd->sequence() <= session->lastCommandSeq && session->lastCommandSeq > 0) {
                        auto err = Protocol::BuildServerError(400, "Stale command sequence");
                        net.Send(msg.clientId, err.data(), err.size());
                        break;
                    }
                    session->lastCommandSeq = cmd->sequence();

                    // Build a Command from the PlayerCommand message
                    {
                        Command simCmd(cmd->command_id(), static_cast<unsigned char>(cmd->options()));
                        if (cmd->timeout_frames() > 0)
                            simCmd.SetTimeOut(static_cast<int>(cmd->timeout_frames()));

                        // Copy parameters
                        if (cmd->params()) {
                            for (unsigned i = 0; i < cmd->params()->size(); i++)
                                simCmd.PushParam(cmd->params()->Get(i));
                        }

                        // Route command to each target unit
                        int routed = 0;
                        if (cmd->squad_ids()) {
                            for (unsigned i = 0; i < cmd->squad_ids()->size(); i++) {
                                uint32_t unitId = cmd->squad_ids()->Get(i);
                                CUnit* unit = unitHandler.GetUnit(unitId);
                                if (unit == nullptr || unit->isDead)
                                    continue;
                                // TODO: validate team ownership (unit->team == session->team)
                                unit->commandAI->GiveCommand(simCmd);
                                routed++;
                            }
                        }

                        std::fprintf(stderr, "[cmd] client %u (%s): cmd=%d seq=%u routed=%d/%d\n",
                            msg.clientId, session->username.c_str(),
                            cmd->command_id(), cmd->sequence(),
                            routed, cmd->squad_ids() ? (int)cmd->squad_ids()->size() : 0);
                    }
                    break;
                }
                case SpringWeb::ClientPayload_ViewportUpdate: {
                    auto* session = sessions.GetSession(msg.clientId);
                    if (!session) {
                        auto err = Protocol::BuildServerError(401, "Not authenticated");
                        net.Send(msg.clientId, err.data(), err.size());
                        break;
                    }

                    auto* vpu = clientMsg->payload_as_ViewportUpdate();
                    int vpId = vpu->viewport_id();
                    if (vpId >= MAX_VIEWPORTS) {
                        auto err = Protocol::BuildServerError(400, "Invalid viewport ID");
                        net.Send(msg.clientId, err.data(), err.size());
                        break;
                    }

                    auto& vp = session->viewports[vpId];
                    vp.centerX   = vpu->center_x();
                    vp.centerZ   = vpu->center_z();
                    vp.width     = vpu->width();
                    vp.height    = vpu->height();
                    vp.rotation  = vpu->rotation();
                    vp.zoomLevel = vpu->zoom_level();
                    vp.active    = (vp.width > 0.0f && vp.height > 0.0f);
                    break;
                }
                default:
                    break;
            }
        }

        sim.SimFrame();

        // Send entity state to connected clients every 3 ticks (~10 Hz)
        // Full snapshot every 30 ticks (~1s), delta updates otherwise.
        // Envelope: 0x02 = full snapshot, 0x03 = delta update.
        {
        int curFrame = sim.GetFrameNum();
        if (curFrame >= 0 && (curFrame % 3) == 0 && net.GetClientCount() > 0) {
            bool isFullSnapshot = (curFrame % 30) == 0;

            sessions.ForEachSession([&](ClientID clientId, ClientSession& session) {
                // Collect candidate units (viewport-filtered or all)
                std::vector<CUnit*> candidates;
                if (session.HasViewport() && sim.HasMap()) {
                    candidates = EntityState::CollectViewportUnits(
                        session.viewports.data(),
                        static_cast<int>(session.viewports.size()));
                } else {
                    candidates = EntityState::CollectAllUnits();
                }

                uint8_t envelope;
                std::vector<uint8_t> stateData;

                if (isFullSnapshot) {
                    // Full snapshot — send all candidates, reset cache
                    envelope = 0x02;
                    stateData = EntityState::SerializeUnits(candidates);
                    session.deltaCache.Clear();
                    for (CUnit* u : candidates)
                        session.deltaCache.Update(u);
                } else {
                    // Delta — only send changed entities
                    std::vector<CUnit*> changed;
                    for (CUnit* u : candidates) {
                        if (session.deltaCache.HasChanged(u))
                            changed.push_back(u);
                    }

                    // Update cache for changed entities
                    for (CUnit* u : changed)
                        session.deltaCache.Update(u);

                    envelope = 0x03;
                    stateData = EntityState::SerializeUnits(changed);
                }

                // Prepend envelope byte
                std::vector<uint8_t> frame;
                frame.reserve(1 + stateData.size());
                frame.push_back(envelope);
                frame.insert(frame.end(), stateData.begin(), stateData.end());
                net.Send(clientId, frame.data(), frame.size());
            });
        }
        }

        // Evaluate standing orders every ~1s (30 ticks)
        if (sim.GetFrameNum() > 0 && (sim.GetFrameNum() % 30) == 0) {
            standingOrders.Evaluate();
        }

        // Tick AI runtime and drain AI commands
        aiPool.Tick(sim.GetFrameNum());
        {
            auto aiCmds = aiPool.DrainCommands();
            for (const auto& cmd : aiCmds) {
                CUnit* unit = unitHandler.GetUnit(cmd.unitId);
                if (unit == nullptr || unit->isDead) continue;
                if (unit->team != cmd.teamId) continue; // validate ownership

                Command simCmd(cmd.commandId, cmd.options);
                for (int i = 0; i < cmd.numParams; i++)
                    simCmd.PushParam(cmd.params[i]);
                unit->commandAI->GiveCommand(simCmd);
            }
        }

        // Broadcast combat events to all connected clients
        {
        auto events = combatEvents.Drain();
        if (!events.empty() && net.GetClientCount() > 0) {
            auto batch = Protocol::BuildCombatEventBatch(
                static_cast<uint32_t>(sim.GetFrameNum()), events);
            net.Broadcast(batch.data(), batch.size());
        }
        }

        perfMetrics.SetFrame(sim.GetFrameNum());
        perfMetrics.SetClientCount(net.GetClientCount());
        perfMetrics.SetAICount(static_cast<int>(aiPool.GetAICount()));
        perfMetrics.EndTick();

        // Periodic status
        int frame = sim.GetFrameNum();
        if (frame > 0 && (frame % (GAME_SPEED * 10)) == 0) {
            std::fprintf(stderr, "[spring-server] frame %d (%.1fs) clients=%d\n",
                frame, frame / (float)GAME_SPEED, net.GetClientCount());
        }
    }

    std::fprintf(stderr, "[spring-server] shutting down (frame %d)...\n", sim.GetFrameNum());
    net.Stop();
    sim.Kill();
    db.Close();
    std::fprintf(stderr, "[spring-server] exited cleanly\n");

    return 0;
}
