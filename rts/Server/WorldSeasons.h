// WorldSeasons — PLAN-worldsim.md W12: seasons.
//
// Closes PLAN-lobby.md §8's build order ("persistent map state in SQLite →
// low-frequency economic tick → battle triggers → result application →
// seasons") — this is the last item in that list.
//
// ── What a season is ────────────────────────────────────────────────────
// A per-world row, advancing on the WORLD clock, with a per-world configured
// length. When the active season's length elapses, it ROLLS OVER: the season
// ends, a digest of what happened during it is archived, and a new season
// begins. This is temporal bookkeeping only — no faction, POI or ledger
// balance is touched by a rollover. `world_economy_events` and
// `world_settlement_ledger` keep accumulating exactly as W6/W9 left them;
// a season boundary is a READ over the same rows, filed away as an archive.
//
// ── Digest, not replay ──────────────────────────────────────────────────
// The digest is built once, at rollover, from two already-existing ledgers:
//   - `world_settlement_ledger` (W6), filtered to the rows appended since the
//     season began — via a per-season SETTLEMENT CURSOR (the highest
//     `settlementId` that belonged to the PREVIOUS season), the same
//     append-only-ledger-plus-cursor idiom `world_economy_cursor` (W9) uses.
//     No settlement row carries a world-ms timestamp (it is recorded at
//     real-time war-end), so a cursor on the row's own append order is the
//     correct boundary, not a world-time window.
//   - `world_economy_events` (W9), filtered by its OWN `world_ms` column
//     (the tick's `nowWorldMs`, already exact) to the season's
//     `[startedWorldMs, nowWorldMs]` window — no cursor needed, the column
//     already carries the right clock.
// Per-faction rows plus one faction-less "unclaimed" row for settlements with
// no in-sim winner (`WorldSettlementRecord::factions` empty).
//
// ── Idempotent, like every other tick here ──────────────────────────────
// `Tick`'s first call for a world only opens season 1, anchored at
// `nowWorldMs` — it does not backdate a season for however long the world
// already existed (same rule W9's cursor-plant uses). A paused world's
// `nowWorldMs` does not move between two `Tick` calls, so no rollover ever
// fires while the world is paused — the pause ledger stops the season clock
// for free, the same trick W9/W10 rely on, and this file does not read
// `world_pause_ledger` either.
//
// ── Numbers are data (pillar 7) ──────────────────────────────────────────
// The one rate this file uses (`seasonLengthWorldMs`) lives in
// `WorldDefaults` (WorldDirector.h) and is resolved per-key by
// `WorldSeasonRules::FromWorldConfig`, so a world seeded before W12 is not
// silently opted out of seasons the moment its config blob is read.

#pragma once

#include <cstdint>
#include <optional>
#include <string>
#include <vector>

#include <nlohmann/json.hpp>

struct sqlite3;

// ─────────────────────────── the per-world rates ───────────────────────────

/// Every number W12 uses, resolved for ONE world.
struct WorldSeasonRules {
    /// How long a season runs, in WORLD ms. Default 14 world days — a season
    /// is a narrative/archival unit, not a balance lever, so this only needs
    /// to be "long enough to be worth archiving", not carefully tuned.
    double seasonLengthWorldMs = 14.0 * 24.0 * 3600.0 * 1000.0;

    static WorldSeasonRules FromWorldConfig(const nlohmann::json& worldConfig);
};

// ─────────────────────────── the rows ──────────────────────────────────────

/// A `world_seasons` row.
struct WorldSeasonRecord {
    std::string worldId;
    int         seasonNumber = 0;
    /// "active" | "ended". Exactly one row per world is "active" at a time —
    /// the same "no second answer" discipline `worlds.state` vs the pause
    /// ledger uses (WorldDirector.h), enforced by `Tick` being the only
    /// writer that ever closes a season.
    std::string state = "active";
    int64_t     startedWorldMs = 0;
    /// 0 while active. Set to the `nowWorldMs` that triggered the rollover —
    /// not necessarily `startedWorldMs + seasonLengthWorldMs` exactly, since
    /// the tick cadence samples the world clock rather than firing exactly on
    /// the boundary (same imprecision every other sweep in this layer has).
    int64_t     endedWorldMs = 0;
    /// The highest `world_settlement_ledger` row id that belonged to a PRIOR
    /// season when this one opened — the digest cursor. See the header for
    /// why settlements need a row-order cursor rather than a world-ms window.
    int64_t     settlementCursorStart = 0;
    /// Real ms, for operator visibility only — never read by any rule here.
    int64_t     createdAt = 0;
};

