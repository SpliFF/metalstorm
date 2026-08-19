// PLAN-worldsim.md W7: world factions + membership.
//
// Same shape as test_world_director.cpp, for the same reason: the faction
// store never touches sim state, so every assertion here runs against an
// in-memory SQLite database with no lobby, no game server and no sim.
//
// What is deliberately NOT here: anything touching `users`. The route layer
// owns that half of the seam, and the rule it applies (`ReconcileSideKey`) is
// a pure function tested below without a Database at all — which is the whole
// reason it is a pure function.

#include <doctest/doctest.h>
#include <nlohmann/json.hpp>
#include <sqlite3.h>

#include "Server/WorldDirector.h"
#include "Server/WorldFactions.h"

namespace {

constexpr int64_t kNow   = 1'700'000'000'000LL;
constexpr const char* kW = "earth";

/// A world with the W7 tables and one seeded world row, so every test starts
/// from the state a real lobby boots into.
struct FactionDb {
    sqlite3* db = nullptr;
    FactionDb() {
        REQUIRE(sqlite3_open(":memory:", &db) == SQLITE_OK);
        WorldDirector::EnsureTables(db);
        WorldFactions::EnsureTables(db);
        REQUIRE(WorldDirector::SeedDefaultWorld(db, kNow) == kW);
    }
    ~FactionDb() { sqlite3_close(db); }

    WorldFactionRules Rules() const {
        const auto w = WorldDirector::Load(db, kW);
        REQUIRE(w.has_value());
        return WorldFactionRules::FromWorldConfig(w->config);
    }

    /// Retune this world's blob — the point of pillar 7 is that a rate is a
    /// row, so the gate tests move the rate rather than the code.
    void SetConfig(const char* key, double value) {
        auto w = WorldDirector::Load(db, kW);
        REQUIRE(w.has_value());
        w->config[key] = value;
        REQUIRE(WorldDirector::Upsert(db, *w));
    }

    void AddPoi(const std::string& id, const std::string& name) {
        WorldPoiRecord p;
        p.worldId = kW;
        p.poiId   = id;
        p.name    = name;
        p.lat     = 48.9;
        p.lon     = 2.4;
        p.createdAt = kNow;
        REQUIRE(WorldDirector::UpsertPoi(db, p));
    }

    WorldFactionFoundRequest Req(const std::string& name, int64_t account,
                                 const std::string& archetype = kArchetypeOrder) {
        WorldFactionFoundRequest r;
        r.worldId   = kW;
        r.name      = name;
        r.archetype = archetype;
        r.accountId = account;
        r.username  = "player" + std::to_string(account);
        return r;
    }
};

bool TableExists(sqlite3* db, const char* name) {
    sqlite3_stmt* s = nullptr;
    REQUIRE(sqlite3_prepare_v2(
                db, "SELECT 1 FROM sqlite_master WHERE type='table' AND name=?",
                -1, &s, nullptr) == SQLITE_OK);
    sqlite3_bind_text(s, 1, name, -1, SQLITE_TRANSIENT);
    const bool found = sqlite3_step(s) == SQLITE_ROW;
    sqlite3_finalize(s);
    return found;
}

}  // namespace

TEST_CASE("W7: the faction tables are world-scoped and never room-scoped") {
    FactionDb h;
    CHECK(TableExists(h.db, "world_factions"));
    CHECK(TableExists(h.db, "world_faction_members"));
    CHECK(TableExists(h.db, "world_authority"));

    // The lane's hard boundary, asserted rather than trusted: a `room_id`
    // column on any of these would be the world layer quietly becoming the
    // battle layer.
    for (const char* table : {"world_factions", "world_faction_members",
                              "world_authority"}) {
        sqlite3_stmt* s = nullptr;
        const std::string sql = std::string("PRAGMA table_info(") + table + ")";
        REQUIRE(sqlite3_prepare_v2(h.db, sql.c_str(), -1, &s, nullptr) == SQLITE_OK);
        bool sawWorldId = false;
        while (sqlite3_step(s) == SQLITE_ROW) {
            const std::string col =
                reinterpret_cast<const char*>(sqlite3_column_text(s, 1));
            CHECK(col != "room_id");
            if (col == "world_id") sawWorldId = true;
        }
        sqlite3_finalize(s);
        CHECK(sawWorldId);
    }
}

