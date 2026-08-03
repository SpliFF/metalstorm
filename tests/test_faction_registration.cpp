#include <doctest/doctest.h>

#include "Server/Database.h"
#include "Server/FactionData.h"

#include <filesystem>
#include <fstream>

namespace fs = std::filesystem;

// PLAN-metalstorm-lobby.md task 0: faction registration.
//   1. Database.CreateUser/FindUser/FindUserById round-trip `faction_id`,
//      nullable for the not-yet-implemented guest/provisional case.
//   2. Database.SetFactionByUsername is the sole admin-override write path.
//   3. FactionData::Discover parses gamedata/sidedata.lua (both the real
//      Metalstorm file and synthetic fixtures for edge cases).

TEST_CASE("Database.CreateUser stores and round-trips faction_id") {
    Database db;
    REQUIRE(db.Open(":memory:"));

    int64_t userId = db.CreateUser("compact_player", "hash", "player", false, "compact");
    REQUIRE(userId > 0);

    auto byName = db.FindUser("compact_player");
    REQUIRE(byName.has_value());
    REQUIRE(byName->factionId.has_value());
    CHECK(*byName->factionId == "compact");

    auto byId = db.FindUserById(userId);
    REQUIRE(byId.has_value());
    REQUIRE(byId->factionId.has_value());
    CHECK(*byId->factionId == "compact");
}

TEST_CASE("Database.CreateUser leaves faction_id unset (nullopt) when omitted") {
    Database db;
    REQUIRE(db.Open(":memory:"));

    // Mirrors dev/test auto-register paths (HttpAuth's non-register-form
    // callers) and the not-yet-implemented guest/provisional account case —
    // both must be able to create a user with no faction at all.
    int64_t userId = db.CreateUser("no_faction_player", "hash");
    REQUIRE(userId > 0);

    auto user = db.FindUserById(userId);
    REQUIRE(user.has_value());
    CHECK_FALSE(user->factionId.has_value());
}

TEST_CASE("Database.SetFactionByUsername is the admin-override write path") {
    Database db;
    REQUIRE(db.Open(":memory:"));

    int64_t userId = db.CreateUser("appeal_case", "hash", "player", false, "compact");
    REQUIRE(userId > 0);

    int64_t affectedId = 0;
    REQUIRE(db.SetFactionByUsername("appeal_case", "union", affectedId));
    CHECK(affectedId == userId);

    auto user = db.FindUserById(userId);
    REQUIRE(user.has_value());
    REQUIRE(user->factionId.has_value());
    CHECK(*user->factionId == "union");
}

TEST_CASE("Database.SetFactionByUsername returns false and zeroes userId for an unknown username") {
    Database db;
    REQUIRE(db.Open(":memory:"));

    int64_t affectedId = 99;
    CHECK_FALSE(db.SetFactionByUsername("nobody", "union", affectedId));
    CHECK(affectedId == 0);
}

TEST_CASE("FactionData::Discover parses the real Metalstorm sidedata.lua") {
    const fs::path gameDir = fs::path(SPRING_SOURCE_DIR) / "data/games/metalstorm";
    if (!fs::exists(gameDir / "gamedata/sidedata.lua")) {
        MESSAGE("metalstorm sidedata.lua not present; skipping");
        return;
    }

    auto factions = FactionData::Discover(gameDir.string());
    REQUIRE(factions.size() == 2);

    // Keys are the lowercased `name` field, matching the scenario files'
    // pre-existing `compact`/`union` placeholders and the engine's own
    // SideParser derivation.
    bool sawCompact = false, sawUnion = false;
    for (const auto& f : factions) {
        if (f.key == "compact") {
            sawCompact = true;
            CHECK(f.name == "Compact");
            CHECK_FALSE(f.fullName.empty());
            CHECK_FALSE(f.description.empty());
            CHECK(f.startUnit == "ms_engineers_s1");
        } else if (f.key == "union") {
            sawUnion = true;
            CHECK(f.name == "Union");
            CHECK_FALSE(f.fullName.empty());
            CHECK_FALSE(f.description.empty());
        }
    }
    CHECK(sawCompact);
    CHECK(sawUnion);
}

