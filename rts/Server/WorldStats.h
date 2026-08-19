// WorldStats — the three-stat family of the world layer, as rows and as
// arithmetic: **Authority** (per COMMANDER), **Capacity** (per PLAYER) and
// **Rank** (per player per faction, DERIVED).
//
// PLAN-worldsim.md W8. Design — LOCKED, not re-derived here:
// PLAN-metalstorm-worldbuilding.md Capture 23 (the two-stat decision),
// Capture 24 (Rank is faction standing), Capture 27 (Rank = the sum of
// holdings excluding loaned items — the anti-flip counterbalance), Capture 12
// (merit over grind: the per-real-24h order ceiling) and the decisions table
// rows 8 and 10.
//
// ── The three stats, and why they live in three different places ───────────
//
//   **Authority — per COMMANDER, slow in both directions.** "Grows as the
//   commander gains experience and achieves objectives, decreases slowly"
//   (C23). So it is a column on a commander ROW, accrued from world events
//   and decayed against the WORLD clock. It is the gravity number (garrison
//   grip, loyalty retention, defection splits); orders never drain it —
//   "a hard day's fighting doesn't weaken your garrisons; only time, death
//   and failure do".
//
//   **Capacity — per PLAYER, the order budget.** "Their ability to give
//   orders — which caps the number of orders and orders-per-day type limits"
//   (C23's correction: a player stat, not a commander stat), with C12's
//   real-24h recharge. So it is a column on the per-account
//   `world_authority` row W7 already ships, plus the two bookkeeping columns
//   a budget needs (what has been spent, and when it last recharged).
//   Authority raises capacity's CEILING and nothing else — "they are separate
//   stats".
//
//   **Rank — per player PER FACTION, and it has no table.** C24 + C27 make it
//   the sum of a player's holdings, which means every writable input already
//   lives somewhere else; a stored rank would be a second copy that goes
//   stale the moment a commander is traded. So it is COMPUTED ON READ, here,
//   from the holdings themselves. `world_faction_members.rank` (a W7 column)
//   is consequently LEGACY: nothing in this file reads it and nothing should
//   start — see `WorldStats::RankFor`.
//
// ── A commander here is a ROW, not a unit ──────────────────────────────────
// The battle layer's commander — the unit on the map, its death, its
// hitpoints — is not this. This is the world-layer commander: an officer a
// player holds in a world, stationed at a POI, carrying an authority score
// and (C27) tradeable and loanable. Nothing in this file reads, writes or
// joins a `war*` table and no column below is keyed by `room_id`; the only
// battle-shaped input is the W6 settlement ledger, which is itself a
// world-scoped row (see WorldDirector.h).
//
// ── Where the numbers come from (pillar 7 / Capture 26) ────────────────────
// Every rate is a key in the WORLD's `config_json`, defaulted in
// `WorldDefaults` and resolved per key by `WorldStatRules::FromWorldConfig` —
// per key, because a world seeded before W8 has a blob that predates these
// keys and a missing key must not disable the rule it configures. There is
// not one tuning literal in the .cpp.
//
// ── Accrual is idempotent, and it is a read ────────────────────────────────
// W9 owns the world tick; W8 must not grow one. So accrual runs LAZILY when a
// stat is read (`AccrueFromSettlements`), and it is safe to run any number of
// times because each award is an append-only `world_authority_events` row
// keyed `(world_id, commander_id, source, source_key)` — a UNIQUE index, so
// replaying the whole ledger awards nothing twice. That is the same discipline
// the settlement ledger itself follows: append rows, never mutate a balance
// in place, and let the derived number be derived.

#pragma once

#include <cstdint>
#include <optional>
#include <string>
#include <vector>

#include <nlohmann/json.hpp>

#include "WorldDirector.h"

struct sqlite3;

// ─────────────────────────── the per-world rates ───────────────────────────

