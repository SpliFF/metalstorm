#include <doctest/doctest.h>

#include "Server/ScenarioDiscovery.h"

#include <filesystem>
#include <fstream>
#include <string>

// PLAN-endtoend.md D10 — the lobby's view of "which wars does this game ship,
// and can each of them actually end". The `terminal` flag is the load-bearing
// one: a scenario with no `victory = true` objective produces a war
// game_gameover.lua can never finish, which is the defect this module exists
// to make visible at create time instead of 40 minutes into a match.

namespace fs = std::filesystem;
namespace SD = ScenarioDiscovery;

namespace {

/// A scratch game folder with a `scenarios/` dir, removed on destruction.
/// Named after the doctest subcase so parallel-ish runs don't collide.
struct TempGame {
    fs::path root;

    explicit TempGame(const std::string& tag) {
        root = fs::temp_directory_path() / ("scnd_" + tag);
        fs::remove_all(root);
        fs::create_directories(root / "scenarios");
    }
    ~TempGame() {
        std::error_code ec;
        fs::remove_all(root, ec);
    }

    void Write(const std::string& name, const std::string& body) const {
        std::ofstream f(root / "scenarios" / name);
        f << body;
    }

    std::string Path() const { return root.string(); }
};

const SD::ScenarioInfo* Find(const std::vector<SD::ScenarioInfo>& v,
                             const std::string& id) {
    return SD::FindById(v, id);
}

} // namespace

TEST_CASE("Discover: reads name, map, tutorial and the victory flag") {
    TempGame g("basic");
    g.Write("alpha.lua", R"(return {
        version = 1,
        name = 'Alpha War',
        tutorial = false,
        world = { map = 'basin' },
        objectives = {
            { type = 'control', region = 'a' },
            { type = 'control', region = 'b', victory = true },
        },
    })");

    const auto found = SD::Discover(g.Path());
    REQUIRE(found.size() == 1);
    CHECK(found[0].id == "alpha");
    CHECK(found[0].displayName == "Alpha War");
    CHECK(found[0].mapId == "basin");
    CHECK(found[0].tutorial == false);
    CHECK(found[0].terminal == true);
}

TEST_CASE("Discover: a scenario with no victory objective is not terminal") {
    TempGame g("noterm");
    g.Write("skirmish.lua", R"(return {
        version = 1,
        name = 'Endless Skirmish',
        world = { map = 'basin' },
        objectives = {
            { type = 'control', region = 'a' },
            { type = 'protect', region = 'b' },
        },
    })");

    const auto found = SD::Discover(g.Path());
    REQUIRE(found.size() == 1);
    CHECK(found[0].terminal == false);
}

TEST_CASE("Discover: `victory = false` is not a terminal condition") {
    // Guards against reading the flag's *presence* rather than its value —
    // an author disabling a victory objective must not leave the lobby
    // believing the war can still end.
    TempGame g("victfalse");
    g.Write("off.lua", R"(return {
        name = 'Victory Disabled',
        world = { map = 'basin' },
        objectives = { { type = 'control', victory = false } },
    })");

    const auto found = SD::Discover(g.Path());
    REQUIRE(found.size() == 1);
    CHECK(found[0].terminal == false);
}

TEST_CASE("Discover: missing objectives / world tables are tolerated") {
    TempGame g("sparse");
    g.Write("bare.lua", "return { version = 1 }");

    const auto found = SD::Discover(g.Path());
    REQUIRE(found.size() == 1);
    CHECK(found[0].id == "bare");
    CHECK(found[0].displayName == "bare"); // falls back to the id
    CHECK(found[0].mapId.empty());
    CHECK(found[0].terminal == false);
}

TEST_CASE("Discover: non-table and erroring files are skipped, not fatal") {
    TempGame g("bad");
    g.Write("good.lua", "return { name = 'Good', world = { map = 'm' } }");
    g.Write("returns_number.lua", "return 42");
    g.Write("throws.lua", "error('needs the sim')");
    g.Write("notes.txt", "not a scenario");

    const auto found = SD::Discover(g.Path());
    REQUIRE(found.size() == 1);
    CHECK(found[0].id == "good");
}

TEST_CASE("Discover: a missing scenarios/ directory is empty, not an error") {
    // Most games ship none. Paper Tanks and ZK must stay discoverable.
    CHECK(SD::Discover("/nonexistent/game/folder").empty());
}

