#pragma once

#include "NetworkServer.h"   // ClientID
#include "RoomManager.h"     // SessionKind
#include <cstddef>
#include <cstdint>
#include <vector>

struct GameServerContext;

// ── The roster gate, as two expressions rather than two open-coded tests ──
//
// PLAN-metalstorm-lobby.md §2.1. A skirmish holds GameStart until every
// rostered human has connected; a persistent war does not wait at all. These
// live here, in one place, because the same decision is read four times — the
// live set-up branch, the replay prologue-feed branch (which must agree with
// the live one exactly or a replay lands its prologue on the wrong side of
// GameStart), CheckAndFireGameStart, and the log line that tells an operator
// which of the two is happening.

/// Does GameStart wait for the launch roster to connect?
inline bool SessionWaitsForRoster(SessionKind kind) {
    return kind == SessionKind::Skirmish;
}

/// Does the game start during set-up rather than from CheckAndFireGameStart
/// in the sim loop? True when there is nothing to wait for (no roster) or no
/// waiting to do (a persistent war).
inline bool SessionStartsGameAtSetup(SessionKind kind, size_t rosterPlayersNeeded) {
    return !SessionWaitsForRoster(kind) || rosterPlayersNeeded == 0;
}

// GameStartCoordinator — owns the standing-order push, team-start-info build,
// and deferred-GameStart logic that used to live as main()-local lambdas in
// server_main.cpp. Pure relocation: same bodies, same globals referenced
// directly; only the captured locals route through `ctx`.
class GameStartCoordinator {
public:
    explicit GameStartCoordinator(GameServerContext& ctx) : ctx(ctx) {}

    // Push a current StandingOrderState snapshot to one client.
    void PushStandingOrdersTo(ClientID clientId, int team);
    void PushOrgGroupsTo(ClientID clientId, int team);
    void PushDirectivesTo(ClientID clientId, int team);

    // Build a TeamStartInfo message from the live TeamHandler/AllyTeam state.
    std::vector<uint8_t> BuildTeamStartInfoMsg();

    // Fire GameStart once all roster players have connected.
    void CheckAndFireGameStart();

private:
    GameServerContext& ctx;
};
