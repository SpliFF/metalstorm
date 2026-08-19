#include <doctest/doctest.h>

#include <sqlite3.h>

#include "Server/FriendPresence.h"
#include "Server/Friends.h"

// PLAN-metalstorm-lobby.md §8, task 9a — friends, presence, and what
// "join my friend" can actually mean.
//
// Three things carry the weight here and each has its own block below:
//
//   * **mutuality is derived, not stored.** Two directed rows are the whole
//     model, so "accept" is literally the same call as "add" made from the
//     other end, and no pair of rows can disagree about the state of a
//     friendship. The tests assert the lattice from both ends.
//   * **removal is symmetric.** Deleting only the caller's own edge would
//     leave the other player holding an incoming request from somebody who
//     just removed them.
//   * **§8's "join their side" is usually the OPPOSING side** — §1b makes the
//     faction permanent and §2.3 makes the side follow it, so joining a
//     cross-faction friend's war seats you against them. That is a correct
//     outcome and it has to be named as its own one, never folded into `ok`.

namespace {

struct TestDb {
    sqlite3* db = nullptr;
    TestDb() {
        REQUIRE(sqlite3_open(":memory:", &db) == SQLITE_OK);
        Friends::EnsureTable(db);
        // ListFor INNER JOINs `users`; build only the three columns it reads
        // rather than pulling in Database.
        sqlite3_exec(db,
            "CREATE TABLE users (id INTEGER PRIMARY KEY AUTOINCREMENT,"
            " username TEXT, faction_id TEXT)",
            nullptr, nullptr, nullptr);
    }
    ~TestDb() { sqlite3_close(db); }

    int64_t addUser(const char* name, const char* faction) {
        sqlite3_stmt* s = nullptr;
        sqlite3_prepare_v2(db,
            "INSERT INTO users (username, faction_id) VALUES (?, ?)",
            -1, &s, nullptr);
        sqlite3_bind_text(s, 1, name, -1, SQLITE_TRANSIENT);
        sqlite3_bind_text(s, 2, faction, -1, SQLITE_TRANSIENT);
        REQUIRE(sqlite3_step(s) == SQLITE_DONE);
        sqlite3_finalize(s);
        return sqlite3_last_insert_rowid(db);
    }

    void deleteUser(int64_t id) {
        sqlite3_stmt* s = nullptr;
        sqlite3_prepare_v2(db, "DELETE FROM users WHERE id=?", -1, &s, nullptr);
        sqlite3_bind_int64(s, 1, id);
        sqlite3_step(s);
        sqlite3_finalize(s);
    }
};

WarSides TwoSides() {
    WarSides s;
    s.push_back({"compact", 0});
    s.push_back({"union", 1});
    return s;
}

}  // namespace

// ── The graph ──────────────────────────────────────────────────────────────

TEST_CASE("one edge is a request, the reverse edge completes the friendship") {
    TestDb t;
    const int64_t a = t.addUser("ana", "compact");
    const int64_t b = t.addUser("bo", "union");

    REQUIRE(Friends::Add(t.db, a, b, 100));
    CHECK(Friends::EdgeBetween(t.db, a, b) == FriendEdge::Outgoing);
    // The SAME pair of rows, read from the other end. This is the property
    // that makes a state column unnecessary.
    CHECK(Friends::EdgeBetween(t.db, b, a) == FriendEdge::Incoming);
    CHECK(Friends::MutualIds(t.db, a).empty());

    // Accept IS add, in the other direction — there is no second verb.
    REQUIRE(Friends::Add(t.db, b, a, 200));
    CHECK(Friends::EdgeBetween(t.db, a, b) == FriendEdge::Mutual);
    CHECK(Friends::EdgeBetween(t.db, b, a) == FriendEdge::Mutual);
    REQUIRE(Friends::MutualIds(t.db, a).size() == 1);
    CHECK(Friends::MutualIds(t.db, a)[0] == b);
}

TEST_CASE("a repeated add keeps the original 'friends since'") {
    TestDb t;
    const int64_t a = t.addUser("ana", "compact");
    const int64_t b = t.addUser("bo", "union");
    REQUIRE(Friends::Add(t.db, a, b, 100));
    REQUIRE(Friends::Add(t.db, a, b, 999));

    const auto list = Friends::ListFor(t.db, a);
    REQUIRE(list.size() == 1);
    // DO NOTHING rather than DO UPDATE: a second click must not reset the
    // date the friendship is stamped with.
    CHECK(list[0].since == 100);
}

TEST_CASE("self-friendship is refused in the store, not just at the route") {
    TestDb t;
    const int64_t a = t.addUser("ana", "compact");
    CHECK_FALSE(Friends::Add(t.db, a, a, 100));
    // A self-edge is its own reverse, so it would read as Mutual and put the
    // viewer in their own friends list as permanently online.
    CHECK(Friends::EdgeBetween(t.db, a, a) == FriendEdge::None);
    CHECK(Friends::ListFor(t.db, a).empty());
}

