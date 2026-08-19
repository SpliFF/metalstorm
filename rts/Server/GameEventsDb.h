// GameEventsDb — `game_events`, the durable strategic history of a persistent
// war and the source of the while-you-were-away digest.
//
// PLAN-persistence.md §4, task 4b. The GAME server appends (it is the only
// process that can see the sim); the LOBBY reads, and serves the slice a
// returning account has not seen on `POST /api/wars/join-preview`. Same
// shared-SQLite rendezvous as `war_summary` / `war_player_bindings` — there is
// no other backchannel between the two processes.
//
// ── Durable, so additive migrations only ──────────────────────────────────
// Not a mirror table. `game_servers` and `game_status` can be dropped and
// rebuilt from live memory; this one is the ONLY copy of what happened in a
// war, and a war is supposed to outlive many restarts of both processes. It
// therefore follows `war_player_bindings`: CREATE IF NOT EXISTS plus ALTER
// TABLE ADD COLUMN, never probe-and-drop.
//
// ── Retention ─────────────────────────────────────────────────────────────
// A week-long war generates events at a strategic tempo (region flips,
// objective resolutions, pacts) — tens per hour, not thousands — so the table
// is small by construction and the prune is a backstop against a pathological
// scenario, not a routine cost. It is per-room and count-based rather than
// age-based on purpose: a player who has been away for a month is exactly the
// player the digest exists for, and an age-based prune would empty it for them
// specifically.
#pragma once

#include <cstdint>
#include <vector>

#include "WarLog.h"

struct sqlite3;

class GameEventsDb {
public:
    /// Rows kept per room. Well above what the digest shows (which is capped
    /// far lower, in the lobby) so that "what did I miss" can still be
    /// answered for a long absence, and low enough that a runaway emitter
    /// cannot grow the shared db without bound.
    static constexpr int kRetainPerRoom = 500;

    /// Create the table if absent and migrate additively. Call before any read
    /// or write, from either process.
    static void EnsureTable(sqlite3* db);

    /// Append a drained batch. One transaction for the batch, and INSERT OR
    /// IGNORE on `(room_id, seq)`: the drain is idempotent by design (a
    /// heartbeat that wrote its rows and then died before advancing its
    /// in-memory watermark re-offers them next time), and a UNIQUE that
    /// silently absorbs the repeat is cheaper than a read-back to find out.
    /// `now` is the wall clock stamped on every row of the batch.
    /// Returns the number of rows actually inserted.
    static int Append(sqlite3* db, uint32_t roomId,
                      const std::vector<warlog::Event>& events, int64_t now);

    /// The highest seq stored for a room, or 0 if none. This is how a freshly
    /// started (or resumed) game server recovers its watermark: the in-memory
    /// cursor dies with the process, the table does not, and a war that comes
    /// back from hibernation must not re-append the history it already wrote.
    static int64_t HighestSeq(sqlite3* db, uint32_t roomId);

    /// Events for `roomId` stamped strictly after `sinceUnix`, oldest first,
    /// at most `limit` of them — the NEWEST `limit`, because a digest that
    /// truncates has to keep the end of the story, not the start.
    /// `totalOut`, when non-null, receives the true count before the limit,
    /// so the caller can say "and 40 more" rather than imply there were 8.
    static std::vector<warlog::Event> Since(sqlite3* db, uint32_t roomId,
                                            int64_t sinceUnix, int limit,
                                            int* totalOut = nullptr);

    /// Drop all but the newest `kRetainPerRoom` rows of a room.
    static void Prune(sqlite3* db, uint32_t roomId);

    /// Delete a room's whole history — called when a war is deleted, so a
    /// recycled room id cannot inherit a previous war's story.
    static void DeleteForRoom(sqlite3* db, uint32_t roomId);
};
