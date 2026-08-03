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
// PLAN-latency L3 adds two more, which supersede Trajectory for Tier-S
// projectiles once `LatencyTierSKeyframes` is on:
//   - TrajectoryKeyframe: a frame-stamped knot on the flight path. The client
//     splines through them instead of integrating between corrections.
//   - OutcomeKnown: the resolved outcome WITH the frame it resolves on, so the
//     explosion can be scheduled on the L1 presentation timeline instead of
//     playing whenever the packet lands.
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
    /// PLAN-latency L3.3 — the client starts a keyframe track from this event.
    /// See schemas/protocol.fbs `ProjectileFiredEvent.keyframed`.
    bool     keyframed = false;
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

/// PLAN-latency L2.1 — a Tier-C ("cosmetic") shot, resolved whole at fire
/// time. Replaces the Fired/Trajectory/Impact triple for weaponDefs
/// classified FX_TIER_COSMETIC; the two streams never both describe the
/// same shot. See `rts/Sim/Weapons/CosmeticFire.h` for the resolver and
/// schemas/protocol.fbs `FireOutcomeEvent` for the wire contract.
struct FireOutcomeEventData {
    uint32_t fireFrame;
    uint16_t weaponDefId;
    uint32_t ownerId;
    uint8_t  team;              // owner-team — used by per-session LOS filter
    float3   origin;
    uint32_t targetId;          // tracked unit, 0 for ground/feature
    float3   targetPos;         // the weapon's lead-corrected aim point
    uint8_t  outcome;           // matches schemas FireOutcome
    uint32_t impactFrame;
    float3   impactPos;
    float    gravity;           // per-frame gravity used to solve the arc
};

/// PLAN-latency L3 — one knot on a Tier-S projectile's flight path.
/// See `rts/Sim/Projectiles/TrajectoryKeyframes.h` for the emission policy
/// and schemas/protocol.fbs `TrajectoryKeyframe` for the wire contract.
struct TrajectoryKeyframeData {
    uint32_t projId;
    uint32_t frame;             // sim frame this knot is stamped at
    float3   pos;
    float3   vel;
    uint8_t  kind;              // matches schemas TrajectoryKeyframeKind
    uint8_t  team;              // owner-team — used by per-session LOS filter
};

/// PLAN-latency L3 — a Tier-S projectile's outcome, stamped with the frame
/// it resolves on so the client can schedule the FX rather than react to it.
struct OutcomeKnownEventData {
    uint32_t projId;
    uint8_t  outcome;           // matches schemas ProjectileImpactKind
    uint32_t outcomeFrame;
    float3   outcomePos;
    uint32_t targetId;          // hit unit/feature/shield-host (0 for terrain)
    uint8_t  team;              // owner-team — used by per-session LOS filter
    uint16_t weaponDefId;
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
    void PushFireOutcome(const FireOutcomeEventData& e) {
        std::lock_guard<std::mutex> lock(mutex);
        fireOutcomes.push_back(e);
    }
    void PushKeyframe(const TrajectoryKeyframeData& e) {
        std::lock_guard<std::mutex> lock(mutex);
        keyframes.push_back(e);
    }
    void PushOutcomeKnown(const OutcomeKnownEventData& e) {
        std::lock_guard<std::mutex> lock(mutex);
        outcomesKnown.push_back(e);
    }

    struct DrainResult {
        std::vector<ProjectileFiredEventData> fired;
        std::vector<ProjectileImpactEventData> impacts;
        std::vector<ProjectileTrajectoryEventData> trajectories;
        std::vector<FireOutcomeEventData> fireOutcomes;
        std::vector<TrajectoryKeyframeData> keyframes;
        std::vector<OutcomeKnownEventData> outcomesKnown;
    };

    DrainResult Drain() {
        std::lock_guard<std::mutex> lock(mutex);
        DrainResult out;
        out.fired.swap(fired);
        out.impacts.swap(impacts);
        out.trajectories.swap(trajectories);
        out.fireOutcomes.swap(fireOutcomes);
        out.keyframes.swap(keyframes);
        out.outcomesKnown.swap(outcomesKnown);
        return out;
    }

    size_t PendingCount() const {
        std::lock_guard<std::mutex> lock(mutex);
        return fired.size() + impacts.size() + trajectories.size() + fireOutcomes.size()
             + keyframes.size() + outcomesKnown.size();
    }

private:
    mutable std::mutex mutex;
    std::vector<ProjectileFiredEventData> fired;
    std::vector<ProjectileImpactEventData> impacts;
    std::vector<ProjectileTrajectoryEventData> trajectories;
    std::vector<FireOutcomeEventData> fireOutcomes;
    std::vector<TrajectoryKeyframeData> keyframes;
    std::vector<OutcomeKnownEventData> outcomesKnown;
};

/// Global instance — referenced from CWeaponProjectile lifecycle hooks.
extern ProjectileEventCollector projectileEvents;