TEST_CASE("W7: EnsureTables is idempotent across boots") {
    FactionDb h;
    WorldFactions::EnsureTables(h.db);
    WorldFactions::EnsureTables(h.db);
    CHECK(WorldFactions::ListFor(h.db, kW).empty());
}

TEST_CASE("W7: archetype sheets carry §4's matrix ordering") {
    const auto& all = WorldFactionArchetypes();
    REQUIRE(all.size() == 4);

    const auto order      = WorldFactionArchetypeFor(kArchetypeOrder);
    const auto dynasty    = WorldFactionArchetypeFor(kArchetypeDynasty);
    const auto resistance = WorldFactionArchetypeFor(kArchetypeResistance);
    const auto anarchic   = WorldFactionArchetypeFor(kArchetypeAnarchic);
    REQUIRE(order.has_value());
    REQUIRE(dynasty.has_value());
    REQUIRE(resistance.has_value());
    REQUIRE(anarchic.has_value());

    // The matrix's designed content is the ORDERING, so that is what is
    // pinned — the absolute numbers are a scale and are free to move.
    CHECK(order->parameters.command > dynasty->parameters.command);
    CHECK(order->parameters.production > resistance->parameters.production);
    CHECK(dynasty->parameters.finance > resistance->parameters.finance);
    // Capture 8, user-directed: the Dynasty is the ancient-tech archetype.
    CHECK(dynasty->parameters.technology > order->parameters.technology);
    CHECK(dynasty->parameters.technology > anarchic->parameters.technology);
    // §4: sympathisers make the Resistance the intel archetype, devotion the
    // loyalty one.
    CHECK(resistance->parameters.intel > order->parameters.intel);
    CHECK(resistance->parameters.loyalty > order->parameters.loyalty);
    // Salvage and scavenging.
    CHECK(anarchic->parameters.mining > order->parameters.mining);
    CHECK(anarchic->parameters.archaeology > order->parameters.archaeology);

    // Capture 25's governance spectrum, one per archetype.
    CHECK(order->governance == "hierarchical");
    CHECK(dynasty->governance == "council");
    CHECK(resistance->governance == "consensus");
    CHECK(anarchic->governance == "minimal");

    CHECK_FALSE(WorldFactionArchetypeFor("engineer-guild").has_value());
}

TEST_CASE("W7: parameters round-trip through JSON") {
    const auto sheet = WorldFactionArchetypeFor(kArchetypeDynasty)->parameters;
    const auto back = WorldFactionParameters::FromJson(sheet.ToJson());
    CHECK(back.technology == doctest::Approx(sheet.technology));
    CHECK(back.finance == doctest::Approx(sheet.finance));
    CHECK(back.electronics == doctest::Approx(sheet.electronics));
}

TEST_CASE("W7: names slugify to one id and refuse the unusable") {
    CHECK(SlugifyFactionName("House Verendi") == "house-verendi");
    CHECK(SlugifyFactionName("House  Verendi!") == "house-verendi");
    CHECK(SlugifyFactionName("  the 14th of Ash  ") == "the-14th-of-ash");
    CHECK(SlugifyFactionName("---") == "");

    WorldFactionRules rules;
    CHECK(ValidateFactionName("House Verendi", rules).empty());
    CHECK_FALSE(ValidateFactionName("ab", rules).empty());
    CHECK_FALSE(ValidateFactionName(std::string(200, 'x'), rules).empty());
    // Untrusted player content: a control character never travels into a
    // roster line.
    CHECK_FALSE(ValidateFactionName("House\nVerendi", rules).empty());
    // Nothing alphanumeric survives, so there is no id to key it by.
    CHECK_FALSE(ValidateFactionName("!!!!", rules).empty());
    // Non-ASCII is player content, not a defect — refusing it would refuse
    // most of the world's own languages.
    CHECK(ValidateFactionName("Maison Verendi — Deuxième", rules).empty());
}

