/**
 * GmRollback — the pure rollback orchestration (PLAN-gm-tools task 2, the
 * Opus-flagged verb). Split out of GmVerbs.cpp so this sequence — the "careful
 * semantics" — links into spring-tests without GmVerbs.cpp's sim/net/Lua
 * dependencies, and is exercised against a mock ISnapshotStore in
 * tests/test_gm_rollback.cpp.
 *
 * The only dependency is GmVerbs.h (the ISnapshotStore seam + result types).
 */
#include "GmVerbs.h"

#include <string>

GmRollbackOutcome DoRollback(ISnapshotStore& store, uint32_t roomId, int32_t targetFrame) {
    GmRollbackOutcome o;
    o.targetFrame = targetFrame;

    // 1) A snapshot engine must exist. Until PLAN-persistence lands, this is
    //    the branch every rollback takes — refuse cleanly, touch nothing.
    if (!store.Available()) {
        o.status = GmRollbackStatus::Unavailable;
        o.error = "snapshot store unavailable — persistence layer not built";
        return o;
    }

    // 2) The target frame must be a real snapshot.
    bool found = false;
    for (const auto& s : store.List(roomId)) {
        if (s.frame == targetFrame) { found = true; break; }
    }
    if (!found) {
        o.status = GmRollbackStatus::NoSuchSnapshot;
        o.error = "no snapshot at frame " + std::to_string(targetFrame);
        return o;
    }

    // 3) Checkpoint the CURRENT state BEFORE restoring (E1: evidence + undo).
    //    If this fails, nothing has changed — bail without touching the sim.
    std::string err;
    const int32_t pre = store.Checkpoint(roomId, "pre-rollback", err);
    if (pre < 0) {
        o.status = GmRollbackStatus::CheckpointFailed;
        o.error = err.empty() ? "pre-rollback checkpoint failed" : err;
        return o;
    }
    o.checkpointed = true;
    o.preCheckpointFrame = pre;

    // 4) Restore the target. On failure the pre-checkpoint (o.preCheckpointFrame)
    //    is the undo point — the game is recoverable either way.
    if (!store.Restore(roomId, targetFrame, err)) {
        o.status = GmRollbackStatus::RestoreFailed;
        o.error = err.empty() ? "restore failed" : err;
        return o;
    }
    o.restored = true;
    o.status = GmRollbackStatus::Ok;
    return o;
}