/// Every number W8 uses, resolved for ONE world. Defaults mirror
/// `WorldDefaults`; a world's own row is the authority once it exists.
struct WorldStatRules {
    // ── Authority (C23: slow in BOTH directions) ────────────────────────────
    /// Awarded to a commander stationed where a war settled in their
    /// faction's favour. "Achieves objectives" is, at the world layer, exactly
    /// a settlement row.
    double authorityPerVictory = 12.0;
    /// Awarded for being there and losing. Small and positive rather than
    /// negative: C12 wants merit, and a commander who fought a hard defence
    /// has gained experience — while the decay below is what punishes a
    /// commander who achieves nothing at all.
    double authorityPerDefeat = 3.0;
    /// The C22 decay retained "at a gentle rate": the FRACTION of a
    /// commander's authority lost per world DAY of idleness. Multiplicative,
    /// so decay is proportional and a high-authority commander sheds more per
    /// day than a fresh one — the same shape as loyalty decay.
    double authorityDecayPerWorldDay = 0.01;
    /// Decay never takes a commander below this. Not a design floor, a
    /// numerical one: an authority that asymptotes to zero would make every
    /// long-lived commander indistinguishable from a brand-new one.
    double authorityFloor = 1.0;
    /// C17's "threshold-grant then promotion": the world authority a PLAYER
    /// must hold before the world hands them their first commander. Zero
    /// would mean every visitor gets one; the default sits below W7's
    /// `startingAuthority` so a new player has one from their first look at
    /// the map and earns the rest.
    double commanderGrantAuthority = 50.0;

    // ── Capacity (C23 + C12 + pillar 6) ────────────────────────────────────
    /// The order budget a player has with no commanders at all. Non-zero
    /// because C17's selections keep "no-commander orders at steep
    /// undiscounted cost" legal — a player with nobody can still act, badly.
    double capacityBase = 20.0;
    /// How much each point of a held commander's authority raises the
    /// player's capacity CEILING. This is the one linkage C23 allows between
    /// the two stats, and it is a multiplier on the ceiling only: spending
    /// orders never touches authority.
    double capacityPerCommanderAuthority = 0.10;
    /// C12's "how many can be spent per real 24-hour period" — REAL hours,
    /// not world hours. The anti-grind ceiling exists to protect the player's
    /// day, so it is measured on the clock the player lives on, and an admin
    /// world pause must not hand anybody a bigger budget.
    double capacityRechargeHours = 24.0;
    /// The fraction of the ceiling refunded each recharge period. 1.0 = a
    /// full budget every day, which is what "optimise for play sessions of
    /// about four hours a day" asks for; below 1.0 makes a heavy day cost the
    /// next one too.
    double capacityRechargeFraction = 1.0;

    // ── Rank (C24 + C27: the sum of holdings, excluding loans) ─────────────
    /// Per commander HELD. C27's list is "money, resources, units,
    /// commanders"; a commander is the heaviest single holding in it because
    /// it is the one that commands the others.
    double rankPerCommander = 10.0;
    /// Per point of that commander's authority. C24's first formulation was
    /// "based on a player's total authority"; C27 did not remove it, it added
    /// the rest of the holdings around it, so authority stays a term.
    double rankPerCommanderAuthority = 1.0;
    /// C24's "bonuses from regions where a player exerts control": per POI
    /// their faction holds and they garrison.
    double rankPerPoiHeld = 25.0;
    /// C24's "artifacts under the player's control".
    double rankPerArtifact = 50.0;
    /// The rest of C27's list. There is no money, no resource and no
    /// world-layer unit row yet (W9 opens the economy), so these weights are
    /// wired and multiply zero — deliberately, because the formula is the
    /// LOCKED part and leaving its terms out would invite re-deriving it
    /// later from a shorter list.
    double rankPerMoney = 1.0;
    double rankPerResource = 1.0;
    double rankPerUnit = 2.0;

    static WorldStatRules FromWorldConfig(const nlohmann::json& worldConfig);
};

// ─────────────────────────── the rows ──────────────────────────────────────

