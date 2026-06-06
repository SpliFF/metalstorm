// PlayerTeamEventCollector — collects player/team status-change events each
// sim frame for forwarding to the client LuaUI worker.
//
// The server already fires the matching Recoil eventHandler callins
// (PlayerChanged / PlayerRemoved / TeamDied) into its own *synced* Lua
// (LuaRules/LuaGaia). But the unsynced LuaUI lives in the browser worker, on
// the far side of the network, so it never sees those callins. Each relevant
// sim event also pushes a PlayerTeamEventData here; the main loop drains the
// queue every tick and broadcasts it reliably as a PlayerTeamEventBatch
// FlatBuffer, which the widget worker fans out to
// widget:PlayerChanged / PlayerAdded / PlayerRemoved / TeamDied.
//
// No per-session LOS filtering: player/team identity and life/death are public
// information in Spring (the scoreboard shows every player and which teams are
// dead). Reliable, low-frequency — these are discrete events, never per-frame.
#pragma once

#include <cstdint>
#include <mutex>
#include <vector>

// Mirrors PlayerTeamEventItem in protocol.fbs. `kind` selects the LuaUI callin.
struct PlayerTeamEventData {
    enum Kind : uint8_t {
        PlayerChanged = 0,
        PlayerAdded   = 1,
        PlayerRemoved = 2,
        TeamDied      = 3,
    };
    uint8_t  kind   = PlayerChanged;
    uint8_t  reason = 0;  // PlayerRemoved reason; 0 otherwise
    uint32_t id     = 0;  // playerID (kinds 0-2) or teamID (kind 3)
};

class PlayerTeamEventCollector {
public:
    void Push(const PlayerTeamEventData& event) {
        std::lock_guard<std::mutex> lock(mutex);
        events.push_back(event);
    }

    std::vector<PlayerTeamEventData> Drain() {
        std::lock_guard<std::mutex> lock(mutex);
        std::vector<PlayerTeamEventData> drained;
        drained.swap(events);
        return drained;
    }

    size_t Size() const {
        std::lock_guard<std::mutex> lock(mutex);
        return events.size();
    }

private:
    mutable std::mutex mutex;
    std::vector<PlayerTeamEventData> events;
};

extern PlayerTeamEventCollector playerTeamEvents;
