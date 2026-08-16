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

/// ── The completeness rule, owned by the rendezvous rather than by either end ─
///
/// `war_state` leaves `active` at the FIRST frame of the wind-down grace, 300
/// frames before `resolve()` runs. Everything that makes an outcome an outcome
/// — `war_final_frame`, `war_settled_complete/expired`, the frozen scoreboard —
/// is stamped by `resolve()` and by nothing before it. So a scrape taken on a
/// `winding_down` heartbeat reads every one of those as ZERO, and publishing it
/// hands the Director a row that says the war ended at frame 0 having settled
/// nothing.
///
/// Live evidence (2026-08-17): at 0.2x the war was archived and its digest
/// emitted 23 s BEFORE the sim settled a single objective; the row was only
/// repaired because the server happened to outlive the archive. When it does
/// not — a hibernation inside the grace, which is exactly D1 — the zeros are
/// permanent and a won war is over on paper with every stake still in escrow.
///
/// `war_final_frame` is the stamp that says `resolve()` ran, so it is the gate.
/// This is a gate on COMPLETENESS, not a one-shot: the writer still publishes
/// on every heartbeat once the row is publishable (see `Record`), because a
/// single write would be lost by any failure between the declaration and the
/// commit — of which the process's own scheduled exit is one.
///
/// Kept here, beside the table, rather than in the scraper: the reader
/// (`HasOutcome`) applies the identical rule to rows already on disk, and two
/// spellings of "is this ending real yet" is how the writer and the reader come
/// to disagree.
///
/// @param simWarState  `war_state` as the sim publishes it: "" (no gameover
///   gadget at all), "active", "winding_down", "resolving" or "over".
/// @param finalFrame   `war_final_frame`, 0 when unstamped.
bool IsPublishableWarOutcome(const std::string& simWarState, int32_t finalFrame);

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
    /// The presence of a COMPLETE row is the signal. The alternative considered
    /// was carrying `war_state` on the perishable `war_summary`, which fails for
    /// precisely the case that matters: the game server exits a few minutes
    /// after declaring the result, and the summary is dropped as stale half a
    /// minute later — so the lobby would lose the ending it was waiting for.
    ///
    /// "Complete" means `final_frame > 0`, i.e. the sim stamped the frame it
    /// resolved on — the same rule `IsPublishableWarOutcome` gates the WRITER
    /// with, applied to what is already on disk. The writer's gate is what
    /// should keep a hollow row from ever existing; this one is what keeps a
    /// hollow row written by an older binary (or by a future second writer)
    /// from archiving a war that has not finished settling. A war whose row is
    /// not yet complete simply stays live and finishes — including on resume,
    /// which is what makes D1's truncated wind-down fail safe.
    static bool HasOutcome(sqlite3* db, uint32_t roomId);

    /// Drop a room's outcome. For the id-reuse path (a room deleted outright),
    /// NOT for a war that ended — an archived war keeps its ending, which is
    /// the whole point of the table.
    static bool Forget(sqlite3* db, uint32_t roomId);
};
