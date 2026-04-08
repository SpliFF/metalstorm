/**
 * spring-server entry point
 *
 * Headless authoritative game server. Runs the simulation at a fixed
 * 30 Hz tick rate with a WebSocket server for client connections.
 */

#include "Server/Simulation.h"
#include "Server/NetworkServer.h"
#include "Sim/Misc/GlobalConstants.h"
#include "System/Misc/SpringTime.h"

#include <csignal>
#include <cstdio>
#include <atomic>
#include <thread>
#include <chrono>

static std::atomic<bool> keepRunning{true};

static void signalHandler(int) {
    keepRunning.store(false);
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
            // TODO: parse as FlatBuffers commands and feed to sim
            // For now, echo back as proof of connectivity
            net.Send(msg.clientId, msg.data.data(), msg.data.size());
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
    std::fprintf(stderr, "[spring-server] exited cleanly\n");

    return 0;
}
