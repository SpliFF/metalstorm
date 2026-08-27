#include "WorldEscrow.h"

#include <sqlite3.h>

#include <algorithm>
#include <cmath>

#include "SqliteThreading.h"

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
/// WorldEconomyRules/WorldStagingRules::FromWorldConfig.
double CfgDouble(const nlohmann::json& j, const char* key, double fallback) {
    if (!j.is_object()) return fallback;
    const auto it = j.find(key);
    if (it == j.end() || !it->is_number()) return fallback;
    return it->get<double>();
}

constexpr const char* kEscrowCols =
    "rowid, world_id, staging_id, poi_id, faction_id, transports, squads, "
    "committed_by_account_id, state, room_id, outcome, created_at, engaged_at, "
    "resolved_at";

WorldEscrowRecord ReadEscrowRow(sqlite3_stmt* s) {
    WorldEscrowRecord r;
    r.escrowId             = sqlite3_column_int64(s, 0);
    r.worldId              = ColText(s, 1);
    r.stagingId            = sqlite3_column_int64(s, 2);
    r.poiId                = ColText(s, 3);
    r.factionId            = ColText(s, 4);
    r.transports           = sqlite3_column_int(s, 5);
    r.squads               = sqlite3_column_int(s, 6);
    r.committedByAccountId = sqlite3_column_int64(s, 7);
    r.state                = WorldEscrowStateFromString(ColText(s, 8));
    r.roomId  = static_cast<uint32_t>(sqlite3_column_int64(s, 9));
    r.outcome              = ColText(s, 10);
    r.createdAt            = sqlite3_column_int64(s, 11);
    r.engagedAt            = sqlite3_column_int64(s, 12);
    r.resolvedAt           = sqlite3_column_int64(s, 13);
    return r;
}

/// Append one `world_force_ledger` row. Runs inside the caller's transaction;
/// returns false on any sqlite failure so the caller can roll the whole
/// movement back — half an escrow (a debit with no row, a flip with no
/// refund) must never reach disk.
bool AppendLedger(sqlite3* db, const std::string& worldId,
                  const std::string& factionId, const char* source,
                  int transports, int squads, int64_t stagingId,
                  uint32_t roomId, int64_t nowRealMs) {
    static const char* kSql =
        "INSERT INTO world_force_ledger (world_id, faction_id, source, "
        "transports, squads, staging_id, room_id, recorded_at) "
        "VALUES (?, ?, ?, ?, ?, ?, ?, ?)";
    sqlite3_stmt* stmt = nullptr;
    if (sqlite3_prepare_v2(db, kSql, -1, &stmt, nullptr) != SQLITE_OK)
        return false;
    BindText(stmt, 1, worldId);
    BindText(stmt, 2, factionId);
    BindText(stmt, 3, source);
    sqlite3_bind_int(stmt, 4, transports);
    sqlite3_bind_int(stmt, 5, squads);
    sqlite3_bind_int64(stmt, 6, stagingId);
    sqlite3_bind_int64(stmt, 7, static_cast<int64_t>(roomId));
    sqlite3_bind_int64(stmt, 8, nowRealMs);
    const bool ok = sqlite3_step(stmt) == SQLITE_DONE;
    sqlite3_finalize(stmt);
    return ok;
}

/// Floor of `fraction × n`, clamped to [0, n]. Floor on purpose: a fraction
/// of a transport does not come home, and rounding up would mint materiel.
int FlooredShare(double fraction, int n) {
    if (n <= 0) return 0;
    const double f = std::clamp(fraction, 0.0, 1.0);
    const int share = static_cast<int>(std::floor(f * static_cast<double>(n) + 1e-9));
    return std::clamp(share, 0, n);
}

}  // namespace

// ─────────────────────────── vocabulary ────────────────────────────────────

