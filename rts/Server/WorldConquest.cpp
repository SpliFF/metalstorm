#include "WorldConquest.h"

#include <sqlite3.h>

#include <algorithm>
#include <unordered_map>

#include "SqliteThreading.h"
#include "WorldStats.h"

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
/// WorldStagingRules::FromWorldConfig.
double CfgDouble(const nlohmann::json& j, const char* key, double fallback) {
    if (!j.is_object()) return fallback;
    const auto it = j.find(key);
    if (it == j.end() || !it->is_number()) return fallback;
    return it->get<double>();
}

constexpr const char* kSelectCols =
    "rowid, world_id, poi_id, faction_id, account_id, cost, refund, state, "
    "filed_at_world_ms, filed_at, resolved_at, settlement_id";

WorldPoiClaimRecord ReadRow(sqlite3_stmt* s) {
    WorldPoiClaimRecord c;
    c.claimId        = sqlite3_column_int64(s, 0);
    c.worldId        = ColText(s, 1);
    c.poiId          = ColText(s, 2);
    c.factionId      = ColText(s, 3);
    c.accountId      = sqlite3_column_int64(s, 4);
    c.cost           = sqlite3_column_double(s, 5);
    c.refund         = sqlite3_column_double(s, 6);
    c.state          = WorldClaimStateFromString(ColText(s, 7));
    c.filedAtWorldMs = sqlite3_column_int64(s, 8);
    c.filedAt        = sqlite3_column_int64(s, 9);
    c.resolvedAt     = sqlite3_column_int64(s, 10);
    c.settlementId   = sqlite3_column_int64(s, 11);
    return c;
}

WorldClaimFileResult Failure(const std::string& error) {
    WorldClaimFileResult r;
    r.ok = false;
    r.error = error;
    return r;
}

/// What a non-won resolution returns to the filer. Clamped to [0, cost]: a
/// hand-edited fraction above 1 must not mint authority, and below 0 must not
/// charge a second time.
double RefundFor(double cost, const WorldConquestRules& rules) {
    const double f = std::clamp(rules.claimRefundFraction, 0.0, 1.0);
    return cost * f;
}

/// Flip ONE open claim to a terminal state, refunding `refund` to its filer.
/// The UPDATE is guarded on `state='open'`, which is the idempotence the
/// header promises: a claim resolved by an earlier pass (or a raced
/// withdrawal) is left exactly as that pass left it, and the refund is only
/// paid when this call is the one that flipped the row.
bool ResolveClaim(sqlite3* db, const WorldPoiClaimRecord& c,
                  WorldClaimState to, double refund, int64_t settlementId,
                  int64_t nowRealMs) {
    bool flipped = false;
    bool ok = true;
    const bool committed = SqliteWriteTransaction(db, "WorldResolveClaim", [&] {
        sqlite3_stmt* stmt = nullptr;
        if (sqlite3_prepare_v2(db,
                "UPDATE world_poi_claims SET state=?, refund=?, resolved_at=?, "
                "settlement_id=? WHERE rowid=? AND state='open'",
                -1, &stmt, nullptr) != SQLITE_OK) {
            ok = false;
            return SQLITE_ERROR;
        }
        BindText(stmt, 1, WorldClaimStateToString(to));
        sqlite3_bind_double(stmt, 2, refund);
        sqlite3_bind_int64(stmt, 3, nowRealMs);
        sqlite3_bind_int64(stmt, 4, settlementId);
        sqlite3_bind_int64(stmt, 5, c.claimId);
        ok = sqlite3_step(stmt) == SQLITE_DONE;
        sqlite3_finalize(stmt);
        if (!ok) return SQLITE_ERROR;
        flipped = sqlite3_changes(db) > 0;
        if (!flipped) return SQLITE_ABORT;  // already resolved — not a failure
        if (refund > 0 &&
            !WorldFactions::AdjustAuthority(db, c.worldId, c.accountId, refund,
                                            nowRealMs)) {
            ok = false;
            return SQLITE_ERROR;
        }
        return SQLITE_OK;
    });
    return committed && ok && flipped;
}

}  // namespace

// ─────────────────────────── rules / vocabulary ────────────────────────────

