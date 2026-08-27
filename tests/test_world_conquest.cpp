// PLAN-worldsim.md phase 3 §5: the conquest rule — POI ownership changes at
// war end via an EXPLICIT CLAIM ACT (USER-DECIDED 2026-08-27).
//
// Same shape as test_world_staging.cpp: an in-memory SQLite database with no
// lobby, no game server and no sim, and the POLICY (the deterministic
// tie-break) driven as a pure function with no database at all.
//
// The properties under test are the ones WorldConquest.h promises:
//   - filing charges the account's world authority through the W7 machinery,
//     and refuses the asks that could only burn it (own POI, duplicate claim,
//     not enough authority)
//   - claim-then-win TRANSFERS the POI; win-without-claim KEEPS the owner —
//     `winnerFactions` alone (side keys, shared by many factions) never moves
//     ownership
//   - the defender's shield: an owner on the winning side keeps the ground,
//     and an allied claim cannot snipe it
//   - a losing claimant is refunded-or-forfeits per `claimRefundFraction`
//   - the tie among multiple winning-side claimants is deterministic:
//     earliest `filedAtWorldMs`, then smallest claimId; the runners-up stay
//     open, queued for the next war
//   - expiry runs on the WORLD clock, refunds per config, and a lapsed claim
//     can never win the war that ends after it lapsed
//   - withdrawal refunds once, and a resolved claim cannot be withdrawn
//   - two sequential wars on one world stay consistent (ownership, claim
//     states, settlement labels)
//   - every rate is per-world config with per-key fallback (pillar 7)

#include <doctest/doctest.h>
#include <nlohmann/json.hpp>
#include <sqlite3.h>

#include "Server/WorldConquest.h"
#include "Server/WorldDirector.h"
#include "Server/WorldFactions.h"
#include "Server/WorldStats.h"

namespace {

constexpr int64_t kNow      = 1'700'000'000'000LL;
constexpr int64_t kWorldNow = 5'000'000'000LL;
constexpr const char* kW    = "earth";

struct ConquestDb {
    sqlite3* db = nullptr;
    ConquestDb() {
        REQUIRE(sqlite3_open(":memory:", &db) == SQLITE_OK);
        WorldDirector::EnsureTables(db);
        WorldFactions::EnsureTables(db);
        WorldStats::EnsureTables(db);
        WorldConquest::EnsureTables(db);
        REQUIRE(WorldDirector::SeedDefaultWorld(db, kNow) == kW);
    }
    ~ConquestDb() { sqlite3_close(db); }

    nlohmann::json Config() const {
        const auto w = WorldDirector::Load(db, kW);
        REQUIRE(w.has_value());
        return w->config;
    }
    WorldConquestRules Rules() const {
        return WorldConquestRules::FromWorldConfig(Config());
    }
    WorldFactionRules FactionRules() const {
        return WorldFactionRules::FromWorldConfig(Config());
    }
    void SetConfig(const char* key, double value) {
        auto w = WorldDirector::Load(db, kW);
        REQUIRE(w.has_value());
        w->config[key] = value;
        REQUIRE(WorldDirector::Upsert(db, *w));
    }

    void AddPoi(const std::string& id) {
        WorldPoiRecord p;
        p.worldId   = kW;
        p.poiId     = id;
        p.name      = id;
        p.mapId     = "meridian_basin";
        p.createdAt = kNow;
        REQUIRE(WorldDirector::UpsertPoi(db, p));
    }

    /// Found a faction on `sideKey`, optionally seated at (and so owning) a
    /// POI. Every account starts at the world's 100 authority and founding
    /// spends 50, so a fresh founder has 50 left.
    std::string Found(const std::string& name, int64_t account,
                      const std::string& sideKey,
                      const std::string& seatPoi = std::string()) {
        WorldFactionFoundRequest r;
        r.worldId   = kW;
        r.name      = name;
        r.archetype = kArchetypeOrder;
        r.sideKey   = sideKey;
        r.seatPoiId = seatPoi;
        r.accountId = account;
        r.username  = "player" + std::to_string(account);
        const auto res = WorldFactions::Found(db, FactionRules(), r, kNow);
        REQUIRE_MESSAGE(res.ok, res.error);
        return res.faction->factionId;
    }

