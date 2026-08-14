// test_ai_runtime — AI VM boundary: the plugin-scoped module loader
// (AI0-loader), AI.getRulesParam (AI1), AI.getTeamId, the AI4 file API, and the
// AI2 directive-shaped write verbs (createGroup / issueDirective / setPosture).
//
// These exercise the real AIScriptContext Lua VM (no sim needed): a snapshot
// is hand-built, pushed, and processed, and the AI's observations/commands are
// drained off aiCommandQueue and asserted on. The AI2 cases confirm the verbs
// push correctly-shaped commands (incl. createGroup→issueDirective token
// correlation) and that the REAL strategos pipeline emits a directive into the
// queue. Applying those commands to the sim (DirectiveManager + the charge
// callin) needs a full sim and is covered by the live smoke.

#include <doctest/doctest.h>

#include "Server/AI/AIScriptContext.h"
#include "Server/AI/AICommandQueue.h"
#include "Server/AI/AICommandCodec.h"
#include "Server/AI/AIStateSnapshot.h"
#include "System/SpringLog/SpringLog.h"

#include <filesystem>
#include <fstream>
#include <iterator>
#include <string>
#include <vector>

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

// Captured log lines for the AI.log visibility case below. A sink receives
// borrowed pointers, so copy out what we assert on.
struct CapturedLine { int level; std::string scope; std::string message; };
std::vector<CapturedLine> g_captured;

