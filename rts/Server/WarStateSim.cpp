#include "WarStateSim.h"

#include <cstdio>
#include <string>
#include <variant>

#include "LuaExecEngine.h"
#include "Lua/LuaRules.h"
#include "Lua/LuaHandleSynced.h"
#include "Lua/LuaRulesParams.h"
#include "Sim/Misc/Team.h"
#include "Sim/Misc/TeamHandler.h"
#include "System/SpringLog/SpringLog.h"

#define LOG_SECTION "war-state"

namespace {

/// A rules param is a variant<bool, float, string>; every key this file reads
/// is written as a number by the gadgets, but a `false` would read back as a
/// bool and a hand-set key as a string. Anything that is not a number reads as
/// 0 rather than throwing — a malformed param must not take the war down on a
/// player's reconnect.
double ParamNumber(const LuaRulesParams::Params& params, const std::string& key) {
    const auto it = params.find(key);
    if (it == params.end()) return 0.0;
    if (const float* f = std::get_if<float>(&it->second.value)) return *f;
    if (const bool* b = std::get_if<bool>(&it->second.value)) return *b ? 1.0 : 0.0;
    return 0.0;
}

std::string PlayerKey(const char* prefix, int playerNum, const char* suffix = "") {
    char buf[64];
    snprintf(buf, sizeof(buf), "%s%d%s", prefix, playerNum, suffix);
    return buf;
}

/// Run a snippet against the synced LuaRules state. Every caller below builds
/// its snippet from numbers it computed itself — there is no string from a
/// client anywhere in this file, which is what makes a call-by-source
/// acceptable here (and it reuses the one exec path the console already goes
/// through, rather than hand-rolling a second lua_pcall bridge).
bool CallSynced(const char* what, const std::string& code) {
    if (luaRules == nullptr) {
        SLOG(SPRING_LOG_NOTICE, "%s skipped: LuaRules not loaded", what);
        return false;
    }
    const std::string out =
        ExecuteInLuaState(luaRules->syncedLuaHandle.GetLuaState(), code);
    // ExecuteInLuaState reports failures as a string rather than a status —
    // surface them, because a silently-refused restore is exactly the "join
    // that did not happen" shape this lane keeps finding.
    if (out.rfind("error", 0) == 0 || out.rfind("syntax error", 0) == 0 ||
        out.rfind("runtime error", 0) == 0) {
        SLOG(SPRING_LOG_WARNING, "%s failed: %s", what, out.c_str());
        return false;
    }
    return true;
}

}  // namespace

WarPlayerState CaptureWarPlayerState(int team, int playerNum) {
    WarPlayerState s;
    if (playerNum < 0) return s;
    if (team >= 0 && teamHandler.IsValidTeam(team)) {
        if (const CTeam* t = teamHandler.Team(team))
            s.authorityPool = ParamNumber(t->modParams,
                                          PlayerKey("authority_player_", playerNum));
    }
    // The scoreboard keys are GAME params (game_teams.lua publishes them with
    // SetGameRulesParam), not team params — a spectator's scoreboard reads
    // every player's row, so they are deliberately not team-scoped.
    const LuaRulesParams::Params& game = CSplitLuaHandle::GetGameParams();
    s.scoreEarned = ParamNumber(game, PlayerKey("score_", playerNum, "_earned"));
    s.scoreSpent  = ParamNumber(game, PlayerKey("score_", playerNum, "_spent"));
    s.objectives  = static_cast<int>(
        ParamNumber(game, PlayerKey("score_", playerNum, "_objectives")));
    return s;
}

bool RestoreWarPlayerPool(int playerNum, double amount) {
    if (playerNum < 0 || !(amount > 0.0)) return false;
    char code[192];
    snprintf(code, sizeof(code),
             "if GG and GG.Authority and GG.Authority.RestorePool then "
             "GG.Authority.RestorePool(%d, %.6f) end",
             playerNum, amount);
    return CallSynced("war-state pool restore", code);
}

bool GrantWarRejoinStipend(int playerNum) {
    if (playerNum < 0) return false;
    char code[192];
    snprintf(code, sizeof(code),
             "if GG and GG.Authority and GG.Authority.GrantRejoinStipend then "
             "GG.Authority.GrantRejoinStipend(%d) end",
             playerNum);
    return CallSynced("war-state rejoin stipend", code);
}

bool RestoreWarPlayerScore(int playerNum, const WarPlayerState& state) {
    if (playerNum < 0) return false;
    if (state.scoreEarned <= 0.0 && state.scoreSpent <= 0.0 && state.objectives <= 0)
        return false;   // nothing to hand back; skip the call entirely
    char code[256];
    snprintf(code, sizeof(code),
             "if GG and GG.Teams and GG.Teams.RestoreScore then "
             "GG.Teams.RestoreScore(%d, %.6f, %.6f, %d) end",
             playerNum, state.scoreEarned, state.scoreSpent, state.objectives);
    return CallSynced("war-state score restore", code);
}
