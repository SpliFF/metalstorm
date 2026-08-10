#include <doctest/doctest.h>

#include "Server/RoomManager.h"
#include "Server/GameStartCoordinator.h"

#include <sqlite3.h>

// PLAN-metalstorm-lobby.md §1/§2.1, task 1 — the session-kind split.
//
// Two kinds of session coexist. A SKIRMISH is the bounded match this engine
// was built around: fill a roster, launch, and GameStart waits until every
// rostered human has connected. A PERSISTENT WAR is Metalstorm's model — the
// war is already running, players trickle in and out, and it may outlive any
// individual player — so it starts with whatever seed exists and never waits.
//
// What these tests pin down is the part that is easy to get wrong twice:
//
//  1. The kind is NOT the existing `persistent` flag. That flag is a reaping
//     policy and is also set on ordinary AI-testing skirmishes; folding the
//     two together would have handed every such room the no-roster-wait
//     behaviour silently. The implication runs one way and CreateRoom is
//     where it is enforced.
//  2. The gate is one expression with four readers (the live set-up branch,
//     the replay prologue-feed branch, CheckAndFireGameStart, and the operator
//     log line), not four open-coded tests of the same idea.
//  3. The spelling crosses three boundaries — room JSON, POST /api/rooms, and
//     spring-server's `--session-kind` — so it has one encoder and one
//     decoder, and the decoder REFUSES an unknown spelling rather than
//     defaulting. A war silently downgraded to a skirmish waits forever for a
//     roster and logs it as "waiting for N player(s)", which is what a slow
//     browser looks like.

TEST_CASE("SessionKind: the wire spelling round-trips through one encoder/decoder") {
    CHECK(std::string(SessionKindToString(SessionKind::Skirmish)) == "skirmish");
    CHECK(std::string(SessionKindToString(SessionKind::PersistentWar)) == "persistent");

    CHECK(SessionKindFromString("skirmish") == SessionKind::Skirmish);
    CHECK(SessionKindFromString("persistent") == SessionKind::PersistentWar);
    // The long spelling is accepted because the plan text uses it; the short
    // one is what gets written back out.
    CHECK(SessionKindFromString("persistent_war") == SessionKind::PersistentWar);
}

TEST_CASE("SessionKind: an unknown spelling is refused, not defaulted") {
    CHECK_FALSE(SessionKindFromString("persistant").has_value());  // typo
    CHECK_FALSE(SessionKindFromString("").has_value());
    CHECK_FALSE(SessionKindFromString("war").has_value());
    CHECK_FALSE(SessionKindFromString("Skirmish").has_value());    // case matters
}

TEST_CASE("SessionKind: a skirmish waits for its roster, a persistent war never does") {
    CHECK(SessionWaitsForRoster(SessionKind::Skirmish));
    CHECK_FALSE(SessionWaitsForRoster(SessionKind::PersistentWar));

    // A skirmish with humans on the roster defers GameStart to the sim loop...
    CHECK_FALSE(SessionStartsGameAtSetup(SessionKind::Skirmish, 2));
    // ...and one without a roster (dev mode) starts during set-up.
    CHECK(SessionStartsGameAtSetup(SessionKind::Skirmish, 0));

    // A war starts during set-up in BOTH roster shapes. The seed roster is not
    // a precondition — this is the whole behavioural delta of the milestone.
    CHECK(SessionStartsGameAtSetup(SessionKind::PersistentWar, 0));
    CHECK(SessionStartsGameAtSetup(SessionKind::PersistentWar, 2));
}

TEST_CASE("CreateRoom: a room is a skirmish unless it asks to be a war") {
    RoomManager rooms;
    const uint32_t id = rooms.CreateRoom(
        "match", "meridian_basin", "metalstorm", 4, /*password=*/"",
        /*hostPlayerId=*/1, /*hostClientId=*/1, "host");
    REQUIRE(rooms.GetRoom(id) != nullptr);
    CHECK(rooms.GetRoom(id)->sessionKind == SessionKind::Skirmish);
    CHECK_FALSE(rooms.GetRoom(id)->persistent);
}

