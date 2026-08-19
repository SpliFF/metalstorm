#include "WorldStats.h"

#include <sqlite3.h>

#include <algorithm>
#include <cctype>
#include <cmath>

#include "SqliteThreading.h"
#include "WorldFactions.h"

namespace {

constexpr double kMsPerHour = 3600.0 * 1000.0;
constexpr double kMsPerDay  = 24.0 * kMsPerHour;

void BindText(sqlite3_stmt* s, int idx, const std::string& v) {
    sqlite3_bind_text(s, idx, v.c_str(), -1, SQLITE_TRANSIENT);
}

std::string ColText(sqlite3_stmt* s, int idx) {
    if (const unsigned char* u = sqlite3_column_text(s, idx))
        return reinterpret_cast<const char*>(u);
    return {};
}

nlohmann::json ParseConfig(const std::string& raw) {
    if (raw.empty()) return nlohmann::json::object();
    nlohmann::json j = nlohmann::json::parse(raw, nullptr, /*allow_exceptions=*/false);
    if (j.is_discarded() || !j.is_object()) return nlohmann::json::object();
    return j;
}

/// Per-key fallback, never whole-blob — same rule and same reason as
/// WorldFactions.cpp's copy: a world tuned before W8 has exactly the keys it
/// was tuned with, and a missing key must not turn its rule off.
double CfgDouble(const nlohmann::json& j, const char* key, double fallback) {
    if (!j.is_object()) return fallback;
    const auto it = j.find(key);
    if (it == j.end() || !it->is_number()) return fallback;
    return it->get<double>();
}

const char* kCommanderColumns =
    "world_id, commander_id, name, account_id, loaned_to_account_id, faction_id, "
    "poi_id, state, authority, authority_at_world_ms, created_at, config_json";

WorldCommanderRecord ReadCommanderRow(sqlite3_stmt* s) {
    WorldCommanderRecord c;
    c.worldId            = ColText(s, 0);
    c.commanderId        = ColText(s, 1);
    c.name               = ColText(s, 2);
    c.accountId          = sqlite3_column_int64(s, 3);
    c.loanedToAccountId  = sqlite3_column_int64(s, 4);
    c.factionId          = ColText(s, 5);
    c.poiId              = ColText(s, 6);
    c.state              = ColText(s, 7);
    c.authority          = sqlite3_column_double(s, 8);
    c.authorityAtWorldMs = sqlite3_column_int64(s, 9);
    c.createdAt          = sqlite3_column_int64(s, 10);
    c.config             = ParseConfig(ColText(s, 11));
    return c;
}

std::vector<WorldCommanderRecord> QueryCommanders(sqlite3* db, const char* sql,
                                                  const std::string& worldId,
                                                  const std::string& text2,
                                                  int64_t int2) {
    std::vector<WorldCommanderRecord> out;
    if (!db || worldId.empty()) return out;
    sqlite3_stmt* stmt = nullptr;
    if (sqlite3_prepare_v2(db, sql, -1, &stmt, nullptr) != SQLITE_OK) return out;
    BindText(stmt, 1, worldId);
    if (!text2.empty()) BindText(stmt, 2, text2);
    else if (int2 != 0)  sqlite3_bind_int64(stmt, 2, int2);
    while (sqlite3_step(stmt) == SQLITE_ROW)
        out.push_back(ReadCommanderRow(stmt));
    sqlite3_finalize(stmt);
    return out;
}

/// A commander id out of a username: the same slug rule faction names use, so
/// the two id spaces read alike, plus an ordinal because a player holds many.
std::string CommanderIdFor(sqlite3* db, const std::string& worldId,
                           int64_t accountId, const std::string& username) {
    std::string base = SlugifyFactionName(username);
    if (base.empty()) base = "cmdr-" + std::to_string(accountId);
    for (int n = 1; n < 1000; ++n) {
        const std::string id = base + "-" + std::to_string(n);
        if (!WorldStats::LoadCommander(db, worldId, id)) return id;
    }
    return {};
}

}  // namespace

// ─────────────────────────── the per-world rates ───────────────────────────

WorldStatRules WorldStatRules::FromWorldConfig(const nlohmann::json& c) {
    WorldStatRules r;
    r.authorityPerVictory        = CfgDouble(c, "authorityPerVictory",        r.authorityPerVictory);
    r.authorityPerDefeat         = CfgDouble(c, "authorityPerDefeat",         r.authorityPerDefeat);
    r.authorityDecayPerWorldDay  = CfgDouble(c, "authorityDecayPerWorldDay",  r.authorityDecayPerWorldDay);
    r.authorityFloor             = CfgDouble(c, "authorityFloor",             r.authorityFloor);
    r.commanderGrantAuthority    = CfgDouble(c, "commanderGrantAuthority",    r.commanderGrantAuthority);
    r.capacityBase               = CfgDouble(c, "capacityBase",               r.capacityBase);
    r.capacityPerCommanderAuthority =
        CfgDouble(c, "capacityPerCommanderAuthority", r.capacityPerCommanderAuthority);
    r.capacityRechargeHours      = CfgDouble(c, "capacityRechargeHours",      r.capacityRechargeHours);
    r.capacityRechargeFraction   = CfgDouble(c, "capacityRechargeFraction",   r.capacityRechargeFraction);
    r.rankPerCommander           = CfgDouble(c, "rankPerCommander",           r.rankPerCommander);
    r.rankPerCommanderAuthority  = CfgDouble(c, "rankPerCommanderAuthority",  r.rankPerCommanderAuthority);
    r.rankPerPoiHeld             = CfgDouble(c, "rankPerPoiHeld",             r.rankPerPoiHeld);
    r.rankPerArtifact            = CfgDouble(c, "rankPerArtifact",            r.rankPerArtifact);
    r.rankPerMoney               = CfgDouble(c, "rankPerMoney",               r.rankPerMoney);
    r.rankPerResource            = CfgDouble(c, "rankPerResource",            r.rankPerResource);
    r.rankPerUnit                = CfgDouble(c, "rankPerUnit",                r.rankPerUnit);
    return r;
}

