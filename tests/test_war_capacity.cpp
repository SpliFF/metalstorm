#include <doctest/doctest.h>

#include "Server/RoomManager.h"
#include "Server/WarDeploy.h"
#include "Server/WarSeeding.h"
#include "Server/WarSides.h"

// PLAN-metalstorm-lobby.md §6, task 7 — per-side capacity, war seeding, and
// Deploy.
//
// Task 2 shipped ONE capacity for every side of every war and said so in the
// header: `--war-side-capacity`, default 8, uniform. §6's balance is
// structural — a player always fights for their own faction, so nobody can be
// moved onto a weaker side — and a structure in which both sides are always
// the same size cannot express the only two things §6 asks for: "sides sized
// to the registered population" and "a faction with a player surplus spawns
// more wars/slots".
//
// What these tests pin down:
//
//  1. **Capacity is per side, and absence is not zero.** A war that sizes one
//     side and not the other is fully defined: the unsized side falls back to
//     the war's uniform number. An authored `0` is a deliberate "unlimited"
//     and overrides a bounded fallback — the one place where absence and zero
//     must not be the same value.
//  2. **The capacities modoption cannot be confused with `war_sides`.** They
//     are both `faction:number` lists and they dedupe on OPPOSITE fields:
//     a repeated team in `war_sides` is a conflict, while two sides sharing a
//     capacity is the normal case.
//  3. **Seeding is asymmetric on purpose.** Sizing both sides to the smaller
//     population is the obvious "fair" answer and it strands the surplus
//     faction's players outside the war entirely.
//  4. **Deploy never refuses.** Full everywhere is `seed`, not a queue; and a
//     war this account already holds a seat in wins outright, whatever the
//     ranking would otherwise prefer.

// ── 1. Per-side capacity ────────────────────────────────────────────────────

TEST_CASE("war_side_capacities: one decoder, per-faction dedupe") {
    const WarSideCapacities caps =
        ParseWarSideCapacities("compact:8,union:12");
    REQUIRE(caps.size() == 2);
    CHECK(caps[0].first == "compact");
    CHECK(caps[0].second == 8);
    CHECK(caps[1].first == "union");
    CHECK(caps[1].second == 12);

    // Deduped by FACTION — unlike ParseWarSides, where the number is the key.
    // Two sides of the same size is the normal case and must not drop one.
    const WarSideCapacities same = ParseWarSideCapacities("compact:8,union:8");
    CHECK(same.size() == 2);

    // A repeated faction is a genuine conflict; first declaration wins.
    const WarSideCapacities dup = ParseWarSideCapacities("compact:8,compact:2");
    REQUIRE(dup.size() == 1);
    CHECK(dup[0].second == 8);
}

TEST_CASE("war_side_capacities: malformed entries drop individually") {
    const WarSideCapacities caps =
        ParseWarSideCapacities("compact:8,:4,union:x,,union:12");
    REQUIRE(caps.size() == 2);
    CHECK(caps[0].first == "compact");
    CHECK(caps[1].first == "union");
    CHECK(caps[1].second == 12);

    // An absent spec is no capacities at all, so every side takes the
    // fallback — a war that declares none behaves exactly as it did before.
    CHECK(ParseWarSideCapacities("").empty());
}

TEST_CASE("capacity: an unsized side falls back, an authored 0 does not") {
    const WarSideCapacities caps = ParseWarSideCapacities("compact:12,union:0");

    // Sized: the war's own number wins over the uniform fallback.
    CHECK(CapacityForSideIn(caps, "compact", 8) == 12);

    // Authored 0 is WAR_SIDE_CAPACITY_UNLIMITED, chosen — NOT absence. If this
    // returned the fallback, a scenario could never opt a side out of a cap.
    CHECK(CapacityForSideIn(caps, "union", 8) == WAR_SIDE_CAPACITY_UNLIMITED);

    // Unsized: the fallback, which is what every pre-task-7 war has.
    CHECK(CapacityForSideIn(caps, "reavers", 8) == 8);

    // A factionless account has no side and therefore no per-side capacity.
    CHECK(CapacityForSideIn(caps, "", 8) == 8);
}

TEST_CASE("capacity: encode and decode are inverse") {
    const WarSideCapacities in = {{"compact", 8}, {"union", 0}, {"reavers", 32}};
    const std::string spec = EncodeWarSideCapacities(in);
    CHECK(spec == "compact:8,union:0,reavers:32");
    const WarSideCapacities out = ParseWarSideCapacities(spec);
    REQUIRE(out.size() == 3);
    CHECK(out == in);

    // A faction key carrying a separator would reshape the list downstream —
    // dropped at the encoder, exactly as EncodeWarSides drops it.
    CHECK(EncodeWarSideCapacities({{"a,b", 4}, {"c:d", 4}, {"", 4}}).empty());
}