const char* WorldEscrowStateToString(WorldEscrowState s) {
    switch (s) {
        case WorldEscrowState::Committed: return "committed";
        case WorldEscrowState::Engaged:   return "engaged";
        case WorldEscrowState::Released:  return "released";
        case WorldEscrowState::Settled:   return "settled";
    }
    return "committed";
}

WorldEscrowState WorldEscrowStateFromString(const std::string& s) {
    if (s == "engaged")  return WorldEscrowState::Engaged;
    if (s == "released") return WorldEscrowState::Released;
    if (s == "settled")  return WorldEscrowState::Settled;
    return WorldEscrowState::Committed;
}

const char* WorldEscrowOutcomeToString(WorldEscrowOutcome o) {
    switch (o) {
        case WorldEscrowOutcome::Held:        return "held";
        case WorldEscrowOutcome::Withdrew:    return "withdrew";
        case WorldEscrowOutcome::Routed:      return "routed";
        case WorldEscrowOutcome::Annihilated: return "annihilated";
    }
    return "annihilated";
}

// ─────────────────────────── the per-world rates ───────────────────────────

WorldEscrowRules WorldEscrowRules::FromWorldConfig(const nlohmann::json& c) {
    WorldEscrowRules r;
    r.annihilatedCaptureFraction =
        CfgDouble(c, "escrowAnnihilatedCaptureFraction", r.annihilatedCaptureFraction);
    r.withdrewThresholdFraction =
        CfgDouble(c, "escrowWithdrewThresholdFraction", r.withdrewThresholdFraction);
    r.heldSpoilsTreasury =
        CfgDouble(c, "escrowHeldSpoilsTreasury", r.heldSpoilsTreasury);
    return r;
}

// ─────────────────────────── pure policy ───────────────────────────────────

WorldEscrowOutcome ClassifyEscrowOutcome(bool attackerWon, int withdrawnUnits,
                                         int committedUnits,
                                         const WorldEscrowRules& rules) {
    if (attackerWon) return WorldEscrowOutcome::Held;
    // §7.5: "no live units and no recorded departure" is annihilated. A side
    // that committed nothing has nothing to withdraw and nothing to price —
    // the same bucket, by the arithmetic rather than by a special case.
    if (committedUnits <= 0 || withdrawnUnits <= 0)
        return WorldEscrowOutcome::Annihilated;
    const double fraction = static_cast<double>(withdrawnUnits) /
                            static_cast<double>(committedUnits);
    return fraction >= rules.withdrewThresholdFraction
               ? WorldEscrowOutcome::Withdrew
               : WorldEscrowOutcome::Routed;
}

WorldEscrowPayout PayoutFor(WorldEscrowOutcome outcome, int transports,
                            int squads, double withdrawnFraction,
                            const WorldEscrowRules& rules) {
    WorldEscrowPayout p;
    transports = std::max(0, transports);
    squads     = std::max(0, squads);
    switch (outcome) {
        case WorldEscrowOutcome::Held:
            // Full return. §7.5 says survivors garrison in place — WHERE they
            // stand is the world layer's ownership question (the conquest
            // lane's), but they are the faction's force again either way.
            p.returnTransports = transports;
            p.returnSquads     = squads;
            break;
        case WorldEscrowOutcome::Withdrew:
            // Keeps what it carried out; the remainder died in the battle and
            // nobody captures a wreck field they do not hold... §7.5 grants
            // the withdrawer no spoils and the victor no capture here.
            p.returnTransports = FlooredShare(withdrawnFraction, transports);
            p.returnSquads     = FlooredShare(withdrawnFraction, squads);
            break;
        case WorldEscrowOutcome::Routed: {
            // Keeps only what left; the remainder settles as annihilated —
            // the victor captures its share of what was left behind.
            p.returnTransports = FlooredShare(withdrawnFraction, transports);
            p.returnSquads     = FlooredShare(withdrawnFraction, squads);
            p.captureTransports = FlooredShare(rules.annihilatedCaptureFraction,
                                               transports - p.returnTransports);
            p.captureSquads     = FlooredShare(rules.annihilatedCaptureFraction,
                                               squads - p.returnSquads);
            break;
        }
        case WorldEscrowOutcome::Annihilated:
            p.captureTransports = FlooredShare(rules.annihilatedCaptureFraction,
                                               transports);
            p.captureSquads     = FlooredShare(rules.annihilatedCaptureFraction,
                                               squads);
            break;
    }
    return p;
}