WorldConquestRules WorldConquestRules::FromWorldConfig(const nlohmann::json& c) {
    WorldConquestRules r;
    r.claimPoiCost        = CfgDouble(c, "claimPoiCost", r.claimPoiCost);
    r.claimRefundFraction = CfgDouble(c, "claimRefundFraction", r.claimRefundFraction);
    r.claimExpiryWorldMs  = CfgDouble(c, "claimExpiryWorldMs", r.claimExpiryWorldMs);
    return r;
}

const char* WorldClaimStateToString(WorldClaimState s) {
    switch (s) {
        case WorldClaimState::Open:      return "open";
        case WorldClaimState::Won:       return "won";
        case WorldClaimState::Lost:      return "lost";
        case WorldClaimState::Expired:   return "expired";
        case WorldClaimState::Withdrawn: return "withdrawn";
    }
    return "open";
}

WorldClaimState WorldClaimStateFromString(const std::string& s) {
    if (s == "won")       return WorldClaimState::Won;
    if (s == "lost")      return WorldClaimState::Lost;
    if (s == "expired")   return WorldClaimState::Expired;
    if (s == "withdrawn") return WorldClaimState::Withdrawn;
    return WorldClaimState::Open;
}

// ─────────────────────────── pure policy ───────────────────────────────────

std::optional<int64_t> SelectWinningClaim(
    const std::vector<WorldPoiClaimRecord>& openClaims,
    const std::vector<WorldClaimFactionSide>& factionSides,
    const std::string& winnerFactions) {
    if (winnerFactions.empty()) return std::nullopt;

    std::unordered_map<std::string, std::string> sideOf;
    for (const auto& fs : factionSides) sideOf[fs.factionId] = fs.sideKey;

    const WorldPoiClaimRecord* best = nullptr;
    for (const auto& c : openClaims) {
        if (!c.IsOpen()) continue;
        const auto it = sideOf.find(c.factionId);
        if (it == sideOf.end() || it->second.empty()) continue;
        if (!SettlementNamesFaction(winnerFactions, it->second)) continue;
        // Earliest claim wins; a tie on the world clock (two claims filed in
        // one clock read) falls to the smaller rowid — file order, and fully
        // deterministic across replays.
        if (!best || c.filedAtWorldMs < best->filedAtWorldMs ||
            (c.filedAtWorldMs == best->filedAtWorldMs && c.claimId < best->claimId))
            best = &c;
    }
    if (!best) return std::nullopt;
    return best->claimId;
}

// ─────────────────────────── the store ─────────────────────────────────────

void WorldConquest::EnsureTables(sqlite3* db) {
    if (!db) return;
    sqlite3_exec(db,
        "CREATE TABLE IF NOT EXISTS world_poi_claims ("
        "  world_id TEXT NOT NULL,"
        "  poi_id TEXT NOT NULL,"
        "  faction_id TEXT NOT NULL,"
        "  account_id INTEGER NOT NULL,"
        "  cost REAL NOT NULL DEFAULT 0,"
        "  refund REAL NOT NULL DEFAULT 0,"
        "  state TEXT NOT NULL DEFAULT 'open',"
        "  filed_at_world_ms INTEGER NOT NULL DEFAULT 0,"
        "  filed_at INTEGER NOT NULL DEFAULT 0,"
        "  resolved_at INTEGER NOT NULL DEFAULT 0,"
        "  settlement_id INTEGER NOT NULL DEFAULT 0"
        ")",
        nullptr, nullptr, nullptr);
    sqlite3_exec(db,
        "CREATE INDEX IF NOT EXISTS idx_world_poi_claims_poi "
        "ON world_poi_claims(world_id, poi_id, state)",
        nullptr, nullptr, nullptr);
    sqlite3_exec(db,
        "CREATE INDEX IF NOT EXISTS idx_world_poi_claims_state "
        "ON world_poi_claims(world_id, state)",
        nullptr, nullptr, nullptr);
}

