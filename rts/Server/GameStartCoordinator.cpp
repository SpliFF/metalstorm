#include "GameStartCoordinator.h"
#include "GameServerContext.h"

#include "Simulation.h"
#include "Protocol.h"
#include "WebTransport/WebTransportServer.h"
#include "Sim/Misc/TeamHandler.h"
#include "Map/ReadMap.h"
#include "Sim/Misc/GlobalConstants.h"
#include "System/SpringLog/SpringLog.h"

#define LOG_SECTION "server"

// Push a current StandingOrderState snapshot to one client. Used both from the
// live-change notifier (broadcast scope) and from the auth paths (one-shot
// snapshot to a freshly connected session, so mid-game joiners see existing
// orders without waiting for the next mutation).
void GameStartCoordinator::PushStandingOrdersTo(ClientID clientId, int team) {
    if (team < 0) return;
    std::vector<int> allied;
    const int activeTeams = teamHandler.ActiveTeams();
    for (int t = 0; t < activeTeams; ++t) {
        if (t == team) continue;
        if (teamHandler.AlliedTeams(team, t)) allied.push_back(t);
    }
    auto msg = Protocol::BuildStandingOrderState(
        team, allied, standingOrders.GetAllOrders());
    ctx.rtcServer.SendReliable(clientId, msg.data(), msg.size());
}

// Team start positions + ally start boxes (PLAN-bar.md §3b read shims:
// Spring.GetTeamStartPosition / GetAllyTeamStartBox). Built from the live
// TeamHandler/AllyTeam state. Positions are RH-canonical elmos (the engine's
// FlipPosZ is a no-op), matching entity-state positions and the synced
// Spring.GetTeamStartPosition. Ally boxes mirror Spring.GetAllyTeamStartBox
// (rect fractions × map size); the headless flow never calls
// Spring.SetAllyTeamStartBox, so they default to the full map — streamed
// faithfully so a game that does set boxes works without a second wire change.
std::vector<uint8_t> GameStartCoordinator::BuildTeamStartInfoMsg() {
    std::vector<SpringWeb::TeamStartPos> teamPositions;
    const int activeTeams = teamHandler.ActiveTeams();
    teamPositions.reserve(activeTeams);
    for (int t = 0; t < activeTeams; ++t) {
        const CTeam* team = teamHandler.Team(t);
        if (team == nullptr) continue;
        const float3& p = team->GetStartPos();
        teamPositions.emplace_back(
            static_cast<int16_t>(t),
            static_cast<int16_t>(team->teamAllyteam),
            p.x, p.y, p.z, team->HasValidStartPos());
    }
    std::vector<SpringWeb::AllyStartBox> allyBoxes;
    const int activeAllyTeams = teamHandler.ActiveAllyTeams();
    allyBoxes.reserve(activeAllyTeams);
    const float mapW = static_cast<float>(mapDims.mapx * SQUARE_SIZE);
    const float mapH = static_cast<float>(mapDims.mapy * SQUARE_SIZE);
    for (int a = 0; a < activeAllyTeams; ++a) {
        const ::AllyTeam& at = teamHandler.GetAllyTeam(a);
        allyBoxes.emplace_back(
            static_cast<int16_t>(a),
            mapW * at.startRectLeft, mapH * at.startRectTop,
            mapW * at.startRectRight, mapH * at.startRectBottom);
    }
    return Protocol::BuildTeamStartInfo(teamPositions, allyBoxes);
}

void GameStartCoordinator::CheckAndFireGameStart() {
    if (ctx.sim.HasGameStarted())
        return;
    if (ctx.connectedRosterPlayers.size() < ctx.rosterPlayersNeeded)
        return;
    SLOG(SPRING_LOG_NOTICE, "all %zu roster players connected, firing GameStart",
        ctx.rosterPlayersNeeded);
    ctx.sim.FireGameStart();
    // Re-broadcast start positions: start gadgets (e.g. BAR's
    // game_initial_spawn.lua) relocate teams via Spring.SetTeamStartPosition
    // during FireGameStart, so the post-spawn values differ from the
    // pre-game ones already sent on auth.
    if (ctx.rtcServer.GetClientCount() > 0) {
        auto tsi = BuildTeamStartInfoMsg();
        ctx.rtcServer.BroadcastReliable(tsi.data(), tsi.size());
    }
}
