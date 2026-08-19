#include "WorldDirector.h"

#include <sqlite3.h>

#include "SqliteThreading.h"

namespace {

// Bind a std::string as transient — sqlite copies, so the source can go out of
// scope. Same helper (and reason) as WarDirector.cpp's.
void BindText(sqlite3_stmt* s, int idx, const std::string& v) {
    sqlite3_bind_text(s, idx, v.c_str(), -1, SQLITE_TRANSIENT);
}

std::string ColText(sqlite3_stmt* s, int idx) {
    if (const unsigned char* u = sqlite3_column_text(s, idx))
        return reinterpret_cast<const char*>(u);
    return {};
}

/// Parse a stored config blob. A row whose JSON this build cannot read is
/// served as an EMPTY object, not as a failure: the blob is tunables, and a
/// world whose knobs are unreadable must still have a clock and a map. (The
/// clock itself is columns, never the blob, for exactly this reason.)
nlohmann::json ParseConfig(const std::string& raw) {
    if (raw.empty()) return nlohmann::json::object();
    nlohmann::json j = nlohmann::json::parse(raw, nullptr, /*allow_exceptions=*/false);
    if (j.is_discarded() || !j.is_object()) return nlohmann::json::object();
    return j;
}

/// Tags round-trip as a comma-separated TEXT column rather than a child table:
/// they are a display/filter vocabulary, never joined on, and a tag table
/// would be a second place a POI can partly exist.
std::string JoinTags(const std::vector<std::string>& tags) {
    std::string out;
    for (const auto& t : tags) {
        if (t.empty()) continue;
        if (!out.empty()) out += ",";
        out += t;
    }
    return out;
}

std::vector<std::string> SplitTags(const std::string& raw) {
    std::vector<std::string> out;
    std::string cur;
    for (const char c : raw) {
        if (c == ',') {
            if (!cur.empty()) out.push_back(cur);
            cur.clear();
            continue;
        }
        cur += c;
    }
    if (!cur.empty()) out.push_back(cur);
    return out;
}

const char* kWorldColumns =
    "world_id, name, state, epoch_real_ms, epoch_world_ms, "
    "time_ratio_num, time_ratio_den, created_at, config_json";

WorldRecord ReadWorldRow(sqlite3_stmt* s) {
    WorldRecord w;
    w.worldId            = ColText(s, 0);
    w.name               = ColText(s, 1);
    w.state              = ColText(s, 2);
    w.clock.epochRealMs  = sqlite3_column_int64(s, 3);
    w.clock.epochWorldMs = sqlite3_column_int64(s, 4);
    w.clock.ratioNum     = sqlite3_column_int64(s, 5);
    w.clock.ratioDen     = sqlite3_column_int64(s, 6);
    w.createdAt          = sqlite3_column_int64(s, 7);
    w.config             = ParseConfig(ColText(s, 8));
    return w;
}

const char* kPoiColumns =
    "world_id, poi_id, name, lat, lon, kind, map_id, tags, created_at, "
    "config_json";

WorldPoiRecord ReadPoiRow(sqlite3_stmt* s) {
    WorldPoiRecord p;
    p.worldId   = ColText(s, 0);
    p.poiId     = ColText(s, 1);
    p.name      = ColText(s, 2);
    p.lat       = sqlite3_column_double(s, 3);
    p.lon       = sqlite3_column_double(s, 4);
    p.kind      = ColText(s, 5);
    p.mapId     = ColText(s, 6);
    p.tags      = SplitTags(ColText(s, 7));
    p.createdAt = sqlite3_column_int64(s, 8);
    p.config    = ParseConfig(ColText(s, 9));
    return p;
}

const char* kEdgeColumns =
    "world_id, from_poi, to_poi, transit_world_ms, kind, bidirectional, "
    "config_json";

WorldPoiEdgeRecord ReadEdgeRow(sqlite3_stmt* s) {
    WorldPoiEdgeRecord e;
    e.worldId        = ColText(s, 0);
    e.fromPoi        = ColText(s, 1);
    e.toPoi          = ColText(s, 2);
    e.transitWorldMs = sqlite3_column_int64(s, 3);
    e.kind           = ColText(s, 4);
    e.bidirectional  = sqlite3_column_int(s, 5) != 0;
    e.config         = ParseConfig(ColText(s, 6));
    return e;
}

}  // namespace

