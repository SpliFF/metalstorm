// WebRTCServer — WebRTC data channel server using libdatachannel.

#include "WebRTCServer.h"
#include "NetworkServer.h"  // for InboundMessage
#include "System/SpringLog/SpringLog.h"

#include <rtc/rtc.hpp>
#include <cstring>

#define LOG_SECTION "webrtc"

WebRTCServer::WebRTCServer() = default;

WebRTCServer::~WebRTCServer() {
    Shutdown();
}

WebRTCServer::OfferResult WebRTCServer::HandleOffer(
    const std::string& sdpOffer, const std::string& /*authToken*/)
{
    // Guard against malformed/empty SDP that would crash libdatachannel
    if (sdpOffer.empty() || sdpOffer.find("v=0") == std::string::npos) {
        return {false, 0, "", "invalid SDP offer"};
    }

    try {
    return HandleOfferInner(sdpOffer);
    } catch (const std::exception& e) {
        SLOG(SPRING_LOG_ERROR, "WebRTC offer failed: %s", e.what());
        return {false, 0, "", std::string("WebRTC error: ") + e.what()};
    }
}

WebRTCServer::OfferResult WebRTCServer::HandleOfferInner(const std::string& sdpOffer)
{
    rtc::Configuration config;
    // STUN server for ICE candidate gathering (public Google STUN)
    config.iceServers.emplace_back("stun:stun.l.google.com:19302");
    // MapData can be several MB for large maps (heightmap + tileindex).
    // Default SCTP max message size is 256KB which is too small.
    config.maxMessageSize = 16 * 1024 * 1024; // 16 MB

    auto pc = std::make_shared<rtc::PeerConnection>(config);
    uint32_t clientId;

    {
        std::lock_guard<std::mutex> lock(mutex_);
        clientId = nextClientId_++;
    }

    SLOG(SPRING_LOG_INFO, "new peer connection for client %u", clientId);

    // Set up callbacks
    auto weakPc = std::weak_ptr<rtc::PeerConnection>(pc);

    pc->onStateChange([this, clientId](rtc::PeerConnection::State state) {
        SLOG(SPRING_LOG_INFO, "client %u state: %d", clientId, (int)state);
        if (state == rtc::PeerConnection::State::Disconnected ||
            state == rtc::PeerConnection::State::Failed ||
            state == rtc::PeerConnection::State::Closed) {
            std::lock_guard<std::mutex> lock(mutex_);
            auto it = peers_.find(clientId);
            if (it != peers_.end()) {
                it->second.connected = false;
                std::lock_guard<std::mutex> dlock(disconnectMutex_);
                disconnectQueue_.push_back(clientId);
            }
        }
    });

    pc->onGatheringStateChange([clientId](rtc::PeerConnection::GatheringState state) {
        SLOG(SPRING_LOG_DEBUG, "client %u gathering state: %d", clientId, (int)state);
    });

    // Create the two data channels server-side
    // The client will receive these via the onDataChannel callback

    // Control channel: reliable, ordered
    rtc::DataChannelInit controlInit;
    controlInit.negotiated = true;
    controlInit.id = static_cast<uint16_t>(0);
    auto controlDc = pc->createDataChannel("control", controlInit);

    controlDc->onOpen([this, clientId]() {
        SLOG(SPRING_LOG_NOTICE, "client %u control channel open", clientId);
        std::lock_guard<std::mutex> lock(mutex_);
        auto it = peers_.find(clientId);
        if (it != peers_.end()) it->second.connected = true;
    });

    controlDc->onMessage([this, clientId](rtc::message_variant message) {
        if (std::holds_alternative<rtc::binary>(message)) {
            auto& bin = std::get<rtc::binary>(message);
            InboundMessage msg;
            msg.clientId = clientId;
            msg.data.resize(bin.size());
            std::memcpy(msg.data.data(), bin.data(), bin.size());
            std::lock_guard<std::mutex> lock(inboundMutex_);
            inboundQueue_.push_back(std::move(msg));
        }
    });

    controlDc->onClosed([clientId]() {
        SLOG(SPRING_LOG_INFO, "client %u control channel closed", clientId);
    });

    // State channel: unreliable, unordered
    rtc::DataChannelInit stateInit;
    stateInit.negotiated = true;
    stateInit.id = static_cast<uint16_t>(1);
    stateInit.reliability.unordered = true;
    stateInit.reliability.maxRetransmits = 0;
    auto stateDc = pc->createDataChannel("state", stateInit);

    stateDc->onOpen([clientId]() {
        SLOG(SPRING_LOG_INFO, "client %u state channel open", clientId);
    });

    stateDc->onMessage([this, clientId](auto message) {
        // Binary message from state channel (client→server viewport updates etc.)
        if (std::holds_alternative<rtc::binary>(message)) {
            auto& bin = std::get<rtc::binary>(message);
            InboundMessage msg;
            msg.clientId = clientId;
            msg.data.resize(bin.size());
            std::memcpy(msg.data.data(), bin.data(), bin.size());
            std::lock_guard<std::mutex> lock(inboundMutex_);
            inboundQueue_.push_back(std::move(msg));
        }
    });

    // Set the remote description (client's offer).
    // libdatachannel auto-generates the answer and transitions to stable.
    pc->setRemoteDescription(rtc::Description(sdpOffer, rtc::Description::Type::Offer));

    auto desc = pc->localDescription();
    if (!desc) {
        return {false, 0, "", "failed to generate SDP answer"};
    }

    // Store the peer
    {
        std::lock_guard<std::mutex> lock(mutex_);
        PeerState state;
        state.clientId = clientId;
        state.pc = pc;
        state.controlChannel = controlDc;
        state.stateChannel = stateDc;
        peers_[clientId] = std::move(state);
    }

    std::string answer = std::string(desc.value());
    return {true, clientId, answer, ""};
}

