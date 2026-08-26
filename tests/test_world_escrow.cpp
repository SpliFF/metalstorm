// The world↔battle escrow seam (PLAN-metalstorm-transports.md §7.3/§7.5).
//
// Same shape as test_world_staging.cpp: an in-memory SQLite database with no
// lobby, no game server and no sim, and the POLICY (§7.5's classification and
// payout arithmetic, the modoption encoding) driven as pure functions with no
// database at all.
//
// The properties under test are the ones WorldEscrow.h promises:
//   - a commitment escrows its OWN counts, atomically with the ledger debit
//     (§7.3 in_transit_out: escrowed, unavailable)
//   - a §7.2 join opens its own escrow row — "who committed what" survives
//   - engagement flips committed→engaged under a guard, and moves no materiel
//   - cancel / terminal staging failure refunds EXACTLY once
//   - §7.5's four outcomes classify and pay out per the table, rates from
//     per-world config (pillar 7)
//   - Settle applies the payout EXACTLY ONCE: settle twice, assert once —
//     including across a two-war sequence replayed end to end
//   - the force ledger is append-only and its SUM is the balance

#include <doctest/doctest.h>
#include <nlohmann/json.hpp>
#include <sqlite3.h>

#include "Server/WorldDirector.h"
#include "Server/WorldEconomy.h"
#include "Server/WorldEscrow.h"
#include "Server/WorldFactions.h"
#include "Server/WorldStaging.h"
#include "Server/WorldStats.h"

namespace {

constexpr int64_t kNow      = 1'700'000'000'000LL;
constexpr int64_t kWorldNow = 5'000'000'000LL;
constexpr const char* kW    = "earth";

struct EscrowDb {
    sqlite3* db = nullptr;
    EscrowDb() {
        REQUIRE(sqlite3_open(":memory:", &db) == SQLITE_OK);
        WorldDirector::EnsureTables(db);
        WorldFactions::EnsureTables(db);
        WorldStats::EnsureTables(db);
        WorldEconomy::EnsureTables(db);
        WorldStaging::EnsureTables(db);
        WorldEscrow::EnsureTables(db);
        REQUIRE(WorldDirector::SeedDefaultWorld(db, kNow) == kW);
    }
    ~EscrowDb() { sqlite3_close(db); }

    WorldStagingRules StagingRules() const {
        const auto w = WorldDirector::Load(db, kW);
        REQUIRE(w.has_value());
        return WorldStagingRules::FromWorldConfig(w->config);
    }

    WorldEscrowRules Rules() const {
        const auto w = WorldDirector::Load(db, kW);
        REQUIRE(w.has_value());
        return WorldEscrowRules::FromWorldConfig(w->config);
    }

    void SetConfig(const char* key, double value) {
        auto w = WorldDirector::Load(db, kW);
        REQUIRE(w.has_value());
        w->config[key] = value;
        REQUIRE(WorldDirector::Upsert(db, *w));
    }

    void AddPoi(const std::string& id, const std::string& owner,
                const std::string& mapId = "meridian_basin") {
        WorldPoiRecord p;
        p.worldId   = kW;
        p.poiId     = id;
        p.name      = id;
        p.mapId     = mapId;
        p.createdAt = kNow;
        REQUIRE(WorldDirector::UpsertPoi(db, p));
        if (!owner.empty())
            REQUIRE(WorldDirector::SetPoiOwner(db, kW, id, owner));
    }

    std::string Found(const std::string& name, int64_t account) {
        WorldFactionFoundRequest r;
        r.worldId   = kW;
        r.name      = name;
        r.archetype = kArchetypeOrder;
        r.accountId = account;
        r.username  = "player" + std::to_string(account);
        const auto w = WorldDirector::Load(db, kW);
        REQUIRE(w.has_value());
        const auto res = WorldFactions::Found(
            db, WorldFactionRules::FromWorldConfig(w->config), r, kNow);
        REQUIRE_MESSAGE(res.ok, res.error);
        return res.faction->factionId;
    }

