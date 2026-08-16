// PLAN-metalstorm-wars.md §10's "slot race" row, which is the acceptance bar
// for task 2's first half: "N concurrent joins for the last F-slot → exactly
// one succeeds, others fall through / queue; reservation TTL releases an
// abandoned join."
//
// The race case deliberately does NOT use an in-memory database. `:memory:`
// gives every connection its own private database, and a shared-cache one
// serialises through a mutex this code does not rely on — either would make
// the test pass without the transaction being correct. So it opens a real file
// in WAL mode with one connection per thread, which is the shape the lobby and
// the game server actually have (two processes, two handles, one file).

#include <doctest/doctest.h>
#include <sqlite3.h>

#include <atomic>
#include <filesystem>
#include <string>
#include <thread>
#include <unistd.h>
#include <vector>

#include "Server/WarDirector.h"
#include "Server/WarPlayerBindings.h"
#include "Server/WarSlotReservation.h"

namespace {

constexpr int64_t kNow = 1'700'000'000;

void EnsureAll(sqlite3* db) {
    WarDirector::EnsureTables(db);
    WarPlayerBindings::EnsureTable(db);
    WarSlotReservations::EnsureTable(db);
}

/// A two-sided war on room 7 with `cap` seats a side.
void SeedWar(sqlite3* db, unsigned cap, uint32_t roomId = 7) {
    WarSeedRequest r;
    r.name          = "Raven Basin";
    r.theatre       = "scorched_crossing_v2.4";
    r.gameId        = "metalstorm";
    r.factions      = {"compact", "union"};
    r.startBoxCount = 4;
    WarSeedPopulation pop;
    WarSeedPlan plan = PlanWarSeed(r, pop);
    REQUIRE(plan.ok);
    for (auto& s : plan.sides)
        s.slotCap = cap;
    REQUIRE(WarDirector::Register(db, roomId, plan, kNow));
}

struct MemDb {
    sqlite3* db = nullptr;
    MemDb() {
        REQUIRE(sqlite3_open(":memory:", &db) == SQLITE_OK);
        EnsureAll(db);
    }
    ~MemDb() { sqlite3_close(db); }
};

/// A real file, so several connections can contend for one write lock.
struct FileDb {
    std::filesystem::path path;
    explicit FileDb(const char* stem) {
        path = std::filesystem::temp_directory_path() /
               (std::string("springrts-warslot-") + stem + "-" +
                std::to_string(::getpid()) + ".db");
        std::filesystem::remove(path);
        sqlite3* db = nullptr;
        REQUIRE(sqlite3_open(path.string().c_str(), &db) == SQLITE_OK);
        sqlite3_exec(db, "PRAGMA journal_mode=WAL", nullptr, nullptr, nullptr);
        EnsureAll(db);
        SeedWar(db, /*cap=*/1);
        sqlite3_close(db);
    }
    ~FileDb() {
        std::error_code ec;
        std::filesystem::remove(path, ec);
        std::filesystem::remove(path.string() + "-wal", ec);
        std::filesystem::remove(path.string() + "-shm", ec);
    }
};

}  // namespace

TEST_CASE("task 2: a reservation is granted while the side has room") {
    MemDb t;
    SeedWar(t.db, /*cap=*/2);

    const auto a = WarSlotReservations::Reserve(t.db, 7, "compact", 101, kNow);
    CHECK(a.outcome == SlotReserveOutcome::Granted);
    CHECK(a.MayJoin());
    CHECK(a.slotCap == 2);
    CHECK(a.bound == 0);
    CHECK(a.reserved == 0);
    CHECK(a.expiresAt == kNow + WAR_SLOT_RESERVATION_TTL_SECONDS);

    // The second seat is still there, and the first reservation is visible to
    // the second caller's count.
    const auto b = WarSlotReservations::Reserve(t.db, 7, "compact", 102, kNow);
    CHECK(b.outcome == SlotReserveOutcome::Granted);
    CHECK(b.reserved == 1);

    // The third is the one turned away — and it is turned away as a FULL SIDE,
    // not as an error, because that is the fact Deploy has to re-rank on.
    const auto c = WarSlotReservations::Reserve(t.db, 7, "compact", 103, kNow);
    CHECK(c.outcome == SlotReserveOutcome::SideFull);
    CHECK_FALSE(c.MayJoin());
    CHECK(c.expiresAt == 0);
    CHECK_FALSE(WarSlotReservations::Find(t.db, 7, 103).has_value());

    // The OTHER side is untouched: a cap is per side, not per war.
    CHECK(WarSlotReservations::Reserve(t.db, 7, "union", 103, kNow).outcome ==
          SlotReserveOutcome::Granted);
    CHECK(WarSlotReservations::LiveCount(t.db, 7, "compact", kNow) == 2);
    CHECK(WarSlotReservations::LiveCount(t.db, 7, "union", kNow) == 1);
}