WorldClaimFileResult WorldConquest::FileClaim(sqlite3* db,
                                              const WorldConquestRules& rules,
                                              const WorldFactionRules& factionRules,
                                              const WorldClaimFileRequest& req,
                                              int64_t nowWorldMs, int64_t nowRealMs) {
    if (!db || req.worldId.empty() || req.poiId.empty() ||
        req.factionId.empty() || req.accountId <= 0)
        return Failure("db_error");

    const auto poi = WorldDirector::LoadPoi(db, req.worldId, req.poiId);
    if (!poi) return Failure("no_poi");

    if (!WorldFactions::Load(db, req.worldId, req.factionId))
        return Failure("no_faction");

    // The owner needs no claim: rule 4 already keeps a defended POI, so a
    // claim by its own holder could only ever burn authority.
    if (poi->ownerFactionId == req.factionId) return Failure("already_owner");

    // One open claim per faction per POI: a second would only queue behind
    // the first in the same tie-break, i.e. buy nothing.
    for (const auto& c : OpenClaimsAt(db, req.worldId, req.poiId))
        if (c.factionId == req.factionId) return Failure("already_claimed");

    const auto authority = WorldFactions::AuthorityFor(db, req.worldId, req.accountId,
                                                       factionRules, nowRealMs);
    if (authority.authority < rules.claimPoiCost) {
        WorldClaimFileResult r = Failure("insufficient_authority");
        r.have = authority.authority;
        r.need = rules.claimPoiCost;
        return r;
    }

    WorldPoiClaimRecord claim;
    claim.worldId        = req.worldId;
    claim.poiId          = req.poiId;
    claim.factionId      = req.factionId;
    claim.accountId      = req.accountId;
    claim.cost           = rules.claimPoiCost;
    claim.state          = WorldClaimState::Open;
    claim.filedAtWorldMs = nowWorldMs;
    claim.filedAt        = nowRealMs;

    // One transaction for the charge and the row — a charge with no claim (or
    // a claim nobody paid for) is a state nothing recovers from, same reason
    // the founding act is one transaction.
    bool ok = true;
    const bool committed = SqliteWriteTransaction(db, "WorldFileClaim", [&] {
        if (rules.claimPoiCost > 0 &&
            !WorldFactions::AdjustAuthority(db, req.worldId, req.accountId,
                                            -rules.claimPoiCost, nowRealMs)) {
            ok = false;
            return SQLITE_ERROR;
        }
        sqlite3_stmt* stmt = nullptr;
        if (sqlite3_prepare_v2(db,
                "INSERT INTO world_poi_claims (world_id, poi_id, faction_id, "
                "account_id, cost, refund, state, filed_at_world_ms, filed_at, "
                "resolved_at, settlement_id) VALUES (?,?,?,?,?,0,'open',?,?,0,0)",
                -1, &stmt, nullptr) != SQLITE_OK) {
            ok = false;
            return SQLITE_ERROR;
        }
        BindText(stmt, 1, req.worldId);
        BindText(stmt, 2, req.poiId);
        BindText(stmt, 3, req.factionId);
        sqlite3_bind_int64(stmt, 4, req.accountId);
        sqlite3_bind_double(stmt, 5, claim.cost);
        sqlite3_bind_int64(stmt, 6, claim.filedAtWorldMs);
        sqlite3_bind_int64(stmt, 7, claim.filedAt);
        ok = sqlite3_step(stmt) == SQLITE_DONE;
        sqlite3_finalize(stmt);
        if (!ok) return SQLITE_ERROR;
        claim.claimId = sqlite3_last_insert_rowid(db);
        return SQLITE_OK;
    });
    if (!committed || !ok) return Failure("db_error");

    WorldClaimFileResult r;
    r.ok = true;
    r.have = authority.authority - claim.cost;
    r.need = rules.claimPoiCost;
    r.claim = claim;
    return r;
}

std::optional<WorldPoiClaimRecord> WorldConquest::Load(sqlite3* db, int64_t claimId) {
    if (!db || claimId <= 0) return std::nullopt;
    sqlite3_stmt* stmt = nullptr;
    const std::string sql = std::string("SELECT ") + kSelectCols +
                            " FROM world_poi_claims WHERE rowid=?";
    if (sqlite3_prepare_v2(db, sql.c_str(), -1, &stmt, nullptr) != SQLITE_OK)
        return std::nullopt;
    sqlite3_bind_int64(stmt, 1, claimId);
    std::optional<WorldPoiClaimRecord> out;
    if (sqlite3_step(stmt) == SQLITE_ROW) out = ReadRow(stmt);
    sqlite3_finalize(stmt);
    return out;
}

