#include "WarSlotReservation.h"

#include <sqlite3.h>

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

/// Run a COUNT(*)-shaped statement whose binds are (int64, text, [int64...]).
/// `missing` is returned when the statement will not even prepare, which is
/// how a caller distinguishes "the table is not there" from "the count is 0" —
/// the two must not read alike inside a capacity decision.
bool CountQuery(sqlite3* db, const char* sql, uint32_t roomId,
                const std::string& factionId,
                const std::vector<int64_t>& trailingInts, unsigned& out) {
    sqlite3_stmt* stmt = nullptr;
    if (sqlite3_prepare_v2(db, sql, -1, &stmt, nullptr) != SQLITE_OK) {
        sqlite3_finalize(stmt);
        return false;
    }
    int idx = 1;
    sqlite3_bind_int64(stmt, idx++, static_cast<int64_t>(roomId));
    BindText(stmt, idx++, factionId);
    for (const int64_t v : trailingInts)
        sqlite3_bind_int64(stmt, idx++, v);
    bool ok = false;
    if (sqlite3_step(stmt) == SQLITE_ROW) {
        out = static_cast<unsigned>(sqlite3_column_int64(stmt, 0));
        ok = true;
    }
    sqlite3_finalize(stmt);
    return ok;
}

}  // namespace

void WarSlotReservations::EnsureTable(sqlite3* db) {
    if (!db) return;
    // Additive, never probe-and-drop — for a weaker reason than `wars`' (a
    // dropped reservation costs a joiner two minutes, not a war), but the same
    // rule, because the day this table is dropped mid-flight is the day every
    // in-flight join double-books a seat.
    sqlite3_exec(db,
        "CREATE TABLE IF NOT EXISTS war_slot_reservations ("
        "  room_id INTEGER NOT NULL,"
        "  faction_id TEXT NOT NULL,"
        "  account_id INTEGER NOT NULL,"
        "  reserved_at INTEGER NOT NULL DEFAULT 0,"
        "  expires_at INTEGER NOT NULL DEFAULT 0,"
        // One reservation per account per WAR, not per side: an account has
        // exactly one faction (metalstorm §2), so a second row for the same
        // war could only ever be a retry — and keyed per-side it would hold
        // two seats.
        "  PRIMARY KEY (room_id, account_id)"
        ")", nullptr, nullptr, nullptr);
    sqlite3_exec(db,
        "CREATE INDEX IF NOT EXISTS idx_war_slot_res_side "
        "ON war_slot_reservations(room_id, faction_id, expires_at)",
        nullptr, nullptr, nullptr);
    // See the header: without this, losing the race reports a transport error
    // instead of a full side. The lobby's own handle already carries it
    // (`SqliteConfigureSharedHandle`); this is for every other opener — a
    // test, a tool, the game server — so the guarantee travels with the table
    // rather than with one call site's setup.
    sqlite3_busy_timeout(db, kSqliteBusyTimeoutMs);
}