/// A `world_commanders` row — one officer a player holds in one world.
struct WorldCommanderRecord {
    std::string worldId;
    /// Unique within the world; a readable slug for the same reason a faction
    /// id is one (it travels through JSON and URLs).
    std::string commanderId;
    std::string name;
    /// The account that OWNS this commander. Ownership is what rank counts and
    /// what a trade moves.
    int64_t accountId = 0;
    /// C27's loan: the account currently commanding it, or 0 when it is not on
    /// loan. A loaned commander counts toward NEITHER party's rank — the
    /// residual C27 left open, decided here in the direction it pointed:
    /// counting it for the lender makes lending rank-free income, counting it
    /// for the borrower makes standing borrowable for one vote, and the design
    /// intent ("standing can't be borrowed") rules both out.
    int64_t loanedToAccountId = 0;
    /// The world faction this commander serves. Denormalised from the owner's
    /// membership at grant time, because a commander stays with its faction
    /// when its owner leaves (C18/C19's defection split is what moves it) and
    /// the settlement attribution below has to know which side it fought on.
    std::string factionId;
    /// Where it is stationed. Attribution reads this: a war settles at a POI,
    /// and the commanders standing there are the ones who earned it.
    std::string poiId;
    /// "active" | "dead" | "captured". Only "active" accrues, garrisons or
    /// counts for rank; the row survives death because the ledger rows that
    /// reference it do (C22's death cost is the loss of the authority, not of
    /// the history).
    std::string state = "active";
    /// Authority AS OF `authorityAtWorldMs` — a stored value plus a timestamp,
    /// not a current one. Decay is applied on read
    /// (`CommanderAuthorityAt`), so a commander nobody looks at for a month
    /// is worth exactly what a commander somebody polled hourly is worth.
    double  authority = 0.0;
    /// WORLD ms (not real ms): decay is world time, so an admin pause stops it
    /// the same way it stops everything else in this layer.
    int64_t authorityAtWorldMs = 0;
    /// Real ms. Used by attribution as a floor — a commander granted today
    /// must not harvest authority from wars that settled before it existed.
    int64_t createdAt = 0;
    nlohmann::json config = nlohmann::json::object();

    /// C27's exclusion, as one predicate so no caller re-spells it.
    bool CountsForRank() const { return state == "active" && loanedToAccountId == 0; }
};

/// A `world_authority_events` row — one award, append-only. The ledger is the
/// audit trail AND the idempotence key: `(world_id, commander_id, source,
/// source_key)` is UNIQUE, so re-running accrual over the whole settlement
/// ledger is a no-op rather than a windfall.
struct WorldAuthorityEventRecord {
    std::string worldId;
    std::string commanderId;
    /// "settlement" today; "objective", "artifact", "decay_audit" later.
    std::string source;
    /// Unique per source. For settlements it is the ledger row's id, so the
    /// key survives two identical wars at one POI.
    std::string sourceKey;
    double  delta = 0.0;
    std::string reason;
    int64_t worldMs = 0;
    int64_t recordedAt = 0;
};

// ─────────────────────────── pure policy ───────────────────────────────────

/// Apply `authorityDecayPerWorldDay` over `elapsedWorldMs`. Multiplicative and
/// continuous (pow, not a per-day loop) so the answer does not depend on how
/// often it is evaluated — the property that lets decay be a read.
///
/// A non-positive elapsed time returns the value unchanged: a clock read
/// slightly behind a stored stamp (a resync, a pause closing) must not be a
/// windfall or a penalty.
double DecayAuthority(double value, int64_t elapsedWorldMs, const WorldStatRules& rules);

/// A commander's authority right now.
double CommanderAuthorityAt(const WorldCommanderRecord& c, int64_t nowWorldMs,
                            const WorldStatRules& rules);

/// Does a settlement row's `factions` field (comma-separated winners) name
/// `factionId`? Exposed because it is the whole difference between a victory
/// award and a defeat one, and it parses untrusted-ish text.
bool SettlementNamesFaction(const std::string& factions, const std::string& factionId);

/// One award attribution decides on.
struct WorldAuthorityAttribution {
    std::string commanderId;
    double      delta = 0.0;
    /// "victory" | "defeat" — what the ledger row records, so a player can see
    /// WHY their commander gained.
    std::string reason;
};

/// Who earned what from one settlement. Pure: the caller supplies the
/// commanders standing at the settled POI, so the rule is testable with no
/// database and no war.
///
/// A commander created AFTER the settlement earns nothing from it — otherwise
/// a fresh commander posted to a contested POI would immediately harvest every
/// war ever fought there.
std::vector<WorldAuthorityAttribution> AttributeSettlement(
    const WorldSettlementRecord& settlement,
    const std::vector<WorldCommanderRecord>& commandersAtPoi,
    const WorldStatRules& rules);

/// The order budget, as the player panel shows it.
struct WorldCapacityState {
    /// The ceiling: `capacityBase` + authority linkage.
    double  max = 0.0;
    /// What has been spent against the current period.
    double  spent = 0.0;
    /// `max - spent`, never negative.
    double  available = 0.0;
    /// When the current period started (real ms).
    int64_t rechargedAt = 0;
    /// Real ms until the next recharge — the "wait for your limit to
    /// recharge" number C12 asks the UI to show.
    int64_t nextRechargeInMs = 0;
};

