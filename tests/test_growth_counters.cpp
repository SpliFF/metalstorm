// Tests for the PLAN-long-uptime §3 growth counters + alarm thresholds.
//
// The module is pure by construction (GrowthCounters.h), so everything the
// production path decides is decidable here: which readings trip which alarm,
// at what severity, what the extra_json blob looks like, and that the lobby
// can read its own writer's output back. The engine-coupled half — that
// unitHandler/playerHandler/the streamer actually hand over the numbers this
// file feeds in — is server_main.cpp's gather and is verified live, not here.
#include <doctest/doctest.h>

#include <nlohmann/json.hpp>

#include "Server/GrowthCounters.h"

#include <algorithm>
#include <cstdlib>
#include <string>

namespace {

bool HasAlarm(const std::vector<growth::Alarm>& v, const std::string& label, bool crit) {
    return std::any_of(v.begin(), v.end(), [&](const growth::Alarm& a) {
        return a.label == label && a.crit == crit;
    });
}

bool HasLabel(const std::vector<growth::Alarm>& v, const std::string& label) {
    return std::any_of(v.begin(), v.end(),
                       [&](const growth::Alarm& a) { return a.label == label; });
}

// A game that is healthy on every axis, as a baseline for "one knob at a time".
growth::Counters HealthyCounters() {
    growth::Counters c;
    c.rssKb = 800 * 1024;      // 800 MB against a 4096 MB default ceiling
    c.luaHeapKb = 64 * 1024;   // 64 MB against 512 MB
    c.paramKeys = 900;
    c.paramKeysRev = 3;
    c.rulesParams = 1200;
    c.unitIdsUsed = 400;
    c.unitIdsMax = 32000;
    c.unitSpawns = 5000;
    c.standingOrders = 12;
    c.players = 6;
    c.playersMax = 251;
    return c;
}

}  // namespace

TEST_CASE("growth: a healthy game raises nothing") {
    const growth::Thresholds t;
    CHECK(growth::Evaluate(HealthyCounters(), t).empty());
}

TEST_CASE("growth: unit-id occupancy warns at 50% and crits at 75%") {
    const growth::Thresholds t;
    growth::Counters c = HealthyCounters();

    c.unitIdsUsed = 15999;  // 49%
    CHECK(growth::Evaluate(c, t).empty());

    c.unitIdsUsed = 16000;  // exactly 50%
    auto warn = growth::Evaluate(c, t);
    CHECK(HasAlarm(warn, "ids", false));
    // The reading, not just the badge — an operator deciding whether to retire
    // the game needs the number (§3/E3: runway is the whole point).
    CHECK(warn[0].detail.find("50%") != std::string::npos);
    CHECK(warn[0].detail.find("32000") != std::string::npos);

    c.unitIdsUsed = 24000;  // 75%
    CHECK(HasAlarm(growth::Evaluate(c, t), "ids", true));
}

TEST_CASE("growth: footprint ceilings warn at 75% and crit at the ceiling") {
    growth::Thresholds t;
    t.rssCeilingMb = 1000;
    t.luaHeapCeilingMb = 100;

    growth::Counters c = HealthyCounters();
    c.rssKb = 700 * 1024;
    c.luaHeapKb = 70 * 1024;
    CHECK(growth::Evaluate(c, t).empty());

    c.rssKb = 750 * 1024;
    CHECK(HasAlarm(growth::Evaluate(c, t), "rss", false));
    c.rssKb = 1000 * 1024;
    CHECK(HasAlarm(growth::Evaluate(c, t), "rss", true));

    c = HealthyCounters();
    c.rssKb = 700 * 1024;
    c.luaHeapKb = 80 * 1024;
    CHECK(HasAlarm(growth::Evaluate(c, t), "lua", false));
    c.luaHeapKb = 120 * 1024;
    CHECK(HasAlarm(growth::Evaluate(c, t), "lua", true));
}

