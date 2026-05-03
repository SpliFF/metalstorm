/**
 * EntityDeltaCache — per-client cache of last-sent entity state.
 *
 * Tracks the most recent values sent to each client so that delta
 * updates only include entities whose state has actually changed.
 * Uses thresholds to avoid sending tiny floating-point jitter.
 */
#pragma once

#include <cstdint>
#include <cmath>
#include <unordered_map>
#include <vector>

class CUnit;

struct CachedEntityState {
    float posX = 0.0f;
    float posY = 0.0f;
    float posZ = 0.0f;
    uint16_t heading = 0;
    uint16_t health = 0;
    uint16_t defId = 0;
    uint8_t team = 0;
    /// Spring losStatus byte for the viewer's ally team. Cached so a
    /// transition between radar-only and full LOS triggers a delta send
    /// even if position/health didn't move.
    uint8_t losState = 0;
    /// Build progress as serialised (0-255). Drives the client's
    /// nanoframe shader; ticks slowly during construction so the delta
    /// path only fires every ~1% of progress for typical structures.
    uint8_t buildProgress = 0;
};

class EntityDeltaCache {
public:
    /// Position change threshold (in elmos). Below this, position is
    /// considered unchanged. Prevents sending micro-jitter.
    static constexpr float POS_THRESHOLD = 0.5f;

    /// Check if a unit's state has changed since last send.
    /// `viewerAllyTeam` is consulted for the LOS-state comparison; pass
    /// -1 to skip that check (legacy permissive sessions / spectators).
    bool HasChanged(const CUnit* unit, int viewerAllyTeam = -1) const;

    /// Update the cache with the unit's current state.
    void Update(const CUnit* unit, int viewerAllyTeam = -1);

    /// Remove an entity from the cache (on death/removal).
    void Remove(uint32_t entityId) { cache.erase(entityId); }

    /// Clear the entire cache (on reconnect or full snapshot).
    void Clear() { cache.clear(); }

    /// Get the set of entity IDs that were cached but are no longer
    /// in the given live set. These are entities that left the view
    /// or were destroyed. Populates `removed` and clears those entries.
    void FindRemoved(const std::vector<CUnit*>& liveUnits,
                     std::vector<uint32_t>& removed);

private:
    std::unordered_map<uint32_t, CachedEntityState> cache;
};
