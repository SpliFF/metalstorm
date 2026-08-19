#include "WorldStaging.h"

#include <sqlite3.h>

#include <algorithm>
#include <cmath>
#include <unordered_map>
#include <unordered_set>

#include "SqliteThreading.h"
#include "WorldFactions.h"

namespace {

void BindText(sqlite3_stmt* s, int idx, const std::string& v) {
    sqlite3_bind_text(s, idx, v.c_str(), -1, SQLITE_TRANSIENT);
}

std::string ColText(sqlite3_stmt* s, int idx) {
    if (const unsigned char* u = sqlite3_column_text(s, idx))
        return reinterpret_cast<const char*>(u);
    return {};
}

/// Per-key fallback, never whole-blob — same rule (and reason) as
/// WorldEconomyRules::FromWorldConfig.
double CfgDouble(const nlohmann::json& j, const char* key, double fallback) {
    if (!j.is_object()) return fallback;
    const auto it = j.find(key);
    if (it == j.end() || !it->is_number()) return fallback;
    return it->get<double>();
}

/// Deliberately looser than the `is_number_integer()` test WorldFactions.cpp
/// and WorldStats.cpp use for their counts: ANY number is accepted and
/// rounded. A world's `config_json` is hand-editable operator data (pillar 7
/// — "numbers are data"), and a retry budget typed as `3.0` is a 3, not a
/// reason to silently serve the default. Silently is the operative word:
/// the strict form has no way to complain, so a mistyped knob presents as the
/// rule simply not applying.
int CfgInt(const nlohmann::json& j, const char* key, int fallback) {
    if (!j.is_object()) return fallback;
    const auto it = j.find(key);
    if (it == j.end() || !it->is_number()) return fallback;
    return static_cast<int>(std::llround(it->get<double>()));
}

constexpr const char* kSelectCols =
    "rowid, world_id, poi_id, attacker_faction_id, origin_poi_id, transports, "
    "squads, committed_by_account_id, state, opened_at_world_ms, "
    "ends_at_world_ms, room_id, attempts, last_error, created_at, resolved_at";

WorldStagingRecord ReadRow(sqlite3_stmt* s) {
    WorldStagingRecord r;
    r.stagingId            = sqlite3_column_int64(s, 0);
    r.worldId              = ColText(s, 1);
    r.poiId                = ColText(s, 2);
    r.attackerFactionId    = ColText(s, 3);
    r.originPoiId          = ColText(s, 4);
    r.transports           = sqlite3_column_int(s, 5);
    r.squads               = sqlite3_column_int(s, 6);
    r.committedByAccountId = sqlite3_column_int64(s, 7);
    r.state                = WorldStagingStateFromString(ColText(s, 8));
    r.openedAtWorldMs      = sqlite3_column_int64(s, 9);
    r.endsAtWorldMs        = sqlite3_column_int64(s, 10);
    r.roomId  = static_cast<uint32_t>(sqlite3_column_int64(s, 11));
    r.attempts             = sqlite3_column_int(s, 12);
    r.lastError            = ColText(s, 13);
    r.createdAt            = sqlite3_column_int64(s, 14);
    r.resolvedAt           = sqlite3_column_int64(s, 15);
    return r;
}

std::vector<WorldStagingRecord> Query(sqlite3* db, const std::string& sql,
                                      const std::string& worldId) {
    std::vector<WorldStagingRecord> out;
    sqlite3_stmt* stmt = nullptr;
    if (sqlite3_prepare_v2(db, sql.c_str(), -1, &stmt, nullptr) != SQLITE_OK)
        return out;
    BindText(stmt, 1, worldId);
    while (sqlite3_step(stmt) == SQLITE_ROW) out.push_back(ReadRow(stmt));
    sqlite3_finalize(stmt);
    return out;
}

}  // namespace

// ─────────────────────────── state vocabulary ──────────────────────────────

