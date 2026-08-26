// WorldEscrow — the world↔battle escrow seam: force committed to a battle is
// held in escrow, handed to the war as an arrival manifest, and settled ONCE
// when the war ends.
//
// Design sources, all of which this file is the lobby-side execution of:
//   - PLAN-metalstorm-transports.md §7.3: a committed force is in exactly one
//     of three ledger states (in transit out / engaged / in transit home) and
//     it is escrowed — unavailable to the world — in all of them. "Spoils and
//     credit settle once, at battle end … *forces* settle per arrival."
//   - PLAN-metalstorm-transports.md §7.5: the outcome vocabulary
//     (`held | withdrew | routed | annihilated`) and its payout table. The
//     25%-capture rule for an annihilated expedition is the comeback pressure
//     valve worldbuilding W5 asks for.
//   - PLAN-metalstorm-worldbuilding.md §"Battle Staging": payment is "a single
//     event, no mid-battle trickle".
//
// ── Hard boundaries this file keeps ─────────────────────────────────────────
//   1. The world layer never touches sim state. Everything here is lobby-side
//      SQLite; the battle consumes arrivals through gadget-visible config (the
//      `world_commit` modoption, encoded by `EncodeWorldCommitModOption`) and
//      reports back only through the war machinery the lobby already reads
//      (`war_outcome`).
//   2. Settlement writes are APPEND-ONLY ledger rows applied exactly once.
//      `world_force_ledger` is never UPDATEd; a faction's standing force is
//      SUM over its rows, exactly the discipline `world_economy_events` keeps
//      for treasury (WorldEconomy.h). Exactly-once is enforced by the escrow
//      rows' own state machine: `Settle` flips `engaged → settled` under a
//      guard and appends payout rows only for rows the flip actually moved,
//      in one transaction — so a war-end replay (a second sweep, a lobby
//      restart mid-archive) flips zero rows and appends nothing.
//   3. No `war*` table is read or written here. `room_id` is a LABEL on the
//      escrow row, exactly as it is on `world_staging` (W10) and
//      `world_settlement_ledger` (W6). The caller (the lobby's war-lifecycle
//      sweep — the one place holding both a world handle and a war handle,
//      the W6 precedent) maps the war's ending onto `WorldEscrowSettleFacts`.
//
// ── The escrow row's state machine ──────────────────────────────────────────
//
//      Commit ─────────► committed ──MarkEngaged──► engaged ──Settle──► settled
//                            │                                   (payout rows)
//                        Release (cancel, terminal
//                            │   staging failure)
//                            ▼
//                        released (refund rows)
//
//   One escrow row PER COMMITMENT — a late commitment that JOINS an open
//   staging window (§7.2) opens its own escrow row, so "who committed what"
//   survives the staging row's counters being summed. This is the
//   per-transport granularity the world currently counts; when the world
//   gains per-asset identity a later milestone adds a manifest column, not a
//   new table.
//
// ── What is deliberately NOT here ───────────────────────────────────────────
//   - Conquest / POI ownership transfer. A sibling lane implements the
//     explicit claim act against the same war-end path; this file's
//     settlement is additive beside it and decides nothing about who owns
//     the POI afterwards.
//   - `in_transit_home` (§7.3's third state) and per-arrival force return.
//     v1 settles the whole engagement at war end; the per-departure trickle
//     needs the battle's withdrawal counters to reach a durable row first
//     (they live in perishable rulesParams today — see WarOutcome.h).
//   - Availability enforcement. Committing force a faction does not have is
//     refused by nothing yet: the force ledger opens NEGATIVE on the first
//     commit, which is honest bookkeeping ("this faction owes the world a
//     seeding of holdings") until a world-holdings milestone seeds opening
//     balances.
//
// ── Numbers are data (pillar 7) ─────────────────────────────────────────────
// The capture fraction, the withdrew threshold and the held-spoils payment
// are keys in the world's `config_json`, defaulted here and resolved per key
// by `WorldEscrowRules::FromWorldConfig` — same discipline as every other
// rate family in this layer.

#pragma once

#include <cstdint>
#include <optional>
#include <string>
#include <vector>

#include <nlohmann/json.hpp>

#include "WorldStaging.h"

struct sqlite3;

// ─────────────────────────── the per-world rates ───────────────────────────

/// Every number the escrow seam uses, resolved for ONE world.
struct WorldEscrowRules {
    /// §7.5: an annihilated (or routed-remainder) expedition is a TRANSFER,
    /// not a bonfire — this fraction of its materiel appears in the victor's
    /// holdings as captured; the rest is destroyed.
    double annihilatedCaptureFraction = 0.25;
    /// §7.5's withdrew/routed threshold: at least this fraction of the
    /// committed force must have departed by transport for the ending to
    /// count as `withdrew` rather than `routed`.
    double withdrewThresholdFraction = 0.50;
    /// The treasury spoils a `held` outcome pays the holding faction at
    /// settlement, appended to `world_economy_events` as one `war_spoils`
    /// row. §7.5's "full spoils", priced as a flat rate until objectives
    /// carry a richer figure across the seam.
    double heldSpoilsTreasury = 25.0;

