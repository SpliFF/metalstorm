#include "WorldSeasons.h"

#include <sqlite3.h>

#include <algorithm>
#include <map>
#include <sstream>

#include "SqliteThreading.h"
#include "WorldDirector.h"
#include "WorldEconomy.h"
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

/// Per-key fallback, never whole-blob — same rule (and reason) as every other
/// `FromWorldConfig` in this layer: a world tuned before W12 has exactly the
/// keys it was tuned with, and a missing key must not turn the rule off.
double CfgDouble(const nlohmann::json& j, const char* key, double fallback) {
    if (!j.is_object()) return fallback;
    const auto it = j.find(key);
    if (it == j.end() || !it->is_number()) return fallback;
    return it->get<double>();
}

/// `WorldSettlementRecord::factions` is comma-joined winner faction ids
/// (`WarOutcomeRecord::winnerFactions`, reused verbatim — same register W6
/// already reads from). Split it the same way `SplitTags` does in
/// WorldDirector.cpp.
std::vector<std::string> SplitFactions(const std::string& raw) {
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

WorldSeasonRecord ReadSeasonRow(sqlite3_stmt* stmt) {
    WorldSeasonRecord s;
    s.worldId               = ColText(stmt, 0);
    s.seasonNumber           = static_cast<int>(sqlite3_column_int64(stmt, 1));
    s.state                  = ColText(stmt, 2);
    s.startedWorldMs         = sqlite3_column_int64(stmt, 3);
    s.endedWorldMs           = sqlite3_column_int64(stmt, 4);
    s.settlementCursorStart  = sqlite3_column_int64(stmt, 5);
    s.createdAt              = sqlite3_column_int64(stmt, 6);
    return s;
}

}  // namespace

// ─────────────────────────── the per-world rates ───────────────────────────

WorldSeasonRules WorldSeasonRules::FromWorldConfig(const nlohmann::json& c) {
    WorldSeasonRules r;
    r.seasonLengthWorldMs = CfgDouble(c, "seasonLengthWorldMs", r.seasonLengthWorldMs);
    return r;
}

// ─────────────────────────── the store ────────────────────────────────────

void WorldSeasons::EnsureTables(sqlite3* db) {
    if (!db) return;
    sqlite3_exec(db,
        "CREATE TABLE IF NOT EXISTS world_seasons ("
        "  world_id TEXT NOT NULL,"
        "  season_number INTEGER NOT NULL,"
        "  state TEXT NOT NULL DEFAULT 'active',"
        "  started_world_ms INTEGER NOT NULL DEFAULT 0,"
        "  ended_world_ms INTEGER NOT NULL DEFAULT 0,"
        "  settlement_cursor_start INTEGER NOT NULL DEFAULT 0,"
        "  created_at INTEGER NOT NULL DEFAULT 0,"
        "  UNIQUE(world_id, season_number)"
        ")", nullptr, nullptr, nullptr);
    sqlite3_exec(db,
        "CREATE INDEX IF NOT EXISTS idx_world_seasons_active "
        "ON world_seasons(world_id, state)", nullptr, nullptr, nullptr);

    sqlite3_exec(db,
        "CREATE TABLE IF NOT EXISTS world_season_digests ("
        "  world_id TEXT NOT NULL,"
        "  season_number INTEGER NOT NULL,"
        "  faction_id TEXT NOT NULL DEFAULT '',"
        "  settlements_won INTEGER NOT NULL DEFAULT 0,"
        "  poi_income_total REAL NOT NULL DEFAULT 0,"
        "  decay_total REAL NOT NULL DEFAULT 0,"
        "  treasury_at_rollover REAL NOT NULL DEFAULT 0,"
        "  recorded_at INTEGER NOT NULL DEFAULT 0,"
        "  UNIQUE(world_id, season_number, faction_id)"
        ")", nullptr, nullptr, nullptr);
}