std::vector<WorldPoiClaimRecord> WorldConquest::OpenClaimsAt(
    sqlite3* db, const std::string& worldId, const std::string& poiId) {
    std::vector<WorldPoiClaimRecord> out;
    if (!db) return out;
    sqlite3_stmt* stmt = nullptr;
    const std::string sql = std::string("SELECT ") + kSelectCols +
        " FROM world_poi_claims WHERE world_id=? AND poi_id=? AND state='open' "
        "ORDER BY filed_at_world_ms ASC, rowid ASC";
    if (sqlite3_prepare_v2(db, sql.c_str(), -1, &stmt, nullptr) != SQLITE_OK)
        return out;
    BindText(stmt, 1, worldId);
    BindText(stmt, 2, poiId);
    while (sqlite3_step(stmt) == SQLITE_ROW) out.push_back(ReadRow(stmt));
    sqlite3_finalize(stmt);
    return out;
}

std::vector<WorldPoiClaimRecord> WorldConquest::ClaimsFor(sqlite3* db,
                                                          const std::string& worldId) {
    std::vector<WorldPoiClaimRecord> out;
    if (!db) return out;
    sqlite3_stmt* stmt = nullptr;
    const std::string sql = std::string("SELECT ") + kSelectCols +
        " FROM world_poi_claims WHERE world_id=? ORDER BY rowid DESC";
    if (sqlite3_prepare_v2(db, sql.c_str(), -1, &stmt, nullptr) != SQLITE_OK)
        return out;
    BindText(stmt, 1, worldId);
    while (sqlite3_step(stmt) == SQLITE_ROW) out.push_back(ReadRow(stmt));
    sqlite3_finalize(stmt);
    return out;
}

bool WorldConquest::Withdraw(sqlite3* db, const WorldConquestRules& rules,
                             const std::string& worldId, int64_t claimId,
                             int64_t nowRealMs) {
    const auto claim = Load(db, claimId);
    if (!claim || claim->worldId != worldId || !claim->IsOpen()) return false;
    return ResolveClaim(db, *claim, WorldClaimState::Withdrawn,
                        RefundFor(claim->cost, rules), 0, nowRealMs);
}

int WorldConquest::ExpireClaims(sqlite3* db, const std::string& worldId,
                                const WorldConquestRules& rules,
                                int64_t nowWorldMs, int64_t nowRealMs) {
    if (!db || rules.claimExpiryWorldMs <= 0) return 0;
    std::vector<WorldPoiClaimRecord> due;
    {
        sqlite3_stmt* stmt = nullptr;
        const std::string sql = std::string("SELECT ") + kSelectCols +
            " FROM world_poi_claims WHERE world_id=? AND state='open' "
            "AND filed_at_world_ms + ? <= ? ORDER BY rowid ASC";
        if (sqlite3_prepare_v2(db, sql.c_str(), -1, &stmt, nullptr) != SQLITE_OK)
            return 0;
        BindText(stmt, 1, worldId);
        sqlite3_bind_int64(stmt, 2, static_cast<int64_t>(rules.claimExpiryWorldMs));
        sqlite3_bind_int64(stmt, 3, nowWorldMs);
        while (sqlite3_step(stmt) == SQLITE_ROW) due.push_back(ReadRow(stmt));
        sqlite3_finalize(stmt);
    }
    int expired = 0;
    for (const auto& c : due)
        if (ResolveClaim(db, c, WorldClaimState::Expired,
                         RefundFor(c.cost, rules), 0, nowRealMs))
            ++expired;
    return expired;
}