    /// Commit force at `poi` AND open its escrow, the way the lobby's route
    /// does — one staging commit, one escrow row with THIS commit's counts.
    WorldStagingRecord CommitEscrowed(const std::string& poi,
                                      const std::string& faction,
                                      int transports, int squads) {
        WorldStagingCommitRequest req;
        req.worldId           = kW;
        req.poiId             = poi;
        req.attackerFactionId = faction;
        req.transports        = transports;
        req.squads            = squads;
        req.accountId         = 7;
        const auto res =
            WorldStaging::Commit(db, StagingRules(), req, kWorldNow, kNow);
        REQUIRE_MESSAGE(res.ok, res.error);
        const auto esc = WorldEscrow::Open(db, res.staging, transports, squads,
                                           req.accountId, kNow);
        REQUIRE(esc.has_value());
        return res.staging;
    }

    int LedgerRowCount() {
        sqlite3_stmt* s = nullptr;
        REQUIRE(sqlite3_prepare_v2(db,
                    "SELECT COUNT(*) FROM world_force_ledger", -1, &s,
                    nullptr) == SQLITE_OK);
        REQUIRE(sqlite3_step(s) == SQLITE_ROW);
        const int n = sqlite3_column_int(s, 0);
        sqlite3_finalize(s);
        return n;
    }

    int SpoilsRowCount() {
        sqlite3_stmt* s = nullptr;
        REQUIRE(sqlite3_prepare_v2(db,
                    "SELECT COUNT(*) FROM world_economy_events "
                    "WHERE source='war_spoils'", -1, &s, nullptr) == SQLITE_OK);
        REQUIRE(sqlite3_step(s) == SQLITE_ROW);
        const int n = sqlite3_column_int(s, 0);
        sqlite3_finalize(s);
        return n;
    }
};

}  // namespace

// ─────────────────────────── pure policy: §7.5 ─────────────────────────────

TEST_CASE("§7.5 classification: winner holds, silent loser is annihilated") {
    const WorldEscrowRules rules;
    CHECK(ClassifyEscrowOutcome(true, 0, 4, rules) == WorldEscrowOutcome::Held);
    // A winner is held even with withdrawals recorded — holding the field is
    // the mechanical test, not staying put.
    CHECK(ClassifyEscrowOutcome(true, 4, 4, rules) == WorldEscrowOutcome::Held);
    CHECK(ClassifyEscrowOutcome(false, 0, 4, rules) ==
          WorldEscrowOutcome::Annihilated);
    // Nothing committed, nothing withdrawn: the arithmetic lands it in the
    // same bucket without a special case.
    CHECK(ClassifyEscrowOutcome(false, 0, 0, rules) ==
          WorldEscrowOutcome::Annihilated);
}

TEST_CASE("§7.5 classification: the withdrew/routed threshold") {
    const WorldEscrowRules rules;  // 0.50
    CHECK(ClassifyEscrowOutcome(false, 2, 4, rules) ==
          WorldEscrowOutcome::Withdrew);   // exactly at threshold
    CHECK(ClassifyEscrowOutcome(false, 3, 4, rules) ==
          WorldEscrowOutcome::Withdrew);
    CHECK(ClassifyEscrowOutcome(false, 1, 4, rules) ==
          WorldEscrowOutcome::Routed);     // got someone out, but < 50%
    WorldEscrowRules strict;
    strict.withdrewThresholdFraction = 0.9;
    CHECK(ClassifyEscrowOutcome(false, 3, 4, strict) ==
          WorldEscrowOutcome::Routed);     // the threshold is config, not code
}

TEST_CASE("§7.5 payout: held returns everything and captures nothing") {
    const WorldEscrowRules rules;
    const auto p = PayoutFor(WorldEscrowOutcome::Held, 3, 8, 0.0, rules);
    CHECK(p.returnTransports == 3);
    CHECK(p.returnSquads == 8);
    CHECK(p.captureTransports == 0);
    CHECK(p.captureSquads == 0);
}