TEST_CASE("Discover: results are sorted by id") {
    TempGame g("sorted");
    g.Write("zulu.lua", "return { name = 'Z' }");
    g.Write("alpha.lua", "return { name = 'A' }");
    g.Write("mike.lua", "return { name = 'M' }");

    const auto found = SD::Discover(g.Path());
    REQUIRE(found.size() == 3);
    CHECK(found[0].id == "alpha");
    CHECK(found[1].id == "mike");
    CHECK(found[2].id == "zulu");
}

TEST_CASE("DefaultForMap: picks the scenario authored for that map") {
    TempGame g("defmap");
    g.Write("basin_war.lua",
            "return { name = 'Basin', world = { map = 'basin' }, "
            "objectives = { { victory = true } } }");
    g.Write("delta_war.lua",
            "return { name = 'Delta', world = { map = 'delta' }, "
            "objectives = { { victory = true } } }");

    const auto found = SD::Discover(g.Path());
    const auto* def = SD::DefaultForMap(found, "basin");
    REQUIRE(def != nullptr);
    CHECK(def->id == "basin_war");

    CHECK(SD::DefaultForMap(found, "somewhere_else") == nullptr);
    CHECK(SD::DefaultForMap(found, "") == nullptr);
}

TEST_CASE("DefaultForMap: tutorials are never the default") {
    // tutorial_01.lua declares `world.map = 'meridian_basin'`, so without
    // this rule creating a Meridian room in the lobby could hand the player
    // Basic Training instead of the war they asked for.
    TempGame g("tut");
    g.Write("tutorial_01.lua",
            "return { name = 'Basic Training', tutorial = true, "
            "world = { map = 'basin' } }");

    auto found = SD::Discover(g.Path());
    CHECK(SD::DefaultForMap(found, "basin") == nullptr);

    g.Write("basin_war.lua",
            "return { name = 'Basin', world = { map = 'basin' }, "
            "objectives = { { victory = true } } }");
    found = SD::Discover(g.Path());
    const auto* def = SD::DefaultForMap(found, "basin");
    REQUIRE(def != nullptr);
    CHECK(def->id == "basin_war");
}

TEST_CASE("DefaultForMap: a terminal scenario beats a non-terminal one") {
    // The whole point — given a choice, never default a player into a war
    // that cannot end, regardless of alphabetical order in either direction.
    TempGame g("prefterm");
    g.Write("aaa_endless.lua",
            "return { name = 'Endless', world = { map = 'basin' }, "
            "objectives = { { type = 'control' } } }");
    g.Write("zzz_finite.lua",
            "return { name = 'Finite', world = { map = 'basin' }, "
            "objectives = { { victory = true } } }");

    const auto found = SD::Discover(g.Path());
    const auto* def = SD::DefaultForMap(found, "basin");
    REQUIRE(def != nullptr);
    CHECK(def->id == "zzz_finite");
    CHECK(def->terminal == true);
}

TEST_CASE("DefaultForMap: a non-terminal scenario is never the default") {
    // Required, not preferred. Auto-applying an endless scenario would stage
    // units and objectives the host never asked for and leave the war just as
    // unendable — it does nothing this default exists to do. Concretely, this
    // is what keeps scenario_smoke_test off a green_flat dev manifest that
    // names no scenario.
    TempGame g("noautoendless");
    g.Write("smoke.lua",
            "return { name = 'Smoke', world = { map = 'flat' }, "
            "objectives = { { type = 'control' } } }");

    const auto found = SD::Discover(g.Path());
    REQUIRE(found.size() == 1);
    CHECK(found[0].terminal == false);
    CHECK(SD::DefaultForMap(found, "flat") == nullptr);
    // …but still explicitly selectable.
    CHECK(SD::FindById(found, "smoke") != nullptr);
}

TEST_CASE("shipped metalstorm scenarios: no map defaults to an endless war") {
    // The live assertion behind the rule above: green_flat_x34_v3 ships
    // scenario_smoke_test (non-terminal), so booting on it must resolve to no
    // scenario rather than to the fixture.
    const std::string gamePath =
        std::string(SPRING_SOURCE_DIR) + "/data/games/metalstorm";
    if (!fs::is_directory(fs::path(gamePath) / "scenarios"))
        return; // content not present in this checkout

    const auto found = SD::Discover(gamePath);
    REQUIRE(!found.empty());
    for (const auto& s : found) {
        const auto* def = SD::DefaultForMap(found, s.mapId);
        if (def != nullptr)
            CHECK(def->terminal == true);
    }
    CHECK(SD::DefaultForMap(found, "green_flat_x34_v3") == nullptr);
}

