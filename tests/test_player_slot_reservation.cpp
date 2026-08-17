#include <doctest/doctest.h>

#include "Game/Players/PlayerHandler.h"
#include "Server/PlayerSlotReservation.h"
#include "Server/WarSides.h"

#include <string>

// PLAN-metalstorm-wars.md §8.1, task 5 — spawn-time player-slot
// pre-allocation, the concrete resolution of lobby §2.1's keystone risk.
//
// The claim under test is a sizing one: a war's game server is sized for the
// WAR (Σ slotCap, which the War Director knows at seed time) rather than for
// the roster the process happened to boot with. What makes that a real
// property and not bookkeeping is that `CPlayerHandler::players` is
// capacity-pinned to MAX_PLAYERS, nothing ever erases from it, and every
// consumer of a player number — roster players, AI virtual players and the
// unlimited spectators a war admits by design — draws from the same monotone
// counter. Without a reserved block, the eighth fighter of an eight-seat war
// can find no player number left because two hundred people came to watch.
//
// Split the way DynamicJoin's is: the layout and the claim are pure functions
// of values, tested here without a sim; the wiring that hands them the
// modoptions (server_main's set-up block) is verified on a running server.
// `CPlayerHandler` itself IS driven for real below, because "the arrays were
// really pre-allocated" is a claim about that object and nothing else.

using namespace playerslots;

TEST_CASE("Σ slotCap is the sum, and 'unknown' is not 'unlimited'") {
    const WarSides sides = ParseWarSides("compact:0,union:4");

    SUBCASE("summed across the sides") {
        CHECK(TotalSlotCap(sides, ParseWarSideCapacities("compact:2,union:2"),
                           WAR_SIDE_CAPACITY_DEFAULT) == 4);
        CHECK(TotalSlotCap(sides, ParseWarSideCapacities("compact:2,union:6"),
                           WAR_SIDE_CAPACITY_DEFAULT) == 8);
    }
    SUBCASE("a side the capacities do not size takes the fallback") {
        CHECK(TotalSlotCap(sides, ParseWarSideCapacities("compact:2"),
                           /*fallbackPerSide=*/3) == 5);
    }
    SUBCASE("an unlimited side makes the total UNKNOWN, not zero-width") {
        // 0 is the same 0-means-UNKNOWN reading WarSideMaintenance's ceiling
        // uses. Summing an unlimited side as 0 would have produced a block
        // narrower than the war, which is worse than no block at all: the
        // lobby would advertise seats the server sized itself out of.
        CHECK(TotalSlotCap(sides, ParseWarSideCapacities("compact:2,union:0"),
                           WAR_SIDE_CAPACITY_DEFAULT) == 0);
    }
    SUBCASE("no sides at all — a skirmish or a legacy room — is not sized") {
        CHECK(TotalSlotCap(WarSides{}, WarSideCapacities{}, 8) == 0);
    }
}

TEST_CASE("the block is laid out per side, in declaration order") {
    const WarSides sides = ParseWarSides("compact:0,union:4");
    const WarSideCapacities caps = ParseWarSideCapacities("compact:2,union:2");

    const auto slots = PlanReservedSlots(4, sides, caps, 8);
    REQUIRE(slots.Size() == 4);
    CHECK(slots.TeamOf(0) == 0);
    CHECK(slots.TeamOf(1) == 0);
    CHECK(slots.TeamOf(2) == 4);
    CHECK(slots.TeamOf(3) == 4);
    CHECK(slots.CountFor(0) == 2);
    CHECK(slots.CountFor(4) == 2);

    SUBCASE("a number outside the block reads as no side, not as team 0") {
        CHECK_FALSE(slots.Reserved(4));
        CHECK(slots.TeamOf(4) == -1);
        CHECK(slots.TeamOf(-1) == -1);
    }

    SUBCASE("caps raised past the spawn size truncate to the block") {
        // Task 2's maintenance pass may raise a side after boot; the process
        // is still the size it was spawned at. Truncating breaks the promise
        // here, at boot, where a log line can say so — rather than at the
        // moment a player the lobby already sent is turned away.
        const auto raised = PlanReservedSlots(
            4, sides, ParseWarSideCapacities("compact:6,union:6"), 8);
        REQUIRE(raised.Size() == 4);
        CHECK(raised.CountFor(0) == 4);
        CHECK(raised.CountFor(4) == 0);
    }

    SUBCASE("caps narrower than the block leave unassigned slots, not gaps") {
        const auto shrunk = PlanReservedSlots(
            5, sides, ParseWarSideCapacities("compact:2,union:2"), 8);
        REQUIRE(shrunk.Size() == 5);
        CHECK(shrunk.TeamOf(4) == -1);
    }
}

TEST_CASE("a joiner claims a free slot of their OWN side") {
    const auto slots = PlanReservedSlots(4, ParseWarSides("compact:0,union:4"),
                                         ParseWarSideCapacities("compact:2,union:2"), 8);
    // "free" is the caller's question because the answer lives in the sim's
    // player list; here it is a set.
    bool taken[4] = {false, false, false, false};
    auto isFree = [&](int n) { return !taken[n]; };

    CHECK(ClaimReservedSlot(slots, 4, isFree) == 2);   // union's block, not 0
    taken[2] = true;
    CHECK(ClaimReservedSlot(slots, 4, isFree) == 3);
    taken[3] = true;

    SUBCASE("a full side falls through rather than eating the other's block") {
        CHECK(ClaimReservedSlot(slots, 4, isFree) == -1);
        CHECK(ClaimReservedSlot(slots, 0, isFree) == 0);
    }
    SUBCASE("a team with no reserved slot at all falls through") {
        CHECK(ClaimReservedSlot(slots, 7, isFree) == -1);
    }
    SUBCASE("a spectator's -1 team never claims") {
        CHECK(ClaimReservedSlot(slots, -1, isFree) == -1);
    }
}

