// WorldFactions — world-scoped player factions, their membership, and the
// authority that gates founding one.
//
// PLAN-worldsim.md W7. Design: PLAN-metalstorm-worldbuilding.md §4 ("Faction
// archetypes — players make their own factions") + Capture 2 (archetypes
// supersede locked factions), Capture 7 (the core parameter set), Capture 23
// (Authority is a stat that grows slowly), Capture 24 (Rank is faction
// standing) and Capture 25 (the governance model is a per-faction ruleset).
//
// ── What this is, and what it deliberately is not ──────────────────────────
// A WORLD faction is a player-founded organisation inside one persistent
// world: a name, an archetype it was cast from, a parameter sheet it may
// deviate from, a governance ruleset, a colour, and a member roster. It is
// created by a player, joined by players, and it owns POIs.
//
// It is NOT `users.faction_id`. That column is the game's SIDE key — a
// lowercased `name` out of `gamedata/sidedata.lua` (FactionData.h), permanent
// from sign-up with only an audited admin override (GuestAccounts.h's §1a
// note), and what the battle layer seats a player on. The two answer
// different questions, and the seam between them is stated once, here, so no
// caller has to guess:
//
//   * `world_faction_members` is the AUTHORITY for "which faction is this
//     player in" at the world layer. Nothing else may be consulted for it.
//   * `world_factions.side_key` says which sidedata side a faction FIELDS in
//     battle. It is the only bridge between the layers.
//   * `users.faction_id` stays the battle side key and is never overwritten
//     with a world faction id. The two are kept from diverging by refusing
//     the join that would diverge them, not by a sync job: see
//     `ReconcileSideKey` below. A sync job would have to choose which side
//     wins on conflict, and both answers are wrong (one silently re-sides a
//     confirmed account, the other leaves a member who cannot be seated).
//
// The hard boundary of the whole lane holds here: nothing in this file reads,
// writes or joins a `war*` table, and no column below is keyed by `room_id`.
// A faction is a thing in a world; a war is one battle inside it.
//
// ── Numbers are data (pillar 7 / Capture 26) ───────────────────────────────
// The archetype sheets in this header are DEFAULTS ONLY: founding copies the
// chosen sheet into the row's `config_json`, and the row is the authority
// afterwards, so tuning a faction never needs a rebuild. Every rate the
// founding gate uses (threshold, cost, starting authority, name caps) lives
// in the WORLD's `config_json` (WorldDefaults), read through
// `WorldFactionRules::FromWorldConfig` — which falls back per key, because a
// world seeded by an older build has a blob that predates these keys and a
// missing key must not disable the rule it configures.

#pragma once

#include <cstdint>
#include <optional>
#include <string>
#include <vector>

#include <nlohmann/json.hpp>

struct sqlite3;

// ─────────────────────────── archetypes ────────────────────────────────────

/// The four archetypes of §4. Keys are stable ids — they are written into
/// rows and sent to clients, so they are lowercase ASCII and never the
/// display name. "dynasty" is §4's own working name for the wealth/prestige
/// archetype.
inline constexpr const char* kArchetypeOrder      = "order";
inline constexpr const char* kArchetypeDynasty    = "dynasty";
inline constexpr const char* kArchetypeResistance = "resistance";
inline constexpr const char* kArchetypeAnarchic   = "anarchic";

/// §4's H/M/L matrix, as numbers. The matrix is expressed in three bands with
/// half-steps ("M-H", "L-M"), so the scale is quarters of the 0..1 range:
/// L=0.25, M=0.5, H=0.75, and a half-step is the midpoint. Nothing multiplies
/// these yet — the mechanical hooks are later milestones — so the scale's job
/// today is only to preserve the ORDERING the design matrix states.
struct WorldFactionParameters {
    double diplomacy   = 0.5;
    double command     = 0.5;
    double finance     = 0.5;
    double production  = 0.5;
    double mining      = 0.5;
    double intel       = 0.5;
    double electronics = 0.5;
    double loyalty     = 0.5;
    double technology  = 0.5;
    double archaeology = 0.5;

    nlohmann::json ToJson() const;
    static WorldFactionParameters FromJson(const nlohmann::json& j);
};

/// One archetype's whole property sheet — §4's "a small data-driven property
/// sheet, not code": the ratings, the naming register that feeds generated
/// names and NL vocabulary, and the governance ruleset of Capture 25.
struct WorldFactionArchetype {
    std::string key;
    std::string name;
    std::string description;
    /// "formal" | "dynastic" | "cause" | "street" — the naming register.
    std::string nameRegister;
    /// Capture 25's spectrum: "hierarchical" | "council" | "consensus" |
    /// "minimal". A string, not an enum, because a faction may deviate and a
    /// world may ship a ruleset this build has never heard of.
    std::string governance;
    /// The default colour a faction cast from this archetype paints its POIs
    /// with, until the founder picks one.
    std::string colour;
    WorldFactionParameters parameters;

    nlohmann::json ToJson() const;
};

/// The four sheets, in the order §4 tables them. Const data, one place.
const std::vector<WorldFactionArchetype>& WorldFactionArchetypes();

