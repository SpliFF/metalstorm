#include "WorldEconomy.h"

#include <sqlite3.h>

#include <algorithm>
#include <cmath>
#include <map>

#include "SqliteThreading.h"
#include "WorldFactions.h"

namespace {

constexpr double kMsPerDay = 24.0 * 3600.0 * 1000.0;

void BindText(sqlite3_stmt* s, int idx, const std::string& v) {
    sqlite3_bind_text(s, idx, v.c_str(), -1, SQLITE_TRANSIENT);
}

std::string ColText(sqlite3_stmt* s, int idx) {
    if (const unsigned char* u = sqlite3_column_text(s, idx))
        return reinterpret_cast<const char*>(u);
    return {};
}

/// Per-key fallback, never whole-blob — same rule as WorldStatRules'
/// FromWorldConfig and the same reason: a world tuned before W9 has exactly
/// the keys it was tuned with, and a missing key must not turn its rule off.
double CfgDouble(const nlohmann::json& j, const char* key, double fallback) {
    if (!j.is_object()) return fallback;
    const auto it = j.find(key);
    if (it == j.end() || !it->is_number()) return fallback;
    return it->get<double>();
}

}  // namespace

// ─────────────────────────── the per-world rates ───────────────────────────

WorldEconomyRules WorldEconomyRules::FromWorldConfig(const nlohmann::json& c) {
    WorldEconomyRules r;
    r.poiIncomePerWorldDay     = CfgDouble(c, "poiIncomePerWorldDay",     r.poiIncomePerWorldDay);
    r.treasuryDecayPerWorldDay = CfgDouble(c, "treasuryDecayPerWorldDay", r.treasuryDecayPerWorldDay);
    r.treasuryFloor            = CfgDouble(c, "treasuryFloor",            r.treasuryFloor);
    return r;
}

// ─────────────────────────── pure policy ───────────────────────────────────

double PoiIncomeOverPeriod(int64_t elapsedWorldMs, const WorldEconomyRules& rules) {
    if (elapsedWorldMs <= 0) return 0.0;
    const double days = static_cast<double>(elapsedWorldMs) / kMsPerDay;
    return rules.poiIncomePerWorldDay * days;
}

double TreasuryDecayOverPeriod(double balance, int64_t elapsedWorldMs,
                               const WorldEconomyRules& rules) {
    if (elapsedWorldMs <= 0) return 0.0;
    if (balance <= rules.treasuryFloor) return 0.0;
    const double rate = rules.treasuryDecayPerWorldDay;
    if (rate <= 0.0) return 0.0;
    // Clamped below 1.0 for the same reason DecayAuthority clamps: a rate at
    // or above "all of it, per day" must decay fast, not annihilate the whole
    // balance on the first read regardless of how little time passed.
    const double retain = std::max(0.0, 1.0 - std::min(rate, 0.99));
    const double days   = static_cast<double>(elapsedWorldMs) / kMsPerDay;
    double decayed = balance * std::pow(retain, days);
    if (decayed < rules.treasuryFloor) decayed = std::min(balance, rules.treasuryFloor);
    return decayed - balance;  // <= 0
}

// ─────────────────────────── the store ────────────────────────────────────

void WorldEconomy::EnsureTables(sqlite3* db) {
    if (!db) return;
    sqlite3_exec(db,
        "CREATE TABLE IF NOT EXISTS world_economy_events ("
        "  world_id TEXT NOT NULL,"
        "  faction_id TEXT NOT NULL DEFAULT '',"
        "  poi_id TEXT NOT NULL DEFAULT '',"
        "  source TEXT NOT NULL DEFAULT '',"
        "  delta REAL NOT NULL DEFAULT 0,"
        "  world_ms INTEGER NOT NULL DEFAULT 0,"
        "  recorded_at INTEGER NOT NULL DEFAULT 0"
        ")", nullptr, nullptr, nullptr);
    sqlite3_exec(db,
        "CREATE INDEX IF NOT EXISTS idx_world_economy_events_faction "
        "ON world_economy_events(world_id, faction_id)", nullptr, nullptr, nullptr);

    // The tick's cursor. One row per world; NOT a balance (see the header) —
    // it is bookkeeping for "how far has this world been priced", the same
    // role `authority_at_world_ms` plays for one commander, generalised to
    // one row per world instead of one row per commander.
    sqlite3_exec(db,
        "CREATE TABLE IF NOT EXISTS world_economy_cursor ("
        "  world_id TEXT PRIMARY KEY,"
        "  last_tick_world_ms INTEGER NOT NULL DEFAULT 0"
        ")", nullptr, nullptr, nullptr);
}

double WorldEconomy::TreasuryFor(sqlite3* db, const std::string& worldId,
                                 const std::string& factionId) {
    if (!db || worldId.empty() || factionId.empty()) return 0.0;
    static const char* kSql =
        "SELECT COALESCE(SUM(delta), 0) FROM world_economy_events "
        "WHERE world_id=? AND faction_id=?";
    sqlite3_stmt* stmt = nullptr;
    if (sqlite3_prepare_v2(db, kSql, -1, &stmt, nullptr) != SQLITE_OK) return 0.0;
    BindText(stmt, 1, worldId);
    BindText(stmt, 2, factionId);
    double total = 0.0;
    if (sqlite3_step(stmt) == SQLITE_ROW) total = sqlite3_column_double(stmt, 0);
    sqlite3_finalize(stmt);
    return total;
}

