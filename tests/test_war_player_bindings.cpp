#include <doctest/doctest.h>

#include <sqlite3.h>

#include "Server/WarPlayerBindings.h"
#include "Server/WarRejoinPolicy.h"

// PLAN-metalstorm-lobby.md §2.5/§5.1, task 4 — player→side binding, per-player
// war state persistence, and rejoin restore.
//
// Task 2 seats a joiner by faction every time they connect and task 3 lets the
// war outlive the lobby that spawned it. Neither remembers the *player*: a
// returning veteran came back as a stranger with the right badge, and could be
// turned away from a full side they had been holding since Tuesday.
//
// What these tests pin down:
//
//  1. **Two horizons, not one.** The seat is an identity and is held for a
//     week against capacity; the pool is a conserved resource and goes stale
//     in five minutes, because game_authority.lua merged it into the TEAM pool
//     the moment the player left. Collapsing them into one number gets one of
//     the two wrong whichever number you pick.
//  2. **The faction outranks the binding.** A binding records a team, but the
//     team was only ever derived from the immutable faction. If the war's
//     sides are re-authored the binding is superseded, never the reverse —
//     otherwise the one path in the seating rule that can put a player on a
//     side their faction does not fight for is a stale row.
//  3. **A rebind must not confiscate the pool it is about to restore.** The
//     seat write and the state write are separate statements against the same
//     row, and the obvious `INSERT OR REPLACE` spelling of the first silently
//     zeroes the columns it does not name.
//  4. **State without a seat is not a thing.** SaveState refuses to invent a
//     binding — a spectator's war state would otherwise create a held seat in
//     a war they only ever watched.

namespace {

/// A fresh in-memory db with the table already created.
struct TestDb {
    sqlite3* db = nullptr;
    TestDb() {
        REQUIRE(sqlite3_open(":memory:", &db) == SQLITE_OK);
        WarPlayerBindings::EnsureTable(db);
    }
    ~TestDb() { sqlite3_close(db); }
};

constexpr int64_t kT0 = 1'700'000'000;

WarPlayerState MakeState(double pool, double earned, double spent, int objectives) {
    WarPlayerState s;
    s.authorityPool = pool;
    s.scoreEarned = earned;
    s.scoreSpent = spent;
    s.objectives = objectives;
    return s;
}

}  // namespace

// ── The policy (pure) ──────────────────────────────────────────────────────

TEST_CASE("an account with no binding gets nothing back") {
    const auto d = DecideRejoin(/*hasBinding=*/false, -1, 1, 0, 0.0, false);
    CHECK(d.seat == RejoinSeat::NoBinding);
    CHECK(d.state == RejoinState::Nothing);
    CHECK(d.team == -1);
    CHECK_FALSE(d.bypassCapacity);
    CHECK_FALSE(d.SeatRestored());
}

TEST_CASE("a fresh rejoin restores the seat and bypasses capacity") {
    const auto d = DecideRejoin(true, /*boundTeam=*/1, /*factionTeam=*/1,
                                /*absenceSec=*/30, /*savedPool=*/400.0, true);
    CHECK(d.seat == RejoinSeat::Restored);
    CHECK(d.team == 1);
    CHECK(d.bypassCapacity);
    CHECK(d.state == RejoinState::RestorePool);
    CHECK(d.pool == doctest::Approx(400.0));
}

TEST_CASE("the pool goes stale long before the seat does") {
    // One second past the brief window: the seat is still held for a week, but
    // the pool is no longer the player's to take back out of the team's hands.
    const auto d = DecideRejoin(true, 0, 0, WAR_BRIEF_ABSENCE_SEC + 1, 400.0, true);
    CHECK(d.seat == RejoinSeat::Restored);
    CHECK(d.bypassCapacity);
    CHECK(d.state == RejoinState::OnboardingStipend);
    CHECK(d.pool == doctest::Approx(0.0));

    // Exactly at the boundary is still brief — the comparison is <=, so a
    // capture and a reconnect in the same second are not an absence.
    const auto at = DecideRejoin(true, 0, 0, WAR_BRIEF_ABSENCE_SEC, 400.0, true);
    CHECK(at.state == RejoinState::RestorePool);
}

TEST_CASE("past the seat-hold window the binding stops bypassing capacity") {
    const auto d = DecideRejoin(true, 1, 1, WAR_SEAT_HOLD_SEC + 1, 0.0, true);
    CHECK(d.seat == RejoinSeat::Restored);
    CHECK(d.team == 1);
    // Still their team — they just take their chances with the capacity check
    // like any other joiner, which is task 2's rule.
    CHECK_FALSE(d.bypassCapacity);

    const auto at = DecideRejoin(true, 1, 1, WAR_SEAT_HOLD_SEC, 0.0, true);
    CHECK(at.bypassCapacity);
}

