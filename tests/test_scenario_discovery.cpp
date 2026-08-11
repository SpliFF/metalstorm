#include <doctest/doctest.h>

#include "Server/ScenarioDiscovery.h"

#include <algorithm>
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

TEST_CASE("shipped metalstorm scenarios: meridian_basin is RETIRED, so its map "
          "has no default war") {
    // Reads the real content, not a fixture. This assertion INVERTED on
    // 2026-08-07 (PLAN-metalstorm-wars.md §7.6): it used to say meridian_basin
    // was the terminable default for its map, which was true and was the wrong
    // thing to want. The map's 8 start positions sit in 3 disconnected
    // components of the VEH/HEAVY passability mask, so the two armies cannot
    // reach each other and the war ends uncontested at a deterministic frame
    // whatever the player does — measured twice on the player path in endtoend
    // fire 21 (two wars, 4 vs 52 player directives, both ending at frame 10560
    // won by the same team, armies 4 040 elmos apart).
    //
    // Terminal is still true and the file is still shipped and loadable: what
    // `retired` removes is the OFFER, not the content.
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
    CHECK(meridian->retired == true);
    CHECK(meridian->terminal == true);

    // Never defaulted to…
    CHECK(SD::DefaultForMap(found, "meridian_basin") == nullptr);
    // …and never silently dropped either: an id a `?direct=` manifest or a
    // gadget spec still stages has to resolve, or the room screen would show a
    // raw id and the create route could not tell "retired" from "typo".
    CHECK(SD::FindById(found, "meridian_basin") == meridian);
}

TEST_CASE("shipped metalstorm scenarios: crossing_standoff is the default war "
          "for scorched_crossing_v2.4") {
    // The other half of §7.6's move: the showcase war is now authored on a map
    // whose start positions are all in ONE component
    // (`tools/mapgen/regions_from_map.py data/maps/scorched_crossing_v2.4
    // --verify` — 6 starts, one component, largest component 94.5% of
    // passable). This is the war a player who picks the default now gets.
    const std::string gamePath =
        std::string(SPRING_SOURCE_DIR) + "/data/games/metalstorm";
    if (!fs::is_directory(fs::path(gamePath) / "scenarios"))
        return; // content not present in this checkout

    const auto found = SD::Discover(gamePath);
    const auto* def = SD::DefaultForMap(found, "scorched_crossing_v2.4");
    REQUIRE(def != nullptr);
    CHECK(def->id == "crossing_standoff");
    CHECK(def->terminal == true);
    CHECK(def->retired == false);

    // And it is a war two players can be seated in, one per side.
    const auto playable = SD::PlayableSides(*def);
    REQUIRE(playable.size() == 2);
    CHECK(playable[0].staged == true);
    CHECK(playable[1].staged == true);
}

TEST_CASE("retired: parsed, excluded from the default, still findable") {
    // The unit-level statement of the rule, independent of shipped content.
    TempGame g("retired");
    g.Write("old_war.lua", R"(return {
        name = 'Old War',
        world = { map = 'basin' },
        objectives = { { type = 'control', victory = true } },
        retired = true,
    })");
    g.Write("new_war.lua", R"(return {
        name = 'New War',
        world = { map = 'crossing' },
        objectives = { { type = 'control', victory = true } },
    })");

    const auto found = SD::Discover(g.Path());
    REQUIRE(found.size() == 2);

    const auto* old = Find(found, "old_war");
    REQUIRE(old != nullptr);
    CHECK(old->retired == true);
    CHECK(old->terminal == true);
    CHECK(SD::DefaultForMap(found, "basin") == nullptr);
    CHECK(SD::FindById(found, "old_war") == old);

    // `retired` is not contagious and defaults to false.
    const auto* fresh = Find(found, "new_war");
    REQUIRE(fresh != nullptr);
    CHECK(fresh->retired == false);
    REQUIRE(SD::DefaultForMap(found, "crossing") != nullptr);
    CHECK(SD::DefaultForMap(found, "crossing")->id == "new_war");
}

// ==========================================================================
// Generated scenarios (PLAN-metalstorm-scenariogen.md §10)
// ==========================================================================
// tools/mapgen/scenariogen.py emits scenario files procedurally. Everything
// this module reads is therefore now produced by a program rather than typed by
// a person, and the two failure modes that creates are both silent:
//
//   * a file that needs VFS/`Spring.*`/`require` at file scope does not error
//     here — LoadOne logs once and the scenario simply never appears in the
//     lobby (ScenarioDiscovery.h:33-37);
//   * a side the generator declares but stages no `units` for resolves with
//     `staged == false`, which is a room slot that starts with no army
//     (endtoend D19) — the AI landed on exactly such a team once already.
//
// So the generator's real output is checked in at tests/fixtures/
// generated_scenario.lua and run through this parser, rather than a hand-typed
// approximation of it. Regenerate with
// `python3 tools/mapgen/tests/regen_fixture.py`; the Python suite's golden test
// fails if the checked-in copy drifts from what the generator emits.

