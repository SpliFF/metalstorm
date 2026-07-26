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

// ── AI4: sandboxed read-only file API (AI.getMapData / AI.getDefExport) ──

namespace {

// A synthetic plugin that reads regions.json (map data root) + power.json
// (def export root), probes an escape path and a missing file, and reports
// everything back through AI.issueCommand so the test can assert on it.
fs::path WriteFileReaderPlugin() {
    const fs::path dir = fs::temp_directory_path() / "strategos_ai4_reader";
    fs::remove_all(dir);
    fs::create_directories(dir);
    std::ofstream(dir / "main.lua") <<
        "function onUpdate(frame)\n"
        "  local rg = AI.getMapData('regions.json')\n"
        "  local pw = AI.getDefExport('power.json')\n"
        "  local rgCount  = (type(rg)=='table' and type(rg.regions)=='table') and #rg.regions or -1\n"
        "  local firstVal = (rgCount>0) and (rg.regions[1].value or -1) or -1\n"
        "  local nb       = (rgCount>0 and type(rg.regions[1].neighbors)=='table') and #rg.regions[1].neighbors or -1\n"
        "  local pwDps    = (type(pw)=='table' and type(pw.defs)=='table' and pw.defs['5']) and pw.defs['5'].dps or -1\n"
        "  -- an escape path must RAISE (pcall returns false) →1 means rejected\n"
        "  local escRej   = (not pcall(AI.getMapData, '../secret.json')) and 1 or 0\n"
        "  -- a missing file must return nil, NOT raise\n"
        "  local missNil  = (AI.getMapData('nope.json') == nil) and 1 or 0\n"
        "  AI.issueCommand(AI.getTeamId(), 777, rgCount, firstVal, nb, pwDps, escRej, missNil)\n"
        "end\n";
    return dir;
}

} // namespace

TEST_CASE("AI4: getMapData + getDefExport decode JSON, reject escapes") {
    const fs::path plugin = WriteFileReaderPlugin();

    // Two separate sandbox roots, each with one fixture file.
    const fs::path mapDir = fs::temp_directory_path() / "strategos_ai4_map";
    const fs::path defDir = fs::temp_directory_path() / "strategos_ai4_defs";
    fs::remove_all(mapDir); fs::remove_all(defDir);
    fs::create_directories(mapDir); fs::create_directories(defDir);
    std::ofstream(mapDir / "regions.json") <<
        R"({"provider":"graph","mapWidth":1000,"mapHeight":1000,"regions":[)"
        R"({"key":"north","name":"North","value":42,"tags":["hq"],"neighbors":["south","east"],"polygon":[{"x":0,"z":0}]},)"
        R"({"key":"south","name":"South","value":7,"tags":[],"neighbors":["north"],"polygon":[]}]})";
    std::ofstream(defDir / "power.json") <<
        R"({"defs":{"5":{"name":"tank","dps":12.5,"hp":300,"class":"tanks","scale":"2"}}})";

    const std::string code = ReadFile(plugin / "main.lua");
    AIScriptContext ctx("ai4_reader", /*teamId*/ 2, /*allyTeamId*/ 2,
                        plugin.string(), mapDir.string(), defDir.string());
    REQUIRE(ctx.Init(code, "main.lua"));

    AIStateSnapshot snap;
    snap.teamId = 2;
    aiCommandQueue.Drain();
    ctx.PushSnapshot(std::move(snap));
    ctx.ProcessSnapshot();

    auto cmds = aiCommandQueue.Drain();
    REQUIRE(cmds.size() == 1);
    const AICommand& c = cmds[0];
    CHECK(c.commandId == 777);
    REQUIRE(c.numParams == 6);
    CHECK(c.params[0] == doctest::Approx(2));      // #regions
    CHECK(c.params[1] == doctest::Approx(42));     // regions[1].value
    CHECK(c.params[2] == doctest::Approx(2));      // regions[1].neighbors count
    CHECK(c.params[3] == doctest::Approx(12.5));   // power.defs['5'].dps
    CHECK(c.params[4] == doctest::Approx(1));      // escape path rejected (raised)
    CHECK(c.params[5] == doctest::Approx(1));      // missing file → nil (no raise)

    fs::remove_all(plugin); fs::remove_all(mapDir); fs::remove_all(defDir);
}