TEST_CASE("CreateRoom: PersistentWar implies persistent, and the implication is one-way") {
    RoomManager rooms;

    // A war is never reaped when its last human leaves, whether or not the
    // caller also remembered to pass the reaping flag.
    const uint32_t warId = rooms.CreateRoom(
        "the war", "meridian_basin", "metalstorm", 4, "", 1, 1, "host",
        /*persistent=*/false, /*hostFactionId=*/"",
        SessionKind::PersistentWar);
    CHECK(rooms.GetRoom(warId)->sessionKind == SessionKind::PersistentWar);
    CHECK(rooms.GetRoom(warId)->persistent);

    // ...but a persistent AI-testing room is still an ordinary skirmish, and
    // must keep waiting for its roster. This is the case that would have
    // broken had the two flags been folded into one.
    const uint32_t aiTestId = rooms.CreateRoom(
        "ai bench", "meridian_basin", "metalstorm", 4, "", 2, 2, "host",
        /*persistent=*/true);
    CHECK(rooms.GetRoom(aiTestId)->persistent);
    CHECK(rooms.GetRoom(aiTestId)->sessionKind == SessionKind::Skirmish);
    CHECK(SessionWaitsForRoster(rooms.GetRoom(aiTestId)->sessionKind));
}

TEST_CASE("RoomManager: the session kind survives a lobby restart") {
    sqlite3* db = nullptr;
    REQUIRE(sqlite3_open(":memory:", &db) == SQLITE_OK);
    RoomManager::EnsureTables(db);

    RoomManager rooms;
    rooms.SetDatabase(db);
    const uint32_t warId = rooms.CreateRoom(
        "the war", "meridian_basin", "metalstorm", 4, "", 1, 1, "host",
        /*persistent=*/false, /*hostFactionId=*/"",
        SessionKind::PersistentWar);
    const uint32_t skirmishId = rooms.CreateRoom(
        "a match", "meridian_basin", "metalstorm", 4, "", 2, 2, "host2");

    // A restart is LoadFromDatabase over the same handle: the in-memory rooms
    // are cleared and rebuilt from the rows. A war that came back as a
    // skirmish would start waiting for a roster it had already started
    // without.
    RoomManager reloaded;
    reloaded.SetDatabase(db);
    reloaded.LoadFromDatabase();
    REQUIRE(reloaded.GetRoom(warId) != nullptr);
    REQUIRE(reloaded.GetRoom(skirmishId) != nullptr);
    CHECK(reloaded.GetRoom(warId)->sessionKind == SessionKind::PersistentWar);
    CHECK(reloaded.GetRoom(warId)->persistent);
    CHECK(reloaded.GetRoom(skirmishId)->sessionKind == SessionKind::Skirmish);

    sqlite3_close(db);
}

TEST_CASE("RoomManager: a room row with an unreadable session_kind loads as a skirmish") {
    sqlite3* db = nullptr;
    REQUIRE(sqlite3_open(":memory:", &db) == SQLITE_OK);
    RoomManager::EnsureTables(db);

    // Hand-written row, as a forward-version or a hand-edited db would leave.
    // The load path downgrades and warns rather than dropping the room: the
    // row is already in the database and losing it is worse than mis-kinding
    // it. (The API decoder does the opposite — see the refusal test above.)
    REQUIRE(sqlite3_exec(db,
        "INSERT INTO rooms (id, name, host_player_id, map_id, game_id, "
        " max_players, password, state, game_server_port, persistent, "
        " session_kind) VALUES "
        " (7, 'weird', 1, 'meridian_basin', 'metalstorm', 4, '', 1, 0, 0, "
        "  'campaign')", nullptr, nullptr, nullptr) == SQLITE_OK);

    RoomManager rooms;
    rooms.SetDatabase(db);
    rooms.LoadFromDatabase();
    REQUIRE(rooms.GetRoom(7) != nullptr);
    CHECK(rooms.GetRoom(7)->sessionKind == SessionKind::Skirmish);

    sqlite3_close(db);
}