TEST_CASE("DefaultForMap: ties break deterministically on lowest id") {
    TempGame g("tie");
    g.Write("bravo.lua",
            "return { world = { map = 'basin' }, objectives = { { victory = "
            "true } } }");
    g.Write("alpha.lua",
            "return { world = { map = 'basin' }, objectives = { { victory = "
            "true } } }");

    const auto found = SD::Discover(g.Path());
    const auto* def = SD::DefaultForMap(found, "basin");
    REQUIRE(def != nullptr);
    CHECK(def->id == "alpha");
}

TEST_CASE("DefaultForMap: a scenario with no world.map is never auto-applied") {
    TempGame g("nomap");
    g.Write("floating.lua",
            "return { name = 'No Map', objectives = { { victory = true } } }");

    const auto found = SD::Discover(g.Path());
    REQUIRE(found.size() == 1);
    CHECK(SD::DefaultForMap(found, "basin") == nullptr);
    // …but it is still explicitly selectable.
    CHECK(SD::FindById(found, "floating") != nullptr);
}

// ---------------------------------------------------------------------------
// Sides — PLAN-metalstorm-wars.md §7.4 / endtoend D19. A room slot picks a
// SIDE, and the side resolves to the team the scenario actually stages that
// side's starting force on. These are the cases that decide whether a
// lobby-created war has two armies or one.
// ---------------------------------------------------------------------------

TEST_CASE("sides: a faction resolves to the team its army is staged on") {
    // Meridian Basin's shape in miniature: four teams per side, one army each.
    // Resolving to the faction's *lowest* team (0 and 4) rather than to a bare
    // dropdown index (0 and 1) is the whole fix — team 1 is a declared
    // teammate the scenario stages nothing for.
    TempGame g("sides_basic");
    g.Write("war.lua", R"(return {
        sides = {
            { faction = 'compact', team = 0 },
            { faction = 'compact', team = 1 },
            { faction = 'union',   team = 4 },
            { faction = 'union',   team = 5 },
        },
        units = {
            { def = 'tank', team = 0 },
            { def = 'tank', team = 4 },
        },
    })");

    const auto found = SD::Discover(g.Path());
    REQUIRE(found.size() == 1);
    REQUIRE(found[0].sides.size() == 2);

    CHECK(found[0].sides[0].faction == "compact");
    CHECK(found[0].sides[0].team == 0);
    CHECK(found[0].sides[0].staged == true);
    CHECK(found[0].sides[0].teams == std::vector<uint8_t>{0, 1});

    CHECK(found[0].sides[1].faction == "union");
    CHECK(found[0].sides[1].team == 4);
    CHECK(found[0].sides[1].staged == true);

    CHECK(SD::EncodeWarSides(found[0]) == "compact:0,union:4");
}

TEST_CASE("sides: the staged team wins even when it is not the lowest") {
    // The rule is "the lowest team the scenario stages units for", not "the
    // lowest team". A side whose army sits on its second slot must still
    // resolve to the slot with the army.
    TempGame g("sides_notlowest");
    g.Write("war.lua", R"(return {
        sides = {
            { faction = 'north', team = 0 },
            { faction = 'south', team = 2 },
            { faction = 'south', team = 3 },
        },
        units = {
            { def = 'tank', team = 0 },
            { def = 'tank', team = 3 },
        },
    })");

    const auto found = SD::Discover(g.Path());
    REQUIRE(found.size() == 1);
    REQUIRE(found[0].sides.size() == 2);
    CHECK(found[0].sides[1].faction == "south");
    CHECK(found[0].sides[1].team == 3);
    CHECK(found[0].sides[1].staged == true);
}