TEST_CASE("W7: the founding gate is the world's number, not the code's") {
    FactionDb h;
    // Default world: starting authority clears the default threshold.
    auto r = WorldFactions::Found(h.db, h.Rules(), h.Req("House Verendi", 7), kNow);
    REQUIRE(r.ok);
    CHECK(r.faction->factionId == "house-verendi");
    CHECK(r.faction->founderAccountId == 7);
    CHECK(r.faction->state == "active");

    // The spend landed and it is the world's number.
    const auto rules = h.Rules();
    const auto after = WorldFactions::AuthorityFor(h.db, kW, 7, rules, kNow);
    CHECK(after.authority ==
          doctest::Approx(rules.startingAuthority - rules.foundFactionCost));

    // A second player cannot clear a threshold the world has raised — and the
    // rate moved without a rebuild, which is the point.
    h.SetConfig("foundFactionAuthority", 5000.0);
    auto refused = WorldFactions::Found(h.db, h.Rules(), h.Req("Third Armoured", 8), kNow);
    CHECK_FALSE(refused.ok);
    CHECK(refused.error == "insufficient_authority");
    CHECK(refused.need == doctest::Approx(5000.0));
    CHECK(refused.have == doctest::Approx(100.0));
    // Nothing was spent on a refused founding.
    CHECK(WorldFactions::AuthorityFor(h.db, kW, 8, h.Rules(), kNow).authority ==
          doctest::Approx(100.0));
    CHECK(WorldFactions::ListFor(h.db, kW).size() == 1);
}

TEST_CASE("W7: a world config that predates W7 still gates founding") {
    FactionDb h;
    // A world seeded by a W1..W6 build: the blob has the POI knobs and none of
    // the faction ones. A missing key must fall back per key, not disable the
    // rule it configures.
    auto w = WorldDirector::Load(h.db, kW);
    REQUIRE(w.has_value());
    w->config = nlohmann::json::object();
    w->config["poiBudgetInitial"] = 8;
    REQUIRE(WorldDirector::Upsert(h.db, *w));

    const auto rules = h.Rules();
    CHECK(rules.foundFactionAuthority == doctest::Approx(WorldDefaults{}.foundFactionAuthority));
    CHECK(rules.startingAuthority == doctest::Approx(WorldDefaults{}.startingAuthority));
    CHECK(rules.nameMaxLen == WorldDefaults{}.factionNameMaxLen);

    CHECK(WorldFactions::Found(h.db, rules, h.Req("Third Armoured", 3), kNow).ok);
}

TEST_CASE("W7: founding refuses a bad name, a bad archetype and a taken name") {
    FactionDb h;
    CHECK(WorldFactions::Found(h.db, h.Rules(), h.Req("ab", 1), kNow).error == "bad_name");
    CHECK(WorldFactions::Found(h.db, h.Rules(),
                               h.Req("Third Armoured", 1, "engineer-guild"), kNow)
              .error == "bad_archetype");

    REQUIRE(WorldFactions::Found(h.db, h.Rules(), h.Req("Third Armoured", 1), kNow).ok);
    // A different spelling of the same id is the same faction to every player
    // reading the map, so it is refused.
    const auto dup = WorldFactions::Found(h.db, h.Rules(), h.Req("third  armoured!", 2), kNow);
    CHECK(dup.error == "name_taken");
}

