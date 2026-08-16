// PLAN-metalstorm-wars.md §9 task 4 + §10's "Lifecycle" test row: "victory
// objective → winding_down → resolving settles escrow → archived + digest;
// faction elimination triggers end but an empty-but-not-eliminated side does
// not; zero-human war hibernates + freezes (no accrual — the §A8 assertion)".
//
// Two halves, matching the two files. `WarTermination.h` is the RULE and is
// pure, so most of this is arithmetic on structs. `WarLifecycleSweep.cpp` is
// what writes the decision down, and it runs against an in-memory database —
// no lobby, no game server, no sim, which is the property that makes the
// Director testable at all.

#include <doctest/doctest.h>
#include <sqlite3.h>

#include "Server/GameEventsDb.h"
#include "Server/WarLifecycleSweep.h"
#include "Server/WarOutcome.h"
#include "Server/WarTermination.h"

namespace {

struct LifecycleDb {
    sqlite3* db = nullptr;
    LifecycleDb() {
        REQUIRE(sqlite3_open(":memory:", &db) == SQLITE_OK);
        WarDirector::EnsureTables(db);
        WarOutcomeDb::EnsureTable(db);
        GameEventsDb::EnsureTable(db);
    }
    ~LifecycleDb() { sqlite3_close(db); }

    /// Seed a two-sided war and put it in `state`.
    uint32_t SeedWar(WarState state = WarState::Open) {
        WarSeedRequest r;
        r.name          = "Raven Basin";
        r.theatre       = "scorched_crossing_v2.4";
        r.gameId        = "metalstorm";
        r.factions      = {"compact", "union"};
        r.startBoxCount = 6;
        WarSeedPopulation pop;
        pop.registered["compact"] = 8;
        pop.registered["union"]   = 8;
        const WarSeedPlan plan = PlanWarSeed(r, pop);
        REQUIRE(plan.ok);
        REQUIRE(WarDirector::Register(db, 7, plan, 1000));
        // Walked, not jumped: `IsLegalWarTransition` refuses a jump, which is
        // the same rule the sweep itself obeys, so the fixture cannot set up a
        // state the production path could not have produced.
        for (const WarState s : {WarState::Open, WarState::Active,
                                 WarState::WindingDown, WarState::Resolving}) {
            if (state == WarState::Seeding) break;
            REQUIRE(WarDirector::SetState(db, 7, s, 1000));
            if (s == state) break;
        }
        return 7;
    }
};

WarTerminationFacts LiveFacts() {
    WarTerminationFacts f;
    f.simWarState = "active";
    f.footholdsKnown = true;
    f.footholds = {{"compact", 1}, {"union", 1}};
    return f;
}

}  // namespace

// ── The rule: which endings exist, and which emphatically do not ──────────

TEST_CASE("task 4: a live war has no terminal condition") {
    CHECK(EvaluateWarTermination(LiveFacts()) == WarTerminalReason::None);
}

TEST_CASE("task 4: the sim leaving 'active' is the primary ending") {
    auto f = LiveFacts();
    f.simWarState = "winding_down";
    CHECK(EvaluateWarTermination(f) == WarTerminalReason::VictoryObjective);
    f.simWarState = "resolving";
    CHECK(EvaluateWarTermination(f) == WarTerminalReason::VictoryObjective);
    f.simWarState = "over";
    CHECK(EvaluateWarTermination(f) == WarTerminalReason::VictoryObjective);
}

TEST_CASE("task 4: a hibernated war reports no sim state and does not end") {
    // The war's process is a snapshot, so nothing publishes `war_state`. An
    // absent declaration is NOT an ending — it is the ordinary state of every
    // frozen war on the box, and reading it as one would archive the entire
    // population the first time the lobby restarted.
    auto f = LiveFacts();
    f.simWarState.clear();
    CHECK(EvaluateWarTermination(f) == WarTerminalReason::None);
}

TEST_CASE("task 4: faction elimination is the last foothold, not the last player") {
    auto f = LiveFacts();
    f.footholds = {{"compact", 0}, {"union", 2}};
    CHECK(EvaluateWarTermination(f) == WarTerminalReason::FactionElimination);
    CHECK(EliminatedFaction(f) == "compact");
}

