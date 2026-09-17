#include <doctest/doctest.h>

#include "Server/Journey.h"
#include "Server/Standing.h"
#include "Server/SyncedInputJournal.h"
#include "Server/WarSummary.h"

// PLAN-beta-journey.md §(c)/§(d), lane A2 — one spec per new mechanism.
//
// Three claims, each of which can be false while everything around it works:
//
//  1. **The solo allow-list.** `POST /api/rooms/solo` is the one
//     player-facing route that spawns a process. If the predicate widens, a
//     Recruit can boot a war scenario staged for four factions.
//  2. **The accrual arithmetic.** It is the only place standing is computed,
//     and an absent per-player credit must cost nobody the session they
//     finished.
//  3. **The journalled journey identity.** Tier/mentor/callsign reach the sim
//     through the replay record, so a recording made before they existed must
//     still decode — as a Recruit with no mentor, not as a refusal.

TEST_CASE("solo boot accepts only scenarios authored for one human") {
    // The two flags an author sets.
    CHECK(Journey::SoloAllowed(/*tutorial=*/true, /*solo=*/false, /*retired=*/false));
    CHECK(Journey::SoloAllowed(/*tutorial=*/false, /*solo=*/true, /*retired=*/false));

    // An ordinary war scenario — the case the route exists to refuse.
    CHECK_FALSE(Journey::SoloAllowed(false, false, false));

    // Retired beats both flags: a mission that cannot be fought must not be
    // the one a first-time player is handed.
    CHECK_FALSE(Journey::SoloAllowed(true, true, /*retired=*/true));
    CHECK_FALSE(Journey::SoloAllowed(true, false, /*retired=*/true));
}

TEST_CASE("standing accrual pays the session whether or not objectives are credited") {
    // No per-player credit in the summary (every mission at beta): the
    // session alone.
    const auto bare = Journey::SessionAccrual(0);
    CHECK(bare.sessions == 1);
    CHECK(bare.standing == 10);

    // Credit carried: +5 each, on top of the session.
    CHECK(Journey::SessionAccrual(1).standing == 15);
    CHECK(Journey::SessionAccrual(3).standing == 25);
    CHECK(Journey::SessionAccrual(3).sessions == 1);

    // Clamped, not rejected — this runs in a loop with no failure mode.
    CHECK(Journey::SessionAccrual(-4).standing == 10);

    // The arithmetic lines up with the tier table it feeds: two clean
    // sessions is still a Recruit, the twentieth point is a Regular.
    CHECK(Standing::TierFor(2 * Journey::SessionAccrual(0).standing) == 1);
    CHECK(Standing::TierFor(Journey::SessionAccrual(0).standing) == 0);

    // An endorsement is the same currency, worth more than a session.
    CHECK(Journey::kStandingPerEndorsement > Journey::kStandingPerSession);
}

TEST_CASE("a replay or broadcast room's exit earns no standing; a played room earns the session") {
    // A room that was never a replay or broadcast watch — an ordinary
    // Mission — earns the full +10 for finishing.
    CHECK(Journey::RoomEarnsAccrual(/*isReplayRoom=*/false, /*isBroadcastRoom=*/false));
    CHECK(Journey::SessionAccrual(0).standing == 10);

    // A replay room's "server" is a recording played back, and a broadcast
    // room's is a relay tapped — neither is a Mission, so the health loop
    // must not call SessionAccrual for either at all (zero accrual, not a
    // zero-value accrual).
    CHECK_FALSE(Journey::RoomEarnsAccrual(/*isReplayRoom=*/true, /*isBroadcastRoom=*/false));
    CHECK_FALSE(Journey::RoomEarnsAccrual(/*isReplayRoom=*/false, /*isBroadcastRoom=*/true));
    CHECK_FALSE(Journey::RoomEarnsAccrual(/*isReplayRoom=*/true, /*isBroadcastRoom=*/true));
}

TEST_CASE("war summary carries per-player objective credit, additively") {
    WarSummary s;
    s.sides.push_back({0, "compact", 1, 0, 0, 0});
    s.credits.push_back({"raven", 2});

    WarSummary back;
    REQUIRE(DecodeWarSummary(EncodeWarSummary(s), back));
    REQUIRE(back.credits.size() == 1);
    CHECK(back.credits[0].username == "raven");
    CHECK(back.credits[0].objectives == 2);

    // A summary from a game server that publishes none decodes clean, and the
    // accrual reads it as "credited with none" rather than as a failure.
    WarSummary noCredit;
    noCredit.sides.push_back({0, "compact", 1, 0, 0, 0});
    WarSummary plain;
    REQUIRE(DecodeWarSummary(EncodeWarSummary(noCredit), plain));
    CHECK(plain.credits.empty());
}

TEST_CASE("journey identity survives the journal, and a truncated one is refused") {
    syncedinput::AuthIdentity id;
    id.userId = 7;
    id.username = "raven";
    id.role = "player";
    id.team = 2;
    id.playerNum = 3;
    id.tier = 2;
    id.mentor = "ai";
    id.callsign = "Raven";

    syncedinput::AuthIdentity back;
    REQUIRE(syncedinput::DecodeAuthIdentity(syncedinput::EncodeAuthIdentity(id), back));
    CHECK(back.tier == 2);
    CHECK(back.mentor == "ai");
    CHECK(back.callsign == "Raven");
    CHECK(back.playerNum == 3);

    // Truncation is a refusal, not a half-decode: an identity missing its
    // tier would seat a Veteran as a Recruit in a replay that looked fine.
    auto blob = syncedinput::EncodeAuthIdentity(id);
    blob.pop_back();
    syncedinput::AuthIdentity truncated;
    CHECK_FALSE(syncedinput::DecodeAuthIdentity(blob, truncated));
}