    double Authority(int64_t account) const {
        return WorldFactions::AuthorityFor(db, kW, account, FactionRules(), kNow)
            .authority;
    }

    WorldClaimFileResult File(const std::string& poi, const std::string& faction,
                              int64_t account, int64_t worldMs = kWorldNow) {
        WorldClaimFileRequest req;
        req.worldId   = kW;
        req.poiId     = poi;
        req.factionId = faction;
        req.accountId = account;
        return WorldConquest::FileClaim(db, Rules(), FactionRules(), req,
                                        worldMs, kNow);
    }

    /// Record a settlement (the W6 ledger row) and return it with its id
    /// filled — exactly what the lobby's lifecycle sweep hands SettleWar.
    WorldSettlementRecord Settle(const std::string& poi,
                                 const std::string& winners,
                                 uint32_t room = 1) {
        WorldSettlementRecord s;
        s.worldId    = kW;
        s.poiId      = poi;
        s.roomId     = room;
        s.outcome    = "victory_objective";
        s.factions   = winners;
        s.recordedAt = kNow;
        s.settlementId = WorldDirector::RecordSettlement(db, s);
        REQUIRE(s.settlementId > 0);
        return s;
    }

    std::string OwnerOf(const std::string& poi) const {
        const auto p = WorldDirector::LoadPoi(db, kW, poi);
        REQUIRE(p.has_value());
        return p->ownerFactionId;
    }
};

WorldPoiClaimRecord MakeClaim(int64_t id, const std::string& faction,
                              int64_t filedAtWorldMs) {
    WorldPoiClaimRecord c;
    c.claimId        = id;
    c.worldId        = kW;
    c.poiId          = "p";
    c.factionId      = faction;
    c.filedAtWorldMs = filedAtWorldMs;
    c.state          = WorldClaimState::Open;
    return c;
}

}  // namespace

// ─────────────────────────── pure policy ───────────────────────────────────

TEST_CASE("conquest: SelectWinningClaim is deterministic — earliest world-ms, "
          "then smallest claimId, side keys gate") {
    const std::vector<WorldClaimFactionSide> sides = {
        {"alpha", "north"}, {"bravo", "north"}, {"charlie", "south"},
        {"sideless", ""},
    };

    SUBCASE("no winner named resolves nothing") {
        const std::vector<WorldPoiClaimRecord> claims = {MakeClaim(1, "alpha", 10)};
        CHECK_FALSE(SelectWinningClaim(claims, sides, "").has_value());
    }
    SUBCASE("a losing-side claim never wins, however early") {
        const std::vector<WorldPoiClaimRecord> claims = {
            MakeClaim(1, "charlie", 1), MakeClaim(2, "alpha", 100)};
        const auto w = SelectWinningClaim(claims, sides, "north");
        REQUIRE(w.has_value());
        CHECK(*w == 2);
    }
    SUBCASE("earliest filed wins among winning-side claims") {
        const std::vector<WorldPoiClaimRecord> claims = {
            MakeClaim(1, "alpha", 200), MakeClaim(2, "bravo", 100)};
        const auto w = SelectWinningClaim(claims, sides, "north");
        REQUIRE(w.has_value());
        CHECK(*w == 2);
    }
    SUBCASE("a tie on the world clock falls to the smaller claimId") {
        const std::vector<WorldPoiClaimRecord> claims = {
            MakeClaim(7, "bravo", 100), MakeClaim(3, "alpha", 100)};
        const auto w = SelectWinningClaim(claims, sides, "north");
        REQUIRE(w.has_value());
        CHECK(*w == 3);
    }
    SUBCASE("winnerFactions is a comma-separated side list, spaces tolerated") {
        const std::vector<WorldPoiClaimRecord> claims = {MakeClaim(1, "charlie", 5)};
        CHECK(SelectWinningClaim(claims, sides, "north, south").has_value());
    }
    SUBCASE("a faction with no side key (or none listed) can never win") {
        const std::vector<WorldPoiClaimRecord> claims = {
            MakeClaim(1, "sideless", 1), MakeClaim(2, "unknown", 2)};
        CHECK_FALSE(SelectWinningClaim(claims, sides, "north").has_value());
    }
}