nlohmann::json WorldDefaults::ToJson() const {
    nlohmann::json j;
    j["poiBudgetInitial"]       = poiBudgetInitial;
    j["poiBudgetMax"]           = poiBudgetMax;
    j["poiPerWorldAgeDay"]      = poiPerWorldAgeDay;
    j["poiPerRegisteredPlayer"] = poiPerRegisteredPlayer;
    j["transitWorldMsPerKm"]    = transitWorldMsPerKm;
    return j;
}

// ── The rows ───────────────────────────────────────────────────────────────

void WorldDirector::EnsureTables(sqlite3* db) {
    if (!db) return;
    // No probe-and-drop, for the reason the header states: these rows are the
    // only copy of the world. A schema bump migrates additively (ALTER TABLE
    // ADD COLUMN), the way WarDirector and WarPlayerBindings do.
    //
    // world_id is TEXT and it is the FIRST key column of every table here.
    // Nothing below is keyed by room_id — that is the battle layer, and the
    // two must never share a key.
    sqlite3_exec(db,
        "CREATE TABLE IF NOT EXISTS worlds ("
        "  world_id TEXT PRIMARY KEY,"
        "  name TEXT NOT NULL DEFAULT '',"
        "  state TEXT NOT NULL DEFAULT 'active',"
        // The clock, as columns rather than as blob keys: a corrupt tunables
        // blob must never be able to move the world clock.
        "  epoch_real_ms INTEGER NOT NULL DEFAULT 0,"
        "  epoch_world_ms INTEGER NOT NULL DEFAULT 0,"
        "  time_ratio_num INTEGER NOT NULL DEFAULT 24,"
        "  time_ratio_den INTEGER NOT NULL DEFAULT 1,"
        "  created_at INTEGER NOT NULL DEFAULT 0,"
        "  config_json TEXT NOT NULL DEFAULT '{}'"
        ")", nullptr, nullptr, nullptr);

    sqlite3_exec(db,
        "CREATE TABLE IF NOT EXISTS world_pois ("
        "  world_id TEXT NOT NULL,"
        "  poi_id TEXT NOT NULL,"
        "  name TEXT NOT NULL DEFAULT '',"
        "  lat REAL NOT NULL DEFAULT 0,"
        "  lon REAL NOT NULL DEFAULT 0,"
        "  kind TEXT NOT NULL DEFAULT 'region',"
        // Empty = a world-only POI. Not a foreign key into `maps`: a POI may
        // name a map this lobby has not installed, and losing the POI because
        // the map package is missing would edit the world's geography.
        "  map_id TEXT NOT NULL DEFAULT '',"
        "  tags TEXT NOT NULL DEFAULT '',"
        "  created_at INTEGER NOT NULL DEFAULT 0,"
        "  config_json TEXT NOT NULL DEFAULT '{}',"
        "  PRIMARY KEY (world_id, poi_id)"
        ")", nullptr, nullptr, nullptr);

    sqlite3_exec(db,
        "CREATE TABLE IF NOT EXISTS world_poi_edges ("
        "  world_id TEXT NOT NULL,"
        "  from_poi TEXT NOT NULL,"
        "  to_poi TEXT NOT NULL,"
        // WORLD ms (see the header): strategic movement is measured on the
        // world clock, so an edge weight survives a change to the time ratio
        // meaning the same thing in fiction.
        "  transit_world_ms INTEGER NOT NULL DEFAULT 0,"
        "  kind TEXT NOT NULL DEFAULT 'transit',"
        "  bidirectional INTEGER NOT NULL DEFAULT 1,"
        "  config_json TEXT NOT NULL DEFAULT '{}',"
        "  PRIMARY KEY (world_id, from_poi, to_poi)"
        ")", nullptr, nullptr, nullptr);

    sqlite3_exec(db,
        "CREATE TABLE IF NOT EXISTS world_pause_ledger ("
        "  world_id TEXT NOT NULL,"
        "  started_at_ms INTEGER NOT NULL,"
        // 0 = still paused. An open row is the ONLY representation of "the
        // world is paused right now" — there is no paused flag anywhere else,
        // so the two can never disagree.
        "  ended_at_ms INTEGER NOT NULL DEFAULT 0,"
        "  reason TEXT NOT NULL DEFAULT '',"
        "  actor TEXT NOT NULL DEFAULT '',"
        "  PRIMARY KEY (world_id, started_at_ms)"
        ")", nullptr, nullptr, nullptr);

    // Every clock read scans this world's ledger; the primary key leads with
    // world_id and serves that, but the open-interval lookup (`ended_at_ms=0`)
    // is the hot one on a world with a long pause history.
    sqlite3_exec(db,
        "CREATE INDEX IF NOT EXISTS idx_world_pause_open "
        "ON world_pause_ledger(world_id, ended_at_ms)", nullptr, nullptr, nullptr);
    sqlite3_exec(db,
        "CREATE INDEX IF NOT EXISTS idx_world_pois_map "
        "ON world_pois(map_id)", nullptr, nullptr, nullptr);
}