TEST_CASE("sides: a side with no staged army resolves anyway, flagged") {
    // Reported rather than hidden: the lobby still offers the side (refusing
    // would break scenarios that stage forces some other way), but `staged`
    // is what lets the room say so out loud before the match starts.
    TempGame g("sides_unstaged");
    g.Write("war.lua", R"(return {
        sides = {
            { faction = 'alpha', team = 0 },
            { faction = 'bravo', team = 6 },
        },
        units = { { def = 'tank', team = 0 } },
    })");

    const auto found = SD::Discover(g.Path());
    REQUIRE(found.size() == 1);
    REQUIRE(found[0].sides.size() == 2);
    CHECK(found[0].sides[0].staged == true);
    CHECK(found[0].sides[1].team == 6);
    CHECK(found[0].sides[1].staged == false);
    CHECK(SD::EncodeWarSides(found[0]) == "alpha:0,bravo:6");
}

TEST_CASE("sides: a faction wholly claimed by scenario.ai is an NPC") {
    // Meridian's reavers. Excluded by what the scenario declares — an `ai`
    // entry on every team of the faction — rather than by its name, so a
    // second NPC faction needs no code change.
    TempGame g("sides_npc");
    g.Write("war.lua", R"(return {
        sides = {
            { faction = 'compact', team = 0 },
            { faction = 'union',   team = 4 },
            { faction = 'reavers', team = 8 },
        },
        ai = { { team = 8, profile = 'npc_raider' } },
        units = {
            { def = 'tank', team = 0 },
            { def = 'tank', team = 4 },
            { def = 'tank', team = 8 },
        },
    })");

    const auto found = SD::Discover(g.Path());
    REQUIRE(found.size() == 1);
    REQUIRE(found[0].sides.size() == 3);
    CHECK(found[0].sides[2].faction == "reavers");
    CHECK(found[0].sides[2].npc == true);

    const auto playable = SD::PlayableSides(found[0]);
    REQUIRE(playable.size() == 2);
    CHECK(playable[0].faction == "compact");
    CHECK(playable[1].faction == "union");
    CHECK(SD::EncodeWarSides(found[0]) == "compact:0,union:4");
}

TEST_CASE("sides: a faction with an AI on only SOME of its teams stays playable") {
    // A co-commander AI alongside human slots on the same side must not
    // silently delete that side from the room's dropdown.
    TempGame g("sides_partialai");
    g.Write("war.lua", R"(return {
        sides = {
            { faction = 'compact', team = 0 },
            { faction = 'compact', team = 1 },
            { faction = 'union',   team = 4 },
        },
        ai = { { team = 1, profile = 'mentor' } },
        units = { { def = 'tank', team = 0 }, { def = 'tank', team = 4 } },
    })");

    const auto found = SD::Discover(g.Path());
    REQUIRE(found.size() == 1);
    CHECK(found[0].sides[0].npc == false);
    CHECK(SD::PlayableSides(found[0]).size() == 2);
}

TEST_CASE("sides: declaration order is preserved, teams are sorted") {
    // The first playable side is where an opinion-less host is seated, so the
    // order the author wrote is the order the lobby must offer.
    TempGame g("sides_order");
    g.Write("war.lua", R"(return {
        sides = {
            { faction = 'zulu',  team = 7 },
            { faction = 'alpha', team = 3 },
            { faction = 'zulu',  team = 5 },
        },
    })");

    const auto found = SD::Discover(g.Path());
    REQUIRE(found.size() == 1);
    REQUIRE(found[0].sides.size() == 2);
    CHECK(found[0].sides[0].faction == "zulu");
    CHECK(found[0].sides[0].teams == std::vector<uint8_t>{5, 7});
    CHECK(found[0].sides[0].team == 5); // lowest, nothing staged
    CHECK(found[0].sides[1].faction == "alpha");
    CHECK(SD::EncodeWarSides(found[0]) == "zulu:5,alpha:3");
}

TEST_CASE("sides: a scenario declaring none encodes to the empty string") {
    // Which every consumer reads as "legacy two-team room" — this is what
    // keeps Paper Tanks and ZK rooms exactly as they were.
    TempGame g("sides_none");
    g.Write("bare.lua", "return { name = 'Bare', units = { { team = 0 } } }");

    const auto found = SD::Discover(g.Path());
    REQUIRE(found.size() == 1);
    CHECK(found[0].sides.empty());
    CHECK(SD::PlayableSides(found[0]).empty());
    CHECK(SD::EncodeWarSides(found[0]).empty());
}

