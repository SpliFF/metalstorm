// PreAuthPolicy — which client verbs a connection may use before it has a
// session (PLAN-protocol-guard task 6, the pre-auth surface audit).
//
// WHY THIS EXISTS: every verb in ClientMessageHandler's switch used to carry
// its own `sessions.GetSession(...)` check, written by hand, one case at a
// time. The audit that produced this file walked all 45 union members and
// found the checks were in fact complete — but "complete" was a property of
// 40-odd independently written lines, not of the design, and the switch grows
// by a case every time the protocol gains a verb. The failure mode is a new
// case that forgets its two lines and is reachable by anyone who can open a
// transport. So the rule moves here, is applied ONCE ahead of the switch, and
// a newly added union member trips `-Wswitch` on the exhaustive switch below
// until somebody classifies it. The per-case checks stay where they are:
// they now answer with their own verb-specific text (and, for several, an
// additional team/role test), and defence in depth costs a map lookup.
//
// THE ALLOW-LIST, and why each member is on it — this is the audit's record:
//
//   * Handshake — must be open; it IS the admission gate. Rejecting it would
//     leave no way to become admissible. It creates no state beyond an entry
//     in `handshakedClients`, and only after Protocol::CheckHandshake accepts
//     the epoch AND the wire schema hash (task 3).
//   * AuthRequest — open to the *session* gate by definition (it is what
//     creates a session), but NOT ungated: it is refused unless the client is
//     already in `handshakedClients`. That is the C1 rule, enforced in the
//     case itself since 2026-06-11.
//   * Ping — deliberately open, and the one judgement call in this file.
//     The client sends it immediately after the handshake and every 30 s
//     thereafter, before and after auth (connection.ts:1607-1620), so gating
//     it on a session would break RTT measurement on the login path. What it
//     discloses to an unauthenticated peer is one integer, the current sim
//     frame, to somebody who has already established a transport to a game
//     server whose existence is public in the lobby's room list; the response
//     is smaller than the request, so it is not an amplifier.
//
// NAMED LIMIT, not papered over: an unauthenticated connection has no message
// budget of any kind — every rate limiter in SessionManager keys off a
// ClientSession, which by definition does not exist yet — so a peer that
// completes a transport can send Ping (or garbage, which dies in the
// flatbuffers verifier) as fast as it likes. Gating Ping would not close that;
// the gap is transport-level and belongs to PLAN-security-hardening, not here.
//
// Everything else requires a session. Note this is transitively a handshake
// requirement too: a session exists only because AuthRequest made one, and
// AuthRequest is refused without a handshake — so no verb below reaches its
// handler from a connection that never passed the schema-hash check.
//
// ORDERING (load-bearing, same argument as PostGamePolicy): the gate runs
// AFTER the journal record. A verb refused live must be refused identically on
// replay, and that only holds if replay is fed the same input including the
// ones that bounced.
#pragma once

#include <cstdint>

#include "protocol_generated.h"

namespace preauth {

/// True when this verb may be dispatched from a connection that has no
/// ClientSession. Exactly three members qualify; see the allow-list above.
///
/// Deliberately NO `default:` — every union member is named, so adding one to
/// protocol.fbs fails to compile here (`-Wswitch`) until it is classified, and
/// tests/test_preauth_policy.cpp walks EnumValuesClientPayload() over it.
inline bool IsOpenPreAuth(uint8_t payloadType) {
    if (payloadType > static_cast<uint8_t>(SpringWeb::ClientPayload_MAX))
        return false;  // out of range: the verifier refuses it anyway
    switch (static_cast<SpringWeb::ClientPayload>(payloadType)) {
        case SpringWeb::ClientPayload_Handshake:
        case SpringWeb::ClientPayload_AuthRequest:
        case SpringWeb::ClientPayload_Ping:
            return true;

        case SpringWeb::ClientPayload_NONE:
        case SpringWeb::ClientPayload_PlayerCommand:
        case SpringWeb::ClientPayload_PlayerCommandBatch:
        case SpringWeb::ClientPayload_PlayerLeaveIntent:
        case SpringWeb::ClientPayload_ViewportUpdate:
        case SpringWeb::ClientPayload_SelectionState:
        case SpringWeb::ClientPayload_ChatSend:
        case SpringWeb::ClientPayload_Ack:
        case SpringWeb::ClientPayload_ReconnectRequest:
        case SpringWeb::ClientPayload_RoomCreate:
        case SpringWeb::ClientPayload_RoomJoin:
        case SpringWeb::ClientPayload_RoomLeave:
        case SpringWeb::ClientPayload_RoomEnlist:
        case SpringWeb::ClientPayload_RoomTeamSelect:
        case SpringWeb::ClientPayload_RoomReady:
        case SpringWeb::ClientPayload_RoomKick:
        case SpringWeb::ClientPayload_RoomStartGame:
        case SpringWeb::ClientPayload_RoomEndGame:
        case SpringWeb::ClientPayload_RoomAddAI:
        case SpringWeb::ClientPayload_RoomRemoveAI:
        case SpringWeb::ClientPayload_AIListRequest:
        case SpringWeb::ClientPayload_GameListRequest:
        case SpringWeb::ClientPayload_RoomSetStartPos:
        case SpringWeb::ClientPayload_RoomCloseRoom:
        case SpringWeb::ClientPayload_RoomSetAITeam:
        case SpringWeb::ClientPayload_LogIngest:
        case SpringWeb::ClientPayload_LogSubscribe:
        case SpringWeb::ClientPayload_LogUnsubscribe:
        case SpringWeb::ClientPayload_ConsoleCommand:
        case SpringWeb::ClientPayload_LuaRulesMsg:
        case SpringWeb::ClientPayload_LuaUIMsg:
        case SpringWeb::ClientPayload_PathRequest:
        case SpringWeb::ClientPayload_PathRequestCancel:
        case SpringWeb::ClientPayload_StandingOrderCreate:
        case SpringWeb::ClientPayload_StandingOrderUpdate:
        case SpringWeb::ClientPayload_StandingOrderRemove:
        case SpringWeb::ClientPayload_OrgGroupCreate:
        case SpringWeb::ClientPayload_OrgGroupUpdate:
        case SpringWeb::ClientPayload_OrgGroupDisband:
        case SpringWeb::ClientPayload_GroupDirective:
        case SpringWeb::ClientPayload_GroupDirectiveRemove:
        case SpringWeb::ClientPayload_GroupPosture:
        case SpringWeb::ClientPayload_ReplayControl:
        // PLAN-test-automation P7. Behind the gate: the server only ever
        // addresses a ClientEvalRequest to an authenticated admin session, so
        // a response from a client with no session answers nothing and has no
        // business being parsed. The broker would refuse it anyway (the sender
        // could not be the addressed client) — this is the outer of the two.
        case SpringWeb::ClientPayload_ClientEvalResponse:
            return false;
    }
    return false;
}

/// The complement, spelled out because that is how the call site reads.
inline bool RequiresSession(uint8_t payloadType) {
    return !IsOpenPreAuth(payloadType);
}

}  // namespace preauth
