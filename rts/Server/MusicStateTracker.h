// MusicStateTracker — combat-intensity → music-state state machine.
//
// PLAN-audio.md §"Server-side state machine" — the sim samples this
// every tick after combat events have been drained for the frame's
// batch. State transitions emit a MusicEvent on the next
// GameEventBatch which the client picks up to crossfade tracks.
//
// State transitions:
//   peace   — default at game start; entered after 30 s of zero combat events
//   tension — ≥ 1 combat event in the last 5 s, below battle threshold
//   battle  — > 5 combat events / sec sustained for 3 s, OR a
//             designated "high-stakes" event (gadget-flagged via
//             ForceMusicState)
//   victory — GameOver fires for the winning ally team (set externally
//             via ForceMusicState(MusicStateBattle::Victory))
//   defeat  — GameOver fires for any non-winning ally team (same)
//
// Sampling: the tracker accepts a per-tick event count via Tick(n).
// It keeps a circular buffer of the last 30 s of per-tick counts and
// re-derives the current state from totals over the relevant windows.
// Both 5-s and 3-s windows use the same buffer.
//
// All in elapsed game frames (GAME_SPEED = 30/s), so 5 s = 150 frames,
// 3 s = 90 frames, 30 s = 900 frames.
#pragma once

#include <array>
#include <cstdint>
#include <mutex>

enum class MusicStateValue : uint8_t {
    Peace = 0,
    Tension = 1,
    Battle = 2,
    Victory = 3,
    Defeat = 4,
};

class MusicStateTracker {
public:
    /// Record the per-tick combat-event count. Called once per sim
    /// frame after CombatEventCollector has been drained.
    void Tick(uint32_t eventsThisTick) {
        std::lock_guard<std::mutex> lock(mutex);
        if (forcedActive) {
            // Locked into victory / defeat / explicit battle — the
            // event-count buffer keeps filling but doesn't drive state.
            advanceBuffer(eventsThisTick);
            return;
        }
        advanceBuffer(eventsThisTick);

        // Sum windows.
        const uint32_t sum5s  = sumOverFrames(WINDOW_5S);
        const uint32_t sum3s  = sumOverFrames(WINDOW_3S);
        const uint32_t sum30s = sumOverFrames(WINDOW_30S);

        // Sustained battle: > 5 events/sec for 3 s straight ≈ > 15
        // events over the last 90 frames.
        const bool battleHot = sum3s > BATTLE_SUSTAINED_THRESHOLD;
        const bool tensionHot = sum5s > 0;

        MusicStateValue next = currentState;
        if (battleHot) {
            next = MusicStateValue::Battle;
        } else if (tensionHot) {
            next = MusicStateValue::Tension;
        } else if (sum30s == 0) {
            next = MusicStateValue::Peace;
        }
        // Otherwise: stay in current state (debounce — don't drop
        // from battle back to tension on the first quiet tick).

        if (next != currentState) {
            currentState = next;
            pendingTransition = true;
        }
    }

    /// Force a specific state (e.g. on GameOver). Locks the tracker
    /// until ResetForced() is called, so victory / defeat aren't
    /// overwritten by an immediate `peace` derivation on the next tick.
    void ForceState(MusicStateValue state, bool sticky) {
        std::lock_guard<std::mutex> lock(mutex);
        if (state != currentState) {
            currentState = state;
            pendingTransition = true;
        }
        forcedActive = sticky;
    }

    /// Release a sticky force (rare — game restarts).
    void ResetForced() {
        std::lock_guard<std::mutex> lock(mutex);
        forcedActive = false;
    }

    /// Drain a pending transition. Returns true exactly once after
    /// each state change; subsequent calls return false until the
    /// state changes again. `outState` is the new state.
    bool DrainTransition(MusicStateValue& outState, uint16_t& outFadeMs) {
        std::lock_guard<std::mutex> lock(mutex);
        if (!pendingTransition) return false;
        pendingTransition = false;
        outState = currentState;
        // Snappier crossfade for the end-of-game stings; smoother
        // 2-second blend for in-game shifts.
        outFadeMs = (currentState == MusicStateValue::Victory ||
                     currentState == MusicStateValue::Defeat)
            ? 500 : 2000;
        return true;
    }

    MusicStateValue Current() const {
        std::lock_guard<std::mutex> lock(mutex);
        return currentState;
    }

private:
    static constexpr int WINDOW_30S = 900;
    static constexpr int WINDOW_5S  = 150;
    static constexpr int WINDOW_3S  = 90;
    /// Threshold for "battle" sustained over 3 s: > 5 events/sec means
    /// > 15 events accumulated in the last 90 frames.
    static constexpr uint32_t BATTLE_SUSTAINED_THRESHOLD = 15;

    void advanceBuffer(uint32_t eventsThisTick) {
        head = (head + 1) % WINDOW_30S;
        buffer[head] = eventsThisTick;
    }

    uint32_t sumOverFrames(int n) const {
        uint32_t s = 0;
        int idx = head;
        for (int i = 0; i < n; ++i) {
            s += buffer[idx];
            idx = (idx == 0) ? (WINDOW_30S - 1) : (idx - 1);
        }
        return s;
    }

    mutable std::mutex mutex;
    std::array<uint32_t, WINDOW_30S> buffer{};
    int head = 0;
    MusicStateValue currentState = MusicStateValue::Peace;
    bool pendingTransition = true;  // emit initial Peace on first batch
    bool forcedActive = false;
};

extern MusicStateTracker musicState;
