// PLAN-worldsim.md W11: staging alerts.
//
// Same shape as test_world_staging.cpp: an in-memory SQLite database with no
// lobby, no game server and no sim. The properties under test are the ones
// WorldNotifications.h promises:
//   - the JSON shape and the headline sentence, per kind
//   - the recipient union: attacker members ∪ defender members ∪ commanders
//     garrisoned at the POI, deduplicated, with either faction id legally
//     empty
//   - the bus: every subscribed sink fires, in order, and zero subscribers is
//     not a crash

#include <doctest/doctest.h>
#include <nlohmann/json.hpp>
#include <sqlite3.h>

#include <algorithm>
#include <vector>

#include "Server/WorldDirector.h"
#include "Server/WorldFactions.h"
#include "Server/WorldNotifications.h"
#include "Server/WorldStats.h"

namespace {

constexpr int64_t kNow      = 1'700'000'000'000LL;
constexpr int64_t kWorldNow = 5'000'000'000LL;
constexpr const char* kW    = "earth";

struct NoticeDb {
    sqlite3* db = nullptr;
    NoticeDb() {
        REQUIRE(sqlite3_open(":memory:", &db) == SQLITE_OK);
        WorldDirector::EnsureTables(db);
        WorldFactions::EnsureTables(db);
        WorldStats::EnsureTables(db);
        REQUIRE(WorldDirector::SeedDefaultWorld(db, kNow) == kW);
    }
    ~NoticeDb() { sqlite3_close(db); }

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

    void Join(const std::string& factionId, int64_t account) {
        const auto res = WorldFactions::Join(db, kW, factionId, account,
                                             "player" + std::to_string(account), kNow);
        REQUIRE_MESSAGE(res.ok, res.error);
    }

    void GrantCommanderAt(int64_t account, const std::string& factionId,
                          const std::string& poiId) {
        const auto c = WorldStats::GrantCommander(
            db, kW, account, "player" + std::to_string(account), factionId,
            poiId, /*authority=*/0.0, kNow, kWorldNow);
        REQUIRE(c.has_value());
    }
};

} // namespace

TEST_CASE("W11: notification kind strings") {
    CHECK(std::string(WorldNotificationKindToString(WorldNotificationKind::StagingOpened)) == "opened");
    CHECK(std::string(WorldNotificationKindToString(WorldNotificationKind::StagingMaterialised)) == "materialised");
    CHECK(std::string(WorldNotificationKindToString(WorldNotificationKind::StagingCancelled)) == "cancelled");
    CHECK(std::string(WorldNotificationKindToString(WorldNotificationKind::StagingFailed)) == "failed");
}

TEST_CASE("W11: headline names the POI, and falls back when it has none") {
    CHECK(WorldNotificationHeadline(WorldNotificationKind::StagingOpened, "Randtown")
          .find("Randtown") != std::string::npos);
    CHECK(WorldNotificationHeadline(WorldNotificationKind::StagingMaterialised, "")
          .find("point of interest") != std::string::npos);
    // Every kind gets a distinct sentence — a toast/list row that read the
    // same for "opened" and "cancelled" would be worse than no headline.
    std::vector<WorldNotificationKind> kinds = {
        WorldNotificationKind::StagingOpened, WorldNotificationKind::StagingMaterialised,
        WorldNotificationKind::StagingCancelled, WorldNotificationKind::StagingFailed,
    };
    std::vector<std::string> seen;
    for (auto k : kinds) seen.push_back(WorldNotificationHeadline(k, "Randtown"));
    for (size_t i = 0; i < seen.size(); ++i)
        for (size_t j = i + 1; j < seen.size(); ++j)
            CHECK(seen[i] != seen[j]);
}

