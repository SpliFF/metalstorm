// WarOutcome — `war_outcome`, the durable record of how a war ended, and the
// rendezvous that carries it from the sim to the Director.
//
// PLAN-metalstorm-wars.md §7 `resolving`/`archived`, task 4.
//
// ── Why this is not a field on `war_summary` ───────────────────────────────
// `war_summary` is the LIVE digest and it is deliberately perishable: the
// lobby drops any row older than `kWarSummaryStaleSec` (30 s), because a
// killed server must stop claiming players are online. That is exactly the
// wrong lifetime for an ending. A war that finishes and whose process exits —
// which is what `--postgame-exit-seconds` makes happen, by design (§7.2) — has
// a stale summary within half a minute, and the fact that it was won would
// evaporate with it. So the ending gets its own table, written once and kept.
//
// ── Who writes what, and why the row has exactly one writer ────────────────
// The GAME SERVER writes this row, and only it: every field is a fact only the
// sim holds (the frame it ended on, which team won, what the settlement
// disposed of, the final scoreboard). The LOBBY only reads. The Director's own
// half of the ending — the terminal REASON it decided on, and the archive
// stamp — lives on the `wars` row, where the Director is likewise the only
// writer. Two processes writing one table is the shape that produces a field
// nobody can explain six weeks later; `war_sides` (Director owns the table,
// scenario owns the team numbers) is the precedent and this follows it.
//
// A war can end for a reason the sim never sees at all — an operator retire, a
// season boundary, a faction driven out of the theatre. Those wars archive
// with no `war_outcome` row and that is correct, not a gap: there was no
// in-sim ending to record. The Director's `terminal_reason` is what always
// exists.
//
// ── Durable, so additive migrations only ──────────────────────────────────
// Same rule as `game_events` and `war_player_bindings`, and for the same
// reason: this is the ONLY copy of a finished war's scoreboard. CREATE IF NOT
// EXISTS plus ALTER TABLE ADD COLUMN, never probe-and-drop. (`war_summary` may
// be dropped and rebuilt because it mirrors live state; this may not.)
#pragma once

#include <cstdint>
#include <optional>
#include <string>
#include <vector>

struct sqlite3;

/// One player's line in the final scoreboard (teams §6). Lifetime counters,
/// not a ranking — teams §6 is explicit that the scoreboard is social
/// recognition and drives no end-game payout, so nothing downstream may read
/// these as a reward basis.
struct WarScoreRow {
    int      playerNum = -1;
    /// The account name, resolved by the game server from its own roster —
    /// the only process that holds the playerNum↔name mapping at the moment
    /// the war ends. A war archived and then browsed a month later must still
    /// be able to name its participants, and player numbers are recycled.
    std::string name;
    int      team = -1;
    double   earned = 0.0;
    double   spent = 0.0;
    unsigned objectives = 0;
};

/// How a war ended, as the sim saw it.
struct WarOutcomeRecord {
    uint32_t roomId = 0;
    /// The frame `game_gameover.lua` stamped at `resolving`
    /// (`war_final_frame`), not the frame the scrape happened on. The
    /// difference matters: the scoreboard is republished on a 30 s cadence and
    /// the sim freezes at the declared frame, so scraping "now" archives
    /// whatever the last tick left behind.
    int32_t  finalFrame = 0;
    /// The team whose objective won it, -1 when the war ended some other way.
    int      winnerTeam = -1;
    /// Every faction on the winning SIDE (§7.2's `winnersFor` — a side is
    /// several Spring teams), comma-separated in declaration order. Empty when
    /// there was no in-sim winner.
    std::string winnerFactions;
    /// The war-end settlement's two halves (§7): objectives that were MET at
    /// the final sweep and paid out normally, and objectives written off with
    /// their stakes refunded to the stakers' team pools. Recorded separately
    /// because "settled 6" tells nobody whether the war paid out or wrote
    /// everything off, and the digest says which.
    unsigned settledComplete = 0;
    unsigned settledExpired = 0;
    std::vector<WarScoreRow> scoreboard;
    int64_t  recordedAt = 0;
};

/// Encode / decode the scoreboard for the row's JSON column. One writer, one
/// reader, both here — the same discipline `WarSummary`'s codec pair uses
/// across the same process boundary.
std::string EncodeWarScoreboard(const std::vector<WarScoreRow>& rows);
std::vector<WarScoreRow> DecodeWarScoreboard(const std::string& text);

class WarOutcomeDb {
public:
    /// Create the table if absent, migrate additively. Call before any read or
    /// write, from either process.
    static void EnsureTable(sqlite3* db);

    /// Record how a war ended. INSERT OR REPLACE on `room_id`: the game server
    /// publishes on its heartbeat and a war sits in `over` for the whole
    /// post-game observation window, so the write is repeated and must be
    /// idempotent rather than duplicated.
    ///
    /// **Room ids are reused.** A replace rather than an insert is also what
    /// keeps a recycled id from carrying a previous war's ending; the Director
    /// additionally drops the row in `Forget`.
    static bool Record(sqlite3* db, const WarOutcomeRecord& outcome);

    static std::optional<WarOutcomeRecord> Load(sqlite3* db, uint32_t roomId);

    /// Has this war's sim declared an ending? The lifecycle sweep's question,
    /// and it asks it of every live war on a short cadence — so it is a
    /// one-integer SELECT rather than `Load`, which would decode a whole
    /// scoreboard to answer a yes/no.
    ///
    /// The presence of the row IS the signal. The alternative considered was
    /// carrying `war_state` on the perishable `war_summary`, which fails for
    /// precisely the case that matters: the game server exits a few minutes
    /// after declaring the result, and the summary is dropped as stale half a
    /// minute later — so the lobby would lose the ending it was waiting for.
    static bool HasOutcome(sqlite3* db, uint32_t roomId);

    /// Drop a room's outcome. For the id-reuse path (a room deleted outright),
    /// NOT for a war that ended — an archived war keeps its ending, which is
    /// the whole point of the table.
    static bool Forget(sqlite3* db, uint32_t roomId);
};