// ─────────────────────────── pure policy ───────────────────────────────────

double DecayAuthority(double value, int64_t elapsedWorldMs, const WorldStatRules& rules) {
    if (elapsedWorldMs <= 0) return value;
    const double rate = rules.authorityDecayPerWorldDay;
    if (rate <= 0.0) return value;
    // A rate at or above 1.0 would mean "all of it, per day", which pow()
    // turns into zero at any elapsed time — clamped so a mis-tuned world
    // decays fast rather than annihilating every commander on the first read.
    const double retain = std::max(0.0, 1.0 - std::min(rate, 0.99));
    const double days   = static_cast<double>(elapsedWorldMs) / kMsPerDay;
    const double decayed = value * std::pow(retain, days);
    // The floor never RAISES a value: a commander below it (a fresh grant with
    // a small award) keeps what it has.
    return decayed < rules.authorityFloor ? std::min(value, rules.authorityFloor) : decayed;
}

double CommanderAuthorityAt(const WorldCommanderRecord& c, int64_t nowWorldMs,
                            const WorldStatRules& rules) {
    // An unstamped row (0) is one written before W8 stamped them, or by a
    // caller that did not know the clock. Treated as "as of now" rather than
    // "as of the world epoch", because the alternative silently decays every
    // such row by the world's whole age.
    if (c.authorityAtWorldMs <= 0) return c.authority;
    return DecayAuthority(c.authority, nowWorldMs - c.authorityAtWorldMs, rules);
}

bool SettlementNamesFaction(const std::string& factions, const std::string& factionId) {
    if (factions.empty() || factionId.empty()) return false;
    size_t at = 0;
    while (at <= factions.size()) {
        const size_t comma = factions.find(',', at);
        const size_t end = comma == std::string::npos ? factions.size() : comma;
        // Trim: the war layer joins winner ids with ", " in places and "," in
        // others, and a leading space would make a member look like a loser.
        size_t b = at, e = end;
        while (b < e && std::isspace(static_cast<unsigned char>(factions[b]))) ++b;
        while (e > b && std::isspace(static_cast<unsigned char>(factions[e - 1]))) --e;
        if (factions.compare(b, e - b, factionId) == 0) return true;
        if (comma == std::string::npos) break;
        at = comma + 1;
    }
    return false;
}

std::vector<WorldAuthorityAttribution> AttributeSettlement(
    const WorldSettlementRecord& settlement,
    const std::vector<WorldCommanderRecord>& commandersAtPoi,
    const WorldStatRules& rules) {
    std::vector<WorldAuthorityAttribution> out;
    for (const auto& c : commandersAtPoi) {
        if (c.state != "active") continue;
        if (c.poiId != settlement.poiId) continue;
        // See the header: no harvesting history. `>=` rather than `>` so a
        // commander granted in the same millisecond a war settled (the
        // in-memory-test case, and a plausible real one) is included.
        if (settlement.recordedAt < c.createdAt) continue;
        const bool won = SettlementNamesFaction(settlement.factions, c.factionId);
        const double delta = won ? rules.authorityPerVictory : rules.authorityPerDefeat;
        if (delta == 0.0) continue;
        out.push_back({c.commanderId, delta, won ? "victory" : "defeat"});
    }
    return out;
}

double CapacityCeiling(double heldCommanderAuthority, const WorldStatRules& rules) {
    const double from = std::max(0.0, heldCommanderAuthority) *
                        rules.capacityPerCommanderAuthority;
    return std::max(0.0, rules.capacityBase + from);
}

WorldCapacityLedger NormalizeCapacity(double spent, int64_t rechargedAtRealMs, double max,
                                      const WorldStatRules& rules, int64_t nowRealMs) {
    WorldCapacityLedger out;
    out.spent = std::max(0.0, spent);
    out.rechargedAt = rechargedAtRealMs;
    // A row that has never recharged starts its first period now. Written back
    // (changed = true) so the period is anchored to a real instant rather than
    // being re-anchored on every read.
    if (out.rechargedAt <= 0) {
        out.rechargedAt = nowRealMs;
        out.changed = true;
        return out;
    }
    const double periodMs = std::max(1.0, rules.capacityRechargeHours * kMsPerHour);
    const int64_t elapsed = nowRealMs - out.rechargedAt;
    if (elapsed < static_cast<int64_t>(periodMs)) return out;
    const int64_t periods = static_cast<int64_t>(static_cast<double>(elapsed) / periodMs);
    const double refund = static_cast<double>(periods) * max *
                          std::max(0.0, rules.capacityRechargeFraction);
    const double next = std::max(0.0, out.spent - refund);
    // Advance by whole periods only: dropping the remainder would let a player
    // who reads their panel every 25 hours drift their recharge time forward
    // an hour a day.
    out.rechargedAt += static_cast<int64_t>(static_cast<double>(periods) * periodMs);
    if (next != out.spent || periods > 0) out.changed = true;
    out.spent = next;
    return out;
}

