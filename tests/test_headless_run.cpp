#include <doctest/doctest.h>

#include "Server/HeadlessRun.h"

// PLAN-headless task 1 — the pure stop-condition + pacing + config-parse core
// of --headless-run. These tests are the "stop-condition matrix" the plan's §6
// asks for (frame / gameOver / luaCondition / wall-ceiling), plus the pacing
// maths and config parser. All pure — no sim, no globals — so they link even
// though the surrounding engine wiring lives in server_main.

using namespace headless;

// Convenience: build a RunState with named fields.
static RunState state(int64_t frame, bool over, bool luaMet, bool luaErr, int64_t wall) {
    RunState s;
    s.frame = frame;
    s.gameOverDeclared = over;
    s.luaConditionMet = luaMet;
    s.luaConditionErrored = luaErr;
    s.wallElapsedSec = wall;
    return s;
}

TEST_CASE("EvaluateStop: no conditions and no wall ceiling never stops") {
    StopConditions cond;  // nothing set
    // maxWallSec = 0 disables the ceiling.
    CHECK(EvaluateStop(cond, 0, state(1'000'000, false, false, false, 999999))
          == StopReason::None);
}

TEST_CASE("EvaluateStop: frame limit") {
    StopConditions cond;
    cond.frame = 300;
    // Before the limit: keep running.
    CHECK(EvaluateStop(cond, 3600, state(299, false, false, false, 0)) == StopReason::None);
    // At the limit: stop.
    CHECK(EvaluateStop(cond, 3600, state(300, false, false, false, 0)) == StopReason::FrameLimit);
    // Past the limit (e.g. a skipped tick overshot): still stops.
    CHECK(EvaluateStop(cond, 3600, state(305, false, false, false, 0)) == StopReason::FrameLimit);
}

TEST_CASE("EvaluateStop: gameOver only fires when requested") {
    StopConditions off;                 // stopAt.gameOver defaults false
    CHECK(EvaluateStop(off, 3600, state(10, true, false, false, 0)) == StopReason::None);

    StopConditions on;
    on.gameOver = true;
    CHECK(EvaluateStop(on, 3600, state(10, false, false, false, 0)) == StopReason::None);
    CHECK(EvaluateStop(on, 3600, state(10, true, false, false, 0)) == StopReason::GameOver);
}

TEST_CASE("EvaluateStop: luaCondition met / errored") {
    StopConditions cond;
    cond.luaCondition = "GG.Balance.Done";
    // Not yet met.
    CHECK(EvaluateStop(cond, 3600, state(10, false, false, false, 0)) == StopReason::None);
    // Met.
    CHECK(EvaluateStop(cond, 3600, state(10, false, true, false, 0)) == StopReason::LuaCondition);
    // Errored → definitive stop (E3), and it outranks a met/frame condition.
    CHECK(EvaluateStop(cond, 3600, state(10, false, true, true, 0)) == StopReason::LuaError);

    // A lua error with no luaCondition configured is ignored (defensive).
    StopConditions none;
    CHECK(EvaluateStop(none, 3600, state(10, false, false, true, 0)) == StopReason::None);
}

TEST_CASE("EvaluateStop: wall ceiling is the runaway backstop (E4)") {
    StopConditions cond;  // no explicit stops
    CHECK(EvaluateStop(cond, 60, state(10, false, false, false, 59)) == StopReason::None);
    CHECK(EvaluateStop(cond, 60, state(10, false, false, false, 60)) == StopReason::WallCeiling);
    CHECK(EvaluateStop(cond, 60, state(10, false, false, false, 61)) == StopReason::WallCeiling);
}

TEST_CASE("EvaluateStop: precedence order") {
    // Every condition satisfied at once → error > gameOver > frame > lua > wall.
    StopConditions cond;
    cond.frame = 100;
    cond.gameOver = true;
    cond.luaCondition = "x";

    CHECK(EvaluateStop(cond, 60, state(100, true, true, true, 60)) == StopReason::LuaError);
    CHECK(EvaluateStop(cond, 60, state(100, true, true, false, 60)) == StopReason::GameOver);
    CHECK(EvaluateStop(cond, 60, state(100, false, true, false, 60)) == StopReason::FrameLimit);
    CHECK(EvaluateStop(cond, 60, state(50, false, true, false, 60)) == StopReason::LuaCondition);
    CHECK(EvaluateStop(cond, 60, state(50, false, false, false, 60)) == StopReason::WallCeiling);
}

