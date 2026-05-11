// ProjectileEventCollector — buffers projectile lifecycle events each sim
// frame for inclusion in the next GameEventBatch broadcast.
//
// The web protocol no longer streams per-tick projectile state. Instead, the
// server emits three event kinds:
//   - Fired: when a CWeaponProjectile is created. Carries pos/vel/ttl/gravity
//     so the client can simulate motion locally between events.
//   - Impact: when a projectile collides, expires, or is intercepted.
//   - Trajectory: when a projectile bounces, gets steered, or has its motion
//     overridden. The client overwrites its local pos/vel.
//
// The hooks live in CWeaponProjectile (constructor, Collision*, bounce update).
// The simulation thread drains the collector once per tick and the result is
// embedded into the GameEventBatch FlatBuffer for the broadcast.
#pragma once

#include "System/float3.h"
#include <cstdint>
#include <mutex>
#include <vector>

struct ProjectileFiredEventData {
    uint32_t projId;
    uint16_t weaponDefId;
    uint32_t ownerId;
    uint8_t  team;
    float3   pos;
    float3   vel;
    float3   targetPos;
    uint32_t targetId;
    int16_t  ttl;
    float    gravity;
    bool     hitscan;
};

struct ProjectileImpactEventData {
    uint32_t projId;
    float3   pos;
    uint8_t  impactKind;        // matches schemas ProjectileImpactKind
    uint32_t targetId;          // hit unit/feature/shield-host (0 for terrain)
    uint8_t  team;              // owner-team — used by per-session LOS filter
    /// Weapon def for the explosion. Populated for both projectile
    /// impacts and free-floating death/self-destruct explosions where
    /// there is no live projectile entry the client could look up.
    /// 0 means "not set — fall back to projId-keyed lookup."
    uint16_t weaponDefId = 0;
};

struct ProjectileTrajectoryEventData {
    uint32_t projId;
    float3   pos;
    float3   vel;
    uint8_t  reason;            // matches schemas ProjectileTrajectoryReason
    uint8_t  team;              // owner-team — used by per-session LOS filter
};

/// Thread-safe collector for projectile lifecycle events.
class ProjectileEventCollector {
public:
    void PushFired(const ProjectileFiredEventData& e) {
        std::lock_guard<std::mutex> lock(mutex);
        fired.push_back(e);
    }
    void PushImpact(const ProjectileImpactEventData& e) {
        std::lock_guard<std::mutex> lock(mutex);
        impacts.push_back(e);
    }
    void PushTrajectory(const ProjectileTrajectoryEventData& e) {
        std::lock_guard<std::mutex> lock(mutex);
        trajectories.push_back(e);
    }

    struct DrainResult {
        std::vector<ProjectileFiredEventData> fired;
        std::vector<ProjectileImpactEventData> impacts;
        std::vector<ProjectileTrajectoryEventData> trajectories;
    };

    DrainResult Drain() {
        std::lock_guard<std::mutex> lock(mutex);
        DrainResult out;
        out.fired.swap(fired);
        out.impacts.swap(impacts);
        out.trajectories.swap(trajectories);
        return out;
    }

    size_t PendingCount() const {
        std::lock_guard<std::mutex> lock(mutex);
        return fired.size() + impacts.size() + trajectories.size();
    }

private:
    mutable std::mutex mutex;
    std::vector<ProjectileFiredEventData> fired;
    std::vector<ProjectileImpactEventData> impacts;
    std::vector<ProjectileTrajectoryEventData> trajectories;
};

/// Global instance — referenced from CWeaponProjectile lifecycle hooks.
extern ProjectileEventCollector projectileEvents;