TEST_CASE("W7: one faction per player per world") {
    FactionDb h;
    REQUIRE(WorldFactions::Found(h.db, h.Rules(), h.Req("Third Armoured", 1), kNow).ok);
    const auto second =
        WorldFactions::Found(h.db, h.Rules(), h.Req("House Verendi", 1), kNow);
    CHECK(second.error == "already_member");

    REQUIRE(WorldFactions::Found(h.db, h.Rules(), h.Req("House Verendi", 2), kNow).ok);
    CHECK(WorldFactions::Join(h.db, kW, "third-armoured", 2, "player2", kNow).error ==
          "already_member");
}

TEST_CASE("W7: join, leave, and the roster that dormancy follows") {
    FactionDb h;
    REQUIRE(WorldFactions::Found(h.db, h.Rules(), h.Req("Third Armoured", 1), kNow).ok);

    CHECK(WorldFactions::Join(h.db, kW, "no-such-faction", 2, "player2", kNow).error ==
          "no_such_faction");
    REQUIRE(WorldFactions::Join(h.db, kW, "third-armoured", 2, "player2", kNow).ok);
    // Joining a faction you are already in is the caller's intent already
    // satisfied, not a conflict.
    CHECK(WorldFactions::Join(h.db, kW, "third-armoured", 2, "player2", kNow).ok);

    CHECK(WorldFactions::MembersOf(h.db, kW, "third-armoured").size() == 2);
    const auto founder = WorldFactions::MembershipFor(h.db, kW, 1);
    REQUIRE(founder.has_value());
    CHECK(founder->role == "founder");
    const auto member = WorldFactions::MembershipFor(h.db, kW, 2);
    REQUIRE(member.has_value());
    CHECK(member->role == "member");

    CHECK(WorldFactions::Leave(h.db, kW, 2));
    CHECK_FALSE(WorldFactions::MembershipFor(h.db, kW, 2).has_value());
    // Leaving twice is a no-op, reported as one.
    CHECK_FALSE(WorldFactions::Leave(h.db, kW, 2));
    CHECK(WorldFactions::Load(h.db, kW, "third-armoured")->state == "active");

    // The last member out marks it dormant; the row survives, because its POIs
    // and its history still name it.
    CHECK(WorldFactions::Leave(h.db, kW, 1));
    const auto dormant = WorldFactions::Load(h.db, kW, "third-armoured");
    REQUIRE(dormant.has_value());
    CHECK(dormant->state == "dormant");

    // And a joiner revives it, so the flag can never disagree with the roster.
    REQUIRE(WorldFactions::Join(h.db, kW, "third-armoured", 3, "player3", kNow).ok);
    CHECK(WorldFactions::Load(h.db, kW, "third-armoured")->state == "active");
}

TEST_CASE("W7: the seat POI becomes the faction's, and only once") {
    FactionDb h;
    h.AddPoi("randtown", "Randtown");

    auto req = h.Req("Third Armoured", 1);
    req.seatPoiId = "no-such-poi";
    CHECK(WorldFactions::Found(h.db, h.Rules(), req, kNow).error == "bad_seat");
    // A refused seat cost nothing: the resolve happens before the spend.
    CHECK(WorldFactions::AuthorityFor(h.db, kW, 1, h.Rules(), kNow).authority ==
          doctest::Approx(100.0));

    req.seatPoiId = "randtown";
    REQUIRE(WorldFactions::Found(h.db, h.Rules(), req, kNow).ok);
    const auto poi = WorldDirector::LoadPoi(h.db, kW, "randtown");
    REQUIRE(poi.has_value());
    CHECK(poi->ownerFactionId == "third-armoured");

    auto second = h.Req("House Verendi", 2);
    second.seatPoiId = "randtown";
    CHECK(WorldFactions::Found(h.db, h.Rules(), second, kNow).error == "seat_taken");
}

