#include "ClientMessageHandler.h"
#include "GameServerContext.h"
#include "GameStartCoordinator.h"

#include "Simulation.h"
#include "NetworkServer.h"
#include "Protocol.h"
#include "Database.h"
#include "ClientSession.h"
#include "RoomManager.h"
#include "StandingOrders.h"
#include "LuaExecEngine.h"
#include "Crypto.h"
#include "WebTransport/WebTransportServer.h"
#include "Lua/LuaRules.h"
#include "Sim/Units/UnitHandler.h"
#include "Sim/Units/Unit.h"
#include "Sim/Units/CommandAI/CommandAI.h"
#include "Sim/Units/CommandAI/Command.h"
#include "Sim/Misc/TeamHandler.h"
#include "Sim/MoveTypes/MoveDefHandler.h"
#include "Sim/Path/IPathManager.h"
#include "Game/Players/PlayerHandler.h"
#include "Game/GameSetup.h"
#include "System/SpringLog/SpringLog.h"

#include <algorithm>
#include <cstring>
#include <string>
#include <vector>

#define LOG_SECTION "server"

namespace {
/// Generate a cryptographically-secure random hex session token (S3).
/// Shares the single Crypto implementation — the old per-file std::mt19937
/// duplicate was both predictable and a copy of HttpAuth's generator.
std::string generateToken() {
    return Crypto::GenerateToken(16);
}
} // namespace

