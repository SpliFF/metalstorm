#include "RulesParamKeyDict.h"

#include <algorithm>

namespace RulesParamKeyDict {

bool ShouldCompact(size_t interned, size_t live, size_t minDead,
                   size_t minDeadPct) {
    // `live` can exceed `interned` only if the caller passed keys that were
    // never interned; treat that as "nothing dead" rather than underflowing
    // size_t into ~1.8e19 and compacting on every tick.
    const size_t dead = (interned > live) ? (interned - live) : 0;
    if (dead < minDead) return false;
    return dead * 100 >= interned * minDeadPct;
}

void Rebuild(std::unordered_map<std::string, uint16_t>& keyToId,
             std::vector<std::string>& idToKey,
             const std::unordered_set<std::string>& liveKeys) {
    keyToId.clear();
    idToKey.clear();
    idToKey.push_back("");  // index 0 reserved, same invariant as InternKey

    std::vector<std::string> sorted(liveKeys.begin(), liveKeys.end());
    std::sort(sorted.begin(), sorted.end());
    for (const auto& k : sorted) {
        if (idToKey.size() >= 65535) break;  // the ceiling InternKey enforces
        keyToId[k] = static_cast<uint16_t>(idToKey.size());
        idToKey.push_back(k);
    }
}

} // namespace RulesParamKeyDict