/// Fold whole elapsed recharge periods into the spend counter. Pure, and the
/// only place the recharge rule is written: the store writes back what this
/// returns, so a read normalises the row and a read on a row already
/// normalised changes nothing.
struct WorldCapacityLedger {
    double  spent = 0.0;
    int64_t rechargedAt = 0;
    /// True when the caller should persist the new values.
    bool    changed = false;
};
WorldCapacityLedger NormalizeCapacity(double spent, int64_t rechargedAtRealMs, double max,
                                      const WorldStatRules& rules, int64_t nowRealMs);

/// The ceiling C23 allows authority to raise.
double CapacityCeiling(double heldCommanderAuthority, const WorldStatRules& rules);

/// Assemble the display state from a normalised ledger.
WorldCapacityState CapacityStateFrom(const WorldCapacityLedger& ledger, double max,
                                     const WorldStatRules& rules, int64_t nowRealMs);

/// The holdings C27 counts that this milestone cannot yet source. Passed in
/// rather than looked up so that the formula is complete and testable today
/// and W9 only has to fill the struct.
struct WorldHoldings {
    double money = 0.0;
    double resources = 0.0;
    int    units = 0;
    int    artifacts = 0;
};

/// Rank, term by term, so the panel can show the sum AND its parts — a
/// standing nobody can decompose reads as arbitrary, and C27's whole point is
/// that the formula is legible enough to be trusted as a counterbalance.
struct WorldRankBreakdown {
    double commanders = 0.0;
    double commanderAuthority = 0.0;
    double regions = 0.0;
    double money = 0.0;
    double resources = 0.0;
    double units = 0.0;
    double artifacts = 0.0;
    double total = 0.0;
    /// Counted inputs, for the "3 commanders · 2 regions" line.
    int commanderCount = 0;
    int poiCount = 0;
    /// Commanders owned but excluded from the sum because they are on loan
    /// (C27). Surfaced because a player whose rank dropped after lending one
    /// deserves to see why.
    int loanedCount = 0;

    nlohmann::json ToJson() const;
};

/// C24 + C27's formula. `commanders` is everything the player OWNS (loaned
/// rows included — this function applies the exclusion itself, so no caller
/// can forget it).
WorldRankBreakdown ComputeRank(const std::vector<WorldCommanderRecord>& commanders,
                               int poisHeld, const WorldHoldings& holdings,
                               const WorldStatRules& rules, int64_t nowWorldMs);

// ─────────────────────────── the store ────────────────────────────────────

/// Static, like WorldDirector and WorldFactions: no per-instance state, and
/// the handle is the lobby's shared one.
class WorldStats {
public:
    /// Create `world_commanders` + `world_authority_events`, and add W8's two
    /// capacity-bookkeeping columns to W7's `world_authority`. ADDITIVE only
    /// (ALTER TABLE ADD COLUMN, whose duplicate-column failure on a current
    /// schema is the expected outcome and is ignored) — same rule as
    /// everywhere else in this layer: these rows are the only copy.
    static void EnsureTables(sqlite3* db);

    // ── commanders ─────────────────────────────────────────────────────────

    static bool UpsertCommander(sqlite3* db, const WorldCommanderRecord& c);
    static std::optional<WorldCommanderRecord> LoadCommander(
        sqlite3* db, const std::string& worldId, const std::string& commanderId);
    static std::vector<WorldCommanderRecord> CommandersFor(sqlite3* db,
                                                          const std::string& worldId);
    /// Everything this account OWNS, on loan or not — the caller (or
    /// `ComputeRank`) applies C27's exclusion.
    static std::vector<WorldCommanderRecord> CommandersOwnedBy(
        sqlite3* db, const std::string& worldId, int64_t accountId);
    /// Active commanders stationed at a POI, whoever owns them. The garrison,
    /// and attribution's input.
    static std::vector<WorldCommanderRecord> CommandersAtPoi(
        sqlite3* db, const std::string& worldId, const std::string& poiId);

    /// Mint a commander. The ONLY writer of a new commander row: acquisition
    /// (promotion, capture, purchase) is later work, and routing it all
    /// through one call is what keeps `authority_at_world_ms` stamped and the
    /// id unique.
    static std::optional<WorldCommanderRecord> GrantCommander(
        sqlite3* db, const std::string& worldId, int64_t accountId,
        const std::string& username, const std::string& factionId,
        const std::string& poiId, double authority, int64_t nowRealMs,
        int64_t nowWorldMs);