std::optional<WorldSeasonRecord> WorldSeasons::CurrentSeason(sqlite3* db,
                                                              const std::string& worldId) {
    if (!db || worldId.empty()) return std::nullopt;
    static const char* kSql =
        "SELECT world_id, season_number, state, started_world_ms, ended_world_ms, "
        "settlement_cursor_start, created_at FROM world_seasons "
        "WHERE world_id=? AND state='active' ORDER BY season_number DESC LIMIT 1";
    sqlite3_stmt* stmt = nullptr;
    if (sqlite3_prepare_v2(db, kSql, -1, &stmt, nullptr) != SQLITE_OK) return std::nullopt;
    BindText(stmt, 1, worldId);
    std::optional<WorldSeasonRecord> out;
    if (sqlite3_step(stmt) == SQLITE_ROW) out = ReadSeasonRow(stmt);
    sqlite3_finalize(stmt);
    return out;
}

std::optional<WorldSeasonRecord> WorldSeasons::SeasonByNumber(sqlite3* db,
                                                               const std::string& worldId,
                                                               int seasonNumber) {
    if (!db || worldId.empty()) return std::nullopt;
    static const char* kSql =
        "SELECT world_id, season_number, state, started_world_ms, ended_world_ms, "
        "settlement_cursor_start, created_at FROM world_seasons "
        "WHERE world_id=? AND season_number=?";
    sqlite3_stmt* stmt = nullptr;
    if (sqlite3_prepare_v2(db, kSql, -1, &stmt, nullptr) != SQLITE_OK) return std::nullopt;
    BindText(stmt, 1, worldId);
    sqlite3_bind_int64(stmt, 2, seasonNumber);
    std::optional<WorldSeasonRecord> out;
    if (sqlite3_step(stmt) == SQLITE_ROW) out = ReadSeasonRow(stmt);
    sqlite3_finalize(stmt);
    return out;
}

std::vector<WorldSeasonRecord> WorldSeasons::SeasonsFor(sqlite3* db,
                                                         const std::string& worldId) {
    std::vector<WorldSeasonRecord> out;
    if (!db || worldId.empty()) return out;
    static const char* kSql =
        "SELECT world_id, season_number, state, started_world_ms, ended_world_ms, "
        "settlement_cursor_start, created_at FROM world_seasons "
        "WHERE world_id=? ORDER BY season_number DESC";
    sqlite3_stmt* stmt = nullptr;
    if (sqlite3_prepare_v2(db, kSql, -1, &stmt, nullptr) != SQLITE_OK) return out;
    BindText(stmt, 1, worldId);
    while (sqlite3_step(stmt) == SQLITE_ROW) out.push_back(ReadSeasonRow(stmt));
    sqlite3_finalize(stmt);
    return out;
}

std::vector<WorldSeasonDigestRecord> WorldSeasons::DigestsFor(sqlite3* db,
                                                               const std::string& worldId,
                                                               int seasonNumber) {
    std::vector<WorldSeasonDigestRecord> out;
    if (!db || worldId.empty()) return out;
    static const char* kSql =
        "SELECT world_id, season_number, faction_id, settlements_won, "
        "poi_income_total, decay_total, treasury_at_rollover, recorded_at "
        "FROM world_season_digests WHERE world_id=? AND season_number=? "
        "ORDER BY faction_id ASC";
    sqlite3_stmt* stmt = nullptr;
    if (sqlite3_prepare_v2(db, kSql, -1, &stmt, nullptr) != SQLITE_OK) return out;
    BindText(stmt, 1, worldId);
    sqlite3_bind_int64(stmt, 2, seasonNumber);
    while (sqlite3_step(stmt) == SQLITE_ROW) {
        WorldSeasonDigestRecord d;
        d.worldId            = ColText(stmt, 0);
        d.seasonNumber        = static_cast<int>(sqlite3_column_int64(stmt, 1));
        d.factionId           = ColText(stmt, 2);
        d.settlementsWon      = static_cast<int>(sqlite3_column_int64(stmt, 3));
        d.poiIncomeTotal       = sqlite3_column_double(stmt, 4);
        d.decayTotal           = sqlite3_column_double(stmt, 5);
        d.treasuryAtRollover   = sqlite3_column_double(stmt, 6);
        d.recordedAt           = sqlite3_column_int64(stmt, 7);
        out.push_back(std::move(d));
    }
    sqlite3_finalize(stmt);
    return out;
}