// ─────────────────────────── config (pillar 7) ─────────────────────────────

TEST_CASE("conquest: rates are per-world config with per-key fallback") {
    WorldConquestRules def;
    CHECK(def.claimPoiCost == doctest::Approx(25.0));
    CHECK(def.claimRefundFraction == doctest::Approx(0.5));

    // A blob that predates the keys (or is not even an object) serves the
    // defaults — a missing key must not disable the rule it configures.
    CHECK(WorldConquestRules::FromWorldConfig(nlohmann::json::object())
              .claimPoiCost == doctest::Approx(def.claimPoiCost));
    CHECK(WorldConquestRules::FromWorldConfig(nlohmann::json())
              .claimRefundFraction == doctest::Approx(def.claimRefundFraction));

    // A partial blob overrides ONLY its own key.
    nlohmann::json c;
    c["claimPoiCost"] = 10.0;
    const auto r = WorldConquestRules::FromWorldConfig(c);
    CHECK(r.claimPoiCost == doctest::Approx(10.0));
    CHECK(r.claimRefundFraction == doctest::Approx(def.claimRefundFraction));
    CHECK(r.claimExpiryWorldMs == doctest::Approx(def.claimExpiryWorldMs));

    // A seeded world carries all three knobs in its blob.
    ConquestDb f;
    const auto cfg = f.Config();
    CHECK(cfg.contains("claimPoiCost"));
    CHECK(cfg.contains("claimRefundFraction"));
    CHECK(cfg.contains("claimExpiryWorldMs"));
}

// ─────────────────────────── filing ────────────────────────────────────────

TEST_CASE("conquest: filing charges the account's world authority and "
          "refuses the asks that could only burn it") {
    ConquestDb f;
    f.AddPoi("seat");
    f.AddPoi("target");
    const auto alpha = f.Found("Alpha", 11, "north", "seat");
    CHECK(f.Authority(11) == doctest::Approx(50.0));  // 100 start - 50 founding

    SUBCASE("a valid claim opens and charges claimPoiCost") {
        const auto r = f.File("target", alpha, 11);
        REQUIRE_MESSAGE(r.ok, r.error);
        REQUIRE(r.claim.has_value());
        CHECK(r.claim->claimId > 0);
        CHECK(r.claim->cost == doctest::Approx(25.0));
        CHECK(r.claim->state == WorldClaimState::Open);
        CHECK(r.claim->filedAtWorldMs == kWorldNow);
        CHECK(f.Authority(11) == doctest::Approx(25.0));

        // One open claim per faction per POI — a second buys nothing.
        const auto again = f.File("target", alpha, 11);
        CHECK_FALSE(again.ok);
        CHECK(again.error == "already_claimed");
        CHECK(f.Authority(11) == doctest::Approx(25.0));  // nothing charged
    }
    SUBCASE("the owner needs no claim on its own POI") {
        const auto r = f.File("seat", alpha, 11);
        CHECK_FALSE(r.ok);
        CHECK(r.error == "already_owner");
    }
    SUBCASE("a place that is not there") {
        const auto r = f.File("nowhere", alpha, 11);
        CHECK_FALSE(r.ok);
        CHECK(r.error == "no_poi");
    }
    SUBCASE("a faction the world does not know") {
        const auto r = f.File("target", "ghosts", 11);
        CHECK_FALSE(r.ok);
        CHECK(r.error == "no_faction");
    }
    SUBCASE("insufficient authority refuses with the have/need pair and "
            "charges nothing") {
        f.SetConfig("claimPoiCost", 80.0);  // founder holds 50
        const auto r = f.File("target", alpha, 11);
        CHECK_FALSE(r.ok);
        CHECK(r.error == "insufficient_authority");
        CHECK(r.have == doctest::Approx(50.0));
        CHECK(r.need == doctest::Approx(80.0));
        CHECK(f.Authority(11) == doctest::Approx(50.0));
    }
}