std::string EncodeWorldCommitModOption(const std::string& sideKey,
                                       int transports, int squads,
                                       int64_t stagingId) {
    return sideKey + ":" + std::to_string(std::max(0, transports)) + ":" +
           std::to_string(std::max(0, squads)) + ":" +
           std::to_string(stagingId);
}

// ─────────────────────────── the store ─────────────────────────────────────

void WorldEscrow::EnsureTables(sqlite3* db) {
    if (!db) return;
    sqlite3_exec(db,
        "CREATE TABLE IF NOT EXISTS world_escrow ("
        "  world_id TEXT NOT NULL,"
        "  staging_id INTEGER NOT NULL,"
        "  poi_id TEXT NOT NULL DEFAULT '',"
        "  faction_id TEXT NOT NULL DEFAULT '',"
        "  transports INTEGER NOT NULL DEFAULT 0,"
        "  squads INTEGER NOT NULL DEFAULT 0,"
        "  committed_by_account_id INTEGER NOT NULL DEFAULT 0,"
        "  state TEXT NOT NULL DEFAULT 'committed',"
        "  room_id INTEGER NOT NULL DEFAULT 0,"
        "  outcome TEXT NOT NULL DEFAULT '',"
        "  created_at INTEGER NOT NULL DEFAULT 0,"
        "  engaged_at INTEGER NOT NULL DEFAULT 0,"
        "  resolved_at INTEGER NOT NULL DEFAULT 0"
        ")", nullptr, nullptr, nullptr);
    // The three questions the seam asks: "this window's rows" (every state
    // transition), "engaged rows against this room" (the war-end sweep), and
    // "this faction's rows" (the panel).
    sqlite3_exec(db,
        "CREATE INDEX IF NOT EXISTS idx_world_escrow_staging "
        "ON world_escrow(staging_id, state)", nullptr, nullptr, nullptr);
    sqlite3_exec(db,
        "CREATE INDEX IF NOT EXISTS idx_world_escrow_room "
        "ON world_escrow(room_id, state)", nullptr, nullptr, nullptr);
    sqlite3_exec(db,
        "CREATE INDEX IF NOT EXISTS idx_world_escrow_faction "
        "ON world_escrow(world_id, faction_id)", nullptr, nullptr, nullptr);

    sqlite3_exec(db,
        "CREATE TABLE IF NOT EXISTS world_force_ledger ("
        "  world_id TEXT NOT NULL,"
        "  faction_id TEXT NOT NULL DEFAULT '',"
        "  source TEXT NOT NULL DEFAULT '',"
        "  transports INTEGER NOT NULL DEFAULT 0,"
        "  squads INTEGER NOT NULL DEFAULT 0,"
        "  staging_id INTEGER NOT NULL DEFAULT 0,"
        "  room_id INTEGER NOT NULL DEFAULT 0,"
        "  recorded_at INTEGER NOT NULL DEFAULT 0"
        ")", nullptr, nullptr, nullptr);
    sqlite3_exec(db,
        "CREATE INDEX IF NOT EXISTS idx_world_force_ledger_faction "
        "ON world_force_ledger(world_id, faction_id)", nullptr, nullptr, nullptr);
}