TEST_CASE("§7.5 payout: annihilated is a transfer, not a bonfire") {
    const WorldEscrowRules rules;  // capture 0.25
    const auto p = PayoutFor(WorldEscrowOutcome::Annihilated, 4, 8, 0.0, rules);
    CHECK(p.returnTransports == 0);
    CHECK(p.returnSquads == 0);
    CHECK(p.captureTransports == 1);  // floor(0.25 × 4)
    CHECK(p.captureSquads == 2);      // floor(0.25 × 8)
    // The fraction is config (pillar 7): a world that captures half does.
    WorldEscrowRules half;
    half.annihilatedCaptureFraction = 0.5;
    const auto q = PayoutFor(WorldEscrowOutcome::Annihilated, 4, 8, 0.0, half);
    CHECK(q.captureTransports == 2);
    CHECK(q.captureSquads == 4);
}

TEST_CASE("§7.5 payout: withdrew keeps what it carried out, forfeits the rest") {
    const WorldEscrowRules rules;
    const auto p = PayoutFor(WorldEscrowOutcome::Withdrew, 4, 8, 0.75, rules);
    CHECK(p.returnTransports == 3);   // floor(0.75 × 4)
    CHECK(p.returnSquads == 6);
    CHECK(p.captureTransports == 0);  // no capture on a withdrawal
    CHECK(p.captureSquads == 0);
}

TEST_CASE("§7.5 payout: routed keeps what left; the remainder is annihilated") {
    const WorldEscrowRules rules;
    const auto p = PayoutFor(WorldEscrowOutcome::Routed, 4, 8, 0.25, rules);
    CHECK(p.returnTransports == 1);   // floor(0.25 × 4)
    CHECK(p.returnSquads == 2);
    CHECK(p.captureTransports == 0);  // floor(0.25 × (4-1)) = 0 — floors, never mints
    CHECK(p.captureSquads == 1);      // floor(0.25 × (8-2))
}

TEST_CASE("payout arithmetic never returns or captures more than was escrowed") {
    WorldEscrowRules rules;
    rules.annihilatedCaptureFraction = 1.0;
    for (const auto outcome :
         {WorldEscrowOutcome::Held, WorldEscrowOutcome::Withdrew,
          WorldEscrowOutcome::Routed, WorldEscrowOutcome::Annihilated}) {
        const auto p = PayoutFor(outcome, 3, 5, 1.0, rules);
        CHECK(p.returnTransports + p.captureTransports <= 3);
        CHECK(p.returnSquads + p.captureSquads <= 5);
    }
}

TEST_CASE("escrow rules come from per-world config, per key") {
    nlohmann::json cfg;
    cfg["escrowAnnihilatedCaptureFraction"] = 0.4;
    const auto r = WorldEscrowRules::FromWorldConfig(cfg);
    CHECK(r.annihilatedCaptureFraction == doctest::Approx(0.4));
    // The keys the blob omits keep their defaults — a world tuned before this
    // milestone is not opted out of the rule.
    CHECK(r.withdrewThresholdFraction == doctest::Approx(0.5));
    CHECK(r.heldSpoilsTreasury == doctest::Approx(25.0));
}

TEST_CASE("the arrival manifest modoption encodes side, counts and staging id") {
    CHECK(EncodeWorldCommitModOption("union", 2, 5, 41) == "union:2:5:41");
    // Negative counts cannot ride into a battle.
    CHECK(EncodeWorldCommitModOption("union", -1, -2, 7) == "union:0:0:7");
}

// ─────────────────────────── the store ─────────────────────────────────────

TEST_CASE("a commitment escrows its own counts and debits the pool") {
    EscrowDb t;
    const auto attacker = t.Found("Iron Pact", 1);
    const auto defender = t.Found("Home Guard", 2);
    t.AddPoi("ridge", defender);

    const auto staging = t.CommitEscrowed("ridge", attacker, 2, 5);

    const auto rows = WorldEscrow::ForStaging(t.db, staging.stagingId);
    REQUIRE(rows.size() == 1);
    CHECK(rows[0].state == WorldEscrowState::Committed);
    CHECK(rows[0].factionId == attacker);
    CHECK(rows[0].poiId == "ridge");
    CHECK(rows[0].transports == 2);
    CHECK(rows[0].squads == 5);
    CHECK(rows[0].IsHeld());

    // §7.3 in_transit_out: escrowed, UNAVAILABLE — the pool went down the
    // moment the commitment was made.
    const auto bal = WorldEscrow::ForceBalanceFor(t.db, kW, attacker);
    CHECK(bal.transports == -2);
    CHECK(bal.squads == -5);
    const auto ledger = WorldEscrow::LedgerFor(t.db, kW, attacker);
    REQUIRE(ledger.size() == 1);
    CHECK(ledger[0].source == "escrow_commit");
}