WorldConquestSettlementResult WorldConquest::SettleWar(
    sqlite3* db, const WorldSettlementRecord& settlement,
    const WorldConquestRules& rules, int64_t nowWorldMs, int64_t nowRealMs) {
    WorldConquestSettlementResult r;
    if (!db || settlement.worldId.empty() || settlement.poiId.empty()) return r;

    const auto poi = WorldDirector::LoadPoi(db, settlement.worldId, settlement.poiId);
    if (!poi) return r;

    // Rule 7 before rules 3–6: a claim that lapsed before the war ended must
    // expire, never win. World-wide rather than per-POI so a sweep that only
    // settles is still enough to keep the table honest.
    r.claimsExpired = ExpireClaims(db, settlement.worldId, rules, nowWorldMs, nowRealMs);

    // Rule 2: a war with no in-sim winner resolves nothing.
    if (settlement.factions.empty()) return r;

    const auto open = OpenClaimsAt(db, settlement.worldId, settlement.poiId);

    // Side keys for the owner and every claimant, loaded once. A faction the
    // world no longer knows (dissolved-but-referenced — legal, see
    // WorldPoiRecord::ownerFactionId) simply has no side and cannot win.
    std::vector<WorldClaimFactionSide> sides;
    auto sideOf = [&](const std::string& factionId) -> std::string {
        if (factionId.empty()) return {};
        for (const auto& fs : sides)
            if (fs.factionId == factionId) return fs.sideKey;
        const auto f = WorldFactions::Load(db, settlement.worldId, factionId);
        const std::string key = f ? f->sideKey : std::string();
        sides.push_back({factionId, key});
        return key;
    };

    r.previousOwnerFactionId = poi->ownerFactionId;
    r.newOwnerFactionId      = poi->ownerFactionId;

    // Rule 3: every claim whose faction's side is not named resolves as lost.
    for (const auto& c : open) {
        const std::string side = sideOf(c.factionId);
        if (!side.empty() && SettlementNamesFaction(settlement.factions, side))
            continue;
        const double refund = RefundFor(c.cost, rules);
        if (ResolveClaim(db, c, WorldClaimState::Lost, refund,
                         settlement.settlementId, nowRealMs)) {
            ++r.claimsResolvedLost;
            r.refunded += refund;
        }
    }

    // Rule 4: the defender's shield. A POI whose owner is on the winning side
    // was defended and does not change hands; the owner's own open claim (a
    // leftover from before ownership moved to it) completes as won.
    const std::string ownerSide = sideOf(poi->ownerFactionId);
    if (!poi->ownerFactionId.empty() && !ownerSide.empty() &&
        SettlementNamesFaction(settlement.factions, ownerSide)) {
        for (const auto& c : open)
            if (c.factionId == poi->ownerFactionId)
                ResolveClaim(db, c, WorldClaimState::Won, 0.0,
                             settlement.settlementId, nowRealMs);
        return r;
    }

    // Rules 5–6: the earliest winning-side claim takes the POI; the rest of
    // the winning side's claims stay open, queued for the next war.
    const auto winner = SelectWinningClaim(open, sides, settlement.factions);
    if (!winner) return r;
    const auto claim = std::find_if(open.begin(), open.end(),
        [&](const WorldPoiClaimRecord& c) { return c.claimId == *winner; });
    if (claim == open.end()) return r;

    if (!ResolveClaim(db, *claim, WorldClaimState::Won, 0.0,
                      settlement.settlementId, nowRealMs))
        return r;  // raced with a withdrawal — the withdrawal stands
    if (claim->factionId != poi->ownerFactionId) {
        if (WorldDirector::SetPoiOwner(db, settlement.worldId, settlement.poiId,
                                       claim->factionId)) {
            r.ownershipChanged  = true;
            r.newOwnerFactionId = claim->factionId;
        }
    }
    r.winningClaimId = *winner;
    return r;
}

// ─────────────────────────── the read surface ──────────────────────────────

nlohmann::json WorldConquest::ClaimJson(const WorldPoiClaimRecord& c) {
    nlohmann::json j;
    j["claimId"]        = c.claimId;
    j["poi"]            = c.poiId;
    j["faction"]        = c.factionId;
    j["accountId"]      = c.accountId;
    j["cost"]           = c.cost;
    j["refund"]         = c.refund;
    j["state"]          = WorldClaimStateToString(c.state);
    j["filedAtWorldMs"] = c.filedAtWorldMs;
    j["resolvedAt"]     = c.resolvedAt;
    j["settlementId"]   = c.settlementId;
    return j;
}

nlohmann::json WorldConquest::ClaimsJson(sqlite3* db, const std::string& worldId,
                                         const WorldConquestRules& rules) {
    nlohmann::json j;
    j["worldId"] = worldId;
    j["rules"]["claimPoiCost"]        = rules.claimPoiCost;
    j["rules"]["claimRefundFraction"] = rules.claimRefundFraction;
    j["rules"]["claimExpiryWorldMs"]  = rules.claimExpiryWorldMs;
    auto arr = nlohmann::json::array();
    for (const auto& c : ClaimsFor(db, worldId)) arr.push_back(ClaimJson(c));
    j["claims"] = std::move(arr);
    return j;
}
