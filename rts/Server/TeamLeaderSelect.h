/* This file is part of the Spring engine (GPL v2 or later), see LICENSE.html */

// TeamLeaderSelect — pure leader-selection policy for FireGameStart (AI3).
//
// Extracted as a free function so it can be unit-tested without booting the
// whole sim (same idiom as GameOverState.h's ShouldRunEliminationFallback).
#pragma once

namespace TeamLeaderSelect {

/// A team's active player, as seen by the leader pass: its playerNum and
/// whether it is an AI virtual player (PlayerBase::isAI).
struct Candidate {
    int  playerNum = -1;
    bool isAI = false;
};

/// Choose a team's leader from its active players (PLAN-metalstorm-ai.md §1,
/// AI3). `players` is expected in ascending playerNum order, exactly as
/// CPlayerHandler::ActivePlayersInTeam returns them.
///
/// Policy: prefer a HUMAN (non-AI) player — on a mixed team (co-commander: an
/// AI shares a human's team) the human leads, never the AI. Fall back to the
/// lowest AI player only when the team has no human (a full-side AI team is led
/// by its own AI virtual player). Return -1 for an empty team (honestly
/// leaderless — we no longer borrow the host human as an AI team's leader).
template <typename It>
inline int SelectLeader(It begin, It end) {
    int leader = -1;
    for (It it = begin; it != end; ++it) {
        if (leader < 0)
            leader = it->playerNum;   // fallback: lowest active player (may be the AI)
        if (!it->isAI)
            return it->playerNum;     // prefer a human leader
    }
    return leader;
}

} // namespace TeamLeaderSelect