SlotReserveResult WarSlotReservations::Reserve(sqlite3* db, uint32_t roomId,
                                               const std::string& factionId,
                                               int64_t accountId, int64_t now,
                                               int ttlSeconds) {
    SlotReserveResult r;
    if (!db || factionId.empty() || accountId <= 0)
        return r;
    if (ttlSeconds <= 0)
        ttlSeconds = WAR_SLOT_RESERVATION_TTL_SECONDS;

    // The write lock is taken HERE, before the first read, and that ordering
    // is the whole point: a deferred transaction would read the counts under a
    // shared lock, and two of them would both see the same free seat before
    // either tried to write.
    if (sqlite3_exec(db, "BEGIN IMMEDIATE", nullptr, nullptr, nullptr) !=
        SQLITE_OK) {
        return r;  // Error — busy past the timeout. Fail closed.
    }

    auto finish = [&](SlotReserveOutcome outcome, bool commit) {
        r.outcome = outcome;
        sqlite3_exec(db, commit ? "COMMIT" : "ROLLBACK", nullptr, nullptr,
                     nullptr);
        return r;
    };

    // 1. The side, and its cap. No row → this war does not field that faction.
    {
        sqlite3_stmt* stmt = nullptr;
        const char* kSql =
            "SELECT slot_cap FROM war_sides WHERE room_id=? AND faction_id=?";
        if (sqlite3_prepare_v2(db, kSql, -1, &stmt, nullptr) != SQLITE_OK) {
            sqlite3_finalize(stmt);
            return finish(SlotReserveOutcome::Error, false);
        }
        sqlite3_bind_int64(stmt, 1, static_cast<int64_t>(roomId));
        BindText(stmt, 2, factionId);
        const bool found = sqlite3_step(stmt) == SQLITE_ROW;
        if (found)
            r.slotCap = static_cast<unsigned>(sqlite3_column_int64(stmt, 0));
        sqlite3_finalize(stmt);
        if (!found)
            return finish(SlotReserveOutcome::NoSuchSide, false);
    }

    // 2. Already seated? A rejoin holds its seat already (WarRejoinPolicy's
    // `bypassCapacity` is the same rule stated from the seating side), so it
    // needs no reservation — and taking one would count the returning player
    // against the cap a second time. Any stale reservation of theirs is
    // dropped on the way out for exactly that reason.
    {
        unsigned mine = 0;
        if (!CountQuery(db,
                "SELECT COUNT(*) FROM war_player_bindings "
                "WHERE room_id=? AND faction_id=? AND account_id=?",
                roomId, factionId, {accountId}, mine))
            return finish(SlotReserveOutcome::Error, false);
        if (mine > 0) {
            sqlite3_stmt* stmt = nullptr;
            if (sqlite3_prepare_v2(db,
                    "DELETE FROM war_slot_reservations "
                    "WHERE room_id=? AND account_id=?",
                    -1, &stmt, nullptr) == SQLITE_OK) {
                sqlite3_bind_int64(stmt, 1, static_cast<int64_t>(roomId));
                sqlite3_bind_int64(stmt, 2, accountId);
                sqlite3_step(stmt);
            }
            sqlite3_finalize(stmt);
            return finish(SlotReserveOutcome::AlreadySeated, true);
        }
    }

    // 3. The count the decision is made on: durable seats plus seats held by
    // somebody else's in-flight join. This account is excluded from both — it
    // holds neither (2 just proved it is not bound), and its own outstanding
    // reservation is a retry, not a rival.
    if (!CountQuery(db,
            "SELECT COUNT(*) FROM war_player_bindings "
            "WHERE room_id=? AND faction_id=? AND account_id<>?",
            roomId, factionId, {accountId}, r.bound))
        return finish(SlotReserveOutcome::Error, false);
    if (!CountQuery(db,
            "SELECT COUNT(*) FROM war_slot_reservations r "
            "WHERE r.room_id=? AND r.faction_id=? AND r.expires_at>? "
            "  AND r.account_id<>? "
            // A reservation whose join COMPLETED is not a second seat. The
            // process that seats a player is the game server (it writes the
            // binding) and it has no reason to call back into the lobby, so
            // the release is expressed here as a fact rather than as an event
            // somebody has to remember to send: once the binding exists, the
            // reservation stops counting, immediately and everywhere. Without
            // this the joiner holds two seats against their own side for the
            // rest of the TTL.
            "  AND NOT EXISTS (SELECT 1 FROM war_player_bindings b "
            "                  WHERE b.room_id=r.room_id "
            "                    AND b.account_id=r.account_id)",
            roomId, factionId, {now, accountId}, r.reserved))
        return finish(SlotReserveOutcome::Error, false);

    // Cap 0 is unlimited. Otherwise the side is full when every seat is
    // spoken for, and `>=` rather than `>` because the seat being asked for
    // is the one after the ones counted.
    if (r.slotCap != 0 && r.bound + r.reserved >= r.slotCap)
        return finish(SlotReserveOutcome::SideFull, false);

    // 4. Did this account already hold a live one? Read before the upsert so
    // the outcome can tell a first grant from a retry.
    bool renewed = false;
    {
        unsigned live = 0;
        if (CountQuery(db,
                "SELECT COUNT(*) FROM war_slot_reservations "
                "WHERE room_id=? AND faction_id=? AND expires_at>? "
                "  AND account_id=?",
                roomId, factionId, {now, accountId}, live))
            renewed = live > 0;
    }

    {
        static const char* kSql =
            "INSERT INTO war_slot_reservations "
            "  (room_id, faction_id, account_id, reserved_at, expires_at) "
            "VALUES (?, ?, ?, ?, ?) "
            "ON CONFLICT(room_id, account_id) DO UPDATE SET "
            // The faction is re-asserted rather than left alone: an account
            // whose faction was overridden by an operator (§1b) must not keep
            // a seat reserved on the side it no longer belongs to.
            "  faction_id=excluded.faction_id,"
            "  reserved_at=excluded.reserved_at,"
            "  expires_at=excluded.expires_at";
        sqlite3_stmt* stmt = nullptr;
        if (sqlite3_prepare_v2(db, kSql, -1, &stmt, nullptr) != SQLITE_OK) {
            sqlite3_finalize(stmt);
            return finish(SlotReserveOutcome::Error, false);
        }
        r.expiresAt = now + ttlSeconds;
        sqlite3_bind_int64(stmt, 1, static_cast<int64_t>(roomId));
        BindText(stmt, 2, factionId);
        sqlite3_bind_int64(stmt, 3, accountId);
        sqlite3_bind_int64(stmt, 4, now);
        sqlite3_bind_int64(stmt, 5, r.expiresAt);
        const bool ok = sqlite3_step(stmt) == SQLITE_DONE;
        sqlite3_finalize(stmt);
        if (!ok) {
            r.expiresAt = 0;
            return finish(SlotReserveOutcome::Error, false);
        }
    }

    return finish(renewed ? SlotReserveOutcome::Renewed
                          : SlotReserveOutcome::Granted,
                  true);
}

