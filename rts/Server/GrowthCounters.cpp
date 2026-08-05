#include "Server/GrowthCounters.h"

#include <nlohmann/json.hpp>

#include <cstdlib>
#include <string>

namespace growth {

namespace {

// Env override helper. Absent, empty, non-numeric or negative all leave the
// default alone — a typo'd ceiling must not silently disable an alarm.
void EnvInt64(const char* name, int64_t& out) {
    const char* v = std::getenv(name);
    if (v == nullptr || *v == '\0')
        return;
    char* end = nullptr;
    const long long parsed = std::strtoll(v, &end, 10);
    if (end == v || *end != '\0' || parsed < 0)
        return;
    out = static_cast<int64_t>(parsed);
}

void EnvInt(const char* name, int& out) {
    int64_t wide = out;
    EnvInt64(name, wide);
    out = static_cast<int>(wide);
}

std::string Pct(int64_t used, int64_t total) {
    if (total <= 0)
        return "?";
    return std::to_string((used * 100) / total) + "%";
}

}  // namespace

Thresholds ThresholdsFromEnv() {
    Thresholds t;
    EnvInt64("SPRING_RSS_CEILING_MB", t.rssCeilingMb);
    EnvInt64("SPRING_LUA_HEAP_CEILING_MB", t.luaHeapCeilingMb);
    EnvInt("SPRING_ID_ALARM_PCT", t.idWarnPct);
    // Keep the crit above the warn whatever the operator typed; an inverted
    // pair would make the warn unreachable (the crit check runs first below).
    if (t.idCritPct < t.idWarnPct)
        t.idCritPct = t.idWarnPct;
    return t;
}

std::vector<Alarm> Evaluate(const Counters& c, const Thresholds& t) {
    std::vector<Alarm> out;

    // S5 — unit-id occupancy. Not an exhaustion alarm (the pool recycles);
    // this is the runway signal E3 asks for so retiring the game stays an
    // operator decision rather than an incident.
    if (c.unitIdsMax > 0 && c.unitIdsUsed > 0) {
        const int64_t pct = (c.unitIdsUsed * 100) / c.unitIdsMax;
        if (t.idCritPct > 0 && pct >= t.idCritPct)
            out.push_back({"ids", true,
                           "unit ids " + Pct(c.unitIdsUsed, c.unitIdsMax) + " of " +
                               std::to_string(c.unitIdsMax)});
        else if (t.idWarnPct > 0 && pct >= t.idWarnPct)
            out.push_back({"ids", false,
                           "unit ids " + Pct(c.unitIdsUsed, c.unitIdsMax) + " of " +
                               std::to_string(c.unitIdsMax)});
    }

    // Footprint ceilings. Both are watermarks, so these latch on once crossed
    // and do not flap — which is correct for a "this game has grown past its
    // budget" signal and would be wrong for a load alarm.
    if (c.rssKb > 0 && t.rssCeilingMb > 0) {
        const int64_t mb = c.rssKb / 1024;
        if (mb >= t.rssCeilingMb)
            out.push_back({"rss", true,
                           "rss " + std::to_string(mb) + "MB of " +
                               std::to_string(t.rssCeilingMb) + "MB"});
        else if (t.ceilingWarnPct > 0 && mb >= (t.rssCeilingMb * t.ceilingWarnPct) / 100)
            out.push_back({"rss", false,
                           "rss " + std::to_string(mb) + "MB of " +
                               std::to_string(t.rssCeilingMb) + "MB"});
    }

    if (c.luaHeapKb > 0 && t.luaHeapCeilingMb > 0) {
        const int64_t mb = c.luaHeapKb / 1024;
        if (mb >= t.luaHeapCeilingMb)
            out.push_back({"lua", true,
                           "lua heap " + std::to_string(mb) + "MB of " +
                               std::to_string(t.luaHeapCeilingMb) + "MB"});
        else if (t.ceilingWarnPct > 0 &&
                 mb >= (t.luaHeapCeilingMb * t.ceilingWarnPct) / 100)
            out.push_back({"lua", false,
                           "lua heap " + std::to_string(mb) + "MB of " +
                               std::to_string(t.luaHeapCeilingMb) + "MB"});
    }

    // S1 — the interned key dictionary. The crit here is not a crash either:
    // past 65534 the wire falls back to string keys permanently, so this is
    // "compaction is not keeping up", which is actionable long before then.
    if (c.paramKeys > 0) {
        if (t.paramKeyCrit > 0 && c.paramKeys >= t.paramKeyCrit)
            out.push_back({"keys", true,
                           "interned param keys " + std::to_string(c.paramKeys)});
        else if (t.paramKeyWarn > 0 && c.paramKeys >= t.paramKeyWarn)
            out.push_back({"keys", false,
                           "interned param keys " + std::to_string(c.paramKeys)});
    }

    // S12 — player rows against the hard MAX_PLAYERS assert.
    if (c.players > 0 && c.playersMax > 0) {
        const int64_t pct = (c.players * 100) / c.playersMax;
        if (t.playerCritPct > 0 && pct >= t.playerCritPct)
            out.push_back({"players", true,
                           std::to_string(c.players) + " of " +
                               std::to_string(c.playersMax) + " player rows"});
        else if (t.playerWarnPct > 0 && pct >= t.playerWarnPct)
            out.push_back({"players", false,
                           std::to_string(c.players) + " of " +
                               std::to_string(c.playersMax) + " player rows"});
    }

    return out;
}

std::string ToJson(const Counters& c, const std::vector<Alarm>& alarms) {
    const bool anyCounter = c.rssKb || c.luaHeapKb || c.paramKeys || c.paramKeysRev ||
                            c.rulesParams || c.unitIdsUsed || c.unitIdsMax ||
                            c.unitSpawns || c.standingOrders || c.players;
    if (!anyCounter && alarms.empty())
        return "";

    nlohmann::json g;
    g["rss_kb"] = c.rssKb;
    g["lua_heap_kb"] = c.luaHeapKb;
    g["param_keys"] = c.paramKeys;
    g["param_keys_rev"] = c.paramKeysRev;
    g["rules_params"] = c.rulesParams;
    g["unit_ids_used"] = c.unitIdsUsed;
    g["unit_ids_max"] = c.unitIdsMax;
    g["unit_spawns"] = c.unitSpawns;
    g["standing_orders"] = c.standingOrders;
    g["players"] = c.players;
    g["players_max"] = c.playersMax;

    nlohmann::json a = nlohmann::json::array();
    for (const Alarm& al : alarms)
        a.push_back({{"label", al.label}, {"crit", al.crit}, {"detail", al.detail}});

    nlohmann::json out;
    out["growth"] = std::move(g);
    out["alarms"] = std::move(a);
    return out.dump();
}

bool ParseAlarms(const std::string& extraJson, std::vector<Alarm>& out) {
    out.clear();
    if (extraJson.empty())
        return false;
    // parse(..., nullptr, false) — no exceptions; a torn or truncated row is a
    // row we skip, not a 500 on the fleet view.
    const nlohmann::json j = nlohmann::json::parse(extraJson, nullptr, false);
    if (j.is_discarded() || !j.is_object())
        return false;
    const auto it = j.find("alarms");
    if (it == j.end() || !it->is_array())
        return false;
    for (const auto& e : *it) {
        if (!e.is_object())
            continue;
        Alarm a;
        a.label = e.value("label", std::string());
        if (a.label.empty())
            continue;
        a.crit = e.value("crit", false);
        a.detail = e.value("detail", std::string());
        out.push_back(std::move(a));
    }
    return true;
}

}  // namespace growth
