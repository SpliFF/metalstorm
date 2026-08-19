// HeadlessRun — run-mode config + pacing + stop-condition core for the
// `--headless-run <config>` batch/soak/CI mode (PLAN-headless task 1).
//
// This mode lets the game simulation run to completion WITHOUT a browser
// client attached: no rendering, no LuaUI, no clients — just the synced sim
// ticking as fast as (or as slowly as) the run config asks, until a stop
// condition fires. It unblocks AI-vs-AI soak, balance batches, replay
// re-execution and sim-determinism CI (see PLAN-headless §1).
//
// The whole module is deliberately PURE — it depends only on nlohmann::json
// and the standard library, no engine globals — so its stop-condition matrix
// and pacing maths are covered by a plain doctest (tests/test_headless_run.cpp)
// that links without dragging in the sim. The engine-coupled parts (firing the
// game, polling the synced-Lua predicate, reading the game-over relay) live in
// server_main.cpp and feed this module plain values via RunState.
#pragma once

#include <cstdint>
#include <optional>
#include <string>
#include <utility>
#include <vector>

namespace headless {

// Pacing mode for the sim loop under a headless run.
//   Realtime  — canonical GAME_SPEED cadence (33ms/tick), same as a live game.
//   Multiple  — "xN": tick at N× realtime wall-clock (N game-seconds / wall-second).
//   Uncapped  — no wall-clock pacing at all; tick as fast as the sim computes.
enum class TickMode { Realtime, Multiple, Uncapped };

// Why a headless run terminated. `None` means keep running. Reported in the
// completion log and (task 2) folded into the stats dump `status`.
enum class StopReason {
    None,
    FrameLimit,     // frame >= stopAt.frame
    GameOver,       // Spring.GameOver declared (and stopAt.gameOver requested)
    LuaCondition,   // synced-Lua predicate returned truthy
    LuaError,       // synced-Lua predicate raised / failed to compile (E3)
    WallCeiling,    // --max-wall-min hard ceiling hit (E4, outermost guard)
    // Replay-only terminal states (PLAN-replay task 2). Not produced by
    // EvaluateStop — a replay's end is a property of the recorded stream, not
    // of the stop-condition matrix — but they share this enum so the stats
    // dump's `status` field can say what actually happened.
    ReplayEnd,      // the recorded stream ran out at its recorded end frame
    ReplayAborted,  // a record the re-execution could not honestly reproduce
};

// The requested stop conditions (from the config's `headless.stopAt` block).
// Any set condition that fires stops the run; the wall ceiling (passed
// separately to EvaluateStop) is always active as the runaway backstop.
struct StopConditions {
    std::optional<int64_t> frame;             // stop at/after this sim frame
    bool gameOver = false;                     // stop when the game declares over
    std::optional<std::string> luaCondition;   // synced-Lua predicate to poll
};

// One AI slot from a self-contained manifest (`aiSlots[]`). Parsed here so all
// JSON handling lives in one place; server_main merges these into its
// RequestedAI list only when no `--ai` CLI flag was given. `profile` is carried
// through but not yet consumed (owned by PLAN-metalstorm-ai §11).
struct AiSlot {
    std::string aiId;
    int team = 0;
    int startPos = -1;
    std::string profile;
};

// Fully-parsed run configuration.
struct Config {
    bool enabled = false;                      // true once a --headless-run config loads

    TickMode tickMode = TickMode::Realtime;
    float tickMultiple = 1.0f;                  // used only when tickMode == Multiple

    StopConditions stopAt;

    int stateHashEvery = 0;                     // determinism-hash cadence (task 2 consumes)
    std::string statsDump;                      // JSON dump path (task 2 consumes)

    int64_t maxWallSec = 3600;                  // from --max-wall-min (default 60min); E4

    // Optional self-contained-manifest fields. server_main uses these only to
    // fill gaps left by the corresponding CLI flags (--map/--game/--ai).
    std::string map;
    std::string game;
    std::vector<AiSlot> aiSlots;

    // Room modoptions, the same key=value pairs `--modoption` carries. A
    // headless fixture that wants a game's synced gadgets configured (start
    // armies, chicken mode, multipliers) had no way to say so before: the
    // manifest is supposed to be a complete launch spec, and modoptions were
    // the one part of it only a CLI flag could supply. Parsed in declaration
    // order and applied by server_main only for keys `--modoption` did not
    // already set, so an explicit flag still wins (same precedence as
    // map/game/aiSlots). Values are strings on the wire — CGameSetup stores
    // them as strings and Spring.GetModOptions() hands them to Lua as strings —
    // so JSON numbers/bools are coerced rather than rejected.
    std::vector<std::pair<std::string, std::string>> modOptions;
};

// Observed sim state at the current tick, fed to EvaluateStop.
struct RunState {
    int64_t frame = 0;
    bool gameOverDeclared = false;
    bool luaConditionMet = false;
    bool luaConditionErrored = false;
    int64_t wallElapsedSec = 0;
};

// Pure stop-condition evaluator — the doctest-covered core. Returns the first
// reason that fires, in precedence order:
//   1. LuaError    — an errored predicate is a definitive stop (never a hang, E3)
//   2. GameOver    — only if stopAt.gameOver was requested
//   3. FrameLimit
//   4. LuaCondition
//   5. WallCeiling — always active when maxWallSec > 0 (the runaway backstop, E4)
StopReason EvaluateStop(const StopConditions& cond, int64_t maxWallSec,
                        const RunState& s);

// Microseconds per tick for the given mode. Returns 0 for Uncapped (sentinel:
// "do not pace"). `gameSpeed` is GAME_SPEED (sim frames per game-second).
int64_t TickIntervalMicros(TickMode mode, float tickMultiple, int gameSpeed);

// Human-readable name for logs / the stats dump status field.
const char* StopReasonName(StopReason r);

// Parse a headless-run config. Accepts the full quickstart-style manifest
// (top-level map/game/aiSlots + a `headless` block) or a headless-only file.
// Returns false and fills `err` on malformed input (never throws).
// maxWallSec is left at its default — server_main sets it from --max-wall-min.
bool ParseConfig(const std::string& jsonText, Config& out, std::string& err);
bool ParseConfigFile(const std::string& path, Config& out, std::string& err);

}  // namespace headless