std::optional<WorldEscrowRecord> WorldEscrow::Open(sqlite3* db,
                                                   const WorldStagingRecord& staging,
                                                   int transports, int squads,
                                                   int64_t accountId,
                                                   int64_t nowRealMs) {
    if (!db || staging.stagingId <= 0) return std::nullopt;
    if (transports < 0 || squads < 0) return std::nullopt;

    int64_t escrowId = 0;
    const bool committed = SqliteWriteTransaction(db, "WorldEscrowOpen", [&] {
        static const char* kInsert =
            "INSERT INTO world_escrow (world_id, staging_id, poi_id, "
            "faction_id, transports, squads, committed_by_account_id, state, "
            "created_at) VALUES (?, ?, ?, ?, ?, ?, ?, 'committed', ?)";
        sqlite3_stmt* stmt = nullptr;
        if (sqlite3_prepare_v2(db, kInsert, -1, &stmt, nullptr) != SQLITE_OK)
            return SQLITE_ERROR;
        BindText(stmt, 1, staging.worldId);
        sqlite3_bind_int64(stmt, 2, staging.stagingId);
        BindText(stmt, 3, staging.poiId);
        BindText(stmt, 4, staging.attackerFactionId);
        sqlite3_bind_int(stmt, 5, transports);
        sqlite3_bind_int(stmt, 6, squads);
        sqlite3_bind_int64(stmt, 7, accountId);
        sqlite3_bind_int64(stmt, 8, nowRealMs);
        const bool ok = sqlite3_step(stmt) == SQLITE_DONE;
        sqlite3_finalize(stmt);
        if (!ok) return SQLITE_ERROR;
        escrowId = sqlite3_last_insert_rowid(db);

        // The debit: the force leaves the available pool the moment it is
        // committed (§7.3 `in_transit_out` — "escrowed, unavailable").
        if (!AppendLedger(db, staging.worldId, staging.attackerFactionId,
                          "escrow_commit", -transports, -squads,
                          staging.stagingId, 0, nowRealMs))
            return SQLITE_ERROR;
        return SQLITE_OK;
    });
    if (!committed) return std::nullopt;
    return Load(db, escrowId);
}

std::optional<WorldEscrowRecord> WorldEscrow::Load(sqlite3* db, int64_t escrowId) {
    if (!db || escrowId <= 0) return std::nullopt;
    const std::string sql =
        std::string("SELECT ") + kEscrowCols + " FROM world_escrow WHERE rowid=?";
    sqlite3_stmt* stmt = nullptr;
    if (sqlite3_prepare_v2(db, sql.c_str(), -1, &stmt, nullptr) != SQLITE_OK)
        return std::nullopt;
    sqlite3_bind_int64(stmt, 1, escrowId);
    std::optional<WorldEscrowRecord> out;
    if (sqlite3_step(stmt) == SQLITE_ROW) out = ReadEscrowRow(stmt);
    sqlite3_finalize(stmt);
    return out;
}

std::vector<WorldEscrowRecord> WorldEscrow::ForStaging(sqlite3* db,
                                                       int64_t stagingId) {
    std::vector<WorldEscrowRecord> out;
    if (!db || stagingId <= 0) return out;
    const std::string sql = std::string("SELECT ") + kEscrowCols +
        " FROM world_escrow WHERE staging_id=? ORDER BY rowid ASC";
    sqlite3_stmt* stmt = nullptr;
    if (sqlite3_prepare_v2(db, sql.c_str(), -1, &stmt, nullptr) != SQLITE_OK)
        return out;
    sqlite3_bind_int64(stmt, 1, stagingId);
    while (sqlite3_step(stmt) == SQLITE_ROW) out.push_back(ReadEscrowRow(stmt));
    sqlite3_finalize(stmt);
    return out;
}