    static WorldEscrowRules FromWorldConfig(const nlohmann::json& worldConfig);
};

// ─────────────────────────── vocabulary ────────────────────────────────────

/// `world_escrow.state`. `released` and `settled` are kept apart on purpose:
/// "this force never fought" (refund) and "this force fought and was priced"
/// (payout) are different facts and a ledger reader is owed the difference.
enum class WorldEscrowState : uint8_t {
    Committed,  ///< §7.3 `in_transit_out`: escrowed, travelling to the battle
    Engaged,    ///< §7.3 `engaged`: the war materialised and holds this force
    Released,   ///< never fought — staging cancelled or terminally failed
    Settled,    ///< the war ended and this row was priced, exactly once
};

const char* WorldEscrowStateToString(WorldEscrowState s);
WorldEscrowState WorldEscrowStateFromString(const std::string& s);

/// §7.5's outcome vocabulary, as the world prices it.
enum class WorldEscrowOutcome : uint8_t { Held, Withdrew, Routed, Annihilated };

const char* WorldEscrowOutcomeToString(WorldEscrowOutcome o);

// ─────────────────────────── the rows ──────────────────────────────────────

/// One commitment's escrow — `world_escrow`.
struct WorldEscrowRecord {
    int64_t     escrowId = 0;
    std::string worldId;
    /// The staging window this commitment rode in on. The escrow row outlives
    /// the window (a settled row is the audit trail), so this is a real key,
    /// unlike `roomId`.
    int64_t     stagingId = 0;
    std::string poiId;
    /// The world faction whose force this is — the faction that gets the
    /// refund or the return, never the account.
    std::string factionId;
    int         transports = 0;
    int         squads     = 0;
    int64_t     committedByAccountId = 0;
    WorldEscrowState state = WorldEscrowState::Committed;
    /// The war this escrow engaged with. A LABEL (rooms are reused), same
    /// rule as `world_staging.room_id`.
    uint32_t    roomId = 0;
    /// Why the row left `engaged`/`committed`: a `WorldEscrowOutcomeToString`
    /// value for settled rows, "cancelled"/"staging_failed" for released
    /// ones, empty while live.
    std::string outcome;
    int64_t     createdAt  = 0;
    int64_t     engagedAt  = 0;
    int64_t     resolvedAt = 0;

    bool IsHeld() const {
        return state == WorldEscrowState::Committed ||
               state == WorldEscrowState::Engaged;
    }
};

/// A `world_force_ledger` row — one signed movement of materiel, append-only.
/// The ledger IS a faction's standing force: nothing sums these into a stored
/// column (the WorldEconomy discipline, applied to transports/squads).
struct WorldForceLedgerRow {
    int64_t     rowId = 0;
    std::string worldId;
    std::string factionId;
    /// "escrow_commit" (negative: force leaves the available pool) |
    /// "escrow_release" (refund) | "settlement_return" (survivors come home) |
    /// "settlement_capture" (the victor's 25% of an annihilated expedition).
    std::string source;
    int         transports = 0;
    int         squads     = 0;
    int64_t     stagingId  = 0;
    uint32_t    roomId     = 0;
    int64_t     recordedAt = 0;
};

/// SUM over a faction's `world_force_ledger` rows. Negative is legal — see
/// the header's availability note.
struct WorldForceBalance {
    int transports = 0;
    int squads     = 0;
};

// ─────────────────────────── pure policy ───────────────────────────────────

/// §7.5's classification, in exactly one place. `attackerWon` is the war
/// machinery's verdict (the side this escrow fielded is among the winner
/// factions); the withdrawal pair prices the losing endings. A loser with no
/// recorded departure is `annihilated`; with departures it is `withdrew` at
/// or above the threshold fraction and `routed` below it. Withdrawal counts
/// are not yet durable across the seam (see the header), so today's callers
/// pass 0 — the function takes them anyway so the rule is complete, tested,
/// and does not change shape when the conduit lands.
WorldEscrowOutcome ClassifyEscrowOutcome(bool attackerWon, int withdrawnUnits,
                                         int committedUnits,
                                         const WorldEscrowRules& rules);

/// What one escrow row's materiel does at settlement, per §7.5's table.
/// Everything not returned and not captured was destroyed.
struct WorldEscrowPayout {
    int returnTransports  = 0;  ///< back to the owning faction
    int returnSquads      = 0;
    int captureTransports = 0;  ///< to the victor
    int captureSquads     = 0;
};

/// §7.5's payout arithmetic over one row's counts. `withdrawnFraction` is the
/// share of the committed force that departed (0 for `held`/`annihilated`;
/// the classified fraction for `withdrew`/`routed`). Integer counts floor —
/// a fraction of a transport does not come home.
WorldEscrowPayout PayoutFor(WorldEscrowOutcome outcome, int transports,
                            int squads, double withdrawnFraction,
                            const WorldEscrowRules& rules);