bool WorldDirector::Upsert(sqlite3* db, const WorldRecord& w) {
    if (!db || w.worldId.empty()) return false;
    bool ok = true;
    const bool committed = SqliteWriteTransaction(db, "WorldUpsert", [&] {
        static const char* kSql =
            "INSERT INTO worlds (world_id, name, state, epoch_real_ms,"
            "                    epoch_world_ms, time_ratio_num, time_ratio_den,"
            "                    created_at, config_json) "
            "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) "
            "ON CONFLICT(world_id) DO UPDATE SET "
            "  name=excluded.name, state=excluded.state,"
            "  epoch_real_ms=excluded.epoch_real_ms,"
            "  epoch_world_ms=excluded.epoch_world_ms,"
            "  time_ratio_num=excluded.time_ratio_num,"
            "  time_ratio_den=excluded.time_ratio_den,"
            "  config_json=excluded.config_json";
        // created_at is deliberately NOT in the update list: a world is
        // founded once.
        sqlite3_stmt* stmt = nullptr;
        if (sqlite3_prepare_v2(db, kSql, -1, &stmt, nullptr) != SQLITE_OK) {
            ok = false;
            return SQLITE_ERROR;
        }
        BindText(stmt, 1, w.worldId);
        BindText(stmt, 2, w.name);
        BindText(stmt, 3, w.state);
        sqlite3_bind_int64(stmt, 4, w.clock.epochRealMs);
        sqlite3_bind_int64(stmt, 5, w.clock.epochWorldMs);
        sqlite3_bind_int64(stmt, 6, w.clock.ratioNum);
        sqlite3_bind_int64(stmt, 7, w.clock.ratioDen);
        sqlite3_bind_int64(stmt, 8, w.createdAt);
        const std::string cfg = w.config.dump();
        BindText(stmt, 9, cfg);
        ok = sqlite3_step(stmt) == SQLITE_DONE;
        sqlite3_finalize(stmt);
        return ok ? SQLITE_OK : SQLITE_ERROR;
    });
    return committed && ok;
}

std::optional<WorldRecord> WorldDirector::Load(sqlite3* db, const std::string& worldId) {
    if (!db || worldId.empty()) return std::nullopt;
    const std::string sql =
        std::string("SELECT ") + kWorldColumns + " FROM worlds WHERE world_id=?";
    sqlite3_stmt* stmt = nullptr;
    if (sqlite3_prepare_v2(db, sql.c_str(), -1, &stmt, nullptr) != SQLITE_OK)
        return std::nullopt;
    BindText(stmt, 1, worldId);
    std::optional<WorldRecord> out;
    if (sqlite3_step(stmt) == SQLITE_ROW)
        out = ReadWorldRow(stmt);
    sqlite3_finalize(stmt);
    return out;
}