int WorldEscrow::MarkEngaged(sqlite3* db, int64_t stagingId, uint32_t roomId,
                             int64_t nowRealMs) {
    if (!db || stagingId <= 0) return 0;
    // Guarded on state — the idempotence IS the guard, same shape as
    // `WorldStaging::MarkMaterialised`. No ledger row: engagement moves the
    // force between two ESCROWED states (§7.3's table), not in or out of the
    // faction's pool.
    static const char* kSql =
        "UPDATE world_escrow SET state='engaged', room_id=?, engaged_at=? "
        "WHERE staging_id=? AND state='committed'";
    sqlite3_stmt* stmt = nullptr;
    if (sqlite3_prepare_v2(db, kSql, -1, &stmt, nullptr) != SQLITE_OK) return 0;
    sqlite3_bind_int64(stmt, 1, static_cast<int64_t>(roomId));
    sqlite3_bind_int64(stmt, 2, nowRealMs);
    sqlite3_bind_int64(stmt, 3, stagingId);
    const bool ok = sqlite3_step(stmt) == SQLITE_DONE;
    const int changed = ok ? sqlite3_changes(db) : 0;
    sqlite3_finalize(stmt);
    return changed;
}

int WorldEscrow::Release(sqlite3* db, int64_t stagingId,
                         const std::string& reason, int64_t nowRealMs) {
    if (!db || stagingId <= 0) return 0;
    int released = 0;
    const bool committed = SqliteWriteTransaction(db, "WorldEscrowRelease", [&] {
        // Read the rows the flip is about to move, so each gets its own
        // refund row — per-commitment, because that is the granularity the
        // escrow promised ("who committed what" survives).
        std::vector<WorldEscrowRecord> rows;
        for (auto& r : ForStaging(db, stagingId))
            if (r.state == WorldEscrowState::Committed) rows.push_back(std::move(r));
        if (rows.empty()) return SQLITE_ABORT;  // nothing to do, by decision

        static const char* kFlip =
            "UPDATE world_escrow SET state='released', outcome=?, resolved_at=? "
            "WHERE staging_id=? AND state='committed'";
        sqlite3_stmt* stmt = nullptr;
        if (sqlite3_prepare_v2(db, kFlip, -1, &stmt, nullptr) != SQLITE_OK)
            return SQLITE_ERROR;
        BindText(stmt, 1, reason);
        sqlite3_bind_int64(stmt, 2, nowRealMs);
        sqlite3_bind_int64(stmt, 3, stagingId);
        const bool ok = sqlite3_step(stmt) == SQLITE_DONE;
        const int changed = ok ? sqlite3_changes(db) : 0;
        sqlite3_finalize(stmt);
        // The flip and the read must agree — inside BEGIN IMMEDIATE they do;
        // disagreement means another writer slipped in and the safe answer is
        // to retry the whole movement.
        if (!ok || changed != static_cast<int>(rows.size()))
            return SQLITE_ERROR;

        for (const auto& r : rows) {
            if (!AppendLedger(db, r.worldId, r.factionId, "escrow_release",
                              r.transports, r.squads, stagingId, 0, nowRealMs))
                return SQLITE_ERROR;
        }
        released = changed;
        return SQLITE_OK;
    });
    // `released` is only meaningful when the transaction actually reached
    // disk — a failed COMMIT rolled the flip back with the refunds.
    return committed ? released : 0;
}

std::vector<int64_t> WorldEscrow::EngagedStagingsForRoom(sqlite3* db,
                                                         uint32_t roomId) {
    std::vector<int64_t> out;
    if (!db || roomId == 0) return out;
    static const char* kSql =
        "SELECT DISTINCT staging_id FROM world_escrow "
        "WHERE room_id=? AND state='engaged' ORDER BY staging_id ASC";
    sqlite3_stmt* stmt = nullptr;
    if (sqlite3_prepare_v2(db, kSql, -1, &stmt, nullptr) != SQLITE_OK) return out;
    sqlite3_bind_int64(stmt, 1, static_cast<int64_t>(roomId));
    while (sqlite3_step(stmt) == SQLITE_ROW)
        out.push_back(sqlite3_column_int64(stmt, 0));
    sqlite3_finalize(stmt);
    return out;
}