std::vector<WorldEconomyEventRecord> WorldEconomy::EventsFor(
    sqlite3* db, const std::string& worldId, const std::string& factionId) {
    std::vector<WorldEconomyEventRecord> out;
    if (!db || worldId.empty() || factionId.empty()) return out;
    static const char* kSql =
        "SELECT world_id, faction_id, poi_id, source, delta, world_ms, recorded_at "
        "FROM world_economy_events WHERE world_id=? AND faction_id=? ORDER BY rowid ASC";
    sqlite3_stmt* stmt = nullptr;
    if (sqlite3_prepare_v2(db, kSql, -1, &stmt, nullptr) != SQLITE_OK) return out;
    BindText(stmt, 1, worldId);
    BindText(stmt, 2, factionId);
    while (sqlite3_step(stmt) == SQLITE_ROW) {
        WorldEconomyEventRecord e;
        e.worldId    = ColText(stmt, 0);
        e.factionId  = ColText(stmt, 1);
        e.poiId      = ColText(stmt, 2);
        e.source     = ColText(stmt, 3);
        e.delta      = sqlite3_column_double(stmt, 4);
        e.worldMs    = sqlite3_column_int64(stmt, 5);
        e.recordedAt = sqlite3_column_int64(stmt, 6);
        out.push_back(std::move(e));
    }
    sqlite3_finalize(stmt);
    return out;
}

int64_t WorldEconomy::LastTickWorldMs(sqlite3* db, const std::string& worldId) {
    if (!db || worldId.empty()) return 0;
    static const char* kSql =
        "SELECT last_tick_world_ms FROM world_economy_cursor WHERE world_id=?";
    sqlite3_stmt* stmt = nullptr;
    if (sqlite3_prepare_v2(db, kSql, -1, &stmt, nullptr) != SQLITE_OK) return 0;
    BindText(stmt, 1, worldId);
    int64_t v = 0;
    if (sqlite3_step(stmt) == SQLITE_ROW) v = sqlite3_column_int64(stmt, 0);
    sqlite3_finalize(stmt);
    return v;
}

namespace {

bool WriteEvent(sqlite3* db, const WorldEconomyEventRecord& e) {
    static const char* kSql =
        "INSERT INTO world_economy_events "
        "(world_id, faction_id, poi_id, source, delta, world_ms, recorded_at) "
        "VALUES (?, ?, ?, ?, ?, ?, ?)";
    sqlite3_stmt* stmt = nullptr;
    if (sqlite3_prepare_v2(db, kSql, -1, &stmt, nullptr) != SQLITE_OK) return false;
    BindText(stmt, 1, e.worldId);
    BindText(stmt, 2, e.factionId);
    BindText(stmt, 3, e.poiId);
    BindText(stmt, 4, e.source);
    sqlite3_bind_double(stmt, 5, e.delta);
    sqlite3_bind_int64(stmt, 6, e.worldMs);
    sqlite3_bind_int64(stmt, 7, e.recordedAt);
    const bool ok = sqlite3_step(stmt) == SQLITE_DONE;
    sqlite3_finalize(stmt);
    return ok;
}

bool WriteCursor(sqlite3* db, const std::string& worldId, int64_t worldMs) {
    static const char* kSql =
        "INSERT INTO world_economy_cursor (world_id, last_tick_world_ms) VALUES (?, ?) "
        "ON CONFLICT(world_id) DO UPDATE SET last_tick_world_ms=excluded.last_tick_world_ms";
    sqlite3_stmt* stmt = nullptr;
    if (sqlite3_prepare_v2(db, kSql, -1, &stmt, nullptr) != SQLITE_OK) return false;
    BindText(stmt, 1, worldId);
    sqlite3_bind_int64(stmt, 2, worldMs);
    const bool ok = sqlite3_step(stmt) == SQLITE_DONE;
    sqlite3_finalize(stmt);
    return ok;
}

/// True if `world_economy_cursor` already has a row for this world — the
/// baseline-planting check `Tick` uses to refuse backdating a brand-new
/// world's whole pre-W9 history into one windfall.
bool HasCursorRow(sqlite3* db, const std::string& worldId) {
    static const char* kSql =
        "SELECT 1 FROM world_economy_cursor WHERE world_id=?";
    sqlite3_stmt* stmt = nullptr;
    if (sqlite3_prepare_v2(db, kSql, -1, &stmt, nullptr) != SQLITE_OK) return false;
    BindText(stmt, 1, worldId);
    const bool has = sqlite3_step(stmt) == SQLITE_ROW;
    sqlite3_finalize(stmt);
    return has;
}

}  // namespace