std::vector<WorldRecord> WorldDirector::ListWorlds(sqlite3* db) {
    std::vector<WorldRecord> out;
    if (!db) return out;
    const std::string sql = std::string("SELECT ") + kWorldColumns +
                            " FROM worlds ORDER BY created_at ASC, world_id ASC";
    sqlite3_stmt* stmt = nullptr;
    if (sqlite3_prepare_v2(db, sql.c_str(), -1, &stmt, nullptr) != SQLITE_OK)
        return out;
    while (sqlite3_step(stmt) == SQLITE_ROW)
        out.push_back(ReadWorldRow(stmt));
    sqlite3_finalize(stmt);
    return out;
}

std::string WorldDirector::PrimaryWorldId(sqlite3* db) {
    for (const auto& w : ListWorlds(db)) {
        if (w.state == "active") return w.worldId;
    }
    return {};
}

std::string WorldDirector::SeedDefaultWorld(sqlite3* db, int64_t nowRealMs) {
    if (!db) return {};
    const auto existing = ListWorlds(db);
    if (!existing.empty()) {
        // Already seeded. Return the primary if there is one, otherwise the
        // oldest row — a lobby whose only world was archived should still be
        // able to serve it read-only rather than silently found a new Earth.
        const std::string primary = PrimaryWorldId(db);
        return primary.empty() ? existing.front().worldId : primary;
    }

    WorldRecord w;
    w.worldId = kDefaultWorldId;
    w.name    = kDefaultWorldName;
    w.state   = "active";
    // The epoch is NOW: the world starts running the moment it is founded, and
    // world time zero is its founding instant. (`epochWorldMs` stays 0 — an
    // in-fiction start date is a per-world edit, not a code default.)
    w.clock.epochRealMs  = nowRealMs;
    w.clock.epochWorldMs = 0;
    w.clock.ratioNum     = kDefaultWorldTimeRatioNum;
    w.clock.ratioDen     = kDefaultWorldTimeRatioDen;
    w.createdAt          = nowRealMs;
    w.config             = WorldDefaults{}.ToJson();
    if (!Upsert(db, w)) return {};
    return w.worldId;
}

bool WorldDirector::UpsertPoi(sqlite3* db, const WorldPoiRecord& poi) {
    if (!db || poi.worldId.empty() || poi.poiId.empty()) return false;
    bool ok = true;
    const bool committed = SqliteWriteTransaction(db, "WorldUpsertPoi", [&] {
        static const char* kSql =
            "INSERT INTO world_pois (world_id, poi_id, name, lat, lon, kind,"
            "                        map_id, tags, created_at, config_json) "
            "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) "
            "ON CONFLICT(world_id, poi_id) DO UPDATE SET "
            "  name=excluded.name, lat=excluded.lat, lon=excluded.lon,"
            "  kind=excluded.kind, map_id=excluded.map_id, tags=excluded.tags,"
            "  config_json=excluded.config_json";
        sqlite3_stmt* stmt = nullptr;
        if (sqlite3_prepare_v2(db, kSql, -1, &stmt, nullptr) != SQLITE_OK) {
            ok = false;
            return SQLITE_ERROR;
        }
        const std::string tags = JoinTags(poi.tags);
        const std::string cfg  = poi.config.dump();
        BindText(stmt, 1, poi.worldId);
        BindText(stmt, 2, poi.poiId);
        BindText(stmt, 3, poi.name);
        sqlite3_bind_double(stmt, 4, poi.lat);
        sqlite3_bind_double(stmt, 5, poi.lon);
        BindText(stmt, 6, poi.kind);
        BindText(stmt, 7, poi.mapId);
        BindText(stmt, 8, tags);
        sqlite3_bind_int64(stmt, 9, poi.createdAt);
        BindText(stmt, 10, cfg);
        ok = sqlite3_step(stmt) == SQLITE_DONE;
        sqlite3_finalize(stmt);
        return ok ? SQLITE_OK : SQLITE_ERROR;
    });
    return committed && ok;
}