namespace {

bool InsertSeason(sqlite3* db, const std::string& worldId, int seasonNumber,
                   int64_t startedWorldMs, int64_t settlementCursorStart,
                   int64_t nowRealMs) {
    bool ok = true;
    const bool committed = SqliteWriteTransaction(db, "WorldSeasonOpen", [&] {
        static const char* kSql =
            "INSERT INTO world_seasons "
            "(world_id, season_number, state, started_world_ms, ended_world_ms, "
            "settlement_cursor_start, created_at) "
            "VALUES (?, ?, 'active', ?, 0, ?, ?)";
        sqlite3_stmt* stmt = nullptr;
        if (sqlite3_prepare_v2(db, kSql, -1, &stmt, nullptr) != SQLITE_OK) {
            ok = false;
            return SQLITE_ERROR;
        }
        BindText(stmt, 1, worldId);
        sqlite3_bind_int64(stmt, 2, seasonNumber);
        sqlite3_bind_int64(stmt, 3, startedWorldMs);
        sqlite3_bind_int64(stmt, 4, settlementCursorStart);
        sqlite3_bind_int64(stmt, 5, nowRealMs);
        ok = sqlite3_step(stmt) == SQLITE_DONE;
        sqlite3_finalize(stmt);
        return ok ? SQLITE_OK : SQLITE_ERROR;
    });
    return committed && ok;
}

bool CloseSeason(sqlite3* db, const std::string& worldId, int seasonNumber,
                 int64_t endedWorldMs) {
    bool ok = true;
    const bool committed = SqliteWriteTransaction(db, "WorldSeasonClose", [&] {
        static const char* kSql =
            "UPDATE world_seasons SET state='ended', ended_world_ms=? "
            "WHERE world_id=? AND season_number=?";
        sqlite3_stmt* stmt = nullptr;
        if (sqlite3_prepare_v2(db, kSql, -1, &stmt, nullptr) != SQLITE_OK) {
            ok = false;
            return SQLITE_ERROR;
        }
        sqlite3_bind_int64(stmt, 1, endedWorldMs);
        BindText(stmt, 2, worldId);
        sqlite3_bind_int64(stmt, 3, seasonNumber);
        ok = sqlite3_step(stmt) == SQLITE_DONE;
        sqlite3_finalize(stmt);
        return ok ? SQLITE_OK : SQLITE_ERROR;
    });
    return committed && ok;
}

bool InsertDigest(sqlite3* db, const WorldSeasonDigestRecord& d) {
    bool ok = true;
    const bool committed = SqliteWriteTransaction(db, "WorldSeasonDigest", [&] {
        static const char* kSql =
            "INSERT INTO world_season_digests "
            "(world_id, season_number, faction_id, settlements_won, "
            "poi_income_total, decay_total, treasury_at_rollover, recorded_at) "
            "VALUES (?, ?, ?, ?, ?, ?, ?, ?)";
        sqlite3_stmt* stmt = nullptr;
        if (sqlite3_prepare_v2(db, kSql, -1, &stmt, nullptr) != SQLITE_OK) {
            ok = false;
            return SQLITE_ERROR;
        }
        BindText(stmt, 1, d.worldId);
        sqlite3_bind_int64(stmt, 2, d.seasonNumber);
        BindText(stmt, 3, d.factionId);
        sqlite3_bind_int64(stmt, 4, d.settlementsWon);
        sqlite3_bind_double(stmt, 5, d.poiIncomeTotal);
        sqlite3_bind_double(stmt, 6, d.decayTotal);
        sqlite3_bind_double(stmt, 7, d.treasuryAtRollover);
        sqlite3_bind_int64(stmt, 8, d.recordedAt);
        ok = sqlite3_step(stmt) == SQLITE_DONE;
        sqlite3_finalize(stmt);
        return ok ? SQLITE_OK : SQLITE_ERROR;
    });
    return committed && ok;
}

/// Build and write every digest row for the season that is closing. Read-only
/// against `world_settlement_ledger`/`world_economy_events` (see the header:
/// a rollover never mutates either ledger), then one INSERT per faction/
/// bucket that had anything to record.
void ArchiveSeason(sqlite3* db, const WorldSeasonRecord& closing,
                   int64_t nowWorldMs, int64_t nowRealMs) {
    struct Bucket {
        int    settlementsWon = 0;
        double poiIncomeTotal = 0.0;
        double decayTotal     = 0.0;
    };
    std::map<std::string, Bucket> buckets;  // factionId -> totals; "" = unclaimed

    // Settlements: everything appended since the PREVIOUS season's rollover
    // (the cursor this season opened with) — see the header for why a
    // row-order cursor is used instead of a world-ms window.
    for (const auto& s : WorldDirector::SettlementsFor(db, closing.worldId)) {
        if (s.settlementId <= closing.settlementCursorStart) continue;
        const auto winners = SplitFactions(s.factions);
        if (winners.empty()) {
            buckets[""].settlementsWon += 1;  // unclaimed — no in-sim winner
            continue;
        }
        for (const auto& f : winners)
            buckets[f].settlementsWon += 1;
    }

    // Economy: `world_ms` is exact (the tick's own `nowWorldMs`), so the
    // season's window needs no cursor — just the season's own started/now
    // bound. One faction at a time, the same iteration WorldStats::RankFor
    // and WorldEconomy::EconomyJson already use.
    for (const auto& f : WorldFactions::ListFor(db, closing.worldId)) {
        for (const auto& ev : WorldEconomy::EventsFor(db, closing.worldId, f.factionId)) {
            if (ev.worldMs <= closing.startedWorldMs || ev.worldMs > nowWorldMs) continue;
            auto& b = buckets[f.factionId];
            if (ev.source == "poi_income") b.poiIncomeTotal += ev.delta;
            else if (ev.source == "decay") b.decayTotal += ev.delta;
        }
        // Ensure every faction gets a row even with zero activity — the
        // digest is a per-season census, not a diff of nonzero movers.
        buckets[f.factionId];
    }

    for (const auto& [factionId, b] : buckets) {
        WorldSeasonDigestRecord d;
        d.worldId          = closing.worldId;
        d.seasonNumber      = closing.seasonNumber;
        d.factionId         = factionId;
        d.settlementsWon    = b.settlementsWon;
        d.poiIncomeTotal    = b.poiIncomeTotal;
        d.decayTotal        = b.decayTotal;
        // A snapshot read, taken AFTER the season's own economy events have
        // all been priced (W9's tick already ran this pass, same lobby loop
        // iteration) — never a write, per the header's "no balance changes".
        d.treasuryAtRollover = factionId.empty()
                                    ? 0.0
                                    : WorldEconomy::TreasuryFor(db, closing.worldId, factionId);
        d.recordedAt         = nowRealMs;
        InsertDigest(db, d);
    }
}

int64_t MaxSettlementId(sqlite3* db, const std::string& worldId) {
    int64_t maxId = 0;
    for (const auto& s : WorldDirector::SettlementsFor(db, worldId))
        maxId = std::max(maxId, s.settlementId);
    return maxId;
}

}  // namespace