TEST_CASE("sides: malformed entries are skipped, not fatal") {
    TempGame g("sides_bad");
    g.Write("war.lua", R"(return {
        sides = {
            { faction = 'good', team = 0 },
            { team = 2 },                    -- no faction
            { faction = 'nameless' },        -- no team
            'not a table',
        },
        units = { { team = 0 } },
    })");

    const auto found = SD::Discover(g.Path());
    REQUIRE(found.size() == 1);
    REQUIRE(found[0].sides.size() == 1);
    CHECK(found[0].sides[0].faction == "good");
}

TEST_CASE("EncodeWarSides: a faction key with ',' or ':' is dropped, not emitted") {
    // The encoding is split on both downstream. Emitting an unparseable entry
    // would reshape the whole list silently, which is worse than losing the
    // side loudly.
    TempGame g("sides_sep");
    g.Write("war.lua", R"(return {
        sides = {
            { faction = 'ok',     team = 0 },
            { faction = 'a,b',    team = 1 },
            { faction = 'c:d',    team = 2 },
        },
    })");

    const auto found = SD::Discover(g.Path());
    REQUIRE(found.size() == 1);
    CHECK(found[0].sides.size() == 3);
    CHECK(SD::EncodeWarSides(found[0]) == "ok:0");
}

TEST_CASE("shipped meridian_basin: the two playable sides are teams 0 and 4") {
    // The live assertion for endtoend D19. Before the fix a lobby-created
    // room offered team indices 0 and 1, so the AI opponent was seated on
    // team 1 — a compact teammate with no army — and the union's entire
    // force (team 4) was skipped at GameStart. Measured live: team 0 = 13
    // units, team 1 = 0 units.
    const std::string gamePath =
        std::string(SPRING_SOURCE_DIR) + "/data/games/metalstorm";
    if (!fs::is_directory(fs::path(gamePath) / "scenarios"))
        return; // content not present in this checkout

    const auto found = SD::Discover(gamePath);
    const auto* meridian = Find(found, "meridian_basin");
    REQUIRE(meridian != nullptr);

    // Nine declared sides collapse to three factions.
    REQUIRE(meridian->sides.size() == 3);

    const auto playable = SD::PlayableSides(*meridian);
    REQUIRE(playable.size() == 2);
    CHECK(playable[0].faction == "compact");
    CHECK(playable[0].team == 0);
    CHECK(playable[0].staged == true);
    CHECK(playable[0].teams == std::vector<uint8_t>{0, 1, 2, 3});
    CHECK(playable[1].faction == "union");
    CHECK(playable[1].team == 4);
    CHECK(playable[1].staged == true);
    CHECK(playable[1].teams == std::vector<uint8_t>{4, 5, 6, 7});

    // The reavers are an NPC and are never offered as a player slot.
    CHECK(meridian->sides[2].faction == "reavers");
    CHECK(meridian->sides[2].npc == true);

    CHECK(SD::EncodeWarSides(*meridian) == "compact:0,union:4");
}

TEST_CASE("FindById: exact match only") {
    TempGame g("byid");
    g.Write("meridian_basin.lua", "return { name = 'M' }");

    const auto found = SD::Discover(g.Path());
    CHECK(SD::FindById(found, "meridian_basin") != nullptr);
    CHECK(SD::FindById(found, "meridian") == nullptr);
    CHECK(SD::FindById(found, "Meridian_Basin") == nullptr);
    CHECK(SD::FindById(found, "") == nullptr);
}

TEST_CASE("shipped metalstorm scenarios: meridian_basin is the terminable "
          "default for the meridian_basin map") {
    // Reads the real content, not a fixture. This is the assertion that
    // would have failed before the fix: creating a Metalstorm room on
    // Meridian Basin now resolves to a war with a victory objective.
    const std::string gamePath =
        std::string(SPRING_SOURCE_DIR) + "/data/games/metalstorm";
    if (!fs::is_directory(fs::path(gamePath) / "scenarios"))
        return; // content not present in this checkout

    const auto found = SD::Discover(gamePath);
    REQUIRE(!found.empty());

    const auto* meridian = Find(found, "meridian_basin");
    REQUIRE(meridian != nullptr);
    CHECK(meridian->mapId == "meridian_basin");
    CHECK(meridian->tutorial == false);
    CHECK(meridian->terminal == true);

    const auto* def = SD::DefaultForMap(found, "meridian_basin");
    REQUIRE(def != nullptr);
    CHECK(def->id == "meridian_basin");
    CHECK(def->terminal == true);
}