TEST_CASE("task 4: an EMPTY-but-not-eliminated side does not end the war") {
    // §10's assertion, and teams §4.5's: persistence keeps empty sides frozen
    // and they are not eliminated. `WarTerminationFacts` carries no player
    // count at all, so the wrong rule is not merely unimplemented here — it is
    // unrepresentable. This case pins that the ONLY census that matters is
    // territorial.
    auto f = LiveFacts();
    f.footholds = {{"compact", 1}, {"union", 1}};   // nobody logged in either
    CHECK(EvaluateWarTermination(f) == WarTerminalReason::None);
}

TEST_CASE("task 4: an unusable census never eliminates anybody") {
    auto f = LiveFacts();
    f.footholdsKnown = false;
    f.footholds = {{"compact", 0}, {"union", 0}};
    CHECK(EvaluateWarTermination(f) == WarTerminalReason::None);
    CHECK(EliminatedFaction(f).empty());
}

TEST_CASE("task 4: 'everybody lost' is a broken census, not a mass ending") {
    // A freshly seeded war's first heartbeat reports all-zero, and so does a
    // scenario edit that flipped every home region at once. Either would
    // otherwise archive every live war on the box.
    auto f = LiveFacts();
    f.footholds = {{"compact", 0}, {"union", 0}};
    CHECK(EvaluateWarTermination(f) == WarTerminalReason::None);
}

TEST_CASE("task 4: a one-sided census cannot eliminate its only side") {
    auto f = LiveFacts();
    f.footholds = {{"compact", 0}};
    CHECK(EliminatedFaction(f).empty());
}

TEST_CASE("task 4: elimination picks the first side in declaration order") {
    auto f = LiveFacts();
    f.footholds = {{"compact", 0}, {"union", 0}, {"reavers", 3}};
    CHECK(EliminatedFaction(f) == "compact");
}

TEST_CASE("task 4: the season boundary ends a war, and only a real boundary does") {
    auto f = LiveFacts();
    f.warSeasonId = "s1";
    f.currentSeasonId = "s2";
    CHECK(EvaluateWarTermination(f) == WarTerminalReason::SeasonEnd);

    f.currentSeasonId = "s1";
    CHECK(EvaluateWarTermination(f) == WarTerminalReason::None);

    // A war with no season in a lobby that has one predates the season
    // system; it does not belong to a finished season.
    f.warSeasonId.clear();
    f.currentSeasonId = "s2";
    CHECK(EvaluateWarTermination(f) == WarTerminalReason::None);

    // And neither configured is the ordinary case.
    f.currentSeasonId.clear();
    CHECK(EvaluateWarTermination(f) == WarTerminalReason::None);
}

TEST_CASE("task 4: operator retire outranks every other condition") {
    auto f = LiveFacts();
    f.operatorRetire = true;
    f.simWarState = "winding_down";
    f.footholds = {{"compact", 0}, {"union", 2}};
    f.warSeasonId = "s1";
    f.currentSeasonId = "s2";
    CHECK(EvaluateWarTermination(f) == WarTerminalReason::OperatorRetire);
}

TEST_CASE("task 4: a war already winding down is not re-diagnosed as elimination") {
    // Otherwise the archive names the wrong reason: the war was won on its
    // objective, and the loser's home falling during the grace period would
    // rewrite the ending under the players.
    auto f = LiveFacts();
    f.simWarState = "resolving";
    f.footholds = {{"compact", 0}, {"union", 2}};
    CHECK(EvaluateWarTermination(f) == WarTerminalReason::VictoryObjective);
}

// ── The chain: one step per sweep ─────────────────────────────────────────

TEST_CASE("task 4: the terminal chain is walked one link at a time") {
    const auto r = WarTerminalReason::VictoryObjective;
    CHECK(NextWarState(WarState::Active, r, false) == WarState::WindingDown);
    CHECK(NextWarState(WarState::WindingDown, r, false) == WarState::Resolving);
    CHECK(NextWarState(WarState::Resolving, r, false) == WarState::Archived);
    CHECK(NextWarState(WarState::Archived, r, false) == WarState::Archived);
}