WorldSeasons::TickResult WorldSeasons::Tick(sqlite3* db, const std::string& worldId,
                                            const WorldSeasonRules& rules,
                                            int64_t nowWorldMs, int64_t nowRealMs) {
    TickResult result;
    if (!db || worldId.empty()) return result;

    const auto current = CurrentSeason(db, worldId);
    if (!current) {
        // First contact — open season 1 anchored HERE, not backdated. A world
        // ticked for the first time long after it was founded must not owe a
        // season's worth of retroactive length (same rule W9's cursor-plant
        // uses for the economic tick).
        InsertSeason(db, worldId, /*seasonNumber=*/1, nowWorldMs,
                    /*settlementCursorStart=*/0, nowRealMs);
        return result;
    }

    const int64_t elapsed = nowWorldMs - current->startedWorldMs;
    if (elapsed < static_cast<int64_t>(rules.seasonLengthWorldMs)) return result;
    // A `nowWorldMs` at or before the season's start cannot happen here (a
    // paused world's worldMs does not move at all, so `elapsed` would be 0,
    // already caught above) — no separate pause guard is needed.

    ArchiveSeason(db, *current, nowWorldMs, nowRealMs);
    CloseSeason(db, worldId, current->seasonNumber, nowWorldMs);

    const int64_t cursorForNext = MaxSettlementId(db, worldId);
    const int nextSeasonNumber = current->seasonNumber + 1;
    InsertSeason(db, worldId, nextSeasonNumber, nowWorldMs, cursorForNext, nowRealMs);

    result.rolledOver         = true;
    result.endedSeasonNumber   = current->seasonNumber;
    result.newSeasonNumber     = nextSeasonNumber;
    return result;
}

