// libspringapi — WebRTC implementation using libdatachannel.
// Provides client-side peer connection with HTTP signaling.

#include "springapi/springapi.h"

#ifdef SPRINGAPI_HAS_WEBRTC
#include <rtc/rtc.hpp>
#include <cstring>
#include <mutex>
#include <thread>
#include <chrono>

namespace springapi {

class RtcConnectionImpl : public RtcConnection {
public:
    RtcConnectionImpl(std::shared_ptr<rtc::PeerConnection> pc,
                      std::shared_ptr<rtc::DataChannel> control,
                      std::shared_ptr<rtc::DataChannel> state,
                      uint32_t cid)
        : pc_(pc), control_(control), state_(state), clientId_(cid) {

        control_->onMessage([this](rtc::message_variant msg) {
            if (std::holds_alternative<rtc::binary>(msg)) {
                auto& bin = std::get<rtc::binary>(msg);
                std::lock_guard<std::mutex> lock(cbMutex_);
                if (controlCb_)
                    controlCb_(reinterpret_cast<const uint8_t*>(bin.data()), bin.size());
            }
        });

        state_->onMessage([this](rtc::message_variant msg) {
            if (std::holds_alternative<rtc::binary>(msg)) {
                auto& bin = std::get<rtc::binary>(msg);
                std::lock_guard<std::mutex> lock(cbMutex_);
                if (stateCb_)
                    stateCb_(reinterpret_cast<const uint8_t*>(bin.data()), bin.size());
            }
        });

        pc_->onStateChange([this](rtc::PeerConnection::State s) {
            std::lock_guard<std::mutex> lock(cbMutex_);
            if (stateCbState_) {
                switch (s) {
                    case rtc::PeerConnection::State::Connected: stateCbState_("connected"); break;
                    case rtc::PeerConnection::State::Disconnected: stateCbState_("disconnected"); break;
                    case rtc::PeerConnection::State::Failed: stateCbState_("failed"); break;
                    case rtc::PeerConnection::State::Closed: stateCbState_("closed"); break;
                    default: break;
                }
            }
        });
    }

    void onControlMessage(DataCallback cb) override {
        std::lock_guard<std::mutex> lock(cbMutex_);
        controlCb_ = std::move(cb);
    }

    void onStateMessage(DataCallback cb) override {
        std::lock_guard<std::mutex> lock(cbMutex_);
        stateCb_ = std::move(cb);
    }

    void onStateChange(StateCallback cb) override {
        std::lock_guard<std::mutex> lock(cbMutex_);
        stateCbState_ = std::move(cb);
    }

    bool sendControl(const uint8_t* data, size_t len) override {
        if (!control_ || !control_->isOpen()) return false;
        control_->send(reinterpret_cast<const std::byte*>(data), len);
        return true;
    }

    bool sendState(const uint8_t* data, size_t len) override {
        if (!state_ || !state_->isOpen()) return false;
        state_->send(reinterpret_cast<const std::byte*>(data), len);
        return true;
    }

    bool isOpen() const override {
        return control_ && control_->isOpen() && state_ && state_->isOpen();
    }

    void close() override {
        if (control_) control_->close();
        if (state_) state_->close();
        if (pc_) pc_->close();
    }

    uint32_t clientId() const override { return clientId_; }

private:
    std::shared_ptr<rtc::PeerConnection> pc_;
    std::shared_ptr<rtc::DataChannel> control_;
    std::shared_ptr<rtc::DataChannel> state_;
    uint32_t clientId_;

    std::mutex cbMutex_;
    DataCallback controlCb_;
    DataCallback stateCb_;
    StateCallback stateCbState_;
};

RtcConnectionPtr connectRtc(const std::string& serverUrl,
                             const std::string& authToken) {
    rtc::Configuration config;
    config.iceServers.emplace_back("stun:stun.l.google.com:19302");

    auto pc = std::make_shared<rtc::PeerConnection>(config);

    // Create negotiated channels matching the server
    rtc::DataChannelInit controlInit;
    controlInit.negotiated = true;
    controlInit.id = static_cast<uint16_t>(0);
    auto control = pc->createDataChannel("control", controlInit);

    rtc::DataChannelInit stateInit;
    stateInit.negotiated = true;
    stateInit.id = static_cast<uint16_t>(1);
    stateInit.reliability.unordered = true;
    stateInit.reliability.maxRetransmits = 0;
    auto state = pc->createDataChannel("state", stateInit);

    // Generate and gather offer
    pc->setLocalDescription(rtc::Description::Type::Offer);

    // Wait for ICE gathering (up to 3s)
    for (int i = 0; i < 60; i++) {
        if (pc->gatheringState() == rtc::PeerConnection::GatheringState::Complete)
            break;
        std::this_thread::sleep_for(std::chrono::milliseconds(50));
    }

    auto localDesc = pc->localDescription();
    if (!localDesc) return nullptr;

    std::string sdpOffer = std::string(localDesc.value());

    // Send offer via HTTP
    std::string body = "{\"sdp\":\"" + jsonEscape(sdpOffer) + "\"}";
    std::string resp = httpPost(serverUrl + "/api/rtc/offer", body, authToken);
    if (resp.empty()) return nullptr;

    std::string sdpAnswer = jsonExtract(resp, "sdp");
    std::string cidStr = jsonExtract(resp, "client_id");
    if (sdpAnswer.empty()) return nullptr;

    uint32_t cid = cidStr.empty() ? 0 : static_cast<uint32_t>(std::atoi(cidStr.c_str()));

    // Set remote description
    pc->setRemoteDescription(rtc::Description(sdpAnswer, rtc::Description::Type::Answer));

    // Wait for channels to open (up to 5s)
    for (int i = 0; i < 100; i++) {
        if (control->isOpen() && state->isOpen()) break;
        std::this_thread::sleep_for(std::chrono::milliseconds(50));
    }

    if (!control->isOpen() || !state->isOpen()) {
        pc->close();
        return nullptr;
    }

    return std::make_shared<RtcConnectionImpl>(pc, control, state, cid);
}

} // namespace springapi

#else // !SPRINGAPI_HAS_WEBRTC

namespace springapi {

RtcConnectionPtr connectRtc(const std::string& /*serverUrl*/,
                             const std::string& /*authToken*/) {
    return nullptr; // WebRTC not available in this build
}

} // namespace springapi

#endif