const char* WorldStagingStateToString(WorldStagingState s) {
    switch (s) {
        case WorldStagingState::Staging:      return "staging";
        case WorldStagingState::Materialised: return "materialised";
        case WorldStagingState::Cancelled:    return "cancelled";
        case WorldStagingState::Failed:       return "failed";
    }
    return "staging";
}

WorldStagingState WorldStagingStateFromString(const std::string& s) {
    if (s == "materialised") return WorldStagingState::Materialised;
    if (s == "cancelled")    return WorldStagingState::Cancelled;
    if (s == "failed")       return WorldStagingState::Failed;
    return WorldStagingState::Staging;
}

// ─────────────────────────── the per-world rates ───────────────────────────

WorldStagingRules WorldStagingRules::FromWorldConfig(const nlohmann::json& c) {
    WorldStagingRules r;
    r.stagingWindowDefaultWorldMs =
        CfgDouble(c, "stagingWindowDefaultWorldMs", r.stagingWindowDefaultWorldMs);
    r.stagingWindowPerTransitMs =
        CfgDouble(c, "stagingWindowPerTransitMs", r.stagingWindowPerTransitMs);
    r.stagingWindowMinWorldMs =
        CfgDouble(c, "stagingWindowMinWorldMs", r.stagingWindowMinWorldMs);
    r.stagingWindowMaxWorldMs =
        CfgDouble(c, "stagingWindowMaxWorldMs", r.stagingWindowMaxWorldMs);
    r.materialiseMaxAttempts =
        CfgInt(c, "stagingMaterialiseMaxAttempts", r.materialiseMaxAttempts);
    return r;
}

// ─────────────────────────── pure policy ───────────────────────────────────

std::string StagingInstigationError(int transports, int squads,
                                    const std::string& attackerFactionId,
                                    const std::string& poiOwnerFactionId) {
    if (attackerFactionId.empty()) return "no_faction";
    // "at least one transport carrying at least one squad" — both halves, and
    // in this order, because an empty transport is the more common mistake and
    // "you brought nothing to carry" is the clearer complaint.
    if (transports < 1) return "no_transport";
    if (squads < 1)     return "no_squads";
    // "…to a POI it does not hold" (§7.1). A faction is *home* at a POI it
    // owns: there is nothing to instigate, and the defender needs no transport.
    if (!poiOwnerFactionId.empty() && poiOwnerFactionId == attackerFactionId)
        return "already_held";
    return {};
}

int64_t StagingWindowFor(int64_t transitWorldMs, const WorldStagingRules& rules) {
    const double lo = std::max(0.0, rules.stagingWindowMinWorldMs);
    // A max below the min is a misconfiguration, not a licence to invert the
    // clamp — the floor wins, because "warning IS the mechanic".
    const double hi = std::max(lo, rules.stagingWindowMaxWorldMs);
    const double raw = transitWorldMs > 0
        ? static_cast<double>(transitWorldMs) * rules.stagingWindowPerTransitMs
        : rules.stagingWindowDefaultWorldMs;
    return static_cast<int64_t>(std::clamp(raw, lo, hi));
}

int64_t CheapestTransitTo(const std::vector<WorldPoiEdgeRecord>& edges,
                          const std::vector<std::string>& fromPois,
                          const std::string& poiId) {
    if (poiId.empty() || fromPois.empty()) return 0;
    const std::unordered_set<std::string> from(fromPois.begin(), fromPois.end());
    int64_t best = 0;
    for (const auto& e : edges) {
        if (e.transitWorldMs <= 0) continue;
        const bool forward  = e.toPoi == poiId && from.count(e.fromPoi) > 0;
        // A one-way route is one way for a march too, so the reverse
        // direction only counts on a bidirectional edge.
        const bool backward = e.bidirectional && e.fromPoi == poiId &&
                              from.count(e.toPoi) > 0;
        if (!forward && !backward) continue;
        if (best == 0 || e.transitWorldMs < best) best = e.transitWorldMs;
    }
    return best;
}

// ─────────────────────────── the store ────────────────────────────────────

