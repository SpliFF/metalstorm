#include <doctest/doctest.h>

#include "Server/RoomManager.h"
#include "Server/SqliteThreading.h"

#include <sqlite3.h>

#include <chrono>
#include <atomic>
#include <unistd.h>
#include <filesystem>
#include <string>
#include <thread>

// PLAN-endtoend.md §Defect register D35 — the residual left after the busy
// timeout landed.
//
// `data/spring-server.db` is a multi-process backchannel and SQLite gives it
// one writer at a time. `kSqliteBusyTimeoutMs` makes a writer *wait* for the
// lock; it does not make the write *happen*. When the wait expired, every
// persist path in RoomManager logged a warning and carried on, so the room's
// row (or half of it) silently never reached disk — the same player-visible
// outcome as D33 by a different route.
//
// Two properties are pinned here:
//
//  1. **One room persist is one transaction.** It used to be four — the
//     `rooms` row in autocommit plus a separate BEGIN/COMMIT in each of
//     PersistMembers / PersistAISlots / PersistModOptions — which took the
//     single write lock four times per room and let a reader see a room whose
//     roster was gone and not yet rewritten.
//  2. **A write that loses the lock is retried, not dropped.**

namespace {

struct TempDb {
    std::filesystem::path path;
    sqlite3* db = nullptr;

    explicit TempDb(const char* stem) {
        path = std::filesystem::temp_directory_path() /
               (std::string("springrts-d35-") + stem + "-" +
                std::to_string(::getpid()) + ".db");
        std::filesystem::remove(path);
        REQUIRE(sqlite3_open(path.string().c_str(), &db) == SQLITE_OK);
        sqlite3_exec(db, "PRAGMA journal_mode=WAL", nullptr, nullptr, nullptr);
        RoomManager::EnsureTables(db);
    }
    ~TempDb() {
        if (db) sqlite3_close(db);
        std::error_code ec;
        std::filesystem::remove(path, ec);
        std::filesystem::remove(path.string() + "-wal", ec);
        std::filesystem::remove(path.string() + "-shm", ec);
    }
};

int CountRows(sqlite3* db, const char* sql) {
    sqlite3_stmt* st = nullptr;
    if (sqlite3_prepare_v2(db, sql, -1, &st, nullptr) != SQLITE_OK) return -1;
    const int n = (sqlite3_step(st) == SQLITE_ROW) ? sqlite3_column_int(st, 0) : -1;
    sqlite3_finalize(st);
    return n;
}

// Seat a host plus one AI and one mod option, so all three child tables have
// something to write. Returns the room id.
uint32_t makeFurnishedRoom(RoomManager& rooms) {
    const uint32_t roomId = rooms.CreateRoom(
        "d35 room", "test_map", "test_game", /*maxPlayers=*/8,
        /*password=*/"", /*hostPlayerId=*/1, /*hostClientId=*/1, "host");
    REQUIRE(rooms.AddAISlot(roomId, /*requesterId=*/1, "strategos",
        "Strategos", /*team=*/1));
    return roomId;
}

} // namespace

TEST_CASE("D35: persisting one room takes the write lock once, not four times") {
    TempDb t("commits");
    RoomManager rooms;
    rooms.SetDatabase(t.db);

    // Count committed write transactions on this handle. sqlite3_commit_hook
    // fires once per COMMIT, including the implicit one around a statement in
    // autocommit mode — which is exactly what makes the four-transaction shape
    // visible: pre-fix this reads 4 (rooms row, members, ai slots, mod
    // options), post-fix 1.
    int commits = 0;
    sqlite3_commit_hook(t.db, [](void* p) -> int {
        ++*static_cast<int*>(p);
        return 0;
    }, &commits);

    const uint32_t roomId = makeFurnishedRoom(rooms);
    REQUIRE(roomId != 0);

    commits = 0;
    // SetRoomState is a plain room-row mutation that write-throughs the whole
    // room; any PersistRoomLocked caller would do.
    rooms.SetRoomState(roomId, ERoomState::ReadyCheck);

    sqlite3_commit_hook(t.db, nullptr, nullptr);
    CHECK(commits == 1);

    // …and the transaction really did carry every table, not just the row.
    CHECK(CountRows(t.db, "SELECT count(*) FROM rooms") == 1);
    CHECK(CountRows(t.db, "SELECT count(*) FROM room_members") == 1);
    CHECK(CountRows(t.db, "SELECT count(*) FROM room_ai_slots") == 1);
}

TEST_CASE("D35: a write that loses the lock is retried, not dropped") {
    TempDb t("retry");
    RoomManager rooms;
    rooms.SetDatabase(t.db);
    const uint32_t roomId = makeFurnishedRoom(rooms);
    REQUIRE(roomId != 0);

    // Zero busy timeout: the writer gets SQLITE_BUSY the instant the lock is
    // held, so the wait policy is out of the picture and only the retry policy
    // can save the write. Standing in for the production case, where the wait
    // policy is 5 s and the competing writer outlasts it — same code path, and
    // it runs in a fraction of a second instead of fifteen.
    sqlite3_busy_timeout(t.db, 0);

    // A second connection holds the lock for long enough to lose the first
    // attempt and short enough to let a later one through. Attempts land at
    // ~0 ms, ~50 ms and ~150 ms (`SqliteBusyBackoffMs`), so a 40 ms hold loses
    // one attempt and leaves two, i.e. ~110 ms of slack before this could go
    // flaky on a loaded machine.
    std::atomic<bool> holding{false};
    std::thread holder([&] {
        sqlite3* other = nullptr;
        REQUIRE(sqlite3_open(t.path.string().c_str(), &other) == SQLITE_OK);
        REQUIRE(sqlite3_exec(other, "BEGIN IMMEDIATE", nullptr, nullptr,
                             nullptr) == SQLITE_OK);
        sqlite3_exec(other, "INSERT INTO room_mod_options"
                            " (room_id, key, value) VALUES (999,'x','y')",
                     nullptr, nullptr, nullptr);
        holding = true;
        std::this_thread::sleep_for(std::chrono::milliseconds(40));
        sqlite3_exec(other, "COMMIT", nullptr, nullptr, nullptr);
        sqlite3_close(other);
    });
    while (!holding) std::this_thread::sleep_for(std::chrono::milliseconds(1));

    rooms.SetRoomState(roomId, ERoomState::Active);
    holder.join();

    // The new state reached disk. Pre-fix the write returned SQLITE_BUSY,
    // RoomManager logged a warning, and this still read Configuring.
    sqlite3_busy_timeout(t.db, kSqliteBusyTimeoutMs);
    sqlite3_stmt* st = nullptr;
    REQUIRE(sqlite3_prepare_v2(t.db,
        "SELECT state FROM rooms WHERE id=?", -1, &st, nullptr)
        == SQLITE_OK);
    sqlite3_bind_int(st, 1, static_cast<int>(roomId));
    REQUIRE(sqlite3_step(st) == SQLITE_ROW);
    CHECK(sqlite3_column_int(st, 0) == static_cast<int>(ERoomState::Active));
    sqlite3_finalize(st);
}