TEST_CASE("task 2: a bound seat counts against the cap") {
    MemDb t;
    SeedWar(t.db, /*cap=*/2);
    REQUIRE(WarPlayerBindings::BindSeat(t.db, 7, 101, "vet", "compact", 0,
                                        kNow));

    const auto a = WarSlotReservations::Reserve(t.db, 7, "compact", 102, kNow);
    CHECK(a.outcome == SlotReserveOutcome::Granted);
    CHECK(a.bound == 1);

    CHECK(WarSlotReservations::Reserve(t.db, 7, "compact", 103, kNow).outcome ==
          SlotReserveOutcome::SideFull);

    // The bound player themselves needs no reservation — a rejoin is not a new
    // seat, and reserving one would count them twice against their own side.
    const auto mine = WarSlotReservations::Reserve(t.db, 7, "compact", 101, kNow);
    CHECK(mine.outcome == SlotReserveOutcome::AlreadySeated);
    CHECK(mine.MayJoin());
    CHECK_FALSE(WarSlotReservations::Find(t.db, 7, 101).has_value());
}

TEST_CASE("task 2: a retry renews rather than taking a second seat") {
    MemDb t;
    SeedWar(t.db, /*cap=*/1);

    CHECK(WarSlotReservations::Reserve(t.db, 7, "compact", 101, kNow).outcome ==
          SlotReserveOutcome::Granted);
    const auto again =
        WarSlotReservations::Reserve(t.db, 7, "compact", 101, kNow + 5);
    CHECK(again.outcome == SlotReserveOutcome::Renewed);
    CHECK(again.MayJoin());
    CHECK(again.expiresAt == kNow + 5 + WAR_SLOT_RESERVATION_TTL_SECONDS);
    // Still one seat held, not two.
    CHECK(WarSlotReservations::LiveCount(t.db, 7, "compact", kNow + 5) == 1);
}

TEST_CASE("task 2: an abandoned join releases on TTL expiry") {
    MemDb t;
    SeedWar(t.db, /*cap=*/1);

    REQUIRE(WarSlotReservations::Reserve(t.db, 7, "compact", 101, kNow).outcome ==
            SlotReserveOutcome::Granted);
    // Nobody else may have the seat while the join is in flight...
    CHECK(WarSlotReservations::Reserve(t.db, 7, "compact", 102, kNow).outcome ==
          SlotReserveOutcome::SideFull);

    // ...and one second before expiry it is still held.
    const int64_t justBefore = kNow + WAR_SLOT_RESERVATION_TTL_SECONDS - 1;
    CHECK(WarSlotReservations::Reserve(t.db, 7, "compact", 102, justBefore)
              .outcome == SlotReserveOutcome::SideFull);

    // At expiry the seat is free — with no sweep having run, because expiry is
    // evaluated at read time and the stale row is simply not counted.
    const int64_t after = kNow + WAR_SLOT_RESERVATION_TTL_SECONDS;
    CHECK(WarSlotReservations::LiveCount(t.db, 7, "compact", after) == 0);
    const auto late = WarSlotReservations::Reserve(t.db, 7, "compact", 102, after);
    CHECK(late.outcome == SlotReserveOutcome::Granted);
    CHECK(late.reserved == 0);

    // The sweep is hygiene: it removes the lapsed row and changes no answer.
    CHECK(WarSlotReservations::ReleaseExpired(t.db, after) == 1);
    CHECK(WarSlotReservations::LiveCount(t.db, 7, "compact", after) == 1);
}

TEST_CASE("task 2: a completed or cancelled join gives the seat back") {
    MemDb t;
    SeedWar(t.db, /*cap=*/1);
    REQUIRE(WarSlotReservations::Reserve(t.db, 7, "compact", 101, kNow).outcome ==
            SlotReserveOutcome::Granted);

    CHECK(WarSlotReservations::Release(t.db, 7, 101));
    CHECK_FALSE(WarSlotReservations::Release(t.db, 7, 101));  // already gone
    CHECK(WarSlotReservations::Reserve(t.db, 7, "compact", 102, kNow).outcome ==
          SlotReserveOutcome::Granted);
}