TEST_CASE("TickIntervalMicros: pacing maths") {
    // Realtime @ 30 Hz = 33333µs/tick.
    CHECK(TickIntervalMicros(TickMode::Realtime, 1.0f, 30) == 33333);
    // xN multiplies the rate: x10 → 3333µs/tick.
    CHECK(TickIntervalMicros(TickMode::Multiple, 10.0f, 30) == 3333);
    // Uncapped is the "no pacing" sentinel.
    CHECK(TickIntervalMicros(TickMode::Uncapped, 1.0f, 30) == 0);
    // A degenerate multiple is clamped, not divide-by-zero.
    CHECK(TickIntervalMicros(TickMode::Multiple, 0.0f, 30) > 0);
    // A degenerate gameSpeed falls back to 30 Hz.
    CHECK(TickIntervalMicros(TickMode::Realtime, 1.0f, 0) == 33333);
}

TEST_CASE("StopReasonName covers every reason") {
    CHECK(std::string(StopReasonName(StopReason::None)) == "none");
    CHECK(std::string(StopReasonName(StopReason::FrameLimit)) == "frame-limit");
    CHECK(std::string(StopReasonName(StopReason::GameOver)) == "game-over");
    CHECK(std::string(StopReasonName(StopReason::LuaCondition)) == "lua-condition");
    CHECK(std::string(StopReasonName(StopReason::LuaError)) == "lua-error");
    CHECK(std::string(StopReasonName(StopReason::WallCeiling)) == "wall-ceiling");
}

TEST_CASE("ParseConfig: full manifest") {
    const char* json = R"({
        "map": "duel", "game": "metalstorm", "scenario": "balance_arena_1",
        "aiSlots": [
            { "aiId": "strategic", "team": 0, "profile": "aggressive" },
            { "aiId": "strategic", "team": 1 }
        ],
        "headless": {
            "tickMode": "uncapped",
            "stopAt": { "frame": 324000, "gameOver": true, "luaCondition": "GG.Balance.Done" },
            "statsDump": "out/run-01.json",
            "stateHashEvery": 900
        }
    })";
    Config c;
    std::string err;
    REQUIRE(ParseConfig(json, c, err));
    CHECK(err.empty());
    CHECK(c.enabled);
    CHECK(c.map == "duel");
    CHECK(c.game == "metalstorm");
    REQUIRE(c.aiSlots.size() == 2);
    CHECK(c.aiSlots[0].aiId == "strategic");
    CHECK(c.aiSlots[0].team == 0);
    CHECK(c.aiSlots[0].profile == "aggressive");
    CHECK(c.aiSlots[1].team == 1);
    CHECK(c.aiSlots[1].startPos == -1);
    CHECK(c.tickMode == TickMode::Uncapped);
    REQUIRE(c.stopAt.frame.has_value());
    CHECK(*c.stopAt.frame == 324000);
    CHECK(c.stopAt.gameOver);
    REQUIRE(c.stopAt.luaCondition.has_value());
    CHECK(*c.stopAt.luaCondition == "GG.Balance.Done");
    CHECK(c.statsDump == "out/run-01.json");
    CHECK(c.stateHashEvery == 900);
}

TEST_CASE("ParseConfig: tickMode variants") {
    auto parse = [](const char* tm, Config& c) {
        std::string j = std::string("{\"headless\":{\"tickMode\":\"") + tm + "\"}}";
        std::string err;
        return ParseConfig(j, c, err);
    };
    Config c;
    REQUIRE(parse("realtime", c));
    CHECK(c.tickMode == TickMode::Realtime);
    REQUIRE(parse("x2.5", c));
    CHECK(c.tickMode == TickMode::Multiple);
    CHECK(c.tickMultiple == doctest::Approx(2.5f));
    REQUIRE(parse("uncapped", c));
    CHECK(c.tickMode == TickMode::Uncapped);
}

TEST_CASE("ParseConfig: rejects malformed input") {
    Config c;
    std::string err;
    // Not JSON.
    CHECK_FALSE(ParseConfig("not json", c, err));
    CHECK_FALSE(err.empty());
    // Unknown tickMode.
    CHECK_FALSE(ParseConfig(R"({"headless":{"tickMode":"warp9"}})", c, err));
    // A non-positive xN multiple.
    CHECK_FALSE(ParseConfig(R"({"headless":{"tickMode":"x0"}})", c, err));
    // Top-level not an object.
    CHECK_FALSE(ParseConfig("[1,2,3]", c, err));
}

TEST_CASE("ParseConfig: minimal manifest defaults to realtime, no stops") {
    Config c;
    std::string err;
    REQUIRE(ParseConfig("{}", c, err));
    CHECK(c.enabled);
    CHECK(c.tickMode == TickMode::Realtime);
    CHECK_FALSE(c.stopAt.frame.has_value());
    CHECK_FALSE(c.stopAt.gameOver);
    CHECK_FALSE(c.stopAt.luaCondition.has_value());
    // With no explicit stops the wall ceiling (set by the caller) is the only
    // terminator — the pure evaluator confirms nothing else fires.
    CHECK(EvaluateStop(c.stopAt, 0, state(1, false, false, false, 0)) == StopReason::None);
}
