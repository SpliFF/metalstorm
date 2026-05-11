// SoundEventCollector — collects per-tick sound emissions.
//
// Weapon fire, projectile impacts, unit deaths, build callbacks etc.
// push into this collector. The sim loop drains it each tick and
// the per-session snapshot stage filters by viewport/LOS before
// serializing into GameEventBatch.sounds.
#pragma once

#include "System/float3.h"
#include <cstdint>
#include <mutex>
#include <vector>

struct SoundEventData {
    /// Index into the def's `sounds` array.
    uint16_t soundId;
    /// Unit def id, weapon def id, or feature def id.
    uint16_t sourceDefId;
    /// SoundSourceKind enum value: 0=Unit, 1=Weapon, 2=Feature, 3=Global.
    uint8_t sourceKind;
    float3 position;
    /// Pre-attenuation gain (multiplied with SoundRef.volume).
    float volume = 1.0f;
    /// Playback rate (multiplied with SoundRef.pitch).
    float pitch = 1.0f;
    /// Eviction priority for the 96-voice pool. Higher wins.
    uint8_t priority = 128;
    /// Owner team. 255 = no team / global / unaffiliated.
    uint8_t team = 255;
};

class SoundEventCollector {
public:
    void Push(const SoundEventData& event) {
        std::lock_guard<std::mutex> lock(mutex);
        events.push_back(event);
    }

    std::vector<SoundEventData> Drain() {
        std::lock_guard<std::mutex> lock(mutex);
        std::vector<SoundEventData> drained;
        drained.swap(events);
        return drained;
    }

    size_t Size() const {
        std::lock_guard<std::mutex> lock(mutex);
        return events.size();
    }

private:
    mutable std::mutex mutex;
    std::vector<SoundEventData> events;
};

extern SoundEventCollector soundEvents;
