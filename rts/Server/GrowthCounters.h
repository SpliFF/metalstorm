// GrowthCounters — the production half of PLAN-long-uptime §3 ("Alarms").
//
// PLAN-long-uptime's soak ladders (§2, task 4) sample the growth surfaces §1
// inventories once per simulated day and fit `base + slope×days` offline. That
// answers "does this game leak?" for a run someone deliberately started. It
// does NOT answer "is the game a player is in right now approaching a wall?",
// which is what a weeks-long campaign actually needs, and which is why §3 asks
// for the same counters on the live metrics surface with static thresholds.
//
// This module is the counter set + the threshold policy, and nothing else. It
// is deliberately PURE — plain structs in, JSON string out — for the same
// reason StatsDump and RulesParamKeyDict are: the engine-coupled gather
// (unitHandler, playerHandler, standingOrders, the streamer's key dictionary,
// getrusage, lua_gc) happens in server_main.cpp and arrives here as data, so
// tests/test_growth_counters.cpp links without the sim.
//
// Where the numbers go: `GameMetricsWriter::MaybeWrite`'s `extraJson`
// argument, which has carried the empty string since PLAN-gm-tools task 1
// reserved it for exactly this. The lobby's `/api/admin/fleet` parses the
// `alarms` array back out (ParseAlarms) and merges it into the badge list the
// GM dashboard already renders; the per-game route hands the whole blob to the
// drill-down so a growth series can be charted next to the tick timeline.
//
// What is NOT here, stated so it is not looked for: `game_events`. §3 says an
// alarm should "emit a `game_events` admin entry", but that table does not
// exist and PLAN-long-uptime §7.3 struck it from S3 for the same reason. The
// durable record of an alarm transition is an `admin_audit` row written by the
// lobby's maintenance loop, which is the table that does exist and is already
// the dashboard's audit trail.
#pragma once

#include <cstdint>
#include <string>
#include <vector>

namespace growth {

// One sample of every bounded-but-growing container PLAN-long-uptime §1 names,
// as of a metric write. Zero means "not sampled on this platform / not
// applicable", never "measured zero" — the alarm rules below all skip zero for
// that reason, so a counter that fails to gather goes quiet rather than
// raising a false crit.
struct Counters {
    // Process + VM footprint. rssKb is a high-water mark (getrusage's
    // ru_maxrss), not a current reading — that is what §3's "heap watermark"
    // asks for, and it is also the only figure that survives an allocator
    // giving pages back between samples.
    int64_t rssKb = 0;
    int64_t luaHeapKb = 0;

    // S1: the interned rulesParams key dictionary. `paramKeys` is the count of
    // assigned ids (id 0 is reserved), which is monotone between compactions —
    // so a `paramKeysRev` that never moves while `paramKeys` climbs is exactly
    // the "compaction has never been observed firing" case T2b-2 flags.
    int64_t paramKeys = 0;
    int64_t paramKeysRev = 0;

    // S1/S2: live synced rulesParams entries (game-scope + every team's).
    int64_t rulesParams = 0;

    // S5. `unitIdsUsed` is MaxUnits() minus the free pool, `unitIdsMax` is
    // MAX_UNITS. `unitSpawns` is the sum of the per-id spawn generations —
    // total slot (re)assignments over the life of the game, i.e. the recycle
    // pressure that §7.2 identified as the real S5 risk. Occupancy says how
    // close the pool is to empty; spawns say how fast ids are being aliased.
    int64_t unitIdsUsed = 0;
    int64_t unitIdsMax = 0;
    int64_t unitSpawns = 0;

    // S6: live standing orders across all teams (bounded by the per-team cap
    // since task 2b, but the count is what proves the cap is doing something).
    int64_t standingOrders = 0;

    // S12: rows in playerHandler. Bounded by distinct accounts since task 2a;
    // the ceiling that used to terminate a game (MAX_PLAYERS) is still real,
    // so the counter stays.
    int64_t players = 0;
    int64_t playersMax = 0;
};

// Static thresholds (§3). A ceiling of 0 disables that rule outright — an
// operator who has not chosen a heap budget for their box should get no heap
// alarm rather than a wrong one.
struct Thresholds {
    // Percent of the unit-id space in use. §3/E3 wants runway, not a crash:
    // the warn is the "retire this game to a fresh instance at your leisure"
    // signal and the crit is "do it now".
    int idWarnPct = 50;
    int idCritPct = 75;

    // Configurable footprint ceilings, in MB. Warn fires at warnPct of them.
    int64_t rssCeilingMb = 4096;
    int64_t luaHeapCeilingMb = 512;
    int ceilingWarnPct = 75;

    // The interning space is 16-bit and id 0 is reserved, so 65534 keys is a
    // permanent fallback-to-string-keys regression with no way back
    // (RulesParamKeyDict.h). Warn at half of it.
    int64_t paramKeyWarn = 32767;
    int64_t paramKeyCrit = 58000;

    // Fraction of MAX_PLAYERS. S12's fix bounds the container by distinct
    // accounts; this catches a game that genuinely attracts that many.
    int playerWarnPct = 80;
    int playerCritPct = 95;
};

// Thresholds with each field overridden from the environment when the variable
// is present and parses as a non-negative integer. Names are the ones
// docs/gm-tools.md documents:
//   SPRING_RSS_CEILING_MB, SPRING_LUA_HEAP_CEILING_MB, SPRING_ID_ALARM_PCT.
Thresholds ThresholdsFromEnv();

// One tripped rule. `label` is the badge text the dashboard renders (short —
// it sits inside a table cell next to the room number); `detail` is the
// human-readable reading, used in the tooltip and in the admin_audit row.
struct Alarm {
    std::string label;
    bool crit = false;
    std::string detail;
};

// Apply `t` to `c`. Deterministic order (id, rss, lua, params, players) so a
// caller diffing two evaluations sees stable output, and so the admin_audit
// transition scan can compare label sets without sorting. A counter of 0 never
// trips (see Counters).
std::vector<Alarm> Evaluate(const Counters& c, const Thresholds& t);

// The counter object on its own — the same key names `ToJson` nests under
// "growth", without the alarms wrapper. PLAN-long-uptime task 4 embeds this in
// every headless stats-dump snapshot so the offline growth report reads the
// SAME key set off a soak run that the dashboard reads off a live game. One
// definition, two surfaces: a soak that fits a slope for `param_keys` and an
// operator watching `param_keys` are then looking at the same number by
// construction rather than by two encoders agreeing. Always returns a JSON
// object (never ""), because a snapshot row with the field missing and a
// snapshot row of zeroes must stay distinguishable downstream.
std::string CountersToJson(const Counters& c);

// Serialise to the `extra_json` payload: {"growth":{…},"alarms":[…]}. Returns
// "" for an all-zero Counters with no alarms, so a game whose gather found
// nothing writes the same empty column it wrote before this module existed
// rather than a blob of zeroes that a chart would draw as a floor.
std::string ToJson(const Counters& c, const std::vector<Alarm>& alarms);

// Read the `alarms` array back out of an `extra_json` column. Tolerant by
// design: a missing column, an empty string, malformed JSON, or a blob written
// by a future engine with a different shape all yield an empty list and
// `false`, never an exception — this runs inside the lobby's admin routes and
// a bad row must not take the fleet view down.
bool ParseAlarms(const std::string& extraJson, std::vector<Alarm>& out);

}  // namespace growth