    /// C17's threshold grant: give an account its first commander in this
    /// world once it holds `commanderGrantAuthority`, and never a second one
    /// this way. Idempotent and safe to call from a read — which is where it
    /// is called from, because W8 has no tick.
    ///
    /// Returns the granted commander, or nullopt when the account already has
    /// one or has not cleared the threshold (both ordinary, not failures).
    static std::optional<WorldCommanderRecord> EnsureStarterCommander(
        sqlite3* db, const std::string& worldId, int64_t accountId,
        const std::string& username, double worldAuthority,
        const WorldStatRules& rules, int64_t nowRealMs, int64_t nowWorldMs);

    // ── authority accrual ──────────────────────────────────────────────────

    /// Walk the settlement ledger and award what has not been awarded yet.
    /// Returns the number of NEW awards written. Idempotent (see the header):
    /// calling it on every read is the design, not a tolerated cost.
    static int AccrueFromSettlements(sqlite3* db, const std::string& worldId,
                                     const WorldStatRules& rules,
                                     int64_t nowRealMs, int64_t nowWorldMs);

    /// Append one award and roll it into the commander's stored value (decayed
    /// to `nowWorldMs` first, then stamped there). Refuses a duplicate
    /// `(source, sourceKey)` silently — that refusal IS the idempotence.
    static bool AwardAuthority(sqlite3* db, const WorldAuthorityEventRecord& e,
                               const WorldStatRules& rules);

    static std::vector<WorldAuthorityEventRecord> EventsFor(
        sqlite3* db, const std::string& worldId, const std::string& commanderId);

    // ── capacity ───────────────────────────────────────────────────────────

    /// The account's order budget now, normalising the row's recharge
    /// bookkeeping as a side effect (see `NormalizeCapacity`). `worldAuthority`
    /// is NOT an input: the ceiling comes from the player's COMMANDERS, which
    /// is what C23's linkage says.
    static WorldCapacityState CapacityFor(sqlite3* db, const std::string& worldId,
                                          int64_t accountId,
                                          const WorldStatRules& rules,
                                          int64_t nowRealMs, int64_t nowWorldMs);

    /// Debit the budget. False when there is not enough left — the caller
    /// must then refuse the order rather than let it through unpaid. No route
    /// calls this yet (orders against the world layer are a later milestone);
    /// it ships with the budget because a budget with no debit is a display,
    /// and the recharge rule can only be tested against real spending.
    static bool SpendCapacity(sqlite3* db, const std::string& worldId,
                              int64_t accountId, double amount,
                              const WorldStatRules& rules,
                              int64_t nowRealMs, int64_t nowWorldMs);

    // ── rank (derived, never stored) ───────────────────────────────────────

    /// The account's rank in whatever faction it belongs to in this world.
    /// Reads holdings, computes, returns — there is no rank row to write, and
    /// `world_faction_members.rank` is deliberately left alone (see the
    /// header: it is legacy).
    static WorldRankBreakdown RankFor(sqlite3* db, const std::string& worldId,
                                      int64_t accountId, const WorldStatRules& rules,
                                      int64_t nowWorldMs);

    // ── the read-only HTTP surface, as data ────────────────────────────────

    /// `GET /api/world/stats` — the world's standings: the rates in force, the
    /// commander authority table, and every faction's members with their
    /// DERIVED rank. Public, like the faction roster: standing inside a
    /// faction is the thing votes are weighted by, so it cannot be secret.
    static nlohmann::json StatsJson(sqlite3* db, const std::string& worldId,
                                    const WorldStatRules& rules,
                                    int64_t nowRealMs, int64_t nowWorldMs);

    /// Merge one account's stats onto `WorldFactions::MeJson`'s body:
    /// `commanders`, `capacity`, `rank`. Same "the other director merges what
    /// it knows at the transport layer" idiom as
    /// `WorldFactions::AttachFactions` — MeJson stays a faction answer and
    /// does not learn about commanders.
    ///
    /// This is also where the two lazy writes W8 allows happen (the starter
    /// grant and settlement accrual), because the player panel is the one
    /// read that is always about a specific account.
    static nlohmann::json AttachMeStats(nlohmann::json me, sqlite3* db,
                                        const std::string& worldId, int64_t accountId,
                                        const std::string& username,
                                        const WorldStatRules& rules,
                                        int64_t nowRealMs, int64_t nowWorldMs);
};
