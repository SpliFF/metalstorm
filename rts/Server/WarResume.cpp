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
            "SELECT frame, taken_at, label FROM game_snapshots"
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
        out.fromHibernation = IsHibernationLabel(out.label);
    }
    sqlite3_finalize(st);
    return out;
}

const char* ToString(WarState s) {
    switch (s) {
        case WarState::NotAWar:    return "not_a_war";
        case WarState::Live:       return "live";
        case WarState::Resuming:   return "resuming";
        case WarState::Hibernated: return "hibernated";
        case WarState::Crashed:    return "crashed";
        case WarState::Fresh:      return "fresh";
    }
    return "unknown";
}

WarState Classify(SessionKind kind, const WarFacts& f) {
    if (kind != SessionKind::PersistentWar)
        return WarState::NotAWar;
    if (f.serverProcessAlive)
        return f.serverReady ? WarState::Live : WarState::Resuming;
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
    p.action      = WarJoinAction::Spawn;
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
