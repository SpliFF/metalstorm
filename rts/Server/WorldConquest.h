// WorldConquest — the conquest rule: POI ownership changes at war end via an
// EXPLICIT CLAIM ACT (USER-DECIDED 2026-08-27 — PLAN-worldsim.md phase 3 §5).
//
// ── Why "winner takes the POI" cannot be the rule ──────────────────────────
// `WarOutcomeRecord::winnerFactions` names the winning SIDE's side keys
// (sidedata names), and many world factions can share one side
// (`world_factions.side_key` is the only bridge — WorldFactions.h). So a
// settlement row alone cannot say WHICH world faction takes the ground, and
// pretending it can would hand every POI on a side's front to whichever
// faction string-matched first. Hence the decided rule:
//
//   **Ownership transfers at war end only to a winning-side faction that had
//   filed an explicit CLAIM on that POI before the war ended. With no valid
//   claim, the current owner keeps the POI.**
//
// The full rule, as `SettleWar` applies it (each clause tested):
//
//   1. A claim is an act with a COST: filing charges `claimPoiCost` world
//      authority to the filing account, through the existing W7 authority
//      machinery (`WorldFactions::AuthorityFor` + `AdjustAuthority` — the
//      same spend path the founding gate uses). The claim row records the
//      charge, so the audit trail survives a later config change.
//   2. At war end (the settlement chokepoint in rts/lobby_main.cpp's
//      lifecycle sweep, right after `WorldDirector::RecordSettlement`):
//      a war with NO in-sim winner (`factions` empty — operator retire,
//      season end) resolves nothing; every claim stays open.
//   3. Every open claim whose faction's side key is NOT named in the winning
//      side resolves as **"lost"**, refunding `claimRefundFraction` of its
//      recorded cost to the filing account (0 = forfeits — refund-or-forfeit
//      is one config knob, not two states).
//   4. **The defender's shield**: if the POI's current owner is itself on
//      the winning side, the ground was successfully defended and does NOT
//      change hands — an allied claim cannot snipe a POI its own side just
//      held. The owner's own open claim (possible when ownership moved to it
//      after filing) resolves as "won" with no transfer; other winning-side
//      claims stay open.
//   5. Otherwise the winning claim is the EARLIEST open winning-side claim:
//      minimum `filed_at_world_ms`, ties broken by `claim_id` (rowid — file
//      order), which is fully deterministic. Ownership transfers to it
//      (`WorldDirector::SetPoiOwner`); the claim resolves as "won" and is
//      never refunded — the cost is the price of conquest.
//   6. Winning-side claims that lost the tie stay OPEN, queued (earliest
//      first) for the next war at that POI — still subject to expiry.
//   7. A claim expires `claimExpiryWorldMs` of WORLD time after filing
//      (an admin pause therefore freezes expiry, like everything else on
//      this clock; 0 disables expiry), refunding at the same fraction.
//      Withdrawal (any member of the claiming faction, mirroring the staging
//      cancel route's authorisation) refunds at the same fraction too — a
//      free withdrawal would make every claim risk-free.
//
// ── Boundaries (the lane's, unchanged) ─────────────────────────────────────
// `world_poi_claims` is keyed by `world_id`, never `room_id`; the only
// battle-shaped input is the W6 settlement row, itself world-scoped, and
// `settlement_id` on a resolved claim is a label into that world ledger, not
// a join back into any `war*` table. Nothing here reads sim state.
//
// ── Numbers are data (pillar 7) ────────────────────────────────────────────
// All three rates are keys in the world's `config_json`, defaulted in
// `WorldDefaults` (WorldDirector.h) and resolved per key by
// `WorldConquestRules::FromWorldConfig` — a world seeded before this
// milestone must not have the rule silently disabled by a missing key.

#pragma once

#include <cstdint>
#include <optional>
#include <string>
#include <vector>

#include <nlohmann/json.hpp>

#include "WorldDirector.h"
#include "WorldFactions.h"

struct sqlite3;

// ─────────────────────────── the per-world rates ───────────────────────────