TEST_CASE("W7: POI ownership survives a geography upsert and reaches the map JSON") {
    FactionDb h;
    h.AddPoi("randtown", "Randtown");
    auto req = h.Req("Third Armoured", 1);
    req.seatPoiId = "randtown";
    REQUIRE(WorldFactions::Found(h.db, h.Rules(), req, kNow).ok);

    // A seeder re-running must not hand a POI back to nobody: ownership moves
    // on a different cadence than geography, so UpsertPoi does not carry it.
    WorldPoiRecord reseed;
    reseed.worldId = kW;
    reseed.poiId   = "randtown";
    reseed.name    = "Randtown";
    reseed.mapId   = "meridian_basin";
    reseed.createdAt = kNow;
    REQUIRE(WorldDirector::UpsertPoi(h.db, reseed));
    CHECK(WorldDirector::LoadPoi(h.db, kW, "randtown")->ownerFactionId ==
          "third-armoured");

    const nlohmann::json body = WorldFactions::AttachFactions(
        WorldDirector::WorldPoisJson(h.db, kW), h.db, kW);
    REQUIRE(body["pois"].size() == 1);
    CHECK(body["pois"][0]["owner"] == "third-armoured");
    REQUIRE(body.contains("factions"));
    CHECK(body["factions"]["third-armoured"]["name"] == "Third Armoured");
    // The colour came from the archetype sheet, which is what paints the map.
    CHECK(body["factions"]["third-armoured"]["colour"] ==
          WorldFactionArchetypeFor(kArchetypeOrder)->colour);

    // An unowned POI is null, not "": the map branches on "is there an owner".
    h.AddPoi("ashfall", "Ashfall");
    const nlohmann::json again = WorldDirector::WorldPoisJson(h.db, kW);
    for (const auto& p : again["pois"])
        if (p["id"] == "ashfall") CHECK(p["owner"].is_null());
}

TEST_CASE("W7: the archetype sheet is copied at founding, not referenced") {
    FactionDb h;
    REQUIRE(WorldFactions::Found(h.db, h.Rules(),
                                 h.Req("House Verendi", 1, kArchetypeDynasty), kNow).ok);
    auto f = WorldFactions::Load(h.db, kW, "house-verendi");
    REQUIRE(f.has_value());
    CHECK(f->governance == "council");
    CHECK(f->config["nameRegister"] == "dynastic");
    const auto sheet = WorldFactionParameters::FromJson(f->config["parameters"]);
    CHECK(sheet.technology ==
          doctest::Approx(WorldFactionArchetypeFor(kArchetypeDynasty)->parameters.technology));

    // §4: "deviation edits the copy" — an edited faction stays edited.
    f->config["parameters"]["technology"] = 0.9;
    REQUIRE(WorldFactions::Upsert(h.db, *f));
    CHECK(WorldFactions::Load(h.db, kW, "house-verendi")
              ->config["parameters"]["technology"] == 0.9);
    // And the archetype it was cast from is untouched.
    CHECK(WorldFactionArchetypeFor(kArchetypeDynasty)->parameters.technology < 0.9);
}

TEST_CASE("W7: a founder's overrides beat the archetype, a bad colour does not") {
    FactionDb h;
    auto req = h.Req("Third Armoured", 1);
    req.governance = "consensus";
    req.colour = "#ff00aa";
    REQUIRE(WorldFactions::Found(h.db, h.Rules(), req, kNow).ok);
    auto f = WorldFactions::Load(h.db, kW, "third-armoured");
    CHECK(f->governance == "consensus");
    CHECK(f->colour == "#ff00aa");

    auto bad = h.Req("House Verendi", 2);
    // A colour goes straight into a canvas fillStyle, so anything that is not
    // exactly #rrggbb falls back to the archetype's rather than being escaped.
    bad.colour = "red; background:url(x)";
    REQUIRE(WorldFactions::Found(h.db, h.Rules(), bad, kNow).ok);
    CHECK(WorldFactions::Load(h.db, kW, "house-verendi")->colour ==
          WorldFactionArchetypeFor(kArchetypeOrder)->colour);
}

