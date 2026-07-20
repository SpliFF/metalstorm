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

/// Spectator visibility modes (PLAN-lobby.md spectator section).
enum class SpectatorVisibilityMode : uint8_t {
    Global = 0,  // See everything (default for spectators)
    Team = 1     // See one team's fog-of-war
};

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

    /// Spectator visibility mode. Only meaningful when role == "spectator".
    /// Global (default): see everything, no fog-of-war.
    /// Team: see one team's LOS (spectatorVisibilityTeam).
    SpectatorVisibilityMode spectatorVisibilityMode = SpectatorVisibilityMode::Global;
    /// When spectatorVisibilityMode == Team, which team's LOS to use.
    /// Ignored when mode == Global.
    int spectatorVisibilityTeam = -1;

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

    /// PLAN-security-hardening task 4 (G6/G16): LuaRulesMsg + LuaUIMsg
    /// relay token bucket. One shared bucket for both — they're both
    /// "arbitrary payload broadcast to N peers", not orders. Same
    /// lazy-refill-on-use pattern as the command buckets above.
    float luaMsgTokens = 0.0f;
    std::chrono::steady_clock::time_point lastLuaMsgBucketUpdate{};
    uint32_t luaMsgRateLimitDrops = 0;

    /// PLAN-security-hardening task 4 (G13): PathRequest token bucket.
    /// Each request is a synchronous sim-thread pathfind — a much heavier
    /// per-token cost than a message, hence its own (lower) budget.
    float pathReqTokens = 0.0f;
    std::chrono::steady_clock::time_point lastPathReqBucketUpdate{};
    uint32_t pathReqRateLimitDrops = 0;

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
        ClientSession session;
        session.clientId = clientId;
        session.userId = userId;
        session.username = username;
        session.role = role;
        session.team = -1;
        session.lastCommandSeq = 0;
        // spectatorVisibilityMode and spectatorVisibilityTeam use default initializers
        sessions[clientId] = session;
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

    /// PLAN-security-hardening task 10 (G4): may this session command a unit
    /// belonging to `unitTeam`? The ownership rule is simply "the unit is on
    /// the session's team". The previous PlayerCommand/Batch checks phrased it
    /// as `session.team >= 0 && unit->team != session.team`, which SKIPPED the
    /// team check entirely when `session.team == -1` — so any un-rostered
    /// session (dev smoketest, but also a spectator or an anomalous no-roster
    /// connection) could command every unit on every team. This centralises
    /// the decision so both command paths share one rule and it is unit-tested:
    ///
    ///   * A spectator commands nothing, in every build.
    ///   * A rostered session (team >= 0) commands only its own team's units.
    ///   * team == -1 (lobby-less launch) keeps the "command anything" escape
    ///     hatch ONLY in dev builds and ONLY for non-spectators — the
    ///     spring-test harness and manual dev runs launch without a lobby
    ///     roster and rely on it. Under SPRING_PROD it is compiled out, so a
    ///     team == -1 session in a production binary commands nothing (every
    ///     legitimate commander is rostered with team >= 0 by the lobby).
    static bool CanCommandTeam(const ClientSession& session, int unitTeam) {
        if (session.role == "spectator")
            return false;
        if (session.team >= 0)
            return unitTeam == session.team;
#ifndef SPRING_PROD
        // team == -1, non-spectator, dev build → lobby-less smoketest bypass.
        return true;
#else
        return false;
#endif
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

    /// LuaRulesMsg/LuaUIMsg relay budget (G6/G16). Generous relative to the
    /// command buckets — legitimate widgets (parley/chat/HUD sync) chat
    /// fairly often — but bounded so a malicious/buggy client can't flood
    /// the relay fan-out.
    static constexpr float LUA_MSG_RATE_PER_SEC = 20.0f;
    static constexpr float LUA_MSG_BURST_CAP    = 40.0f;
    /// Per-message payload cap (G6/G16) — independent of the rate limiter,
    /// checked once per message regardless of budget.
    static constexpr size_t LUA_MSG_MAX_BYTES = 16 * 1024;

    static bool TryConsumeLuaMsgBudget(ClientSession& session) {
        const auto now = std::chrono::steady_clock::now();
        if (session.lastLuaMsgBucketUpdate.time_since_epoch().count() == 0) {
            session.luaMsgTokens = LUA_MSG_BURST_CAP;
            session.lastLuaMsgBucketUpdate = now;
        } else {
            const auto elapsedSec = std::chrono::duration<float>(
                now - session.lastLuaMsgBucketUpdate).count();
            session.luaMsgTokens = std::min(
                LUA_MSG_BURST_CAP,
                session.luaMsgTokens + elapsedSec * LUA_MSG_RATE_PER_SEC);
            session.lastLuaMsgBucketUpdate = now;
        }
        if (session.luaMsgTokens < 1.0f) {
            session.luaMsgRateLimitDrops++;
            return false;
        }
        session.luaMsgTokens -= 1.0f;
        return true;
    }

    /// PathRequest budget (G13) — each token gates one synchronous
    /// sim-thread pathfind, so the sustained rate is deliberately much
    /// lower than the message buckets.
    static constexpr float PATH_REQ_RATE_PER_SEC = 10.0f;
    static constexpr float PATH_REQ_BURST_CAP    = 20.0f;

    static bool TryConsumePathRequestBudget(ClientSession& session) {
        const auto now = std::chrono::steady_clock::now();
        if (session.lastPathReqBucketUpdate.time_since_epoch().count() == 0) {
            session.pathReqTokens = PATH_REQ_BURST_CAP;
            session.lastPathReqBucketUpdate = now;
        } else {
            const auto elapsedSec = std::chrono::duration<float>(
                now - session.lastPathReqBucketUpdate).count();
            session.pathReqTokens = std::min(
                PATH_REQ_BURST_CAP,
                session.pathReqTokens + elapsedSec * PATH_REQ_RATE_PER_SEC);
            session.lastPathReqBucketUpdate = now;
        }
        if (session.pathReqTokens < 1.0f) {
            session.pathReqRateLimitDrops++;
            return false;
        }
        session.pathReqTokens -= 1.0f;
        return true;
    }

private:
    std::mutex mutex;
    std::unordered_map<ClientID, ClientSession> sessions;
};