void ClientMessageHandler::HandleMessage(InboundMessage& msg) {
    auto& rtcServer = ctx.rtcServer;
    auto& sessions  = ctx.sessions;
    auto& db        = ctx.db;
    auto& rooms     = ctx.rooms;
    auto& sim       = ctx.sim;
    auto& luaExecEngine        = ctx.luaExecEngine;
    auto& playerTeamByUsername = ctx.playerTeamByUsername;
    auto& clientPlayerNum      = ctx.clientPlayerNum;
    auto& connectedRosterPlayers = ctx.connectedRosterPlayers;
    auto& nextPlayerNum        = ctx.nextPlayerNum;
    const std::string& defsCacheKey = ctx.defsCacheKey;

    auto* clientMsg = Protocol::ParseClientMessage(msg.data.data(), msg.data.size());
    if (!clientMsg || !clientMsg->payload()) {
        auto err = Protocol::BuildServerError(400, "Invalid message");
        rtcServer.SendReliable(msg.clientId, err.data(), err.size());
        return;
    }

    if (ctx.logMessages) {
        SLOG(SPRING_LOG_DEBUG, "msg: client=%u type=%d size=%zu",
            msg.clientId, (int)clientMsg->payload_type(), msg.data.size());
    }

    switch (clientMsg->payload_type()) {
        case SpringWeb::ClientPayload_Ping: {
            auto* ping = clientMsg->payload_as_Ping();
            auto pong = Protocol::BuildPong(
                ping->client_time(),
                static_cast<uint64_t>(sim.GetFrameNum()));
            rtcServer.SendReliable(msg.clientId, pong.data(), pong.size());
            break;
        }
        case SpringWeb::ClientPayload_Handshake: {
            auto* hs = clientMsg->payload_as_Handshake();
            const uint16_t clientVer = hs->protocol_version();
            SLOG(SPRING_LOG_INFO, "handshake from client %u: v%d %s",
                msg.clientId,
                clientVer,
                hs->client_version() ? hs->client_version()->c_str() : "unknown");
            // C1: enforce the protocol version. A mismatch (typically a stale
            // cached JS bundle against a changed schema) is rejected with a
            // VersionMismatch AuthResponse; the client closes on auth failure.
            // We deliberately do NOT record the client as handshaked, so even
            // if it ignores the response its AuthRequest is refused below.
            if (clientVer != Protocol::CURRENT_PROTOCOL_VERSION) {
                SLOG(SPRING_LOG_WARNING,
                    "client %u protocol mismatch: client v%d, server v%d — rejecting",
                    msg.clientId, clientVer, Protocol::CURRENT_PROTOCOL_VERSION);
                auto resp = Protocol::BuildAuthResponse(
                    SpringWeb::AuthStatus_VersionMismatch, "", 0,
                    "Protocol version mismatch — reload the client");
                rtcServer.SendReliable(msg.clientId, resp.data(), resp.size());
                break;
            }
            ctx.handshakedClients.insert(msg.clientId);
            break;
        }
        case SpringWeb::ClientPayload_AuthRequest: {
            // C1: refuse auth until a protocol-compatible Handshake arrived.
            // Catches clients too old to send a handshake at all (a matching
            // handshake is the only thing that adds the id to this set).
            if (!ctx.handshakedClients.count(msg.clientId)) {
                SLOG(SPRING_LOG_WARNING,
                    "client %u sent AuthRequest without a valid handshake — rejecting",
                    msg.clientId);
                auto resp = Protocol::BuildAuthResponse(
                    SpringWeb::AuthStatus_VersionMismatch, "", 0,
                    "Protocol handshake required — reload the client");
                rtcServer.SendReliable(msg.clientId, resp.data(), resp.size());
                break;
            }
            auto* auth = clientMsg->payload_as_AuthRequest();
            const char* username = auth->username() ? auth->username()->c_str() : "";
            const char* passHash = auth->password_hash() ? auth->password_hash()->c_str() : "";

            // Helper: resolve a username against the lobby-
            // supplied roster. Returns the assigned team, or
            // -1 if the roster is empty (dev-mode permissive)
            // OR the username isn't in the roster at all.
            // Callers use -1 as a reject signal when the
            // roster is non-empty.
            auto resolveTeam = [&](const std::string& name) -> int {
                if (playerTeamByUsername.empty()) return -1;
                auto it = playerTeamByUsername.find(name);
                return (it != playerTeamByUsername.end()) ? it->second : -1;
            };
            const bool rosterRequired = !playerTeamByUsername.empty();

            // Try token-based reconnection first
            const bool hasToken = auth->token() && auth->token()->size() > 0;
            if (hasToken) {
                int64_t userId = db.ValidateSession(auth->token()->str());
                if (userId > 0) {
                    // Look up the username from the userId so we
                    // can cross-check against the lobby roster.
                    auto reconnectUser = db.FindUserById(userId);
                    if (!reconnectUser) {
                        auto resp = Protocol::BuildAuthResponse(
                            SpringWeb::AuthStatus_InvalidCredentials,
                            "", 0, "Session user missing");
                        rtcServer.SendReliable(msg.clientId, resp.data(), resp.size());
                        break;
                    }
                    const int team = resolveTeam(reconnectUser->username);
                    if (rosterRequired && team < 0) {
                        auto resp = Protocol::BuildAuthResponse(
                            SpringWeb::AuthStatus_InvalidCredentials,
                            "", 0, "Not in this room's roster");
                        rtcServer.SendReliable(msg.clientId, resp.data(), resp.size());
                        break;
                    }
                    auto resp = Protocol::BuildAuthResponse(
                        SpringWeb::AuthStatus_OK, auth->token()->str(),
                        static_cast<uint32_t>(userId), "",
                        static_cast<int8_t>(team), defsCacheKey);
                    rtcServer.SendReliable(msg.clientId, resp.data(), resp.size());
                    // Register the session — previously the
                    // token path skipped this, which meant a
                    // reconnected client had no session and
                    // every PlayerCommand bounced at the
                    // REQUIRE_SESSION guard.
                    sessions.AddSession(msg.clientId, userId,
                        reconnectUser->username, reconnectUser->role);
                    if (auto* s = sessions.GetSession(msg.clientId))
                        s->team = team;
                    // Register a Spring CPlayer so Lua can
                    // query player info and receive callins.
                    {
                        int pNum = nextPlayerNum++;
                        CPlayer p;
                        p.name = reconnectUser->username;
                        p.team = team;
                        p.active = true;
                        p.playerNum = pNum;
                        playerHandler.AddPlayer(p);
                        clientPlayerNum[msg.clientId] = pNum;
                    }
                    // One-shot standing-order snapshot so a
                    // mid-game reconnect sees existing orders
                    // immediately, without waiting for the
                    // next mutation to trigger the broadcast
                    // hook.
                    start.PushStandingOrdersTo(msg.clientId, team);
                    SLOG(SPRING_LOG_NOTICE,
                        "client %u reconnected as '%s' (id=%lld) team=%d",
                        msg.clientId, reconnectUser->username.c_str(),
                        userId, team);
                    // Track roster connection for GameStart
                    if (playerTeamByUsername.count(reconnectUser->username)) {
                        connectedRosterPlayers.insert(reconnectUser->username);
                        start.CheckAndFireGameStart();
                    }
                    // Map data is now served via HTTP from the lobby
                    // server at /api/maps/data/{mapId}/metadata.json +
                    // binary .bin files. No longer sent over WebRTC.
                    // Defs stream incrementally via entity/projectile state.
                    break;
                }
                // Token was present but ValidateSession failed.
                // If no password was supplied this is a pure
                // reconnect attempt and falling through into
                // the password branch would surface as a
                // misleading "Wrong password" error — reject
                // cleanly with "Session expired" so the client
                // can drop the stale token and re-auth. Mirrors
                // the lobby's behaviour at lobby_main.cpp.
                if (strlen(passHash) == 0) {
                    auto resp = Protocol::BuildAuthResponse(
                        SpringWeb::AuthStatus_InvalidCredentials,
                        "", 0, "Session expired");
                    rtcServer.SendReliable(msg.clientId, resp.data(), resp.size());
                    break;
                }
            }

            // Look up or create user
            auto user = db.FindUser(username);
            if (!user) {
                // Auto-register for now (Phase 1 MVP). S1: store a scrypt hash,
                // never the raw password field.
                std::string hashed = Crypto::HashPassword(passHash);
                int64_t newId = hashed.empty()
                    ? 0 : db.CreateUser(username, hashed);
                if (newId == 0) {
                    auto resp = Protocol::BuildAuthResponse(
                        SpringWeb::AuthStatus_InvalidCredentials, "", 0,
                        "Registration failed");
                    rtcServer.SendReliable(msg.clientId, resp.data(), resp.size());
                    break;
                }
                user = db.FindUser(username);
            }

            // Check password (S1: scrypt verify; transparently upgrade legacy
            // plaintext / weaker hashes on a successful login).
            {
                bool needsRehash = false;
                if (!Crypto::VerifyPassword(passHash, user->passwordHash, needsRehash)) {
                    auto resp = Protocol::BuildAuthResponse(
                        SpringWeb::AuthStatus_InvalidCredentials, "", 0,
                        "Wrong password");
                    rtcServer.SendReliable(msg.clientId, resp.data(), resp.size());
                    break;
                }
                if (needsRehash)
                    db.UpdatePasswordHash(user->id, Crypto::HashPassword(passHash));
            }

            // Check ban
            if (user->isBanned) {
                auto resp = Protocol::BuildAuthResponse(
                    SpringWeb::AuthStatus_AccountBanned, "", 0,
                    "Account banned");
                rtcServer.SendReliable(msg.clientId, resp.data(), resp.size());
                break;
            }

            // Roster membership: reject anyone the lobby
            // didn't pre-authorise for this game. Dev-mode
            // (empty roster) skips this check.
            const int team = resolveTeam(user->username);
            if (rosterRequired && team < 0) {
                auto resp = Protocol::BuildAuthResponse(
                    SpringWeb::AuthStatus_InvalidCredentials,
                    "", 0, "Not in this room's roster");
                rtcServer.SendReliable(msg.clientId, resp.data(), resp.size());
                SLOG(SPRING_LOG_WARNING,
                    "client %u rejected: '%s' not in roster",
                    msg.clientId, user->username.c_str());
                break;
            }

            // Create session
            std::string token = generateToken();
            db.CreateSession(user->id, token);

            auto resp = Protocol::BuildAuthResponse(
                SpringWeb::AuthStatus_OK, token,
                static_cast<uint32_t>(user->id), "",
                static_cast<int8_t>(team), defsCacheKey);
            rtcServer.SendReliable(msg.clientId, resp.data(), resp.size());
            sessions.AddSession(msg.clientId, user->id, user->username, user->role);
            if (auto* s = sessions.GetSession(msg.clientId))
                s->team = team;
            // Register a Spring CPlayer so Lua can query
            // player info and receive callins.
            {
                int pNum = nextPlayerNum++;
                CPlayer p;
                p.name = user->username;
                p.team = team;
                p.active = true;
                p.playerNum = pNum;
                playerHandler.AddPlayer(p);
                clientPlayerNum[msg.clientId] = pNum;
            }
            // One-shot standing-order snapshot for the freshly
            // authenticated session — mirrors the reconnect
            // path above. Without this, mid-game joins
            // wouldn't see existing orders until the next
            // create / update / remove fired the broadcast
            // hook.
            start.PushStandingOrdersTo(msg.clientId, team);

            // Initial team start positions + ally start boxes so the
            // in-game LuaUI worker can answer Spring.GetTeamStartPosition
            // / GetAllyTeamStartBox. Re-broadcast after GameStart for the
            // final post-spawn values (see checkAndFireGameStart).
            {
                auto tsi = start.BuildTeamStartInfoMsg();
                rtcServer.SendReliable(msg.clientId, tsi.data(), tsi.size());
            }

            // The game's modoptions, so the in-game LuaUI worker's
            // Spring.GetModOptions() returns the same set the synced
            // gadgets (and the defs-cache key) already see. Immutable for
            // the game-server's lifetime → one-shot per client, no
            // re-broadcast (a late joiner gets them on its own auth).
            {
                const auto& opts = CGameSetup::GetModOptions();
                std::vector<std::pair<std::string, std::string>> kvs;
                kvs.reserve(opts.size());
                for (const auto& kv : opts) kvs.emplace_back(kv.first, kv.second);
                auto mo = Protocol::BuildGameModOptions(kvs);
                rtcServer.SendReliable(msg.clientId, mo.data(), mo.size());
            }

            SLOG(SPRING_LOG_NOTICE, "client %u authenticated as '%s' (id=%lld) team=%d",
                msg.clientId, username, user->id, team);

            // Track roster connection for GameStart
            if (playerTeamByUsername.count(user->username)) {
                connectedRosterPlayers.insert(user->username);
                start.CheckAndFireGameStart();
            }

            // Send room list to newly authenticated client
            {
                auto allRooms = rooms.GetAllRooms();
                auto listMsg = Protocol::BuildRoomListUpdate(allRooms);
                rtcServer.SendReliable(msg.clientId, listMsg.data(), listMsg.size());
            }

            // Map data is now served via HTTP from the lobby server
            // at /api/maps/data/{mapId}/metadata.json + binary .bin
            // files. No longer sent as a FlatBuffer over WebRTC
            // (the 2+ MB MapData message exceeded SCTP's 256KB limit).
            // Unit and weapon defs are NOT sent eagerly on auth.
            // They stream incrementally as the client encounters
            // new entity/projectile types during state updates.
            break;
        }
        case SpringWeb::ClientPayload_PlayerCommand: {
            auto* session = sessions.GetSession(msg.clientId);
            if (!session) {
                auto err = Protocol::BuildServerError(401, "Not authenticated");
                rtcServer.SendReliable(msg.clientId, err.data(), err.size());
                break;
            }

            auto* cmd = clientMsg->payload_as_PlayerCommand();
            // Token-bucket rate limiting: drop early when the
            // client is over budget. squad_ids.size() is the
            // per-unit order count this command represents.
            const int squadCount = cmd && cmd->squad_ids()
                ? static_cast<int>(cmd->squad_ids()->size()) : 0;
            if (!SessionManager::TryConsumeCommandBudget(*session, squadCount)) {
                auto err = Protocol::BuildServerError(429, "Command rate limit exceeded");
                rtcServer.SendReliable(msg.clientId, err.data(), err.size());
                SLOG(SPRING_LOG_WARNING,
                    "cmd: client %u (%s) rate-limit drop #%u (msgTokens=%.1f orderTokens=%.1f want=%d)",
                    msg.clientId, session->username.c_str(),
                    session->rateLimitDrops,
                    session->cmdMessageTokens, session->cmdOrderTokens, squadCount);
                break;
            }

            // Sequence validation (must be monotonically increasing)
            if (cmd->sequence() <= session->lastCommandSeq && session->lastCommandSeq > 0) {
                auto err = Protocol::BuildServerError(400, "Stale command sequence");
                rtcServer.SendReliable(msg.clientId, err.data(), err.size());
                break;
            }
            session->lastCommandSeq = cmd->sequence();

            // Build a Command from the PlayerCommand message
            {
                Command simCmd(cmd->command_id(), static_cast<unsigned char>(cmd->options()));
                if (cmd->timeout_frames() > 0)
                    simCmd.SetTimeOut(static_cast<int>(cmd->timeout_frames()));

                // Copy parameters
                if (cmd->params()) {
                    for (unsigned i = 0; i < cmd->params()->size(); i++)
                        simCmd.PushParam(cmd->params()->Get(i));
                }

                // Route command to each target unit, dropping
                // any that don't belong to this session's
                // team. session->team == -1 means "no roster
                // restriction" (dev smoketest or spectator)
                // and lets the command through unchanged,
                // which preserves the old behaviour when the
                // lobby isn't in the loop.
                int routed = 0;
                int rejectedTeam = 0;
                if (cmd->squad_ids()) {
                    for (unsigned i = 0; i < cmd->squad_ids()->size(); i++) {
                        uint32_t unitId = cmd->squad_ids()->Get(i);
                        CUnit* unit = unitHandler.GetUnit(unitId);
                        if (unit == nullptr || unit->isDead)
                            continue;
                        if (session->team >= 0 && unit->team != session->team) {
                            rejectedTeam++;
                            continue;
                        }
                        unit->commandAI->GiveCommand(simCmd);
                        routed++;
                    }
                }

                SLOG(SPRING_LOG_DEBUG,
                    "cmd: client %u (%s, team=%d): cmd=%d seq=%u routed=%d rejected=%d/%d",
                    msg.clientId, session->username.c_str(), session->team,
                    cmd->command_id(), cmd->sequence(),
                    routed, rejectedTeam,
                    cmd->squad_ids() ? (int)cmd->squad_ids()->size() : 0);
            }
            break;
        }
        case SpringWeb::ClientPayload_PlayerCommandBatch: {
            // Atomic execution of a sequence of PlayerCommand
            // entries on the same sim tick. Used by:
            //   - Waypoint drag (CMD.INSERT + CMD.REMOVE pair
            //     against the same unit, where dropping or
            //     reordering would break intent)
            //   - Build drag-row / drag-rectangle (N CMD_BUILD
            //     entries against the same builder list, all
            //     queued without intervening state transitions)
            // The batch consumes one sequence-number slot (the
            // batch's `sequence` field), not one per inner
            // command — sending stale or duplicate batches
            // bounces with the same 400 the per-command path
            // returns.
            auto* session = sessions.GetSession(msg.clientId);
            if (!session) {
                auto err = Protocol::BuildServerError(401, "Not authenticated");
                rtcServer.SendReliable(msg.clientId, err.data(), err.size());
                break;
            }

            auto* batch = clientMsg->payload_as_PlayerCommandBatch();
            if (!batch || !batch->commands()) break;

            // Sum squad_ids across the batch — a batch with N
            // inner commands and M unique targets across them
            // costs N+M tokens (1 message + sum of targets).
            // Cheapest correct cost in token-bucket terms: a
            // 12-tile build row across one builder spends 1
            // message + 12 orders.
            int batchSquadCount = 0;
            for (unsigned ci = 0; ci < batch->commands()->size(); ci++) {
                auto* c = batch->commands()->Get(ci);
                if (c && c->squad_ids())
                    batchSquadCount += static_cast<int>(c->squad_ids()->size());
            }
            if (!SessionManager::TryConsumeCommandBudget(*session, batchSquadCount)) {
                auto err = Protocol::BuildServerError(429, "Command rate limit exceeded");
                rtcServer.SendReliable(msg.clientId, err.data(), err.size());
                SLOG(SPRING_LOG_WARNING,
                    "cmd-batch: client %u (%s) rate-limit drop #%u (msgTokens=%.1f orderTokens=%.1f want=%d)",
                    msg.clientId, session->username.c_str(),
                    session->rateLimitDrops,
                    session->cmdMessageTokens, session->cmdOrderTokens, batchSquadCount);
                break;
            }

            if (batch->sequence() <= session->lastCommandSeq && session->lastCommandSeq > 0) {
                auto err = Protocol::BuildServerError(400, "Stale command sequence");
                rtcServer.SendReliable(msg.clientId, err.data(), err.size());
                break;
            }
            session->lastCommandSeq = batch->sequence();

            int totalRouted = 0;
            int totalRejectedTeam = 0;
            for (unsigned ci = 0; ci < batch->commands()->size(); ci++) {
                auto* cmd = batch->commands()->Get(ci);
                if (!cmd) continue;
                Command simCmd(cmd->command_id(),
                               static_cast<unsigned char>(cmd->options()));
                if (cmd->timeout_frames() > 0)
                    simCmd.SetTimeOut(static_cast<int>(cmd->timeout_frames()));
                if (cmd->params()) {
                    for (unsigned i = 0; i < cmd->params()->size(); i++)
                        simCmd.PushParam(cmd->params()->Get(i));
                }
                if (!cmd->squad_ids()) continue;
                for (unsigned i = 0; i < cmd->squad_ids()->size(); i++) {
                    uint32_t unitId = cmd->squad_ids()->Get(i);
                    CUnit* unit = unitHandler.GetUnit(unitId);
                    if (unit == nullptr || unit->isDead) continue;
                    if (session->team >= 0 && unit->team != session->team) {
                        totalRejectedTeam++;
                        continue;
                    }
                    unit->commandAI->GiveCommand(simCmd);
                    totalRouted++;
                }
            }
            SLOG(SPRING_LOG_DEBUG,
                "cmd-batch: client %u (%s, team=%d): seq=%u entries=%u routed=%d rejected=%d",
                msg.clientId, session->username.c_str(), session->team,
                batch->sequence(),
                batch->commands()->size(),
                totalRouted, totalRejectedTeam);
            break;
        }
        case SpringWeb::ClientPayload_ViewportUpdate: {
            auto* session = sessions.GetSession(msg.clientId);
            if (!session) {
                auto err = Protocol::BuildServerError(401, "Not authenticated");
                rtcServer.SendReliable(msg.clientId, err.data(), err.size());
                break;
            }

            auto* vpu = clientMsg->payload_as_ViewportUpdate();
            int vpId = vpu->viewport_id();
            if (vpId >= MAX_VIEWPORTS) {
                auto err = Protocol::BuildServerError(400, "Invalid viewport ID");
                rtcServer.SendReliable(msg.clientId, err.data(), err.size());
                break;
            }

            auto& vp = session->viewports[vpId];
            vp.centerX   = vpu->center_x();
            vp.centerZ   = vpu->center_z();
            vp.width     = vpu->width();
            vp.height    = vpu->height();
            vp.rotation  = vpu->rotation();
            vp.zoomLevel = vpu->zoom_level();
            vp.active    = (vp.width > 0.0f && vp.height > 0.0f);
            break;
        }
        // --- Room message helpers ---
        // Broadcasts room state to members + room list to everyone
        #define BROADCAST_ROOM_UPDATE(roomPtr) do { \
            if (roomPtr) { \
                auto _sm = Protocol::BuildRoomStateUpdate(*roomPtr); \
                for (const auto& _p : roomPtr->players) \
                    rtcServer.SendReliable(_p.clientId, _sm.data(), _sm.size()); \
            } \
            auto _all = rooms.GetAllRooms(); \
            auto _lm = Protocol::BuildRoomListUpdate(_all); \
            rtcServer.BroadcastReliable(_lm.data(), _lm.size()); \
        } while(0)

        case SpringWeb::ClientPayload_RoomCreate: {
            auto* session = sessions.GetSession(msg.clientId);
            if (!session) { auto e = Protocol::BuildServerError(401, "Auth required"); rtcServer.SendReliable(msg.clientId, e.data(), e.size()); break; }

            auto* rc = clientMsg->payload_as_RoomCreate();
            uint32_t roomId = rooms.CreateRoom(
                rc->name() ? rc->name()->str() : "Game",
                rc->map_id() ? rc->map_id()->str() : "",
                rc->game_id() ? rc->game_id()->str() : "",
                rc->max_players() > 0 ? rc->max_players() : 8,
                rc->password() ? rc->password()->str() : "",
                static_cast<uint32_t>(session->userId), msg.clientId, session->username);
            BROADCAST_ROOM_UPDATE(rooms.GetRoom(roomId));
            break;
        }
        case SpringWeb::ClientPayload_RoomJoin: {
            auto* session = sessions.GetSession(msg.clientId);
            if (!session) { auto e = Protocol::BuildServerError(401, "Auth required"); rtcServer.SendReliable(msg.clientId, e.data(), e.size()); break; }

            auto* rj = clientMsg->payload_as_RoomJoin();
            if (!rooms.JoinRoom(rj->room_id(), static_cast<uint32_t>(session->userId),
                                msg.clientId, session->username,
                                rj->password() ? rj->password()->str() : "")) {
                auto e = Protocol::BuildServerError(403, "Cannot join room");
                rtcServer.SendReliable(msg.clientId, e.data(), e.size());
                break;
            }
            BROADCAST_ROOM_UPDATE(rooms.GetRoom(rj->room_id()));
            break;
        }
        case SpringWeb::ClientPayload_RoomLeave: {
            auto* session = sessions.GetSession(msg.clientId);
            if (!session) break;
            auto* room = rooms.FindRoomByClient(msg.clientId);
            if (room) {
                uint32_t rid = room->id;
                rooms.LeaveRoom(rid, static_cast<uint32_t>(session->userId));
                BROADCAST_ROOM_UPDATE(rooms.GetRoom(rid));
            }
            break;
        }
        case SpringWeb::ClientPayload_RoomTeamSelect: {
            auto* session = sessions.GetSession(msg.clientId);
            if (!session) break;
            auto* room = rooms.FindRoomByClient(msg.clientId);
            if (room) {
                rooms.SetTeam(room->id, static_cast<uint32_t>(session->userId),
                              clientMsg->payload_as_RoomTeamSelect()->team());
                BROADCAST_ROOM_UPDATE(room);
            }
            break;
        }
        case SpringWeb::ClientPayload_RoomReady: {
            auto* session = sessions.GetSession(msg.clientId);
            if (!session) break;
            auto* room = rooms.FindRoomByClient(msg.clientId);
            if (room) {
                rooms.SetReady(room->id, static_cast<uint32_t>(session->userId),
                               clientMsg->payload_as_RoomReady()->ready());
                BROADCAST_ROOM_UPDATE(room);
            }
            break;
        }
        case SpringWeb::ClientPayload_RoomStartGame: {
            auto* session = sessions.GetSession(msg.clientId);
            if (!session) break;
            auto* room = rooms.FindRoomByClient(msg.clientId);
            if (room && rooms.StartGame(room->id, static_cast<uint32_t>(session->userId))) {
                BROADCAST_ROOM_UPDATE(room);
            }
            break;
        }
        case SpringWeb::ClientPayload_RoomKick: {
            auto* session = sessions.GetSession(msg.clientId);
            if (!session) break;

            auto* room = rooms.FindRoomByClient(msg.clientId);
            if (room) {
                rooms.KickPlayer(room->id, static_cast<uint32_t>(session->userId),
                                 clientMsg->payload_as_RoomKick()->player_id());
                BROADCAST_ROOM_UPDATE(room);
            }
            break;
        }
        case SpringWeb::ClientPayload_LuaRulesMsg: {
            auto* session = sessions.GetSession(msg.clientId);
            if (!session) {
                SLOG(SPRING_LOG_NOTICE,
                     "[server] LuaRulesMsg drop: no session for client %u",
                     msg.clientId);
                auto err = Protocol::BuildServerError(401, "Not authenticated");
                rtcServer.SendReliable(msg.clientId, err.data(), err.size());
                break;
            }
            if (luaRules == nullptr) {
                SLOG(SPRING_LOG_NOTICE,
                     "[server] LuaRulesMsg drop: luaRules not loaded");
                break;
            }

            auto pIt = clientPlayerNum.find(msg.clientId);
            if (pIt == clientPlayerNum.end()) {
                SLOG(SPRING_LOG_NOTICE,
                     "[server] LuaRulesMsg drop: no playerNum for client %u",
                     msg.clientId);
                break;
            }

            auto* lrm = clientMsg->payload_as_LuaRulesMsg();
            auto* dataVec = lrm ? lrm->data() : nullptr;
            if (dataVec == nullptr) {
                SLOG(SPRING_LOG_NOTICE,
                     "[server] LuaRulesMsg drop: empty data vector");
                break;
            }

            std::string payload(reinterpret_cast<const char*>(dataVec->data()),
                                dataVec->size());
            SLOG(SPRING_LOG_NOTICE,
                 "[server] LuaRulesMsg dispatch: client=%u player=%d bytes=%zu head='%s'",
                 msg.clientId, pIt->second, payload.size(),
                 payload.substr(0, std::min<size_t>(payload.size(), 64)).c_str());
            luaRules->RecvLuaMsg(payload, pIt->second);
            break;
        }
        case SpringWeb::ClientPayload_LuaUIMsg: {
            // Player→player LuaUI broadcast (Spring.SendLuaUIMsg). Unlike
            // LuaRulesMsg this never touches synced state — the server
            // just relays it to every eligible client as a
            // LuaUIMsgRelay → widget:RecvLuaMsg(msg, playerID). The
            // audience filter (`mode`) is evaluated here per-receiver,
            // faithfully mirroring Recoil CLuaHandle::HandleLuaMsg
            // (LUA_HANDLE_ORDER_UI). The sender receives its own message
            // back (faithful loopback — Recoil relays to all incl self).
            auto* session = sessions.GetSession(msg.clientId);
            if (!session) {
                auto err = Protocol::BuildServerError(401, "Not authenticated");
                rtcServer.SendReliable(msg.clientId, err.data(), err.size());
                break;
            }
            auto sIt = clientPlayerNum.find(msg.clientId);
            if (sIt == clientPlayerNum.end()) {
                SLOG(SPRING_LOG_NOTICE,
                     "[server] LuaUIMsg drop: no playerNum for client %u",
                     msg.clientId);
                break;
            }
            const int senderPNum = sIt->second;
            auto* uim = clientMsg->payload_as_LuaUIMsg();
            auto* dataVec = uim ? uim->data() : nullptr;
            if (dataVec == nullptr) break;
            const uint8_t mode = uim->mode();

            std::string payload(reinterpret_cast<const char*>(dataVec->data()),
                                dataVec->size());
            const CPlayer* sender = playerHandler.Player(senderPNum);
            const bool senderSpec = (sender == nullptr) || sender->IsSpectator();
            const int senderAllyTeam =
                (sender != nullptr && !senderSpec)
                    ? teamHandler.AllyTeam(sender->team) : -1;

            auto relay = Protocol::BuildLuaUIMsgRelay(payload, senderPNum);
            int delivered = 0;
            for (const auto& [rClientId, rPNum] : clientPlayerNum) {
                const CPlayer* recv = playerHandler.Player(rPNum);
                if (recv == nullptr) continue;
                const bool recvSpec = recv->IsSpectator();
                bool send = false;
                switch (mode) {
                    case 0:   send = true; break;
                    case 's': send = recvSpec; break;
                    case 'a': {
                        // Recoil: a full-view spectator sees all; if the
                        // sender is a spectator only spectators receive;
                        // otherwise allied-allyteam receivers receive.
                        if (recvSpec)       send = true;
                        else if (senderSpec) send = false;
                        else send = teamHandler.Ally(
                            senderAllyTeam, teamHandler.AllyTeam(recv->team));
                    } break;
                    default: send = false; break;
                }
                if (!send) continue;
                rtcServer.SendReliable(rClientId, relay.data(), relay.size());
                ++delivered;
            }
            SLOG(SPRING_LOG_INFO,
                 "[server] LuaUIMsg relay: sender=%d mode=%u bytes=%zu delivered=%d",
                 senderPNum, static_cast<unsigned>(mode), payload.size(), delivered);
            break;
        }
        case SpringWeb::ClientPayload_ConsoleCommand: {
            auto* cc = clientMsg->payload_as_ConsoleCommand();
            if (!cc) break;
            // S2: ConsoleCommand pushes arbitrary code into LuaExecEngine
            // (spawn units, pause, change speed, run Lua). Gate on the
            // authenticated session's role — only admins may exec. A missing
            // session or any non-admin role is rejected with a ConsoleResponse
            // so the caller sees the denial rather than silent success.
            auto* session = sessions.GetSession(msg.clientId);
            if (!session || session->role != "admin") {
                SLOG(SPRING_LOG_WARNING,
                    "client %u denied ConsoleCommand (role=%s scope=%s)",
                    msg.clientId,
                    session ? session->role.c_str() : "<none>",
                    cc->scope() ? cc->scope()->c_str() : "server");
                auto resp = Protocol::BuildConsoleResponse(
                    cc->request_id(),
                    cc->scope() ? cc->scope()->str() : "server",
                    /*success=*/false,
                    "permission denied: admin role required", /*level=*/2);
                rtcServer.SendReliable(msg.clientId, resp.data(), resp.size());
                break;
            }
            LuaExecRequest req;
            req.requestId = cc->request_id();
            req.scope = cc->scope() ? cc->scope()->str() : "server";
            req.code = cc->command() ? cc->command()->str() : "";
            req.clientId = msg.clientId;
            luaExecEngine.Push(std::move(req));
            break;
        }
        case SpringWeb::ClientPayload_SelectionState: {
            auto* session = sessions.GetSession(msg.clientId);
            if (!session) break;
            auto* sel = clientMsg->payload_as_SelectionState();
            if (!sel) break;
            // Drop out-of-order updates — selection arrives debounced
            // so the latest sequence is authoritative.
            if (sel->sequence() < session->lastSelectionSeq) break;
            session->lastSelectionSeq = sel->sequence();
            session->selectedUnits.clear();
            if (auto* ids = sel->unit_ids()) {
                session->selectedUnits.reserve(ids->size());
                for (uint32_t i = 0; i < ids->size(); ++i) {
                    session->selectedUnits.insert(ids->Get(i));
                }
            }
            break;
        }
        case SpringWeb::ClientPayload_PathRequest: {
            // Honour the client's `Spring.PathRequest` call by
            // routing through the sim's IPathManager. The path
            // manager is sim-thread-local; this case runs on the
            // sim thread (network messages drain inside the
            // simulation step), so direct calls are safe.
            //
            // We compute the path synchronously (HAPFS is fully
            // sync; QTPFS may need 1-2 extra ticks but
            // GetPathWayPoints returns whatever is ready) and
            // immediately release the path with DeletePath —
            // long-lived paths aren't needed here because the
            // client caches waypoints in its own
            // request_id → response map. Spring's `:Next()`
            // semantics are emulated client-side by walking the
            // cached waypoint list.
            auto* session = sessions.GetSession(msg.clientId);
            if (!session) break;
            auto* req = clientMsg->payload_as_PathRequest();
            if (!req) break;
            const uint32_t requestId = req->request_id();
            const auto* startVec = req->start();
            const auto* endVec = req->end();
            if (!startVec || !endVec) {
                auto resp = Protocol::BuildPathResponse(requestId, {}, 0.0f);
                rtcServer.SendReliable(msg.clientId, resp.data(), resp.size());
                break;
            }
            const float3 startPos(startVec->x(), startVec->y(), startVec->z());
            const float3 endPos(endVec->x(), endVec->y(), endVec->z());
            const unsigned int moveType = req->move_type();
            const float radius = req->goal_radius() > 0.0f
                ? req->goal_radius() : 8.0f;

            std::vector<float3> waypoints;
            float length = 0.0f;
            if (pathManager != nullptr &&
                moveType < moveDefHandler.GetNumMoveDefs())
            {
                const MoveDef* moveDef =
                    moveDefHandler.GetMoveDefByPathType(moveType);
                if (moveDef != nullptr) {
                    // Unsynced request — widgets/UI must not
                    // mutate the path manager's synced state.
                    const unsigned int pathID =
                        pathManager->RequestPath(
                            nullptr, moveDef, startPos, endPos,
                            radius, /*synced=*/false);
                    if (pathID != 0) {
                        std::vector<int> starts;
                        pathManager->GetPathWayPoints(
                            pathID, waypoints, starts);
                        for (size_t i = 1; i < waypoints.size(); ++i) {
                            const float3 d = waypoints[i] - waypoints[i - 1];
                            length += d.Length();
                        }
                        pathManager->DeletePath(pathID);
                    }
                }
            }

            auto resp = Protocol::BuildPathResponse(
                requestId, waypoints, length);
            rtcServer.SendReliable(msg.clientId, resp.data(), resp.size());
            break;
        }
        case SpringWeb::ClientPayload_PathRequestCancel: {
            // No-op: paths are computed synchronously inside
            // ClientPayload_PathRequest and released
            // immediately, so there is nothing to cancel. The
            // cancel envelope still rides through the protocol
            // for forward compatibility (when QTPFS is enabled
            // we may keep multi-tick searches pending).
            break;
        }
        case SpringWeb::ClientPayload_StandingOrderCreate: {
            auto* session = sessions.GetSession(msg.clientId);
            if (!session || session->team < 0) {
                auto err = Protocol::BuildServerError(401, "Not authenticated");
                rtcServer.SendReliable(msg.clientId, err.data(), err.size());
                break;
            }
            auto* req = clientMsg->payload_as_StandingOrderCreate();
            if (!req) break;
            // One message token per standing-order mutation. No
            // order-token cost: standing orders don't fan out to
            // squads at the protocol level — the evaluator does.
            if (!SessionManager::TryConsumeCommandBudget(*session, 0)) {
                auto err = Protocol::BuildServerError(429, "Command rate limit exceeded");
                rtcServer.SendReliable(msg.clientId, err.data(), err.size());
                break;
            }
            if (req->sequence() <= session->lastCommandSeq && session->lastCommandSeq > 0) {
                auto err = Protocol::BuildServerError(400, "Stale command sequence");
                rtcServer.SendReliable(msg.clientId, err.data(), err.size());
                break;
            }
            session->lastCommandSeq = req->sequence();

            std::vector<float> params;
            if (auto* p = req->params()) {
                params.reserve(p->size());
                for (unsigned i = 0; i < p->size(); ++i) params.push_back(p->Get(i));
            }
            auto conds = Protocol::ReadStandingOrderConditions(req->conditions());
            const uint32_t id = standingOrders.Create(
                session->team,
                static_cast<StandingOrderType>(req->type()),
                req->priority(),
                std::move(params),
                std::move(conds),
                req->expires_in_frames(),
                static_cast<uint32_t>(sim.GetFrameNum()));
            SLOG(SPRING_LOG_DEBUG,
                "standing-order: client %u (%s, team=%d) created order %u type=%u priority=%u",
                msg.clientId, session->username.c_str(), session->team,
                id, static_cast<unsigned>(req->type()), req->priority());
            break;
        }
        case SpringWeb::ClientPayload_StandingOrderUpdate: {
            auto* session = sessions.GetSession(msg.clientId);
            if (!session || session->team < 0) {
                auto err = Protocol::BuildServerError(401, "Not authenticated");
                rtcServer.SendReliable(msg.clientId, err.data(), err.size());
                break;
            }
            auto* req = clientMsg->payload_as_StandingOrderUpdate();
            if (!req) break;
            if (!SessionManager::TryConsumeCommandBudget(*session, 0)) {
                auto err = Protocol::BuildServerError(429, "Command rate limit exceeded");
                rtcServer.SendReliable(msg.clientId, err.data(), err.size());
                break;
            }
            if (req->sequence() <= session->lastCommandSeq && session->lastCommandSeq > 0) {
                auto err = Protocol::BuildServerError(400, "Stale command sequence");
                rtcServer.SendReliable(msg.clientId, err.data(), err.size());
                break;
            }
            session->lastCommandSeq = req->sequence();

            std::vector<float> params;
            if (auto* p = req->params()) {
                params.reserve(p->size());
                for (unsigned i = 0; i < p->size(); ++i) params.push_back(p->Get(i));
            }
            auto conds = Protocol::ReadStandingOrderConditions(req->conditions());
            const bool ok = standingOrders.Update(
                req->order_id(), session->team,
                req->priority(), std::move(params), std::move(conds),
                req->active());
            if (!ok) {
                auto err = Protocol::BuildServerError(403, "Not owner of standing order");
                rtcServer.SendReliable(msg.clientId, err.data(), err.size());
            }
            break;
        }
        case SpringWeb::ClientPayload_StandingOrderRemove: {
            auto* session = sessions.GetSession(msg.clientId);
            if (!session || session->team < 0) {
                auto err = Protocol::BuildServerError(401, "Not authenticated");
                rtcServer.SendReliable(msg.clientId, err.data(), err.size());
                break;
            }
            auto* req = clientMsg->payload_as_StandingOrderRemove();
            if (!req) break;
            if (!SessionManager::TryConsumeCommandBudget(*session, 0)) {
                auto err = Protocol::BuildServerError(429, "Command rate limit exceeded");
                rtcServer.SendReliable(msg.clientId, err.data(), err.size());
                break;
            }
            if (req->sequence() <= session->lastCommandSeq && session->lastCommandSeq > 0) {
                auto err = Protocol::BuildServerError(400, "Stale command sequence");
                rtcServer.SendReliable(msg.clientId, err.data(), err.size());
                break;
            }
            session->lastCommandSeq = req->sequence();
            const bool ok = standingOrders.Remove(req->order_id(), session->team);
            if (!ok) {
                auto err = Protocol::BuildServerError(403, "Not owner of standing order");
                rtcServer.SendReliable(msg.clientId, err.data(), err.size());
            }
            break;
        }
        default:
            break;
    }
    #undef BROADCAST_ROOM_UPDATE
}
