// WebRTCServer — manages WebRTC peer connections for game clients.
//
// Each client establishes a peer connection via HTTP signaling:
//   POST /api/rtc/offer  → client SDP offer  → server SDP answer
//   POST /api/rtc/candidate → ICE candidate exchange
//
// Two data channels per peer:
//   "control" (id=0, ordered, reliable) — FlatBuffer messages
//   "state"   (id=1, unordered, unreliable) — entity/projectile state

#pragma once

#include <cstdint>
#include <functional>
#include <memory>
#include <mutex>
#include <string>
#include <unordered_map>
#include <vector>

// Forward declarations — libdatachannel types
namespace rtc {
    class PeerConnection;
    class DataChannel;
    struct Configuration;
}

using ClientID = uint32_t;

struct InboundMessage; // from NetworkServer.h

class WebRTCServer {
public:
    WebRTCServer();
    ~WebRTCServer();

    /// Handle an SDP offer from a client. Returns the SDP answer.
    /// Called from the HTTP POST handler.
    struct OfferResult {
        bool success;
        uint32_t clientId;    // assigned client ID
        std::string sdpAnswer;
        std::string error;
    };
    OfferResult HandleOffer(const std::string& sdpOffer, const std::string& authToken);

    /// Add a remote ICE candidate for a client.
    bool AddCandidate(uint32_t clientId, const std::string& candidate, const std::string& mid);

    /// Send data on the reliable (control) channel.
    void SendReliable(uint32_t clientId, const uint8_t* data, size_t len);

    /// Send data on the unreliable (state) channel.
    void SendUnreliable(uint32_t clientId, const uint8_t* data, size_t len);

    /// Broadcast to all connected clients on the reliable channel.
    void BroadcastReliable(const uint8_t* data, size_t len);

    /// Broadcast to all connected clients on the unreliable channel.
    void BroadcastUnreliable(const uint8_t* data, size_t len);

    /// Drain inbound messages from data channels (same interface as NetworkServer).
    std::vector<InboundMessage> DrainInbound();

    /// Drain disconnected client IDs.
    std::vector<ClientID> DrainDisconnects();

    /// Number of connected peers.
    int GetClientCount() const;

    /// Shut down all peer connections.
    void Shutdown();

private:
    struct PeerState {
        uint32_t clientId;
        std::shared_ptr<rtc::PeerConnection> pc;
        std::shared_ptr<rtc::DataChannel> controlChannel;
        std::shared_ptr<rtc::DataChannel> stateChannel;
        bool connected = false;
    };

    uint32_t nextClientId_ = 1;
    mutable std::mutex mutex_;
    std::unordered_map<uint32_t, PeerState> peers_;

    std::mutex inboundMutex_;
    std::vector<InboundMessage> inboundQueue_;

    std::mutex disconnectMutex_;
    std::vector<ClientID> disconnectQueue_;
};
