/**
 * ClientSession — tracks authenticated client state.
 *
 * Maps network ClientIDs to authenticated players with their
 * permissions and team assignments.
 */
#pragma once

#include "EntityDeltaCache.h"

#include <cstdint>
#include <array>
#include <mutex>
#include <string>
#include <unordered_map>
#include <unordered_set>

using ClientID = uint32_t;

/// A rectangular viewport in world space (XZ plane).
struct Viewport {
    float centerX = 0.0f;
    float centerZ = 0.0f;
    float width   = 0.0f;
    float height  = 0.0f;
    float rotation = 0.0f;     // radians around Y axis
    float zoomLevel = 1.0f;
    bool active = false;
};

/// Maximum number of viewports per client (main + minimap + PiP).
static constexpr int MAX_VIEWPORTS = 4;

struct ClientSession {
    ClientID clientId = 0;
    int64_t userId = 0;
    std::string username;
    std::string role;           // "admin", "player", "spectator"
    int team = -1;              // -1 = unassigned
    uint32_t lastCommandSeq = 0;
    int commandsThisTick = 0;

    /// Per-client viewports (indexed by viewport_id).
    std::array<Viewport, MAX_VIEWPORTS> viewports{};

    /// Delta compression cache — tracks last-sent entity state.
    EntityDeltaCache deltaCache;

    /// Last known frame for reconnection state recovery.
    int lastKnownFrame = -1;

    /// Whether this session is disconnected but eligible for reconnection.
    bool disconnected = false;

    /// Whether this client has any active viewport.
    bool HasViewport() const {
        for (const auto& vp : viewports)
            if (vp.active) return true;
        return false;
    }

    /// Unit def IDs this client has been sent. The server checks this
    /// before streaming entity state — if an entity's defId is not in
    /// the set, the server sends the def first.
    std::unordered_set<uint16_t> knownUnitDefs;

    /// Weapon def IDs this client has been sent. Same pattern —
    /// checked before streaming projectile state.
    std::unordered_set<uint16_t> knownWeaponDefs;
};

class SessionManager {
public:
    /// Register an authenticated client.
    void AddSession(ClientID clientId, int64_t userId,
                    const std::string& username, const std::string& role) {
        std::lock_guard<std::mutex> lock(mutex);
        sessions[clientId] = {clientId, userId, username, role, -1, 0, 0};
    }

    /// Remove a client session (on disconnect).
    void RemoveSession(ClientID clientId) {
        std::lock_guard<std::mutex> lock(mutex);
        sessions.erase(clientId);
    }

    /// Get a session by client ID. Returns nullptr if not authenticated.
    ClientSession* GetSession(ClientID clientId) {
        std::lock_guard<std::mutex> lock(mutex);
        auto it = sessions.find(clientId);
        return (it != sessions.end()) ? &it->second : nullptr;
    }

    /// Check if a client is authenticated.
    bool IsAuthenticated(ClientID clientId) {
        std::lock_guard<std::mutex> lock(mutex);
        return sessions.count(clientId) > 0;
    }

    /// Reset per-tick rate limiting counters.
    void ResetTickCounters() {
        std::lock_guard<std::mutex> lock(mutex);
        for (auto& [id, session] : sessions) {
            session.commandsThisTick = 0;
        }
    }

    /// Iterate all sessions under lock. Callback receives (ClientID, ClientSession&).
    template<typename Fn>
    void ForEachSession(Fn&& fn) {
        std::lock_guard<std::mutex> lock(mutex);
        for (auto& [id, session] : sessions) {
            fn(id, session);
        }
    }

    /// Max commands per client per tick.
    static constexpr int MAX_COMMANDS_PER_TICK = 10;

private:
    std::mutex mutex;
    std::unordered_map<ClientID, ClientSession> sessions;
};