// ─────────────────────────── the rule at war end ───────────────────────────

TEST_CASE("conquest: claim-then-win transfers the POI; the winning claim is "
          "labelled and never refunded") {
    ConquestDb f;
    f.AddPoi("dseat");
    f.AddPoi("p");
    const auto defender = f.Found("Defenders", 21, "south", "dseat");
    REQUIRE(WorldDirector::SetPoiOwner(f.db, kW, "p", defender));
    const auto alpha = f.Found("Alpha", 11, "north");

    const auto filed = f.File("p", alpha, 11);
    REQUIRE(filed.ok);
    const double afterFiling = f.Authority(11);

    const auto s = f.Settle("p", "north");
    const auto res = WorldConquest::SettleWar(f.db, s, f.Rules(), kWorldNow, kNow);

    CHECK(res.ownershipChanged);
    CHECK(res.previousOwnerFactionId == defender);
    CHECK(res.newOwnerFactionId == alpha);
    CHECK(res.winningClaimId == filed.claim->claimId);
    CHECK(f.OwnerOf("p") == alpha);

    const auto claim = WorldConquest::Load(f.db, filed.claim->claimId);
    REQUIRE(claim.has_value());
    CHECK(claim->state == WorldClaimState::Won);
    CHECK(claim->settlementId == s.settlementId);
    CHECK(claim->refund == doctest::Approx(0.0));
    // The cost is the price of conquest — winning refunds nothing.
    CHECK(f.Authority(11) == doctest::Approx(afterFiling));
}

TEST_CASE("conquest: winning WITHOUT a claim keeps the current owner — the "
          "side key alone never moves ownership") {
    ConquestDb f;
    f.AddPoi("dseat");
    f.AddPoi("p");
    const auto defender = f.Found("Defenders", 21, "south", "dseat");
    REQUIRE(WorldDirector::SetPoiOwner(f.db, kW, "p", defender));
    f.Found("Alpha", 11, "north");  // exists, fought, filed nothing

    const auto s = f.Settle("p", "north");
    const auto res = WorldConquest::SettleWar(f.db, s, f.Rules(), kWorldNow, kNow);

    CHECK_FALSE(res.ownershipChanged);
    CHECK(f.OwnerOf("p") == defender);
}

TEST_CASE("conquest: the defender's shield — an owner on the winning side "
          "keeps the ground, and an allied claim stays open") {
    ConquestDb f;
    f.AddPoi("p");
    const auto owner = f.Found("Holders", 21, "north", "p");
    const auto ally  = f.Found("Allies", 11, "north");

    const auto filed = f.File("p", ally, 11);
    REQUIRE(filed.ok);

    const auto s = f.Settle("p", "north");
    const auto res = WorldConquest::SettleWar(f.db, s, f.Rules(), kWorldNow, kNow);

    CHECK_FALSE(res.ownershipChanged);
    CHECK(f.OwnerOf("p") == owner);
    const auto claim = WorldConquest::Load(f.db, filed.claim->claimId);
    REQUIRE(claim.has_value());
    CHECK(claim->state == WorldClaimState::Open);  // queued for the next war
}

