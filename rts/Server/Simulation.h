/**
 * CSimulation — wraps Spring's simulation loop for the headless server.
 *
 * Extracted from the old CGame::SimFrame() (deleted in Phase 0).
 * Initialises all the global subsystems that the sim depends on,
 * then ticks them in the correct order each frame.
 */
#pragma once

#include <memory>
#include <string>

class LuaParser;

class CSimulation {
public:
    CSimulation();
    ~CSimulation() noexcept;

    /// Initialise all sim subsystems. Must be called before SimFrame().
    /// mapName is the path to the .smf file (empty = no map).
    void Init(const std::string& mapName = "");

    /// Shut down all sim subsystems.
    void Kill();

    /// Run one deterministic simulation tick.
    void SimFrame();

    /// Current sim frame number (-1 before first tick, 0+ after).
    int GetFrameNum() const;

    bool IsRunning() const { return running; }
    bool HasDefs() const { return defsLoaded; }
    bool HasMap() const { return mapLoaded; }

private:
    bool LoadDefs();
    bool LoadMap(const std::string& mapName);
    void InitSubsystems(bool hasMap);
    void SetupTestGame();

    bool running = false;
    bool defsLoaded = false;
    bool mapLoaded = false;
    std::unique_ptr<LuaParser> defsParser;
};
