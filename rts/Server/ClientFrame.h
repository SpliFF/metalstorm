/**
 * The inbound client frame: envelope byte, then a verified ClientMessage.
 *
 * One decoder, in a header light enough for anything to include (it pulls in
 * the generated schema and nothing else — Protocol.h, the historical home,
 * drags in the whole sim and cannot be reached from spring-tests).
 *
 * It exists because there were two. `Protocol::ParseClientMessage` skipped the
 * envelope byte before verifying; server_main's replay gate re-derived the same
 * step and did NOT (2026-08-05 → 2026-08-14), so it read `NONE` for every
 * well-formed message and refused nothing — a live client on a replay server
 * could send a `PlayerCommand` straight into a re-execution. A caller that
 * needs only the tag now asks this, and the two cannot drift apart.
 */
#pragma once

#include <cstddef>
#include <cstdint>

#include "protocol_generated.h"

namespace wireframe {

/// 0x01 — a FlatBuffers message. The other envelope values are server→client
/// binary payloads (Protocol.h names them all); only this one carries a
/// ClientMessage.
constexpr uint8_t kEnvelopeFlatBuffers = 0x01;

/// Parse a framed ClientMessage. nullptr for anything that is not one: a wrong
/// envelope byte, a frame too short to hold a root table, or a buffer the
/// FlatBuffers verifier rejects.
inline const SpringWeb::ClientMessage* ParseClientMessage(
    const uint8_t* data, size_t len)
{
    if (data == nullptr || len < 2 || data[0] != kEnvelopeFlatBuffers)
        return nullptr;

    // `data + 1`: the verifier must see the FlatBuffer, not the envelope. This
    // single statement is the whole defect above.
    auto verifier = flatbuffers::Verifier(data + 1, len - 1);
    if (!SpringWeb::VerifyClientMessageBuffer(verifier))
        return nullptr;

    return SpringWeb::GetClientMessage(data + 1);
}

/// Payload tag of a framed ClientMessage, or `ClientPayload_NONE` (0) when the
/// frame is not a parseable one. NONE is also a legal tag value, so a caller
/// that must tell "unparseable" from "empty payload" uses ParseClientMessage.
inline uint8_t PeekClientPayloadType(const uint8_t* data, size_t len) {
    const SpringWeb::ClientMessage* cm = ParseClientMessage(data, len);
    return cm == nullptr ? 0 : static_cast<uint8_t>(cm->payload_type());
}

}  // namespace wireframe