WorldEscrowSettleResult WorldEscrow::Settle(sqlite3* db, int64_t stagingId,
                                            const WorldEscrowSettleFacts& facts,
                                            const WorldEscrowRules& rules,
                                            int64_t nowWorldMs, int64_t nowRealMs) {
    WorldEscrowSettleResult res;
    if (!db || stagingId <= 0) return res;

    const bool committed = SqliteWriteTransaction(db, "WorldEscrowSettle", [&] {
        std::vector<WorldEscrowRecord> rows;
        for (auto& r : ForStaging(db, stagingId))
            if (r.state == WorldEscrowState::Engaged) rows.push_back(std::move(r));
        // THE exactly-once gate: a replayed war end (second sweep, restarted
        // lobby) finds nothing engaged and leaves without writing — this
        // ABORT is the idempotence the header promises.
        if (rows.empty()) return SQLITE_ABORT;

        static const char* kFlip =
            "UPDATE world_escrow SET state='settled', outcome=?, resolved_at=? "
            "WHERE staging_id=? AND state='engaged'";
        sqlite3_stmt* stmt = nullptr;
        if (sqlite3_prepare_v2(db, kFlip, -1, &stmt, nullptr) != SQLITE_OK)
            return SQLITE_ERROR;
        BindText(stmt, 1, WorldEscrowOutcomeToString(facts.outcome));
        sqlite3_bind_int64(stmt, 2, nowRealMs);
        sqlite3_bind_int64(stmt, 3, stagingId);
        const bool ok = sqlite3_step(stmt) == SQLITE_DONE;
        const int changed = ok ? sqlite3_changes(db) : 0;
        sqlite3_finalize(stmt);
        if (!ok || changed != static_cast<int>(rows.size()))
            return SQLITE_ERROR;

        WorldEscrowPayout total;
        for (const auto& r : rows) {
            const WorldEscrowPayout p = PayoutFor(
                facts.outcome, r.transports, r.squads, facts.withdrawnFraction,
                rules);
            if (p.returnTransports > 0 || p.returnSquads > 0) {
                if (!AppendLedger(db, r.worldId, r.factionId,
                                  "settlement_return", p.returnTransports,
                                  p.returnSquads, stagingId, r.roomId,
                                  nowRealMs))
                    return SQLITE_ERROR;
            }
            // Captures land with the victor; with no victor named the share
            // is destroyed — no row, which the ledger reads as exactly that.
            if (!facts.victorFactionId.empty() &&
                (p.captureTransports > 0 || p.captureSquads > 0)) {
                if (!AppendLedger(db, r.worldId, facts.victorFactionId,
                                  "settlement_capture", p.captureTransports,
                                  p.captureSquads, stagingId, r.roomId,
                                  nowRealMs))
                    return SQLITE_ERROR;
            }
            total.returnTransports  += p.returnTransports;
            total.returnSquads      += p.returnSquads;
            total.captureTransports += p.captureTransports;
            total.captureSquads     += p.captureSquads;
        }

        // §7.5 "full spoils": one treasury row, once, into the SAME ledger
        // the economy tick appends to — settlement is a world event and its
        // money is auditable in the same place all money is.
        if (facts.outcome == WorldEscrowOutcome::Held &&
            rules.heldSpoilsTreasury > 0.0 && !rows.empty()) {
            static const char* kSpoils =
                "INSERT INTO world_economy_events (world_id, faction_id, "
                "poi_id, source, delta, world_ms, recorded_at) "
                "VALUES (?, ?, ?, 'war_spoils', ?, ?, ?)";
            sqlite3_stmt* sp = nullptr;
            if (sqlite3_prepare_v2(db, kSpoils, -1, &sp, nullptr) != SQLITE_OK)
                return SQLITE_ERROR;
            BindText(sp, 1, rows.front().worldId);
            BindText(sp, 2, rows.front().factionId);
            BindText(sp, 3, rows.front().poiId);
            sqlite3_bind_double(sp, 4, rules.heldSpoilsTreasury);
            sqlite3_bind_int64(sp, 5, nowWorldMs);
            sqlite3_bind_int64(sp, 6, nowRealMs);
            const bool spOk = sqlite3_step(sp) == SQLITE_DONE;
            sqlite3_finalize(sp);
            if (!spOk) return SQLITE_ERROR;
        }

        res.settled = true;
        res.rows    = changed;
        res.payout  = total;
        return SQLITE_OK;
    });
    // The result the body assembled only stands if the COMMIT reached disk —
    // a rolled-back settlement did not happen, and must be reported (and
    // retried by the next sweep) as such.
    if (!committed) return WorldEscrowSettleResult{};
    return res;
}