TEST_CASE("the faction outranks the binding when the war's sides change") {
    // The binding says team 1; the war now seats this faction on team 0.
    const auto moved = DecideRejoin(true, /*boundTeam=*/1, /*factionTeam=*/0,
                                    10, 400.0, true);
    CHECK(moved.seat == RejoinSeat::Superseded);
    CHECK(moved.team == -1);
    CHECK_FALSE(moved.bypassCapacity);
    CHECK(moved.state == RejoinState::Nothing);

    // And a war that no longer fields the faction at all.
    const auto retired = DecideRejoin(true, 1, /*factionTeam=*/-1, 10, 400.0, true);
    CHECK(retired.seat == RejoinSeat::Superseded);
}

TEST_CASE("a binding that was never state-saved restores no state") {
    // Distinct from "saved an empty pool": a player may legitimately leave
    // with nothing, and that must not read as "never captured".
    const auto never = DecideRejoin(true, 0, 0, 10, 0.0, /*hasSavedState=*/false);
    CHECK(never.seat == RejoinSeat::Restored);
    CHECK(never.state == RejoinState::Nothing);

    const auto empty = DecideRejoin(true, 0, 0, 10, 0.0, /*hasSavedState=*/true);
    CHECK(empty.state == RejoinState::RestorePool);
    CHECK(empty.pool == doctest::Approx(0.0));
}

TEST_CASE("clock skew between the two writers cannot confiscate a pool") {
    // `last_seen_at` is stamped by the game server and read back after the
    // clock may have moved; a negative absence must read as "just now", not as
    // an absence so large it fails every window.
    const auto d = DecideRejoin(true, 0, 0, /*absenceSec=*/-90, 250.0, true);
    CHECK(d.state == RejoinState::RestorePool);
    CHECK(d.bypassCapacity);
}

// ── The store ──────────────────────────────────────────────────────────────

TEST_CASE("a seat binds and reads back") {
    TestDb t;
    REQUIRE(WarPlayerBindings::BindSeat(t.db, 7, 42, "dj_joiner", "union", 1, kT0));
    const auto b = WarPlayerBindings::Find(t.db, 7, 42);
    REQUIRE(b.has_value());
    CHECK(b->roomId == 7);
    CHECK(b->accountId == 42);
    CHECK(b->username == "dj_joiner");
    CHECK(b->factionId == "union");
    CHECK(b->team == 1);
    CHECK(b->firstSeenAt == kT0);
    CHECK(b->lastSeenAt == kT0);
    CHECK_FALSE(b->HasSavedState());
    // Bindings are per (war, account): the same account in another war, and
    // another account in this one, are both absent.
    CHECK_FALSE(WarPlayerBindings::Find(t.db, 8, 42).has_value());
    CHECK_FALSE(WarPlayerBindings::Find(t.db, 7, 43).has_value());
}

TEST_CASE("state saves onto an existing binding and comes back whole") {
    TestDb t;
    REQUIRE(WarPlayerBindings::BindSeat(t.db, 1, 5, "vet", "compact", 0, kT0));
    REQUIRE(WarPlayerBindings::SaveState(t.db, 1, 5,
                                         MakeState(412.5, 900.0, 487.5, 3),
                                         kT0 + 60));
    const auto b = WarPlayerBindings::Find(t.db, 1, 5);
    REQUIRE(b.has_value());
    CHECK(b->state.authorityPool == doctest::Approx(412.5));
    CHECK(b->state.scoreEarned == doctest::Approx(900.0));
    CHECK(b->state.scoreSpent == doctest::Approx(487.5));
    CHECK(b->state.objectives == 3);
    CHECK(b->stateSavedAt == kT0 + 60);
    CHECK(b->lastSeenAt == kT0 + 60);
    CHECK(b->HasSavedState());
}

TEST_CASE("state without a seat is refused rather than invented") {
    TestDb t;
    // A spectator: no binding, so nothing to update. If this returned true (or
    // upserted) a war a player only ever watched would later hand them a held
    // seat in it.
    CHECK_FALSE(WarPlayerBindings::SaveState(t.db, 1, 99,
                                             MakeState(100.0, 0, 0, 0), kT0));
    CHECK_FALSE(WarPlayerBindings::Find(t.db, 1, 99).has_value());
}

TEST_CASE("re-binding a seat keeps the saved state and the first-seen stamp") {
    TestDb t;
    REQUIRE(WarPlayerBindings::BindSeat(t.db, 1, 5, "vet", "compact", 0, kT0));
    REQUIRE(WarPlayerBindings::SaveState(t.db, 1, 5,
                                         MakeState(412.5, 900.0, 487.5, 3), kT0 + 60));
    // The rejoin: same account, same war, a day later.
    REQUIRE(WarPlayerBindings::BindSeat(t.db, 1, 5, "vet", "compact", 0, kT0 + 86400));
    const auto b = WarPlayerBindings::Find(t.db, 1, 5);
    REQUIRE(b.has_value());
    // This is the INSERT OR REPLACE trap: a replace deletes and re-inserts, so
    // every column the seat statement does not name goes to its default — the
    // rejoin would confiscate exactly the pool it is about to hand back.
    CHECK(b->state.authorityPool == doctest::Approx(412.5));
    CHECK(b->state.objectives == 3);
    CHECK(b->stateSavedAt == kT0 + 60);
    // …and `first_seen_at` still means "when this account first fought here".
    CHECK(b->firstSeenAt == kT0);
    CHECK(b->lastSeenAt == kT0 + 86400);
}

