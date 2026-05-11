// IntelEventCollector — see header.

#include "IntelEventCollector.h"

#include "System/EventHandler.h"

IntelEventCollector* intelEvents = nullptr;

IntelEventCollector::IntelEventCollector()
    : CEventClient("IntelEventCollector", 0, /*synced=*/true)
{
}

void IntelEventCollector::Register() {
    eventHandler.AddClient(this);
}

void IntelEventCollector::UnitSeismicPing(
    const CUnit* /*unit*/, int allyTeam,
    const float3& pos, float strength)
{
    std::lock_guard<std::mutex> lock(mutex);
    seismicPings.push_back({pos, strength, static_cast<int16_t>(allyTeam)});
}

std::vector<SeismicPingData> IntelEventCollector::DrainSeismicPings() {
    std::lock_guard<std::mutex> lock(mutex);
    std::vector<SeismicPingData> drained;
    drained.swap(seismicPings);
    return drained;
}