std::vector<WorldPoiRecord> WorldDirector::PoisFor(sqlite3* db,
                                                   const std::string& worldId) {
    std::vector<WorldPoiRecord> out;
    if (!db || worldId.empty()) return out;
    const std::string sql = std::string("SELECT ") + kPoiColumns +
                            " FROM world_pois WHERE world_id=? ORDER BY poi_id ASC";
    sqlite3_stmt* stmt = nullptr;
    if (sqlite3_prepare_v2(db, sql.c_str(), -1, &stmt, nullptr) != SQLITE_OK)
        return out;
    BindText(stmt, 1, worldId);
    while (sqlite3_step(stmt) == SQLITE_ROW)
        out.push_back(ReadPoiRow(stmt));
    sqlite3_finalize(stmt);
    return out;
}

std::optional<WorldPoiRecord> WorldDirector::LoadPoi(sqlite3* db,
                                                     const std::string& worldId,
                                                     const std::string& poiId) {
    if (!db || worldId.empty() || poiId.empty()) return std::nullopt;
    const std::string sql = std::string("SELECT ") + kPoiColumns +
                            " FROM world_pois WHERE world_id=? AND poi_id=?";
    sqlite3_stmt* stmt = nullptr;
    if (sqlite3_prepare_v2(db, sql.c_str(), -1, &stmt, nullptr) != SQLITE_OK)
        return std::nullopt;
    BindText(stmt, 1, worldId);
    BindText(stmt, 2, poiId);
    std::optional<WorldPoiRecord> out;
    if (sqlite3_step(stmt) == SQLITE_ROW)
        out = ReadPoiRow(stmt);
    sqlite3_finalize(stmt);
    return out;
}

bool WorldDirector::UpsertEdge(sqlite3* db, const WorldPoiEdgeRecord& edge) {
    if (!db || edge.worldId.empty() || edge.fromPoi.empty() || edge.toPoi.empty())
        return false;
    // A self-edge is not a route. Refused here rather than stored and ignored
    // by the renderer, because W3 computes weights from distance and a zero
    // distance would look like an instant march between two places.
    if (edge.fromPoi == edge.toPoi) return false;
    bool ok = true;
    const bool committed = SqliteWriteTransaction(db, "WorldUpsertEdge", [&] {
        static const char* kSql =
            "INSERT INTO world_poi_edges (world_id, from_poi, to_poi,"
            "                             transit_world_ms, kind, bidirectional,"
            "                             config_json) "
            "VALUES (?, ?, ?, ?, ?, ?, ?) "
            "ON CONFLICT(world_id, from_poi, to_poi) DO UPDATE SET "
            "  transit_world_ms=excluded.transit_world_ms, kind=excluded.kind,"
            "  bidirectional=excluded.bidirectional,"
            "  config_json=excluded.config_json";
        sqlite3_stmt* stmt = nullptr;
        if (sqlite3_prepare_v2(db, kSql, -1, &stmt, nullptr) != SQLITE_OK) {
            ok = false;
            return SQLITE_ERROR;
        }
        const std::string cfg = edge.config.dump();
        BindText(stmt, 1, edge.worldId);
        BindText(stmt, 2, edge.fromPoi);
        BindText(stmt, 3, edge.toPoi);
        sqlite3_bind_int64(stmt, 4, edge.transitWorldMs);
        BindText(stmt, 5, edge.kind);
        sqlite3_bind_int(stmt, 6, edge.bidirectional ? 1 : 0);
        BindText(stmt, 7, cfg);
        ok = sqlite3_step(stmt) == SQLITE_DONE;
        sqlite3_finalize(stmt);
        return ok ? SQLITE_OK : SQLITE_ERROR;
    });
    return committed && ok;
}

std::vector<WorldPoiEdgeRecord> WorldDirector::EdgesFor(sqlite3* db,
                                                        const std::string& worldId) {
    std::vector<WorldPoiEdgeRecord> out;
    if (!db || worldId.empty()) return out;
    const std::string sql = std::string("SELECT ") + kEdgeColumns +
                            " FROM world_poi_edges WHERE world_id=? "
                            "ORDER BY from_poi ASC, to_poi ASC";
    sqlite3_stmt* stmt = nullptr;
    if (sqlite3_prepare_v2(db, sql.c_str(), -1, &stmt, nullptr) != SQLITE_OK)
        return out;
    BindText(stmt, 1, worldId);
    while (sqlite3_step(stmt) == SQLITE_ROW)
        out.push_back(ReadEdgeRow(stmt));
    sqlite3_finalize(stmt);
    return out;
}