TEST_CASE("conquest: a losing claimant is refunded-or-forfeits per "
          "claimRefundFraction") {
    ConquestDb f;
    f.AddPoi("dseat");
    f.AddPoi("p");
    const auto defender = f.Found("Defenders", 21, "north", "dseat");
    REQUIRE(WorldDirector::SetPoiOwner(f.db, kW, "p", defender));
    const auto bravo = f.Found("Bravo", 12, "south");

    SUBCASE("default fraction refunds half") {
        const auto filed = f.File("p", bravo, 12);
        REQUIRE(filed.ok);
        CHECK(f.Authority(12) == doctest::Approx(25.0));

        const auto s = f.Settle("p", "north");
        const auto res =
            WorldConquest::SettleWar(f.db, s, f.Rules(), kWorldNow, kNow);
        CHECK_FALSE(res.ownershipChanged);
        CHECK(res.claimsResolvedLost == 1);
        CHECK(res.refunded == doctest::Approx(12.5));
        CHECK(f.Authority(12) == doctest::Approx(37.5));

        const auto claim = WorldConquest::Load(f.db, filed.claim->claimId);
        REQUIRE(claim.has_value());
        CHECK(claim->state == WorldClaimState::Lost);
        CHECK(claim->refund == doctest::Approx(12.5));
        CHECK(claim->settlementId == s.settlementId);
    }
    SUBCASE("a fraction of zero forfeits the whole cost") {
        f.SetConfig("claimRefundFraction", 0.0);
        const auto filed = f.File("p", bravo, 12);
        REQUIRE(filed.ok);
        const auto s = f.Settle("p", "north");
        const auto res =
            WorldConquest::SettleWar(f.db, s, f.Rules(), kWorldNow, kNow);
        CHECK(res.claimsResolvedLost == 1);
        CHECK(res.refunded == doctest::Approx(0.0));
        CHECK(f.Authority(12) == doctest::Approx(25.0));
        const auto claim = WorldConquest::Load(f.db, filed.claim->claimId);
        REQUIRE(claim.has_value());
        CHECK(claim->state == WorldClaimState::Lost);
    }
}

TEST_CASE("conquest: a war with no in-sim winner resolves nothing") {
    ConquestDb f;
    f.AddPoi("dseat");
    f.AddPoi("p");
    const auto defender = f.Found("Defenders", 21, "south", "dseat");
    REQUIRE(WorldDirector::SetPoiOwner(f.db, kW, "p", defender));
    const auto alpha = f.Found("Alpha", 11, "north");
    const auto filed = f.File("p", alpha, 11);
    REQUIRE(filed.ok);

    const auto s = f.Settle("p", "");  // operator retire / season end
    const auto res = WorldConquest::SettleWar(f.db, s, f.Rules(), kWorldNow, kNow);

    CHECK_FALSE(res.ownershipChanged);
    CHECK(res.claimsResolvedLost == 0);
    CHECK(f.OwnerOf("p") == defender);
    const auto claim = WorldConquest::Load(f.db, filed.claim->claimId);
    REQUIRE(claim.has_value());
    CHECK(claim->state == WorldClaimState::Open);
}

TEST_CASE("conquest: the tie among winning-side claimants is earliest-first, "
          "and the runner-up stays open for the next war") {
    ConquestDb f;
    f.AddPoi("dseat");
    f.AddPoi("p");
    const auto defender = f.Found("Defenders", 21, "south", "dseat");
    REQUIRE(WorldDirector::SetPoiOwner(f.db, kW, "p", defender));
    const auto alpha   = f.Found("Alpha", 11, "north");
    const auto charlie = f.Found("Charlie", 13, "north");

    // Charlie files EARLIER on the world clock than Alpha.
    const auto cFiled = f.File("p", charlie, 13, kWorldNow - 500);
    const auto aFiled = f.File("p", alpha, 11, kWorldNow);
    REQUIRE(cFiled.ok);
    REQUIRE(aFiled.ok);

    const auto s = f.Settle("p", "north");
    const auto res = WorldConquest::SettleWar(f.db, s, f.Rules(), kWorldNow, kNow);

    CHECK(res.ownershipChanged);
    CHECK(res.newOwnerFactionId == charlie);
    CHECK(res.winningClaimId == cFiled.claim->claimId);
    CHECK(f.OwnerOf("p") == charlie);

    // Alpha's claim lost no war — its side won — so it stays open, queued.
    const auto a = WorldConquest::Load(f.db, aFiled.claim->claimId);
    REQUIRE(a.has_value());
    CHECK(a->state == WorldClaimState::Open);
}

// ─────────────────────────── expiry / withdrawal ───────────────────────────