WorldCapacityState CapacityStateFrom(const WorldCapacityLedger& ledger, double max,
                                     const WorldStatRules& rules, int64_t nowRealMs) {
    WorldCapacityState s;
    s.max = max;
    s.spent = std::min(std::max(0.0, ledger.spent), max);
    s.available = std::max(0.0, max - s.spent);
    s.rechargedAt = ledger.rechargedAt;
    const double periodMs = std::max(1.0, rules.capacityRechargeHours * kMsPerHour);
    const int64_t due = ledger.rechargedAt + static_cast<int64_t>(periodMs);
    s.nextRechargeInMs = std::max<int64_t>(0, due - nowRealMs);
    return s;
}

nlohmann::json WorldRankBreakdown::ToJson() const {
    nlohmann::json j;
    j["total"] = total;
    j["commanderCount"] = commanderCount;
    j["poiCount"] = poiCount;
    j["loanedCount"] = loanedCount;
    nlohmann::json terms;
    terms["commanders"]         = commanders;
    terms["commanderAuthority"] = commanderAuthority;
    terms["regions"]            = regions;
    terms["money"]              = money;
    terms["resources"]          = resources;
    terms["units"]              = units;
    terms["artifacts"]          = artifacts;
    j["terms"] = std::move(terms);
    return j;
}

WorldRankBreakdown ComputeRank(const std::vector<WorldCommanderRecord>& commanders,
                               int poisHeld, const WorldHoldings& holdings,
                               const WorldStatRules& rules, int64_t nowWorldMs) {
    WorldRankBreakdown r;
    for (const auto& c : commanders) {
        if (!c.CountsForRank()) {
            if (c.loanedToAccountId != 0) ++r.loanedCount;
            continue;
        }
        ++r.commanderCount;
        r.commanders += rules.rankPerCommander;
        r.commanderAuthority +=
            CommanderAuthorityAt(c, nowWorldMs, rules) * rules.rankPerCommanderAuthority;
    }
    r.poiCount   = std::max(0, poisHeld);
    r.regions    = r.poiCount * rules.rankPerPoiHeld;
    r.money      = holdings.money * rules.rankPerMoney;
    r.resources  = holdings.resources * rules.rankPerResource;
    r.units      = holdings.units * rules.rankPerUnit;
    r.artifacts  = holdings.artifacts * rules.rankPerArtifact;
    r.total = r.commanders + r.commanderAuthority + r.regions + r.money +
              r.resources + r.units + r.artifacts;
    return r;
}

// ─────────────────────────── the store ────────────────────────────────────

void WorldStats::EnsureTables(sqlite3* db) {
    if (!db) return;
    sqlite3_exec(db,
        "CREATE TABLE IF NOT EXISTS world_commanders ("
        "  world_id TEXT NOT NULL,"
        "  commander_id TEXT NOT NULL,"
        "  name TEXT NOT NULL DEFAULT '',"
        "  account_id INTEGER NOT NULL DEFAULT 0,"
        // 0 = not on loan. C27's exclusion is read off this column.
        "  loaned_to_account_id INTEGER NOT NULL DEFAULT 0,"
        "  faction_id TEXT NOT NULL DEFAULT '',"
        "  poi_id TEXT NOT NULL DEFAULT '',"
        "  state TEXT NOT NULL DEFAULT 'active',"
        "  authority REAL NOT NULL DEFAULT 0,"
        // WORLD ms: decay is world time, so a pause stops it.
        "  authority_at_world_ms INTEGER NOT NULL DEFAULT 0,"
        "  created_at INTEGER NOT NULL DEFAULT 0,"
        "  config_json TEXT NOT NULL DEFAULT '{}',"
        "  PRIMARY KEY (world_id, commander_id)"
        ")", nullptr, nullptr, nullptr);

    sqlite3_exec(db,
        "CREATE TABLE IF NOT EXISTS world_authority_events ("
        "  world_id TEXT NOT NULL,"
        "  commander_id TEXT NOT NULL,"
        "  source TEXT NOT NULL DEFAULT '',"
        "  source_key TEXT NOT NULL DEFAULT '',"
        "  delta REAL NOT NULL DEFAULT 0,"
        "  reason TEXT NOT NULL DEFAULT '',"
        "  world_ms INTEGER NOT NULL DEFAULT 0,"
        "  recorded_at INTEGER NOT NULL DEFAULT 0"
        ")", nullptr, nullptr, nullptr);
    // THE idempotence key (see the header). A UNIQUE INDEX rather than a
    // primary key because the table is append-only history and its natural
    // order is insertion order, not this tuple.
    sqlite3_exec(db,
        "CREATE UNIQUE INDEX IF NOT EXISTS idx_world_authority_events_once "
        "ON world_authority_events(world_id, commander_id, source, source_key)",
        nullptr, nullptr, nullptr);

    // The garrison query and the "my commanders" query, neither of which the
    // primary key can serve.
    sqlite3_exec(db,
        "CREATE INDEX IF NOT EXISTS idx_world_commanders_poi "
        "ON world_commanders(world_id, poi_id)", nullptr, nullptr, nullptr);
    sqlite3_exec(db,
        "CREATE INDEX IF NOT EXISTS idx_world_commanders_account "
        "ON world_commanders(world_id, account_id)", nullptr, nullptr, nullptr);

    // W7's per-account row gains the two columns a BUDGET needs on top of the
    // `capacity` value it already had. ALTER TABLE ADD COLUMN errors when the
    // column is already there, which on a current schema is the expected
    // outcome and is ignored — the same shape every other add-a-column
    // migration in this tree uses (GameStateStore.cpp, WarDirector.cpp).
    WorldFactions::EnsureTables(db);
    sqlite3_exec(db,
        "ALTER TABLE world_authority ADD COLUMN capacity_spent REAL NOT NULL DEFAULT 0",
        nullptr, nullptr, nullptr);
    sqlite3_exec(db,
        "ALTER TABLE world_authority ADD COLUMN capacity_recharged_at INTEGER NOT NULL DEFAULT 0",
        nullptr, nullptr, nullptr);
}

