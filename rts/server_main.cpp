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
#include "Sim/Misc/GlobalConstants.h"
#include "System/Misc/SpringTime.h"

#include <csignal>
#include <cstdio>
#include <atomic>
#include <thread>
#include <chrono>
#include <random>

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
    if (argc > 1) {
        port = std::atoi(argv[1]);
    }

    std::fprintf(stderr, "[spring-server] starting...\n");

    // Initialise Spring's time system
    spring_clock::PushTickRate(true);
    spring_time::setstarttime(spring_time::gettime(true));

    // --- Database ---
    Database db;
    if (!db.Open("spring-server.db")) {
        std::fprintf(stderr, "[spring-server] ERROR: failed to open database\n");
        return 1;
    }

    // --- Network ---
    NetworkServer net;
    if (!net.Start(port)) {
        std::fprintf(stderr, "[spring-server] ERROR: failed to start network server\n");
        return 1;
    }

    // --- Simulation ---
    CSimulation sim;
    sim.Init();

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
                    std::fprintf(stderr, "[auth] client %u authenticated as '%s' (id=%lld)\n",
                        msg.clientId, username, user->id);
                    break;
                }
                case SpringWeb::ClientPayload_PlayerCommand: {
                    // TODO: validate and feed to sim
                    auto* cmd = clientMsg->payload_as_PlayerCommand();
                    std::fprintf(stderr, "[spring-server] command from client %u: id=%d seq=%u\n",
                        msg.clientId, cmd->command_id(), cmd->sequence());
                    break;
                }
                default:
                    break;
            }
        }

        sim.SimFrame();

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