bool WarSlotReservations::Release(sqlite3* db, uint32_t roomId,
                                  int64_t accountId) {
    if (!db) return false;
    sqlite3_stmt* stmt = nullptr;
    if (sqlite3_prepare_v2(db,
            "DELETE FROM war_slot_reservations "
            "WHERE room_id=? AND account_id=?",
            -1, &stmt, nullptr) != SQLITE_OK) {
        sqlite3_finalize(stmt);
        return false;
    }
    sqlite3_bind_int64(stmt, 1, static_cast<int64_t>(roomId));
    sqlite3_bind_int64(stmt, 2, accountId);
    const bool stepped = sqlite3_step(stmt) == SQLITE_DONE;
    sqlite3_finalize(stmt);
    return stepped && sqlite3_changes(db) > 0;
}

int WarSlotReservations::ReleaseExpired(sqlite3* db, int64_t now) {
    if (!db) return 0;
    sqlite3_stmt* stmt = nullptr;
    if (sqlite3_prepare_v2(db,
            "DELETE FROM war_slot_reservations WHERE expires_at<=?", -1, &stmt,
            nullptr) != SQLITE_OK) {
        sqlite3_finalize(stmt);
        return 0;
    }
    sqlite3_bind_int64(stmt, 1, now);
    const bool stepped = sqlite3_step(stmt) == SQLITE_DONE;
    const int n = stepped ? sqlite3_changes(db) : 0;
    sqlite3_finalize(stmt);
    return n;
}