/// The arrival manifest, as the one gadget-visible string the boot manifest
/// carries: `sideKey:transports:squads:stagingId`. The battle side derives
/// geometry (entry points, drop zones) itself — the world knows no map
/// coordinates, deliberately. Parsed by game_transports.lua; encoded here so
/// the two ends share one spelling and the encoder is testable without a war.
std::string EncodeWorldCommitModOption(const std::string& sideKey,
                                       int transports, int squads,
                                       int64_t stagingId);

// ─────────────────────────── settlement inputs ─────────────────────────────

/// The war's ending, as the CALLER mapped it onto escrow vocabulary. Kept as
/// data rather than derived here so this file never reads a `war*` table
/// (hard boundary 3).
struct WorldEscrowSettleFacts {
    WorldEscrowOutcome outcome = WorldEscrowOutcome::Annihilated;
    /// Captures land in this faction's ledger. Empty = no victor to capture
    /// (a draw, an unowned POI) — the captured share is destroyed instead,
    /// which is the conservative reading of §7.5.
    std::string victorFactionId;
    /// The share of the committed force that departed by transport, for
    /// `withdrew`/`routed` pricing. 0 for `held`/`annihilated`.
    double withdrawnFraction = 0.0;
};

/// What `Settle` did. `settled == false` means the guard found nothing
/// engaged — the war was already settled (the replay case) or never held
/// escrow at all; either way nothing was written.
struct WorldEscrowSettleResult {
    bool settled = false;
    int  rows    = 0;   ///< escrow rows flipped engaged → settled
    WorldEscrowPayout payout;  ///< summed over those rows
};

// ─────────────────────────── the store ─────────────────────────────────────

/// Static, like every other director in this layer.
class WorldEscrow {
public:
    /// Create `world_escrow` + `world_force_ledger`. ADDITIVE only — same
    /// rule as every other table in this layer.
    static void EnsureTables(sqlite3* db);

    /// Escrow ONE commitment's force: append the escrow row plus its
    /// `escrow_commit` ledger debit, atomically. Called beside every
    /// successful `WorldStaging::Commit` with THAT COMMIT's counts (a join
    /// commit escrows what it added, not the window's new total).
    static std::optional<WorldEscrowRecord> Open(sqlite3* db,
                                                 const WorldStagingRecord& staging,
                                                 int transports, int squads,
                                                 int64_t accountId,
                                                 int64_t nowRealMs);

    static std::optional<WorldEscrowRecord> Load(sqlite3* db, int64_t escrowId);
    /// Every escrow row a staging window holds, oldest first.
    static std::vector<WorldEscrowRecord> ForStaging(sqlite3* db, int64_t stagingId);

    /// The staging materialised as `roomId`: flip its `committed` rows to
    /// `engaged`. Guarded on state, so a replayed sweep moves nothing twice.
    /// Returns the number of rows flipped.
    static int MarkEngaged(sqlite3* db, int64_t stagingId, uint32_t roomId,
                           int64_t nowRealMs);

    /// The window died before contact (cancel, terminal materialise failure):
    /// flip `committed` rows to `released` and refund each with an
    /// `escrow_release` ledger row, atomically. Guarded on state — a second
    /// call flips zero rows and refunds nothing. Returns rows released.
    static int Release(sqlite3* db, int64_t stagingId, const std::string& reason,
                       int64_t nowRealMs);

    /// Staging ids that hold ENGAGED escrow against `roomId` — the war-end
    /// sweep's question. Room ids are reused; the state guard is what keeps a
    /// previous war's settled escrow out of this answer.
    static std::vector<int64_t> EngagedStagingsForRoom(sqlite3* db, uint32_t roomId);

    /// THE single settlement (§7.3/§7.5): flip this staging's `engaged` rows
    /// to `settled` and append the payout — `settlement_return` rows to the
    /// owning faction, `settlement_capture` rows to the victor, and (for
    /// `held`) one `war_spoils` treasury row into `world_economy_events` —
    /// all in one transaction, gated on the flip having moved at least one
    /// row. Calling it again for the same staging finds nothing engaged and
    /// writes NOTHING: that guard is the exactly-once promise, and it holds
    /// across lobby restarts because the guard is the rows' own state.
    static WorldEscrowSettleResult Settle(sqlite3* db, int64_t stagingId,
                                          const WorldEscrowSettleFacts& facts,
                                          const WorldEscrowRules& rules,
                                          int64_t nowWorldMs, int64_t nowRealMs);

    /// A faction's standing force: SUM over its ledger. Zero rows = zero
    /// force, and negative is legal (see the header).
    static WorldForceBalance ForceBalanceFor(sqlite3* db,
                                             const std::string& worldId,
                                             const std::string& factionId);

    static std::vector<WorldForceLedgerRow> LedgerFor(sqlite3* db,
                                                      const std::string& worldId,
                                                      const std::string& factionId);

    /// One escrow row as JSON, for the staging/POI panels.
    static nlohmann::json EscrowJson(const WorldEscrowRecord& r);
};