TEST_CASE("W11: ToJson carries every field, and defaults the headline") {
    WorldNotificationEvent ev;
    ev.worldId            = kW;
    ev.poiId               = "randtown";
    ev.poiName             = "Randtown";
    ev.kind                = WorldNotificationKind::StagingOpened;
    ev.attackerFactionId  = "iron-order";
    ev.defenderFactionId  = "dust-legion";
    ev.stagingId           = 42;
    ev.worldMs             = 123456;

    const auto j = WorldNotificationToJson(ev);
    CHECK(j["world"] == kW);
    CHECK(j["poi"] == "randtown");
    CHECK(j["poiName"] == "Randtown");
    CHECK(j["kind"] == "opened");
    CHECK(j["attackerFaction"] == "iron-order");
    CHECK(j["defenderFaction"] == "dust-legion");
    CHECK(j["stagingId"] == 42);
    CHECK(j["worldMs"] == 123456);
    CHECK(j["headline"] == WorldNotificationHeadline(WorldNotificationKind::StagingOpened, "Randtown"));

    // An explicit headline overrides the default rather than being ignored.
    ev.headline = "custom sentence";
    CHECK(WorldNotificationToJson(ev)["headline"] == "custom sentence");
}

TEST_CASE("W11: recipients are the union of attacker, defender and garrison, deduplicated") {
    NoticeDb h;
    const auto attacker = h.Found("Iron Order", 1);
    h.Join(attacker, 2);
    const auto defender = h.Found("Dust Legion", 3);
    h.Join(defender, 4);
    // Account 5 garrisons the POI but belongs to neither faction — still owed
    // the alert, per the milestone's own wording ("a commander/holding").
    h.GrantCommanderAt(5, defender, "randtown");
    // Account 6 garrisons the POI too, AND account 3 (the defender's founder)
    // separately holds a commander there — neither should appear twice.
    h.GrantCommanderAt(6, defender, "randtown");
    h.GrantCommanderAt(3, defender, "randtown");

    const auto recipients = WorldNotificationRecipients(h.db, kW, attacker, defender, "randtown");
    std::vector<int64_t> ids(recipients.begin(), recipients.end());
    std::sort(ids.begin(), ids.end());
    ids.erase(std::unique(ids.begin(), ids.end()), ids.end());

    CHECK(ids == std::vector<int64_t>{1, 2, 3, 4, 5, 6});
}

TEST_CASE("W11: an empty faction id contributes nobody, not everybody") {
    NoticeDb h;
    const auto attacker = h.Found("Iron Order", 1);
    h.GrantCommanderAt(9, attacker, "randtown");

    // No defender (unheld POI): only the attacker's members and the garrison.
    const auto recipients = WorldNotificationRecipients(h.db, kW, attacker, "", "randtown");
    std::vector<int64_t> ids(recipients.begin(), recipients.end());
    std::sort(ids.begin(), ids.end());
    CHECK(ids == std::vector<int64_t>{1, 9});
}

TEST_CASE("W11: no attacker, no defender, no garrison — nobody is owed anything") {
    NoticeDb h;
    const auto recipients = WorldNotificationRecipients(h.db, kW, "", "", "nowhere");
    CHECK(recipients.empty());
}

TEST_CASE("W11: the bus fires every subscriber, in subscription order") {
    WorldNotificationBus bus;
    std::vector<int> order;
    bus.Subscribe([&order](const WorldNotificationEvent&) { order.push_back(1); });
    bus.Subscribe([&order](const WorldNotificationEvent&) { order.push_back(2); });

    WorldNotificationEvent ev;
    ev.kind = WorldNotificationKind::StagingMaterialised;
    bus.Publish(ev);

    CHECK(order == std::vector<int>{1, 2});
}

TEST_CASE("W11: publishing with no subscribers does nothing, and does not throw") {
    WorldNotificationBus bus;
    WorldNotificationEvent ev;
    CHECK_NOTHROW(bus.Publish(ev));
}

TEST_CASE("W11: a sink sees the event's own data, not a copy stamped with defaults") {
    WorldNotificationBus bus;
    WorldNotificationEvent seen;
    bool fired = false;
    bus.Subscribe([&](const WorldNotificationEvent& ev) { seen = ev; fired = true; });

    WorldNotificationEvent ev;
    ev.worldId = kW;
    ev.poiId = "randtown";
    ev.kind = WorldNotificationKind::StagingCancelled;
    ev.attackerFactionId = "iron-order";
    bus.Publish(ev);

    REQUIRE(fired);
    CHECK(seen.worldId == kW);
    CHECK(seen.poiId == "randtown");
    CHECK(seen.kind == WorldNotificationKind::StagingCancelled);
    CHECK(seen.attackerFactionId == "iron-order");
}
