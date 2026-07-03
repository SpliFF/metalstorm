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
#include <vector>

class GameOverRelay {
public:
    // Record the game result. First declaration wins (a game is over once); a
    // later declaration — e.g. the fallback firing after a gadget already
    // called Spring.GameOver — is ignored so the winners can't be overwritten.
    void Declare(const std::vector<uint8_t>& winners) {
        if (declared)
            return;
        winningAllyTeams = winners;
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

private:
    bool declared = false;                    // latched forever after first game-over
    bool pending  = false;                    // true until StateStreamer broadcasts once
    std::vector<uint8_t> winningAllyTeams;    // as passed to Spring.GameOver(...)
};

extern GameOverRelay gameOverRelay;