TEST_CASE("a §7.2 join opens its OWN escrow row — who committed what survives") {
    EscrowDb t;
    const auto attacker = t.Found("Iron Pact", 1);
    const auto defender = t.Found("Home Guard", 2);
    t.AddPoi("ridge", defender);

    const auto staging = t.CommitEscrowed("ridge", attacker, 1, 1);
    // The late commitment: the lobby route calls Commit (which joins) and
    // then escrows the join's OWN counts.
    WorldStagingCommitRequest req;
    req.worldId           = kW;
    req.poiId             = "ridge";
    req.attackerFactionId = attacker;
    req.transports        = 2;
    req.squads            = 3;
    req.accountId         = 8;
    const auto join =
        WorldStaging::Commit(t.db, t.StagingRules(), req, kWorldNow, kNow);
    REQUIRE(join.ok);
    REQUIRE(join.joined);
    REQUIRE(WorldEscrow::Open(t.db, join.staging, 2, 3, 8, kNow).has_value());

    const auto rows = WorldEscrow::ForStaging(t.db, staging.stagingId);
    REQUIRE(rows.size() == 2);
    CHECK(rows[0].transports == 1);
    CHECK(rows[1].transports == 2);
    CHECK(rows[1].committedByAccountId == 8);
    // And the pool reflects the sum of both debits.
    const auto bal = WorldEscrow::ForceBalanceFor(t.db, kW, attacker);
    CHECK(bal.transports == -3);
    CHECK(bal.squads == -4);
}

TEST_CASE("engagement flips under a guard and moves no materiel") {
    EscrowDb t;
    const auto attacker = t.Found("Iron Pact", 1);
    const auto defender = t.Found("Home Guard", 2);
    t.AddPoi("ridge", defender);
    const auto staging = t.CommitEscrowed("ridge", attacker, 2, 5);

    const int before = t.LedgerRowCount();
    CHECK(WorldEscrow::MarkEngaged(t.db, staging.stagingId, 900, kNow) == 1);
    // Replayed sweep: the guard finds nothing committed and flips nothing.
    CHECK(WorldEscrow::MarkEngaged(t.db, staging.stagingId, 900, kNow) == 0);
    // Engagement moves the force between two ESCROWED states — no ledger row.
    CHECK(t.LedgerRowCount() == before);

    const auto rows = WorldEscrow::ForStaging(t.db, staging.stagingId);
    REQUIRE(rows.size() == 1);
    CHECK(rows[0].state == WorldEscrowState::Engaged);
    CHECK(rows[0].roomId == 900);
    CHECK(WorldEscrow::EngagedStagingsForRoom(t.db, 900) ==
          std::vector<int64_t>{staging.stagingId});
}

TEST_CASE("cancel refunds the escrow exactly once") {
    EscrowDb t;
    const auto attacker = t.Found("Iron Pact", 1);
    const auto defender = t.Found("Home Guard", 2);
    t.AddPoi("ridge", defender);
    const auto staging = t.CommitEscrowed("ridge", attacker, 2, 5);

    CHECK(WorldEscrow::Release(t.db, staging.stagingId, "cancelled", kNow) == 1);
    auto bal = WorldEscrow::ForceBalanceFor(t.db, kW, attacker);
    CHECK(bal.transports == 0);
    CHECK(bal.squads == 0);
    const int rowsAfter = t.LedgerRowCount();

    // The replay: a second release flips nothing and refunds nothing.
    CHECK(WorldEscrow::Release(t.db, staging.stagingId, "cancelled", kNow) == 0);
    CHECK(t.LedgerRowCount() == rowsAfter);
    bal = WorldEscrow::ForceBalanceFor(t.db, kW, attacker);
    CHECK(bal.transports == 0);

    const auto rows = WorldEscrow::ForStaging(t.db, staging.stagingId);
    REQUIRE(rows.size() == 1);
    CHECK(rows[0].state == WorldEscrowState::Released);
    CHECK(rows[0].outcome == "cancelled");
}

