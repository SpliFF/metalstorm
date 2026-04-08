/**
 * Protocol helpers — envelope framing and message construction.
 *
 * Every WebSocket binary frame starts with a u8 envelope byte:
 *   0x01 = FlatBuffers message
 *   0x02 = Entity state update (custom binary, Tier 2)
 */
#pragma once

#include "protocol_generated.h"
#include <flatbuffers/flatbuffers.h>
#include <cstdint>
#include <vector>

namespace Protocol {

constexpr uint8_t ENVELOPE_FLATBUFFERS = 0x01;
constexpr uint8_t ENVELOPE_ENTITY_STATE = 0x02;

/// Build a framed ServerMessage (envelope byte + FlatBuffers payload).
inline std::vector<uint8_t> BuildServerMessage(
    flatbuffers::FlatBufferBuilder& fbb,
    SpringWeb::ServerPayload payload_type,
    flatbuffers::Offset<void> payload)
{
    auto msg = SpringWeb::CreateServerMessage(fbb, payload_type, payload);
    fbb.Finish(msg);

    const uint8_t* buf = fbb.GetBufferPointer();
    size_t size = fbb.GetSize();

    std::vector<uint8_t> frame;
    frame.reserve(1 + size);
    frame.push_back(ENVELOPE_FLATBUFFERS);
    frame.insert(frame.end(), buf, buf + size);
    return frame;
}

/// Parse a framed ClientMessage. Returns nullptr if invalid.
inline const SpringWeb::ClientMessage* ParseClientMessage(
    const uint8_t* data, size_t len)
{
    if (len < 2 || data[0] != ENVELOPE_FLATBUFFERS)
        return nullptr;

    auto verifier = flatbuffers::Verifier(data + 1, len - 1);
    if (!SpringWeb::VerifyClientMessageBuffer(verifier))
        return nullptr;

    return SpringWeb::GetClientMessage(data + 1);
}

/// Build a Pong response.
inline std::vector<uint8_t> BuildPong(uint64_t clientTime, uint64_t serverTime) {
    flatbuffers::FlatBufferBuilder fbb(128);
    auto pong = SpringWeb::CreatePong(fbb, clientTime, serverTime);
    return BuildServerMessage(fbb, SpringWeb::ServerPayload_Pong, pong.Union());
}

/// Build an AuthResponse.
inline std::vector<uint8_t> BuildAuthResponse(
    SpringWeb::AuthStatus status,
    const std::string& token,
    uint32_t playerId,
    const std::string& message = "")
{
    flatbuffers::FlatBufferBuilder fbb(256);
    auto resp = SpringWeb::CreateAuthResponseDirect(fbb, status,
        token.empty() ? nullptr : token.c_str(),
        playerId,
        message.empty() ? nullptr : message.c_str());
    return BuildServerMessage(fbb, SpringWeb::ServerPayload_AuthResponse, resp.Union());
}

/// Build a ServerError.
inline std::vector<uint8_t> BuildServerError(uint16_t code, const std::string& msg) {
    flatbuffers::FlatBufferBuilder fbb(256);
    auto err = SpringWeb::CreateServerErrorDirect(fbb, code, msg.c_str());
    return BuildServerMessage(fbb, SpringWeb::ServerPayload_ServerError, err.Union());
}

} // namespace Protocol
