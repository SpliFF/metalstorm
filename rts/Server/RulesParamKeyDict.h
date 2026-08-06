// RulesParamKeyDict — the pure half of the rulesParams key-dictionary
// compaction (PLAN-long-uptime S1).
//
// StateStreamer interns every rulesParams key it ever sees into a 16-bit id so
// the wire carries an id instead of a string. `InternKey` never removes, and
// Metalstorm mints ~10 keys per objective and ~10 per parley proposal — every
// one of which resolves, has its params cleared, and leaves its key interned
// for the life of the server. Two costs:
//
//   1. `SendKeyDictionary` re-sends the WHOLE dictionary to every behind-rev
//      session on any tick that mints a key, so the resend grows linearly in
//      total keys ever seen. This is what bites first, in hours.
//   2. At 65535 ids `InternKey` returns 0 forever and every param falls back
//      to a string key on the wire — handled correctly by the client, but a
//      permanent bandwidth regression with no way back.
//
// These two functions decide *whether* to compact and *how* to rebuild. They
// live here rather than on StateStreamer so they can be tested without an RTC
// server and a session table; the streamer owns the impure half (gathering the
// live key set, bumping the revision, re-broadcasting).
#pragma once

#include <cstdint>
#include <string>
#include <unordered_map>
#include <unordered_set>
#include <vector>

namespace RulesParamKeyDict {

/// Is compaction worth its cost? `interned` counts assigned ids (excluding the
/// reserved 0), `live` counts keys still referenced. Both thresholds must pass:
/// the absolute floor stops churning a small dictionary, and the percentage
/// stops re-issuing every id on a dictionary that is mostly live anyway.
bool ShouldCompact(size_t interned, size_t live, size_t minDead,
                   size_t minDeadPct);

/// Rebuild `keyToId` / `idToKey` from `liveKeys` alone. Index 0 stays reserved
/// for "not interned" and ids are assigned in sorted key order, so the result
/// is a function of the live key set and nothing else — hash-map iteration
/// order would hand two servers that saw the same keys different ids.
///
/// `liveKeys` must be the complete set of keys any message on the compacting
/// tick can name, including keys named only by a delta that removes them: a
/// live key missing from the set is re-interned to a different id than the one
/// a client already holds.
void Rebuild(std::unordered_map<std::string, uint16_t>& keyToId,
             std::vector<std::string>& idToKey,
             const std::unordered_set<std::string>& liveKeys);

} // namespace RulesParamKeyDict
