#pragma once

// GameServerContext — a plain aggregation of references / values that the
// extracted spring-server units (GameStartCoordinator, ClientMessageHandler,
// StateStreamer, GameHttpRoutes) need. It owns nothing and carries no logic;
// it just wires up the long-lived objects main() constructs so the extracted
// code can reach them without main() passing a dozen args to each call.
//
// NOTE: many sim-side singletons (teamHandler, unitHandler, playerHandler,
// eventHandler, pathManager, luaRules, readMap, mapDims, gs, losHandler,
// standingOrders, perfMetrics, g_luaDebugger, plus every event collector
// global) are NOT members here — the extracted code keeps referencing those
// directly through their own `extern` declarations exactly as server_main.cpp
// always has.

#include "NetworkServer.h"          // ClientID
#include "DynamicJoin.h"            // SessionKind, WAR_SIDE_CAPACITY_DEFAULT
#include <cstdint>
#include <string>
#include <vector>
#include <unordered_map>
#include <unordered_set>

class WebTransportServer;
class CSimulation;
class Database;
class SessionManager;
class RoomManager;
class AIRuntimePool;
class LuaExecEngine;

// Human player roster slot from the lobby (`--player username:team:pos`).
struct RequestedPlayer {
    std::string username;
    int team = 0;
    int startPos = -1;
};

// AI slot request from the lobby (`--ai id:team:pos:profile`).
struct RequestedAI {
    std::string id;
    int team = 0;
    int startPos = -1;
    // AI3 (PLAN-metalstorm-ai.md §1): the virtual playerID allocated for this
    // AI slot at startup (server_main registers a real CPlayer per AI). -1
    // until registered. Passed to AIRuntimePool::AddAI as the charge identity.
    int playerNum = -1;
    // PLAN-metalstorm-ai.md §10 task 6: optional personality/difficulty
    // profile name (e.g. "aggressive", "caretaker") requested by the lobby
    // or a --headless-run manifest's aiSlots[].profile. Empty = no override
    // (the AI VM falls back to a scenario-published ai_profile or
    // Config.DEFAULT_PROFILE). Untrusted text — validated Lua-side by
    // main.lua's resolveProfile() against Config.PROFILES, never here.
    std::string profile;
};

struct GameServerContext {
    NetworkServer&      net;
    WebTransportServer& rtcServer;
    CSimulation&        sim;
    Database&           db;
    SessionManager&     sessions;
    RoomManager&        rooms;
    AIRuntimePool&      aiPool;
    LuaExecEngine&      luaExecEngine;

    uint32_t    roomId = 0;
    std::string gameId;
    std::string mapId;
    int         port = 0;
    bool        logMessages = false;
    std::string defsCacheKey;

    std::vector<RequestedPlayer>&             requestedPlayers;
    std::vector<RequestedAI>&                 requestedAIs;
    std::unordered_map<std::string, int>&     playerTeamByUsername;
    std::unordered_map<ClientID, int>&        clientPlayerNum;
    // PLAN-quickstart.md §3.3: reason from a client's PlayerLeaveIntent
    // (sent just before a deliberate disconnect), consumed by the disconnect
    // handler in server_main.cpp and cleared per-client alongside the other
    // per-client maps. Absent = default reason 0 (voluntary quit).
    std::unordered_map<ClientID, uint8_t>&    pendingLeaveReason;
    int&                                      nextPlayerNum;
    // D16 (PLAN-endtoend.md §Defect register): account id -> sim playerNum,
    // stable for the game server's lifetime. A reconnect (detach/resync, or a
    // genuine quit + rejoin) MUST come back as the same sim player: every
    // synced key a client reads is scoped by its playerNum
    // (`authority_player_<n>`, `authority_granted_<n>`, the AI's spend
    // identity), so minting a fresh number strands the player's own state
    // under the retired one and puts a duplicate name on the scoreboard.
    // Keyed by account id rather than username: the account is the identity
    // the lobby issued the session token against (see the player-identity
    // contract — `ctx.identity.playerId` is this playerNum, NOT the account).
    // AI virtual players have no account and never appear here.
    std::unordered_map<int64_t, int>&         playerNumByAccount;
    std::unordered_set<std::string>&          connectedRosterPlayers;
    size_t                                    rosterPlayersNeeded = 0;
    /// Whether GameStart is held until `rosterPlayersNeeded` humans have
    /// connected. True for a skirmish — the classic "all clients loaded" gate.
    /// False for a persistent war (PLAN-metalstorm-lobby.md §2.1): the war
    /// starts with whatever seed exists and players trickle in, so a roster is
    /// an *initial* set rather than a precondition. The roster count itself
    /// stays honest either way — it is what the logs and the team mapping read.
    bool                                      waitsForRoster = true;
    /// This session's kind, from `--session-kind` (task 1). The auth handler
    /// needs it in its own right and not merely via `waitsForRoster`: task 2's
    /// dynamic join is a *war* rule, and reading it off the roster-wait flag
    /// would hand the same behaviour to a skirmish that happened to launch
    /// with an empty roster (`SessionStartsGameAtSetup`'s second term).
    SessionKind                               sessionKind = SessionKind::Skirmish;
    /// Humans allowed per war side before a dynamic joiner is turned back to
    /// spectating (`--war-side-capacity`, 0 = unlimited). Uniform across sides
    /// by design — per-side capacities and queue-when-full are task 7.
    unsigned                                  warSideCapacity =
                                                  WAR_SIDE_CAPACITY_DEFAULT;

    // C1: clients that have sent a protocol-compatible Handshake. AuthRequest
    // is refused until a matching handshake is recorded, so a client that
    // skips the handshake (or sent an incompatible version) can't get a
    // session. Cleared on disconnect alongside the other per-client maps.
    std::unordered_set<ClientID>&             handshakedClients;
};