// ── The pause ledger ───────────────────────────────────────────────────────

bool WorldDirector::OpenPause(sqlite3* db, const std::string& worldId,
                              int64_t nowRealMs, const std::string& reason,
                              const std::string& actor) {
    if (!db || worldId.empty()) return false;
    bool ok = true;
    const bool committed = SqliteWriteTransaction(db, "WorldOpenPause", [&] {
        // The already-open check runs INSIDE the transaction: two admins
        // hitting pause at once on the same shared handle would otherwise both
        // see "not paused" and insert, and the world would need two resumes.
        {
            sqlite3_stmt* q = nullptr;
            if (sqlite3_prepare_v2(db,
                    "SELECT 1 FROM world_pause_ledger "
                    "WHERE world_id=? AND ended_at_ms=0 LIMIT 1",
                    -1, &q, nullptr) != SQLITE_OK) {
                ok = false;
                return SQLITE_ERROR;
            }
            BindText(q, 1, worldId);
            const bool alreadyOpen = sqlite3_step(q) == SQLITE_ROW;
            sqlite3_finalize(q);
            if (alreadyOpen) {
                ok = false;
                // ABORT, not ERROR: nothing was lost and nothing is wrong —
                // the world is simply already paused, which is not a failure
                // worth an ERROR line in the lobby log.
                return SQLITE_ABORT;
            }
        }
        sqlite3_stmt* stmt = nullptr;
        if (sqlite3_prepare_v2(db,
                "INSERT INTO world_pause_ledger "
                "(world_id, started_at_ms, ended_at_ms, reason, actor) "
                "VALUES (?, ?, 0, ?, ?)",
                -1, &stmt, nullptr) != SQLITE_OK) {
            ok = false;
            return SQLITE_ERROR;
        }
        BindText(stmt, 1, worldId);
        sqlite3_bind_int64(stmt, 2, nowRealMs);
        BindText(stmt, 3, reason);
        BindText(stmt, 4, actor);
        ok = sqlite3_step(stmt) == SQLITE_DONE;
        sqlite3_finalize(stmt);
        return ok ? SQLITE_OK : SQLITE_ERROR;
    });
    return committed && ok;
}

bool WorldDirector::ClosePause(sqlite3* db, const std::string& worldId,
                               int64_t nowRealMs) {
    if (!db || worldId.empty()) return false;
    bool ok = true;
    const bool committed = SqliteWriteTransaction(db, "WorldClosePause", [&] {
        sqlite3_stmt* stmt = nullptr;
        if (sqlite3_prepare_v2(db,
                "UPDATE world_pause_ledger SET ended_at_ms=? "
                "WHERE world_id=? AND ended_at_ms=0",
                -1, &stmt, nullptr) != SQLITE_OK) {
            ok = false;
            return SQLITE_ERROR;
        }
        sqlite3_bind_int64(stmt, 1, nowRealMs);
        BindText(stmt, 2, worldId);
        ok = sqlite3_step(stmt) == SQLITE_DONE;
        sqlite3_finalize(stmt);
        if (!ok) return SQLITE_ERROR;
        // No open interval → nothing to resume. Reported as false (the caller
        // asked for a state change that did not happen) without logging an
        // error, same reasoning as OpenPause.
        if (sqlite3_changes(db) == 0) {
            ok = false;
            return SQLITE_ABORT;
        }
        return SQLITE_OK;
    });
    return committed && ok;
}

std::vector<WorldPauseInterval> WorldDirector::PausesFor(sqlite3* db,
                                                         const std::string& worldId) {
    std::vector<WorldPauseInterval> out;
    if (!db || worldId.empty()) return out;
    sqlite3_stmt* stmt = nullptr;
    if (sqlite3_prepare_v2(db,
            "SELECT started_at_ms, ended_at_ms FROM world_pause_ledger "
            "WHERE world_id=? ORDER BY started_at_ms ASC",
            -1, &stmt, nullptr) != SQLITE_OK)
        return out;
    BindText(stmt, 1, worldId);
    while (sqlite3_step(stmt) == SQLITE_ROW) {
        WorldPauseInterval iv;
        iv.startedAtMs = sqlite3_column_int64(stmt, 0);
        iv.endedAtMs   = sqlite3_column_int64(stmt, 1);
        out.push_back(iv);
    }
    sqlite3_finalize(stmt);
    return out;
}