TEST_CASE("an engaged row cannot be released — the war owns it now") {
    EscrowDb t;
    const auto attacker = t.Found("Iron Pact", 1);
    const auto defender = t.Found("Home Guard", 2);
    t.AddPoi("ridge", defender);
    const auto staging = t.CommitEscrowed("ridge", attacker, 2, 5);
    REQUIRE(WorldEscrow::MarkEngaged(t.db, staging.stagingId, 900, kNow) == 1);

    CHECK(WorldEscrow::Release(t.db, staging.stagingId, "cancelled", kNow) == 0);
    const auto rows = WorldEscrow::ForStaging(t.db, staging.stagingId);
    CHECK(rows[0].state == WorldEscrowState::Engaged);
    // Still escrowed: no refund appeared.
    CHECK(WorldEscrow::ForceBalanceFor(t.db, kW, attacker).transports == -2);
}

TEST_CASE("held settlement returns the force, pays spoils — exactly once") {
    EscrowDb t;
    const auto attacker = t.Found("Iron Pact", 1);
    const auto defender = t.Found("Home Guard", 2);
    t.AddPoi("ridge", defender);
    const auto staging = t.CommitEscrowed("ridge", attacker, 2, 5);
    REQUIRE(WorldEscrow::MarkEngaged(t.db, staging.stagingId, 900, kNow) == 1);

    WorldEscrowSettleFacts facts;
    facts.outcome = WorldEscrowOutcome::Held;
    const auto first = WorldEscrow::Settle(t.db, staging.stagingId, facts,
                                           t.Rules(), kWorldNow, kNow);
    REQUIRE(first.settled);
    CHECK(first.rows == 1);
    CHECK(first.payout.returnTransports == 2);
    CHECK(first.payout.returnSquads == 5);

    // The force came home: SUM over the ledger is back to zero.
    auto bal = WorldEscrow::ForceBalanceFor(t.db, kW, attacker);
    CHECK(bal.transports == 0);
    CHECK(bal.squads == 0);
    // And the spoils landed in the treasury ledger, once.
    CHECK(t.SpoilsRowCount() == 1);
    CHECK(WorldEconomy::TreasuryFor(t.db, kW, attacker) ==
          doctest::Approx(25.0));

    // THE idempotence assertion: settle twice, assert once. The replay finds
    // nothing engaged, writes no ledger row, no spoils row, and reports
    // itself a no-op.
    const int ledgerRows = t.LedgerRowCount();
    const auto replay = WorldEscrow::Settle(t.db, staging.stagingId, facts,
                                            t.Rules(), kWorldNow, kNow);
    CHECK_FALSE(replay.settled);
    CHECK(replay.rows == 0);
    CHECK(t.LedgerRowCount() == ledgerRows);
    CHECK(t.SpoilsRowCount() == 1);
    CHECK(WorldEconomy::TreasuryFor(t.db, kW, attacker) ==
          doctest::Approx(25.0));

    const auto rows = WorldEscrow::ForStaging(t.db, staging.stagingId);
    CHECK(rows[0].state == WorldEscrowState::Settled);
    CHECK(rows[0].outcome == "held");
    CHECK(WorldEscrow::EngagedStagingsForRoom(t.db, 900).empty());
}