bool WorldStats::UpsertCommander(sqlite3* db, const WorldCommanderRecord& c) {
    if (!db || c.worldId.empty() || c.commanderId.empty()) return false;
    bool ok = true;
    const bool committed = SqliteWriteTransaction(db, "WorldCommanderUpsert", [&] {
        static const char* kSql =
            "INSERT INTO world_commanders (world_id, commander_id, name, account_id,"
            "                              loaned_to_account_id, faction_id, poi_id,"
            "                              state, authority, authority_at_world_ms,"
            "                              created_at, config_json) "
            "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) "
            "ON CONFLICT(world_id, commander_id) DO UPDATE SET "
            "  name=excluded.name, account_id=excluded.account_id,"
            "  loaned_to_account_id=excluded.loaned_to_account_id,"
            "  faction_id=excluded.faction_id, poi_id=excluded.poi_id,"
            "  state=excluded.state, authority=excluded.authority,"
            "  authority_at_world_ms=excluded.authority_at_world_ms,"
            "  config_json=excluded.config_json";
        // created_at is NOT updated: a commander is minted once, and
        // attribution uses that instant as its floor.
        sqlite3_stmt* stmt = nullptr;
        if (sqlite3_prepare_v2(db, kSql, -1, &stmt, nullptr) != SQLITE_OK) {
            ok = false;
            return SQLITE_ERROR;
        }
        BindText(stmt, 1, c.worldId);
        BindText(stmt, 2, c.commanderId);
        BindText(stmt, 3, c.name);
        sqlite3_bind_int64(stmt, 4, c.accountId);
        sqlite3_bind_int64(stmt, 5, c.loanedToAccountId);
        BindText(stmt, 6, c.factionId);
        BindText(stmt, 7, c.poiId);
        BindText(stmt, 8, c.state);
        sqlite3_bind_double(stmt, 9, c.authority);
        sqlite3_bind_int64(stmt, 10, c.authorityAtWorldMs);
        sqlite3_bind_int64(stmt, 11, c.createdAt);
        BindText(stmt, 12, c.config.dump());
        ok = sqlite3_step(stmt) == SQLITE_DONE;
        sqlite3_finalize(stmt);
        return ok ? SQLITE_OK : SQLITE_ERROR;
    });
    return committed && ok;
}

std::optional<WorldCommanderRecord> WorldStats::LoadCommander(
    sqlite3* db, const std::string& worldId, const std::string& commanderId) {
    if (!db || worldId.empty() || commanderId.empty()) return std::nullopt;
    const std::string sql = std::string("SELECT ") + kCommanderColumns +
                            " FROM world_commanders WHERE world_id=? AND commander_id=?";
    sqlite3_stmt* stmt = nullptr;
    if (sqlite3_prepare_v2(db, sql.c_str(), -1, &stmt, nullptr) != SQLITE_OK)
        return std::nullopt;
    BindText(stmt, 1, worldId);
    BindText(stmt, 2, commanderId);
    std::optional<WorldCommanderRecord> out;
    if (sqlite3_step(stmt) == SQLITE_ROW) out = ReadCommanderRow(stmt);
    sqlite3_finalize(stmt);
    return out;
}

std::vector<WorldCommanderRecord> WorldStats::CommandersFor(sqlite3* db,
                                                           const std::string& worldId) {
    const std::string sql = std::string("SELECT ") + kCommanderColumns +
                            " FROM world_commanders WHERE world_id=? "
                            "ORDER BY commander_id ASC";
    return QueryCommanders(db, sql.c_str(), worldId, {}, 0);
}

std::vector<WorldCommanderRecord> WorldStats::CommandersOwnedBy(
    sqlite3* db, const std::string& worldId, int64_t accountId) {
    if (accountId <= 0) return {};
    const std::string sql = std::string("SELECT ") + kCommanderColumns +
                            " FROM world_commanders WHERE world_id=? AND account_id=? "
                            "ORDER BY commander_id ASC";
    return QueryCommanders(db, sql.c_str(), worldId, {}, accountId);
}

std::vector<WorldCommanderRecord> WorldStats::CommandersAtPoi(
    sqlite3* db, const std::string& worldId, const std::string& poiId) {
    if (poiId.empty()) return {};
    const std::string sql = std::string("SELECT ") + kCommanderColumns +
                            " FROM world_commanders WHERE world_id=? AND poi_id=? "
                            "AND state='active' ORDER BY commander_id ASC";
    return QueryCommanders(db, sql.c_str(), worldId, poiId, 0);
}