TEST_CASE("a war's bindings list oldest first") {
    TestDb t;
    REQUIRE(WarPlayerBindings::BindSeat(t.db, 3, 20, "second", "union", 1, kT0 + 500));
    REQUIRE(WarPlayerBindings::BindSeat(t.db, 3, 10, "first", "compact", 0, kT0));
    REQUIRE(WarPlayerBindings::BindSeat(t.db, 4, 30, "other war", "union", 1, kT0));
    const auto rows = WarPlayerBindings::ForRoom(t.db, 3);
    REQUIRE(rows.size() == 2);
    CHECK(rows[0].username == "first");
    CHECK(rows[1].username == "second");
}

TEST_CASE("an audited faction override clears every binding the account holds") {
    // PLAN-metalstorm-lobby §1b. Task 0 recorded this clause as a documented
    // no-op because the store did not exist; leaving the rows behind would
    // send the account back to its FORMER faction's side on the next rejoin.
    TestDb t;
    REQUIRE(WarPlayerBindings::BindSeat(t.db, 1, 5, "turncoat", "compact", 0, kT0));
    REQUIRE(WarPlayerBindings::BindSeat(t.db, 2, 5, "turncoat", "compact", 0, kT0));
    REQUIRE(WarPlayerBindings::BindSeat(t.db, 1, 6, "bystander", "compact", 0, kT0));
    CHECK(WarPlayerBindings::DeleteForAccount(t.db, 5) == 2);
    CHECK_FALSE(WarPlayerBindings::Find(t.db, 1, 5).has_value());
    CHECK_FALSE(WarPlayerBindings::Find(t.db, 2, 5).has_value());
    CHECK(WarPlayerBindings::Find(t.db, 1, 6).has_value());
}

TEST_CASE("deleting a war takes its bindings with it") {
    // Room ids are assigned from a counter, not an AUTOINCREMENT, so they are
    // reused: an orphaned binding is not a leak but a roster of strangers
    // handed to whatever war is given the id next.
    TestDb t;
    REQUIRE(WarPlayerBindings::BindSeat(t.db, 1, 5, "a", "compact", 0, kT0));
    REQUIRE(WarPlayerBindings::BindSeat(t.db, 1, 6, "b", "union", 1, kT0));
    REQUIRE(WarPlayerBindings::BindSeat(t.db, 2, 7, "c", "union", 1, kT0));
    CHECK(WarPlayerBindings::DeleteForRoom(t.db, 1) == 2);
    CHECK(WarPlayerBindings::ForRoom(t.db, 1).empty());
    CHECK(WarPlayerBindings::ForRoom(t.db, 2).size() == 1);
}

TEST_CASE("EnsureTable is idempotent and never drops what it finds") {
    // Unlike its neighbours (rooms/game_servers/game_status, all mirrors of
    // live in-memory state), this table is the ONLY copy of a player's war
    // state — so a second EnsureTable must not be a probe-and-drop.
    TestDb t;
    REQUIRE(WarPlayerBindings::BindSeat(t.db, 1, 5, "vet", "compact", 0, kT0));
    REQUIRE(WarPlayerBindings::SaveState(t.db, 1, 5, MakeState(99.0, 0, 0, 0), kT0));
    WarPlayerBindings::EnsureTable(t.db);
    WarPlayerBindings::EnsureTable(t.db);
    const auto b = WarPlayerBindings::Find(t.db, 1, 5);
    REQUIRE(b.has_value());
    CHECK(b->state.authorityPool == doctest::Approx(99.0));
}

TEST_CASE("every store call tolerates a null handle") {
    // The game server opens its own handle and carries on without one if the
    // open fails; a war must not crash on a reconnect because of it.
    WarPlayerBindings::EnsureTable(nullptr);
    CHECK_FALSE(WarPlayerBindings::BindSeat(nullptr, 1, 1, "x", "y", 0, kT0));
    CHECK_FALSE(WarPlayerBindings::SaveState(nullptr, 1, 1, WarPlayerState{}, kT0));
    CHECK_FALSE(WarPlayerBindings::Find(nullptr, 1, 1).has_value());
    CHECK(WarPlayerBindings::ForRoom(nullptr, 1).empty());
    CHECK(WarPlayerBindings::DeleteForAccount(nullptr, 1) == 0);
    CHECK(WarPlayerBindings::DeleteForRoom(nullptr, 1) == 0);
}
