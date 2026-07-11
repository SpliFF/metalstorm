#include <doctest/doctest.h>

#include "Server/GmVerbs.h"

#include <string>
#include <vector>

// PLAN-gm-tools task 2 — the Opus-flagged rollback semantics. DoRollback is the
// pure sequence (Available → target-exists → pre-checkpoint → restore); these
// tests drive it against a recording mock ISnapshotStore and assert BOTH the
// outcome status AND the call ORDER — the pre-checkpoint-before-restore
// invariant (E1: a mistaken rollback is itself undoable) is the whole point.

namespace {

struct MockStore : ISnapshotStore {
    bool available = true;
    std::vector<SnapshotInfo> snaps;
    int32_t checkpointFrame = 900;   // frame Checkpoint returns (>=0 = success)
    bool checkpointOk = true;
    bool restoreOk = true;

    // Recording, in call order.
    std::vector<std::string> calls;
    int32_t restoredFrame = -1;

    bool Available() const override { return available; }

    std::vector<SnapshotInfo> List(uint32_t) override {
        calls.push_back("List");
        return snaps;
    }
    int32_t Checkpoint(uint32_t, const std::string& label, std::string& err) override {
        calls.push_back("Checkpoint:" + label);
        if (!checkpointOk) { err = "checkpoint boom"; return -1; }
        return checkpointFrame;
    }
    bool Restore(uint32_t, int32_t frame, std::string& err) override {
        calls.push_back("Restore:" + std::to_string(frame));
        if (!restoreOk) { err = "restore boom"; return false; }
        restoredFrame = frame;
        return true;
    }
};

SnapshotInfo snap(int32_t f) { SnapshotInfo s; s.frame = f; return s; }

}  // namespace

TEST_CASE("DoRollback refuses cleanly when no snapshot store is available") {
    // The NullSnapshotStore case — every rollback today. Nothing is touched.
    MockStore store;
    store.available = false;

    auto o = DoRollback(store, 1, 500);

    CHECK(o.status == GmRollbackStatus::Unavailable);
    CHECK_FALSE(o.checkpointed);
    CHECK_FALSE(o.restored);
    CHECK(store.calls.empty());   // no List/Checkpoint/Restore attempted
}

TEST_CASE("NullSnapshotStore reports unavailable and refuses restore") {
    NullSnapshotStore store;
    CHECK_FALSE(store.Available());
    auto o = DoRollback(store, 1, 100);
    CHECK(o.status == GmRollbackStatus::Unavailable);
}

TEST_CASE("DoRollback rejects a frame that is not a real snapshot") {
    MockStore store;
    store.snaps = { snap(100), snap(200), snap(300) };

    auto o = DoRollback(store, 1, 250);   // 250 is between snapshots, not one

    CHECK(o.status == GmRollbackStatus::NoSuchSnapshot);
    CHECK_FALSE(o.checkpointed);
    CHECK_FALSE(o.restored);
    // It checked the list but never checkpointed or restored.
    REQUIRE(store.calls.size() == 1);
    CHECK(store.calls[0] == "List");
}

TEST_CASE("DoRollback checkpoints the current state BEFORE restoring (E1 order)") {
    MockStore store;
    store.snaps = { snap(200) };
    store.checkpointFrame = 640;   // current frame captured as the undo point

    auto o = DoRollback(store, 7, 200);

    CHECK(o.status == GmRollbackStatus::Ok);
    CHECK(o.checkpointed);
    CHECK(o.restored);
    CHECK(o.preCheckpointFrame == 640);   // the undo snapshot
    CHECK(o.targetFrame == 200);
    CHECK(store.restoredFrame == 200);

    // The critical invariant: List, then Checkpoint (pre-rollback), then Restore
    // — the pre-rollback checkpoint must precede the restore.
    REQUIRE(store.calls.size() == 3);
    CHECK(store.calls[0] == "List");
    CHECK(store.calls[1] == "Checkpoint:pre-rollback");
    CHECK(store.calls[2] == "Restore:200");
}

TEST_CASE("DoRollback aborts without restoring if the pre-checkpoint fails") {
    MockStore store;
    store.snaps = { snap(200) };
    store.checkpointOk = false;   // can't make the undo snapshot

    auto o = DoRollback(store, 1, 200);

    CHECK(o.status == GmRollbackStatus::CheckpointFailed);
    CHECK_FALSE(o.checkpointed);
    CHECK_FALSE(o.restored);
    CHECK(store.restoredFrame == -1);   // sim state never touched
    CHECK(o.error == "checkpoint boom");
    // Attempted the checkpoint, but never the restore.
    REQUIRE(store.calls.size() == 2);
    CHECK(store.calls[1] == "Checkpoint:pre-rollback");
}

TEST_CASE("DoRollback preserves the undo point when the restore itself fails") {
    MockStore store;
    store.snaps = { snap(200) };
    store.checkpointFrame = 640;
    store.restoreOk = false;

    auto o = DoRollback(store, 1, 200);

    CHECK(o.status == GmRollbackStatus::RestoreFailed);
    CHECK(o.checkpointed);                 // the pre-checkpoint DID succeed...
    CHECK(o.preCheckpointFrame == 640);    // ...so the game is still recoverable
    CHECK_FALSE(o.restored);
    CHECK(o.error == "restore boom");
}