void WorldStaging::EnsureTables(sqlite3* db) {
    if (!db) return;
    sqlite3_exec(db,
        "CREATE TABLE IF NOT EXISTS world_staging ("
        "  world_id TEXT NOT NULL,"
        "  poi_id TEXT NOT NULL,"
        "  attacker_faction_id TEXT NOT NULL DEFAULT '',"
        "  origin_poi_id TEXT NOT NULL DEFAULT '',"
        "  transports INTEGER NOT NULL DEFAULT 0,"
        "  squads INTEGER NOT NULL DEFAULT 0,"
        "  committed_by_account_id INTEGER NOT NULL DEFAULT 0,"
        "  state TEXT NOT NULL DEFAULT 'staging',"
        "  opened_at_world_ms INTEGER NOT NULL DEFAULT 0,"
        "  ends_at_world_ms INTEGER NOT NULL DEFAULT 0,"
        "  room_id INTEGER NOT NULL DEFAULT 0,"
        "  attempts INTEGER NOT NULL DEFAULT 0,"
        "  last_error TEXT NOT NULL DEFAULT '',"
        "  created_at INTEGER NOT NULL DEFAULT 0,"
        "  resolved_at INTEGER NOT NULL DEFAULT 0"
        ")", nullptr, nullptr, nullptr);
    // The sweep's query is "open rows in this world, by window end", and the
    // POI panel's is "rows at this POI" — one index each, because the sweep
    // runs on every world every 30 s for the life of the lobby.
    sqlite3_exec(db,
        "CREATE INDEX IF NOT EXISTS idx_world_staging_open "
        "ON world_staging(world_id, state, ends_at_world_ms)",
        nullptr, nullptr, nullptr);
    sqlite3_exec(db,
        "CREATE INDEX IF NOT EXISTS idx_world_staging_poi "
        "ON world_staging(world_id, poi_id)", nullptr, nullptr, nullptr);
}

std::optional<WorldStagingRecord> WorldStaging::Load(sqlite3* db, int64_t stagingId) {
    if (!db || stagingId <= 0) return std::nullopt;
    const std::string sql =
        std::string("SELECT ") + kSelectCols + " FROM world_staging WHERE rowid=?";
    sqlite3_stmt* stmt = nullptr;
    if (sqlite3_prepare_v2(db, sql.c_str(), -1, &stmt, nullptr) != SQLITE_OK)
        return std::nullopt;
    sqlite3_bind_int64(stmt, 1, stagingId);
    std::optional<WorldStagingRecord> out;
    if (sqlite3_step(stmt) == SQLITE_ROW) out = ReadRow(stmt);
    sqlite3_finalize(stmt);
    return out;
}

std::vector<WorldStagingRecord> WorldStaging::OpenFor(sqlite3* db,
                                                      const std::string& worldId) {
    if (!db || worldId.empty()) return {};
    return Query(db, std::string("SELECT ") + kSelectCols +
                     " FROM world_staging WHERE world_id=? AND state='staging' "
                     "ORDER BY ends_at_world_ms ASC, rowid ASC",
                 worldId);
}

std::vector<WorldStagingRecord> WorldStaging::AllFor(sqlite3* db,
                                                     const std::string& worldId) {
    if (!db || worldId.empty()) return {};
    return Query(db, std::string("SELECT ") + kSelectCols +
                     " FROM world_staging WHERE world_id=? ORDER BY rowid DESC",
                 worldId);
}

std::vector<WorldStagingRecord> WorldStaging::DueStagings(
    sqlite3* db, const std::string& worldId, const WorldStagingRules& rules,
    int64_t nowWorldMs) {
    std::vector<WorldStagingRecord> out;
    for (auto& r : OpenFor(db, worldId)) {
        if (r.endsAtWorldMs > nowWorldMs) continue;
        // The budget is re-read from the rules on every sweep rather than
        // frozen into the row, so lowering it in config retires a row that is
        // already spinning instead of only affecting future ones.
        if (rules.materialiseMaxAttempts > 0 &&
            r.attempts >= rules.materialiseMaxAttempts)
            continue;
        out.push_back(std::move(r));
    }
    return out;
}