/// A `world_season_digests` row — one faction's (or the unclaimed bucket's)
/// archived totals for one finished season. Append-only: a season is only
/// ever digested once, when `Tick` closes it.
struct WorldSeasonDigestRecord {
    std::string worldId;
    int         seasonNumber = 0;
    /// Empty = the "unclaimed" bucket: settlements with no in-sim winner
    /// (`WorldSettlementRecord::factions` empty) recorded during the season.
    /// Never carries economy totals (an unclaimed settlement is not a
    /// faction, so it cannot own POIs or a treasury).
    std::string factionId;
    int         settlementsWon = 0;
    double      poiIncomeTotal = 0.0;
    /// Always <= 0 (WorldEconomy's decay events are never positive).
    double      decayTotal = 0.0;
    /// A SNAPSHOT of `WorldEconomy::TreasuryFor` at the moment of rollover —
    /// a read, never a write: the season boundary never mutates the ledger
    /// the treasury is summed from (see the header — "no balance changes").
    double      treasuryAtRollover = 0.0;
    int64_t     recordedAt = 0;
};

// ─────────────────────────── the store ────────────────────────────────────

/// Static, like every other World* store: no per-instance state, the handle
/// is the lobby's shared one.
class WorldSeasons {
public:
    /// Create `world_seasons` + `world_season_digests` if absent. ADDITIVE
    /// only, same rule as every other table in this layer.
    static void EnsureTables(sqlite3* db);

    /// The world's currently active season, or nullopt if `Tick` has never
    /// been called for it (a world that predates W12, or one nobody has
    /// ticked yet).
    static std::optional<WorldSeasonRecord> CurrentSeason(sqlite3* db,
                                                           const std::string& worldId);

    static std::vector<WorldSeasonDigestRecord> DigestsFor(sqlite3* db,
                                                            const std::string& worldId,
                                                            int seasonNumber);

    /// What one `Tick` call did.
    struct TickResult {
        bool rolledOver = false;
        int  endedSeasonNumber = 0;
        int  newSeasonNumber = 0;
    };

    /// Ensure a season is running (opens season 1 anchored at `nowWorldMs` on
    /// the very first call for a world — see the header for why that must
    /// not backdate) and roll over to the next season, archiving a digest,
    /// once the active season's `seasonLengthWorldMs` has elapsed.
    ///
    /// A `nowWorldMs` that has not advanced since the last call (the world is
    /// paused, or the lobby loop fired twice inside one world-clock tick)
    /// never rolls over — see the header for why that alone is what makes an
    /// admin pause stop the season clock here.
    static TickResult Tick(sqlite3* db, const std::string& worldId,
                           const WorldSeasonRules& rules,
                           int64_t nowWorldMs, int64_t nowRealMs);

    /// Folds `season` (number, state, started/ends-at) onto an existing
    /// `/api/world` body — the `AttachFactions`/`AttachBattleStatus` idiom.
    /// Read-only: never calls `Tick`, so a route read can never itself cause
    /// a rollover.
    static nlohmann::json AttachSeasonStatus(nlohmann::json worldStatusJson, sqlite3* db,
                                             const std::string& worldId,
                                             const WorldSeasonRules& rules,
                                             int64_t nowWorldMs);
};

/// The sentence the `world-season` SSE event and the log line both carry —
/// built once, here, so they cannot drift, same discipline
/// `WorldNotificationHeadline`/`WarTerminalReasonHeadline` use.
std::string WorldSeasonHeadline(int endedSeasonNumber, int newSeasonNumber);