TEST_CASE("AI4: unconfigured root → nil (no crash)") {
    // No mapDataDir / defExportDir passed → the accessors return nil so a
    // blind AI degrades honestly instead of erroring.
    fs::path dir = fs::temp_directory_path() / "strategos_ai4_blind";
    fs::remove_all(dir); fs::create_directories(dir);
    std::ofstream(dir / "main.lua") <<
        "function onUpdate(frame)\n"
        "  local a = (AI.getMapData('regions.json') == nil) and 1 or 0\n"
        "  local b = (AI.getDefExport('power.json') == nil) and 1 or 0\n"
        "  AI.issueCommand(AI.getTeamId(), 888, a, b)\n"
        "end\n";

    const std::string code = ReadFile(dir / "main.lua");
    AIScriptContext ctx("ai4_blind", 0, 0, dir.string()); // no read roots
    REQUIRE(ctx.Init(code, "main.lua"));
    AIStateSnapshot snap;
    aiCommandQueue.Drain();
    ctx.PushSnapshot(std::move(snap));
    ctx.ProcessSnapshot();
    auto cmds = aiCommandQueue.Drain();
    REQUIRE(cmds.size() == 1);
    CHECK(cmds[0].params[0] == doctest::Approx(1));
    CHECK(cmds[0].params[1] == doctest::Approx(1));
    fs::remove_all(dir);
}

TEST_CASE("AI4: the real strategos VM reads both static files") {
    // The real strategos picture.lua (readRegions/loadPowerTable) now pulls
    // regions.json + power.json through the AI4 API on every strategic tick.
    // Boot the real plugin with populated sandbox roots, tick once, and read
    // back the diagnostic globals picture.lua sets — proving both reads ran
    // inside the real strategos VM and decoded correctly.
    const fs::path plugin = fs::path(SPRING_SOURCE_DIR) /
        "data/games/metalstorm/ai/strategos";
    if (!fs::exists(plugin / "main.lua")) {
        MESSAGE("strategos plugin not present; skipping");
        return;
    }

    const fs::path mapDir = fs::temp_directory_path() / "strategos_ai4_realmap";
    const fs::path defDir = fs::temp_directory_path() / "strategos_ai4_realdefs";
    fs::remove_all(mapDir); fs::remove_all(defDir);
    fs::create_directories(mapDir); fs::create_directories(defDir);
    std::ofstream(mapDir / "regions.json") <<
        R"({"provider":"graph","mapWidth":512,"mapHeight":512,"regions":[)"
        R"({"key":"alpha","name":"Alpha","value":10,"tags":[],"neighbors":["bravo"],"polygon":[]},)"
        R"({"key":"bravo","name":"Bravo","value":20,"tags":[],"neighbors":["alpha"],"polygon":[]}]})";
    std::ofstream(defDir / "power.json") <<
        R"({"defs":{"3":{"name":"mech","dps":8,"hp":500,"class":"mechs","scale":"1"}}})";

    const std::string code = ReadFile(plugin / "main.lua");
    AIScriptContext ctx("strategos", /*teamId*/ 1, /*allyTeamId*/ 1,
                        plugin.string(), mapDir.string(), defDir.string());
    REQUIRE(ctx.Init(code, "main.lua"));

    AIStateSnapshot snap;
    snap.teamId = 1;
    snap.frame = 1;
    ctx.PushSnapshot(std::move(snap));
    ctx.ProcessSnapshot();   // boot + first strategic tick (Picture.refresh)
    CHECK(ctx.IsRunning());

    double regions = -1.0, power = -1.0;
    REQUIRE(ctx.TryGetGlobalNumber("AI_STRATEGOS_STATIC_REGIONS", regions));
    REQUIRE(ctx.TryGetGlobalNumber("AI_STRATEGOS_STATIC_POWER", power));
    CHECK(regions == doctest::Approx(2));   // both regions decoded
    CHECK(power == doctest::Approx(1));      // the one power-table def decoded

    fs::remove_all(mapDir); fs::remove_all(defDir);
}
