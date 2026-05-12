/**
 * ClientSession — tracks authenticated client state.
 *
 * Maps network ClientIDs to authenticated players with their
 * permissions and team assignments.
 */
#pragma once

#include "EntityDeltaCache.h"

#include <chrono>
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

    /// Token-bucket rate limiting. Two buckets gate inbound commands:
    ///   - cmdMessageTokens: each PlayerCommand / PlayerCommandBatch
    ///     consumes 1. Refill rate `MSG_RATE_PER_SEC`, burst cap
    ///     `MSG_BURST_CAP`. Caps inbound message frequency regardless
    ///     of squad list size.
    ///   - cmdOrderTokens: each command consumes `squad_ids.size()`
    ///     (sum across batch entries). Refill rate `ORDER_RATE_PER_SEC`,
    ///     burst cap `ORDER_BURST_CAP`. Caps total per-unit orders so a
    ///     single message addressing 10K squads can't bypass the rate
    ///     limit by virtue of being one message.
    /// Both buckets start full and refill linearly using wall-clock
    /// time. `lastBucketUpdate` is the std::steady_clock point of the
    /// last refill calculation. Reject when either bucket would go
    /// negative — partial commands aren't a thing in our protocol.
    float cmdMessageTokens = 0.0f;
    float cmdOrderTokens   = 0.0f;
    std::chrono::steady_clock::time_point lastBucketUpdate{};
    /// Drop counter for telemetry (commands rejected by the limiter
    /// since session start). Cheap monotonic int; not surfaced over
    /// the wire today but logged on every drop.
    uint32_t rateLimitDrops = 0;

    /// Per-client viewports (indexed by viewport_id).
    std::array<Viewport, MAX_VIEWPORTS> viewports{};

    /// Most recent SelectionState received from the client. Scopes the
    /// per-unit cmd-desc broadcast so the server doesn't re-serialise
    /// every own-team unit's command panel each tick — only the units
    /// the player has selected. Empty set is interpreted as "no
    /// selection set yet" → fall back to streaming every own-team unit
    /// (degraded but functional for older clients).
    std::unordered_set<uint32_t> selectedUnits;
    uint32_t lastSelectionSeq = 0;

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

    // (Def-streaming bookkeeping removed — defs are delivered eagerly
    // via HTTP at game start; see DefsCache and AuthResponse.defs_cache_key.)
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

    /// Iterate all sessions under lock. Callback receives (ClientID, ClientSession&).
    template<typename Fn>
    void ForEachSession(Fn&& fn) {
        std::lock_guard<std::mutex> lock(mutex);
        for (auto& [id, session] : sessions) {
            fn(id, session);
        }
    }

    /// Token-bucket parameters. Tuned for legitimate play (drag-build
    /// rows, formation orders, rapid waypoint chaining) without
    /// allowing flood attacks from a misbehaving or malicious client.
    /// Per PLAN-orders.md: ~50 messages/sec, ~200 squad orders/sec.
    static constexpr float MSG_RATE_PER_SEC    = 50.0f;
    static constexpr float MSG_BURST_CAP       = 100.0f;
    static constexpr float ORDER_RATE_PER_SEC  = 200.0f;
    static constexpr float ORDER_BURST_CAP     = 400.0f;

    /// Refill both token buckets based on elapsed wall-clock time and
    /// consume the requested amounts. Returns true if both buckets had
    /// enough tokens (command admitted), false otherwise (drop the
    /// command and increment `rateLimitDrops`). Caller holds no lock —
    /// buckets are owned by the calling session.
    static bool TryConsumeCommandBudget(ClientSession& session,
                                        int squadOrderCount) {
        const auto now = std::chrono::steady_clock::now();
        if (session.lastBucketUpdate.time_since_epoch().count() == 0) {
            // First-time init: buckets start at burst cap so the first
            // few commands always go through even before any refill
            // delta has accumulated.
            session.cmdMessageTokens = MSG_BURST_CAP;
            session.cmdOrderTokens   = ORDER_BURST_CAP;
            session.lastBucketUpdate = now;
        } else {
            const auto elapsedSec = std::chrono::duration<float>(
                now - session.lastBucketUpdate).count();
            session.cmdMessageTokens = std::min(
                MSG_BURST_CAP,
                session.cmdMessageTokens + elapsedSec * MSG_RATE_PER_SEC);
            session.cmdOrderTokens = std::min(
                ORDER_BURST_CAP,
                session.cmdOrderTokens + elapsedSec * ORDER_RATE_PER_SEC);
            session.lastBucketUpdate = now;
        }
        // A command with no squad targets (no-op) shouldn't drain the
        // order budget — but it still costs one message slot.
        const float needOrders = static_cast<float>(std::max(0, squadOrderCount));
        if (session.cmdMessageTokens < 1.0f || session.cmdOrderTokens < needOrders) {
            session.rateLimitDrops++;
            return false;
        }
        session.cmdMessageTokens -= 1.0f;
        session.cmdOrderTokens   -= needOrders;
        return true;
    }

private:
    std::mutex mutex;
    std::unordered_map<ClientID, ClientSession> sessions;
};
