// test_ai_runtime — AI VM boundary: the plugin-scoped module loader
// (AI0-loader), AI.getRulesParam (AI1), and AI.getTeamId.
//
// These exercise the real AIScriptContext Lua VM (no sim needed): a snapshot
// is hand-built, pushed, and processed, and the AI reports its observations
// back through AI.issueCommand — the one existing observable channel — which
// we drain and assert on. A second case boots the *real* strategos multi-file
// plugin to prove the loader resolves its require() graph end to end.

#include <doctest/doctest.h>

#include "Server/AI/AIScriptContext.h"
#include "Server/AI/AICommandQueue.h"
#include "Server/AI/AIStateSnapshot.h"

#include <filesystem>
#include <fstream>
#include <iterator>
#include <string>

namespace fs = std::filesystem;

namespace {

std::string ReadFile(const fs::path& p) {
    std::ifstream f(p, std::ios::binary);
    return std::string((std::istreambuf_iterator<char>(f)),
                       std::istreambuf_iterator<char>());
}

// Write a tiny multi-file plugin: a top-level module, a dotted/nested module,
// and a main.lua that pulls both via require and reports observations via
// AI.issueCommand so the test can read them back off aiCommandQueue.
fs::path WriteSyntheticPlugin() {
    const fs::path dir = fs::temp_directory_path() / "strategos_ai_test_plugin";
    fs::remove_all(dir);
    fs::create_directories(dir / "nested");

    { std::ofstream(dir / "sub.lua") << "return { answer = 7 }\n"; }
    { std::ofstream(dir / "nested" / "mod.lua") << "return { tag = 55 }\n"; }
    {
        std::ofstream m(dir / "main.lua");
        m << "local S = require('sub')\n"
             "local N = require('nested.mod')\n"
             "-- require caches: a second require returns the same table\n"
             "assert(require('sub') == S, 'require cache broken')\n"
             "function onUpdate(frame)\n"
             "  local rp       = AI.getRulesParam('game', 'magic') or -1\n"
             "  local labelOk  = (AI.getRulesParam('game', 'label') == 'alpha') and 1 or 0\n"
             "  local teamNum  = AI.getRulesParam('team', 'sidenum') or -1\n"
             "  local missing  = (AI.getRulesParam('game', 'nope') == nil) and 1 or 0\n"
             "  AI.issueCommand(AI.getTeamId(), 999, S.answer, rp, labelOk, teamNum, missing, N.tag)\n"
             "end\n";
    }
    return dir;
}

} // namespace

TEST_CASE("AI VM: require loader + getRulesParam + getTeamId end to end") {
    const fs::path dir = WriteSyntheticPlugin();
    const std::string code = ReadFile(dir / "main.lua");

    AIScriptContext ctx("ai_test", /*teamId*/ 3, /*allyTeamId*/ 3, dir.string());
    REQUIRE(ctx.Init(code, "main.lua"));   // all require()s resolved + chunk ran
    REQUIRE(ctx.IsRunning());

    AIStateSnapshot snap;
    snap.frame = 100;
    snap.teamId = 3;
    snap.gameParams["magic"] = AIRulesParamValue{false, 42.0, ""};
    snap.gameParams["label"] = AIRulesParamValue{true, 0.0, "alpha"};
    snap.teamParams["sidenum"] = AIRulesParamValue{false, 9.0, ""};

    aiCommandQueue.Drain(); // clear anything from other cases
    ctx.PushSnapshot(std::move(snap));
    ctx.ProcessSnapshot();

    auto cmds = aiCommandQueue.Drain();
    REQUIRE(cmds.size() == 1);
    const AICommand& c = cmds[0];
    CHECK(c.teamId == 3);
    CHECK(c.unitId == 3u);      // AI.getTeamId()
    CHECK(c.commandId == 999);
    REQUIRE(c.numParams == 6);
    CHECK(c.params[0] == doctest::Approx(7));   // require('sub').answer
    CHECK(c.params[1] == doctest::Approx(42));  // getRulesParam('game','magic')
    CHECK(c.params[2] == doctest::Approx(1));   // string param == 'alpha'
    CHECK(c.params[3] == doctest::Approx(9));   // getRulesParam('team','sidenum')
    CHECK(c.params[4] == doctest::Approx(1));   // absent key → nil
    CHECK(c.params[5] == doctest::Approx(55));  // require('nested.mod').tag

    fs::remove_all(dir);
}

TEST_CASE("AI VM: require rejects path traversal") {
    const fs::path dir = WriteSyntheticPlugin();
    // A module name escaping the plugin folder must fail to load, which makes
    // the chunk pcall fail, which makes Init() return false.
    AIScriptContext ctx("ai_test_evil", 0, 0, dir.string());
    CHECK_FALSE(ctx.Init("require('../../../../etc/hosts')\n", "main.lua"));
    fs::remove_all(dir);
}

TEST_CASE("AI VM: strategos multi-file plugin boots via the loader") {
    // The real strategos AI (data/games/metalstorm/ai/strategos) is a
    // multi-file layout whose main.lua require()s config/picture/slate/
    // planner/actuators/roles + profiles.default. Init() succeeding proves the
    // loader resolves that whole graph — the AI0-loader acceptance test.
    const fs::path plugin = fs::path(SPRING_SOURCE_DIR) /
        "data/games/metalstorm/ai/strategos";
    if (!fs::exists(plugin / "main.lua")) {
        MESSAGE("strategos plugin not present; skipping");
        return;
    }
    const std::string code = ReadFile(plugin / "main.lua");
    AIScriptContext ctx("strategos", /*teamId*/ 1, /*allyTeamId*/ 1, plugin.string());
    REQUIRE(ctx.Init(code, "main.lua"));
    CHECK(ctx.IsRunning());

    // First onUpdate triggers boot(): it must run without throwing out of the
    // pcall (the module graph is sound). A blank snapshot is fine — the AI is
    // blind (no rulesParams) and correctly does almost nothing.
    AIStateSnapshot snap;
    snap.teamId = 1;
    ctx.PushSnapshot(std::move(snap));
    ctx.ProcessSnapshot(); // must not crash the VM
    CHECK(ctx.IsRunning());
}