TEST_CASE("removal is symmetric — no dangling reverse request") {
    TestDb t;
    const int64_t a = t.addUser("ana", "compact");
    const int64_t b = t.addUser("bo", "union");
    REQUIRE(Friends::Add(t.db, a, b, 100));
    REQUIRE(Friends::Add(t.db, b, a, 100));

    CHECK(Friends::Remove(t.db, a, b) == 2);
    CHECK(Friends::EdgeBetween(t.db, a, b) == FriendEdge::None);
    // The one that matters: had only the caller's edge gone, `b` would now be
    // looking at an incoming friend request from the person who unfriended
    // them.
    CHECK(Friends::EdgeBetween(t.db, b, a) == FriendEdge::None);
    CHECK(Friends::ListFor(t.db, b).empty());
}

TEST_CASE("declining a request removes exactly the one edge that exists") {
    TestDb t;
    const int64_t a = t.addUser("ana", "compact");
    const int64_t b = t.addUser("bo", "union");
    REQUIRE(Friends::Add(t.db, a, b, 100));
    CHECK(Friends::Remove(t.db, b, a) == 1);
    CHECK(Friends::EdgeBetween(t.db, a, b) == FriendEdge::None);
}

TEST_CASE("ListFor reports both directions, mutual first, and joins the user row") {
    TestDb t;
    const int64_t me = t.addUser("me", "compact");
    const int64_t zed = t.addUser("zed", "union");     // mutual
    const int64_t ann = t.addUser("ann", "compact");   // incoming only
    const int64_t bob = t.addUser("bob", "");          // outgoing only
    REQUIRE(Friends::Add(t.db, me, zed, 10));
    REQUIRE(Friends::Add(t.db, zed, me, 11));
    REQUIRE(Friends::Add(t.db, ann, me, 12));
    REQUIRE(Friends::Add(t.db, me, bob, 13));

    const auto list = Friends::ListFor(t.db, me);
    REQUIRE(list.size() == 3);
    CHECK(list[0].username == "zed");
    CHECK(list[0].edge == FriendEdge::Mutual);
    CHECK(list[0].factionId == "union");
    // The remaining two are alphabetical, so the list does not reshuffle as
    // requests come and go.
    CHECK(list[1].username == "ann");
    CHECK(list[1].edge == FriendEdge::Incoming);
    // `since` is the CALLER's own edge; an incoming-only request has none.
    CHECK(list[1].since == 0);
    CHECK(list[2].username == "bob");
    CHECK(list[2].edge == FriendEdge::Outgoing);
    CHECK(list[2].since == 13);
    CHECK(list[2].factionId.empty());
}

TEST_CASE("an edge to a deleted account vanishes from the list and is pruned") {
    TestDb t;
    const int64_t a = t.addUser("ana", "compact");
    const int64_t ghost = t.addUser("guest-x", "");
    REQUIRE(Friends::Add(t.db, a, ghost, 100));
    REQUIRE(Friends::Add(t.db, ghost, a, 100));

    // The abandoned-guest sweep deletes accounts without knowing this table
    // exists. The INNER JOIN is what keeps a blank row out of the list before
    // the hourly prune catches up.
    t.deleteUser(ghost);
    CHECK(Friends::ListFor(t.db, a).empty());
    CHECK(Friends::PruneOrphans(t.db) == 2);
    CHECK(Friends::PruneOrphans(t.db) == 0);
}

TEST_CASE("DeleteForAccount clears both directions everywhere") {
    TestDb t;
    const int64_t a = t.addUser("ana", "compact");
    const int64_t b = t.addUser("bo", "union");
    const int64_t c = t.addUser("cy", "compact");
    REQUIRE(Friends::Add(t.db, a, b, 1));
    REQUIRE(Friends::Add(t.db, b, a, 1));
    REQUIRE(Friends::Add(t.db, c, a, 1));

    CHECK(Friends::DeleteForAccount(t.db, a) == 3);
    CHECK(Friends::ListFor(t.db, b).empty());
    CHECK(Friends::ListFor(t.db, c).empty());
}

// ── Presence ───────────────────────────────────────────────────────────────

TEST_CASE("presence ranks the war binding above the room and the lobby") {
    const int64_t now = 1'000'000;

    PresenceFacts f;
    CHECK(DecidePresence(f, now) == PresenceState::Offline);

    f.lobbyLastSeen = now - 5;
    CHECK(DecidePresence(f, now) == PresenceState::Online);

    f.roomId = 7;
    CHECK(DecidePresence(f, now) == PresenceState::Staging);

    // A player in a war is ALSO making HTTP requests and may still hold a room
    // row; "fighting" is the more useful of the true answers, so it wins.
    f.warRoomId = 9;
    f.warTeam = 1;
    f.warLastSeen = now - 30;
    CHECK(DecidePresence(f, now) == PresenceState::Fighting);
}

