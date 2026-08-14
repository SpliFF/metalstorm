#include <doctest/doctest.h>

#include "Server/RuntimeAIRoster.h"

#include <sqlite3.h>
#include <string>

// PLAN-metalstorm-ai.md §10 task 4(b), the open thread it left: a caretaker AI
// seated mid-war did not survive hibernate/resume. The war came back with the
// caretaker's virtual player in the restored synced state — its authority pool
// and its orders keyed by a playerNum — and no runtime behind it.
//
// `room_runtime_ai` is the missing record. These cases cover the table contract
// and the restore policy; the two halves that need a sim (registering the player
// at its stored number, loading the VM) live in AISpawnService.cpp, which does
// not link into spring-tests — same split as AISpawn.cpp / test_ai_spawn.cpp.

namespace {

sqlite3* FreshDb() {
    sqlite3* db = nullptr;
    REQUIRE(sqlite3_open(":memory:", &db) == SQLITE_OK);
    RuntimeAIRoster::EnsureTable(db);
    return db;
}

RuntimeAISeat Seat(uint32_t room, int playerNum, int team,
                   const std::string& id = "strategos") {
    RuntimeAISeat s;
    s.roomId = room;
    s.playerNum = playerNum;
    s.aiId = id;
    s.team = team;
    s.seatedFrame = 40'000;
    s.createdAt = 1'700'000'000;
    return s;
}

}  // namespace