std::optional<WorldCommanderRecord> WorldStats::GrantCommander(
    sqlite3* db, const std::string& worldId, int64_t accountId,
    const std::string& username, const std::string& factionId,
    const std::string& poiId, double authority, int64_t nowRealMs,
    int64_t nowWorldMs) {
    if (!db || worldId.empty() || accountId <= 0) return std::nullopt;
    WorldCommanderRecord c;
    c.worldId     = worldId;
    c.commanderId = CommanderIdFor(db, worldId, accountId, username);
    if (c.commanderId.empty()) return std::nullopt;
    // The display name is the player's for now. Generated officer names come
    // out of the archetype's naming register (WorldFactions.h's
    // `nameRegister`) when name generation exists; until then a commander the
    // player recognises beats a placeholder they do not.
    c.name               = username.empty() ? c.commanderId : username;
    c.accountId          = accountId;
    c.factionId          = factionId;
    c.poiId              = poiId;
    c.authority          = std::max(0.0, authority);
    c.authorityAtWorldMs = nowWorldMs;
    c.createdAt          = nowRealMs;
    if (!UpsertCommander(db, c)) return std::nullopt;
    return c;
}

std::optional<WorldCommanderRecord> WorldStats::EnsureStarterCommander(
    sqlite3* db, const std::string& worldId, int64_t accountId,
    const std::string& username, double worldAuthority,
    const WorldStatRules& rules, int64_t nowRealMs, int64_t nowWorldMs) {
    if (!db || worldId.empty() || accountId <= 0) return std::nullopt;
    if (worldAuthority < rules.commanderGrantAuthority) return std::nullopt;
    // "Never a second one this way": the check is on ANY row this account has
    // ever owned, not on live ones, so a player whose commander died does not
    // get a free replacement out of the on-ramp.
    if (!CommandersOwnedBy(db, worldId, accountId).empty()) return std::nullopt;
    std::string factionId, poiId;
    if (const auto m = WorldFactions::MembershipFor(db, worldId, accountId)) {
        factionId = m->factionId;
        // Station them where their faction already stands, if anywhere: a
        // commander with no POI is a commander no war can ever attribute to.
        for (const auto& p : WorldDirector::PoisFor(db, worldId)) {
            if (p.ownerFactionId == m->factionId) { poiId = p.poiId; break; }
        }
    }
    // The starter's authority is the floor rather than zero: the floor is the
    // value decay converges to, so starting below it would make a new
    // commander briefly worth less than an abandoned one.
    return GrantCommander(db, worldId, accountId, username, factionId, poiId,
                          rules.authorityFloor, nowRealMs, nowWorldMs);
}

// ── authority accrual ──────────────────────────────────────────────────────

bool WorldStats::AwardAuthority(sqlite3* db, const WorldAuthorityEventRecord& e,
                                const WorldStatRules& rules) {
    if (!db || e.worldId.empty() || e.commanderId.empty()) return false;
    const auto c = LoadCommander(db, e.worldId, e.commanderId);
    if (!c) return false;
    bool ok = true;
    bool duplicate = false;
    const bool committed = SqliteWriteTransaction(db, "WorldAwardAuthority", [&] {
        static const char* kInsert =
            "INSERT INTO world_authority_events "
            "(world_id, commander_id, source, source_key, delta, reason, world_ms, recorded_at) "
            "VALUES (?, ?, ?, ?, ?, ?, ?, ?)";
        sqlite3_stmt* stmt = nullptr;
        if (sqlite3_prepare_v2(db, kInsert, -1, &stmt, nullptr) != SQLITE_OK) {
            ok = false;
            return SQLITE_ERROR;
        }
        BindText(stmt, 1, e.worldId);
        BindText(stmt, 2, e.commanderId);
        BindText(stmt, 3, e.source);
        BindText(stmt, 4, e.sourceKey);
        sqlite3_bind_double(stmt, 5, e.delta);
        BindText(stmt, 6, e.reason);
        sqlite3_bind_int64(stmt, 7, e.worldMs);
        sqlite3_bind_int64(stmt, 8, e.recordedAt);
        const int rc = sqlite3_step(stmt);
        sqlite3_finalize(stmt);
        if (rc != SQLITE_DONE) {
            // The UNIQUE index refusing the row is the idempotence working,
            // not a failure: SQLITE_ABORT rolls back silently.
            duplicate = true;
            return SQLITE_ABORT;
        }
        // Roll the award into the stored value: decay what was there to now
        // FIRST, then add, then stamp. Adding before decaying would decay the
        // award itself for the time the commander was idle before earning it.
        WorldCommanderRecord updated = *c;
        updated.authority = std::max(0.0, CommanderAuthorityAt(*c, e.worldMs, rules) + e.delta);
        updated.authorityAtWorldMs = e.worldMs;
        static const char* kUpdate =
            "UPDATE world_commanders SET authority=?, authority_at_world_ms=? "
            "WHERE world_id=? AND commander_id=?";
        sqlite3_stmt* u = nullptr;
        if (sqlite3_prepare_v2(db, kUpdate, -1, &u, nullptr) != SQLITE_OK) {
            ok = false;
            return SQLITE_ERROR;
        }
        sqlite3_bind_double(u, 1, updated.authority);
        sqlite3_bind_int64(u, 2, updated.authorityAtWorldMs);
        BindText(u, 3, updated.worldId);
        BindText(u, 4, updated.commanderId);
        ok = sqlite3_step(u) == SQLITE_DONE;
        sqlite3_finalize(u);
        return ok ? SQLITE_OK : SQLITE_ERROR;
    });
    if (duplicate) return false;
    return committed && ok;
}

