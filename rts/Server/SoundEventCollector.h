// SoundEventCollector — collects per-tick sound emissions.
//
// Weapon fire, projectile impacts, unit deaths, build callbacks etc.
// push into this collector. The sim loop drains it each tick and
// the per-session snapshot stage filters by viewport/LOS before
// serializing into GameEventBatch.sounds.
#pragma once

#include "System/float3.h"
#include "Server/DebugFlags.h"
#include "System/SpringLog/SpringLog.h"
#include <cstdint>
#include <mutex>
#include <vector>

/// Mix channel for a SoundEvent. Mirrors Recoil's
/// `rts/System/Sound/ISoundChannels.h`. Each channel has independent
/// volume + enable state on the client. Emitter picks the channel
/// based on context: combat code -> Battle, selection / order-ack
/// paths -> UnitReply, UI -> UserInterface, music state machine ->
/// BGMusic, everything else (default) -> General. Values match the
/// FlatBuffer `SoundChannel` enum exactly so the dispatcher can
/// cast through without translation.
enum class SoundEventChannel : uint8_t {
    General = 0,
    Battle = 1,
    UnitReply = 2,
    UserInterface = 3,
    BGMusic = 4,
};

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
    /// Eviction priority for the 96-voice pool. Higher wins. Note:
    /// when the client resolves a SoundItem with its own `priority`
    /// from `gamedata/sounds.lua`, that value overrides this one
    /// (per the SoundItem-resolution rules in PLAN-audio.md).
    uint8_t priority = 128;
    /// Owner team. 255 = no team / global / unaffiliated.
    uint8_t team = 255;
    /// Mix channel. Defaults to General; combat emitters set Battle,
    /// selection / order-ack paths set UnitReply, etc.
    SoundEventChannel channel = SoundEventChannel::General;
};

class SoundEventCollector {
public:
    void Push(const SoundEventData& event) {
        if (g_debugFlags.sound.load(std::memory_order_relaxed)) {
            static const char* const KIND_NAMES[] = {"unit", "weapon", "feature", "global"};
            const char* k = (event.sourceKind < 4) ? KIND_NAMES[event.sourceKind] : "?";
            springlog_log(SPRING_LOG_INFO, "sound", "", springlog_get_frame(),
                 "kind=%s defId=%u soundId=%u team=%u ch=%u "
                 "vol=%.2f pitch=%.2f prio=%u @ (%.0f,%.0f,%.0f)",
                 k, (unsigned)event.sourceDefId, (unsigned)event.soundId,
                 (unsigned)event.team, (unsigned)event.channel,
                 event.volume, event.pitch, (unsigned)event.priority,
                 event.position.x, event.position.y, event.position.z);
        }
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
