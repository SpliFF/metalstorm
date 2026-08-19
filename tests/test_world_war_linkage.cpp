// tests/test_world_war_linkage.cpp — PLAN-worldsim.md W5: the read-only
// POI ↔ battle join. Pure arithmetic on json + a small in-memory list, no
// sqlite, no room manager, no socket — same discipline as WorldWarLinkage.h
// itself.

#include <doctest/doctest.h>
#include <nlohmann/json.hpp>

#include "Server/WorldWarLinkage.h"

namespace {

nlohmann::json PoisJsonWith(std::initializer_list<std::pair<std::string, std::string>> idAndMap) {
    nlohmann::json out;
    out["worldId"] = "earth";
    nlohmann::json pois = nlohmann::json::array();
    for (const auto &[id, mapId] : idAndMap) {
        nlohmann::json p;
        p["id"] = id;
        if (mapId.empty()) p["mapId"] = nullptr;
        else                p["mapId"] = mapId;
        pois.push_back(std::move(p));
    }
    out["pois"] = std::move(pois);
    out["edges"] = nlohmann::json::array();
    return out;
}

} // namespace

TEST_CASE("W5: a POI with no live war on its map is quiet") {
    nlohmann::json j = AttachBattleStatus(
        PoisJsonWith({{"randtown", "meridian_basin"}}), {});
    CHECK(j["pois"][0]["battleStatus"] == "quiet");
    CHECK(j["pois"][0]["warRoomId"].is_null());
}

TEST_CASE("W5: a world-only POI (no battle map) is always quiet, even with a live war elsewhere") {
    std::vector<RoomBattleInfo> battles = {
        {7, "meridian_basin", WarState::Active},
    };
    nlohmann::json j = AttachBattleStatus(
        PoisJsonWith({{"osprey_fen", ""}}), battles);
    CHECK(j["pois"][0]["battleStatus"] == "quiet");
    CHECK(j["pois"][0]["warRoomId"].is_null());
}

TEST_CASE("W5: Seeding/Open wars mark the POI staging") {
    for (WarState s : {WarState::Seeding, WarState::Open}) {
        std::vector<RoomBattleInfo> battles = {{3, "meridian_basin", s}};
        nlohmann::json j = AttachBattleStatus(
            PoisJsonWith({{"randtown", "meridian_basin"}}), battles);
        CHECK(j["pois"][0]["battleStatus"] == "staging");
        CHECK(j["pois"][0]["warRoomId"] == 3);
    }
}

TEST_CASE("W5: Active/WindingDown/Resolving wars mark the POI active") {
    for (WarState s : {WarState::Active, WarState::WindingDown, WarState::Resolving}) {
        std::vector<RoomBattleInfo> battles = {{9, "meridian_basin", s}};
        nlohmann::json j = AttachBattleStatus(
            PoisJsonWith({{"randtown", "meridian_basin"}}), battles);
        CHECK(j["pois"][0]["battleStatus"] == "active");
        CHECK(j["pois"][0]["warRoomId"] == 9);
    }
}

TEST_CASE("W5: two live wars on the same map — Active outranks Staging") {
    std::vector<RoomBattleInfo> battles = {
        {1, "meridian_basin", WarState::Seeding},
        {2, "meridian_basin", WarState::Active},
    };
    nlohmann::json j = AttachBattleStatus(
        PoisJsonWith({{"randtown", "meridian_basin"}}), battles);
    CHECK(j["pois"][0]["battleStatus"] == "active");
    CHECK(j["pois"][0]["warRoomId"] == 2);
}

TEST_CASE("W5: a war on a different map does not light up this POI") {
    std::vector<RoomBattleInfo> battles = {{5, "some_other_map", WarState::Active}};
    nlohmann::json j = AttachBattleStatus(
        PoisJsonWith({{"randtown", "meridian_basin"}}), battles);
    CHECK(j["pois"][0]["battleStatus"] == "quiet");
    CHECK(j["pois"][0]["warRoomId"].is_null());
}

TEST_CASE("W5: multiple POIs are judged independently") {
    std::vector<RoomBattleInfo> battles = {
        {1, "map_a", WarState::Active},
        {2, "map_b", WarState::Seeding},
    };
    nlohmann::json j = AttachBattleStatus(
        PoisJsonWith({{"poi_a", "map_a"}, {"poi_b", "map_b"}, {"poi_c", "map_c"}}),
        battles);
    CHECK(j["pois"][0]["battleStatus"] == "active");
    CHECK(j["pois"][1]["battleStatus"] == "staging");
    CHECK(j["pois"][2]["battleStatus"] == "quiet");
}