TEST_CASE("a stale war binding is a held seat, not a present player") {
    const int64_t now = 1'000'000;
    PresenceFacts f;
    f.warRoomId = 9;
    f.warTeam = 0;
    // Task 4 made a seat outlive the session by a week. Reading the binding
    // alone would show every veteran as permanently in the war they last
    // fought in.
    f.warLastSeen = now - (kWarPresenceFreshSec + 1);
    CHECK(DecidePresence(f, now) == PresenceState::Offline);

    f.warLastSeen = now - kWarPresenceFreshSec;
    CHECK(DecidePresence(f, now) == PresenceState::Fighting);
}

TEST_CASE("lobby presence expires") {
    const int64_t now = 1'000'000;
    PresenceFacts f;
    f.lobbyLastSeen = now - (kLobbyPresenceFreshSec + 1);
    CHECK(DecidePresence(f, now) == PresenceState::Offline);
}

TEST_CASE("PresenceTracker remembers the newest touch and nothing else") {
    PresenceTracker t;
    CHECK(t.LastSeen(42) == 0);
    t.Touch(42, 500);
    t.Touch(42, 900);
    CHECK(t.LastSeen(42) == 900);
    // A bad id is dropped rather than stored — an unauthenticated request
    // reaches the funnel too, and it must not mint a presence row for id 0.
    t.Touch(0, 900);
    CHECK(t.LastSeen(0) == 0);
}

// ── "Join my friend" ───────────────────────────────────────────────────────

namespace {

FriendJoinFacts InWar(const char* myFaction, int friendTeam) {
    FriendJoinFacts f;
    f.myFaction = myFaction;
    f.friendInWar = true;
    f.friendTeam = friendTeam;
    f.sides = TwoSides();
    f.myCapacity = 8;
    return f;
}

}  // namespace

TEST_CASE("a same-faction friend is joined on their own side") {
    const auto d = DecideFriendJoin(InWar("union", 1));
    CHECK(d.outcome == FriendJoinOutcome::SameSide);
    CHECK(d.myTeam == 1);
}

TEST_CASE("a cross-faction friend is joined OPPOSITE them, and says so") {
    // §8's "one-click join their side" against §1b's permanent faction. The
    // join succeeds — it is the same war — but on the caller's own faction's
    // side, and the outcome must not read as "you're with your friend".
    const auto d = DecideFriendJoin(InWar("compact", 1));
    CHECK(d.outcome == FriendJoinOutcome::OpposingSide);
    CHECK(d.myTeam == 0);
    CHECK(FriendJoinSeats(d.outcome));
}

TEST_CASE("a war that fields no side for my faction is closed to me") {
    auto f = InWar("robots", 1);
    const auto d = DecideFriendJoin(f);
    CHECK(d.outcome == FriendJoinOutcome::FactionAbsent);
    CHECK_FALSE(FriendJoinSeats(d.outcome));
    CHECK(d.myTeam == -1);
}

TEST_CASE("capacity is checked before the same/opposing question") {
    auto f = InWar("union", 1);
    f.myCapacity = 2;
    f.myBound = 2;
    // Answering "same side!" about a seat the game server will then refuse is
    // the promise task 6 keeps the browser from making.
    CHECK(DecideFriendJoin(f).outcome == FriendJoinOutcome::SideFull);

    // A player who already holds a seat is never refused their own.
    f.iAmBound = true;
    CHECK(DecideFriendJoin(f).outcome == FriendJoinOutcome::SameSide);
}

TEST_CASE("an unlimited side is never full") {
    auto f = InWar("union", 1);
    f.myCapacity = WAR_SIDE_CAPACITY_UNLIMITED;
    f.myBound = 400;
    CHECK(DecideFriendJoin(f).outcome == FriendJoinOutcome::SameSide);
}

TEST_CASE("no faction and no war are distinct, non-seating answers") {
    auto noFaction = InWar("", 1);
    CHECK(DecideFriendJoin(noFaction).outcome == FriendJoinOutcome::NoFaction);

    auto notInWar = InWar("union", 1);
    notInWar.friendInWar = false;
    CHECK(DecideFriendJoin(notInWar).outcome == FriendJoinOutcome::NotInAWar);

    // The faction check comes first: an account with no faction cannot be
    // seated in ANY war, so reporting "your friend isn't playing" would send
    // them to look for a different war they equally cannot join.
    auto neither = InWar("", 1);
    neither.friendInWar = false;
    CHECK(DecideFriendJoin(neither).outcome == FriendJoinOutcome::NoFaction);
}
