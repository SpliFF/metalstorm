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

// AI slot request from the lobby (`--ai id:team:pos`).
struct RequestedAI {
    std::string id;
    int team = 0;
    int startPos = -1;
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
    int&                                      nextPlayerNum;
    std::unordered_set<std::string>&          connectedRosterPlayers;
    size_t                                    rosterPlayersNeeded = 0;
};