TEST_CASE("GameRoom reads capacity from its modoption, and none by default") {
    GameRoom room;
    CHECK(room.SideCapacities().empty());

    room.modOptions["war_sides"] = "compact:0,union:1";
    room.modOptions["war_side_capacities"] = "compact:4,union:16";
    const auto caps = room.SideCapacities();
    REQUIRE(caps.size() == 2);
    CHECK(CapacityForSideIn(caps, "compact", 8) == 4);
    CHECK(CapacityForSideIn(caps, "union", 8) == 16);

    // The two modoptions are read independently: capacity never renumbers or
    // invents a side, so a room whose capacities name a faction it does not
    // field is simply a capacity nobody can use.
    CHECK(room.SideTeams().size() == 2);
}

// ── 2. Seeding ──────────────────────────────────────────────────────────────

TEST_CASE("seeding: sides are sized to their own faction's population") {
    const WarSides sides = ParseWarSides("compact:0,union:1");
    WarSeedPopulation pop;
    pop.registered = {{"compact", 6}, {"union", 20}};

    const WarSideCapacities caps = SeedSideCapacities(sides, pop);
    REQUIRE(caps.size() == 2);
    CHECK(caps[0].first == "compact");
    CHECK(caps[0].second == 6);
    CHECK(caps[1].first == "union");
    CHECK(caps[1].second == 20);

    // The asymmetry is the point. Sizing both to the smaller population would
    // leave 14 registered union players with nowhere to fight, and a queue is
    // exactly what §6 sets out to avoid.
    CHECK(caps[1].second > caps[0].second);
}

TEST_CASE("seeding: a second war for a faction halves its sides") {
    const WarSides sides = ParseWarSides("compact:0,union:1");
    WarSeedPopulation pop;
    pop.registered = {{"compact", 20}, {"union", 20}};
    pop.warsFielding = {{"compact", 1}, {"union", 1}};

    const WarSideCapacities caps = SeedSideCapacities(sides, pop);
    // 20 spread over the existing war plus this one.
    CHECK(caps[0].second == 10);
    CHECK(caps[1].second == 10);

    // Self-limiting: a surplus faction gets MORE WARS, not one enormous one,
    // which is what keeps an individual war winnable by the people in it.
    pop.warsFielding = {{"compact", 3}, {"union", 3}};
    CHECK(SeedSideCapacities(sides, pop)[0].second == 5);
}

TEST_CASE("seeding: integer ceiling, so an odd population is not stranded") {
    const WarSides sides = ParseWarSides("compact:0");
    WarSeedPopulation pop;
    pop.registered = {{"compact", 9}};
    pop.warsFielding = {{"compact", 1}};
    // 9/2 = 4.5 — floor would give 4 a side, i.e. 8 seats for 9 players.
    CHECK(SeedSideCapacities(sides, pop)[0].second == 5);
}

TEST_CASE("seeding: bounded below and above") {
    const WarSides sides = ParseWarSides("compact:0,union:1");
    WarSeedPopulation pop;
    pop.registered = {{"compact", 0}, {"union", 4000}};

    const WarSideCapacities caps = SeedSideCapacities(sides, pop);
    // A faction nobody has registered for still gets a joinable side: the war
    // must have room for the first person who signs up after it was seeded.
    CHECK(caps[0].second == WAR_SEED_MIN_CAPACITY);
    // And a runaway population must not advertise four thousand seats.
    CHECK(caps[1].second == WAR_SEED_MAX_CAPACITY);
}

// ── 3. Deploy ───────────────────────────────────────────────────────────────

namespace {
DeployCandidate War(uint32_t id, unsigned mine, unsigned capacity,
                    unsigned opposing, unsigned live = 0, bool bound = false) {
    DeployCandidate c;
    c.roomId = id;
    c.fieldsMyFaction = true;
    c.myBound = mine;
    c.myCapacity = capacity;
    c.opposingBound = opposing;
    c.liveHumans = live;
    c.iAmBound = bound;
    return c;
}
}  // namespace