TEST_CASE("task 4: open → active needs a human, and never goes back") {
    CHECK(NextWarState(WarState::Open, WarTerminalReason::None, true) ==
          WarState::Active);
    CHECK(NextWarState(WarState::Open, WarTerminalReason::None, false) ==
          WarState::Open);
    // The §A8 shape: the last player leaving does not demote the war. An
    // established war reverting to `Open` would look freshly seeded to §4's
    // demand-driven seeding and would reintroduce last-player-out sideways.
    CHECK(NextWarState(WarState::Active, WarTerminalReason::None, false) ==
          WarState::Active);
}

TEST_CASE("task 4: an operator retire skips the chain") {
    const auto r = WarTerminalReason::OperatorRetire;
    CHECK(NextWarState(WarState::Seeding, r, false) == WarState::Archived);
    CHECK(NextWarState(WarState::Active, r, true) == WarState::Archived);
    CHECK(NextWarState(WarState::WindingDown, r, false) == WarState::Archived);
}

TEST_CASE("task 4: a war that dies while seeding archives directly") {
    // There is no wind-down to play out and nobody to notify, and leaving the
    // row in `seeding` would strand a war no legal transition can clean up.
    CHECK(NextWarState(WarState::Seeding, WarTerminalReason::VictoryObjective,
                       false) == WarState::Archived);
}

// ── The sweep: what it writes ─────────────────────────────────────────────

TEST_CASE("task 4: a sweep over a live war writes nothing") {
    LifecycleDb t;
    const uint32_t id = t.SeedWar(WarState::Active);
    CHECK_FALSE(AdvanceWarLifecycle(t.db, id, LiveFacts(), true, 2000).has_value());
    CHECK(WarDirector::Load(t.db, id)->state == WarState::Active);
}

TEST_CASE("task 4: victory → winding_down → resolving → archived + digest") {
    LifecycleDb t;
    const uint32_t id = t.SeedWar(WarState::Active);

    // The game server published its ending before the lobby ever looked.
    WarOutcomeRecord o;
    o.roomId = id;
    o.finalFrame = 10560;
    o.winnerTeam = 1;
    o.winnerFactions = "union";
    o.settledComplete = 2;
    o.settledExpired = 5;
    o.scoreboard = {{3, "veteran", 1, 900.0, 750.0, 6}};
    REQUIRE(WarOutcomeDb::Record(t.db, o));

    auto f = LiveFacts();
    f.simWarState = "winding_down";

    auto s1 = AdvanceWarLifecycle(t.db, id, f, true, 2000);
    REQUIRE(s1.has_value());
    CHECK(s1->to == WarState::WindingDown);
    CHECK_FALSE(s1->archived);

    auto s2 = AdvanceWarLifecycle(t.db, id, f, true, 2001);
    REQUIRE(s2.has_value());
    CHECK(s2->to == WarState::Resolving);
    CHECK_FALSE(s2->archived);

    auto s3 = AdvanceWarLifecycle(t.db, id, f, true, 2002);
    REQUIRE(s3.has_value());
    CHECK(s3->to == WarState::Archived);
    CHECK(s3->archived);

    const auto war = WarDirector::Load(t.db, id);
    REQUIRE(war.has_value());
    CHECK(war->state == WarState::Archived);
    CHECK(war->terminalReason == "victory_objective");
    CHECK(war->retiredAt == 2002);

    // §7 `archived`: "enlisted players get a war-over digest".
    int total = 0;
    const auto events = GameEventsDb::Since(t.db, id, 0, 10, &total);
    REQUIRE(events.size() == 1);
    CHECK(events[0].kind == "war");
    CHECK(events[0].subject == "Raven Basin");
    CHECK(events[0].detail.find("won on its objective") != std::string::npos);
    CHECK(events[0].detail.find("union") != std::string::npos);

    // The final scoreboard survives the archive — the whole reason the ending
    // is a durable table rather than a field on the perishable summary.
    const auto stored = WarOutcomeDb::Load(t.db, id);
    REQUIRE(stored.has_value());
    REQUIRE(stored->scoreboard.size() == 1);
    CHECK(stored->scoreboard[0].name == "veteran");
    CHECK(stored->scoreboard[0].objectives == 6);
    CHECK(stored->settledComplete == 2);
    CHECK(stored->settledExpired == 5);
}

