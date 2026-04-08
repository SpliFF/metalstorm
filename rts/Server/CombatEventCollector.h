// CombatEventCollector — collects combat events each sim frame.
//
// Weapon Fire() and damage resolution call into this collector.
// At the end of each tick, the sim loop drains the events and
// broadcasts them to clients as a GameEventBatch.
#pragma once

#include "System/float3.h"
#include <cstdint>
#include <mutex>
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