bool WebRTCServer::AddCandidate(uint32_t clientId,
                                 const std::string& candidate,
                                 const std::string& mid) {
    std::lock_guard<std::mutex> lock(mutex_);
    auto it = peers_.find(clientId);
    if (it == peers_.end()) return false;

    it->second.pc->addRemoteCandidate(rtc::Candidate(candidate, mid));
    return true;
}

void WebRTCServer::SendReliable(uint32_t clientId, const uint8_t* data, size_t len) {
    std::lock_guard<std::mutex> lock(mutex_);
    auto it = peers_.find(clientId);
    if (it == peers_.end() || !it->second.connected) return;
    auto& dc = it->second.controlChannel;
    if (dc && dc->isOpen()) {
        try {
            dc->send(reinterpret_cast<const std::byte*>(data), len);
        } catch (const std::exception& e) {
            SLOG(SPRING_LOG_ERROR, "SendReliable failed for client %u (%zu bytes): %s",
                clientId, len, e.what());
        }
    }
}

void WebRTCServer::SendUnreliable(uint32_t clientId, const uint8_t* data, size_t len) {
    std::lock_guard<std::mutex> lock(mutex_);
    auto it = peers_.find(clientId);
    if (it == peers_.end() || !it->second.connected) return;
    auto& dc = it->second.stateChannel;
    if (dc && dc->isOpen()) {
        try {
            dc->send(reinterpret_cast<const std::byte*>(data), len);
        } catch (const std::exception& e) {
            SLOG(SPRING_LOG_ERROR, "SendUnreliable failed for client %u (%zu bytes): %s",
                clientId, len, e.what());
        }
    }
}

void WebRTCServer::BroadcastReliable(const uint8_t* data, size_t len) {
    std::lock_guard<std::mutex> lock(mutex_);
    for (auto& [id, peer] : peers_) {
        if (!peer.connected) continue;
        auto& dc = peer.controlChannel;
        if (dc && dc->isOpen()) {
            dc->send(reinterpret_cast<const std::byte*>(data), len);
        }
    }
}

void WebRTCServer::BroadcastUnreliable(const uint8_t* data, size_t len) {
    std::lock_guard<std::mutex> lock(mutex_);
    for (auto& [id, peer] : peers_) {
        if (!peer.connected) continue;
        auto& dc = peer.stateChannel;
        if (dc && dc->isOpen()) {
            dc->send(reinterpret_cast<const std::byte*>(data), len);
        }
    }
}

std::vector<InboundMessage> WebRTCServer::DrainInbound() {
    std::lock_guard<std::mutex> lock(inboundMutex_);
    std::vector<InboundMessage> result;
    result.swap(inboundQueue_);
    return result;
}

std::vector<ClientID> WebRTCServer::DrainDisconnects() {
    std::lock_guard<std::mutex> lock(disconnectMutex_);
    std::vector<ClientID> result;
    result.swap(disconnectQueue_);
    return result;
}

int WebRTCServer::GetClientCount() const {
    std::lock_guard<std::mutex> lock(mutex_);
    int count = 0;
    for (auto& [id, peer] : peers_) {
        if (peer.connected) count++;
    }
    return count;
}

void WebRTCServer::Shutdown() {
    std::lock_guard<std::mutex> lock(mutex_);
    for (auto& [id, peer] : peers_) {
        if (peer.controlChannel) peer.controlChannel->close();
        if (peer.stateChannel) peer.stateChannel->close();
        if (peer.pc) peer.pc->close();
    }
    peers_.clear();
}