WorldForceBalance WorldEscrow::ForceBalanceFor(sqlite3* db,
                                               const std::string& worldId,
                                               const std::string& factionId) {
    WorldForceBalance b;
    if (!db || worldId.empty() || factionId.empty()) return b;
    static const char* kSql =
        "SELECT COALESCE(SUM(transports), 0), COALESCE(SUM(squads), 0) "
        "FROM world_force_ledger WHERE world_id=? AND faction_id=?";
    sqlite3_stmt* stmt = nullptr;
    if (sqlite3_prepare_v2(db, kSql, -1, &stmt, nullptr) != SQLITE_OK) return b;
    BindText(stmt, 1, worldId);
    BindText(stmt, 2, factionId);
    if (sqlite3_step(stmt) == SQLITE_ROW) {
        b.transports = sqlite3_column_int(stmt, 0);
        b.squads     = sqlite3_column_int(stmt, 1);
    }
    sqlite3_finalize(stmt);
    return b;
}

std::vector<WorldForceLedgerRow> WorldEscrow::LedgerFor(
    sqlite3* db, const std::string& worldId, const std::string& factionId) {
    std::vector<WorldForceLedgerRow> out;
    if (!db || worldId.empty() || factionId.empty()) return out;
    static const char* kSql =
        "SELECT rowid, world_id, faction_id, source, transports, squads, "
        "staging_id, room_id, recorded_at FROM world_force_ledger "
        "WHERE world_id=? AND faction_id=? ORDER BY rowid ASC";
    sqlite3_stmt* stmt = nullptr;
    if (sqlite3_prepare_v2(db, kSql, -1, &stmt, nullptr) != SQLITE_OK) return out;
    BindText(stmt, 1, worldId);
    BindText(stmt, 2, factionId);
    while (sqlite3_step(stmt) == SQLITE_ROW) {
        WorldForceLedgerRow r;
        r.rowId      = sqlite3_column_int64(stmt, 0);
        r.worldId    = ColText(stmt, 1);
        r.factionId  = ColText(stmt, 2);
        r.source     = ColText(stmt, 3);
        r.transports = sqlite3_column_int(stmt, 4);
        r.squads     = sqlite3_column_int(stmt, 5);
        r.stagingId  = sqlite3_column_int64(stmt, 6);
        r.roomId     = static_cast<uint32_t>(sqlite3_column_int64(stmt, 7));
        r.recordedAt = sqlite3_column_int64(stmt, 8);
        out.push_back(std::move(r));
    }
    sqlite3_finalize(stmt);
    return out;
}

nlohmann::json WorldEscrow::EscrowJson(const WorldEscrowRecord& r) {
    nlohmann::json j;
    j["escrowId"]   = r.escrowId;
    j["stagingId"]  = r.stagingId;
    j["poiId"]      = r.poiId;
    j["factionId"]  = r.factionId;
    j["transports"] = r.transports;
    j["squads"]     = r.squads;
    j["state"]      = WorldEscrowStateToString(r.state);
    j["outcome"]    = r.outcome.empty() ? nlohmann::json(nullptr)
                                        : nlohmann::json(r.outcome);
    j["roomId"] = r.roomId == 0 ? nlohmann::json(nullptr) : nlohmann::json(r.roomId);
    return j;
}