TEST_CASE("conquest: expiry runs on the WORLD clock, refunds per config, and "
          "a lapsed claim cannot win the war that ends after it lapsed") {
    ConquestDb f;
    f.AddPoi("dseat");
    f.AddPoi("p");
    const auto defender = f.Found("Defenders", 21, "south", "dseat");
    REQUIRE(WorldDirector::SetPoiOwner(f.db, kW, "p", defender));
    const auto alpha = f.Found("Alpha", 11, "north");

    f.SetConfig("claimExpiryWorldMs", 1000.0);
    const auto filed = f.File("p", alpha, 11, kWorldNow);
    REQUIRE(filed.ok);
    CHECK(f.Authority(11) == doctest::Approx(25.0));

    SUBCASE("ExpireClaims lapses only what is due") {
        CHECK(WorldConquest::ExpireClaims(f.db, kW, f.Rules(),
                                          kWorldNow + 999, kNow) == 0);
        CHECK(WorldConquest::ExpireClaims(f.db, kW, f.Rules(),
                                          kWorldNow + 1000, kNow) == 1);
        // Half the cost back, once; a second sweep finds nothing open.
        CHECK(f.Authority(11) == doctest::Approx(37.5));
        CHECK(WorldConquest::ExpireClaims(f.db, kW, f.Rules(),
                                          kWorldNow + 2000, kNow) == 0);
        const auto claim = WorldConquest::Load(f.db, filed.claim->claimId);
        REQUIRE(claim.has_value());
        CHECK(claim->state == WorldClaimState::Expired);
        CHECK(claim->refund == doctest::Approx(12.5));
    }
    SUBCASE("a settlement after the window expires the claim instead of "
            "crowning it") {
        const auto s = f.Settle("p", "north");
        const auto res = WorldConquest::SettleWar(f.db, s, f.Rules(),
                                                  kWorldNow + 5000, kNow);
        CHECK(res.claimsExpired == 1);
        CHECK_FALSE(res.ownershipChanged);
        CHECK(f.OwnerOf("p") == defender);
        const auto claim = WorldConquest::Load(f.db, filed.claim->claimId);
        REQUIRE(claim.has_value());
        CHECK(claim->state == WorldClaimState::Expired);
    }
    SUBCASE("an expiry of zero disables the rule") {
        f.SetConfig("claimExpiryWorldMs", 0.0);
        CHECK(WorldConquest::ExpireClaims(f.db, kW, f.Rules(),
                                          kWorldNow + 100'000'000, kNow) == 0);
    }
}

TEST_CASE("conquest: withdrawal refunds once, and a resolved claim cannot be "
          "withdrawn") {
    ConquestDb f;
    f.AddPoi("dseat");
    f.AddPoi("p");
    const auto defender = f.Found("Defenders", 21, "south", "dseat");
    REQUIRE(WorldDirector::SetPoiOwner(f.db, kW, "p", defender));
    const auto alpha = f.Found("Alpha", 11, "north");
    const auto filed = f.File("p", alpha, 11);
    REQUIRE(filed.ok);

    SUBCASE("withdraw refunds the configured fraction, exactly once") {
        CHECK(WorldConquest::Withdraw(f.db, f.Rules(), kW,
                                      filed.claim->claimId, kNow));
        CHECK(f.Authority(11) == doctest::Approx(37.5));
        CHECK_FALSE(WorldConquest::Withdraw(f.db, f.Rules(), kW,
                                            filed.claim->claimId, kNow));
        CHECK(f.Authority(11) == doctest::Approx(37.5));
        const auto claim = WorldConquest::Load(f.db, filed.claim->claimId);
        REQUIRE(claim.has_value());
        CHECK(claim->state == WorldClaimState::Withdrawn);
    }
    SUBCASE("a claim a settlement already resolved stays resolved") {
        const auto s = f.Settle("p", "north");
        const auto res =
            WorldConquest::SettleWar(f.db, s, f.Rules(), kWorldNow, kNow);
        REQUIRE(res.ownershipChanged);
        CHECK_FALSE(WorldConquest::Withdraw(f.db, f.Rules(), kW,
                                            filed.claim->claimId, kNow));
        const auto claim = WorldConquest::Load(f.db, filed.claim->claimId);
        REQUIRE(claim.has_value());
        CHECK(claim->state == WorldClaimState::Won);
    }
}

// ─────────────────────────── sequential wars ───────────────────────────────