std::optional<WorldClockReading> WorldDirector::ClockFor(sqlite3* db,
                                                         const std::string& worldId,
                                                         int64_t nowRealMs) {
    const auto w = Load(db, worldId);
    if (!w) return std::nullopt;
    return ReadWorldClock(w->clock, PausesFor(db, worldId), nowRealMs);
}

// ── The read-only HTTP surface, as data ────────────────────────────────────

nlohmann::json WorldDirector::WorldStatusJson(sqlite3* db, const std::string& worldId,
                                              int64_t nowRealMs) {
    nlohmann::json out;
    const auto w = Load(db, worldId);
    if (!w) {
        out["error"] = "world_not_found";
        out["worldId"] = worldId;
        return out;
    }
    const auto clock = ReadWorldClock(w->clock, PausesFor(db, worldId), nowRealMs);
    const auto cal   = WorldCalendarFromMs(clock.worldMs);

    out["worldId"]   = w->worldId;
    out["name"]      = w->name;
    out["state"]     = w->state;
    out["createdAt"] = w->createdAt;
    // The tunables are served verbatim, keys this build does not know
    // included: the client's job is to render the world, not to agree with the
    // server about which knobs exist.
    out["config"]    = w->config;

    nlohmann::json c;
    c["realMs"]        = clock.realMs;
    c["worldMs"]       = clock.worldMs;
    c["epochRealMs"]   = w->clock.epochRealMs;
    c["epochWorldMs"]  = w->clock.epochWorldMs;
    c["runningRealMs"] = clock.runningRealMs;
    c["pausedRealMs"]  = clock.pausedRealMs;
    c["paused"]        = clock.paused;
    // Both halves of the ratio, so a client can advance the clock locally
    // between polls (W4's widget) without guessing at 24×.
    c["ratioNum"]      = w->clock.ratioNum;
    c["ratioDen"]      = w->clock.ratioDen;
    c["day"]           = cal.dayNumber;
    c["hour"]          = cal.hour;
    c["minute"]        = cal.minute;
    c["second"]        = cal.second;
    c["label"]         = FormatWorldCalendar(cal);
    out["clock"] = std::move(c);

    out["poiCount"] = static_cast<int64_t>(PoisFor(db, w->worldId).size());
    return out;
}

nlohmann::json WorldDirector::WorldPoisJson(sqlite3* db, const std::string& worldId) {
    nlohmann::json out;
    out["worldId"] = worldId;
    nlohmann::json pois = nlohmann::json::array();
    for (const auto& p : PoisFor(db, worldId)) {
        nlohmann::json j;
        j["id"]     = p.poiId;
        j["name"]   = p.name;
        j["lat"]    = p.lat;
        j["lon"]    = p.lon;
        j["kind"]   = p.kind;
        // Explicitly null rather than "" for a world-only POI: the UI branches
        // on "is this place enterable", and an empty string is a value that
        // looks like a map id until someone tries to load it.
        if (p.mapId.empty()) j["mapId"] = nullptr;
        else                 j["mapId"] = p.mapId;
        j["tags"]   = p.tags;
        j["config"] = p.config;
        pois.push_back(std::move(j));
    }
    out["pois"] = std::move(pois);

    nlohmann::json edges = nlohmann::json::array();
    for (const auto& e : EdgesFor(db, worldId)) {
        nlohmann::json j;
        j["from"]           = e.fromPoi;
        j["to"]             = e.toPoi;
        j["transitWorldMs"] = e.transitWorldMs;
        j["kind"]           = e.kind;
        j["bidirectional"]  = e.bidirectional;
        j["config"]         = e.config;
        edges.push_back(std::move(j));
    }
    out["edges"] = std::move(edges);
    return out;
}