WorldStagingCommitResult WorldStaging::Commit(sqlite3* db,
                                              const WorldStagingRules& rules,
                                              const WorldStagingCommitRequest& req,
                                              int64_t nowWorldMs, int64_t nowRealMs) {
    WorldStagingCommitResult res;
    if (!db) { res.error = "db_error"; return res; }
    if (req.worldId.empty()) { res.error = "no_world"; return res; }

    const auto world = WorldDirector::Load(db, req.worldId);
    if (!world) { res.error = "no_world"; return res; }

    const auto poi = WorldDirector::LoadPoi(db, req.worldId, req.poiId);
    if (!poi) { res.error = "no_poi"; return res; }
    // A POI with no battle map cannot host a battle, so committing force at
    // one would open a window that could never materialise. Refused at
    // commitment rather than discovered at the window's end — the player is
    // owed the "nothing to fight over here" answer while they can still spend
    // the force somewhere else.
    if (!poi->HasBattleMap()) { res.error = "no_battle_map"; return res; }

    if (!WorldFactions::Load(db, req.worldId, req.attackerFactionId)) {
        res.error = "no_faction";
        return res;
    }

    if (const std::string why = StagingInstigationError(
            req.transports, req.squads, req.attackerFactionId, poi->ownerFactionId);
        !why.empty()) {
        res.error = why;
        return res;
    }

    // §7.2's late commitment: force committed while this faction already has
    // an open window at this POI joins it. The window does not move — see the
    // header for why extending it would be a grief vector.
    for (const auto& open : OpenFor(db, req.worldId)) {
        if (open.poiId != req.poiId || open.attackerFactionId != req.attackerFactionId)
            continue;
        static const char* kAdd =
            "UPDATE world_staging SET transports=transports+?, squads=squads+? "
            "WHERE rowid=? AND state='staging'";
        sqlite3_stmt* stmt = nullptr;
        if (sqlite3_prepare_v2(db, kAdd, -1, &stmt, nullptr) != SQLITE_OK) {
            res.error = "db_error";
            return res;
        }
        sqlite3_bind_int(stmt, 1, req.transports);
        sqlite3_bind_int(stmt, 2, req.squads);
        sqlite3_bind_int64(stmt, 3, open.stagingId);
        const bool ok = sqlite3_step(stmt) == SQLITE_DONE;
        sqlite3_finalize(stmt);
        if (!ok) { res.error = "db_error"; return res; }
        const auto reloaded = Load(db, open.stagingId);
        if (!reloaded) { res.error = "db_error"; return res; }
        res.ok = true;
        res.joined = true;
        res.staging = *reloaded;
        return res;
    }

    // Price the window. The origin the committer named wins; failing that,
    // every POI the attacking faction already holds is a plausible staging
    // ground and the cheapest of them is the honest answer — an attacker
    // marches from wherever is nearest, and making the UI name an origin
    // before it can show a window would put the plumbing before the player.
    std::vector<std::string> origins;
    if (!req.originPoiId.empty()) {
        origins.push_back(req.originPoiId);
    } else {
        for (const auto& p : WorldDirector::PoisFor(db, req.worldId))
            if (p.ownerFactionId == req.attackerFactionId) origins.push_back(p.poiId);
    }
    const int64_t transit =
        CheapestTransitTo(WorldDirector::EdgesFor(db, req.worldId), origins, req.poiId);
    const int64_t window = StagingWindowFor(transit, rules);

    WorldStagingRecord r;
    r.worldId              = req.worldId;
    r.poiId                = req.poiId;
    r.attackerFactionId    = req.attackerFactionId;
    r.originPoiId          = req.originPoiId;
    r.transports           = req.transports;
    r.squads               = req.squads;
    r.committedByAccountId = req.accountId;
    r.state                = WorldStagingState::Staging;
    r.openedAtWorldMs      = nowWorldMs;
    r.endsAtWorldMs        = nowWorldMs + window;
    r.createdAt            = nowRealMs;

    static const char* kInsert =
        "INSERT INTO world_staging (world_id, poi_id, attacker_faction_id, "
        "origin_poi_id, transports, squads, committed_by_account_id, state, "
        "opened_at_world_ms, ends_at_world_ms, created_at) "
        "VALUES (?, ?, ?, ?, ?, ?, ?, 'staging', ?, ?, ?)";
    sqlite3_stmt* stmt = nullptr;
    if (sqlite3_prepare_v2(db, kInsert, -1, &stmt, nullptr) != SQLITE_OK) {
        res.error = "db_error";
        return res;
    }
    BindText(stmt, 1, r.worldId);
    BindText(stmt, 2, r.poiId);
    BindText(stmt, 3, r.attackerFactionId);
    BindText(stmt, 4, r.originPoiId);
    sqlite3_bind_int(stmt, 5, r.transports);
    sqlite3_bind_int(stmt, 6, r.squads);
    sqlite3_bind_int64(stmt, 7, r.committedByAccountId);
    sqlite3_bind_int64(stmt, 8, r.openedAtWorldMs);
    sqlite3_bind_int64(stmt, 9, r.endsAtWorldMs);
    sqlite3_bind_int64(stmt, 10, r.createdAt);
    const bool ok = sqlite3_step(stmt) == SQLITE_DONE;
    sqlite3_finalize(stmt);
    if (!ok) { res.error = "db_error"; return res; }
    r.stagingId = sqlite3_last_insert_rowid(db);

    res.ok = true;
    res.staging = r;
    return res;
}