int WorldStats::AccrueFromSettlements(sqlite3* db, const std::string& worldId,
                                      const WorldStatRules& rules,
                                      int64_t nowRealMs, int64_t nowWorldMs) {
    if (!db || worldId.empty()) return 0;
    const auto settlements = WorldDirector::SettlementsFor(db, worldId);
    if (settlements.empty()) return 0;
    const auto commanders = CommandersFor(db, worldId);
    if (commanders.empty()) return 0;
    int applied = 0;
    for (const auto& s : settlements) {
        // The pure rule decides; this loop only supplies rows and persists
        // verdicts. `commanders` is passed whole rather than re-queried per
        // POI because a world's commander roster is small and one read beats
        // one query per settlement row.
        for (const auto& award : AttributeSettlement(s, commanders, rules)) {
            WorldAuthorityEventRecord e;
            e.worldId     = worldId;
            e.commanderId = award.commanderId;
            e.source      = "settlement";
            // The ledger row's own id: two identical wars at one POI are two
            // awards, and a re-run of either is none.
            e.sourceKey   = std::to_string(s.settlementId);
            e.delta       = award.delta;
            e.reason      = award.reason;
            e.worldMs     = nowWorldMs;
            e.recordedAt  = nowRealMs;
            if (AwardAuthority(db, e, rules)) ++applied;
        }
    }
    return applied;
}

std::vector<WorldAuthorityEventRecord> WorldStats::EventsFor(
    sqlite3* db, const std::string& worldId, const std::string& commanderId) {
    std::vector<WorldAuthorityEventRecord> out;
    if (!db || worldId.empty()) return out;
    static const char* kSql =
        "SELECT world_id, commander_id, source, source_key, delta, reason, world_ms, recorded_at "
        "FROM world_authority_events WHERE world_id=? AND commander_id=? "
        "ORDER BY rowid ASC";
    sqlite3_stmt* stmt = nullptr;
    if (sqlite3_prepare_v2(db, kSql, -1, &stmt, nullptr) != SQLITE_OK) return out;
    BindText(stmt, 1, worldId);
    BindText(stmt, 2, commanderId);
    while (sqlite3_step(stmt) == SQLITE_ROW) {
        WorldAuthorityEventRecord e;
        e.worldId     = ColText(stmt, 0);
        e.commanderId = ColText(stmt, 1);
        e.source      = ColText(stmt, 2);
        e.sourceKey   = ColText(stmt, 3);
        e.delta       = sqlite3_column_double(stmt, 4);
        e.reason      = ColText(stmt, 5);
        e.worldMs     = sqlite3_column_int64(stmt, 6);
        e.recordedAt  = sqlite3_column_int64(stmt, 7);
        out.push_back(std::move(e));
    }
    sqlite3_finalize(stmt);
    return out;
}

// ── capacity ───────────────────────────────────────────────────────────────

namespace {

/// The player's own authority sum: their HELD commanders, decayed to now. Not
/// their loaned-out ones — a commander somebody else is commanding does not
/// widen the lender's order budget any more than it raises their rank.
double HeldAuthoritySum(sqlite3* db, const std::string& worldId, int64_t accountId,
                        const WorldStatRules& rules, int64_t nowWorldMs) {
    double sum = 0.0;
    for (const auto& c : WorldStats::CommandersOwnedBy(db, worldId, accountId)) {
        if (!c.CountsForRank()) continue;
        sum += CommanderAuthorityAt(c, nowWorldMs, rules);
    }
    return sum;
}

/// Read W8's two capacity columns off W7's row. Returns false when the account
/// has no row yet — the caller decides whether that is a fresh budget or an
/// error (it is a fresh budget).
bool ReadCapacityRow(sqlite3* db, const std::string& worldId, int64_t accountId,
                     double& spent, int64_t& rechargedAt) {
    static const char* kSql =
        "SELECT capacity_spent, capacity_recharged_at FROM world_authority "
        "WHERE world_id=? AND account_id=?";
    sqlite3_stmt* stmt = nullptr;
    if (sqlite3_prepare_v2(db, kSql, -1, &stmt, nullptr) != SQLITE_OK) return false;
    BindText(stmt, 1, worldId);
    sqlite3_bind_int64(stmt, 2, accountId);
    bool found = false;
    if (sqlite3_step(stmt) == SQLITE_ROW) {
        spent = sqlite3_column_double(stmt, 0);
        rechargedAt = sqlite3_column_int64(stmt, 1);
        found = true;
    }
    sqlite3_finalize(stmt);
    return found;
}

/// Make sure the account HAS a `world_authority` row, through W7's own
/// creator. This is not defensive tidiness: W7 credits `startingAuthority` the
/// first time a world sees an account, and it does so by inserting the row. If
/// W8 inserted that row first — with authority 0, which is all a capacity
/// write knows — the grant would be skipped forever and the founding gate
/// would read zero for a player who had never spent anything. So the capacity
/// write never creates the row; it asks W7 to, and then UPDATEs its own two
/// columns.
void EnsureAuthorityRow(sqlite3* db, const std::string& worldId, int64_t accountId,
                        int64_t nowRealMs) {
    const auto w = WorldDirector::Load(db, worldId);
    WorldFactions::AuthorityFor(
        db, worldId, accountId,
        WorldFactionRules::FromWorldConfig(w ? w->config : nlohmann::json::object()),
        nowRealMs);
}

bool WriteCapacityRow(sqlite3* db, const std::string& worldId, int64_t accountId,
                      double spent, int64_t rechargedAt, int64_t nowRealMs) {
    EnsureAuthorityRow(db, worldId, accountId, nowRealMs);
    bool ok = true;
    const bool committed = SqliteWriteTransaction(db, "WorldCapacityWrite", [&] {
        static const char* kSql =
            "UPDATE world_authority SET capacity_spent=?, capacity_recharged_at=?,"
            "                           updated_at=? "
            "WHERE world_id=? AND account_id=?";
        sqlite3_stmt* stmt = nullptr;
        if (sqlite3_prepare_v2(db, kSql, -1, &stmt, nullptr) != SQLITE_OK) {
            ok = false;
            return SQLITE_ERROR;
        }
        sqlite3_bind_double(stmt, 1, spent);
        sqlite3_bind_int64(stmt, 2, rechargedAt);
        sqlite3_bind_int64(stmt, 3, nowRealMs);
        BindText(stmt, 4, worldId);
        sqlite3_bind_int64(stmt, 5, accountId);
        ok = sqlite3_step(stmt) == SQLITE_DONE;
        sqlite3_finalize(stmt);
        return ok ? SQLITE_OK : SQLITE_ERROR;
    });
    return committed && ok;
}

}  // namespace

