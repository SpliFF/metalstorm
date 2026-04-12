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
#include <vector>

class LuaParser;
class LuaScriptContext;
class ScriptEventDispatcher;

/// One entry in the game-start roster. Both human players and AI
/// slots feed the same struct — CSimulation doesn't care which is
/// which, it just needs to know what teams exist and where each one
/// spawns. The handoff from spring-server::main fills the vector
/// from its --player and --ai CLI args.
struct RosterEntry {
    int team = 0;        // sim team id
    int startPosIdx = -1;  // index into the map's teams[] array; -1 = auto
};

class CSimulation {
public:
    CSimulation();
    ~CSimulation() noexcept;

    /// Install the game-start roster. Called by spring-server::main
    /// after parsing --player / --ai args, before Init(). Passing an
    /// empty vector keeps the legacy 2-team dev fallback path.
    void SetRoster(std::vector<RosterEntry> roster) { rosterEntries = std::move(roster); }

    /// Initialise all sim subsystems. Must be called before SimFrame().
    /// mapName is the path to the .smf file (empty = no map).
    /// After Init(), the sim is ready but GameStart has NOT fired.
    /// Call FireGameStart() once all players have connected.
    void Init(const std::string& mapName = "");

    /// Fire the GameStart event into Lua and begin the game.
    /// Must be called after Init() and after all players are
    /// registered with playerHandler. Gadgets that spawn starting
    /// units (e.g. start_unit_setup.lua) run during this call.
    void FireGameStart();

    /// True after Init(), false after FireGameStart().
    bool IsWaitingForPlayers() const { return scriptingLoaded && !gameStarted; }

    /// True after FireGameStart() has run.
    bool HasGameStarted() const { return gameStarted; }

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
    void InitScripting();

    bool running = false;
    bool defsLoaded = false;
    bool mapLoaded = false;
    bool scriptingLoaded = false;
    bool gameStarted = false;
    std::unique_ptr<LuaParser> defsParser;

    /// Game-start roster installed via SetRoster() before Init().
    /// Empty = legacy dev fallback (SetupTestGame spawns 2 hardcoded
    /// teams at the map centre). Non-empty = one spawn per entry at
    /// the map's corresponding start position.
    std::vector<RosterEntry> rosterEntries;
};
