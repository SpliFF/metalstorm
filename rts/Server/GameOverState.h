// GameOverState — one-shot relay carrying a declared game result from the sim
// thread to the per-tick broadcast pipeline (StateStreamer).
//
// Spring's original game-end path went through `CGame::GameEnd`, which this
// fork removed with Game.h (see the TODO in LuaSyncedCtrl::GameOver). That left
// `Spring.GameOver(winners)` firing the synced eventHandler callin but with no
// mechanism to tell the *clients* who won — the client could only infer "game
// over" from a paused GameInfo, with an empty winners table (the deviation this
// replaces). This relay restores the missing link: a game gadget's
// `Spring.GameOver`, or StateStreamer's own last-team-standing fallback,
// declares the winning allyteams here; StateStreamer consumes the declaration
// once and broadcasts a `GameInfo{ game_over = true, winning_ally_teams = … }`.
//
// Threading: both the writer (LuaSyncedCtrl::GameOver, a synced Lua callin) and
// the reader (StateStreamer::Tick) run on the single sim thread, so no locking
// is needed — unlike the cross-thread PlayerTeamEventCollector.
#pragma once

#include <cstdint>
#include <string>
#include <vector>

// Pure gate for StateStreamer::CheckWinCondition's hardcoded last-team-standing
// fallback (teams 0/1 empty-unit-count check). Kept as a free function so it's
// unit-testable without a live sim/GameServerContext.
//
// PLAN-metalstorm-teams.md §4 is explicit: "GameOver conditions are
// objective/scenario-driven, never 'team has no players'" — so the fallback
// must never run for Metalstorm, regardless of cheat state. It also must never
// run under cheats (scenarios intentionally leave AI slots empty and rely on
// cheats to keep the sim running indefinitely — see StateStreamer.cpp).
inline bool ShouldRunEliminationFallback(const std::string& gameId, bool cheatEnabled) {
    return !cheatEnabled && gameId != "metalstorm";
}

class GameOverRelay {
public:
    // Record the game result. First declaration wins (a game is over once); a
    // later declaration — e.g. the fallback firing after a gadget already
    // called Spring.GameOver — is ignored so the winners can't be overwritten.
    void Declare(const std::vector<uint8_t>& winners, int frame = 0) {
        if (declared)
            return;
        winningAllyTeams = winners;
        declaredFrame = frame;
        declared = true;
        pending = true;
    }

    // Called each tick by StateStreamer. Returns true exactly once — on the
    // first tick after a declaration — handing back the winners so the caller
    // broadcasts the game-over GameInfo a single time.
    bool ConsumePending(std::vector<uint8_t>& out) {
        if (!pending)
            return false;
        pending = false;
        out = winningAllyTeams;
        return true;
    }

    bool IsDeclared() const { return declared; }

    // The retained result, for everything that needs it *after* the one-shot
    // broadcast has already gone out. ConsumePending intentionally fires once
    // — a client that authenticates later never saw it, and without this a
    // spectator joining a finished match gets a normal live HUD with no
    // overlay (observed live 2026-08-03: a spectator joining ~2400 frames
    // after the win saw a game that looked like it was still being played).
    // ClientMessageHandler replays a game-over GameInfo from these on auth.
    const std::vector<uint8_t>& Winners() const { return winningAllyTeams; }
    int DeclaredFrame() const { return declaredFrame; }

private:
    bool declared = false;                    // latched forever after first game-over
    bool pending  = false;                    // true until StateStreamer broadcasts once
    int  declaredFrame = 0;                   // sim frame the result was declared at
    std::vector<uint8_t> winningAllyTeams;    // as passed to Spring.GameOver(...)
};

extern GameOverRelay gameOverRelay;