TEST_CASE("task 4: the war-over digest is emitted exactly once, ever") {
    LifecycleDb t;
    const uint32_t id = t.SeedWar(WarState::Resolving);
    auto f = LiveFacts();
    f.simWarState = "over";

    REQUIRE(AdvanceWarLifecycle(t.db, id, f, false, 3000).has_value());
    // Re-observing an archived war is the ordinary case on every sweep, and
    // it survives a lobby restart: the guard is the first-writer-wins reason
    // column, not an in-memory latch that a restart would lose. Without it
    // every enlisted player would be re-told, on every restart, that a war
    // they left last week had ended.
    CHECK_FALSE(AdvanceWarLifecycle(t.db, id, f, false, 3001).has_value());

    int total = 0;
    CHECK(GameEventsDb::Since(t.db, id, 0, 10, &total).size() == 1);
}

TEST_CASE("task 4: an ending the sim never saw archives with no victor") {
    LifecycleDb t;
    const uint32_t id = t.SeedWar(WarState::Active);
    auto f = LiveFacts();
    f.footholds = {{"compact", 0}, {"union", 2}};

    REQUIRE(AdvanceWarLifecycle(t.db, id, f, true, 4000)->to == WarState::WindingDown);
    REQUIRE(AdvanceWarLifecycle(t.db, id, f, true, 4001)->to == WarState::Resolving);
    auto last = AdvanceWarLifecycle(t.db, id, f, true, 4002);
    REQUIRE(last.has_value());
    CHECK(last->archived);
    CHECK(last->eliminatedFaction == "compact");

    CHECK(WarDirector::Load(t.db, id)->terminalReason == "faction_elimination");
    // There is no `war_outcome` row: nothing in the sim ended, the Director
    // did. That is not a gap and the digest simply carries no victor.
    CHECK_FALSE(WarOutcomeDb::Load(t.db, id).has_value());
    const auto events = GameEventsDb::Since(t.db, id, 0, 10, nullptr);
    REQUIRE(events.size() == 1);
    CHECK(events[0].detail.find("Driven out: compact") != std::string::npos);
    CHECK(events[0].detail.find("Victor") == std::string::npos);
}

TEST_CASE("task 4: an operator retire archives in one sweep, from anywhere") {
    LifecycleDb t;
    const uint32_t id = t.SeedWar(WarState::Active);
    auto f = LiveFacts();
    f.operatorRetire = true;

    auto s = AdvanceWarLifecycle(t.db, id, f, true, 5000);
    REQUIRE(s.has_value());
    CHECK(s->to == WarState::Archived);
    CHECK(s->archived);
    CHECK(WarDirector::Load(t.db, id)->terminalReason == "operator_retire");
}

TEST_CASE("task 4: a zero-human war neither ends nor is demoted") {
    // The §A8 assertion, from the Director's side. Nobody is connected, so
    // there is no promotion to `Active` — and, far more importantly, no
    // ending. The war is a frozen row; persistence hibernates its process and
    // the world stops accruing, which is teams §4.5's correction.
    LifecycleDb t;
    const uint32_t id = t.SeedWar(WarState::Open);
    auto f = LiveFacts();
    f.simWarState.clear();          // hibernated: nothing publishes war_state
    f.footholdsKnown = false;       // and nothing publishes a census either

    CHECK_FALSE(AdvanceWarLifecycle(t.db, id, f, false, 6000).has_value());
    const auto war = WarDirector::Load(t.db, id);
    CHECK(war->state == WarState::Open);
    CHECK(war->terminalReason.empty());
    CHECK(war->IsLive());
}

