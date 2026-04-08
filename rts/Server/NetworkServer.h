/**
 * NetworkServer — WebSocket server running on a dedicated thread.
 *
 * Accepts client connections, receives binary messages, and provides
 * a thread-safe interface for the sim thread to drain inbound messages
 * and broadcast outbound data.
 */
#pragma once

#include <atomic>
#include <cstdint>
#include <memory>
#include <mutex>
#include <thread>
#include <vector>

/// Identifies a connected client.
using ClientID = uint32_t;

/// An inbound message from a client.
struct InboundMessage {
    ClientID clientId;
    std::vector<uint8_t> data;
};

class NetworkServer {
public:
    NetworkServer();
    ~NetworkServer();

    /// Start listening on the given port. Spawns the network thread.
    bool Start(int port);

    /// Stop the server and join the network thread.
    void Stop();

    /// Drain all inbound messages received since the last call.
    /// Called from the sim thread each tick.
    std::vector<InboundMessage> DrainInbound();

    /// Send a binary message to a specific client.
    /// Thread-safe — can be called from the sim thread.
    void Send(ClientID clientId, const uint8_t* data, size_t len);

    /// Send a binary message to all connected clients.
    /// Thread-safe — can be called from the sim thread.
    void Broadcast(const uint8_t* data, size_t len);

    /// Number of currently connected clients.
    int GetClientCount() const { return clientCount.load(); }

private:
    void NetworkThreadFunc(int port);

    std::thread networkThread;
    std::atomic<bool> running{false};
    std::atomic<int> clientCount{0};

    // Inbound message queue (network thread writes, sim thread reads)
    std::mutex inboundMutex;
    std::vector<InboundMessage> inboundQueue;

    // Opaque pointer to uWS loop for cross-thread wakeup
    struct Impl;
    std::unique_ptr<Impl> impl;
};