WorldCapacityState WorldStats::CapacityFor(sqlite3* db, const std::string& worldId,
                                           int64_t accountId,
                                           const WorldStatRules& rules,
                                           int64_t nowRealMs, int64_t nowWorldMs) {
    const double max = CapacityCeiling(
        HeldAuthoritySum(db, worldId, accountId, rules, nowWorldMs), rules);
    double spent = 0.0;
    int64_t rechargedAt = 0;
    ReadCapacityRow(db, worldId, accountId, spent, rechargedAt);
    const auto ledger = NormalizeCapacity(spent, rechargedAt, max, rules, nowRealMs);
    if (ledger.changed)
        WriteCapacityRow(db, worldId, accountId, ledger.spent, ledger.rechargedAt, nowRealMs);
    return CapacityStateFrom(ledger, max, rules, nowRealMs);
}

bool WorldStats::SpendCapacity(sqlite3* db, const std::string& worldId,
                               int64_t accountId, double amount,
                               const WorldStatRules& rules,
                               int64_t nowRealMs, int64_t nowWorldMs) {
    if (!db || worldId.empty() || accountId <= 0) return false;
    if (amount <= 0.0) return false;
    const auto state = CapacityFor(db, worldId, accountId, rules, nowRealMs, nowWorldMs);
    if (amount > state.available) return false;
    return WriteCapacityRow(db, worldId, accountId, state.spent + amount,
                            state.rechargedAt, nowRealMs);
}

// ── rank ───────────────────────────────────────────────────────────────────

WorldRankBreakdown WorldStats::RankFor(sqlite3* db, const std::string& worldId,
                                       int64_t accountId, const WorldStatRules& rules,
                                       int64_t nowWorldMs) {
    const auto owned = CommandersOwnedBy(db, worldId, accountId);
    // "Regions where a player exerts control" (C24) = a POI their FACTION
    // holds and they garrison. Faction ownership alone would credit every
    // member with every holding; a commander standing there alone would credit
    // an occupier of somebody else's ground.
    int poisHeld = 0;
    if (const auto m = WorldFactions::MembershipFor(db, worldId, accountId)) {
        std::vector<std::string> garrisoned;
        for (const auto& c : owned)
            if (c.CountsForRank() && !c.poiId.empty()) garrisoned.push_back(c.poiId);
        for (const auto& p : WorldDirector::PoisFor(db, worldId)) {
            if (p.ownerFactionId != m->factionId) continue;
            if (std::find(garrisoned.begin(), garrisoned.end(), p.poiId) != garrisoned.end())
                ++poisHeld;
        }
    }
    // Money / resources / units: zero until W9's economy exists. Passed
    // explicitly so the formula is whole (see WorldStatRules' comment).
    const WorldHoldings holdings;
    return ComputeRank(owned, poisHeld, holdings, rules, nowWorldMs);
}

// ── the read-only HTTP surface ─────────────────────────────────────────────

namespace {

nlohmann::json CommanderJson(const WorldCommanderRecord& c, const WorldStatRules& rules,
                             int64_t nowWorldMs) {
    nlohmann::json j;
    j["commanderId"] = c.commanderId;
    j["name"]        = c.name;
    j["accountId"]   = c.accountId;
    j["factionId"]   = c.factionId;
    j["poiId"]       = c.poiId;
    j["state"]       = c.state;
    // Both numbers: the decayed value is what everything reads, and the stored
    // one is what a player comparing two panels a week apart needs to see the
    // decay rather than suspect the display.
    j["authority"]      = CommanderAuthorityAt(c, nowWorldMs, rules);
    j["authorityStored"] = c.authority;
    j["loaned"]         = c.loanedToAccountId != 0;
    if (c.loanedToAccountId != 0) j["loanedTo"] = c.loanedToAccountId;
    return j;
}

nlohmann::json RulesJson(const WorldStatRules& r) {
    nlohmann::json j;
    j["authorityPerVictory"]       = r.authorityPerVictory;
    j["authorityPerDefeat"]        = r.authorityPerDefeat;
    j["authorityDecayPerWorldDay"] = r.authorityDecayPerWorldDay;
    j["authorityFloor"]            = r.authorityFloor;
    j["commanderGrantAuthority"]   = r.commanderGrantAuthority;
    j["capacityBase"]              = r.capacityBase;
    j["capacityPerCommanderAuthority"] = r.capacityPerCommanderAuthority;
    j["capacityRechargeHours"]     = r.capacityRechargeHours;
    j["capacityRechargeFraction"]  = r.capacityRechargeFraction;
    j["rankPerCommander"]          = r.rankPerCommander;
    j["rankPerCommanderAuthority"] = r.rankPerCommanderAuthority;
    j["rankPerPoiHeld"]            = r.rankPerPoiHeld;
    j["rankPerArtifact"]           = r.rankPerArtifact;
    return j;
}

}  // namespace