void CaptureSink(const SpringLogRecord* r, void*) {
    g_captured.push_back({ r->level,
                           r->scope   ? r->scope   : "",
                           r->message ? r->message : "" });
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

TEST_CASE("AI VM: AI.log survives the DEFAULT log threshold (§5.1 observability)") {
    // A headless AI has no chat wire and no HUD: AI.log is its only channel, and
    // main.lua routes the boot line, every per-directive announcement, the
    // per-tick summary and every tick ERROR through it. It used to emit at
    // SPRING_LOG_INFO while the default threshold is SPRING_LOG_NOTICE, so on an
    // ordinary run — nobody passing --log-level — the AI was completely silent
    // and could be shown neither to be working nor to be inert. This case
    // deliberately does NOT lower the threshold: it asserts the line arrives at
    // whatever springlog's default is, which is the condition that was broken.
    const fs::path dir = fs::temp_directory_path() / "strategos_ai_log_plugin";
    fs::remove_all(dir);
    fs::create_directories(dir);
    { std::ofstream(dir / "main.lua")
        << "function onUpdate(frame)\n"
           "  AI.log('[strategos] tick f=' .. tostring(frame))\n"
           "end\n"; }

    g_captured.clear();
    const int sinkId = springlog_add_sink(&CaptureSink, nullptr);

    AIScriptContext ctx("strategos", /*teamId*/ 2, /*allyTeamId*/ 2, dir.string());
    REQUIRE(ctx.Init(ReadFile(dir / "main.lua"), "main.lua"));

    AIStateSnapshot snap;
    snap.teamId = 2;
    snap.frame = 4242;
    ctx.PushSnapshot(std::move(snap));
    ctx.ProcessSnapshot();

    springlog_remove_sink(sinkId);

    const CapturedLine* line = nullptr;
    for (const auto& c : g_captured) {
        if (c.message.find("[strategos] tick f=4242") != std::string::npos) line = &c;
    }
    REQUIRE(line != nullptr);              // ← failed before the fix: dropped at INFO
    CHECK(line->level >= SPRING_LOG_NOTICE);
    CHECK(line->scope == "strategos");     // scoped to the AI slot's name

    fs::remove_all(dir);
}

TEST_CASE("AI VM: virtual playerID plumbs through (AI3 charge identity)") {
    // AI3 (PLAN-metalstorm-ai.md §1): each AI slot is a virtual player, so the
    // VM knows its playerID via AI.getPlayerId() and every command it issues is
    // attributed to that id (AICommand::playerId) — the authority charge
    // identity. Prove both: the Lua-visible getter and the drained command tag.
    const fs::path dir = fs::temp_directory_path() / "strategos_ai_pid_plugin";
    fs::remove_all(dir);
    fs::create_directories(dir);
    {
        std::ofstream m(dir / "main.lua");
        m << "function onUpdate(frame)\n"
             "  AI.issueCommand(1, 42, AI.getPlayerId())\n"
             "end\n";
    }
    const std::string code = ReadFile(dir / "main.lua");

    AIScriptContext ctx("ai_pid", /*teamId*/ 2, /*allyTeamId*/ 2, dir.string(),
                        /*mapDataDir*/ "", /*defExportDir*/ "", /*playerId*/ 7);
    REQUIRE(ctx.Init(code, "main.lua"));
    CHECK(ctx.GetPlayerId() == 7);

    AIStateSnapshot snap;
    snap.frame = 1;
    snap.teamId = 2;
    aiCommandQueue.Drain();
    ctx.PushSnapshot(std::move(snap));
    ctx.ProcessSnapshot();

    auto cmds = aiCommandQueue.Drain();
    REQUIRE(cmds.size() == 1);
    CHECK(cmds[0].teamId == 2);
    CHECK(cmds[0].playerId == 7);                       // AICommand carries the AI's id
    REQUIRE(cmds[0].numParams == 1);
    CHECK(cmds[0].params[0] == doctest::Approx(7));     // AI.getPlayerId() in Lua

    fs::remove_all(dir);
}

TEST_CASE("AI VM: unattributed AI (no virtual player) reports playerId -1") {
    const fs::path dir = fs::temp_directory_path() / "strategos_ai_nopid_plugin";
    fs::remove_all(dir);
    fs::create_directories(dir);
    {
        std::ofstream m(dir / "main.lua");
        m << "function onUpdate(frame) AI.issueCommand(1, 42, AI.getPlayerId()) end\n";
    }
    const std::string code = ReadFile(dir / "main.lua");
    // Default ctor playerId = -1 (single-buffer / test AI, no virtual player).
    AIScriptContext ctx("ai_nopid", 0, 0, dir.string());
    REQUIRE(ctx.Init(code, "main.lua"));
    CHECK(ctx.GetPlayerId() == -1);

    AIStateSnapshot snap; snap.teamId = 0;
    aiCommandQueue.Drain();
    ctx.PushSnapshot(std::move(snap));
    ctx.ProcessSnapshot();
    auto cmds = aiCommandQueue.Drain();
    REQUIRE(cmds.size() == 1);
    CHECK(cmds[0].playerId == -1);
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

// ── AI2: directive-shaped write verbs (createGroup / issueDirective / setPosture) ──

namespace {

// A synthetic plugin that exercises all three AI2 write verbs, including the
// createGroup→issueDirective/setPosture token correlation (a negative handle
// is a same-batch group token). It stashes the returned handle in a global so
// the test can confirm it is the negated group token.
fs::path WriteDirectiveVerbPlugin() {
    const fs::path dir = fs::temp_directory_path() / "strategos_ai2_verbs";
    fs::remove_all(dir);
    fs::create_directories(dir);
    std::ofstream(dir / "main.lua") <<
        "function onUpdate(frame)\n"
        "  local h = AI.createGroup({10, 20, 30}, 1)      -- negative token handle\n"
        "  _G.HANDLE = h\n"
        "  AI.issueDirective(h, { type=9, priority=7, shape=1,\n"
        "    params={150,0,50,64}, requestedStrength=500,\n"
        "    within={x=150, z=50, radius=64} })            -- group-scoped (via token)\n"
        "  AI.issueDirective(0, { type=5, priority=3, shape=1, params={10,0,20,8} })\n"
        "  AI.setPosture(h, '{\\\"roe\\\":\\\"hold\\\"}')\n"
        "end\n";
    return dir;
}

} // namespace

TEST_CASE("AI2: directive verbs push correctly-shaped commands (with token correlation)") {
    const fs::path dir = WriteDirectiveVerbPlugin();
    const std::string code = ReadFile(dir / "main.lua");

    AIScriptContext ctx("ai2_verbs", /*teamId*/ 4, /*allyTeamId*/ 4, dir.string());
    REQUIRE(ctx.Init(code, "main.lua"));

    AIStateSnapshot snap;
    snap.teamId = 4;
    aiCommandQueue.Drain();
    ctx.PushSnapshot(std::move(snap));
    ctx.ProcessSnapshot();

    auto cmds = aiCommandQueue.Drain();
    REQUIRE(cmds.size() == 4);

    // 1. createGroup
    const AICommand& g = cmds[0];
    CHECK(g.kind == AICommandKind::CreateGroup);
    CHECK(g.teamId == 4);
    CHECK(g.echelon == 1);
    REQUIRE(g.squadIds.size() == 3);
    CHECK(g.squadIds[0] == 10u);
    CHECK(g.squadIds[2] == 30u);
    CHECK(g.groupToken > 0u);
    const uint32_t token = g.groupToken;

    // The handle handed back to Lua is the negated token.
    double handle = 0.0;
    REQUIRE(ctx.TryGetGlobalNumber("HANDLE", handle));
    CHECK(handle == doctest::Approx(-static_cast<double>(token)));

    // 2. group-scoped directive — references the create via refToken, not a real id
    const AICommand& d0 = cmds[1];
    CHECK(d0.kind == AICommandKind::IssueDirective);
    CHECK(d0.refToken == token);
    CHECK(d0.groupId == 0u);
    CHECK(d0.directiveType == 9);
    CHECK(d0.priority == 7);
    CHECK(d0.shape == 1);
    REQUIRE(d0.directiveParams.size() == 4);
    CHECK(d0.directiveParams[0] == doctest::Approx(150));
    CHECK(d0.directiveParams[3] == doctest::Approx(64));
    CHECK(d0.requestedStrength == 500u);
    CHECK(d0.withinRadius == doctest::Approx(64));
    CHECK(d0.withinX == doctest::Approx(150));
    CHECK(d0.withinZ == doctest::Approx(50));

    // 3. area-scoped directive — no group, no token, no within filter
    const AICommand& d1 = cmds[2];
    CHECK(d1.kind == AICommandKind::IssueDirective);
    CHECK(d1.refToken == 0u);
    CHECK(d1.groupId == 0u);
    CHECK(d1.directiveType == 5);
    CHECK(d1.withinRadius == doctest::Approx(0));

    // 4. posture — references the same created group, carries the JSON
    const AICommand& p = cmds[3];
    CHECK(p.kind == AICommandKind::SetPosture);
    CHECK(p.refToken == token);
    CHECK(p.text == "{\"roe\":\"hold\"}");

    fs::remove_all(dir);
}

TEST_CASE("AI2: real strategos VM issues a directive into the command queue") {
    // End-to-end proof that the whole strategos pipeline (picture → slate →
    // planner → actuators) reaches the directive-shaped command queue: boot the
    // REAL plugin, feed it a two-region picture (one owned, one neutral-adjacent
    // = an EXPAND/SCOUT goal) plus one own unit and a funded team pool, tick
    // once, and confirm at least one IssueDirective command lands on the queue
    // anchored on the target region. The sim-thread drain (which turns this into
    // a real DirectiveManager::Create + AllowDirectiveCreate charge) needs a
    // full sim and is covered by the live smoke, not here.
    const fs::path plugin = fs::path(SPRING_SOURCE_DIR) /
        "data/games/metalstorm/ai/strategos";
    if (!fs::exists(plugin / "main.lua")) {
        MESSAGE("strategos plugin not present; skipping");
        return;
    }

    const fs::path mapDir = fs::temp_directory_path() / "strategos_ai2_map";
    const fs::path defDir = fs::temp_directory_path() / "strategos_ai2_defs";
    fs::remove_all(mapDir); fs::remove_all(defDir);
    fs::create_directories(mapDir); fs::create_directories(defDir);
    // home = owned square [0..100]²; front = neutral square [100..200]×[0..100],
    // adjacent to home → EXPAND (neutral, adjacent-to-owned, no threat).
    std::ofstream(mapDir / "regions.json") <<
        R"({"provider":"graph","mapWidth":512,"mapHeight":512,"regions":[)"
        R"({"key":"home","name":"Home","value":10,"tags":[],"neighbors":["front"],)"
        R"("polygon":[{"x":0,"z":0},{"x":100,"z":0},{"x":100,"z":100},{"x":0,"z":100}]},)"
        R"({"key":"front","name":"Front","value":20,"tags":[],"neighbors":["home"],)"
        R"("polygon":[{"x":100,"z":0},{"x":200,"z":0},{"x":200,"z":100},{"x":100,"z":100}]}]})";
    std::ofstream(defDir / "power.json") <<
        R"({"defs":{"3":{"name":"tank","dps":12,"hp":500,"class":"tanks","scale":"2"}}})";

    const std::string code = ReadFile(plugin / "main.lua");
    AIScriptContext ctx("strategos", /*teamId*/ 1, /*allyTeamId*/ 1,
                        plugin.string(), mapDir.string(), defDir.string());
    REQUIRE(ctx.Init(code, "main.lua"));

    AIStateSnapshot snap;
    snap.teamId = 1;
    snap.frame = 1;
    // Region control overlay + a funded team pool (full_side draws the team
    // fallback pool; ownPool is honestly 0 until AI3).
    snap.gameParams["region_home_team"]  = AIRulesParamValue{false, 1.0, ""};
    snap.gameParams["region_front_team"] = AIRulesParamValue{false, -1.0, ""};
    snap.teamParams["authority_pool"]    = AIRulesParamValue{false, 100000.0, ""};
    // One own unit sitting inside the home polygon → a force package of ~500.
    AISquadInfo u;
    u.unitId = 42; u.defId = 3; u.team = 1;
    u.position = float3(50.0f, 0.0f, 50.0f); u.health = 500.0f;
    snap.ownUnits.push_back(u);

    aiCommandQueue.Drain();
    ctx.PushSnapshot(std::move(snap));
    ctx.ProcessSnapshot();   // boot + one strategic tick
    CHECK(ctx.IsRunning());

    auto cmds = aiCommandQueue.Drain();
    int directives = 0;
    const AICommand* issued = nullptr;
    for (const auto& c : cmds) {
        // Structural floor: the strategos actuator must emit NO per-squad command.
        CHECK(c.kind != AICommandKind::UnitCommand);
        if (c.kind == AICommandKind::IssueDirective) { ++directives; issued = &c; }
    }
    REQUIRE(directives >= 1);
    // The directive anchors on the FRONT region centroid (150, 50) — proving the
    // actuator resolved region geometry from regions.json, not a stub.
    REQUIRE(issued->directiveParams.size() >= 3);
    CHECK(issued->directiveParams[0] == doctest::Approx(150));
    CHECK(issued->directiveParams[2] == doctest::Approx(50));
    CHECK(issued->requestedStrength > 0u);   // demand cap threaded from the package

    fs::remove_all(mapDir); fs::remove_all(defDir);
}

// ─────────────── I1/SG1: AI.sendMessage, the AI→synced-Lua write ───────────
//
// PLAN-ai-synced-write task 1. The verb pushes an opaque payload as
// AICommandKind::LuaMsg; the drain (StateStreamer::ApplyAICommands) hands it to
// `luaRules->RecvLuaMsg(text, playerId)` — the SAME gadget entry point a human's
// LuaRulesMsg lands on. What is testable here is everything up to that hand-off
// plus the journal codec; the delivery itself needs a GameServerContext (the
// streamer is not linked into spring-tests), so it is the SG1 headless smoke's
// job — task 5(a) in the plan, and this comment is the pointer to it.

TEST_CASE("I1/SG1: AI.sendMessage queues a LuaMsg attributed to the AI's player") {
    const fs::path dir = fs::temp_directory_path() / "strategos_ai_sendmsg_plugin";
    fs::remove_all(dir);
    fs::create_directories(dir);
    {
        std::ofstream m(dir / "main.lua");
        m << "function onUpdate(frame)\n"
             "  local ok = AI.sendMessage('cmd=ai.intent&goalId=17')\n"
             "  AI.issueCommand(1, 42, ok and 1 or 0)\n"   // report the return value
             "end\n";
    }
    const std::string code = ReadFile(dir / "main.lua");

    AIScriptContext ctx("ai_sendmsg", /*teamId*/ 2, /*allyTeamId*/ 2, dir.string(),
                        /*mapDataDir*/ "", /*defExportDir*/ "", /*playerId*/ 5);
    REQUIRE(ctx.Init(code, "main.lua"));

    AIStateSnapshot snap;
    snap.frame = 1;
    snap.teamId = 2;
    aiCommandQueue.Drain();
    ctx.PushSnapshot(std::move(snap));
    ctx.ProcessSnapshot();

    auto cmds = aiCommandQueue.Drain();
    REQUIRE(cmds.size() == 2);
    // Push order is the correlation guarantee the intent/RecordIntent pairing
    // rests on (§2.5): the message precedes the command it annotates.
    CHECK(cmds[0].kind == AICommandKind::LuaMsg);
    CHECK(cmds[0].text == "cmd=ai.intent&goalId=17");
    CHECK(cmds[0].teamId == 2);
    CHECK(cmds[0].playerId == 5);      // AI3 identity, what RecvLuaMsg attributes to
    CHECK(cmds[1].kind == AICommandKind::UnitCommand);
    REQUIRE(cmds[1].numParams == 1);
    CHECK(cmds[1].params[0] == doctest::Approx(1));   // sendMessage returned true

    fs::remove_all(dir);
}

TEST_CASE("I1/SG1: an oversize message is refused at push, and does not raise") {
    const fs::path dir = fs::temp_directory_path() / "strategos_ai_sendmsg_big";
    fs::remove_all(dir);
    fs::create_directories(dir);
    {
        std::ofstream m(dir / "main.lua");
        // 2049 bytes — one past the clamp. A throttled planner must degrade,
        // not crash its tick, so the verb returns false rather than erroring.
        m << "function onUpdate(frame)\n"
             "  local ok = AI.sendMessage(string.rep('x', 2049))\n"
             "  local ok2 = AI.sendMessage(string.rep('y', 2048))\n"
             "  AI.issueCommand(1, 42, ok and 1 or 0, ok2 and 1 or 0)\n"
             "end\n";
    }
    const std::string code = ReadFile(dir / "main.lua");

    AIScriptContext ctx("ai_sendmsg_big", 0, 0, dir.string());
    REQUIRE(ctx.Init(code, "main.lua"));

    AIStateSnapshot snap; snap.teamId = 0;
    aiCommandQueue.Drain();
    ctx.PushSnapshot(std::move(snap));
    ctx.ProcessSnapshot();
    CHECK(ctx.IsRunning());            // the tick survived the rejection

    auto cmds = aiCommandQueue.Drain();
    REQUIRE(cmds.size() == 2);         // the rejected one never reached the queue
    CHECK(cmds[0].kind == AICommandKind::LuaMsg);
    CHECK(cmds[0].text.size() == kAILuaMsgMaxBytes);   // exactly at the cap passes
    REQUIRE(cmds[1].numParams == 2);
    CHECK(cmds[1].params[0] == doctest::Approx(0));    // 2049 → false
    CHECK(cmds[1].params[1] == doctest::Approx(1));    // 2048 → true

    fs::remove_all(dir);
}

TEST_CASE("I1/SG1: the drain clamp passes 16 LuaMsg per AI player per batch") {
    // The E6 structural backstop the drain applies (StateStreamer::ApplyAICommands).
    // It is per PLAYER, not per batch: two AIs in one batch each get their own
    // 16, which is what stops one defeated planner from starving the other.
    AILuaMsgDrainBudget budget;
    int delivered = 0, dropped = 0;
    for (int i = 0; i < 17; ++i)
        (budget.TryConsume(/*playerId*/ 5) ? delivered : dropped)++;
    CHECK(delivered == kAILuaMsgPerDrain);
    CHECK(dropped == 1);

    CHECK(budget.TryConsume(/*playerId*/ 6));    // a second AI is unaffected
    // ...and an unattributed AI (-1) is its own bucket, not a shared one.
    CHECK(budget.TryConsume(-1));
}

TEST_CASE("I1/SG1: the LuaMsg kind and its payload survive the journal codec") {
    // Journal chokepoint #4: the drain records EVERY command before applying
    // any of it, so a replay re-feeds the batch through the same
    // ApplyAICommands. If the kind byte or the text did not round-trip, a
    // replayed AI message would apply as a different verb — silently.
    AICommand c;
    c.kind     = AICommandKind::LuaMsg;
    c.teamId   = 3;
    c.playerId = 9;
    c.text     = std::string("cmd=ai.intent&goalId=42&dt=7&region=north");

    const std::vector<uint8_t> blob = SerializeAICommand(c);
    REQUIRE(!blob.empty());
    CHECK(blob[0] == static_cast<uint8_t>(AICommandKind::LuaMsg));   // kind byte

    AICommand back;
    REQUIRE(DeserializeAICommand(blob, back));
    CHECK(back.kind == AICommandKind::LuaMsg);
    CHECK(back.teamId == 3);
    CHECK(back.playerId == 9);
    CHECK(back.text == c.text);

    // An embedded NUL survives too — the payload is bytes, not a C string, and
    // wire.lua is free to carry any of them.
    c.text.assign("a\0b", 3);
    AICommand nulBack;
    REQUIRE(DeserializeAICommand(SerializeAICommand(c), nulBack));
    CHECK(nulBack.text.size() == 3);
    CHECK(nulBack.text == std::string("a\0b", 3));

    // A truncated record is refused rather than half-applied.
    std::vector<uint8_t> truncated = SerializeAICommand(c);
    truncated.resize(truncated.size() - 2);
    AICommand ignored;
    CHECK_FALSE(DeserializeAICommand(truncated, ignored));
}