TEST_CASE("an unassigned slot is a last resort, not a first choice") {
    // 5 slots, 4 of them sided. Side `compact` must exhaust its own two before
    // spending the spare — otherwise the side with no leftovers to fall back
    // on is the one that starves.
    const auto slots = PlanReservedSlots(5, ParseWarSides("compact:0,union:4"),
                                         ParseWarSideCapacities("compact:2,union:2"), 8);
    bool taken[5] = {false, false, false, false, false};
    auto isFree = [&](int n) { return !taken[n]; };

    CHECK(ClaimReservedSlot(slots, 0, isFree) == 0);
    taken[0] = true;
    CHECK(ClaimReservedSlot(slots, 0, isFree) == 1);
    taken[1] = true;
    CHECK(ClaimReservedSlot(slots, 0, isFree) == 4);   // now the spare
}

// ── §10's integration row, at the sizing layer ───────────────────────────────
//
// "two factions, one war, slotCap 2/side; a player joins via dynamic-join onto
// a PRE-ALLOCATED slot — the assertion is that the server sized its arrays for
// slotCap, not for the roster it booted with."
//
// Driven against the REAL CPlayerHandler, because the whole claim is about
// that object: a value struct saying "4 slots" while the player list holds one
// row would be exactly the bug this task exists to prevent.
TEST_CASE("the arrays are sized for the war, not for the roster that booted") {
    const WarSides sides = ParseWarSides("compact:0,union:4");
    const WarSideCapacities caps = ParseWarSideCapacities("compact:2,union:2");
    const unsigned total = TotalSlotCap(sides, caps, WAR_SIDE_CAPACITY_DEFAULT);
    REQUIRE(total == 4);

    const auto slots = PlanReservedSlots(total, sides, caps,
                                         WAR_SIDE_CAPACITY_DEFAULT);

    playerHandler.ResetState();
    playerHandler.ReserveSlots(static_cast<int>(total), slots.teamOfSlot);

    // The assertion: four rows exist before anybody has connected. The war
    // booted with a one-player roster — that player has not even authenticated
    // yet — and the list is already the size of the war.
    REQUIRE(playerHandler.ActivePlayers() == 4);
    for (int i = 0; i < 4; ++i) {
        CHECK(playerHandler.IsUnclaimedSlot(i));
        // Spectator + inactive until claimed, so every "who is fighting on
        // this team" question — Lua's GetPlayerList(teamID), the human-presence
        // checks, the hibernation gate — reads an empty seat as empty.
        CHECK(playerHandler.Player(i)->spectator);
        CHECK_FALSE(playerHandler.Player(i)->active);
    }
    // The side each seat is for is on the row, so an operator dumping the
    // player list sees the shape the war was sized to.
    CHECK(playerHandler.Player(0)->team == 0);
    CHECK(playerHandler.Player(3)->team == 4);

    auto isFree = [&](int n) { return playerHandler.IsUnclaimedSlot(n); };

    // The seed roster's one player authenticates onto side `compact`.
    const int seedNum = ClaimReservedSlot(slots, 0, isFree);
    REQUIRE(seedNum == 0);
    {
        CPlayer p;
        p.name = "seed";
        p.team = 0;
        p.active = true;
        p.spectator = false;
        p.playerNum = seedNum;
        playerHandler.AddPlayer(p);
    }
    CHECK_FALSE(playerHandler.IsUnclaimedSlot(0));
    CHECK(playerHandler.ActivePlayers() == 4);   // no growth: the slot existed

    // The dynamic joiner: a third same-faction player was queued, a war was
    // demand-seeded, and they arrive on side `union`. They land on slot 2 —
    // pre-allocated for team 4 at spawn, before this process had a roster.
    const int joinerNum = ClaimReservedSlot(slots, 4, isFree);
    CHECK(joinerNum == 2);
    CHECK(slots.TeamOf(joinerNum) == 4);
    {
        CPlayer p;
        p.name = "joiner";
        p.team = 4;
        p.active = true;
        p.spectator = false;
        p.playerNum = joinerNum;
        playerHandler.AddPlayer(p);
    }
    CHECK(playerHandler.ActivePlayers() == 4);

    // A returning account keeps the row it already owns (PLAN-long-uptime
    // S12) — the claim path asks HumanPlayer() first, and it must not hand a
    // second slot to somebody who already has one.
    CHECK(playerHandler.HumanPlayer("joiner") == 2);
    // ...and a nameless reserved slot owns nobody, so an empty username can
    // never resolve onto one.
    CHECK(playerHandler.HumanPlayer("") == -1);

    playerHandler.ResetState();
}

TEST_CASE("an unsized session behaves exactly as it did before") {
    // A skirmish, a legacy room, or a war with an unlimited side: no block, no
    // reservation, and the claim falls through to the caller's own counter.
    const auto none = PlanReservedSlots(0, ParseWarSides("compact:0"),
                                        WarSideCapacities{}, 8);
    CHECK(none.Empty());
    CHECK(ClaimReservedSlot(none, 0, [](int) { return true; }) == -1);

    playerHandler.ResetState();
    playerHandler.ReserveSlots(0, none.teamOfSlot);
    CHECK(playerHandler.ActivePlayers() == 0);
    CHECK_FALSE(playerHandler.IsUnclaimedSlot(0));
    playerHandler.ResetState();
}