/// The sheet for `key`, or nullopt. Callers that need "or the default" say so
/// explicitly rather than getting a silent Order-shaped faction.
std::optional<WorldFactionArchetype> WorldFactionArchetypeFor(const std::string& key);

// ─────────────────────────── the per-world rules ───────────────────────────

/// The founding gate's numbers, resolved for ONE world. Built from that
/// world's `config_json` with a per-key fallback to `WorldDefaults` — a blob
/// written before these keys existed (or hand-edited to drop one) must not
/// turn the rule it configures off.
struct WorldFactionRules {
    double startingAuthority     = 100.0;
    double foundFactionAuthority = 100.0;
    double foundFactionCost      = 50.0;
    int    nameMinLen            = 3;
    int    nameMaxLen            = 32;

    static WorldFactionRules FromWorldConfig(const nlohmann::json& worldConfig);
};

// ─────────────────────────── the rows ──────────────────────────────────────

/// A `world_factions` row.
struct WorldFactionRecord {
    std::string worldId;
    /// Slug derived from the name at founding (`SlugifyFactionName`), unique
    /// within the world. A slug rather than an integer because it travels
    /// through URLs, JSON and the map's owner field, and a readable id is
    /// worth more there than a compact one.
    std::string factionId;
    std::string name;
    std::string archetype;
    std::string governance;
    /// "#rrggbb" — how this faction's POIs are painted on the World screen.
    std::string colour;
    /// The sidedata side this faction fields in battle, or empty when it has
    /// not bound one. THE bridge to `users.faction_id`; see the header.
    std::string sideKey;
    int64_t     founderAccountId = 0;
    int64_t     foundedAt = 0;
    /// "active" | "dormant". Dormant = the roster emptied; the row survives
    /// because its POIs, its ledger rows and its name all still refer to it.
    std::string state = "active";
    /// The parameter sheet + anything else this faction has been tuned with.
    /// Copied from the archetype at founding, the authority thereafter.
    nlohmann::json config = nlohmann::json::object();
};

/// A `world_faction_members` row. Keyed `(world_id, account_id)`: a player
/// belongs to at most ONE faction per world, which is what makes membership
/// answerable without a tie-break rule.
struct WorldFactionMemberRecord {
    std::string worldId;
    std::string factionId;
    int64_t     accountId = 0;
    /// Denormalised for the roster view. The account table stays the
    /// authority for the name; this copy is a label, refreshed on every
    /// join.
    std::string username;
    /// "founder" | "member". Officer grades and elections are the governance
    /// milestone's work, not this one.
    std::string role = "member";
    /// Capture 24's faction-standing stat. Stored rather than computed
    /// because its inputs (regions held, artifacts) do not exist yet; a
    /// column that starts at the archetype's floor is the honest placeholder
    /// for a number a later milestone will derive.
    double      rank = 0.0;
    int64_t     joinedAt = 0;
};

/// A `world_authority` row — Capture 23's two player stats, world-scoped.
/// Authority is the slow-moving one that gates founding; capacity is the
/// order budget and is carried here from the start so the later milestone
/// that spends it does not have to migrate a second table in.
struct WorldAuthorityRecord {
    std::string worldId;
    int64_t     accountId = 0;
    double      authority = 0.0;
    double      capacity  = 0.0;
    int64_t     updatedAt = 0;
};

// ─────────────────────────── pure policy ───────────────────────────────────

/// Turn a player-supplied faction name into its id. Lowercase, ASCII
/// alphanumerics kept, every run of anything else collapsed to one '-', ends
/// trimmed. Empty if nothing survives — which the caller must treat as a
/// rejected name, not as a blank id.
std::string SlugifyFactionName(const std::string& name);

/// Why a name was refused, or empty when it is acceptable. Faction names are
/// untrusted player content (§4: "untrusted input everywhere they travel"),
/// so this caps length in CHARACTERS and refuses control characters outright;
/// escaping is still the renderer's job, this is the door.
std::string ValidateFactionName(const std::string& name, const WorldFactionRules& rules);

/// What joining a faction should do about `users.faction_id`, given the
/// account's current side key and the faction's. Pure so the rule is testable
/// without a Database — the route applies the verdict.
enum class SideKeyAction {
    /// Nothing to do: they already agree, or neither side has a key.
    None,
    /// The account has no side key and the faction has one: adopt it. This is
    /// the account's side being SET for the first time, which is exactly what
    /// `users.faction_id` being nullable-for-unset is for.
    Adopt,
    /// Both are set and they differ. Refused rather than reconciled: §1a
    /// makes a confirmed side permanent (changing it clears the account's war
    /// bindings — GuestAccounts.h), and a join is not an admin override.
    Refuse,
};
SideKeyAction ReconcileSideKey(const std::string& accountSideKey,
                               const std::string& factionSideKey);

