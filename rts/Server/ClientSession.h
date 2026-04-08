/**
 * ClientSession — tracks authenticated client state.
 *
 * Maps network ClientIDs to authenticated players with their
 * permissions and team assignments.
 */
#pragma once

#include <cstdint>
#include <mutex>
#include <string>
#include <unordered_map>

using ClientID = uint32_t;

struct ClientSession {
    ClientID clientId = 0;
    int64_t userId = 0;
    std::string username;
    std::string role;           // "admin", "player", "spectator"
    int team = -1;              // -1 = unassigned
    uint32_t lastCommandSeq = 0;
    int commandsThisTick = 0;
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

    /// Max commands per client per tick.
    static constexpr int MAX_COMMANDS_PER_TICK = 10;

private:
    std::mutex mutex;
    std::unordered_map<ClientID, ClientSession> sessions;
};