TEST_CASE("task 4: a bound seat in an archived war is no longer a live war") {
    // §7's "bindings closed", modelled as the war leaving the live set rather
    // than as a column: every path that consults a binding filters on live
    // wars first, and the rows have to stay because §7 keeps the war for
    // history.
    LifecycleDb t;
    const uint32_t id = t.SeedWar(WarState::Active);
    REQUIRE(WarDirector::ListLive(t.db).size() == 1);
    CHECK(WarDirector::WarsFielding(t.db, "compact") == 1);

    auto f = LiveFacts();
    f.operatorRetire = true;
    REQUIRE(AdvanceWarLifecycle(t.db, id, f, true, 7000)->archived);

    CHECK(WarDirector::ListLive(t.db).empty());
    CHECK(WarDirector::WarsFielding(t.db, "compact") == 0);
    // The war itself is still there to be browsed as history.
    CHECK(WarDirector::Load(t.db, id).has_value());
}

// ── The outcome store ─────────────────────────────────────────────────────

TEST_CASE("task 4: the outcome row round-trips, and republishing replaces it") {
    LifecycleDb t;
    WarOutcomeRecord o;
    o.roomId = 3;
    o.finalFrame = 9000;
    o.winnerTeam = 0;
    o.winnerFactions = "compact";
    o.settledComplete = 1;
    o.settledExpired = 4;
    o.scoreboard = {{0, "alpha", 0, 100.5, 40.0, 2},
                    {1, "beta", 1, 10.0, 9.0, 0}};
    REQUIRE(WarOutcomeDb::Record(t.db, o));

    auto back = WarOutcomeDb::Load(t.db, 3);
    REQUIRE(back.has_value());
    CHECK(back->finalFrame == 9000);
    CHECK(back->winnerFactions == "compact");
    REQUIRE(back->scoreboard.size() == 2);
    CHECK(back->scoreboard[0].name == "alpha");
    CHECK(back->scoreboard[0].earned == doctest::Approx(100.5));
    CHECK(back->scoreboard[1].team == 1);

    // The heartbeat republishes for the whole post-game window; the row must
    // not accumulate.
    o.settledExpired = 6;
    REQUIRE(WarOutcomeDb::Record(t.db, o));
    CHECK(WarOutcomeDb::Load(t.db, 3)->settledExpired == 6);
}

TEST_CASE("task 4: a corrupt scoreboard archives as empty, never as invention") {
    CHECK(DecodeWarScoreboard("not json").empty());
    CHECK(DecodeWarScoreboard("{}").empty());
    CHECK(DecodeWarScoreboard("[3, \"x\"]").empty());
}

TEST_CASE("task 4: forgetting a room drops its ending, archiving does not") {
    LifecycleDb t;
    const uint32_t id = t.SeedWar(WarState::Active);
    WarOutcomeRecord o;
    o.roomId = id;
    o.winnerFactions = "union";
    REQUIRE(WarOutcomeDb::Record(t.db, o));

    auto f = LiveFacts();
    f.operatorRetire = true;
    REQUIRE(AdvanceWarLifecycle(t.db, id, f, true, 8000)->archived);
    // Archived: the ending survives, because that is what an archive is.
    CHECK(WarOutcomeDb::Load(t.db, id).has_value());

    // Forgotten: the room id is about to be handed to a new war, which must
    // not inherit this one's winner.
    REQUIRE(WarDirector::Forget(t.db, id));
    CHECK_FALSE(WarOutcomeDb::Load(t.db, id).has_value());
}

// ── The rendezvous's completeness rule (second live verification, D2/D3) ────
//
// The defect these cover was structurally invisible to this suite: the sweep
// takes `WarTerminationFacts` as a struct, so every test above simply SET
// `simWarState = "winding_down"` and the question of where that fact comes
// from — a `war_outcome` row the game server publishes on a heartbeat — was
// never asked. Live, at 0.2x sim speed, the war was archived and its digest
// emitted 23 s BEFORE the sim settled a single objective.