bool WorldStaging::MarkMaterialised(sqlite3* db, int64_t stagingId, uint32_t roomId,
                                    int64_t nowRealMs) {
    if (!db || stagingId <= 0) return false;
    // Guarded on `state='staging'` so a second sweep (or a second lobby)
    // cannot re-materialise a row that already became a war — the guard IS
    // the idempotence, and it is the same shape W6's ledger guard uses.
    static const char* kSql =
        "UPDATE world_staging SET state='materialised', room_id=?, resolved_at=?, "
        "last_error='' WHERE rowid=? AND state='staging'";
    sqlite3_stmt* stmt = nullptr;
    if (sqlite3_prepare_v2(db, kSql, -1, &stmt, nullptr) != SQLITE_OK) return false;
    sqlite3_bind_int64(stmt, 1, static_cast<int64_t>(roomId));
    sqlite3_bind_int64(stmt, 2, nowRealMs);
    sqlite3_bind_int64(stmt, 3, stagingId);
    const bool ok = sqlite3_step(stmt) == SQLITE_DONE;
    const int changed = sqlite3_changes(db);
    sqlite3_finalize(stmt);
    return ok && changed > 0;
}

bool WorldStaging::MarkAttemptFailed(sqlite3* db, int64_t stagingId,
                                     const std::string& reason,
                                     const WorldStagingRules& rules,
                                     int64_t nowRealMs) {
    if (!db || stagingId <= 0) return false;
    static const char* kSql =
        "UPDATE world_staging SET attempts=attempts+1, last_error=? "
        "WHERE rowid=? AND state='staging'";
    sqlite3_stmt* stmt = nullptr;
    if (sqlite3_prepare_v2(db, kSql, -1, &stmt, nullptr) != SQLITE_OK) return false;
    BindText(stmt, 1, reason);
    sqlite3_bind_int64(stmt, 2, stagingId);
    const bool ok = sqlite3_step(stmt) == SQLITE_DONE;
    const int changed = sqlite3_changes(db);
    sqlite3_finalize(stmt);
    if (!ok || changed == 0) return false;

    if (rules.materialiseMaxAttempts <= 0) return true;
    const auto row = Load(db, stagingId);
    if (!row || row->attempts < rules.materialiseMaxAttempts) return true;
    static const char* kGiveUp =
        "UPDATE world_staging SET state='failed', resolved_at=? "
        "WHERE rowid=? AND state='staging'";
    sqlite3_stmt* g = nullptr;
    if (sqlite3_prepare_v2(db, kGiveUp, -1, &g, nullptr) != SQLITE_OK) return true;
    sqlite3_bind_int64(g, 1, nowRealMs);
    sqlite3_bind_int64(g, 2, stagingId);
    sqlite3_step(g);
    sqlite3_finalize(g);
    return true;
}

