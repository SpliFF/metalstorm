// StatsDump — stats dump assembly + determinism hash for `--headless-run`
// (PLAN-headless task 2). Consumes the counters HeadlessRun (task 1) already
// gates on and the per-team / per-weapon totals that already exist in the
// engine (CTeam::statHistory, CombatStatsAccumulator) — this module only
// assembles them into the JSON dump the plan's §1 asks for. The full economy
// ledger (income/expense breakdown by source) is out of scope here; it lands
// with PLAN-metalstorm-economy.md. Objective outcomes / region-control
// timelines are omitted entirely (not silently zeroed) because that sim state
// does not exist yet — it is Stage-7-gated Metalstorm backbone work.
//
// Kept PURE like HeadlessRun.h: JSON assembly + the hash function take only
// plain structs, no engine globals, so tests/test_stats_dump.cpp links
// without dragging in the sim. server_main.cpp gathers the engine-coupled
// values (CTeam/CUnit/gsRNG/lua_gc) and feeds them in as plain data.
#pragma once

#include <cstdint>
#include <string>
#include <vector>

namespace statsdump {

// Per-team snapshot row. Sourced from CTeam (res/resIncome/resExpense) and
// CTeam::GetCurrentStats() (TeamStatistics) — both already exist for the live
// per-client team-stats broadcast (StateStreamer::BroadcastTeamStats); this
// struct just carries the same fields into the headless dump.
struct TeamSnapshot {
    int teamId = 0;
    int allyTeam = 0;
    bool dead = false;
    int numUnits = 0;
    float metal = 0.0f;
    float energy = 0.0f;
    float metalIncome = 0.0f;
    float energyIncome = 0.0f;
    float metalExpense = 0.0f;
    float energyExpense = 0.0f;
    float damageDealt = 0.0f;
    float damageReceived = 0.0f;
    int unitsProduced = 0;
    int unitsDied = 0;
    int unitsKilled = 0;
};

// One weapon def's running combat totals (CombatStatsAccumulator::Snapshot).
struct WeaponStats {
    uint16_t weaponDefId = 0;
    uint32_t volleys = 0;
    uint32_t kills = 0;
    float damage = 0.0f;
};

// One synced unit's digest fields for the determinism hash (§1: "unit
// count/pos/health xor-fold + gsRNG state").
struct UnitDigest {
    int32_t id = 0;
    int16_t team = 0;
    float x = 0.0f, y = 0.0f, z = 0.0f;
    float health = 0.0f;
};

// Cheap synced-state digest: xor-folds every unit's id/team/pos/health plus
// the synced RNG's generator state (read-only — must not consume/advance the
// stream). Two headless runs with identical config+seed tick through an
// identical unit list in an identical order (that IS the sync claim under
// test) and an identical RNG stream, so the hash sequence must match
// frame-for-frame; the CI pair-run (task 4) diffs the sequence, not raw
// state. `units` order matters — callers must iterate in a stable, engine-
// defined order (e.g. unitHandler.GetActiveUnits()), never sort here.
uint64_t ComputeStateHash(const std::vector<UnitDigest>& units, uint64_t rngState);

// One periodic snapshot row, taken every `stateHashEvery` sim frames.
struct Snapshot {
    int64_t frame = 0;
    double gameSeconds = 0.0;
    int64_t wallSeconds = 0;
    uint64_t stateHash = 0;
    float simFps = 0.0f;
    int64_t rssKb = 0;       // PLAN-long-uptime S4 RSS watermark feed
    int64_t luaHeapKb = 0;   // PLAN-long-uptime S4 Lua-heap watermark feed
    std::vector<TeamSnapshot> teams;
    std::vector<WeaponStats> weapons;
};

// The full run dump, written to `statsDump` at termination. `snapshots`
// includes every periodic row taken during the run, in order (the last row
// is effectively the final state, but frame/gameSeconds/wallSeconds above
// reflect the actual terminating frame even if it fell between cadence
// ticks).
struct FinalDump {
    std::string status;   // headless::StopReasonName() value
    int64_t frame = 0;
    double gameSeconds = 0.0;
    int64_t wallSeconds = 0;
    std::vector<Snapshot> snapshots;
};

// Pure JSON serialisation — no engine deps, doctest-covered. stateHash is
// serialised as a fixed-width hex string (not a JSON number) so downstream
// tools (task 3's Node/Python batch driver) never lose precision to
// double-parsing a >2^53 value.
std::string BuildDumpJson(const FinalDump& dump);

// Writes BuildDumpJson(dump) to `path` (creating parent dirs is the caller's
// job — PLAN's example paths are relative to the run's cwd). Returns false
// and fills `err` on failure; never throws — a bad dump path must not crash
// a multi-hour soak on its very last tick (mirrors HeadlessRun's E3 "never a
// hang" philosophy applied to "never a crash-on-exit").
bool WriteDumpFile(const std::string& path, const FinalDump& dump, std::string& err);

// Process resident-set size in KB (0 if unavailable on this platform).
// Platform-coupled (getrusage) but engine-independent.
int64_t GetRssKb();

}  // namespace statsdump
