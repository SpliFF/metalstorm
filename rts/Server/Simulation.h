/**
 * CSimulation — wraps Spring's simulation loop for the headless server.
 *
 * Extracted from the old CGame::SimFrame() (deleted in Phase 0).
 * Initialises all the global subsystems that the sim depends on,
 * then ticks them in the correct order each frame.
 *
 * This class owns no state itself — the subsystems are all globals
 * (unitHandler, projectileHandler, etc.). CSimulation just orchestrates
 * their Init/Update/Kill lifecycle.
 */
#pragma once

class CSimulation {
public:
    /// Initialise all sim subsystems. Must be called before SimFrame().
    void Init();

    /// Shut down all sim subsystems.
    void Kill();

    /// Run one deterministic simulation tick.
    /// Call this at GAME_SPEED Hz (30 Hz).
    void SimFrame();

    /// Current sim frame number (-1 before first tick, 0+ after).
    int GetFrameNum() const;

    /// Whether the sim has been initialised.
    bool IsRunning() const { return running; }

private:
    bool running = false;
};