bool WorldStaging::Cancel(sqlite3* db, int64_t stagingId, int64_t nowRealMs) {
    if (!db || stagingId <= 0) return false;
    static const char* kSql =
        "UPDATE world_staging SET state='cancelled', resolved_at=? "
        "WHERE rowid=? AND state='staging'";
    sqlite3_stmt* stmt = nullptr;
    if (sqlite3_prepare_v2(db, kSql, -1, &stmt, nullptr) != SQLITE_OK) return false;
    sqlite3_bind_int64(stmt, 1, nowRealMs);
    sqlite3_bind_int64(stmt, 2, stagingId);
    const bool ok = sqlite3_step(stmt) == SQLITE_DONE;
    const int changed = sqlite3_changes(db);
    sqlite3_finalize(stmt);
    return ok && changed > 0;
}

// ─────────────────────────── the read surface ──────────────────────────────

nlohmann::json WorldStaging::StagingJson(const WorldStagingRecord& r,
                                         int64_t nowWorldMs) {
    nlohmann::json j;
    j["stagingId"]       = r.stagingId;
    j["poiId"]           = r.poiId;
    j["attackerFaction"] = r.attackerFactionId;
    j["originPoiId"]     = r.originPoiId.empty() ? nlohmann::json(nullptr)
                                                 : nlohmann::json(r.originPoiId);
    j["transports"]      = r.transports;
    j["squads"]          = r.squads;
    j["state"]           = WorldStagingStateToString(r.state);
    j["openedAtWorldMs"] = r.openedAtWorldMs;
    j["endsAtWorldMs"]   = r.endsAtWorldMs;
    // Remaining is served rather than left to the client to subtract: the
    // client ticks its own copy of the world clock between fetches (W4), and
    // two clocks disagreeing about "3 hours left" is exactly the confusion a
    // warning mechanic cannot afford. Never negative — an overdue window is
    // "0", i.e. materialising.
    j["remainingWorldMs"] = std::max<int64_t>(0, r.endsAtWorldMs - nowWorldMs);
    j["roomId"] = r.roomId == 0 ? nlohmann::json(nullptr) : nlohmann::json(r.roomId);
    return j;
}

nlohmann::json WorldStaging::AttachStaging(nlohmann::json poisJson, sqlite3* db,
                                           const std::string& worldId,
                                           int64_t nowWorldMs) {
    if (!poisJson.contains("pois") || !poisJson["pois"].is_array())
        return poisJson;

    std::unordered_map<std::string, std::vector<WorldStagingRecord>> byPoi;
    for (auto& r : WorldStaging::OpenFor(db, worldId))
        byPoi[r.poiId].push_back(std::move(r));

    for (auto& poi : poisJson["pois"]) {
        nlohmann::json arr = nlohmann::json::array();
        if (poi.contains("id") && poi["id"].is_string()) {
            const auto it = byPoi.find(poi["id"].get<std::string>());
            if (it != byPoi.end()) {
                for (const auto& r : it->second)
                    arr.push_back(StagingJson(r, nowWorldMs));
            }
        }
        const bool gathering = !arr.empty();
        poi["staging"] = std::move(arr);
        // Upgrade only (see the header): "quiet" becomes "staging", "active"
        // and an existing "staging" are left exactly as W5 computed them.
        if (gathering && poi.value("battleStatus", std::string("quiet")) == "quiet")
            poi["battleStatus"] = "staging";
    }
    return poisJson;
}
