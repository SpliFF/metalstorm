// WorldEconomy — PLAN-worldsim.md W9: the low-frequency economic tick.
//
// Design: PLAN-metalstorm-worldbuilding.md's world-time block ("Incomes,
// decay, and transit all accrue in absentia") and the W8 residual note this
// milestone closes: "Rank's money/.../weights are wired and multiply zero —
// W9's economy fills WorldHoldings, no formula change needed."
//
// ── What ticks, and what does not ──────────────────────────────────────────
// A world FACTION accrues **income** from every `world_pois` row it owns
// (Capture 10's "holdings"), and its accumulated wealth **decays** slowly —
// the same "merit over grind, gentle rate" shape W8's authority decay already
// uses, applied to money instead of a commander's standing. Both are driven
// by the WorldDirector's periodic sweep (`rts/lobby_main.cpp`), NOT by a
// route read — unlike W8's authority accrual, which is deliberately lazy
// because W8 shipped with no tick. W9 is the tick W8's header pointed at.
//
// ── Ledgered, never mutated in place ────────────────────────────────────────
// There is no `balance` COLUMN anywhere in this file. A faction's treasury is
// the SUM of its `world_economy_events` rows — computed on read, exactly like
// Rank is computed on read from holdings (WorldStats.h). Every tick call
// appends rows; nothing here ever UPDATEs one. That is stricter than W8's
// commander `authority` column (which IS rolled forward in place) by design:
// the economic ledger is meant to be an audit trail a player can be shown
// ("why do we have 340 treasury" → these rows), and a summed ledger answers
// that for free.
//
// ── Idempotent catch-up, not a replay ──────────────────────────────────────
// `world_economy_cursor` holds ONE row per world: the world-ms this world was
// last ticked at. `Tick` computes `elapsed = nowWorldMs - cursor` and prices
// income/decay as a closed-form function of `elapsed` (income is linear in
// elapsed time; decay is the same continuous `pow` shape `DecayAuthority`
// uses) — so a lobby that was down for six real hours and comes back to a
// world clock that jumped six world-days catches up with ONE tick call
// pricing the whole gap, never by looping a day at a time and never by
// re-walking history. Calling `Tick` twice with the same `nowWorldMs` (the
// lobby loop firing while the world clock has not advanced — exactly what
// happens while the world is admin-paused, since `WorldClockReading::worldMs`
// itself freezes then) computes `elapsed <= 0` and writes nothing: that IS
// how the pause ledger stops accrual here — this file does not read
// `world_pause_ledger` itself, it just never sees `nowWorldMs` move while a
// pause is open.
//
// ── Numbers are data (pillar 7) ─────────────────────────────────────────────
// Every rate is a key in the world's `config_json`, defaulted in
// `WorldDefaults` (WorldDirector.h) and resolved per key by
// `WorldEconomyRules::FromWorldConfig` — same per-key-fallback discipline as
// `WorldStatRules::FromWorldConfig`, so a world seeded before W9 is not
// silently opted out of the tick the moment its blob is read.

#pragma once

#include <cstdint>
#include <string>
#include <vector>

#include <nlohmann/json.hpp>

#include "WorldDirector.h"

struct sqlite3;

// ─────────────────────────── the per-world rates ───────────────────────────

/// Every number W9 uses, resolved for ONE world.
struct WorldEconomyRules {
    /// Treasury income per world DAY, per POI a faction owns. The whole of
    /// "per-POI income" — a faction with no POIs earns nothing, which is the
    /// point: holding ground is what the economy rewards.
    double poiIncomePerWorldDay = 2.0;
    /// The C22/W8-style "gentle rate" decay, but on a faction's treasury
    /// instead of a commander's authority: the FRACTION lost per world day of
    /// accumulated wealth. Keeps a dormant faction's treasury from becoming a
    /// permanent stockpile nobody has to defend to keep.
    double treasuryDecayPerWorldDay = 0.01;
    /// Decay never takes a treasury below this (and never RAISES one that
    /// starts below it — same rule as `authorityFloor`).
    double treasuryFloor = 0.0;