nlohmann::json WorldStats::StatsJson(sqlite3* db, const std::string& worldId,
                                     const WorldStatRules& rules,
                                     int64_t nowRealMs, int64_t nowWorldMs) {
    nlohmann::json out;
    out["worldId"] = worldId;
    out["rules"]   = RulesJson(rules);
    if (!db) {
        out["commanders"] = nlohmann::json::array();
        out["factions"]   = nlohmann::json::array();
        return out;
    }
    // A read that also settles what the ledger owes. Idempotent, so a public
    // route may do it: see the header.
    out["accrued"] = AccrueFromSettlements(db, worldId, rules, nowRealMs, nowWorldMs);

    nlohmann::json commanders = nlohmann::json::array();
    for (const auto& c : CommandersFor(db, worldId))
        commanders.push_back(CommanderJson(c, rules, nowWorldMs));
    out["commanders"] = std::move(commanders);

    // Standings: every faction's roster with each member's DERIVED rank,
    // highest first — this is the vote-weight table, so its order is the
    // information.
    nlohmann::json factions = nlohmann::json::array();
    for (const auto& f : WorldFactions::ListFor(db, worldId)) {
        nlohmann::json fj;
        fj["factionId"] = f.factionId;
        fj["name"]      = f.name;
        fj["colour"]    = f.colour;
        std::vector<std::pair<double, nlohmann::json>> rows;
        for (const auto& m : WorldFactions::MembersOf(db, worldId, f.factionId)) {
            const auto rank = RankFor(db, worldId, m.accountId, rules, nowWorldMs);
            nlohmann::json mj;
            mj["accountId"] = m.accountId;
            mj["username"]  = m.username;
            mj["role"]      = m.role;
            mj["rank"]      = rank.ToJson();
            rows.emplace_back(rank.total, std::move(mj));
        }
        std::stable_sort(rows.begin(), rows.end(),
                         [](const auto& a, const auto& b) { return a.first > b.first; });
        nlohmann::json members = nlohmann::json::array();
        double total = 0.0;
        for (auto& [score, mj] : rows) {
            total += score;
            members.push_back(std::move(mj));
        }
        fj["members"] = std::move(members);
        // The denominator a vote share is read against, so the UI does not
        // have to sum an array to say "you hold 40% of the votes".
        fj["rankTotal"] = total;
        factions.push_back(std::move(fj));
    }
    out["factions"] = std::move(factions);
    return out;
}

nlohmann::json WorldStats::AttachMeStats(nlohmann::json me, sqlite3* db,
                                         const std::string& worldId, int64_t accountId,
                                         const std::string& username,
                                         const WorldStatRules& rules,
                                         int64_t nowRealMs, int64_t nowWorldMs) {
    if (!db || worldId.empty() || accountId <= 0) return me;
    // W7's MeJson has already created the authority row and granted its
    // starting value, so this reads a number that exists rather than a zero.
    const double worldAuthority =
        me.contains("authority") && me["authority"].is_number()
            ? me["authority"].get<double>() : 0.0;
    const auto granted = EnsureStarterCommander(db, worldId, accountId, username,
                                                worldAuthority, rules, nowRealMs, nowWorldMs);
    me["commanderGranted"] = granted.has_value();
    me["accrued"] = AccrueFromSettlements(db, worldId, rules, nowRealMs, nowWorldMs);

    nlohmann::json commanders = nlohmann::json::array();
    for (const auto& c : CommandersOwnedBy(db, worldId, accountId))
        commanders.push_back(CommanderJson(c, rules, nowWorldMs));
    me["commanders"] = std::move(commanders);

    const auto cap = CapacityFor(db, worldId, accountId, rules, nowRealMs, nowWorldMs);
    nlohmann::json cj;
    cj["max"]              = cap.max;
    cj["spent"]            = cap.spent;
    cj["available"]        = cap.available;
    cj["rechargedAt"]      = cap.rechargedAt;
    cj["nextRechargeInMs"] = cap.nextRechargeInMs;
    cj["rechargeHours"]    = rules.capacityRechargeHours;
    me["capacity"] = std::move(cj);

    // Rank is per player PER FACTION and this account is in at most one, so
    // there is exactly one number — but it is still reported under the faction
    // it applies to, because standing outside a faction is not a thing.
    const auto rank = RankFor(db, worldId, accountId, rules, nowWorldMs);
    nlohmann::json rj = rank.ToJson();
    if (const auto m = WorldFactions::MembershipFor(db, worldId, accountId))
        rj["factionId"] = m->factionId;
    else
        rj["factionId"] = nullptr;
    me["rank"] = std::move(rj);
    me["statRules"] = RulesJson(rules);
    return me;
}
