// UnitCommandCollector — captures synced UnitCommand / UnitCmdDone
// callins fired by CCommandAI as commands are added to / completed from
// a unit's queue. The sim loop drains the collector each tick and
// per-session forwards events the viewer's ally team is allowed to see
// (own team + alliance).
//
// Why both Issued and Done in one collector: they share the same
// argument shape (unit, command, options, tag) and most ZK widgets
// consume them in pairs (track the command from issue to completion).
// Keeping them in one queue preserves emission order without forcing
// the worker to interleave two streams.
#pragma once

#include "System/EventClient.h"

#include <cstdint>
#include <mutex>
#include <vector>

class Command;

enum class UnitCommandKind : uint8_t {
    Issued = 0,
    Done   = 1,
};

struct UnitCommandEventData {
    UnitCommandKind kind;
    uint32_t unitId;
    uint16_t unitDefId;
    uint8_t  unitTeam;
    int32_t  cmdId;
    std::vector<float> params;
    uint8_t  options;
    uint32_t tag;
    /// Spring's `playerNum`. `-1` for system / Lua / AI issued commands.
    /// Only set on Issued events; Done events leave this at -1.
    int16_t  playerId;
    bool     fromSynced;
    bool     fromLua;
};

class UnitCommandCollector : public CEventClient {
public:
    UnitCommandCollector();
    ~UnitCommandCollector() override = default;

    /// Register with the engine's EventHandler. Must be called after
    /// `eventHandler` is constructed. Subscribes explicitly — see the
    /// implementation for why AddClient alone is not enough.
    void Register();

    /// Consulted by `eventHandler.AddClient`; the base returns false, which
    /// silently unsubscribes this collector from everything.
    bool WantsEvent(const std::string& eventName) override;

    /// Drain events collected since the last call. Thread-safe.
    std::vector<UnitCommandEventData> Drain();

    /// CEventClient overrides ----------------------------------------
    bool GetFullRead() const override { return true; }
    int  GetReadAllyTeam() const override { return AllAccessTeam; }

    void UnitCommand(const CUnit* unit, const Command& command,
                     int playerNum, bool fromSynced, bool fromLua) override;
    void UnitCmdDone(const CUnit* unit, const Command& command) override;

private:
    mutable std::mutex mutex;
    std::vector<UnitCommandEventData> events;
};

/// Global collector. Lifetime: constructed in server boot, destroyed
/// at shutdown. Pointer rather than value so registration order can be
/// controlled alongside the other server singletons.
extern UnitCommandCollector* unitCommandEvents;