TEST_CASE("annihilated settlement: the victor captures a quarter, once") {
    EscrowDb t;
    const auto attacker = t.Found("Iron Pact", 1);
    const auto defender = t.Found("Home Guard", 2);
    t.AddPoi("ridge", defender);
    const auto staging = t.CommitEscrowed("ridge", attacker, 4, 8);
    REQUIRE(WorldEscrow::MarkEngaged(t.db, staging.stagingId, 901, kNow) == 1);

    WorldEscrowSettleFacts facts;
    facts.outcome         = WorldEscrowOutcome::Annihilated;
    facts.victorFactionId = defender;
    const auto res = WorldEscrow::Settle(t.db, staging.stagingId, facts,
                                         t.Rules(), kWorldNow, kNow);
    REQUIRE(res.settled);
    CHECK(res.payout.captureTransports == 1);
    CHECK(res.payout.captureSquads == 2);

    // The attacker's force is struck from the ledger — the commit debit
    // stands with no return against it.
    CHECK(WorldEscrow::ForceBalanceFor(t.db, kW, attacker).transports == -4);
    CHECK(WorldEscrow::ForceBalanceFor(t.db, kW, attacker).squads == -8);
    // The victor's holdings gained the captured quarter.
    CHECK(WorldEscrow::ForceBalanceFor(t.db, kW, defender).transports == 1);
    CHECK(WorldEscrow::ForceBalanceFor(t.db, kW, defender).squads == 2);
    // No spoils treasury for anyone: the victor's reward is the capture.
    CHECK(t.SpoilsRowCount() == 0);

    // Replay: nothing moves for either faction.
    const int rows = t.LedgerRowCount();
    CHECK_FALSE(WorldEscrow::Settle(t.db, staging.stagingId, facts, t.Rules(),
                                    kWorldNow, kNow)
                    .settled);
    CHECK(t.LedgerRowCount() == rows);
    CHECK(WorldEscrow::ForceBalanceFor(t.db, kW, defender).transports == 1);
}

TEST_CASE("annihilated with no victor named: the captured share is destroyed") {
    EscrowDb t;
    const auto attacker = t.Found("Iron Pact", 1);
    t.AddPoi("ridge", "");  // unowned ground
    const auto staging = t.CommitEscrowed("ridge", attacker, 4, 8);
    REQUIRE(WorldEscrow::MarkEngaged(t.db, staging.stagingId, 902, kNow) == 1);

    WorldEscrowSettleFacts facts;
    facts.outcome = WorldEscrowOutcome::Annihilated;  // victor empty
    const auto res = WorldEscrow::Settle(t.db, staging.stagingId, facts,
                                         t.Rules(), kWorldNow, kNow);
    REQUIRE(res.settled);
    // Only the settled flip and no ledger movement at all: nothing returned,
    // nobody to capture — the commit debit is the whole story.
    const auto ledger = WorldEscrow::LedgerFor(t.db, kW, attacker);
    REQUIRE(ledger.size() == 1);
    CHECK(ledger[0].source == "escrow_commit");
}

TEST_CASE("settling a staging with no engaged escrow writes nothing") {
    EscrowDb t;
    const auto attacker = t.Found("Iron Pact", 1);
    const auto defender = t.Found("Home Guard", 2);
    t.AddPoi("ridge", defender);
    const auto staging = t.CommitEscrowed("ridge", attacker, 2, 5);
    // Never engaged — the window has not materialised.
    WorldEscrowSettleFacts facts;
    facts.outcome = WorldEscrowOutcome::Held;
    const auto res = WorldEscrow::Settle(t.db, staging.stagingId, facts,
                                         t.Rules(), kWorldNow, kNow);
    CHECK_FALSE(res.settled);
    CHECK(WorldEscrow::ForStaging(t.db, staging.stagingId)[0].state ==
          WorldEscrowState::Committed);
}

TEST_CASE("the spoils rate is per-world config") {
    EscrowDb t;
    t.SetConfig("escrowHeldSpoilsTreasury", 100.0);
    const auto attacker = t.Found("Iron Pact", 1);
    const auto defender = t.Found("Home Guard", 2);
    t.AddPoi("ridge", defender);
    const auto staging = t.CommitEscrowed("ridge", attacker, 1, 1);
    REQUIRE(WorldEscrow::MarkEngaged(t.db, staging.stagingId, 903, kNow) == 1);
    WorldEscrowSettleFacts facts;
    facts.outcome = WorldEscrowOutcome::Held;
    REQUIRE(WorldEscrow::Settle(t.db, staging.stagingId, facts, t.Rules(),
                                kWorldNow, kNow)
                .settled);
    CHECK(WorldEconomy::TreasuryFor(t.db, kW, attacker) ==
          doctest::Approx(100.0));
}

// ─────────────────────────── the two-war sequence ──────────────────────────

