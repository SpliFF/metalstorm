// HeadlessRun — see HeadlessRun.h. Pure config/pacing/stop-condition core.

#include "Server/HeadlessRun.h"

#include <algorithm>
#include <cstdlib>
#include <fstream>
#include <sstream>

#include <nlohmann/json.hpp>

namespace headless {

StopReason EvaluateStop(const StopConditions& cond, int64_t maxWallSec,
                        const RunState& s) {
    // 1. An errored synced-Lua predicate is a definitive stop (E3: never a hang).
    if (cond.luaCondition && s.luaConditionErrored)
        return StopReason::LuaError;
    // 2. Game declared over (only if the config asked us to stop on it).
    if (cond.gameOver && s.gameOverDeclared)
        return StopReason::GameOver;
    // 3. Frame limit.
    if (cond.frame && s.frame >= *cond.frame)
        return StopReason::FrameLimit;
    // 4. Synced-Lua predicate satisfied.
    if (cond.luaCondition && s.luaConditionMet)
        return StopReason::LuaCondition;
    // 5. Hard wall-clock ceiling — the outermost runaway guard (E4).
    if (maxWallSec > 0 && s.wallElapsedSec >= maxWallSec)
        return StopReason::WallCeiling;
    return StopReason::None;
}

int64_t TickIntervalMicros(TickMode mode, float tickMultiple, int gameSpeed) {
    if (mode == TickMode::Uncapped)
        return 0;  // sentinel: caller skips wall-clock pacing entirely
    if (gameSpeed <= 0)
        gameSpeed = 30;
    float mult = (mode == TickMode::Multiple) ? tickMultiple : 1.0f;
    // Clamp so a misconfigured multiple can't divide by zero or busy-spin.
    // 0.01× ≈ 3.3s/tick; 1000× ≈ 33µs/tick.
    mult = std::clamp(mult, 0.01f, 1000.0f);
    return static_cast<int64_t>(1'000'000.0 / (gameSpeed * mult));
}

const char* StopReasonName(StopReason r) {
    switch (r) {
        case StopReason::None:         return "none";
        case StopReason::FrameLimit:   return "frame-limit";
        case StopReason::GameOver:     return "game-over";
        case StopReason::LuaCondition: return "lua-condition";
        case StopReason::LuaError:     return "lua-error";
        case StopReason::WallCeiling:  return "wall-ceiling";
        case StopReason::ReplayEnd:    return "replay-end";
        case StopReason::ReplayAborted: return "replay-aborted";
    }
    return "unknown";
}

bool ParseConfig(const std::string& jsonText, Config& out, std::string& err) {
    using nlohmann::json;
    json j;
    try {
        j = json::parse(jsonText);
    } catch (const std::exception& e) {
        err = std::string("JSON parse error: ") + e.what();
        return false;
    }
    if (!j.is_object()) {
        err = "headless-run config: top-level value is not an object";
        return false;
    }

    out.enabled = true;

    // --- Optional self-contained manifest fields ---
    if (j.contains("map") && j["map"].is_string())
        out.map = j["map"].get<std::string>();
    if (j.contains("game") && j["game"].is_string())
        out.game = j["game"].get<std::string>();
    if (j.contains("aiSlots") && j["aiSlots"].is_array()) {
        for (const auto& s : j["aiSlots"]) {
            if (!s.is_object())
                continue;
            AiSlot slot;
            slot.aiId    = s.value("aiId", std::string());
            slot.team    = s.value("team", 0);
            slot.startPos = s.value("startPos", -1);
            slot.profile = s.value("profile", std::string());
            if (slot.aiId.empty())
                continue;  // skip malformed slots rather than abort the run
            out.aiSlots.push_back(std::move(slot));
        }
    }
    if (j.contains("modOptions") && j["modOptions"].is_object()) {
        // nlohmann preserves insertion order only with ordered_json; plain
        // json sorts keys. Either way the ORDER is not semantically load-
        // bearing (CGameSetup is a map), but it is deterministic, which is
        // what a determinism fixture needs.
        for (const auto& [key, val] : j["modOptions"].items()) {
            if (key.empty())
                continue;
            std::string s;
            if (val.is_string())        s = val.get<std::string>();
            else if (val.is_boolean())  s = val.get<bool>() ? "1" : "0";
            else if (val.is_number_integer()) s = std::to_string(val.get<int64_t>());
            else if (val.is_number())   s = std::to_string(val.get<double>());
            else continue;  // objects/arrays/null have no modoption spelling
            out.modOptions.emplace_back(key, std::move(s));
        }
    }

    // --- The `headless` block (run behaviour) ---
    if (!j.contains("headless"))
        return true;  // manifest with no headless block: defaults (realtime, no stops)
    if (!j["headless"].is_object()) {
        err = "headless-run config: `headless` is not an object";
        return false;
    }
    const json& h = j["headless"];

    // tickMode: "uncapped" | "realtime" | "xN"
    {
        const std::string tm = h.value("tickMode", std::string("realtime"));
        if (tm == "uncapped") {
            out.tickMode = TickMode::Uncapped;
        } else if (tm == "realtime") {
            out.tickMode = TickMode::Realtime;
        } else if (tm.size() >= 2 && (tm[0] == 'x' || tm[0] == 'X')) {
            out.tickMode = TickMode::Multiple;
            out.tickMultiple = static_cast<float>(std::atof(tm.c_str() + 1));
            if (!(out.tickMultiple > 0.0f)) {
                err = "headless-run config: invalid tickMode multiple '" + tm + "'";
                return false;
            }
        } else {
            err = "headless-run config: unknown tickMode '" + tm +
                  "' (want \"uncapped\", \"realtime\" or \"xN\")";
            return false;
        }
    }

    // stopAt: { frame, gameOver, luaCondition }
    if (h.contains("stopAt")) {
        if (!h["stopAt"].is_object()) {
            err = "headless-run config: `stopAt` is not an object";
            return false;
        }
        const json& sa = h["stopAt"];
        if (sa.contains("frame") && sa["frame"].is_number()) {
            const int64_t f = sa["frame"].get<int64_t>();
            if (f > 0)
                out.stopAt.frame = f;
        }
        if (sa.contains("gameOver"))
            out.stopAt.gameOver = sa.value("gameOver", false);
        if (sa.contains("luaCondition") && sa["luaCondition"].is_string()) {
            const std::string lc = sa["luaCondition"].get<std::string>();
            if (!lc.empty())
                out.stopAt.luaCondition = lc;
        }
    }

    out.stateHashEvery = h.value("stateHashEvery", 0);
    out.statsDump = h.value("statsDump", std::string());
    return true;
}

bool ParseConfigFile(const std::string& path, Config& out, std::string& err) {
    std::ifstream f(path);
    if (!f) {
        err = "cannot open headless-run config: " + path;
        return false;
    }
    std::stringstream ss;
    ss << f.rdbuf();
    return ParseConfig(ss.str(), out, err);
}

}  // namespace headless