TEST_CASE("RuntimeAIRoster: a seat survives the process that made it") {
    sqlite3* db = FreshDb();

    CHECK(RuntimeAIRoster::Record(db, Seat(7, 5, 2)));

    const auto seats = RuntimeAIRoster::ForRoom(db, 7);
    REQUIRE(seats.size() == 1);
    CHECK(seats[0].playerNum == 5);
    CHECK(seats[0].team == 2);
    CHECK(seats[0].aiId == "strategos");
    // The frame is what the operator log quotes back ("seated frame N before
    // the freeze") — a resumed war with a silent seat is the failure mode.
    CHECK(seats[0].seatedFrame == 40'000);
    CHECK(seats[0].createdAt == 1'700'000'000);

    sqlite3_close(db);
}

TEST_CASE("RuntimeAIRoster: seats are scoped to their room, in seating order") {
    sqlite3* db = FreshDb();

    // Two sides of one war emptied, plus an unrelated war on another id.
    CHECK(RuntimeAIRoster::Record(db, Seat(7, 9, 3)));
    CHECK(RuntimeAIRoster::Record(db, Seat(7, 5, 2)));
    CHECK(RuntimeAIRoster::Record(db, Seat(8, 4, 1)));

    const auto seven = RuntimeAIRoster::ForRoom(db, 7);
    REQUIRE(seven.size() == 2);
    // Ordered by playerNum, which is the order the numbers were minted in and
    // therefore the order the sides emptied in.
    CHECK(seven[0].playerNum == 5);
    CHECK(seven[1].playerNum == 9);
    CHECK(seven[0].roomId == 7);

    CHECK(RuntimeAIRoster::ForRoom(db, 8).size() == 1);
    CHECK(RuntimeAIRoster::ForRoom(db, 99).empty());

    sqlite3_close(db);
}

TEST_CASE("RuntimeAIRoster: re-recording one number is the same seat, not a second AI") {
    sqlite3* db = FreshDb();

    CHECK(RuntimeAIRoster::Record(db, Seat(7, 5, 2, "strategos")));
    // A resumed war re-seats its stored AI, and the seat is recorded again from
    // the live path if the side empties once more. One row, latest wins.
    CHECK(RuntimeAIRoster::Record(db, Seat(7, 5, 2, "strategos")));

    const auto seats = RuntimeAIRoster::ForRoom(db, 7);
    REQUIRE(seats.size() == 1);
    CHECK(seats[0].aiId == "strategos");

    sqlite3_close(db);
}

TEST_CASE("RuntimeAIRoster: a room's seats die with the room (ids are reused)") {
    sqlite3* db = FreshDb();

    CHECK(RuntimeAIRoster::Record(db, Seat(7, 5, 2)));
    CHECK(RuntimeAIRoster::Record(db, Seat(7, 9, 3)));
    CHECK(RuntimeAIRoster::Record(db, Seat(8, 4, 1)));

    CHECK(RuntimeAIRoster::DeleteForRoom(db, 7) == 2);
    CHECK(RuntimeAIRoster::ForRoom(db, 7).empty());
    // The neighbouring war is untouched: the delete is the room chokepoint's,
    // not a truncate.
    CHECK(RuntimeAIRoster::ForRoom(db, 8).size() == 1);

    sqlite3_close(db);
}

TEST_CASE("RuntimeAIRoster: a reader on a db that predates the table is empty, not broken") {
    // A lobby or game server built before this table existed leaves a database
    // without it. Reading must answer "no seats" — the same rule
    // GameServersDb::DeleteForRoom follows for its own missing tables.
    sqlite3* db = nullptr;
    REQUIRE(sqlite3_open(":memory:", &db) == SQLITE_OK);

    CHECK(RuntimeAIRoster::ForRoom(db, 7).empty());
    CHECK(RuntimeAIRoster::DeleteForRoom(db, 7) == 0);
    CHECK_FALSE(RuntimeAIRoster::Record(db, Seat(7, 5, 2)));

    // And EnsureTable is idempotent — both processes call it on every boot.
    RuntimeAIRoster::EnsureTable(db);
    RuntimeAIRoster::EnsureTable(db);
    CHECK(RuntimeAIRoster::Record(db, Seat(7, 5, 2)));
    CHECK(RuntimeAIRoster::ForRoom(db, 7).size() == 1);

    sqlite3_close(db);
}

TEST_CASE("DecideRuntimeAIRestore: the ordinary resume restores the stored seat") {
    const RuntimeAISeat s = Seat(7, 5, 2);
    CHECK(DecideRuntimeAIRestore(s, /*teamActive=*/true, /*playerNumTaken=*/false,
                                 /*teamHasActiveAI=*/false) ==
          RuntimeAIRestoreVerdict::Restore);
}

TEST_CASE("DecideRuntimeAIRestore: every refusal is a legitimate shape of a changed roster") {
    const RuntimeAISeat s = Seat(7, 5, 2);

    SUBCASE("the team is gone from the resumed world") {
        CHECK(DecideRuntimeAIRestore(s, false, false, false) ==
              RuntimeAIRestoreVerdict::RefuseNoTeam);
    }
    SUBCASE("the stored number belongs to a live player now") {
        // The launch roster is staged before a resume applies, so a war whose
        // human roster grew since the freeze can legitimately have handed this
        // number out. Two players on one synced identity is the thing to refuse.
        CHECK(DecideRuntimeAIRestore(s, true, true, false) ==
              RuntimeAIRestoreVerdict::RefuseSlotTaken);
    }
    SUBCASE("a launch --ai slot now covers the team") {
        CHECK(DecideRuntimeAIRestore(s, true, false, true) ==
              RuntimeAIRestoreVerdict::RefuseTeamHasAI);
    }
    SUBCASE("the row names no plugin") {
        CHECK(DecideRuntimeAIRestore(Seat(7, 5, 2, ""), true, false, false) ==
              RuntimeAIRestoreVerdict::RefuseNoId);
    }
    SUBCASE("a negative number is not a seat") {
        CHECK(DecideRuntimeAIRestore(Seat(7, -1, 2), true, false, false) ==
              RuntimeAIRestoreVerdict::RefuseSlotTaken);
    }
    SUBCASE("a taken number is named ahead of a taken team") {
        // Both can be true at once, and the number is the more specific fact:
        // reporting the team would send an operator to the AI roster looking for
        // a human's row.
        CHECK(DecideRuntimeAIRestore(s, true, true, true) ==
              RuntimeAIRestoreVerdict::RefuseSlotTaken);
    }
    SUBCASE("every verdict names itself") {
        CHECK(std::string(RuntimeAIRestoreVerdictName(
                  RuntimeAIRestoreVerdict::Restore)) != "unknown");
        CHECK(std::string(RuntimeAIRestoreVerdictName(
                  RuntimeAIRestoreVerdict::RefuseNoTeam)) != "unknown");
        CHECK(std::string(RuntimeAIRestoreVerdictName(
                  RuntimeAIRestoreVerdict::RefuseNoId)) != "unknown");
        CHECK(std::string(RuntimeAIRestoreVerdictName(
                  RuntimeAIRestoreVerdict::RefuseSlotTaken)) != "unknown");
        CHECK(std::string(RuntimeAIRestoreVerdictName(
                  RuntimeAIRestoreVerdict::RefuseTeamHasAI)) != "unknown");
    }
}
