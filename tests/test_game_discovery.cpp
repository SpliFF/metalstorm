#include <doctest/doctest.h>

#include "Server/GameDiscovery.h"

#include <filesystem>
#include <fstream>
#include <string>

// PLAN-endtoend.md D26 — the lobby's view of "which games may a player
// actually create". BAR and ZK were archived 2026-08-02 (PLAN.md, user
// directive) but stayed in the create-room dropdown, and because discovery
// sorts alphabetically and the client took entry 0, `bar` was the SELECTED
// default: the first choice a new player makes was a game that does not
// start.
//
// The load-bearing property under test is that `archived` changes who may
// PICK a game, not whether it is discovered. Dropping archived games from
// Discover() would have been the smaller change and is wrong: the folder is
// real, `/api/rooms/direct` still stages archived content for fixtures and
// for PLAN-bulk-spawn-crash.md's repro, and a lobby whose list disagrees
// with the filesystem is a worse surface than a greyed-out row.

namespace fs = std::filesystem;
namespace GD = GameDiscovery;

namespace {

/// A scratch games directory holding whole game folders, removed on
/// destruction. Named after the subcase so runs don't collide.
struct TempGamesDir {
    fs::path root;

    explicit TempGamesDir(const std::string& tag) {
        root = fs::temp_directory_path() / ("gamedisc_" + tag);
        fs::remove_all(root);
        fs::create_directories(root);
    }
    ~TempGamesDir() {
        std::error_code ec;
        fs::remove_all(root, ec);
    }

    /// Write `<folder>/game.config.lua`. The body is the table contents,
    /// so a caller writes only the fields it cares about — exactly what a
    /// barebones real config looks like.
    void Write(const std::string& folder, const std::string& fields) const {
        fs::create_directories(root / folder);
        std::ofstream f(root / folder / "game.config.lua");
        f << "return {\n" << fields << "\n}\n";
    }

    std::string Path() const { return root.string(); }
};

} // namespace

TEST_CASE("GameDiscovery reads the archived flag and its reason") {
    TempGamesDir dir("flag");
    dir.Write("metalstorm", "  name = 'Metalstorm', version = '0.1',");
    dir.Write("zk",
        "  name = 'Zero-K',\n"
        "  archived = true,\n"
        "  archivedReason = 'The Zero-K port is archived.',");

    auto games = GD::Discover(dir.Path());
    REQUIRE(games.size() == 2);

    const GD::GameInfo* ms = GD::FindById(games, "metalstorm");
    REQUIRE(ms != nullptr);
    // Silence means playable. A game that says nothing must never become
    // unpickable through a parse slip.
    CHECK(ms->archived == false);
    CHECK(ms->archivedReason == "");

    const GD::GameInfo* zk = GD::FindById(games, "zk");
    REQUIRE(zk != nullptr);
    CHECK(zk->archived == true);
    CHECK(zk->archivedReason == "The Zero-K port is archived.");
}

TEST_CASE("GameDiscovery still lists an archived game") {
    // The rule is "cannot be picked", not "does not exist". /api/rooms/direct
    // stages archived content from a manifest and must keep working.
    TempGamesDir dir("listed");
    dir.Write("bar", "  name = 'Beyond All Reason', archived = true,");

    auto games = GD::Discover(dir.Path());
    REQUIRE(games.size() == 1);
    CHECK(games[0].id == "bar");
    CHECK(games[0].archived == true);
}

TEST_CASE("DefaultPlayable skips the archived game that sorts first") {
    // The defect verbatim. Discovery sorts by folder id, so `bar` is
    // entry 0 on this tree and the old `games[0]` rule picked it.
    TempGamesDir dir("default");
    dir.Write("bar", "  name = 'Beyond All Reason', archived = true,");
    dir.Write("metalstorm", "  name = 'Metalstorm',");
    dir.Write("zk", "  name = 'Zero-K', archived = true,");

    auto games = GD::Discover(dir.Path());
    REQUIRE(games.size() == 3);
    REQUIRE(games[0].id == "bar");

    const GD::GameInfo* pick = GD::DefaultPlayable(games);
    REQUIRE(pick != nullptr);
    CHECK(pick->id == "metalstorm");
}

TEST_CASE("DefaultPlayable returns nothing rather than an unstartable default") {
    TempGamesDir dir("none");
    dir.Write("bar", "  name = 'Beyond All Reason', archived = true,");
    dir.Write("zk", "  name = 'Zero-K', archived = true,");

    auto games = GD::Discover(dir.Path());
    REQUIRE(games.size() == 2);
    // A default the create route would then refuse is worse than no
    // default: the player only finds out at the Create button.
    CHECK(GD::DefaultPlayable(games) == nullptr);
    CHECK(GD::DefaultPlayable({}) == nullptr);
}

TEST_CASE("FindById misses cleanly") {
    TempGamesDir dir("find");
    dir.Write("metalstorm", "  name = 'Metalstorm',");

    auto games = GD::Discover(dir.Path());
    CHECK(GD::FindById(games, "metalstorm") != nullptr);
    CHECK(GD::FindById(games, "bar") == nullptr);
    CHECK(GD::FindById(games, "") == nullptr);
}