/// Every number the conquest rule uses, resolved for ONE world.
struct WorldConquestRules {
    /// World authority charged to the filing ACCOUNT when a claim is filed.
    double claimPoiCost = 25.0;
    /// The fraction of the recorded cost returned when a claim resolves any
    /// way but "won" (lost, expired, withdrawn). 1.0 = full refund, 0.0 =
    /// forfeit. One knob on purpose: three separately-tunable refunds invite
    /// an arbitrage loop (withdraw just before losing) that one rate cannot.
    double claimRefundFraction = 0.5;
    /// WORLD ms after filing at which an unresolved claim expires (refunded
    /// at the fraction above). <= 0 disables expiry. World ms, so an admin
    /// pause freezes claim lifetimes along with everything else.
    double claimExpiryWorldMs = 30.0 * 24.0 * 3600.0 * 1000.0;  // 30 world days

    static WorldConquestRules FromWorldConfig(const nlohmann::json& worldConfig);
};

// ─────────────────────────── the rows ──────────────────────────────────────

/// `world_poi_claims.state`. "won" is terminal-and-transferred (or confirmed
/// — see the defender's shield); the three non-won terminals are kept apart
/// because a player is owed the difference between "your side lost", "nobody
/// fought over it in time" and "you called it off".
enum class WorldClaimState : uint8_t {
    Open,       ///< filed, unresolved; the next settlement at the POI reads it
    Won,        ///< a war settled in the claimant's favour
    Lost,       ///< a war settled at the POI and the claimant's side was not named
    Expired,    ///< `claimExpiryWorldMs` elapsed with no resolving war
    Withdrawn,  ///< the claiming faction called it off
};

const char* WorldClaimStateToString(WorldClaimState s);
WorldClaimState WorldClaimStateFromString(const std::string& s);

/// One `world_poi_claims` row — one faction's filed claim on one POI.
struct WorldPoiClaimRecord {
    /// The row's own rowid, filled on read and ignored on write. The
    /// deterministic tie-break (rule 5) and the refund audit both key on it.
    int64_t     claimId = 0;
    std::string worldId;
    std::string poiId;
    /// The claiming world faction. A claim is the FACTION's act even though
    /// one member filed and paid for it — same attribution rule as a staging
    /// commitment.
    std::string factionId;
    /// The member that filed it: the label the UI shows, and the account the
    /// charge was taken from and any refund returns to.
    int64_t     accountId = 0;
    /// What filing actually charged, recorded so a refund refunds what was
    /// paid even if `claimPoiCost` has been retuned since.
    double      cost = 0.0;
    /// What resolution actually returned (0 while open, and 0 on "won").
    double      refund = 0.0;
    WorldClaimState state = WorldClaimState::Open;
    /// WORLD clock at filing — the tie-break key, and what expiry is measured
    /// from.
    int64_t     filedAtWorldMs = 0;
    int64_t     filedAt = 0;      ///< real ms
    int64_t     resolvedAt = 0;   ///< real ms, 0 while open
    /// The `world_settlement_ledger` rowid that resolved this claim (won or
    /// lost). A LABEL into the world's own ledger — never a war-table key.
    /// 0 while open and for expiry/withdrawal, which no war caused.
    int64_t     settlementId = 0;

    bool IsOpen() const { return state == WorldClaimState::Open; }
};

/// What a file attempt asked for. The route fills `factionId` from the
/// account's membership — a claim in somebody else's name is refused the same
/// way a staging commitment in one is.
struct WorldClaimFileRequest {
    std::string worldId;
    std::string poiId;
    std::string factionId;
    int64_t     accountId = 0;
};

/// Everything a file attempt can answer with. `error` is a stable machine
/// token in the `WorldFactionFoundResult` idiom.
struct WorldClaimFileResult {
    bool ok = false;
    /// "" | "no_poi" | "no_faction" | "already_owner" | "already_claimed" |
    /// "insufficient_authority" | "db_error".
    std::string error;
    /// Only meaningful on `insufficient_authority` — the UI's "you have X of
    /// Y" line, same as founding.
    double have = 0.0;
    double need = 0.0;
    std::optional<WorldPoiClaimRecord> claim;
};

/// What one settlement did to the claim table and the map.
struct WorldConquestSettlementResult {
    bool        ownershipChanged = false;
    /// Filled whenever the settlement had a winner and the POI exists, even
    /// when nothing changed — the caller's log line wants both names.
    std::string previousOwnerFactionId;
    std::string newOwnerFactionId;
    int64_t     winningClaimId = 0;
    int         claimsResolvedLost = 0;
    int         claimsExpired = 0;
    /// Total authority returned across every refund this pass made.
    double      refunded = 0.0;
};

// ─────────────────────────── pure policy ───────────────────────────────────