int WorldEconomy::Tick(sqlite3* db, const std::string& worldId,
                       const WorldEconomyRules& rules,
                       int64_t nowWorldMs, int64_t nowRealMs) {
    if (!db || worldId.empty()) return 0;

    if (!HasCursorRow(db, worldId)) {
        // First-ever tick for this world: plant the baseline, price nothing.
        // See the header — a world ticked long after it was founded must not
        // backdate a windfall for the whole gap.
        WriteCursor(db, worldId, nowWorldMs);
        return 0;
    }

    const int64_t cursor  = LastTickWorldMs(db, worldId);
    const int64_t elapsed = nowWorldMs - cursor;
    // <= 0 covers both "the world is paused" (the clock this was called with
    // has not moved since the last tick — see the header) and a clock resync
    // landing slightly behind a stored cursor. Neither is a windfall or a
    // penalty: nothing is priced and the cursor does not move backwards.
    if (elapsed <= 0) return 0;

    // Per-faction POI counts, so income is priced once per faction-POI pair
    // rather than once per faction with a count folded in — the ledger stays
    // "per-POI/per-faction", auditable down to which region paid for what.
    std::vector<std::pair<std::string, std::string>> ownedPois;  // (factionId, poiId)
    std::map<std::string, int> poisByFaction;
    for (const auto& p : WorldDirector::PoisFor(db, worldId)) {
        if (p.ownerFactionId.empty()) continue;
        ownedPois.emplace_back(p.ownerFactionId, p.poiId);
        ++poisByFaction[p.ownerFactionId];
    }

    // The universe of factions to decay: every faction the world knows,
    // whether or not it currently owns a POI — a faction that just lost its
    // last region still has a treasury to bleed until it is spent or floors
    // out, and skipping it here would let a POI loss silently freeze decay.
    std::vector<std::string> allFactionIds;
    for (const auto& f : WorldFactions::ListFor(db, worldId))
        allFactionIds.push_back(f.factionId);

    // Balances as of the START of this period, read before anything below
    // writes a single row. Decay prices what was ALREADY there; this tick's
    // own income has not had time to decay yet (it will, next tick) — reading
    // the balance again after the income loop would see this call's own
    // uncommitted inserts (same connection, same open transaction) and decay
    // income that is seconds old.
    std::map<std::string, double> balanceBefore;
    for (const auto& factionId : allFactionIds)
        balanceBefore[factionId] = TreasuryFor(db, worldId, factionId);

    int written = 0;
    const bool committed = SqliteWriteTransaction(db, "WorldEconomyTick", [&] {
        written = 0;
        bool ok = true;

        for (const auto& [factionId, poiId] : ownedPois) {
            const double income = PoiIncomeOverPeriod(elapsed, rules);
            if (income == 0.0) continue;
            WorldEconomyEventRecord e;
            e.worldId    = worldId;
            e.factionId  = factionId;
            e.poiId      = poiId;
            e.source     = "poi_income";
            e.delta      = income;
            e.worldMs    = nowWorldMs;
            e.recordedAt = nowRealMs;
            if (!WriteEvent(db, e)) { ok = false; break; }
            ++written;
        }

        if (ok) {
            for (const auto& factionId : allFactionIds) {
                const double balance = balanceBefore[factionId];
                const double delta   = TreasuryDecayOverPeriod(balance, elapsed, rules);
                if (delta == 0.0) continue;
                WorldEconomyEventRecord e;
                e.worldId    = worldId;
                e.factionId  = factionId;
                e.source     = "decay";
                e.delta      = delta;
                e.worldMs    = nowWorldMs;
                e.recordedAt = nowRealMs;
                if (!WriteEvent(db, e)) { ok = false; break; }
                ++written;
            }
        }

        if (ok) ok = WriteCursor(db, worldId, nowWorldMs);
        if (!ok) return SQLITE_ERROR;
        return SQLITE_OK;
    });
    // A rolled-back transaction leaves the cursor untouched, so the NEXT tick
    // call re-prices the same gap instead of silently losing it — the write
    // failure is the only case this file replays a period, and it replays the
    // whole thing atomically rather than row by row.
    return committed ? written : 0;
}

nlohmann::json WorldEconomy::EconomyJson(sqlite3* db, const std::string& worldId,
                                         const WorldEconomyRules& rules) {
    nlohmann::json out;
    out["poiIncomePerWorldDay"]     = rules.poiIncomePerWorldDay;
    out["treasuryDecayPerWorldDay"] = rules.treasuryDecayPerWorldDay;
    out["treasuryFloor"]            = rules.treasuryFloor;
    nlohmann::json factions = nlohmann::json::array();
    if (db && !worldId.empty()) {
        std::map<std::string, int> poisByFaction;
        for (const auto& p : WorldDirector::PoisFor(db, worldId))
            if (!p.ownerFactionId.empty()) ++poisByFaction[p.ownerFactionId];
        for (const auto& f : WorldFactions::ListFor(db, worldId)) {
            nlohmann::json fj;
            fj["factionId"] = f.factionId;
            fj["treasury"]  = TreasuryFor(db, worldId, f.factionId);
            const auto it = poisByFaction.find(f.factionId);
            fj["poisHeld"]  = it == poisByFaction.end() ? 0 : it->second;
            factions.push_back(std::move(fj));
        }
    }
    out["factions"] = std::move(factions);
    return out;
}
