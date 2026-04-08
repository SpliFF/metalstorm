// ScriptEvent — typed event payloads for the scripting abstraction layer.
//
// Events are passed by value (stack-allocated) from the ScriptEventDispatcher
// to IScriptContext instances. They carry entity IDs rather than C++ pointers
// so they can be safely queued for async contexts (AI thread pool).
//
// Control events (Allow*, *PreDamaged) include mutable output fields that
// the script can modify to alter sim behaviour.
#pragma once

#include "System/float3.h"
#include <cstdint>

// Event type IDs — one per CEventClient virtual method.
// Only server-relevant events are included (no Render/Draw/UI events).
namespace ScriptEventType {
    enum : uint16_t {
        GamePreload = 1,
        GameStart,
        GameOver,
        GameFrame,

        TeamDied,
        TeamChanged,
        PlayerChanged,
        PlayerAdded,
        PlayerRemoved,

        // Unit notification events
        UnitCreated,
        UnitFinished,
        UnitFromFactory,
        UnitDestroyed,
        UnitTaken,
        UnitGiven,
        UnitIdle,
        UnitCommand,
        UnitCmdDone,
        UnitDamaged,
        UnitStunned,
        UnitExperience,
        UnitEnteredRadar,
        UnitEnteredLos,
        UnitLeftRadar,
        UnitLeftLos,
        UnitEnteredWater,
        UnitEnteredAir,
        UnitLeftWater,
        UnitLeftAir,
        UnitLoaded,
        UnitUnloaded,
        UnitCloaked,
        UnitDecloaked,
        UnitMoved,
        UnitMoveFailed,
        UnitSeismicPing,

        // Feature events
        FeatureCreated,
        FeatureDestroyed,
        FeatureDamaged,
        FeatureMoved,

        // Projectile events
        ProjectileCreated,
        ProjectileDestroyed,

        // Misc
        StockpileChanged,
        Explosion,

        // Control events (return values that affect sim)
        AllowCommand,
        AllowUnitCreation,
        AllowUnitTransfer,
        AllowUnitBuildStep,
        CommandFallback,
        UnitPreDamaged,

        COUNT
    };
}

// Typed event payloads. Using a struct-per-event pattern rather than
// a union to keep things type-safe and extensible.

struct ScriptEvent {
    uint16_t type = 0;

    // Common fields (used by most events)
    uint32_t entityId = 0;      // primary entity (unit, feature, projectile)
    uint32_t entityId2 = 0;     // secondary entity (attacker, builder, transport)

    // Numeric data (event-specific interpretation)
    int intData[4] = {};        // teamID, playerID, weaponDefID, etc.
    float floatData[4] = {};    // damage, experience, strength, etc.
    float3 position;            // position data

    // Control event outputs (mutable — script writes these)
    bool controlResult = true;  // for Allow* events: true = allow
    float controlFloat = 0.0f;  // for UnitPreDamaged: modified damage

    // Constructor helpers for common events
    static ScriptEvent GameFrameEvent(int frame) {
        ScriptEvent e;
        e.type = ScriptEventType::GameFrame;
        e.intData[0] = frame;
        return e;
    }

    static ScriptEvent UnitEvent(uint16_t type, uint32_t unitId, uint32_t otherId = 0) {
        ScriptEvent e;
        e.type = type;
        e.entityId = unitId;
        e.entityId2 = otherId;
        return e;
    }

    static ScriptEvent DamageEvent(uint32_t unitId, uint32_t attackerId,
                                   float damage, int weaponDefId, int projectileId, bool paralyzer) {
        ScriptEvent e;
        e.type = ScriptEventType::UnitDamaged;
        e.entityId = unitId;
        e.entityId2 = attackerId;
        e.floatData[0] = damage;
        e.intData[0] = weaponDefId;
        e.intData[1] = projectileId;
        e.intData[2] = paralyzer ? 1 : 0;
        return e;
    }
};
