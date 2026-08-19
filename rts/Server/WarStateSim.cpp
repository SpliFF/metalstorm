#include "WarStateSim.h"

#include <cstdio>
#include <string>
#include <variant>

#include "LuaExecEngine.h"
#include "Lua/LuaRules.h"
#include "Lua/LuaHandleSynced.h"
#include "Lua/LuaRulesParams.h"
#include "Game/Players/Player.h"
#include "Game/Players/PlayerHandler.h"
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

/// The string half of the same variant. A missing key and a key holding a
/// number both read as empty: the warlog's display fields are authored by the
/// emitting gadget and a numeric one is a bug there, not something to render.
std::string ParamString(const LuaRulesParams::Params& params, const std::string& key) {
    const auto it = params.find(key);
    if (it == params.end()) return "";
    if (const std::string* s = std::get_if<std::string>(&it->second.value)) return *s;
    return "";
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

std::vector<WarSummaryPlayer> GatherWarSummaryPlayers() {
    std::vector<WarSummaryPlayer> out;
    for (int i = 0; i < playerHandler.ActivePlayers(); ++i) {
        const CPlayer* p = playerHandler.Player(i);
        if (p == nullptr) continue;
        WarSummaryPlayer row;
        row.team = p->team;
        row.spectator = p->spectator;
        row.isAI = p->isAI;
        row.active = p->active;
        out.push_back(row);
    }
    return out;
}

std::vector<WarSummaryRegion> GatherWarSummaryRegions() {
    // `region_<key>_team` / `region_<key>_contested`, published PUBLIC by
    // game_regions.lua. The key is whatever the map's partition calls the
    // region, so the scan matches on the shape, not on a known list.
    static const std::string kPrefix = "region_";
    static const std::string kTeamSuffix = "_team";

    const LuaRulesParams::Params& params = CSplitLuaHandle::GetGameParams();
    std::vector<WarSummaryRegion> out;
    for (const auto& [key, param] : params) {
        if (key.size() <= kPrefix.size() + kTeamSuffix.size()) continue;
        if (key.compare(0, kPrefix.size(), kPrefix) != 0) continue;
        if (key.compare(key.size() - kTeamSuffix.size(), kTeamSuffix.size(),
                        kTeamSuffix) != 0)
            continue;
        WarSummaryRegion r;
        // -1 is "nobody holds it"; the param is written as a number, so a
        // string/bool value reads as 0 via ParamNumber, which would claim
        // team 0 holds a region it does not. Check the variant instead.
        if (const float* f = std::get_if<float>(&param.value))
            r.team = static_cast<int>(*f);
        else
            continue;   // not a region-ownership param after all
        const std::string base = key.substr(0, key.size() - kTeamSuffix.size());
        r.contested = ParamNumber(params, base + "_contested") != 0.0;
        out.push_back(r);
    }
    return out;
}

std::vector<WarSideFootholds> GatherWarFootholds(const WarSides& sides) {
    // `war_footholds_<team>` + `war_footholds_known`, published by
    // game_gameover.lua (wars §7, task 4). Keyed by TEAM there because a team
    // is what the scenario's regions block names; the faction mapping is
    // `war_sides`, which the caller already holds, so folding it in on the Lua
    // side would be a second copy of it.
    const LuaRulesParams::Params& game = CSplitLuaHandle::GetGameParams();
    std::vector<WarSideFootholds> out;
    if (ParamNumber(game, "war_footholds_known") == 0.0)
        return out;   // the caller reads an empty census as "cannot tell"
    for (const auto& [faction, team] : sides) {
        WarSideFootholds f;
        f.factionId = faction;
        f.held = static_cast<unsigned>(std::max(
            0.0, ParamNumber(game, PlayerKey("war_footholds_", team))));
        out.push_back(std::move(f));
    }
    return out;
}

double GatherWarStakes() {
    // §5's "highest-stakes" key. Summed off `objective_<id>_reward`, which
    // game_objectives.lua already publishes as `reward + EscrowTotal(id)` —
    // so the staked bounties are in it and there is no second place that adds
    // them up. Only ACTIVE objectives count: a resolved one has been paid and
    // is riding on nothing.
    //
    // Scanned by key shape, the same way GatherWarSummaryRegions() is, because
    // the objective id space is the gadget's and asking it for the list would
    // mean calling into synced Lua from a wall-clock heartbeat.
    static const std::string kPrefix = "objective_";
    static const std::string kSuffix = "_reward";

    const LuaRulesParams::Params& params = CSplitLuaHandle::GetGameParams();
    double total = 0.0;
    for (const auto& [key, param] : params) {
        if (key.size() <= kPrefix.size() + kSuffix.size()) continue;
        if (key.compare(0, kPrefix.size(), kPrefix) != 0) continue;
        if (key.compare(key.size() - kSuffix.size(), kSuffix.size(), kSuffix) != 0)
            continue;
        const std::string base = key.substr(0, key.size() - kSuffix.size());
        if (ParamString(params, base + "_state") != "active") continue;
        if (const float* f = std::get_if<float>(&param.value))
            total += *f;
    }
    return total;
}

std::string GatherWarSimState() {
    return ParamString(CSplitLuaHandle::GetGameParams(), "war_state");
}

bool GatherWarOutcome(const WarSides& sides, WarOutcomeRecord& out) {
    const LuaRulesParams::Params& game = CSplitLuaHandle::GetGameParams();
    // The war has an ENDING only once game_gameover.lua has left 'active' AND
    // stamped the frame it resolved on. Leaving 'active' happens 300 frames
    // earlier, at the top of the wind-down grace, when nothing has been settled
    // and every field below scrapes as 0 — see `IsPublishableWarOutcome`, which
    // owns this rule for both ends of the rendezvous.
    //
    // Read the frame FIRST, because it is half the question.
    const std::string state = ParamString(game, "war_state");
    out.finalFrame = static_cast<int32_t>(ParamNumber(game, "war_final_frame"));
    if (!IsPublishableWarOutcome(state, out.finalFrame))
        return false;

    out.winnerTeam = static_cast<int>(ParamNumber(game, "war_winner_team")) - 0;
    // `war_winner_team` is absent, not zero, before a winner is declared, and
    // team 0 is a real team — so the presence of the key is the test, never
    // its value.
    if (game.find("war_winner_team") == game.end())
        out.winnerTeam = -1;

    // Every faction on the winning SIDE. game_gameover publishes the winning
    // ALLYTEAMS, which is the engine's vocabulary; the archive wants the
    // player's, and `war_sides` is the one mapping between them.
    out.winnerFactions.clear();
    if (out.winnerTeam >= 0) {
        for (const auto& [faction, team] : sides) {
            if (static_cast<int>(team) != out.winnerTeam) continue;
            if (!out.winnerFactions.empty()) out.winnerFactions += ",";
            out.winnerFactions += faction;
        }
    }

    // `out.finalFrame` was read above: it is the frame the sim STAMPED at
    // `resolving`, not the frame this scrape happens on (the sim freezes after
    // the declaration, and the scoreboard is republished on a 30 s cadence, so
    // "now" would archive whatever the last tick left behind) — and it is also
    // the gate that got us here.
    out.settledComplete =
        static_cast<unsigned>(std::max(0.0, ParamNumber(game, "war_settled_complete")));
    out.settledExpired =
        static_cast<unsigned>(std::max(0.0, ParamNumber(game, "war_settled_expired")));

    // The final scoreboard (teams §6). Read off the live player list rather
    // than by scanning the param map for `score_*` keys, because the archive
    // has to be able to NAME the participants and only the roster holds the
    // playerNum↔name mapping — player numbers are recycled, so a scoreboard
    // browsed a month later would otherwise be anonymous.
    out.scoreboard.clear();
    for (int i = 0; i < playerHandler.ActivePlayers(); ++i) {
        const CPlayer* p = playerHandler.Player(i);
        if (p == nullptr || p->isAI || p->spectator) continue;
        WarScoreRow row;
        row.playerNum  = i;
        row.name       = p->name;
        row.team       = p->team;
        row.earned     = ParamNumber(game, PlayerKey("score_", i, "_earned"));
        row.spent      = ParamNumber(game, PlayerKey("score_", i, "_spent"));
        row.objectives = static_cast<unsigned>(
            std::max(0.0, ParamNumber(game, PlayerKey("score_", i, "_objectives"))));
        out.scoreboard.push_back(std::move(row));
    }
    return true;
}

warlog::DrainResult DrainWarLog(int64_t watermark) {
    const LuaRulesParams::Params& params = CSplitLuaHandle::GetGameParams();
    const int64_t head = static_cast<int64_t>(ParamNumber(params, "warlog_seq"));
    const int ringSize = static_cast<int>(ParamNumber(params, "warlog_ring"));

    return warlog::Drain(head, watermark, ringSize,
                         [&params](int slot, warlog::Event& out) {
        char prefix[32];
        snprintf(prefix, sizeof(prefix), "warlog_%d_", slot);
        const std::string p = prefix;
        const auto seqIt = params.find(p + "seq");
        if (seqIt == params.end()) return false;   // never written — young war
        out.seq = static_cast<int64_t>(ParamNumber(params, p + "seq"));
        out.team = static_cast<int>(ParamNumber(params, p + "team"));
        out.frame = static_cast<int32_t>(ParamNumber(params, p + "frame"));
        out.kind = ParamString(params, p + "kind");
        out.subject = ParamString(params, p + "subject");
        out.detail = ParamString(params, p + "detail");
        return true;
    });
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