namespace {

/// Copy the checked-in generated scenario into a scratch game folder.
/// Returns false when the fixture is missing, so the test can skip rather
/// than fail in a checkout that has not got it.
bool StageGeneratedFixture(const TempGame& g, const std::string& asName) {
    const fs::path fixture = fs::path(SPRING_SOURCE_DIR) / "tests" /
                             "fixtures" / "generated_scenario.lua";
    std::error_code ec;
    if (!fs::is_regular_file(fixture, ec))
        return false;
    fs::copy_file(fixture, fs::path(g.Path()) / "scenarios" / asName,
                  fs::copy_options::overwrite_existing, ec);
    return !ec;
}

} // namespace

TEST_CASE("generated scenario: parses under the lobby's bare lua_State") {
    // Invariant 1. The lobby binary has no VFS, no `Spring.*` and no sim
    // globals to offer, so this is the only place a generated file's purity is
    // actually proved — the sim would happily load one that the lobby cannot.
    TempGame g("genparse");
    if (!StageGeneratedFixture(g, "gen_fixture.lua"))
        return; // fixture not present in this checkout

    const auto found = SD::Discover(g.Path());
    REQUIRE(found.size() == 1);
    CHECK(found[0].id == "gen_fixture");
    CHECK_FALSE(found[0].displayName.empty());
    CHECK_FALSE(found[0].mapId.empty());
    CHECK(found[0].tutorial == false);
}

TEST_CASE("generated scenario: is terminal, so the war it creates can end") {
    // Invariant 2. `victory` is the only terminal condition game_gameover.lua
    // watches; without one the generator would be mass-producing wars that run
    // forever, and DefaultForMap would refuse every one of them.
    TempGame g("genterm");
    if (!StageGeneratedFixture(g, "gen_fixture.lua"))
        return;

    const auto found = SD::Discover(g.Path());
    REQUIRE(found.size() == 1);
    CHECK(found[0].terminal == true);

    const auto* def = SD::DefaultForMap(found, found[0].mapId);
    REQUIRE(def != nullptr);
    CHECK(def->id == "gen_fixture");
}

TEST_CASE("generated scenario: every playable side is staged an army") {
    // Invariant 3 / endtoend D19, and the reason ScenarioSide exists at all.
    // A room slot picks a SIDE; a side resolving to a team the scenario stages
    // no `units` for is a player (or, as it happened, an AI) starting with
    // nothing on an empty team.
    TempGame g("genstaged");
    if (!StageGeneratedFixture(g, "gen_fixture.lua"))
        return;

    const auto found = SD::Discover(g.Path());
    REQUIRE(found.size() == 1);

    const auto playable = SD::PlayableSides(found[0]);
    REQUIRE(playable.size() >= 2);
    for (const auto& side : playable) {
        INFO("side '" << side.faction << "' resolves to team "
                      << static_cast<unsigned>(side.team));
        CHECK(side.staged == true);
        CHECK_FALSE(side.npc);
    }

    // The NPC faction holding the hostile clusters must NOT be offered as a
    // player slot: it is data-driven off `ai`, so this also proves the
    // generator's `ai` block lines up with its `sides` block.
    CHECK(found[0].sides.size() > playable.size());
    CHECK(found[0].sides.back().npc == true);
}

TEST_CASE("generated scenario: war_sides encodes cleanly") {
    // The faction keys land in a modoption split on ',' and ':' downstream, so
    // a generator that minted a key containing either would have its sides
    // silently dropped by EncodeWarSides rather than rejected.
    TempGame g("gensides");
    if (!StageGeneratedFixture(g, "gen_fixture.lua"))
        return;

    const auto found = SD::Discover(g.Path());
    REQUIRE(found.size() == 1);

    const std::string encoded = SD::EncodeWarSides(found[0]);
    CHECK_FALSE(encoded.empty());
    // One entry per playable side, none dropped.
    const auto commas = std::count(encoded.begin(), encoded.end(), ',');
    CHECK(static_cast<size_t>(commas) + 1 ==
          SD::PlayableSides(found[0]).size());
}

