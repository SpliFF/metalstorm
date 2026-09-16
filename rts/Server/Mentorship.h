// Mentorship — the mentor↔mentee relation and the rules that move it.
//
// PLAN-beta-journey.md §0/§(b)/§(d). A mentorship is a lobby row mirrored into
// the sim as a custom option; nothing here touches the sim, a room, or a
// socket. Header-only inline because every function is a handful of plain
// SQLite statements over two tables, the way Standing.h is a handful of
// comparisons — there is no state to hold and no second translation unit that
// would benefit from one.
//
// ── The invariant: one live mentorship per mentee ──────────────────────────
// Offered and active both count as live. A mentee with two offers open has to
// be shown a queue, and a mentee with two ACTIVE mentors has two people
// issuing orders at tier+∞ over them — which is the one thing the rank
// precedence rule in game_assignment.lua cannot arbitrate, because neither
// mentor outranks the other *as a mentor*. So the second offer is refused at
// the door rather than resolved later.
//
// Mentee-keyed rather than pair-keyed for the same reason: the constraint is a
// property of the person being mentored, not of the pair.
#pragma once

#include <cstdint>
#include <optional>
#include <string>

#include <sqlite3.h>

namespace Mentorship {

/// `mentor_id` for the AI fallback. 0 rather than NULL so the column stays
/// NOT NULL and "who is mentoring" is one integer comparison everywhere,
/// including in the sim, where the mirrored option is `-1` for AI.
constexpr int64_t kAiMentorId = 0;

/// Seconds in the endorsement day-bucket. One endorsement per mentor→mentee
/// per day is the whole rate limit on `+15` standing (§0 accrual) — without
/// it a pair of accounts is a standing faucet.
constexpr int64_t kEndorsementDaySeconds = 24 * 60 * 60;

struct Record {
    int64_t     id = 0;
    int64_t     mentorId = 0;     ///< kAiMentorId for the AI fallback
    int64_t     menteeId = 0;
    std::string kind;             ///< "human" | "ai"
    std::string state;            ///< "offered" | "active" | "ended"
    int64_t     createdAt = 0;
    int64_t     endedAt = 0;
};

enum class Status {
    OK,
    AlreadyMentored,  ///< the mentee already has a live (offered or active) row
    SelfMentor,       ///< a mentor cannot mentor themselves
    NotFound,         ///< no such row, or it is not live any more
    NotYours,         ///< the caller is not a party to this mentorship
    Failed,           ///< the write did not land
};

/// Both tables, additive and idempotent. Called from Database::Initialize so
/// every process that opens the lobby db — lobby, game server, tests — finds
/// them present whether or not it registers a mentor route.
inline void EnsureTables(sqlite3* db) {
    if (!db) return;
    sqlite3_exec(db,
        "CREATE TABLE IF NOT EXISTS mentorships ("
        "  id INTEGER PRIMARY KEY AUTOINCREMENT,"
        "  mentor_id INTEGER NOT NULL,"
        "  mentee_id INTEGER NOT NULL REFERENCES users(id),"
        "  kind TEXT NOT NULL,"
        "  state TEXT NOT NULL,"
        "  created_at INTEGER NOT NULL,"
        "  ended_at INTEGER NOT NULL DEFAULT 0"
        ")", nullptr, nullptr, nullptr);
    sqlite3_exec(db,
        "CREATE INDEX IF NOT EXISTS idx_mentorships_mentee "
        "ON mentorships(mentee_id, state)", nullptr, nullptr, nullptr);
    // No AUTOINCREMENT id: the row IS its key, and the composite primary key
    // is what makes the once-a-day rule an INSERT OR IGNORE rather than a
    // read-then-write with a race in the middle.
    sqlite3_exec(db,
        "CREATE TABLE IF NOT EXISTS mentor_endorsements ("
        "  mentor_id INTEGER NOT NULL,"
        "  mentee_id INTEGER NOT NULL,"
        "  day INTEGER NOT NULL,"
        "  PRIMARY KEY(mentor_id, mentee_id, day)"
        ")", nullptr, nullptr, nullptr);
}

namespace detail {

inline std::optional<Record> ReadOne(sqlite3* db, const char* where,
                                     int64_t key) {
    if (!db) return std::nullopt;
    const std::string sql =
        std::string("SELECT id, mentor_id, mentee_id, kind, state, created_at, "
                    "ended_at FROM mentorships WHERE ") + where +
        " ORDER BY id DESC LIMIT 1";
    sqlite3_stmt* stmt = nullptr;
    if (sqlite3_prepare_v2(db, sql.c_str(), -1, &stmt, nullptr) != SQLITE_OK) {
        sqlite3_finalize(stmt);
        return std::nullopt;
    }
    sqlite3_bind_int64(stmt, 1, key);
    std::optional<Record> out;
    if (sqlite3_step(stmt) == SQLITE_ROW) {
        Record r;
        r.id        = sqlite3_column_int64(stmt, 0);
        r.mentorId  = sqlite3_column_int64(stmt, 1);
        r.menteeId  = sqlite3_column_int64(stmt, 2);
        const unsigned char* kind  = sqlite3_column_text(stmt, 3);
        const unsigned char* state = sqlite3_column_text(stmt, 4);
        r.kind      = kind ? reinterpret_cast<const char*>(kind) : "";
        r.state     = state ? reinterpret_cast<const char*>(state) : "";
        r.createdAt = sqlite3_column_int64(stmt, 5);
        r.endedAt   = sqlite3_column_int64(stmt, 6);
        out = r;
    }
    sqlite3_finalize(stmt);
    return out;
}

}  // namespace detail

/// The mentee's live mentorship — offered OR active — or nullopt. The one
/// read `/api/account/me` and the offer gate both go through, so "live" has a
/// single definition.
inline std::optional<Record> ActiveFor(sqlite3* db, int64_t menteeId) {
    if (menteeId <= 0) return std::nullopt;
    return detail::ReadOne(db,
        "mentee_id = ? AND state IN ('offered','active')", menteeId);
}

/// A mentorship by id, whatever its state.
inline std::optional<Record> ById(sqlite3* db, int64_t id) {
    if (id <= 0) return std::nullopt;
    return detail::ReadOne(db, "id = ?", id);
}

struct OfferResult {
    Status  status = Status::OK;
    int64_t id = 0;
};

/// Offer a mentorship. A human offer lands `offered` and waits for Respond;
/// an AI one (`mentorId == kAiMentorId`) lands `active` immediately, because
/// the mentee asking for it IS the acceptance — there is nobody on the other
/// side to answer.
inline OfferResult Offer(sqlite3* db, int64_t mentorId, int64_t menteeId,
                         int64_t now) {
    OfferResult res;
    if (!db || menteeId <= 0 || mentorId < 0) {
        res.status = Status::Failed;
        return res;
    }
    if (mentorId == menteeId) {
        res.status = Status::SelfMentor;
        return res;
    }
    if (ActiveFor(db, menteeId)) {
        res.status = Status::AlreadyMentored;
        return res;
    }
    const bool ai = (mentorId == kAiMentorId);
    sqlite3_stmt* stmt = nullptr;
    if (sqlite3_prepare_v2(db,
            "INSERT INTO mentorships (mentor_id, mentee_id, kind, state, "
            "created_at, ended_at) VALUES (?, ?, ?, ?, ?, 0)", -1, &stmt,
            nullptr) != SQLITE_OK) {
        sqlite3_finalize(stmt);
        res.status = Status::Failed;
        return res;
    }
    sqlite3_bind_int64(stmt, 1, mentorId);
    sqlite3_bind_int64(stmt, 2, menteeId);
    sqlite3_bind_text(stmt, 3, ai ? "ai" : "human", -1, SQLITE_STATIC);
    sqlite3_bind_text(stmt, 4, ai ? "active" : "offered", -1, SQLITE_STATIC);
    sqlite3_bind_int64(stmt, 5, now);
    const bool ok = sqlite3_step(stmt) == SQLITE_DONE;
    sqlite3_finalize(stmt);
    if (!ok) {
        res.status = Status::Failed;
        return res;
    }
    res.id = sqlite3_last_insert_rowid(db);
    return res;
}

/// The mentee answers an offer. Accepting moves it to `active`; declining
/// ends it, which is what keeps "declining keeps independence" (PLAN-beta.md
/// §5) a state the next offer can be made against rather than a dead row that
/// blocks every future one.
///
/// `menteeId` is the CALLER, checked against the row — an offer is answered by
/// the person it was made to and by nobody else.
inline Status Respond(sqlite3* db, int64_t id, int64_t menteeId, bool accept,
                      int64_t now) {
    auto row = ById(db, id);
    if (!row || row->state != "offered") return Status::NotFound;
    if (row->menteeId != menteeId) return Status::NotYours;

    sqlite3_stmt* stmt = nullptr;
    if (sqlite3_prepare_v2(db,
            "UPDATE mentorships SET state = ?, ended_at = ? "
            "WHERE id = ? AND state = 'offered'", -1, &stmt, nullptr) != SQLITE_OK) {
        sqlite3_finalize(stmt);
        return Status::Failed;
    }
    sqlite3_bind_text(stmt, 1, accept ? "active" : "ended", -1, SQLITE_STATIC);
    sqlite3_bind_int64(stmt, 2, accept ? 0 : now);
    sqlite3_bind_int64(stmt, 3, id);
    const bool ok = sqlite3_step(stmt) == SQLITE_DONE;
    sqlite3_finalize(stmt);
    // `AND state = 'offered'` is the concurrency control, not a re-check: two
    // responses racing both pass the read above and only one writes.
    if (!ok || sqlite3_changes(db) == 0) return Status::Failed;
    return Status::OK;
}

/// End the mentee's live mentorship. Either party may call it — a mentorship
/// neither side can walk out of is a trap, and the mentee is the one who needs
/// the exit most.
inline Status End(sqlite3* db, int64_t menteeId, int64_t callerId, int64_t now) {
    auto row = ActiveFor(db, menteeId);
    if (!row) return Status::NotFound;
    if (callerId != row->menteeId && callerId != row->mentorId)
        return Status::NotYours;

    sqlite3_stmt* stmt = nullptr;
    if (sqlite3_prepare_v2(db,
            "UPDATE mentorships SET state = 'ended', ended_at = ? "
            "WHERE id = ? AND state IN ('offered','active')", -1, &stmt,
            nullptr) != SQLITE_OK) {
        sqlite3_finalize(stmt);
        return Status::Failed;
    }
    sqlite3_bind_int64(stmt, 1, now);
    sqlite3_bind_int64(stmt, 2, row->id);
    const bool ok = sqlite3_step(stmt) == SQLITE_DONE;
    sqlite3_finalize(stmt);
    if (!ok || sqlite3_changes(db) == 0) return Status::Failed;
    return Status::OK;
}

/// Record a mentor's endorsement of a mentee for the day `now` falls in.
/// Returns true only when the row is NEW — that boolean is what the caller
/// turns into `+15` standing, so a repeat endorsement on the same day is
/// silently free rather than an error the mentor has to understand.
inline bool Endorse(sqlite3* db, int64_t mentorId, int64_t menteeId,
                    int64_t now) {
    if (!db || mentorId <= 0 || menteeId <= 0 || mentorId == menteeId)
        return false;
    sqlite3_stmt* stmt = nullptr;
    if (sqlite3_prepare_v2(db,
            "INSERT OR IGNORE INTO mentor_endorsements (mentor_id, mentee_id, day) "
            "VALUES (?, ?, ?)", -1, &stmt, nullptr) != SQLITE_OK) {
        sqlite3_finalize(stmt);
        return false;
    }
    sqlite3_bind_int64(stmt, 1, mentorId);
    sqlite3_bind_int64(stmt, 2, menteeId);
    sqlite3_bind_int64(stmt, 3, now / kEndorsementDaySeconds);
    const bool ok = sqlite3_step(stmt) == SQLITE_DONE;
    sqlite3_finalize(stmt);
    return ok && sqlite3_changes(db) > 0;
}

}  // namespace Mentorship