/// One (faction id → side key) pair, as `SelectWinningClaim` consumes them —
/// passed in rather than looked up so the tie-break rule is testable with no
/// database and no war.
struct WorldClaimFactionSide {
    std::string factionId;
    std::string sideKey;
};

/// Rule 5: the claimId of the earliest open claim whose faction's side key is
/// named in `winnerFactions` (comma-separated side keys, parsed by
/// `SettlementNamesFaction`), ties on `filedAtWorldMs` broken by the smaller
/// `claimId`. Claims whose faction has no entry in `factionSides` (or an
/// empty side key) can never win — a faction that fields no side cannot have
/// won the war. nullopt when no claim qualifies.
std::optional<int64_t> SelectWinningClaim(
    const std::vector<WorldPoiClaimRecord>& openClaims,
    const std::vector<WorldClaimFactionSide>& factionSides,
    const std::string& winnerFactions);

// ─────────────────────────── the store ─────────────────────────────────────

/// Static, like every other director in this layer: no per-instance state,
/// and the handle is the lobby's shared one.
class WorldConquest {
public:
    /// Create `world_poi_claims`. ADDITIVE only — these rows are the only
    /// record of who paid for what.
    static void EnsureTables(sqlite3* db);

    /// The whole filing act as one call (validate, check the gate, charge,
    /// insert), for the same reason `WorldFactions::Found` is one call: a
    /// charge with no claim row is a state nothing recovers from.
    /// `factionRules` is needed because the authority read
    /// (`WorldFactions::AuthorityFor`) creates a first-contact row at the
    /// world's starting grant.
    static WorldClaimFileResult FileClaim(sqlite3* db,
                                          const WorldConquestRules& rules,
                                          const WorldFactionRules& factionRules,
                                          const WorldClaimFileRequest& req,
                                          int64_t nowWorldMs, int64_t nowRealMs);

    static std::optional<WorldPoiClaimRecord> Load(sqlite3* db, int64_t claimId);
    /// Open claims on one POI, in tie-break order (filedAtWorldMs, claimId).
    static std::vector<WorldPoiClaimRecord> OpenClaimsAt(sqlite3* db,
                                                         const std::string& worldId,
                                                         const std::string& poiId);
    /// Every claim in a world, newest first — the history a panel shows.
    static std::vector<WorldPoiClaimRecord> ClaimsFor(sqlite3* db,
                                                      const std::string& worldId);

    /// Withdraw an open claim (rule 7's second half): refunds
    /// `claimRefundFraction` of the recorded cost to the filing account and
    /// flips the row to `withdrawn`. False when the claim is not open (or not
    /// there) — resolution won the race, and the resolution stands.
    static bool Withdraw(sqlite3* db, const WorldConquestRules& rules,
                         const std::string& worldId, int64_t claimId,
                         int64_t nowRealMs);

    /// Rule 7's first half: expire every open claim in the world whose
    /// `filedAtWorldMs + claimExpiryWorldMs` has passed, refunding each.
    /// Returns how many expired. Driven by the lobby's world sweep on the
    /// same cadence as the economic tick; a paused world's frozen `worldMs`
    /// expires nothing, for free.
    static int ExpireClaims(sqlite3* db, const std::string& worldId,
                            const WorldConquestRules& rules,
                            int64_t nowWorldMs, int64_t nowRealMs);

    /// Rules 2–6, applied to ONE settlement row (whose `settlementId` the
    /// caller has — `WorldDirector::RecordSettlement` returns it). Expires
    /// due claims at the POI first, so a claim that outlived its window can
    /// never win the war that ended after it lapsed. Idempotent in the way
    /// the sweep needs: claims are resolved by UPDATEs guarded on
    /// `state='open'`, so replaying a settlement against already-resolved
    /// claims changes nothing and refunds nothing twice.
    static WorldConquestSettlementResult SettleWar(
        sqlite3* db, const WorldSettlementRecord& settlement,
        const WorldConquestRules& rules, int64_t nowWorldMs, int64_t nowRealMs);

    // ── the read-only surface, as data ─────────────────────────────────────

    /// `GET /api/world/claims` — every claim in the world (newest first),
    /// plus the rates in force so a client can price the button it renders.
    static nlohmann::json ClaimsJson(sqlite3* db, const std::string& worldId,
                                     const WorldConquestRules& rules);

    /// One claim as JSON, in the shape `ClaimsJson` embeds.
    static nlohmann::json ClaimJson(const WorldPoiClaimRecord& c);
};
