/**
 * Handshake admission policy (C1 + PLAN-protocol-guard task 3).
 *
 * The rule the game server applies to the first message on a control stream,
 * as a pure function of what the client sent. It lives here rather than inline
 * in ClientMessageHandler.cpp for one reason: the handler's Handshake case
 * needs a NetworkServer, a Simulation and a live room to reach, so the rule
 * could not be tested at all — and this is the rule that decides whether
 * anybody can play. Header-only and dependency-free apart from the generated
 * hash, so a test can include it without dragging in the sim.
 *
 * Two things are checked, in this order:
 *
 *  1. `protocol_version` — a manual epoch counter, bumped only for breaks the
 *     schema text cannot see (the 0x02-0x09 binary envelope framings, or a
 *     semantic reinterpretation of an existing field). It is deliberately NOT
 *     the drift guard: it went unmoved through 15 schema edits, which is why
 *     the hash exists.
 *  2. `schema_hash` — sha256 of the binary schema, emitted into both sides by
 *     scripts/regen-protocol.sh. Strict equality: client and server are built
 *     and deployed from one commit, so an inequality always means a stale
 *     bundle (or a stale server), never a supported older peer. An ABSENT hash
 *     is stale by definition — every post-guard client sends one.
 */
#pragma once

#include "ProtocolSchemaHash.h"

#include <cstdint>
#include <string>
#include <string_view>

namespace Protocol {

/// Wire-protocol epoch negotiated in the Handshake (C1). Bumped 1 -> 2 when the
/// schema hash landed on the wire, which retroactively invalidates every
/// pre-guard cached bundle (those send no hash at all, and would otherwise be
/// refused by the less legible missing-hash branch).
/// Keep in sync with PROTOCOL_VERSION in client/src/core/protocol-version.ts.
/// A schema-visible change does NOT need this bumped — the hash covers it.
constexpr uint16_t CURRENT_PROTOCOL_VERSION = 2;

/// Verdict on one Handshake. `message` is what the client is told in the
/// VersionMismatch AuthResponse; `logDetail` is the server-side warning line.
/// Both name the two values that disagreed, because "version mismatch" without
/// the numbers is a support ticket rather than a diagnosis.
struct HandshakeVerdict {
    bool accepted = false;
    std::string message;
    std::string logDetail;
};

/// First 12 chars of a hash, for a human-readable message; "<none>" when the
/// client sent no hash at all, so the two failure modes never read alike.
inline std::string ShortSchemaHash(std::string_view hash) {
    if (hash.empty()) return "<none>";
    return std::string(hash.substr(0, 12));
}

/// Apply the admission rule. `clientSchemaHash` is empty when the field was
/// absent (a pre-guard bundle) — the caller passes the flatbuffers string or
/// "" for a null one, and the two cases are the same verdict either way.
inline HandshakeVerdict CheckHandshake(uint16_t clientVersion,
                                       std::string_view clientSchemaHash) {
    HandshakeVerdict v;

    if (clientVersion != CURRENT_PROTOCOL_VERSION) {
        v.message = "Protocol version mismatch (client v" +
                    std::to_string(clientVersion) + ", server v" +
                    std::to_string(CURRENT_PROTOCOL_VERSION) +
                    ") — reload the client";
        v.logDetail = "protocol version: client v" +
                      std::to_string(clientVersion) + ", server v" +
                      std::to_string(CURRENT_PROTOCOL_VERSION);
        return v;
    }

    const std::string_view serverHash{SCHEMA_HASH};
    if (clientSchemaHash != serverHash) {
        v.message = "Wire schema mismatch (client " +
                    ShortSchemaHash(clientSchemaHash) + ", server " +
                    ShortSchemaHash(serverHash) + ") — reload the client";
        v.logDetail = "schema hash: client " +
                      ShortSchemaHash(clientSchemaHash) + ", server " +
                      ShortSchemaHash(serverHash);
        return v;
    }

    v.accepted = true;
    return v;
}

}  // namespace Protocol
