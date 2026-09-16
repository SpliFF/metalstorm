// SimStep — the frame budget behind the `sim_step N` exec verb.
//
// WHY THIS EXISTS. Pausing the sim (`gs->paused`) freezes the world, which is
// what you want for a screenshot and exactly wrong for filming a MANOEUVRE: a
// tank's turn arc, a turret slew, a walk cycle mid-stride only exist while the
// thing is moving. Slow motion (`speed 0.1`) helps but does not remove the
// race — the sim still advances by an unknown amount across a multi-second
// relay round trip, so consecutive shots are not a controlled interval apart.
//
// Single-stepping removes the race entirely: from a stop, grant exactly N
// frames, let the tick loop spend them, and stop again. Between two shots the
// world advances by the number of frames the caller asked for and by nothing
// else, however long the camera took. That is what makes step → capture →
// step → capture a FILM rather than a set of unrelated poses.
//
// Mechanics. `server_main.cpp`'s SimFrame gate reads this budget as the one
// exception to the pause gate:
//
//     if (started && !debuggerPaused && !gameOver && (!gs->paused || Consume()))
//
// so `Consume()` is only reached while paused and decrements once per tick
// that actually runs. Both `pause` and `unpause` clear the budget: a grant is
// a statement about the stop it was issued from, and letting one survive a
// manual resume would make a much later pause silently leak extra frames.
//
// Not in `gs` on purpose. CGlobalSynced is CR_MEMBER-serialized and part of
// the sync/replay surface; a debug-only frame budget belongs nowhere near it.
// Writes come from the LuaExec thunk (which runs inside the tick), reads from
// the tick itself, so the atomic is belt-and-braces rather than load-bearing.
#pragma once

#include <algorithm>
#include <atomic>

namespace simstep {

/// Ceiling on a single grant: 100 game-seconds. A step is a *controlled*
/// advance — a caller who wants minutes of sim wants `unpause`, and a fat
/// finger on the frame count should not silently un-freeze the world for a
/// quarter of an hour.
inline constexpr int kMaxStepFrames = 3000;

/// The live budget. A function-local static so the header needs no .cpp and
/// no CMake edit (the Server glob is evaluated at configure time).
inline std::atomic<int>& Budget() {
    static std::atomic<int> budget{0};
    return budget;
}

/// Frames still owed to the current grant.
inline int Pending() { return Budget().load(std::memory_order_relaxed); }

/// Drop any outstanding grant. Called on `pause` and `unpause`.
inline void Clear() { Budget().store(0, std::memory_order_relaxed); }

/// Replace the budget with `frames` (clamped to [0, kMaxStepFrames]).
/// REPLACES rather than accumulates: two `sim_step 5` calls in flight mean
/// the caller lost track, and 10 frames is never the answer they wanted.
/// Returns what was actually granted.
inline int Grant(int frames) {
    const int n = std::clamp(frames, 0, kMaxStepFrames);
    Budget().store(n, std::memory_order_relaxed);
    return n;
}

/// Spend one frame. True when this tick may run the sim.
inline bool Consume() {
    int cur = Budget().load(std::memory_order_relaxed);
    while (cur > 0) {
        if (Budget().compare_exchange_weak(cur, cur - 1,
                                           std::memory_order_relaxed)) {
            return true;
        }
    }
    return false;
}

} // namespace simstep