TEST_CASE("growth: a zero counter never trips its rule") {
    // Zero means "not gathered on this platform", not "measured zero" — a
    // getrusage that fails must go quiet, not report a game using 0 MB and
    // certainly not divide by a zero maximum.
    growth::Thresholds t;
    t.rssCeilingMb = 1;  // any non-zero rss would crit
    growth::Counters c;  // all zero
    CHECK(growth::Evaluate(c, t).empty());

    c.unitIdsUsed = 30000;
    c.unitIdsMax = 0;  // max unknown → no percentage to take
    CHECK(!HasLabel(growth::Evaluate(c, t), "ids"));

    // A negative occupancy is a gather bug, not a reading — and one shipped in
    // the first live row of this feature (the free pool is sized on MAX_UNITS
    // while MaxUnits() is the mod-limited cap, so subtracting one from the
    // other gave -2 on an idle game). Fixed at the source; the rule must still
    // refuse to interpret it if it ever comes back.
    c.unitIdsUsed = -2;
    c.unitIdsMax = 31998;
    CHECK(!HasLabel(growth::Evaluate(c, t), "ids"));
}

TEST_CASE("growth: a ceiling of 0 disables its rule") {
    growth::Thresholds t;
    t.rssCeilingMb = 0;
    t.luaHeapCeilingMb = 0;
    t.idWarnPct = 0;
    t.idCritPct = 0;

    growth::Counters c = HealthyCounters();
    c.rssKb = 900000 * 1024;
    c.luaHeapKb = 900000 * 1024;
    c.unitIdsUsed = 31999;
    CHECK(growth::Evaluate(c, t).empty());
}

TEST_CASE("growth: interned key dictionary and player rows") {
    const growth::Thresholds t;
    growth::Counters c = HealthyCounters();

    c.paramKeys = 32767;
    CHECK(HasAlarm(growth::Evaluate(c, t), "keys", false));
    c.paramKeys = 60000;
    CHECK(HasAlarm(growth::Evaluate(c, t), "keys", true));

    c = HealthyCounters();
    c.players = 201;  // 80% of 251
    CHECK(HasAlarm(growth::Evaluate(c, t), "players", false));
    c.players = 240;  // 95%
    CHECK(HasAlarm(growth::Evaluate(c, t), "players", true));
}

TEST_CASE("growth: several rules trip at once, in a stable order") {
    growth::Thresholds t;
    t.rssCeilingMb = 100;
    growth::Counters c = HealthyCounters();
    c.unitIdsUsed = 30000;
    c.rssKb = 200 * 1024;
    c.paramKeys = 60000;

    const auto a = growth::Evaluate(c, t);
    REQUIRE(a.size() == 3);
    CHECK(a[0].label == "ids");
    CHECK(a[1].label == "rss");
    CHECK(a[2].label == "keys");
    // Twice over the same input gives the same list — the lobby's audit scan
    // diffs label sets between passes, so an unstable order would look like a
    // transition and write a row every five minutes forever.
    const auto b = growth::Evaluate(c, t);
    REQUIRE(b.size() == a.size());
    for (size_t i = 0; i < a.size(); ++i)
        CHECK(a[i].label == b[i].label);
}

TEST_CASE("growth: ToJson carries every counter and the alarms") {
    const growth::Counters c = HealthyCounters();
    const auto alarms = growth::Evaluate(c, growth::Thresholds());
    const std::string s = growth::ToJson(c, alarms);
    REQUIRE(!s.empty());

    const auto j = nlohmann::json::parse(s, nullptr, false);
    REQUIRE(!j.is_discarded());
    REQUIRE(j.contains("growth"));
    const auto& g = j["growth"];
    CHECK(g["rss_kb"] == c.rssKb);
    CHECK(g["lua_heap_kb"] == c.luaHeapKb);
    CHECK(g["param_keys"] == c.paramKeys);
    CHECK(g["param_keys_rev"] == c.paramKeysRev);
    CHECK(g["rules_params"] == c.rulesParams);
    CHECK(g["unit_ids_used"] == c.unitIdsUsed);
    CHECK(g["unit_ids_max"] == c.unitIdsMax);
    CHECK(g["unit_spawns"] == c.unitSpawns);
    CHECK(g["standing_orders"] == c.standingOrders);
    CHECK(g["players"] == c.players);
    CHECK(g["players_max"] == c.playersMax);
    CHECK(j["alarms"].is_array());
    CHECK(j["alarms"].empty());
}

TEST_CASE("growth: an empty gather writes an empty column, not a blob of zeroes") {
    // The chart would otherwise draw a floor of zeroes and an operator would
    // read "measured, and flat" off a row that measured nothing.
    CHECK(growth::ToJson(growth::Counters(), {}).empty());
}

