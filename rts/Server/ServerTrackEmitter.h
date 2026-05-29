// ServerTrackEmitter — lays vehicle tread-track decal segments.
//
// Faithful to Recoil's CGroundDecalHandler::AddTrack cadence: one segment
// per `trackDecalWidth` of unit travel, oriented along the travel vector.
// Segments are pushed into the global trackSegmentEvents collector and ride
// the same per-session LOS-filtered envelope 0x08 the scars use.
//
// trackTypeId on the wire is a small index into a sorted distinct table of
// track-type names (NOT the unit defId — that would leak the enemy roster).
// The table is derived once from the unit defs (the single source of truth);
// the client rebuilds the identical sorted table from each def's `trackType`
// field and so resolves index -> texture without any extra wire traffic.
#pragma once

#include "System/float3.h"

#include <cstdint>
#include <string>
#include <unordered_map>
#include <vector>

class ServerTrackEmitter {
public:
    // Build the track-name table + per-defId trackTypeId lookup from
    // unitDefHandler. Idempotent; a no-op (leaves !Ready()) until the def
    // handler is populated, so it's safe to call before sim.Init finishes.
    void Init();
    bool Ready() const { return initialized; }

    // Per tick: scan active units and emit a track segment for every
    // track-leaving mover that has travelled >= its trackDecalWidth since
    // its last segment. Builds the table lazily on first call.
    void Emit(int frameNum);

    // Sorted distinct lowercased track-type names; index == trackTypeId.
    // The client derives the same list from def `trackType` fields.
    const std::vector<std::string>& TrackTypeNames() const { return trackNames; }

private:
    bool initialized = false;
    std::vector<std::string> trackNames;    // index -> lowercased name
    std::vector<uint16_t>    defTrackTypeId; // [defId] -> index, 0xFFFF = none

    struct TrackMemo { float3 pos; int lastFrame; };
    std::unordered_map<uint32_t, TrackMemo> memo; // unitId -> last segment pos
    int lastPruneFrame = 0;
};

extern ServerTrackEmitter serverTrackEmitter;