TEST_CASE("deploy: the war where my side is most outnumbered wins") {
    const std::vector<DeployCandidate> wars = {
        War(1, /*mine=*/4, /*cap=*/8, /*opposing=*/4),
        War(2, /*mine=*/1, /*cap=*/8, /*opposing=*/6),
        War(3, /*mine=*/3, /*cap=*/8, /*opposing=*/4),
    };
    const DeployDecision d = DecideDeploy("compact", wars);
    CHECK(d.outcome == DeployOutcome::JoinWar);
    CHECK(d.roomId == 2);
    CHECK(d.underdogBy == 5);
}

TEST_CASE("deploy: a full side is never recommended, however badly it needs me") {
    // The war that needs a compact player most is also the one with no seat.
    const std::vector<DeployCandidate> wars = {
        War(1, /*mine=*/8, /*cap=*/8, /*opposing=*/30),
        War(2, /*mine=*/2, /*cap=*/8, /*opposing=*/3),
    };
    const DeployDecision d = DecideDeploy("compact", wars);
    CHECK(d.outcome == DeployOutcome::JoinWar);
    CHECK(d.roomId == 2);
}

TEST_CASE("deploy: an unlimited side always has room") {
    const std::vector<DeployCandidate> wars = {
        War(1, /*mine=*/40, /*cap=*/WAR_SIDE_CAPACITY_UNLIMITED, /*opposing=*/50),
    };
    CHECK(DecideDeploy("compact", wars).outcome == DeployOutcome::JoinWar);
}

TEST_CASE("deploy: full everywhere seeds a new war rather than queueing") {
    const std::vector<DeployCandidate> wars = {
        War(1, /*mine=*/8, /*cap=*/8, /*opposing=*/2),
        War(2, /*mine=*/8, /*cap=*/8, /*opposing=*/8),
    };
    const DeployDecision d = DecideDeploy("compact", wars);
    CHECK(d.outcome == DeployOutcome::SeedNewWar);
    CHECK(d.roomId == 0);

    // Same answer with no wars at all — the first player of a fresh deployment
    // gets a world, not an empty list.
    CHECK(DecideDeploy("compact", {}).outcome == DeployOutcome::SeedNewWar);
}

TEST_CASE("deploy: a war I already hold a seat in wins outright") {
    // War 2 is crying out for compact players and has room; war 1 is balanced
    // and is MINE. Deploy is for choosing a world, not for abandoning one.
    const std::vector<DeployCandidate> wars = {
        War(1, /*mine=*/4, /*cap=*/8, /*opposing=*/4, /*live=*/0, /*bound=*/true),
        War(2, /*mine=*/0, /*cap=*/8, /*opposing=*/8),
    };
    const DeployDecision d = DecideDeploy("compact", wars);
    CHECK(d.outcome == DeployOutcome::ReturnToMyWar);
    CHECK(d.roomId == 1);
}

TEST_CASE("wars task 3: a bound war with no seat FALLS THROUGH (wars §5)") {
    // CORRECTED 2026-08-16 (wars §9 task 3). This case used to assert the
    // opposite — "my own war wins even when its side is full" — on the
    // reasoning that DecideRejoin's `bypassCapacity` holds the seat anyway.
    // PLAN-metalstorm-wars.md §5 says otherwise, in as many words: "if that
    // side is now full, fall through to `findWar` for another war of the same
    // faction."
    //
    // The old reading confused two different fulls. `bypassCapacity` stops the
    // veteran's OWN held seat from counting against the cap when they join;
    // it does not conjure a seat when the side is full of other people. So the
    // old behaviour sent a returning player at a war with nowhere to sit and
    // the join failed downstream — a preference for a seat that does not exist
    // is a refusal, not a preference.
    //
    // The binding is not lost by falling through: it stays in the table and
    // the veteran returns to it as soon as somebody leaves.
    std::vector<DeployCandidate> wars = {War(1, 8, 8, 8, 0, /*bound=*/true)};
    CHECK(DecideDeploy("compact", wars).outcome == DeployOutcome::SeedNewWar);
    CHECK(DecideDeploy("compact", wars).rejoinFellThrough);

    // …and it falls through to another war of the SAME faction when there is
    // one, rather than seeding a redundant world.
    wars.push_back(War(2, 0, 8, 0));
    const DeployDecision d = DecideDeploy("compact", wars);
    CHECK(d.outcome == DeployOutcome::JoinWar);
    CHECK(d.roomId == 2);
    CHECK(d.rejoinFellThrough);
}

