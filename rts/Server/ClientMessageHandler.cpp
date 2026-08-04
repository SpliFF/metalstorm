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
#include "OrgGroups.h"
#include "LuaExecEngine.h"
#include "SyncedInputJournal.h"
#include "ReplayPlayer.h"
#include "GameOverState.h"
#include "PostGamePolicy.h"
#include "PlayerRosterBroadcast.h"
#include "Crypto.h"
#include "WebTransport/WebTransportServer.h"
#include "Lua/LuaRules.h"
#include "Sim/Units/UnitHandler.h"
#include "Sim/Units/Unit.h"
#include "Sim/Units/CommandAI/CommandAI.h"
#include "Sim/Units/CommandAI/Command.h"
#include "Sim/Misc/TeamHandler.h"
#include "Sim/Misc/Wind.h"
#include "Sim/Misc/GlobalSynced.h"
#include "Sim/Misc/ModInfo.h"
#include "Sim/MoveTypes/MoveDefHandler.h"
#include "Sim/Path/IPathManager.h"
#include "Game/Players/PlayerHandler.h"
#include "Game/GameSetup.h"
#include "System/SpringLog/SpringLog.h"
#include "System/EventHandler.h"

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

/// ClientSession::role / CanCommandTeam / StateStreamer all key off this
/// exact string — see PLAN-metalstorm-onboarding.md §4.
const std::string kSpectatorRole = "spectator";
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

    // ── Journal chokepoint #1 of 5: inbound client verbs (PLAN-replay task 1).
    // Recorded here, once, BEFORE dispatch — so every verb in the switch below
    // is covered by construction and a newly added case cannot escape the
    // cause stream. What gets kept is decided by the exhaustive classifier in
    // SyncedInputJournal.cpp, never by the individual handlers.
    //
    // The RAW wire bytes are recorded, not a decoded form: replay re-feeds
    // them through this same HandleMessage, so a replayed run cannot drift
    // from the live one through a decode difference. Recording before dispatch
    // (rather than after a successful apply) is deliberate too — a message
    // rejected by the rate limiter or the sequence check on the live run must
    // be rejected identically on replay, and that only holds if replay sees
    // the same input, including the ones that bounced.
    {
        auto pjIt = clientPlayerNum.find(msg.clientId);
        syncedinput::Journal().RecordClientMessage(
            static_cast<uint8_t>(clientMsg->payload_type()),
            pjIt != clientPlayerNum.end() ? pjIt->second : -1,
            static_cast<uint32_t>(msg.clientId),
            msg.data.data(), msg.data.size());
    }

    // ── Post-game gate. The match is over and the sim is frozen, so anything
    // that would reach the sim is refused here, once, ahead of the switch.
    //
    // Placed after the journal record on purpose: a verb refused live must be
    // refused identically on replay, and that only holds if replay is fed the
    // same input including the ones that bounced (see the note above).
    //
    // This has to be server-side. The client stops sending orders because the
    // result overlay covers the screen — which is not a check at all: a
    // scripted client, or one that reconnects after the win, walks straight
    // past it. Live on 2026-08-03 a `StandingOrderCreate` posted after the
    // declared win was accepted *and* charged 2 authority against a player in
    // a finished match. See PostGamePolicy.h.
    if (gameOverRelay.IsDeclared() &&
        postgame::RejectsClientPayload(
            static_cast<uint8_t>(clientMsg->payload_type()))) {
        auto err = Protocol::BuildServerError(409, "Game over");
        rtcServer.SendReliable(msg.clientId, err.data(), err.size());
        return;
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

            // ── Live client on a replay server = spectator, unconditionally ──
            // (PLAN-replay §7.11 T2-a-3.) The recorded connections come back
            // through the virtual-id branch below; anything else is somebody
            // who tuned in to watch a re-execution. Its account may well BE the
            // player whose game this is — the recording is not re-opened to
            // let them play it again. Forced spectator, forced team -1, a
            // player number from the reserved range, and deliberately absent
            // from `playerHandler`/`clientPlayerNum` so no synced pass can see
            // it (the reasoning is in ReplayPlayer.h next to the constants).
            const bool replaySpectator =
                replay::IsReplaying() && !replay::IsVirtualClient(msg.clientId);

            // Register the sim-side player for a LIVE auth and return the
            // player number the AuthResponse carries. Shared by the token and
            // the password path, which had drifted into two copies of it.
            auto registerLivePlayer = [&](const std::string& name, int team,
                                          bool spectator) -> int {
                if (replaySpectator) {
                    // No CPlayer, no clientPlayerNum entry, no consumption of
                    // `nextPlayerNum` — the recorded auths cross-check against
                    // that counter and a spectator must not move it.
                    const int specNum = replay::AllocSpectatorPlayerNum();
                    SLOG(SPRING_LOG_NOTICE,
                        "replay: admitting client %u as spectator '%s' "
                        "(playerNum %d, reserved range; not in the sim roster)",
                        msg.clientId, name.c_str(), specNum);
                    return specNum;
                }
                const int pNum = nextPlayerNum++;
                CPlayer p;
                p.name      = name;
                p.team      = team;
                p.active    = true;
                p.playerNum = pNum;
                p.spectator = spectator;
                playerHandler.AddPlayer(p);
                clientPlayerNum[msg.clientId] = pNum;
                return pNum;
            };

            // One-shots every authenticated session needs — fresh login AND
            // token reconnect (the browser stores its lobby session token, so
            // the reconnect path is the common case). Without sending these on
            // reconnect, the in-game LuaUI worker never gets the modoptions
            // (GetModOptions stays {}); TeamStartInfo otherwise only survives
            // via its post-GameStart re-broadcast.
            auto sendPostAuthOneShots = [&]() {
                // Team start positions + ally start boxes →
                // Spring.GetTeamStartPosition / GetAllyTeamStartBox.
                auto tsi = start.BuildTeamStartInfoMsg();
                rtcServer.SendReliable(msg.clientId, tsi.data(), tsi.size());
                // The game's modoptions → worker Spring.GetModOptions(), the
                // same set the synced gadgets + defs-cache key see. Immutable
                // for the game server's lifetime → one-shot per client.
                const auto& opts = CGameSetup::GetModOptions();
                std::vector<std::pair<std::string, std::string>> kvs;
                kvs.reserve(opts.size());
                for (const auto& kv : opts) kvs.emplace_back(kv.first, kv.second);
                auto mo = Protocol::BuildGameModOptions(kvs);
                rtcServer.SendReliable(msg.clientId, mo.data(), mo.size());
                // GameInfo carries the immutable game constants the in-game
                // LuaUI worker's `Game` table snapshots at boot — crucially
                // `max_units` (the unit/feature ID-space boundary feature-order
                // params pack against; a client/server mismatch silently
                // misdecodes every feature-targeted reclaim/repair order — see
                // PLAN-bar.md) and `legacy_coord_system`. The periodic
                // BroadcastGameInfo refines the live fields (frame/speed/wind),
                // but a just-connected client wouldn't get one until the next
                // 30-frame boundary — possibly after the worker has already
                // booted and snapshotted Game.maxUnits. Sending it on auth
                // guarantees it lands in liveState before boot.
                //
                // It also carries the result when the match is already over.
                // The game-over broadcast is one-shot (GameOverRelay::
                // ConsumePending fires exactly once), so before this a session
                // that authenticated after the win learned nothing about it:
                // live 2026-08-03 a spectator joining ~2400 frames past the
                // declared win got a normal HUD with no overlay, reading as a
                // broken build. `frame` is the declared frame, not the live
                // one, so the overlay says the battle ended when it actually
                // did — the two are equal today because game over freezes the
                // sim, but the overlay's claim shouldn't depend on that.
                const float3& wv = envResHandler.GetCurrentWindVec();
                const bool over = gameOverRelay.IsDeclared();
                auto gi = Protocol::BuildGameInfo(
                    ctx.mapId, ctx.gameId, gs->speedFactor,
                    static_cast<uint32_t>(over ? gameOverRelay.DeclaredFrame()
                                               : sim.GetFrameNum()),
                    gs->paused,
                    wv.x, wv.y, wv.z,
                    envResHandler.GetCurrentWindStrength(),
                    envResHandler.GetCurrentTidalStrength(),
                    modInfo.legacyCoordSystem, unitHandler.MaxUnits(),
                    over, over ? gameOverRelay.Winners()
                               : std::vector<uint8_t>{});
                rtcServer.SendReliable(msg.clientId, gi.data(), gi.size());
                if (over) {
                    SLOG(SPRING_LOG_NOTICE,
                        "client %u authenticated after game over — replayed "
                        "result (frame %d, %zu winning allyteam(s))",
                        msg.clientId, gameOverRelay.DeclaredFrame(),
                        gameOverRelay.Winners().size());
                }
            };

            // Journal chokepoint #1's companion (PLAN-replay T2-a). The
            // AuthRequest bytes are already in the stream; this records what
            // the accounts database turned them INTO, because a re-execution
            // has no database that can answer the same way — a replica need
            // not carry the `sessions` row, and a campaign replayed weeks
            // later is asking about a token that has expired by construction.
            auto recordAuthIdentity = [&](int64_t userId,
                                          const std::string& name,
                                          const std::string& role, int team,
                                          int pNum, bool spectator) {
                // A replay spectator is not part of any cause stream: it is an
                // observer of one. (Nothing is written during a replay anyway
                // — `--replay` and `--journal-file` are mutually exclusive —
                // but the audit ring should not claim otherwise either.)
                if (replaySpectator) return;
                syncedinput::AuthIdentity id;
                id.userId    = userId;
                id.username  = name;
                id.role      = role;
                id.team      = team;
                id.playerNum = pNum;
                id.spectator = spectator;
                syncedinput::Journal().RecordAuthIdentity(
                    static_cast<uint32_t>(msg.clientId), id);
            };

            // ── Replay: the recorded stream is the identity authority ──────
            // (PLAN-replay §7.10, T2-a.) A replayed AuthRequest must NOT reach
            // `db` at all. Not as an optimisation — as correctness: the token
            // path would fail on a replica DB and fall through to "Session
            // expired", leaving the connection with no session, so every later
            // PlayerCommand from it would bounce at the REQUIRE_SESSION guard
            // and the replay would confidently reproduce a game in which the
            // human player never issued an order. The password path is worse
            // still: it would WRITE a fresh session row into the database of a
            // machine that is only replaying.
            //
            // Only live clients keep the database path. A live client on a
            // replay server is a spectator (server_main refuses its
            // sim-affecting verbs), so its identity is its own business.
            if (replay::IsReplaying() && replay::IsVirtualClient(msg.clientId)) {
                const uint32_t recId = replay::RecordedClientId(msg.clientId);
                const syncedinput::AuthIdentity* rid =
                    replay::Feed().IdentityFor(recId);
                if (rid == nullptr) {
                    // Only successful resolutions are recorded, so the absence
                    // of one IS the recorded outcome: this connection's auth
                    // failed live (wrong password, expired token, ban, unknown
                    // account). Reproduce the refusal rather than re-asking a
                    // database that may well answer differently.
                    SLOG(SPRING_LOG_NOTICE,
                        "replay: recorded client %u never authenticated "
                        "successfully — refusing, as the recording did", recId);
                    auto resp = Protocol::BuildAuthResponse(
                        SpringWeb::AuthStatus_InvalidCredentials, "", 0,
                        "Replay: no recorded identity");
                    rtcServer.SendReliable(msg.clientId, resp.data(), resp.size());
                    break;
                }

                // The DB-derived half (account id, username, role) is taken
                // from the record. The half the LAUNCH SPEC determines — team
                // and player number — is re-derived here and compared, the
                // same discipline the GameStart record's roster check uses: a
                // divergence in either means every later PlayerCommand is
                // about to be authorised against a different player or team
                // than the recording used, and the honest response is to stop
                // with a located reason rather than produce a confident replay
                // of a game nobody played.
                const int derivedTeam = resolveTeam(rid->username);
                if (derivedTeam != rid->team) {
                    SLOG(SPRING_LOG_ERROR,
                        "replay: team divergence authenticating '%s' — recorded "
                        "team %d, replay roster resolves %d",
                        rid->username.c_str(), rid->team, derivedTeam);
                    replay::Feed().RequestStop("team divergence at auth");
                    break;
                }
                if (nextPlayerNum != rid->playerNum) {
                    SLOG(SPRING_LOG_ERROR,
                        "replay: player-number divergence authenticating '%s' — "
                        "recorded playerNum %d, replay would allocate %d "
                        "(player registration order differs from the recording)",
                        rid->username.c_str(), rid->playerNum, nextPlayerNum);
                    replay::Feed().RequestStop("player-number divergence at auth");
                    break;
                }

                const int pNum = rid->playerNum;
                nextPlayerNum = pNum + 1;
                {
                    CPlayer p;
                    p.name      = rid->username;
                    p.team      = rid->team;
                    p.active    = true;
                    p.playerNum = pNum;
                    p.spectator = rid->spectator;
                    playerHandler.AddPlayer(p);
                    clientPlayerNum[msg.clientId] = pNum;
                }
                // Sent for symmetry with the live paths, and it costs nothing:
                // the virtual id has no transport, so the reply is dropped.
                // Keeping the send means the two paths do not drift.
                auto resp = Protocol::BuildAuthResponse(
                    SpringWeb::AuthStatus_OK, "",
                    static_cast<uint32_t>(rid->userId), "",
                    static_cast<int8_t>(rid->team), rid->role, defsCacheKey,
                    static_cast<int32_t>(pNum));
                rtcServer.SendReliable(msg.clientId, resp.data(), resp.size());
                sessions.AddSession(msg.clientId, rid->userId, rid->username,
                                    rid->role);
                if (auto* s = sessions.GetSession(msg.clientId))
                    s->team = rid->team;
                start.PushStandingOrdersTo(msg.clientId, rid->team);
                start.PushOrgGroupsTo(msg.clientId, rid->team);
                start.PushDirectivesTo(msg.clientId, rid->team);
                sendPostAuthOneShots();
                Protocol::BroadcastPlayerRoster(ctx);
                SLOG(SPRING_LOG_NOTICE,
                    "replay: client %u authenticated as '%s' from the recorded "
                    "stream (account id=%lld) playerNum=%d team=%d role=%s",
                    msg.clientId, rid->username.c_str(),
                    (long long)rid->userId, pNum, rid->team, rid->role.c_str());
                // GameStart is reached exactly as it was live: through the
                // roster-connected count. The GameStart RECORD still arrives
                // next in the stream and finds the game already started, so it
                // does its roster cross-check and fires nothing (server_main's
                // GameStart case is guarded on HasGameStarted).
                if (playerTeamByUsername.count(rid->username)) {
                    connectedRosterPlayers.insert(rid->username);
                    start.CheckAndFireGameStart();
                }
                break;
            }

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
                    // On a replay server the roster belongs to the recording,
                    // so this account's place in it is irrelevant: team -1.
                    const int team = replaySpectator
                        ? -1 : resolveTeam(reconnectUser->username);
                    // An authenticated user who isn't in the roster the lobby
                    // handed us is a spectator, not a rejected connection —
                    // PLAN-metalstorm-onboarding.md §4's "spectate a running
                    // game" flow depends on this: spawnGameServer never puts
                    // spectators in --player, so every spectator (pre-game or
                    // mid-game) lands here with team < 0.
                    const bool isSpectator =
                        replaySpectator || (rosterRequired && team < 0);
                    const std::string& effectiveRole =
                        isSpectator ? kSpectatorRole : reconnectUser->role;
                    // Register a Spring CPlayer so Lua can
                    // query player info and receive callins.
                    // Spectators ARE players in Spring's playerHandler
                    // (PlayerBase::spectator), just non-commanding ones.
                    //
                    // This runs BEFORE BuildAuthResponse because the response
                    // now carries `player_num` — the client cannot derive it
                    // (it is a per-server allocation, not the account id), and
                    // every synced key it reads back is scoped by it.
                    const int pNum = registerLivePlayer(
                        reconnectUser->username, team, isSpectator);
                    auto resp = Protocol::BuildAuthResponse(
                        SpringWeb::AuthStatus_OK, auth->token()->str(),
                        static_cast<uint32_t>(userId), "",
                        static_cast<int8_t>(team), effectiveRole,
                        defsCacheKey, static_cast<int32_t>(pNum));
                    rtcServer.SendReliable(msg.clientId, resp.data(), resp.size());
                    // Register the session — previously the
                    // token path skipped this, which meant a
                    // reconnected client had no session and
                    // every PlayerCommand bounced at the
                    // REQUIRE_SESSION guard.
                    sessions.AddSession(msg.clientId, userId,
                        reconnectUser->username, effectiveRole);
                    if (auto* s = sessions.GetSession(msg.clientId))
                        s->team = team;
                    recordAuthIdentity(userId, reconnectUser->username,
                                       effectiveRole, team, pNum, isSpectator);
                    // One-shot standing-order snapshot so a
                    // mid-game reconnect sees existing orders
                    // immediately, without waiting for the
                    // next mutation to trigger the broadcast
                    // hook.
                    start.PushStandingOrdersTo(msg.clientId, team);
                    start.PushOrgGroupsTo(msg.clientId, team);
                    start.PushDirectivesTo(msg.clientId, team);
                    sendPostAuthOneShots();
                    // The roster changed (this player joined), so everyone
                    // gets it — not just the new arrival. Sent after
                    // AddSession so the joiner's own row carries its account
                    // id rather than a 0 placeholder.
                    Protocol::BroadcastPlayerRoster(ctx);
                    SLOG(SPRING_LOG_NOTICE,
                        "client %u reconnected as '%s' (account id=%lld) "
                        "playerNum=%d team=%d role=%s",
                        msg.clientId, reconnectUser->username.c_str(),
                        userId, pNum, team, effectiveRole.c_str());
                    // Track roster connection for GameStart. Never for a replay
                    // spectator: GameStart on a replay is an input in its own
                    // right (journal chokepoint #5) and the recorded record is
                    // the only thing allowed to fire it. A spectator whose
                    // account happens to be in the recording's roster would
                    // otherwise start the game early and land the whole
                    // pre-game prologue on the wrong side of it.
                    if (!replaySpectator &&
                        playerTeamByUsername.count(reconnectUser->username)) {
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
#ifndef SPRING_PROD
                // Auto-register for now (Phase 1 MVP, dev builds only). S1:
                // store a scrypt hash, never the raw password field.
                // PLAN-security-hardening G5: an unauthenticated WebTransport
                // handshake must not be able to silently mint accounts in
                // production — register via POST /api/auth/register first.
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
#else
                auto resp = Protocol::BuildAuthResponse(
                    SpringWeb::AuthStatus_InvalidCredentials, "", 0,
                    "Unknown user — register via POST /api/auth/register first");
                rtcServer.SendReliable(msg.clientId, resp.data(), resp.size());
                break;
#endif
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

            // Roster membership: an authenticated user not in the lobby's
            // --player roster is a spectator, not a rejected connection —
            // see the matching comment on the reconnect path above. Dev-mode
            // (empty roster) skips this and keeps the "command anything"
            // smoketest escape hatch for team == -1.
            // Replay servers: see the reconnect path above — team -1 always.
            const int team = replaySpectator ? -1 : resolveTeam(user->username);
            const bool isSpectator =
                replaySpectator || (rosterRequired && team < 0);
            const std::string& effectiveRole = isSpectator ? kSpectatorRole : user->role;

            // Create session
            std::string token = generateToken();
            db.CreateSession(user->id, token);

            // Register a Spring CPlayer so Lua can query
            // player info and receive callins. Spectators ARE players in
            // Spring's playerHandler (PlayerBase::spectator), just
            // non-commanding ones.
            //
            // Ordered ahead of BuildAuthResponse for the same reason as the
            // reconnect path above: the response carries `player_num`, and
            // nothing downstream can reconstruct it.
            const int pNum = registerLivePlayer(user->username, team, isSpectator);
            auto resp = Protocol::BuildAuthResponse(
                SpringWeb::AuthStatus_OK, token,
                static_cast<uint32_t>(user->id), "",
                static_cast<int8_t>(team), effectiveRole, defsCacheKey,
                static_cast<int32_t>(pNum));
            rtcServer.SendReliable(msg.clientId, resp.data(), resp.size());
            sessions.AddSession(msg.clientId, user->id, user->username, effectiveRole);
            if (auto* s = sessions.GetSession(msg.clientId))
                s->team = team;
            recordAuthIdentity(user->id, user->username, effectiveRole, team,
                               pNum, isSpectator);
            // One-shot standing-order snapshot for the freshly
            // authenticated session — mirrors the reconnect
            // path above. Without this, mid-game joins
            // wouldn't see existing orders until the next
            // create / update / remove fired the broadcast
            // hook.
            start.PushStandingOrdersTo(msg.clientId, team);
            start.PushOrgGroupsTo(msg.clientId, team);
            start.PushDirectivesTo(msg.clientId, team);

            // Team start positions + ally start boxes (re-broadcast after
            // GameStart for the final post-spawn values) and the game's
            // modoptions. Shared with the reconnect path above.
            sendPostAuthOneShots();
            // Roster changed — everyone gets the new full roster, after
            // AddSession so the joiner's row carries its account id.
            Protocol::BroadcastPlayerRoster(ctx);

            SLOG(SPRING_LOG_NOTICE,
                "client %u authenticated as '%s' (account id=%lld) "
                "playerNum=%d team=%d role=%s",
                msg.clientId, username, user->id, pNum, team,
                effectiveRole.c_str());

            // Track roster connection for GameStart — never for a replay
            // spectator, same reason as the reconnect path above.
            if (!replaySpectator && playerTeamByUsername.count(user->username)) {
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

                // Route command to each target unit, dropping any the
                // session isn't allowed to command. Ownership is enforced
                // by SessionManager::CanCommandTeam (G4): rostered sessions
                // reach only their own team, spectators reach nothing, and
                // the lobby-less team==-1 escape hatch is dev-only.
                int routed = 0;
                int rejectedTeam = 0;
                if (cmd->squad_ids()) {
                    for (unsigned i = 0; i < cmd->squad_ids()->size(); i++) {
                        uint32_t unitId = cmd->squad_ids()->Get(i);
                        CUnit* unit = unitHandler.GetUnit(unitId);
                        if (unit == nullptr || unit->isDead)
                            continue;
                        if (!SessionManager::CanCommandTeam(*session, unit->team)) {
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
        // PLAN-quickstart.md §3.3: a client sends this immediately before a
        // deliberate disconnect() so the imminent PlayerLeft/PlayerRemoved
        // carries the real reason (e.g. 3=detach) instead of the default 0.
        // Stored, not acted on immediately — consumed once by the disconnect
        // drain loop in server_main.cpp, which also clears the entry.
        case SpringWeb::ClientPayload_PlayerLeaveIntent: {
            auto* session = sessions.GetSession(msg.clientId);
            if (!session) break;
            auto* pli = clientMsg->payload_as_PlayerLeaveIntent();
            ctx.pendingLeaveReason[msg.clientId] = pli ? pli->reason() : 0;
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
                    if (!SessionManager::CanCommandTeam(*session, unit->team)) {
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
        case SpringWeb::ClientPayload_RoomEnlist: {
            auto* session = sessions.GetSession(msg.clientId);
            if (!session) {
                auto e = Protocol::BuildServerError(401, "Auth required");
                rtcServer.SendReliable(msg.clientId, e.data(), e.size());
                break;
            }
            auto* room = rooms.FindRoomByClient(msg.clientId);
            if (!room) {
                auto e = Protocol::BuildServerError(400, "Not in a room");
                rtcServer.SendReliable(msg.clientId, e.data(), e.size());
                break;
            }
            auto* re = clientMsg->payload_as_RoomEnlist();
            const uint8_t team = re ? re->team() : 255;
            if (!rooms.EnlistSpectator(room->id, static_cast<uint32_t>(session->userId), team)) {
                auto e = Protocol::BuildServerError(403, "Cannot enlist");
                rtcServer.SendReliable(msg.clientId, e.data(), e.size());
                break;
            }
            BROADCAST_ROOM_UPDATE(room);
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
            // PLAN-security-hardening task 4 (G6): the relay previously had
            // no size cap and no rate limit at all, unlike PlayerCommand's
            // token bucket. Checked before the payload is even copied out.
            if (dataVec->size() > SessionManager::LUA_MSG_MAX_BYTES) {
                SLOG(SPRING_LOG_WARNING,
                     "[server] LuaRulesMsg drop: client=%u oversized payload (%zu bytes > %zu)",
                     msg.clientId, static_cast<size_t>(dataVec->size()),
                     static_cast<size_t>(SessionManager::LUA_MSG_MAX_BYTES));
                auto err = Protocol::BuildServerError(413, "LuaRulesMsg payload too large");
                rtcServer.SendReliable(msg.clientId, err.data(), err.size());
                break;
            }
            if (!SessionManager::TryConsumeLuaMsgBudget(*session)) {
                SLOG(SPRING_LOG_WARNING,
                     "[server] LuaRulesMsg drop: client=%u rate-limited (drop #%u)",
                     msg.clientId, session->luaMsgRateLimitDrops);
                auto err = Protocol::BuildServerError(429, "LuaRulesMsg rate limit exceeded");
                rtcServer.SendReliable(msg.clientId, err.data(), err.size());
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

            // PLAN-security-hardening task 4 (G16): same cap as LuaRulesMsg
            // — the relay previously had no size/rate limit at all.
            if (dataVec->size() > SessionManager::LUA_MSG_MAX_BYTES) {
                SLOG(SPRING_LOG_WARNING,
                     "[server] LuaUIMsg drop: client=%u oversized payload (%zu bytes > %zu)",
                     msg.clientId, static_cast<size_t>(dataVec->size()),
                     static_cast<size_t>(SessionManager::LUA_MSG_MAX_BYTES));
                auto err = Protocol::BuildServerError(413, "LuaUIMsg payload too large");
                rtcServer.SendReliable(msg.clientId, err.data(), err.size());
                break;
            }
            if (!SessionManager::TryConsumeLuaMsgBudget(*session)) {
                SLOG(SPRING_LOG_WARNING,
                     "[server] LuaUIMsg drop: client=%u rate-limited (drop #%u)",
                     msg.clientId, session->luaMsgRateLimitDrops);
                auto err = Protocol::BuildServerError(429, "LuaUIMsg rate limit exceeded");
                rtcServer.SendReliable(msg.clientId, err.data(), err.size());
                break;
            }

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
            // PLAN-security-hardening task 4 (G13): unlike PlayerCommand,
            // this had no rate limit at all — a flood of PathRequest ran
            // unthrottled synchronous pathfinding on the sim thread, a
            // direct DoS on tick time. Checked after parsing (so we can
            // answer with a definitive empty path rather than leaving the
            // client's request_id promise hanging) but before the actual
            // pathfind runs.
            if (!SessionManager::TryConsumePathRequestBudget(*session)) {
                SLOG(SPRING_LOG_WARNING,
                     "[server] PathRequest drop: client=%u rate-limited (drop #%u)",
                     msg.clientId, session->pathReqRateLimitDrops);
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

            // Authority charge site (PLAN-metalstorm-authority.md §3.2/A2):
            // game_authority_charge.lua debits the issuing player's pool
            // (falling back to the team pool) as a side effect of allowing
            // this callin; a false veto means insufficient authority.
            {
                int playerID = -1;
                auto pIt = clientPlayerNum.find(msg.clientId);
                if (pIt != clientPlayerNum.end()) playerID = pIt->second;
                if (!eventHandler.AllowStandingOrderCreate(session->team, playerID, req->type())) {
                    auto err = Protocol::BuildServerError(402, "Insufficient authority");
                    rtcServer.SendReliable(msg.clientId, err.data(), err.size());
                    break;
                }
            }

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
        // PLAN-security-hardening task 11 (G14): these 14 ClientPayload verbs
        // are declared in the schema but have no handler. Previously they fell
        // through `default: break` and were silently discarded — which reads,
        // to anyone auditing the switch, as "handled". Enumerate them here with
        // an explicit reject so (a) an operator sees a client probing an
        // unimplemented verb, and (b) nobody can re-enable one by dropping code
        // into `default` without deliberately removing it from this block and
        // giving it a real gate. We drop rather than reply (no amplification)
        // and rate-limit the log to a DEBUG line.
        //
        // Rationale for reject-not-wire: the room-management verbs
        // (RoomEndGame/RoomAddAI/RoomRemoveAI/RoomSetStartPos/RoomCloseRoom/
        // RoomSetAITeam) all have working, host-checked HTTP counterparts, so
        // the WT copies are redundant; the log verbs (LogIngest/LogSubscribe/
        // LogUnsubscribe) are served by the logserver's own (now
        // LocalhostOrAdmin-gated) HTTP routes; Ack/ReconnectRequest/ChatSend/
        // AIListRequest/GameListRequest are protocol niceties with no server
        // side today. They stay in the union for wire/protocol-version
        // stability (removing a union member renumbers tags); this block is the
        // gate. Wire one individually — with its own session+role check — if it
        // is ever actually needed.
        case SpringWeb::ClientPayload_ChatSend:
        case SpringWeb::ClientPayload_Ack:
        case SpringWeb::ClientPayload_ReconnectRequest:
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
            SLOG(SPRING_LOG_DEBUG, "rejecting unimplemented/ungated verb type=%d from client=%u",
                (int)clientMsg->payload_type(), msg.clientId);
            break;
        // -------- Macro command & control (PLAN-macro-orders / -directives) --------
        // All six share the standing-order gate discipline: authed team,
        // one message token (no per-squad order-token — the evaluator fans
        // out), monotonic sequence. Team scoping = team objects with player
        // attribution (macro-orders 2026-06-13 update).
        case SpringWeb::ClientPayload_OrgGroupCreate: {
            auto* session = sessions.GetSession(msg.clientId);
            if (!session || session->team < 0) {
                auto err = Protocol::BuildServerError(401, "Not authenticated");
                rtcServer.SendReliable(msg.clientId, err.data(), err.size());
                break;
            }
            auto* req = clientMsg->payload_as_OrgGroupCreate();
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

            std::vector<uint32_t> members;
            if (auto* m = req->member_ids()) {
                members.reserve(m->size());
                for (unsigned i = 0; i < m->size(); ++i) members.push_back(m->Get(i));
            }
            const uint32_t id = orgGroups.Create(
                session->team, static_cast<Echelon>(req->echelon()),
                req->name() ? req->name()->str() : std::string(),
                members, req->parent_id(),
                static_cast<uint32_t>(sim.GetFrameNum()));
            if (id == 0) {
                // v0 rejects the reserved army tier (echelon/parent) — fail loud.
                auto err = Protocol::BuildServerError(400,
                    "Org-group echelon/parent not supported in v0 (army tier reserved)");
                rtcServer.SendReliable(msg.clientId, err.data(), err.size());
            }
            break;
        }
        case SpringWeb::ClientPayload_OrgGroupUpdate: {
            auto* session = sessions.GetSession(msg.clientId);
            if (!session || session->team < 0) {
                auto err = Protocol::BuildServerError(401, "Not authenticated");
                rtcServer.SendReliable(msg.clientId, err.data(), err.size());
                break;
            }
            auto* req = clientMsg->payload_as_OrgGroupUpdate();
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

            std::vector<uint32_t> addIds, removeIds;
            if (auto* a = req->add_ids()) {
                addIds.reserve(a->size());
                for (unsigned i = 0; i < a->size(); ++i) addIds.push_back(a->Get(i));
            }
            if (auto* r = req->remove_ids()) {
                removeIds.reserve(r->size());
                for (unsigned i = 0; i < r->size(); ++i) removeIds.push_back(r->Get(i));
            }
            const bool ok = orgGroups.Update(
                req->group_id(), session->team, addIds, removeIds,
                req->name() ? req->name()->str() : std::string());
            if (!ok) {
                auto err = Protocol::BuildServerError(403, "Not owner of org group");
                rtcServer.SendReliable(msg.clientId, err.data(), err.size());
            }
            break;
        }
        case SpringWeb::ClientPayload_OrgGroupDisband: {
            auto* session = sessions.GetSession(msg.clientId);
            if (!session || session->team < 0) {
                auto err = Protocol::BuildServerError(401, "Not authenticated");
                rtcServer.SendReliable(msg.clientId, err.data(), err.size());
                break;
            }
            auto* req = clientMsg->payload_as_OrgGroupDisband();
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
            // Directives scoped to the group go with it (keeps the manager
            // dependency one-directional: handler drives both).
            directiveManager.RemoveForGroup(req->group_id());
            const bool ok = orgGroups.Disband(req->group_id(), session->team);
            if (!ok) {
                auto err = Protocol::BuildServerError(403, "Not owner of org group");
                rtcServer.SendReliable(msg.clientId, err.data(), err.size());
            }
            break;
        }
        case SpringWeb::ClientPayload_GroupPosture: {
            auto* session = sessions.GetSession(msg.clientId);
            if (!session || session->team < 0) {
                auto err = Protocol::BuildServerError(401, "Not authenticated");
                rtcServer.SendReliable(msg.clientId, err.data(), err.size());
                break;
            }
            auto* req = clientMsg->payload_as_GroupPosture();
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
            const bool ok = orgGroups.SetPosture(
                req->group_id(), session->team,
                req->posture_json() ? req->posture_json()->str() : std::string());
            if (!ok) {
                auto err = Protocol::BuildServerError(403, "Not owner of org group");
                rtcServer.SendReliable(msg.clientId, err.data(), err.size());
            }
            break;
        }
        case SpringWeb::ClientPayload_GroupDirective: {
            auto* session = sessions.GetSession(msg.clientId);
            if (!session || session->team < 0) {
                auto err = Protocol::BuildServerError(401, "Not authenticated");
                rtcServer.SendReliable(msg.clientId, err.data(), err.size());
                break;
            }
            auto* req = clientMsg->payload_as_GroupDirective();
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

            // Reject directives scoped to a group the caller doesn't own.
            const uint32_t groupId = req->group_id();
            if (groupId != 0) {
                const OrgGroup* g = orgGroups.Get(groupId);
                if (g == nullptr || g->team != session->team) {
                    auto err = Protocol::BuildServerError(403, "Not owner of org group");
                    rtcServer.SendReliable(msg.clientId, err.data(), err.size());
                    break;
                }
            }

            std::vector<float> params;
            if (auto* p = req->params()) {
                params.reserve(p->size());
                for (unsigned i = 0; i < p->size(); ++i) params.push_back(p->Get(i));
            }
            auto conds = Protocol::ReadStandingOrderConditions(req->conditions());
            const std::string phases = req->phases_json() ? req->phases_json()->str() : std::string();

            if (req->directive_id() == 0) {
                // Authority charge site (PLAN-metalstorm-authority.md
                // §3.2/A2, PLAN-macro-directives.md §1 "Charge point"):
                // charged ONCE at directive create, never on Update — the
                // directive's decomposed per-squad commands are fromLua
                // and free (§3.2 charging-rules table), so this is the
                // only spend a directive ever incurs.
                {
                    int playerID = -1;
                    auto pIt = clientPlayerNum.find(msg.clientId);
                    if (pIt != clientPlayerNum.end()) playerID = pIt->second;
                    if (!eventHandler.AllowDirectiveCreate(session->team, playerID, groupId,
                            req->type(), req->requested_strength())) {
                        auto err = Protocol::BuildServerError(402, "Insufficient authority");
                        rtcServer.SendReliable(msg.clientId, err.data(), err.size());
                        break;
                    }
                }

                const uint32_t id = directiveManager.Create(
                    session->team, static_cast<DirectiveType>(req->type()),
                    req->priority(), static_cast<OrderShape>(req->shape()),
                    std::move(params), std::move(conds), groupId,
                    req->requested_strength(), phases,
                    req->expires_in_frames(),
                    static_cast<uint32_t>(sim.GetFrameNum()));
                SLOG(SPRING_LOG_DEBUG,
                    "directive: client %u (team=%d) created directive %u type=%u group=%u",
                    msg.clientId, session->team, id,
                    static_cast<unsigned>(req->type()), groupId);
            } else {
                const bool ok = directiveManager.Update(
                    req->directive_id(), session->team,
                    static_cast<DirectiveType>(req->type()), req->priority(),
                    static_cast<OrderShape>(req->shape()), std::move(params),
                    std::move(conds), req->requested_strength(), phases,
                    req->active());
                if (!ok) {
                    auto err = Protocol::BuildServerError(403, "Not owner of directive");
                    rtcServer.SendReliable(msg.clientId, err.data(), err.size());
                }
            }
            break;
        }
        case SpringWeb::ClientPayload_GroupDirectiveRemove: {
            auto* session = sessions.GetSession(msg.clientId);
            if (!session || session->team < 0) {
                auto err = Protocol::BuildServerError(401, "Not authenticated");
                rtcServer.SendReliable(msg.clientId, err.data(), err.size());
                break;
            }
            auto* req = clientMsg->payload_as_GroupDirectiveRemove();
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
            const bool ok = directiveManager.Remove(req->directive_id(), session->team);
            if (!ok) {
                auto err = Protocol::BuildServerError(403, "Not owner of directive");
                rtcServer.SendReliable(msg.clientId, err.data(), err.size());
            }
            break;
        }
        default:
            break;
    }
    #undef BROADCAST_ROOM_UPDATE
}