TEST_CASE("task 4 D2: an outcome scraped mid-wind-down is not publishable") {
    // `war_state` leaves 'active' at the FIRST frame of the 300-frame grace,
    // when `resolve()` has not run and every field the archive wants still
    // reads 0. This is the exact scrape the game server takes on that
    // heartbeat, and publishing it archives a war that ended at frame 0 with
    // its whole escrow undisposed.
    CHECK_FALSE(IsPublishableWarOutcome("winding_down", 0));
    CHECK_FALSE(IsPublishableWarOutcome("resolving", 0));
    CHECK_FALSE(IsPublishableWarOutcome("over", 0));

    // Still fought, and the two shapes that mean "there is no ending here at
    // all" — a war with no gameover gadget must never be recorded as over
    // (§7.1: a scenario-less war has no terminal condition).
    CHECK_FALSE(IsPublishableWarOutcome("active", 0));
    CHECK_FALSE(IsPublishableWarOutcome("active", 9300));
    CHECK_FALSE(IsPublishableWarOutcome("", 0));
    CHECK_FALSE(IsPublishableWarOutcome("", 9300));

    // `resolve()` ran: it settled every unresolved objective, disposed the
    // escrow and stamped the frame. NOW there is an ending.
    CHECK(IsPublishableWarOutcome("resolving", 9300));
    CHECK(IsPublishableWarOutcome("over", 9300));
}

TEST_CASE("task 4 D2: the lobby's signal is a COMPLETE row, not any row") {
    LifecycleDb t;
    // A hollow row is what D1's truncated wind-down leaves behind: the server
    // hibernated inside the grace, so nothing was ever settled. The writer's
    // gate should stop it existing; if one exists anyway (an older binary, a
    // recycled id), the reader must not archive a war on it.
    WarOutcomeRecord hollow;
    hollow.roomId = 11;
    hollow.finalFrame = 0;
    REQUIRE(WarOutcomeDb::Record(t.db, hollow));
    CHECK_FALSE(WarOutcomeDb::HasOutcome(t.db, 11));
    // The row itself is still readable — this is a completeness gate on the
    // SIGNAL, not a refusal to store what the server sent.
    CHECK(WarOutcomeDb::Load(t.db, 11).has_value());

    // The next heartbeat, after the resolve, repairs it. `Record` replaces on
    // room_id, which is what makes the written-every-heartbeat property safe.
    hollow.finalFrame = 9300;
    hollow.settledComplete = 1;
    REQUIRE(WarOutcomeDb::Record(t.db, hollow));
    CHECK(WarOutcomeDb::HasOutcome(t.db, 11));

    // And a war nobody has published anything for is not over either.
    CHECK_FALSE(WarOutcomeDb::HasOutcome(t.db, 12));
}

TEST_CASE("task 4 D3: the war-over digest is stamped with the frame it ended on") {
    LifecycleDb t;
    const uint32_t id = t.SeedWar(WarState::Resolving);
    WarOutcomeRecord o;
    o.roomId = id;
    o.finalFrame = 9300;
    o.winnerFactions = "union";
    REQUIRE(WarOutcomeDb::Record(t.db, o));

    // `wars.last_active_frame` is deliberately left at its seeded 0 here: that
    // is what every live war's column actually held, because nothing called
    // `TouchActivity` in production at all. The digest must not inherit it.
    const auto war = WarDirector::Load(t.db, id);
    REQUIRE(war->lastActiveFrame == 0);

    auto f = LiveFacts();
    f.simWarState = "over";
    REQUIRE(AdvanceWarLifecycle(t.db, id, f, false, 4000)->archived);

    int total = 0;
    const auto events = GameEventsDb::Since(t.db, id, 0, 10, &total);
    REQUIRE(events.size() == 1);
    CHECK(events[0].frame == 9300);
}

TEST_CASE("task 4 D3: an ending the sim never saw falls back to the war's frame") {
    // An operator retire has no `war_outcome` row at all (§7: there was no
    // in-sim ending to record), so the heartbeat column is the only frame
    // there is — and it now has a writer, so it is no longer always 0.
    LifecycleDb t;
    const uint32_t id = t.SeedWar(WarState::Active);
    REQUIRE(WarDirector::TouchActivity(t.db, id, 5400, 4100));

    auto f = LiveFacts();
    f.operatorRetire = true;
    REQUIRE(AdvanceWarLifecycle(t.db, id, f, true, 4100)->archived);

    int total = 0;
    const auto events = GameEventsDb::Since(t.db, id, 0, 10, &total);
    REQUIRE(events.size() == 1);
    CHECK(events[0].frame == 5400);
}