TEST_CASE("W7: authority is per world, per account, and never negative") {
    FactionDb h;
    const auto rules = h.Rules();
    const auto first = WorldFactions::AuthorityFor(h.db, kW, 11, rules, kNow);
    CHECK(first.authority == doctest::Approx(rules.startingAuthority));

    // The grant persists — the number shown is the number the gate reads back.
    REQUIRE(WorldFactions::AdjustAuthority(h.db, kW, 11, -30.0, kNow));
    CHECK(WorldFactions::AuthorityFor(h.db, kW, 11, rules, kNow).authority ==
          doctest::Approx(rules.startingAuthority - 30.0));

    // Overspending floors at zero rather than going negative, which would make
    // the founding gate mean something different for that player forever.
    REQUIRE(WorldFactions::AdjustAuthority(h.db, kW, 11, -1000.0, kNow));
    CHECK(WorldFactions::AuthorityFor(h.db, kW, 11, rules, kNow).authority ==
          doctest::Approx(0.0));

    // A second world is a separate ledger.
    WorldRecord other;
    other.worldId = "mars";
    other.name = "Mars";
    other.createdAt = kNow;
    other.clock.epochRealMs = kNow;
    REQUIRE(WorldDirector::Upsert(h.db, other));
    CHECK(WorldFactions::AuthorityFor(h.db, "mars", 11, rules, kNow).authority ==
          doctest::Approx(rules.startingAuthority));
}

TEST_CASE("W7: ReconcileSideKey holds the users.faction_id seam") {
    // Neither side has a key: nothing to do.
    CHECK(ReconcileSideKey("", "") == SideKeyAction::None);
    // The faction fields nobody: a join says nothing about the account's side.
    CHECK(ReconcileSideKey("compact", "") == SideKeyAction::None);
    // They already agree.
    CHECK(ReconcileSideKey("compact", "compact") == SideKeyAction::None);
    // The account has no side and the faction has one: this is the account's
    // side being SET for the first time, which is what nullable-for-unset is.
    CHECK(ReconcileSideKey("", "compact") == SideKeyAction::Adopt);
    // Both set and different: refused. §1a makes a confirmed side permanent —
    // changing it clears the account's war bindings, and a join is not an
    // audited admin override.
    CHECK(ReconcileSideKey("union", "compact") == SideKeyAction::Refuse);
}

TEST_CASE("W7: the route bodies are answerable without a socket") {
    FactionDb h;
    h.AddPoi("randtown", "Randtown");
    auto req = h.Req("House Verendi", 4, kArchetypeDynasty);
    req.seatPoiId = "randtown";
    req.sideKey = "compact";
    REQUIRE(WorldFactions::Found(h.db, h.Rules(), req, kNow).ok);
    REQUIRE(WorldFactions::Join(h.db, kW, "house-verendi", 5, "player5", kNow).ok);

    const auto rules = h.Rules();
    const nlohmann::json factions = WorldFactions::FactionsJson(h.db, kW, rules);
    REQUIRE(factions["factions"].size() == 1);
    CHECK(factions["factions"][0]["id"] == "house-verendi");
    CHECK(factions["factions"][0]["memberCount"] == 2);
    CHECK(factions["factions"][0]["sideKey"] == "compact");
    // The catalogue rides along so a "found a faction" form is one round-trip.
    CHECK(factions["archetypes"].size() == 4);
    CHECK(factions["rules"]["foundFactionAuthority"] ==
          doctest::Approx(rules.foundFactionAuthority));

    const nlohmann::json me = WorldFactions::MeJson(h.db, kW, 4, rules, kNow);
    CHECK(me["membership"]["factionId"] == "house-verendi");
    CHECK(me["membership"]["role"] == "founder");
    CHECK(me["authority"] ==
          doctest::Approx(rules.startingAuthority - rules.foundFactionCost));

    // A player who has never touched this world: no membership, and the gate
    // answer the UI needs before it offers the button.
    const nlohmann::json stranger = WorldFactions::MeJson(h.db, kW, 99, rules, kNow);
    CHECK(stranger["membership"].is_null());
    CHECK(stranger["canFound"] == true);
    CHECK(stranger["authority"] == doctest::Approx(rules.startingAuthority));
}