TEST_CASE("wars task 3: falling through is reported, and only when it happened") {
    // An account with no binding anywhere that gets `seed` is the ordinary
    // first-time case and must not be labelled as having been displaced.
    CHECK_FALSE(DecideDeploy("compact", {War(1, 8, 8, 8)}).rejoinFellThrough);
    CHECK_FALSE(DecideDeploy("compact", {War(1, 0, 8, 0, 0, /*bound=*/true)})
                    .rejoinFellThrough);
}

TEST_CASE("deploy: a war that does not field my faction is not a candidate") {
    DeployCandidate other = War(1, 0, 8, 0);
    other.fieldsMyFaction = false;
    CHECK(DecideDeploy("compact", {other}).outcome ==
          DeployOutcome::SeedNewWar);
}

TEST_CASE("deploy: a factionless account is told so, not sent somewhere") {
    // §2.3 — faction is the only thing that may choose a side, so there is
    // nothing to seat on. The account can still spectate anything, which is
    // why this is an outcome and not an error.
    const DeployDecision d = DecideDeploy("", {War(1, 0, 8, 4)});
    CHECK(d.outcome == DeployOutcome::NoFaction);
    CHECK(d.roomId == 0);
}

TEST_CASE("wars task 3: §5's ranking is friends > needed > stakes > freshest") {
    // Each block moves exactly ONE key and holds every key above it equal, so
    // a failure names the key that broke rather than "the ranking changed".

    SUBCASE("friends outrank a bigger deficit") {
        // §8: "people play where their friends are". You can always be needed
        // tomorrow.
        auto withFriend = War(1, 2, 8, 2);
        withFriend.friendsPresent = 1;
        const auto needier = War(2, 0, 8, 8);
        CHECK(DecideDeploy("compact", {withFriend, needier}).roomId == 1);
    }

    SUBCASE("with friends equal, the most outnumbered side wins") {
        const std::vector<DeployCandidate> wars = {War(1, 2, 8, 3),
                                                  War(2, 2, 8, 7)};
        CHECK(DecideDeploy("compact", wars).roomId == 2);
    }

    SUBCASE("with need equal, the higher stakes win") {
        auto low = War(1, 2, 8, 4);
        low.stakes = 10.0;
        auto high = War(2, 2, 8, 4);
        high.stakes = 250.0;
        CHECK(DecideDeploy("compact", {low, high}).roomId == 2);
    }

    SUBCASE("with stakes equal, the FRESHEST war wins") {
        // Freshest, not longest-running: §4's demand seeding creates wars to
        // absorb exactly this traffic, and ranking the incumbent above them
        // would leave every seeded war empty.
        auto older = War(1, 2, 8, 4);
        older.createdAt = 1000;
        auto newer = War(2, 2, 8, 4);
        newer.createdAt = 9000;
        CHECK(DecideDeploy("compact", {older, newer}).roomId == 2);
    }

    SUBCASE("equal in every key — the lowest id, always") {
        // So the same lobby state always deploys the same way and two clients
        // cannot be told different things.
        const std::vector<DeployCandidate> identical = {War(7, 2, 8, 4),
                                                        War(3, 2, 8, 4)};
        CHECK(DecideDeploy("compact", identical).roomId == 3);
    }

    SUBCASE("live population is NOT a key") {
        // It ranked above nothing §5 names and it fought "freshest": a war
        // with people in it is by construction not the fresh one, so a
        // live-population key made demand-seeded wars unreachable.
        auto fresh = War(1, 2, 8, 4, /*live=*/0);
        fresh.createdAt = 9000;
        auto busy = War(2, 2, 8, 4, /*live=*/12);
        busy.createdAt = 1000;
        CHECK(DecideDeploy("compact", {fresh, busy}).roomId == 1);
    }

    SUBCASE("a full side never wins any key") {
        auto perfect = War(1, 8, 8, 8);
        perfect.friendsPresent = 5;
        perfect.stakes = 9999.0;
        perfect.createdAt = 9000;
        const auto plain = War(2, 0, 8, 0);
        CHECK(DecideDeploy("compact", {perfect, plain}).roomId == 2);
    }
}

TEST_CASE("deploy: every outcome names itself for the operator log") {
    CHECK(std::string(DeployOutcomeToString(DeployOutcome::JoinWar)) == "join");
    CHECK(std::string(DeployOutcomeToString(DeployOutcome::ReturnToMyWar)) ==
          "return");
    CHECK(std::string(DeployOutcomeToString(DeployOutcome::SeedNewWar)) ==
          "seed");
    CHECK(std::string(DeployOutcomeToString(DeployOutcome::NoFaction)) ==
          "no_faction");
}