unsigned WarSlotReservations::LiveCount(sqlite3* db, uint32_t roomId,
                                        const std::string& factionId,
                                        int64_t now) {
    if (!db) return 0;
    unsigned n = 0;
    // Same exclusion as `Reserve`'s own count, and it must stay the same: a
    // capacity read that disagreed with the transaction that enforces it would
    // show a full war to the browser and seat somebody anyway.
    CountQuery(db,
        "SELECT COUNT(*) FROM war_slot_reservations r "
        "WHERE r.room_id=? AND r.faction_id=? AND r.expires_at>? "
        "  AND NOT EXISTS (SELECT 1 FROM war_player_bindings b "
        "                  WHERE b.room_id=r.room_id "
        "                    AND b.account_id=r.account_id)",
        roomId, factionId, {now}, n);
    return n;
}

std::optional<WarSlotReservation> WarSlotReservations::Find(sqlite3* db,
                                                            uint32_t roomId,
                                                            int64_t accountId) {
    if (!db) return std::nullopt;
    sqlite3_stmt* stmt = nullptr;
    if (sqlite3_prepare_v2(db,
            "SELECT room_id, faction_id, account_id, reserved_at, expires_at "
            "FROM war_slot_reservations WHERE room_id=? AND account_id=?",
            -1, &stmt, nullptr) != SQLITE_OK) {
        sqlite3_finalize(stmt);
        return std::nullopt;
    }
    sqlite3_bind_int64(stmt, 1, static_cast<int64_t>(roomId));
    sqlite3_bind_int64(stmt, 2, accountId);
    std::optional<WarSlotReservation> out;
    if (sqlite3_step(stmt) == SQLITE_ROW) {
        WarSlotReservation v;
        v.roomId     = static_cast<uint32_t>(sqlite3_column_int64(stmt, 0));
        v.factionId  = ColText(stmt, 1);
        v.accountId  = sqlite3_column_int64(stmt, 2);
        v.reservedAt = sqlite3_column_int64(stmt, 3);
        v.expiresAt  = sqlite3_column_int64(stmt, 4);
        out = std::move(v);
    }
    sqlite3_finalize(stmt);
    return out;
}

std::vector<WarSlotReservation> WarSlotReservations::ForRoom(sqlite3* db,
                                                             uint32_t roomId,
                                                             int64_t now) {
    std::vector<WarSlotReservation> out;
    if (!db) return out;
    sqlite3_stmt* stmt = nullptr;
    if (sqlite3_prepare_v2(db,
            "SELECT room_id, faction_id, account_id, reserved_at, expires_at "
            "FROM war_slot_reservations WHERE room_id=? AND expires_at>? "
            "ORDER BY reserved_at ASC, account_id ASC",
            -1, &stmt, nullptr) != SQLITE_OK) {
        sqlite3_finalize(stmt);
        return out;
    }
    sqlite3_bind_int64(stmt, 1, static_cast<int64_t>(roomId));
    sqlite3_bind_int64(stmt, 2, now);
    while (sqlite3_step(stmt) == SQLITE_ROW) {
        WarSlotReservation v;
        v.roomId     = static_cast<uint32_t>(sqlite3_column_int64(stmt, 0));
        v.factionId  = ColText(stmt, 1);
        v.accountId  = sqlite3_column_int64(stmt, 2);
        v.reservedAt = sqlite3_column_int64(stmt, 3);
        v.expiresAt  = sqlite3_column_int64(stmt, 4);
        out.push_back(std::move(v));
    }
    sqlite3_finalize(stmt);
    return out;
}

int WarSlotReservations::DeleteForRoom(sqlite3* db, uint32_t roomId) {
    if (!db) return 0;
    sqlite3_stmt* stmt = nullptr;
    if (sqlite3_prepare_v2(db,
            "DELETE FROM war_slot_reservations WHERE room_id=?", -1, &stmt,
            nullptr) != SQLITE_OK) {
        sqlite3_finalize(stmt);
        return 0;
    }
    sqlite3_bind_int64(stmt, 1, static_cast<int64_t>(roomId));
    const bool stepped = sqlite3_step(stmt) == SQLITE_DONE;
    const int n = stepped ? sqlite3_changes(db) : 0;
    sqlite3_finalize(stmt);
    return n;
}
