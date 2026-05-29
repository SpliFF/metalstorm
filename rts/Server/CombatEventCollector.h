// CombatEventCollector — collects combat events each sim frame.
//
// Weapon Fire() and damage resolution call into this collector.
// At the end of each tick, the sim loop drains the events and
// broadcasts them to clients as a GameEventBatch.
#pragma once

#include "System/float3.h"
#include "Server/DebugFlags.h"
#include "System/SpringLog/SpringLog.h"
#include <cstdint>
#include <mutex>
#include <string>
#include <vector>

struct CombatEventData {
    uint32_t attackerId;
    uint32_t targetId;
    uint16_t weaponDefId;
    uint8_t result;      // 0=hit, 1=miss, 2=blocked, 3=kill
    float damage;
    float3 position;     // impact point
};

class CombatEventCollector {
public:
    /// Record a combat event (thread-safe).
    void Push(const CombatEventData& event) {
        if (g_debugFlags.combat.load(std::memory_order_relaxed)) {
            static const char* const RESULT_NAMES[] = {"hit", "miss", "blocked", "kill"};
            const char* r = (event.result < 4) ? RESULT_NAMES[event.result] : "?";
            springlog_log(SPRING_LOG_INFO, "combat", "", springlog_get_frame(),
                 "%s atk=%u tgt=%u w=%u dmg=%.1f @ (%.0f,%.0f,%.0f)",
                 r, event.attackerId, event.targetId, (unsigned)event.weaponDefId,
                 event.damage, event.position.x, event.position.y, event.position.z);
        }
        std::lock_guard<std::mutex> lock(mutex);
        events.push_back(event);
    }

    /// Drain all events collected since last call.
    std::vector<CombatEventData> Drain() {
        std::lock_guard<std::mutex> lock(mutex);
        std::vector<CombatEventData> drained;
        drained.swap(events);
        return drained;
    }

    /// Number of pending events.
    size_t Size() const {
        std::lock_guard<std::mutex> lock(mutex);
        return events.size();
    }

private:
    mutable std::mutex mutex;
    std::vector<CombatEventData> events;
};

/// Global combat event collector, accessible from weapon code.
extern CombatEventCollector combatEvents;

/// Tracks unit deaths for EntityDestroy broadcast.
///
/// `losMask` is a bitmask of ally teams that had `LOS_INLOS` on the
/// dying unit at the moment of death. server_main.cpp uses it to filter
/// the broadcast: only sessions whose ally team has the bit set receive
/// the destroy envelope. Players holding only PREVLOS (ghost) keep
/// their ghost — Recoil's behaviour is that out-of-LOS destruction is
/// not revealed; the player learns the building is gone the next time
/// they LOS-scan the spot (client-side regained-LOS clearing).
///
/// Bit `i` of `losMask` corresponds to ally team `i`. Ally teams >= 32
/// fall back to "broadcast to all" to preserve legacy behaviour in the
/// unlikely event of >32-ally-team setups (Spring supports up to 255
/// teams but realistic matches stay well below the cap).
struct UnitDeathEvent {
    uint32_t unitId;
    float x, y, z;
    uint32_t losMask;
};

class UnitDeathCollector {
public:
    void Push(uint32_t unitId, float x, float y, float z, uint32_t losMask) {
        std::lock_guard<std::mutex> lock(mutex);
        events.push_back({unitId, x, y, z, losMask});
    }

    std::vector<UnitDeathEvent> Drain() {
        std::lock_guard<std::mutex> lock(mutex);
        std::vector<UnitDeathEvent> drained;
        drained.swap(events);
        return drained;
    }

private:
    std::mutex mutex;
    std::vector<UnitDeathEvent> events;
};

extern UnitDeathCollector unitDeaths;

/// Per-unit runtime sensor-radius change. Emitted by
/// `Spring.SetUnitSensorRadius` (LuaSyncedCtrl) and drained per tick
/// by server_main.cpp into `EntitySensorUpdate` messages so widgets
/// like `unit_stealth.lua` see range-circle changes immediately
/// instead of waiting for a snapshot that doesn't carry the field.
/// sensorType values match `SpringWeb::SensorType` in protocol.fbs:
///   0=los  1=airLos  2=radar  3=sonar
///   4=seismic  5=radarJammer  6=sonarJammer
struct SensorUpdateEvent {
    uint32_t entityId;
    uint8_t  sensorType;
    float    radius;
};

class SensorUpdateCollector {
public:
    void Push(uint32_t entityId, uint8_t sensorType, float radius) {
        std::lock_guard<std::mutex> lock(mutex);
        events.push_back({entityId, sensorType, radius});
    }

    std::vector<SensorUpdateEvent> Drain() {
        std::lock_guard<std::mutex> lock(mutex);
        std::vector<SensorUpdateEvent> drained;
        drained.swap(events);
        return drained;
    }

private:
    std::mutex mutex;
    std::vector<SensorUpdateEvent> events;
};

extern SensorUpdateCollector sensorUpdates;

/// One forwarded argument from `Spring.SendToUnsynced(...)`. The synced
/// callout in `CSyncedLuaHandle::SendToUnsynced` validates types to
/// nil/bool/number/string before pushing, so the variant carries exactly
/// those four cases. `numVal` is double so Lua-side number precision
/// round-trips losslessly.
struct SendToUnsyncedArgValue {
    enum class Kind : uint8_t { Nil = 0, Bool = 1, Number = 2, String = 3 };
    Kind kind = Kind::Nil;
    bool boolVal = false;
    double numVal = 0.0;
    std::string strVal;
};

struct SendToUnsyncedEventData {
    /// 0 = broadcast to every connected client (the only mode synced
    /// `SendToUnsynced` supports today). Reserved for future per-player
    /// fanout from a wrapping callout.
    uint32_t clientId = 0;
    std::vector<SendToUnsyncedArgValue> args;
};

/// Collects `Spring.SendToUnsynced` calls made from synced LuaRules
/// gadgets. The headless server has no unsynced Lua handle to dispatch
/// into (CSplitLuaHandle::InitUnsynced calls KillLua on it), so each
/// call is captured here and the server's main loop drains the queue
/// every tick into `SendToUnsyncedEvent` FlatBuffer broadcasts. The
/// widget worker on the client side decodes the args and dispatches to
/// the per-topic handler registered via gadgetHandler:AddSyncAction.
class SendToUnsyncedEventCollector {
public:
    void Push(SendToUnsyncedEventData event) {
        std::lock_guard<std::mutex> lock(mutex);
        events.push_back(std::move(event));
    }

    std::vector<SendToUnsyncedEventData> Drain() {
        std::lock_guard<std::mutex> lock(mutex);
        std::vector<SendToUnsyncedEventData> drained;
        drained.swap(events);
        return drained;
    }

private:
    std::mutex mutex;
    std::vector<SendToUnsyncedEventData> events;
};

extern SendToUnsyncedEventCollector sendToUnsyncedEvents;
