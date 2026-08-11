// WarLog — the strategic event stream of a persistent war, and the pure logic
// that drains it out of the sim's ring buffer.
//
// PLAN-persistence.md §4 ("a while-you-were-away digest on rejoin — objectives
// resolved, regions flipped, pacts made/broken"), task 4b.
//
// ── The shape of the problem ───────────────────────────────────────────────
// The emit side is `game_warlog.lua`, which writes the last N events into
// gameRulesParams as a ring (`warlog_<slot>_*`) with a monotonic head
// (`warlog_seq`). The ring is a hand-off buffer, not a record: it is synced
// state, so it cannot grow for the life of a war that runs for weeks. The
// durable record is the `game_events` table (GameEventsDb.h), written by the
// game server's 2 s war-summary heartbeat.
//
// Between those two sits one function with one job — given the ring's head
// and the watermark of what has already been stored, hand back the events in
// between, in order, and SAY SO when some of them were overwritten before the
// drain could see them. That last part is the reason this is a pure function
// in its own file rather than a loop inside the heartbeat lambda: "the digest
// is complete" is the only property the feature actually sells, and it is
// decided entirely by arithmetic on three integers.
//
// ── Why the drain is not a subscription ────────────────────────────────────
// There is no callback from synced Lua into the server's DB layer (there is no
// DB callout at all — see WarStateSim.h for the same finding on the other
// direction), so every Lua→durable path in this codebase is a scraper on a
// wall-clock heartbeat. This one follows GatherWarSummaryRegions(): the sim
// publishes params, the heartbeat reads them. It also has to be wall-clock for
// its own reason — the heartbeat is what still runs while the sim is paused,
// and a war can be paused for as long as anybody likes.
#pragma once

#include <cstdint>
#include <functional>
#include <string>
#include <vector>

namespace warlog {

/// One strategic event. `at` is stamped by the writer, not by the sim: the
/// frame says where in the WORLD it happened and the timestamp says where in
/// the player's WEEK, and hibernation makes those two independent — a war
/// frozen for three days advances no frames at all.
struct Event {
    int64_t     seq   = 0;
    std::string kind;      ///< 'objective' | 'region' | 'pact' | kElidedKind
    std::string subject;   ///< display noun, composed by the emitting gadget
    std::string detail;    ///< outcome within the kind
    int         team  = -1;
    int32_t     frame = 0;
};

/// The kind stamped on the synthetic row that stands in for events the ring
/// overwrote before the drain reached them. It is a row in the stream rather
/// than a counter beside it because it has a POSITION: "and 12 more things
/// happened here" is a different statement from "12 events were lost at some
/// point in this war".
inline constexpr const char* kElidedKind = "elided";

/// Reads slot `slot` of the ring. Returns false when the slot has never been
/// written (a war younger than one full lap), which is not an error.
using SlotReader = std::function<bool(int slot, Event& out)>;

struct DrainResult {
    std::vector<Event> events;      ///< strictly increasing `seq`, oldest first
    int64_t            watermark;   ///< the new "already stored" cursor
    int64_t            elided;      ///< events the ring overwrote unseen
};

/// Drain everything after `watermark` up to and including `head`.
///
/// `ringSize` is read from the sim (`warlog_ring`) rather than compiled in, so
/// the gadget owns the buffer's geometry; a non-positive value means the ring
/// is not published at all and nothing is drained.
///
/// Three cases, and the middle one is the whole point:
///   - `head <= watermark` — nothing new (the ordinary heartbeat).
///   - `head - watermark > ringSize` — the ring lapped. Only the last
///     `ringSize` events still exist; the rest are gone and are reported as
///     `elided`, with one synthetic Event carrying the count at the position
///     where they were lost.
///   - otherwise — every event since the watermark is still in the buffer.
///
/// A slot whose `seq` does not match the one being asked for is skipped and
/// counted as elided: that is a half-written event (the emitter writes the
/// head last, so this can only be seen mid-write) or a slot from a previous
/// lap, and either way its fields belong to a different event.
DrainResult Drain(int64_t head, int64_t watermark, int ringSize,
                  const SlotReader& read);

}  // namespace warlog
