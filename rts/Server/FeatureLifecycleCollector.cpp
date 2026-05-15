// FeatureLifecycleCollector — see header.

#include "FeatureLifecycleCollector.h"

#include "Sim/Features/Feature.h"
#include "Sim/Features/FeatureDef.h"
#include "System/EventHandler.h"

FeatureLifecycleCollector* featureLifecycleEvents = nullptr;

FeatureLifecycleCollector::FeatureLifecycleCollector()
    : CEventClient("FeatureLifecycleCollector", 0, /*synced=*/true)
{
}

void FeatureLifecycleCollector::Register() {
    eventHandler.AddClient(this);
    // AddClient consults WantsEvent(); CEventClient's default returns
    // false unless `autoLinkEvents` is set (a path the existing server
    // collectors don't wire up). Subscribe explicitly so the dispatcher
    // actually adds us to listFeatureCreated / listFeatureDestroyed.
    eventHandler.InsertEvent(this, "FeatureCreated");
    eventHandler.InsertEvent(this, "FeatureDestroyed");
}

bool FeatureLifecycleCollector::WantsEvent(const std::string& eventName) {
    return eventName == "FeatureCreated" || eventName == "FeatureDestroyed";
}

void FeatureLifecycleCollector::Drain(
    std::vector<FeatureSpawnEventData>& outSpawns,
    std::vector<FeatureRemovedEventData>& outRemoved)
{
    std::lock_guard<std::mutex> lock(mutex);
    outSpawns.swap(spawns);
    outRemoved.swap(removed);
    spawns.clear();
    removed.clear();
}

void FeatureLifecycleCollector::FeatureCreated(const CFeature* feature) {
    if (feature == nullptr) return;
    FeatureSpawnEventData e{};
    e.featureId = static_cast<uint32_t>(feature->id);
    e.defId     = (feature->def != nullptr)
        ? static_cast<uint32_t>(feature->def->id) : 0;
    e.x = feature->pos.x;
    e.y = feature->pos.y;
    e.z = feature->pos.z;
    e.heading     = static_cast<int16_t>(feature->heading);
    e.buildFacing = static_cast<uint8_t>(feature->buildFacing);
    e.team        = static_cast<int8_t>(feature->team);
    e.allyTeam    = static_cast<int8_t>(feature->allyteam);

    std::lock_guard<std::mutex> lock(mutex);
    spawns.push_back(e);
}

void FeatureLifecycleCollector::FeatureDestroyed(const CFeature* feature) {
    if (feature == nullptr) return;
    FeatureRemovedEventData e{};
    e.featureId = static_cast<uint32_t>(feature->id);

    std::lock_guard<std::mutex> lock(mutex);
    removed.push_back(e);
}
