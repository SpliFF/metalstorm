#pragma once

#include "NetworkServer.h"   // ClientID
#include <cstdint>
#include <vector>

struct GameServerContext;

// GameStartCoordinator — owns the standing-order push, team-start-info build,
// and deferred-GameStart logic that used to live as main()-local lambdas in
// server_main.cpp. Pure relocation: same bodies, same globals referenced
// directly; only the captured locals route through `ctx`.
class GameStartCoordinator {
public:
    explicit GameStartCoordinator(GameServerContext& ctx) : ctx(ctx) {}

    // Push a current StandingOrderState snapshot to one client.
    void PushStandingOrdersTo(ClientID clientId, int team);

    // Build a TeamStartInfo message from the live TeamHandler/AllyTeam state.
    std::vector<uint8_t> BuildTeamStartInfoMsg();

    // Fire GameStart once all roster players have connected.
    void CheckAndFireGameStart();

private:
    GameServerContext& ctx;
};