TEST_CASE("conquest: two sequential wars on one world stay consistent") {
    ConquestDb f;
    f.AddPoi("dseat");
    f.AddPoi("p");
    const auto defender = f.Found("Defenders", 21, "south", "dseat");
    REQUIRE(WorldDirector::SetPoiOwner(f.db, kW, "p", defender));
    const auto alpha = f.Found("Alpha", 11, "north");
    const auto bravo = f.Found("Bravo", 12, "south");

    // War 1: Alpha claims and the north side wins — Alpha takes the POI.
    const auto aFiled = f.File("p", alpha, 11, kWorldNow);
    REQUIRE(aFiled.ok);
    const auto s1 = f.Settle("p", "north", 1);
    const auto r1 = WorldConquest::SettleWar(f.db, s1, f.Rules(), kWorldNow, kNow);
    REQUIRE(r1.ownershipChanged);
    CHECK(f.OwnerOf("p") == alpha);

    // War 2 at the same POI: Bravo claims and the south side wins — the POI
    // moves again, and Alpha (who filed nothing this time) just loses it.
    const auto bFiled = f.File("p", bravo, 12, kWorldNow + 10);
    REQUIRE(bFiled.ok);
    const auto s2 = f.Settle("p", "south", 2);
    REQUIRE(s2.settlementId > s1.settlementId);  // the ledger accumulates
    const auto r2 =
        WorldConquest::SettleWar(f.db, s2, f.Rules(), kWorldNow + 20, kNow);
    REQUIRE(r2.ownershipChanged);
    CHECK(r2.previousOwnerFactionId == alpha);
    CHECK(r2.newOwnerFactionId == bravo);
    CHECK(f.OwnerOf("p") == bravo);

    // Each won claim is labelled with ITS settlement, and the histories of
    // both wars survive side by side.
    const auto a = WorldConquest::Load(f.db, aFiled.claim->claimId);
    const auto b = WorldConquest::Load(f.db, bFiled.claim->claimId);
    REQUIRE(a.has_value());
    REQUIRE(b.has_value());
    CHECK(a->state == WorldClaimState::Won);
    CHECK(a->settlementId == s1.settlementId);
    CHECK(b->state == WorldClaimState::Won);
    CHECK(b->settlementId == s2.settlementId);
    CHECK(WorldDirector::SettlementsFor(f.db, kW).size() == 2);
    CHECK(WorldConquest::ClaimsFor(f.db, kW).size() == 2);

    // Replaying war 2's settlement changes nothing — every claim is already
    // resolved, so the pass is a no-op (the sweep's idempotence).
    const auto replay =
        WorldConquest::SettleWar(f.db, s2, f.Rules(), kWorldNow + 30, kNow);
    CHECK_FALSE(replay.ownershipChanged);
    CHECK(replay.claimsResolvedLost == 0);
    CHECK(f.OwnerOf("p") == bravo);
}

// ─────────────────────────── the read surface ──────────────────────────────

TEST_CASE("conquest: ClaimsJson carries the rates in force and every claim, "
          "newest first") {
    ConquestDb f;
    f.AddPoi("dseat");
    f.AddPoi("p");
    f.AddPoi("q");
    const auto defender = f.Found("Defenders", 21, "south", "dseat");
    REQUIRE(WorldDirector::SetPoiOwner(f.db, kW, "p", defender));
    REQUIRE(WorldDirector::SetPoiOwner(f.db, kW, "q", defender));
    const auto alpha = f.Found("Alpha", 11, "north");
    REQUIRE(f.File("p", alpha, 11).ok);
    REQUIRE(f.File("q", alpha, 11).ok);

    const auto j = WorldConquest::ClaimsJson(f.db, kW, f.Rules());
    CHECK(j["worldId"] == kW);
    CHECK(j["rules"]["claimPoiCost"].get<double>() == doctest::Approx(25.0));
    REQUIRE(j["claims"].is_array());
    REQUIRE(j["claims"].size() == 2);
    CHECK(j["claims"][0]["poi"] == "q");  // newest first
    CHECK(j["claims"][1]["poi"] == "p");
    CHECK(j["claims"][0]["state"] == "open");
    CHECK(j["claims"][0]["faction"] == alpha);
}