/// What a found/join attempt asked for.
struct WorldFactionFoundRequest {
    std::string worldId;
    std::string name;
    std::string archetype;
    /// Optional overrides. Empty = take the archetype's.
    std::string governance;
    std::string colour;
    /// The side this faction fields in battle. Normally the founder's own
    /// `users.faction_id`, passed in by the route — this file never reads the
    /// users table.
    std::string sideKey;
    /// Optional: the POI this faction is seated at, which it comes to own.
    /// "found a faction, then expand it through authority and conquest" (§4)
    /// — the seat is the first square of that expansion, and the only
    /// ownership writer this milestone ships.
    std::string seatPoiId;
    int64_t     accountId = 0;
    std::string username;
};

/// Everything a found attempt can answer with. `error` empty = it happened.
struct WorldFactionFoundResult {
    bool ok = false;
    /// Machine-readable: "" | "bad_name" | "bad_archetype" | "name_taken" |
    /// "already_member" | "insufficient_authority" | "bad_seat" |
    /// "seat_taken" | "db_error".
    std::string error;
    std::string detail;
    /// Only meaningful on `insufficient_authority`, for the UI's "you have X
    /// of Y" line.
    double have = 0.0;
    double need = 0.0;
    std::optional<WorldFactionRecord> faction;
};

// ─────────────────────────── the store ─────────────────────────────────────

/// Static, like WorldDirector and WarDirector: no per-instance state, and the
/// handle is the lobby's shared one.
class WorldFactions {
public:
    /// Create the three tables if absent. ADDITIVE only, same rule as
    /// WorldDirector: a faction roster is the only copy of who belongs where.
    static void EnsureTables(sqlite3* db);

    // ── factions ───────────────────────────────────────────────────────────

    static bool Upsert(sqlite3* db, const WorldFactionRecord& f);
    static std::optional<WorldFactionRecord> Load(sqlite3* db,
                                                  const std::string& worldId,
                                                  const std::string& factionId);
    static std::vector<WorldFactionRecord> ListFor(sqlite3* db,
                                                    const std::string& worldId);

    /// The whole founding act, as one call: validate, check the gate, spend,
    /// insert the faction, seat the founder, claim the seat POI. One function
    /// because the parts are only correct together — a faction with no
    /// founder row, or a spend with no faction, is a state nothing recovers
    /// from.
    static WorldFactionFoundResult Found(sqlite3* db,
                                         const WorldFactionRules& rules,
                                         const WorldFactionFoundRequest& req,
                                         int64_t nowRealMs);

    // ── membership ─────────────────────────────────────────────────────────

    static std::optional<WorldFactionMemberRecord> MembershipFor(
        sqlite3* db, const std::string& worldId, int64_t accountId);
    static std::vector<WorldFactionMemberRecord> MembersOf(
        sqlite3* db, const std::string& worldId, const std::string& factionId);

    /// Join an existing faction. Refuses when the account already belongs to
    /// a faction in this world — leaving is an explicit act, because it is
    /// the one that ends the member's standing.
    static WorldFactionFoundResult Join(sqlite3* db, const std::string& worldId,
                                        const std::string& factionId,
                                        int64_t accountId,
                                        const std::string& username,
                                        int64_t nowRealMs);

    /// Leave whatever faction the account is in. Returns false if it was in
    /// none. A faction whose last member leaves goes "dormant" rather than
    /// being deleted — its POIs and its name still refer to it.
    static bool Leave(sqlite3* db, const std::string& worldId, int64_t accountId);

    // ── authority (Capture 23) ─────────────────────────────────────────────

    /// The account's world authority, creating the row at
    /// `rules.startingAuthority` the first time this world sees them. The
    /// grant is here rather than at registration because authority is
    /// per-world state and an account may meet a world years after signing
    /// up.
    static WorldAuthorityRecord AuthorityFor(sqlite3* db, const std::string& worldId,
                                             int64_t accountId,
                                             const WorldFactionRules& rules,
                                             int64_t nowRealMs);
    /// Add (or, with a negative delta, spend) authority. Never clamps at a
    /// ceiling — there is no ceiling designed yet — but never goes below
    /// zero, because a negative authority would make the founding gate mean
    /// something different for a player who once overspent.
    static bool AdjustAuthority(sqlite3* db, const std::string& worldId,
                                int64_t accountId, double delta, int64_t nowRealMs);

    // ── the HTTP surface, as data ──────────────────────────────────────────

    /// `GET /api/world/factions` — the roster of factions in one world plus
    /// the archetype catalogue (a client building a "found a faction" form
    /// needs both, and two round-trips for one form is a race).
    static nlohmann::json FactionsJson(sqlite3* db, const std::string& worldId,
                                       const WorldFactionRules& rules);

    /// `POST /api/world/me` — one account's standing in one world.
    static nlohmann::json MeJson(sqlite3* db, const std::string& worldId,
                                 int64_t accountId, const WorldFactionRules& rules,
                                 int64_t nowRealMs);

    /// Merge faction identity onto `WorldDirector::WorldPoisJson`'s body: a
    /// top-level `factions` map (id → {name, colour, archetype}) so the map
    /// can paint an owner's colour from the same fetch that gave it the
    /// owner. Same shape and reason as `AttachBattleStatus` — the director
    /// builds the body, the transport layer merges what the other director
    /// knows.
    static nlohmann::json AttachFactions(nlohmann::json poisJson, sqlite3* db,
                                         const std::string& worldId);
};