TEST_CASE("generated scenario: neutral (Gaia) entries are not counted as a side") {
    // The generator writes `team = 'neutral'` for Gaia-owned towns, because
    // Gaia's numeric id is playerTeamCount and so is not knowable at authoring
    // time. CollectTeams ignores non-numeric `team` values, which is what keeps
    // those buildings from inventing a phantom playable side — assert it rather
    // than rely on it.
    TempGame g("genneutral");
    if (!StageGeneratedFixture(g, "gen_fixture.lua"))
        return;

    const auto found = SD::Discover(g.Path());
    REQUIRE(found.size() == 1);
    for (const auto& side : found[0].sides)
        CHECK(side.faction != "neutral");
}

// ── Per-side capacity (PLAN-metalstorm-lobby.md §6, task 7) ─────────────────
//
// A scenario may state how many humans a side holds. Partial on purpose: the
// lobby seeds every side from the registered population and lets these
// override, per side, so an author with a reason for ONE side's size states
// that one and leaves the rest to a population they have no figures for.

TEST_CASE("sides: a scenario may author a per-side capacity") {
    TempGame g("sides_capacity");
    g.Write("war.lua", R"(return {
        sides = {
            { faction = 'compact', team = 0, capacity = 4 },
            { faction = 'union',   team = 4 },
        },
        units = { { def = 'tank', team = 0 }, { def = 'tank', team = 4 } },
    })");

    const auto found = SD::Discover(g.Path());
    REQUIRE(found.size() == 1);
    REQUIRE(found[0].sides.size() == 2);
    CHECK(found[0].sides[0].hasCapacity == true);
    CHECK(found[0].sides[0].capacity == 4);
    // Absence is not zero: the unsized side is left to the seeding rule, and a
    // `capacity == 0` reading here would silently uncap it instead.
    CHECK(found[0].sides[1].hasCapacity == false);

    const WarSideCapacities caps = SD::AuthoredSideCapacities(found[0]);
    REQUIRE(caps.size() == 1);
    CHECK(caps[0].first == "compact");
    CHECK(caps[0].second == 4);
}

TEST_CASE("sides: 'unlimited' is a capacity, and a typo is not") {
    TempGame g("sides_capacity_unlimited");
    g.Write("war.lua", R"(return {
        sides = {
            { faction = 'horde',  team = 0, capacity = 'unlimited' },
            { faction = 'keep',   team = 1, capacity = -3 },
            { faction = 'nobody', team = 2, capacity = 'lots' },
        },
        units = { { def = 'tank', team = 0 } },
    })");

    const auto found = SD::Discover(g.Path());
    REQUIRE(found.size() == 1);
    REQUIRE(found[0].sides.size() == 3);
    // Declared unlimited — authored, so it overrides the seeding rule.
    CHECK(found[0].sides[0].hasCapacity == true);
    CHECK(found[0].sides[0].capacity == WAR_SIDE_CAPACITY_UNLIMITED);
    // A negative is a typo, not "unlimited". Reading it as unlimited would
    // uncap a side by accident, which is the one direction that cannot be
    // walked back once players are in.
    CHECK(found[0].sides[1].hasCapacity == false);
    CHECK(found[0].sides[2].hasCapacity == false);

    const WarSideCapacities caps = SD::AuthoredSideCapacities(found[0]);
    REQUIRE(caps.size() == 1);
    CHECK(caps[0].first == "horde");
}

TEST_CASE("sides: the first declaration of a multi-team side wins") {
    // A side is one slot pool however many teams it spans, so two entries
    // saying `capacity = 8` mean a side of 8 — not of 16.
    TempGame g("sides_capacity_multi");
    g.Write("war.lua", R"(return {
        sides = {
            { faction = 'compact', team = 0, capacity = 8 },
            { faction = 'compact', team = 1, capacity = 8 },
        },
        units = { { def = 'tank', team = 0 } },
    })");

    const auto found = SD::Discover(g.Path());
    REQUIRE(found.size() == 1);
    REQUIRE(found[0].sides.size() == 1);
    CHECK(found[0].sides[0].capacity == 8);
}

TEST_CASE("sides: an NPC side authors no capacity anyone can use") {
    // AuthoredSideCapacities runs over PlayableSides, so a capacity on an NPC
    // side never reaches the modoption — it would name a faction no account
    // can hold and no seating rule would ever consult.
    TempGame g("sides_capacity_npc");
    g.Write("war.lua", R"(return {
        sides = {
            { faction = 'compact', team = 0, capacity = 6 },
            { faction = 'reavers', team = 8, capacity = 99 },
        },
        units = { { def = 'tank', team = 0 } },
        ai = { { id = 'strategos', team = 8 } },
    })");

    const auto found = SD::Discover(g.Path());
    REQUIRE(found.size() == 1);
    const WarSideCapacities caps = SD::AuthoredSideCapacities(found[0]);
    REQUIRE(caps.size() == 1);
    CHECK(caps[0].first == "compact");
}