TEST_CASE("RoomManager.EnsureTables catches a rooms table that predates session_kind") {
    sqlite3* db = nullptr;
    REQUIRE(sqlite3_open(":memory:", &db) == SQLITE_OK);

    // The pre-task-1 schema: `persistent` present, `session_kind` absent.
    // Without a probe for the new column the existing ones pass this tree
    // straight through, after which every INSERT naming session_kind fails
    // (logged, not thrown) and LoadFromDatabase cannot prepare its SELECT —
    // so no room persists at all and the lobby comes back empty.
    //
    // The three sibling tables are created in their CURRENT shape on purpose.
    // The first draft of this test omitted them, and it passed with and
    // without the fix: the `room_ai_slots.profile` probe failed on the missing
    // table and dropped `rooms` for its own reasons. A migration probe can
    // only be tested against a tree where it is the ONLY probe that fires.
    REQUIRE(sqlite3_exec(db,
        "CREATE TABLE rooms (id INTEGER PRIMARY KEY, name TEXT NOT NULL, "
        " host_player_id INTEGER NOT NULL, map_id TEXT, game_id TEXT, "
        " max_players INTEGER NOT NULL DEFAULT 8, "
        " password TEXT NOT NULL DEFAULT '', state INTEGER NOT NULL DEFAULT 1, "
        " game_server_port INTEGER NOT NULL DEFAULT 0, "
        " persistent INTEGER NOT NULL DEFAULT 0);"
        "CREATE TABLE room_members (room_id INTEGER NOT NULL, "
        " player_id INTEGER NOT NULL, username TEXT NOT NULL DEFAULT '', "
        " team INTEGER NOT NULL DEFAULT 0, start_pos INTEGER NOT NULL DEFAULT -1, "
        " ready INTEGER NOT NULL DEFAULT 0, is_spectator INTEGER NOT NULL DEFAULT 0, "
        " is_host INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (room_id, player_id));"
        "CREATE TABLE room_ai_slots (room_id INTEGER NOT NULL, "
        " slot_index INTEGER NOT NULL, ai_id TEXT NOT NULL, "
        " display_name TEXT NOT NULL DEFAULT '', team INTEGER NOT NULL DEFAULT 0, "
        " start_pos INTEGER NOT NULL DEFAULT -1, profile TEXT NOT NULL DEFAULT '', "
        " PRIMARY KEY (room_id, slot_index));"
        "CREATE TABLE room_mod_options (room_id INTEGER NOT NULL, "
        " key TEXT NOT NULL, value TEXT NOT NULL DEFAULT '', "
        " PRIMARY KEY (room_id, key));"
        "INSERT INTO rooms (id, name, host_player_id, persistent) "
        " VALUES (3, 'stale', 1, 1)",
        nullptr, nullptr, nullptr) == SQLITE_OK);

    RoomManager::EnsureTables(db);

    // Dev-grade migration, stated rather than assumed: this file's probes
    // DROP and recreate rather than ALTER, so the stale row is gone. That is
    // the pre-existing policy for lobby-local state (see EnsureTables' own
    // comment), not something task 1 chose.
    RoomManager stale;
    stale.SetDatabase(db);
    stale.LoadFromDatabase();
    CHECK(stale.GetRoom(3) == nullptr);

    RoomManager rooms;
    rooms.SetDatabase(db);
    const uint32_t id = rooms.CreateRoom(
        "the war", "meridian_basin", "metalstorm", 4, "", 1, 1, "host",
        /*persistent=*/false, /*hostFactionId=*/"",
        SessionKind::PersistentWar);

    RoomManager reloaded;
    reloaded.SetDatabase(db);
    reloaded.LoadFromDatabase();
    REQUIRE(reloaded.GetRoom(id) != nullptr);
    CHECK(reloaded.GetRoom(id)->sessionKind == SessionKind::PersistentWar);

    sqlite3_close(db);
}