TEST_CASE("two-war sequence: both settle once, replays settle nothing") {
    EscrowDb t;
    const auto attacker = t.Found("Iron Pact", 1);
    const auto defender = t.Found("Home Guard", 2);
    t.AddPoi("ridge", defender, "meridian_basin");
    t.AddPoi("delta", defender, "crossing");

    // War 1: the expedition to ridge — it will HOLD.
    const auto s1 = t.CommitEscrowed("ridge", attacker, 2, 4);
    REQUIRE(WorldEscrow::MarkEngaged(t.db, s1.stagingId, 910, kNow) == 1);
    // War 2: the expedition to delta — it will be ANNIHILATED. Committed
    // while war 1 is engaged: both debits stand at once.
    const auto s2 = t.CommitEscrowed("delta", attacker, 4, 8);
    REQUIRE(WorldEscrow::MarkEngaged(t.db, s2.stagingId, 911, kNow) == 1);
    CHECK(WorldEscrow::ForceBalanceFor(t.db, kW, attacker).transports == -6);

    // War 1 ends: held.
    WorldEscrowSettleFacts win;
    win.outcome = WorldEscrowOutcome::Held;
    REQUIRE(WorldEscrow::Settle(t.db, s1.stagingId, win, t.Rules(), kWorldNow,
                                kNow)
                .settled);
    // War 2 ends: annihilated, defender captures.
    WorldEscrowSettleFacts loss;
    loss.outcome         = WorldEscrowOutcome::Annihilated;
    loss.victorFactionId = defender;
    REQUIRE(WorldEscrow::Settle(t.db, s2.stagingId, loss, t.Rules(), kWorldNow,
                                kNow)
                .settled);

    // The books after both settlements, from the append-only ledger alone.
    const auto att = WorldEscrow::ForceBalanceFor(t.db, kW, attacker);
    CHECK(att.transports == -4);  // war 1's force home, war 2's struck
    CHECK(att.squads == -8);
    const auto def = WorldEscrow::ForceBalanceFor(t.db, kW, defender);
    CHECK(def.transports == 1);
    CHECK(def.squads == 2);
    const double treasury = WorldEconomy::TreasuryFor(t.db, kW, attacker);
    const int ledgerRows  = t.LedgerRowCount();
    const int spoilsRows  = t.SpoilsRowCount();
    CHECK(spoilsRows == 1);

    // THE REPLAY: the war-end sweep fires again for both rooms — a lobby
    // restart mid-archive, a second sweep, any of the replay shapes. Every
    // number above must be bit-identical afterwards.
    for (int pass = 0; pass < 2; ++pass) {
        CHECK(WorldEscrow::EngagedStagingsForRoom(t.db, 910).empty());
        CHECK(WorldEscrow::EngagedStagingsForRoom(t.db, 911).empty());
        CHECK_FALSE(WorldEscrow::Settle(t.db, s1.stagingId, win, t.Rules(),
                                        kWorldNow, kNow)
                        .settled);
        CHECK_FALSE(WorldEscrow::Settle(t.db, s2.stagingId, loss, t.Rules(),
                                        kWorldNow, kNow)
                        .settled);
    }
    CHECK(t.LedgerRowCount() == ledgerRows);
    CHECK(t.SpoilsRowCount() == spoilsRows);
    CHECK(WorldEconomy::TreasuryFor(t.db, kW, attacker) ==
          doctest::Approx(treasury));
    const auto att2 = WorldEscrow::ForceBalanceFor(t.db, kW, attacker);
    CHECK(att2.transports == att.transports);
    CHECK(att2.squads == att.squads);
    const auto def2 = WorldEscrow::ForceBalanceFor(t.db, kW, defender);
    CHECK(def2.transports == def.transports);
    CHECK(def2.squads == def.squads);

    // A room id REUSED by a later war must not see the old escrow: the state
    // guard, not the label, keeps the answer clean.
    const auto s3 = t.CommitEscrowed("ridge", attacker, 1, 1);
    REQUIRE(WorldEscrow::MarkEngaged(t.db, s3.stagingId, 910, kNow) == 1);
    CHECK(WorldEscrow::EngagedStagingsForRoom(t.db, 910) ==
          std::vector<int64_t>{s3.stagingId});
}