    static WorldEconomyRules FromWorldConfig(const nlohmann::json& worldConfig);
};

// ─────────────────────────── the rows ──────────────────────────────────────

/// A `world_economy_events` row — one priced tick outcome, append-only. The
/// ledger IS the balance: nothing sums these into a stored column.
struct WorldEconomyEventRecord {
    std::string worldId;
    std::string factionId;
    /// The POI this income came from, or empty for a faction-level row
    /// (decay has no single POI to blame).
    std::string poiId;
    /// "poi_income" | "decay".
    std::string source;
    double  delta = 0.0;
    /// The world-ms this event was priced AT — the tick's `nowWorldMs`, i.e.
    /// the end of the period it prices, not a per-day timestamp.
    int64_t worldMs = 0;
    int64_t recordedAt = 0;
};

// ─────────────────────────── pure policy ───────────────────────────────────

/// Income one POI yields over `elapsedWorldMs`. Linear — there is no reason
/// for a POI's income to compound — so pricing a long gap in one call gives
/// the same answer as pricing it a day at a time would, which is exactly the
/// property idempotent catch-up needs.
double PoiIncomeOverPeriod(int64_t elapsedWorldMs, const WorldEconomyRules& rules);

/// The DELTA (never positive) that `treasuryDecayPerWorldDay` applies to
/// `balance` over `elapsedWorldMs`. Same continuous `pow`-based shape as
/// `DecayAuthority` (WorldStats.h) for the same reason: the answer must not
/// depend on how often it is evaluated.
double TreasuryDecayOverPeriod(double balance, int64_t elapsedWorldMs,
                               const WorldEconomyRules& rules);

// ─────────────────────────── the store ────────────────────────────────────

/// Static, like WorldDirector/WorldFactions/WorldStats: no per-instance
/// state, the handle is the lobby's shared one.
class WorldEconomy {
public:
    /// Create `world_economy_events` + `world_economy_cursor`. ADDITIVE only
    /// — same rule as every other table in this layer.
    static void EnsureTables(sqlite3* db);

    /// A faction's treasury right now: `SUM(delta)` over its ledger. Zero for
    /// a faction with no rows, which is every faction before its first tick —
    /// legal, not a defect.
    static double TreasuryFor(sqlite3* db, const std::string& worldId,
                              const std::string& factionId);

    static std::vector<WorldEconomyEventRecord> EventsFor(
        sqlite3* db, const std::string& worldId, const std::string& factionId);

    /// The world-ms this world's ledger was last priced through, or 0 if it
    /// has never ticked.
    static int64_t LastTickWorldMs(sqlite3* db, const std::string& worldId);

    /// Price everything that happened between the cursor and `nowWorldMs` for
    /// every faction that owns a POI or already holds a treasury, and move
    /// the cursor there. Returns the number of ledger rows appended.
    ///
    /// The FIRST call for a world only plants the cursor at `nowWorldMs` and
    /// writes nothing — a world ticked for the first time long after it was
    /// founded must not backdate a windfall for every day it existed before
    /// this milestone shipped. Every call after that prices exactly the gap
    /// since the previous one, however long, in one shot (see the header:
    /// this is the idempotent catch-up, not a replay).
    ///
    /// A `nowWorldMs` at or before the cursor (the world is paused, or the
    /// lobby loop fired twice inside one world-clock tick) writes nothing and
    /// leaves the cursor where it was — see the header for why that alone is
    /// what makes an admin pause stop accrual here.
    static int Tick(sqlite3* db, const std::string& worldId,
                    const WorldEconomyRules& rules,
                    int64_t nowWorldMs, int64_t nowRealMs);

    // ── the read-only surface, as data ─────────────────────────────────────

    /// Folded into `WorldStats::StatsJson`'s body at the transport layer (the
    /// `AttachFactions` idiom): the rates in force plus every faction's
    /// current treasury and POI count, so the World screen can show "why" a
    /// faction has what it has without a second round-trip.
    static nlohmann::json EconomyJson(sqlite3* db, const std::string& worldId,
                                      const WorldEconomyRules& rules);
};