TEST_CASE("growth: ParseAlarms round-trips what ToJson wrote") {
    growth::Thresholds t;
    t.rssCeilingMb = 100;
    growth::Counters c = HealthyCounters();
    c.rssKb = 200 * 1024;
    c.unitIdsUsed = 30000;

    const auto written = growth::Evaluate(c, t);
    REQUIRE(written.size() == 2);

    std::vector<growth::Alarm> read;
    REQUIRE(growth::ParseAlarms(growth::ToJson(c, written), read));
    REQUIRE(read.size() == written.size());
    for (size_t i = 0; i < read.size(); ++i) {
        CHECK(read[i].label == written[i].label);
        CHECK(read[i].crit == written[i].crit);
        CHECK(read[i].detail == written[i].detail);
    }
}

TEST_CASE("growth: ParseAlarms is total over garbage") {
    // This runs inside the admin fleet route over whatever is in the column,
    // including rows written by a different engine version. Every one of these
    // must yield "no alarms" rather than an exception or a partial list.
    std::vector<growth::Alarm> out{{"stale", true, "left over"}};
    CHECK(!growth::ParseAlarms("", out));
    CHECK(out.empty());
    CHECK(!growth::ParseAlarms("{", out));
    CHECK(!growth::ParseAlarms("[1,2,3]", out));
    CHECK(!growth::ParseAlarms("\"a string\"", out));
    CHECK(!growth::ParseAlarms(R"({"growth":{}})", out));
    CHECK(!growth::ParseAlarms(R"({"alarms":"not an array"})", out));
    CHECK(out.empty());

    // A well-formed array with malformed members keeps the good ones and
    // silently drops the rest (a label-less alarm has nothing to render).
    REQUIRE(growth::ParseAlarms(
        R"({"alarms":[7,{"crit":true},{"label":"ids","crit":true,"detail":"d"}]})", out));
    REQUIRE(out.size() == 1);
    CHECK(out[0].label == "ids");
    CHECK(out[0].crit);
}

TEST_CASE("growth: thresholds come from the environment, and a bad value is ignored") {
    setenv("SPRING_RSS_CEILING_MB", "2048", 1);
    setenv("SPRING_LUA_HEAP_CEILING_MB", "256", 1);
    setenv("SPRING_ID_ALARM_PCT", "30", 1);
    {
        const growth::Thresholds t = growth::ThresholdsFromEnv();
        CHECK(t.rssCeilingMb == 2048);
        CHECK(t.luaHeapCeilingMb == 256);
        CHECK(t.idWarnPct == 30);
    }

    // Garbage, negative and empty all leave the default alone — a typo'd
    // ceiling that silently disabled the alarm would be the worst outcome.
    setenv("SPRING_RSS_CEILING_MB", "not-a-number", 1);
    setenv("SPRING_LUA_HEAP_CEILING_MB", "-5", 1);
    setenv("SPRING_ID_ALARM_PCT", "", 1);
    {
        const growth::Thresholds def;
        const growth::Thresholds t = growth::ThresholdsFromEnv();
        CHECK(t.rssCeilingMb == def.rssCeilingMb);
        CHECK(t.luaHeapCeilingMb == def.luaHeapCeilingMb);
        CHECK(t.idWarnPct == def.idWarnPct);
    }

    // An operator who sets the warn above the built-in crit gets a crit that
    // moves up with it, rather than a warn that can never fire.
    setenv("SPRING_ID_ALARM_PCT", "90", 1);
    {
        const growth::Thresholds t = growth::ThresholdsFromEnv();
        CHECK(t.idWarnPct == 90);
        CHECK(t.idCritPct >= 90);
        growth::Counters c = HealthyCounters();
        c.unitIdsUsed = 29000;  // 90% of 32000
        CHECK(HasLabel(growth::Evaluate(c, t), "ids"));
        c.unitIdsUsed = 25000;  // 78% — over the built-in 75 crit, under the warn
        CHECK(!HasLabel(growth::Evaluate(c, t), "ids"));
    }

    unsetenv("SPRING_RSS_CEILING_MB");
    unsetenv("SPRING_LUA_HEAP_CEILING_MB");
    unsetenv("SPRING_ID_ALARM_PCT");
}
