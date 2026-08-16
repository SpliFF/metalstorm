#include "WarResume.h"

#include <sqlite3.h>

namespace warresume {

// Hibernation.h builds every exit-checkpoint label as
// `"hibernate:" + Describe(reason)`. Matching the prefix rather than the six
// full strings is deliberate: a new ExitReason must not silently start reading
// as a crash here just because this file did not learn its name.
static constexpr const char* kHibernatePrefix = "hibernate:";

bool IsHibernationLabel(const std::string& label) {
    const std::string prefix(kHibernatePrefix);
    return label.size() > prefix.size() &&
           label.compare(0, prefix.size(), prefix) == 0;
}

SnapshotFacts LatestSnapshot(sqlite3* db, const std::string& gameId, uint32_t roomId) {
    SnapshotFacts out;
    if (db == nullptr) return out;
    sqlite3_stmt* st = nullptr;
    // Same ORDER BY as GameStateStore::NewestFrame — `id DESC`, not
    // `frame DESC`. A resumed war re-checkpoints at a HIGHER frame every time,
    // but a GM rollback followed by a checkpoint can store a lower one, and
    // "newest" has to mean "most recently written" for the two files to agree
    // on which blob a `--resume` will actually apply.
    if (sqlite3_prepare_v2(db,
            "SELECT frame, taken_at, label, engine_hash, map_hash"
            " FROM game_snapshots"
            " WHERE game_id = ? AND room_id = ? ORDER BY id DESC LIMIT 1",
            -1, &st, nullptr) != SQLITE_OK) {
        // Missing table on a database no game server has ever opened. Not an
        // error; see the header.
        if (st != nullptr) sqlite3_finalize(st);
        return out;
    }
    sqlite3_bind_text(st, 1, gameId.c_str(), -1, SQLITE_TRANSIENT);
    sqlite3_bind_int(st, 2, static_cast<int>(roomId));
    if (sqlite3_step(st) == SQLITE_ROW) {
        out.has     = true;
        out.frame   = sqlite3_column_int(st, 0);
        out.takenAt = sqlite3_column_int64(st, 1);
        if (const unsigned char* lbl = sqlite3_column_text(st, 2))
            out.label = reinterpret_cast<const char*>(lbl);
        if (const unsigned char* eh = sqlite3_column_text(st, 3))
            out.engineHash = reinterpret_cast<const char*>(eh);
        if (const unsigned char* mh = sqlite3_column_text(st, 4))
            out.mapHash = reinterpret_cast<const char*>(mh);
        out.fromHibernation = IsHibernationLabel(out.label);
    }
    sqlite3_finalize(st);
    return out;
}

int DeleteSnapshotsForRoom(sqlite3* db, uint32_t roomId) {
    if (db == nullptr) return 0;
    sqlite3_stmt* st = nullptr;
    if (sqlite3_prepare_v2(db, "DELETE FROM game_snapshots WHERE room_id = ?",
                           -1, &st, nullptr) != SQLITE_OK) {
        // No table — no game server has ever written here. See the header.
        if (st != nullptr) sqlite3_finalize(st);
        return 0;
    }
    sqlite3_bind_int(st, 1, static_cast<int>(roomId));
    sqlite3_step(st);
    sqlite3_finalize(st);
    return sqlite3_changes(db);
}

const char* ToString(ResumeEligibility e) {
    switch (e) {
        case ResumeEligibility::NoHistory:     return "no_history";
        case ResumeEligibility::Resumable:     return "resumable";
        case ResumeEligibility::EngineChanged: return "engine_changed";
        case ResumeEligibility::MapChanged:    return "map_changed";
        case ResumeEligibility::UnknownBinary: return "unknown_binary";
    }
    return "unknown";
}

bool RefusesResume(ResumeEligibility e) {
    return e == ResumeEligibility::EngineChanged ||
           e == ResumeEligibility::MapChanged;
}

ResumeVerdict DecideResumeEligibility(const SnapshotFacts& snap,
                                     const BinaryIdentity& cur) {
    ResumeVerdict v;
    if (!snap.has) {
        v.eligibility = ResumeEligibility::NoHistory;
        v.reason = "no snapshot history";
        return v;
    }
    // Not probed, or a snapshot written before task 3c stamped the column: the
    // lobby has nothing to compare, so it abstains and the game server's own
    // E1 check stays the only authority. Deliberately NOT a refusal — a
    // pre-flight that fails closed would make a probe failure look like an
    // engine upgrade and reset a live campaign to frame 0.
    if (cur.engineHash.empty() || snap.engineHash.empty()) {
        v.eligibility = ResumeEligibility::UnknownBinary;
        v.reason = "cannot pre-check the snapshot's engine stamp — the game "
                   "server will validate it";
        return v;
    }
    if (snap.engineHash != cur.engineHash) {
        v.eligibility = ResumeEligibility::EngineChanged;
        v.reason = "E1: the frozen world at frame " + std::to_string(snap.frame) +
                   " was taken by engine " + snap.engineHash +
                   " and this server binary is " + cur.engineHash +
                   " — snapshots do not cross a rebuild, so this war restarts "
                   "at frame 0";
        return v;
    }
    // Map second: an engine change makes this question moot, and the reverse is
    // not true (the same binary CAN be pointed at a re-processed map).
    if (!cur.mapHash.empty() && !snap.mapHash.empty() &&
        snap.mapHash != cur.mapHash) {
        v.eligibility = ResumeEligibility::MapChanged;
        v.reason = "E1: the frozen world at frame " + std::to_string(snap.frame) +
                   " is on map '" + snap.mapHash + "' and this room now serves '" +
                   cur.mapHash + "' — this war restarts at frame 0";
        return v;
    }
    v.eligibility = ResumeEligibility::Resumable;
    v.reason = "frozen at frame " + std::to_string(snap.frame) +
               ", loadable by this binary";
    return v;
}

const char* ToString(WarState s) {
    switch (s) {
        case WarState::NotAWar:    return "not_a_war";
        case WarState::Live:       return "live";
        case WarState::Resuming:   return "resuming";
        case WarState::Hibernated: return "hibernated";
        case WarState::Crashed:    return "crashed";
        case WarState::Fresh:      return "fresh";
        case WarState::Finished:   return "finished";
        case WarState::Unresumable: return "unresumable";
    }
    return "unknown";
}

WarState Classify(SessionKind kind, const WarFacts& f) {
    if (kind != SessionKind::PersistentWar)
        return WarState::NotAWar;
    if (f.serverProcessAlive)
        return f.serverReady ? WarState::Live : WarState::Resuming;
    // The war ended and its process has gone. This outranks every question
    // below because none of them apply to a war that is over — and it has to be
    // asked BEFORE `Crashed`, whose test a clean post-game exit passes in full
    // (D4: a war that finished correctly told its players it had been lost).
    if (f.warEnded)
        return WarState::Finished;
    // E1 first among the remaining no-process cases (task 3c) — see the header
    // for why it outranks Crashed.
    if (RefusesResume(DecideResumeEligibility(f.snapshot, f.binary).eligibility))
        return WarState::Unresumable;
    // In flight when the process vanished, with no exit checkpoint to show for
    // it. `onOrphanedRoom` HOLDS a war rather than recycling it, so the room
    // keeps the state it died in and that state is the only record that a match
    // was actually running.
    const bool wasInFlight = (f.roomState == ERoomState::Loading ||
                              f.roomState == ERoomState::Active);
    if (wasInFlight && !f.snapshot.fromHibernation)
        return WarState::Crashed;
    if (f.snapshot.has)
        return WarState::Hibernated;
    return WarState::Fresh;
}

WarJoinPlan PlanJoin(SessionKind kind, const WarFacts& f) {
    WarJoinPlan p;
    p.state = Classify(kind, f);
    if (kind != SessionKind::PersistentWar) {
        p.action = WarJoinAction::None;
        return p;
    }
    if (f.serverProcessAlive) {
        // Includes the E5 case: a second joiner arriving while the first
        // joiner's respawn is still coming up. One process, and this joiner is
        // told which state it is waiting on.
        p.action = WarJoinAction::ConnectToLive;
        return p;
    }
    p.action = WarJoinAction::Spawn;
    // The E1 pre-flight (task 3c). A refused world is not passed `--resume`:
    // the server would abort on it, the room would keep a dead pid, and because
    // this function gates on a live pid the next join would plan the identical
    // spawn — a war unjoinable forever, one aborted process per attempt.
    const ResumeVerdict v = DecideResumeEligibility(f.snapshot, f.binary);
    p.eligibility = v.eligibility;
    if (RefusesResume(v.eligibility)) {
        p.withResume    = false;
        p.resumeFrame   = -1;
        p.lostFrame     = f.snapshot.frame;
        p.blockedReason = v.reason;
        return p;
    }
    p.withResume  = f.snapshot.has;
    p.resumeFrame = f.snapshot.has ? f.snapshot.frame : -1;
    return p;
}

std::string Describe(const WarJoinPlan& p) {
    switch (p.action) {
        case WarJoinAction::None:
            return "not a persistent war — nothing to resume";
        case WarJoinAction::ConnectToLive:
            return p.state == WarState::Live
                       ? std::string("war already live — joining it")
                       : std::string("a server for this war is already coming "
                                     "up — waiting on it (state=resuming)");
        case WarJoinAction::Spawn:
            if (!p.blockedReason.empty()) {
                // The loss is the headline, and the frame that is being lost is
                // named. `resumeFrame` is -1 here by construction.
                return std::string("NOT resuming this war — ") +
                       p.blockedReason + " (state=" + ToString(p.state) + ")";
            }
            if (!p.withResume) {
                return std::string("no snapshot history — launching this war "
                                   "from frame 0 (state=") +
                       ToString(p.state) + ")";
            }
            return std::string("resuming the war from frame ") +
                   std::to_string(p.resumeFrame) + " (state=" +
                   ToString(p.state) + ")";
    }
    return "unknown join plan";
}

}  // namespace warresume