TEST_CASE("task 2: a completed join stops holding a reservation") {
    // The release nobody sends. The game server writes the binding and has no
    // reason to call back into the lobby, so a reservation whose join landed
    // must stop counting on the strength of the binding alone — otherwise the
    // joiner holds two seats against their own side for the rest of the TTL.
    MemDb t;
    SeedWar(t.db, /*cap=*/2);
    REQUIRE(WarSlotReservations::Reserve(t.db, 7, "compact", 101, kNow).outcome ==
            SlotReserveOutcome::Granted);
    REQUIRE(WarSlotReservations::Reserve(t.db, 7, "compact", 102, kNow).outcome ==
            SlotReserveOutcome::Granted);
    CHECK(WarSlotReservations::LiveCount(t.db, 7, "compact", kNow) == 2);

    // 101 arrives and is seated.
    REQUIRE(WarPlayerBindings::BindSeat(t.db, 7, 101, "a", "compact", 0, kNow));
    CHECK(WarSlotReservations::LiveCount(t.db, 7, "compact", kNow) == 1);

    // The side is still full — one bound, one in flight — but for the right
    // reason, and 101 is counted exactly once.
    const auto third = WarSlotReservations::Reserve(t.db, 7, "compact", 103, kNow);
    CHECK(third.outcome == SlotReserveOutcome::SideFull);
    CHECK(third.bound == 1);
    CHECK(third.reserved == 1);
}

TEST_CASE("task 2: reservations refuse a side the war does not field") {
    MemDb t;
    SeedWar(t.db, /*cap=*/2);
    CHECK(WarSlotReservations::Reserve(t.db, 7, "raiders", 101, kNow).outcome ==
          SlotReserveOutcome::NoSuchSide);
    CHECK(WarSlotReservations::Reserve(t.db, 99, "compact", 101, kNow).outcome ==
          SlotReserveOutcome::NoSuchSide);
    CHECK(WarSlotReservations::Reserve(t.db, 7, "", 101, kNow).outcome ==
          SlotReserveOutcome::Error);
}

TEST_CASE("task 2: an unlimited side never fills") {
    MemDb t;
    SeedWar(t.db, /*cap=*/2);
    // WAR_SIDE_CAPACITY_UNLIMITED — the same permissive reading DeployHasSeat
    // gives it: a war whose sides were never sized must not lock everyone out.
    REQUIRE(WarDirector::SetSideSlotCap(t.db, 7, "compact", 0));
    for (int64_t account = 101; account <= 110; ++account)
        CHECK(WarSlotReservations::Reserve(t.db, 7, "compact", account, kNow)
                  .outcome == SlotReserveOutcome::Granted);
}

TEST_CASE("task 2 / §10 slot race: N concurrent joins, exactly one seat") {
    FileDb file("race");

    constexpr int kJoiners = 12;
    std::atomic<int> granted{0};
    std::atomic<int> full{0};
    std::atomic<int> errors{0};
    std::atomic<bool> go{false};

    std::vector<std::thread> threads;
    threads.reserve(kJoiners);
    for (int i = 0; i < kJoiners; ++i) {
        threads.emplace_back([&, i] {
            // One connection per thread: the real topology, and the only one
            // in which `BEGIN IMMEDIATE` is doing any work at all.
            sqlite3* db = nullptr;
            if (sqlite3_open(file.path.string().c_str(), &db) != SQLITE_OK) {
                errors++;
                sqlite3_close(db);
                return;
            }
            WarSlotReservations::EnsureTable(db);  // sets the busy timeout
            while (!go.load(std::memory_order_acquire))
                std::this_thread::yield();
            const auto r = WarSlotReservations::Reserve(db, 7, "compact",
                                                        200 + i, kNow);
            switch (r.outcome) {
                case SlotReserveOutcome::Granted:  granted++; break;
                case SlotReserveOutcome::SideFull: full++;    break;
                default:                           errors++;  break;
            }
            sqlite3_close(db);
        });
    }
    go.store(true, std::memory_order_release);
    for (auto& t : threads)
        t.join();

    // The whole point: one winner, and every loser told the truth about why.
    CHECK(granted.load() == 1);
    CHECK(full.load() == kJoiners - 1);
    CHECK(errors.load() == 0);

    sqlite3* db = nullptr;
    REQUIRE(sqlite3_open(file.path.string().c_str(), &db) == SQLITE_OK);
    CHECK(WarSlotReservations::LiveCount(db, 7, "compact", kNow) == 1);
    // ...and the seat comes back when the winner never arrives.
    const int64_t after = kNow + WAR_SLOT_RESERVATION_TTL_SECONDS;
    CHECK(WarSlotReservations::LiveCount(db, 7, "compact", after) == 0);
    sqlite3_close(db);
}
