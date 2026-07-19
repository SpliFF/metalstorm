#include <doctest/doctest.h>

#include "Server/StatsDump.h"

#include <cstdio>
#include <fstream>
#include <sstream>

#include <nlohmann/json.hpp>

// PLAN-headless task 2 — the pure JSON-assembly + determinism-hash core of the
// headless stats dump. Pure — no sim, no globals — so it links without the
// engine-coupled gathering code that lives in server_main.cpp.

using namespace statsdump;

TEST_CASE("ComputeStateHash: deterministic for identical input") {
    std::vector<UnitDigest> units = {
        {1, 0, 10.0f, 0.0f, 20.0f, 100.0f},
        {2, 1, -5.0f, 0.0f, 30.0f, 80.0f},
    };
    CHECK(ComputeStateHash(units, 42) == ComputeStateHash(units, 42));
}

TEST_CASE("ComputeStateHash: sensitive to every input dimension") {
    std::vector<UnitDigest> base = {{1, 0, 10.0f, 0.0f, 20.0f, 100.0f}};
    const uint64_t baseHash = ComputeStateHash(base, 42);

    // Different id.
    std::vector<UnitDigest> diffId = {{2, 0, 10.0f, 0.0f, 20.0f, 100.0f}};
    CHECK(ComputeStateHash(diffId, 42) != baseHash);

    // Different team.
    std::vector<UnitDigest> diffTeam = {{1, 1, 10.0f, 0.0f, 20.0f, 100.0f}};
    CHECK(ComputeStateHash(diffTeam, 42) != baseHash);

    // Different position.
    std::vector<UnitDigest> diffPos = {{1, 0, 11.0f, 0.0f, 20.0f, 100.0f}};
    CHECK(ComputeStateHash(diffPos, 42) != baseHash);

    // Different health.
    std::vector<UnitDigest> diffHealth = {{1, 0, 10.0f, 0.0f, 20.0f, 99.0f}};
    CHECK(ComputeStateHash(diffHealth, 42) != baseHash);

    // Different RNG state.
    CHECK(ComputeStateHash(base, 43) != baseHash);

    // Different unit count (extra unit appended).
    std::vector<UnitDigest> extra = base;
    extra.push_back({2, 0, 0.0f, 0.0f, 0.0f, 0.0f});
    CHECK(ComputeStateHash(extra, 42) != baseHash);
}

TEST_CASE("ComputeStateHash: order-sensitive (a stable iteration order matters)") {
    std::vector<UnitDigest> a = {
        {1, 0, 0.0f, 0.0f, 0.0f, 100.0f},
        {2, 0, 0.0f, 0.0f, 0.0f, 100.0f},
    };
    std::vector<UnitDigest> b = {a[1], a[0]};  // swapped
    CHECK(ComputeStateHash(a, 0) != ComputeStateHash(b, 0));
}

TEST_CASE("ComputeStateHash: empty unit list still produces a stable hash") {
    std::vector<UnitDigest> empty;
    CHECK(ComputeStateHash(empty, 7) == ComputeStateHash(empty, 7));
    CHECK(ComputeStateHash(empty, 7) != ComputeStateHash(empty, 8));
}

TEST_CASE("BuildDumpJson: schema round-trips through nlohmann::json") {
    FinalDump dump;
    dump.status = "frame-limit";
    dump.frame = 300;
    dump.gameSeconds = 10.0;
    dump.wallSeconds = 5;

    Snapshot snap;
    snap.frame = 300;
    snap.gameSeconds = 10.0;
    snap.wallSeconds = 5;
    snap.stateHash = 0x0123456789abcdefULL;
    snap.simFps = 850.5f;
    snap.rssKb = 123456;
    snap.luaHeapKb = 4096;

    TeamSnapshot team;
    team.teamId = 0;
    team.allyTeam = 0;
    team.dead = false;
    team.numUnits = 12;
    team.metal = 500.0f;
    team.energy = 1000.0f;
    team.metalIncome = 10.5f;
    team.energyIncome = 20.5f;
    team.metalExpense = 9.0f;
    team.energyExpense = 15.0f;
    team.damageDealt = 1200.0f;
    team.damageReceived = 300.0f;
    team.unitsProduced = 20;
    team.unitsDied = 3;
    team.unitsKilled = 7;
    snap.teams.push_back(team);

    WeaponStats weapon;
    weapon.weaponDefId = 5;
    weapon.volleys = 42;
    weapon.kills = 6;
    weapon.damage = 3300.0f;
    snap.weapons.push_back(weapon);

    dump.snapshots.push_back(snap);

    const std::string json = BuildDumpJson(dump);
    auto j = nlohmann::json::parse(json);  // must be valid JSON

    CHECK(j["status"] == "frame-limit");
    CHECK(j["frame"] == 300);
    CHECK(j["wallSeconds"] == 5);
    REQUIRE(j["snapshots"].size() == 1);

    const auto& s = j["snapshots"][0];
    CHECK(s["frame"] == 300);
    CHECK(s["rssKb"] == 123456);
    CHECK(s["luaHeapKb"] == 4096);
    // stateHash is a 16-char lowercase hex string, not a JSON number — a
    // >2^53 hash would lose precision through a double-based JSON parser.
    CHECK(s["stateHash"].is_string());
    CHECK(s["stateHash"] == "0123456789abcdef");

    REQUIRE(s["teams"].size() == 1);
    CHECK(s["teams"][0]["teamId"] == 0);
    CHECK(s["teams"][0]["numUnits"] == 12);
    CHECK(s["teams"][0]["unitsKilled"] == 7);

    REQUIRE(s["weapons"].size() == 1);
    CHECK(s["weapons"][0]["weaponDefId"] == 5);
    CHECK(s["weapons"][0]["volleys"] == 42);
    CHECK(s["weapons"][0]["kills"] == 6);
}

TEST_CASE("BuildDumpJson: empty snapshots list is valid JSON") {
    FinalDump dump;
    dump.status = "wall-ceiling";
    dump.frame = 0;
    const std::string json = BuildDumpJson(dump);
    auto j = nlohmann::json::parse(json);
    CHECK(j["status"] == "wall-ceiling");
    CHECK(j["snapshots"].empty());
}

TEST_CASE("WriteDumpFile: writes readable JSON, errors on an unwritable path") {
    FinalDump dump;
    dump.status = "game-over";
    dump.frame = 42;

    const std::string path = "test_stats_dump_output.json";
    std::string err;
    REQUIRE(WriteDumpFile(path, dump, err));
    CHECK(err.empty());

    std::ifstream f(path);
    REQUIRE(f.good());
    std::stringstream ss;
    ss << f.rdbuf();
    auto j = nlohmann::json::parse(ss.str());
    CHECK(j["status"] == "game-over");
    std::remove(path.c_str());

    // A path in a directory that doesn't exist must fail cleanly, never throw.
    std::string badErr;
    CHECK_FALSE(WriteDumpFile("no_such_dir/out.json", dump, badErr));
    CHECK_FALSE(badErr.empty());
}

TEST_CASE("GetRssKb: returns a plausible positive value on a live process") {
    CHECK(GetRssKb() > 0);
}
