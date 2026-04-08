/**
 * CSimulation — wraps Spring's simulation loop for the headless server.
 *
 * Extracted from the old CGame::SimFrame() (deleted in Phase 0).
 * Initialises all the global subsystems that the sim depends on,
 * then ticks them in the correct order each frame.
 */
#pragma once

#include <memory>

class LuaParser;

class CSimulation {
public:
    CSimulation();
    ~CSimulation() noexcept;

    /// Initialise all sim subsystems. Must be called before SimFrame().
    void Init();

    /// Shut down all sim subsystems.
    void Kill();

    /// Run one deterministic simulation tick.
    void SimFrame();

    /// Current sim frame number (-1 before first tick, 0+ after).
    int GetFrameNum() const;

    bool IsRunning() const { return running; }
    bool HasDefs() const { return defsLoaded; }

private:
    /// Parse gamedata/defs.lua via LuaParser. Returns false if not found.
    bool LoadDefs();

    /// Initialise sim handlers from parsed defs.
    void InitSubsystems();

    bool running = false;
    bool defsLoaded = false;
    std::unique_ptr<LuaParser> defsParser;
};