nlohmann::json WorldSeasons::AttachSeasonStatus(nlohmann::json worldStatusJson, sqlite3* db,
                                                const std::string& worldId,
                                                const WorldSeasonRules& rules,
                                                int64_t nowWorldMs) {
    const auto current = CurrentSeason(db, worldId);
    nlohmann::json season;
    if (!current) {
        // Legal: a world nobody has ticked yet (this build's own tick loop
        // fires on the same cadence as W9/W10's, so this is a narrow window
        // right after a fresh boot, not a steady-state answer).
        season = nullptr;
    } else {
        season["number"]         = current->seasonNumber;
        season["startedWorldMs"] = current->startedWorldMs;
        const int64_t endsWorldMs = current->startedWorldMs +
                                    static_cast<int64_t>(rules.seasonLengthWorldMs);
        season["endsWorldMs"]    = endsWorldMs;
        season["lengthWorldMs"]  = static_cast<int64_t>(rules.seasonLengthWorldMs);
        season["remainingWorldMs"] = std::max<int64_t>(0, endsWorldMs - nowWorldMs);
    }
    worldStatusJson["season"] = std::move(season);
    return worldStatusJson;
}

namespace {

nlohmann::json SeasonRowJson(const WorldSeasonRecord& s) {
    nlohmann::json j;
    j["number"]         = s.seasonNumber;
    j["state"]          = s.state;
    j["seasonId"]       = WorldSeasonIdFor(s.worldId, s.seasonNumber);
    j["startedWorldMs"] = s.startedWorldMs;
    // 0 while active — the row's own truth, not a projection: `endsWorldMs`
    // (the projected boundary) already lives on `/api/world`'s season attach,
    // where the rules are in hand. The archive reports what HAPPENED.
    j["endedWorldMs"]   = s.endedWorldMs;
    return j;
}

}  // namespace

nlohmann::json WorldSeasons::SeasonsIndexJson(sqlite3* db, const std::string& worldId) {
    nlohmann::json body;
    body["worldId"] = worldId;
    nlohmann::json arr = nlohmann::json::array();
    for (const auto& s : SeasonsFor(db, worldId)) arr.push_back(SeasonRowJson(s));
    body["seasons"] = std::move(arr);
    return body;
}

nlohmann::json WorldSeasons::SeasonArchiveJson(sqlite3* db, const std::string& worldId,
                                               int seasonNumber) {
    const auto season = SeasonByNumber(db, worldId, seasonNumber);
    if (!season) {
        nlohmann::json err;
        err["error"] = "no_such_season";
        return err;
    }
    nlohmann::json body;
    body["worldId"] = worldId;
    body["season"]  = SeasonRowJson(*season);
    nlohmann::json digests = nlohmann::json::array();
    for (const auto& d : DigestsFor(db, worldId, seasonNumber)) {
        nlohmann::json j;
        // Empty faction id = the unclaimed bucket; serialised as null so a
        // client cannot mistake it for a faction whose id is "".
        j["factionId"]          = d.factionId.empty()
                                      ? nlohmann::json(nullptr)
                                      : nlohmann::json(d.factionId);
        j["settlementsWon"]     = d.settlementsWon;
        j["poiIncomeTotal"]     = d.poiIncomeTotal;
        j["decayTotal"]         = d.decayTotal;
        j["treasuryAtRollover"] = d.treasuryAtRollover;
        digests.push_back(std::move(j));
    }
    body["digests"] = std::move(digests);
    return body;
}

std::string WorldSeasonIdFor(const std::string& worldId, int seasonNumber) {
    std::ostringstream os;
    os << worldId << "/season-" << seasonNumber;
    return os.str();
}

std::string WorldSeasonHeadline(int endedSeasonNumber, int newSeasonNumber) {
    std::ostringstream os;
    os << "Season " << endedSeasonNumber << " has ended. Season " << newSeasonNumber
       << " begins.";
    return os.str();
}