TEST_CASE("FactionData::Discover returns empty for a game with no sidedata.lua") {
    const fs::path dir = fs::temp_directory_path() / "faction_data_test_missing";
    fs::create_directories(dir);

    auto factions = FactionData::Discover(dir.string());
    CHECK(factions.empty());
}

TEST_CASE("FactionData::Discover returns empty for an inert {} stub") {
    const fs::path dir = fs::temp_directory_path() / "faction_data_test_stub";
    fs::create_directories(dir / "gamedata");
    { std::ofstream(dir / "gamedata" / "sidedata.lua") << "return {}\n"; }

    auto factions = FactionData::Discover(dir.string());
    CHECK(factions.empty());
}

TEST_CASE("FactionData::Discover skips entries missing `name` and drops duplicate keys") {
    const fs::path dir = fs::temp_directory_path() / "faction_data_test_edge_cases";
    fs::create_directories(dir / "gamedata");
    {
        std::ofstream f(dir / "gamedata" / "sidedata.lua");
        f << "return {\n"
             "    { name = 'Alpha', startUnit = 'unit_a' },\n"
             "    { startUnit = 'unit_no_name' },\n"          // missing `name` — skipped
             "    { name = 'ALPHA', startUnit = 'unit_dup' },\n" // dup key after lowering — skipped
             "    { name = 'Beta', startUnit = 'unit_b' },\n"
             "}\n";
    }

    auto factions = FactionData::Discover(dir.string());
    REQUIRE(factions.size() == 2);
    CHECK(factions[0].key == "alpha");
    CHECK(factions[0].startUnit == "unit_a");
    CHECK(factions[1].key == "beta");
}

TEST_CASE("FactionData::Discover resolves VFS.Include against the game folder") {
    // Regression for the "sidedata.lua needs no VFS shim" claim that used to
    // sit in FactionData.h: BAR's real sidedata.lua opens with
    // `VFS.Include("gamedata/sides_enum.lua")` and errors out if it comes back
    // nil, which made every lobby boot log a warning and /api/factions/bar
    // return []. This fixture mirrors that shape exactly.
    const fs::path dir = fs::temp_directory_path() / "faction_data_test_vfs";
    fs::create_directories(dir / "gamedata");
    {
        std::ofstream f(dir / "gamedata" / "sides_enum.lua");
        f << "return { ARMADA = 'arm', CORTEX = 'cor' }\n";
    }
    {
        std::ofstream f(dir / "gamedata" / "sidedata.lua");
        f << "local SIDES = VFS.Include('gamedata/sides_enum.lua')\n"
             "if not SIDES then error('failed to load sides_enum.lua') end\n"
             "return {\n"
             "    { name = 'Armada', startunit = SIDES.ARMADA .. 'com' },\n"
             "    { name = 'Cortex', startunit = SIDES.CORTEX .. 'com' },\n"
             "}\n";
    }

    auto factions = FactionData::Discover(dir.string());
    REQUIRE(factions.size() == 2);
    CHECK(factions[0].key == "armada");
    // Lowercase `startunit` — the spelling BAR and ZK ship. The sim reads it
    // through LuaTable (which lowercases keys) so both spellings are valid
    // game data; this reader accepts either.
    CHECK(factions[0].startUnit == "armcom");
    CHECK(factions[1].key == "cortex");
    CHECK(factions[1].startUnit == "corcom");
}

TEST_CASE("FactionData::Discover treats a missing VFS.Include target as nil, not a crash") {
    // Spring's own VFS.Include returns nil for a missing file, and BAR's
    // sidedata.lua relies on that to raise its own error(). Anything that
    // goes wrong inside the chunk must still degrade to an empty vector.
    const fs::path dir = fs::temp_directory_path() / "faction_data_test_vfs_missing";
    fs::create_directories(dir / "gamedata");
    {
        std::ofstream f(dir / "gamedata" / "sidedata.lua");
        f << "local SIDES = VFS.Include('gamedata/does_not_exist.lua')\n"
             "if not SIDES then error('failed to load sides_enum.lua') end\n"
             "return { { name = 'Armada' } }\n";
    }

    CHECK(FactionData::Discover(dir.string()).empty());
}
