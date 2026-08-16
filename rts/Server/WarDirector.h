// WarDirector — the lobby-side service that owns the SET of live wars.
//
// PLAN-metalstorm-wars.md §2 and §9 task 1. The rule that defines this file,
// stated first because everything else follows from it: **the War Director
// never touches sim state.** It decides *which wars exist* and how big each
// side of one is, writes that down, and hands off to the boot paths that
// already exist. Every in-war behaviour belongs to the backbone gadgets, and
// every process-level decision (spawn, resume, hibernate) belongs to the code
// that already makes it. So this whole file is SQLite plus arithmetic, and it
// is testable headless because its two outputs are *DB rows* and *one boot
// call* — neither needs a renderer, a sim or a running game server.
//
// ── What was already here, and what this adds ──────────────────────────────
// PLAN-metalstorm-lobby.md tasks 6–7 built the ROOM-shaped half of all of
// this and it is deliberately not rebuilt here:
//   * `WarSeeding.h`  — `SeedSideCapacities`, the capacity rule
//     (`registered(f) / (warsFielding(f) + 1)`, clamped). Called from here;
//     the sizing arithmetic is NOT re-derived.
//   * `WarSides.h`    — the one encoder/decoder pair for the `war_sides` and
//     `war_side_capacities` modoptions, read by three separate processes.
//   * `WarDeploy.h` + `POST /api/wars/deploy` — "which war should I fight
//     in?", including the `seed` outcome that says a new war is needed.
//   * `WarPlayerBindings` — the durable account↔side record.
//
// What none of them own is the **war as an object**. Today a war *is* a room
// with `session_kind='persistent'` and two modoption strings, which means
// several facts have nowhere to live: what stage of its life it is in, why it
// was created, which scenario authored it, and — the one that bites first —
// what its sides are supposed to be when no game server is running to be
// asked. `/api/wars/deploy` answers `seed` and then stops, because there is
// nobody whose job it is to act on that. This file is that somebody.
//
// ── Why `wars` extends `rooms` rather than replacing it ────────────────────
// §1 says "a `wars` table extending `rooms`", and the extension is strict: a
// `wars` row is keyed by `room_id` and carries ONLY the columns `rooms` has
// none of. Map, game, port, session kind, persistence and the member roster
// stay exactly where RoomManager already keeps them. Duplicating the map id
// into a second table would create two answers to "what map is this war on",
// and the day they disagree is the day a war boots on one map and is browsed
// as another.
//
// The same discipline applies to `war_sides`, which is the subtle one. The
// modoption strings remain the WIRE format — they are what the client's
// `war-sides.ts` and the game server's seating code read, and this file does
// not change that by one character. The table is the Director's own durable
// authority, and the modoptions are *derived* from it at boot
// (`EncodeWarSides` / `EncodeWarSideCapacities`, both already written). One
// producer, the existing encoders, the existing readers.
#pragma once

#include <cstdint>
#include <optional>
#include <string>
#include <vector>

#include "WarSeeding.h"
#include "WarSides.h"

struct sqlite3;

// ── The meta-state machine (§7) ────────────────────────────────────────────

/// Where a war is in its life. Stored as TEXT, not an integer, for the same
/// reason `rooms.session_kind` is: these rows are read by `sqlite3` at a
/// prompt and by the MCP debug server far more often than by C++, and a war
/// stuck in state 3 tells a human nothing.
///
/// **Hibernation is deliberately NOT one of these.** §1 calls it orthogonal
/// and it is: a hibernated war is an `active` war whose *process* is a
/// snapshot rather than a pid, and that distinction is `game_servers` /
/// `game_snapshots` business (PLAN-persistence §3). Folding it in here would
/// mean a war that hibernates and resumes has forgotten whether it was open
/// to joiners.
enum class WarState : uint8_t {
    /// The row exists and the boot call has not been made (or has not
    /// returned). No player may be handed a join token for a war in this
    /// state — there is nothing yet to join.
    Seeding = 0,
    /// Booted and accepting joiners.
    Open,
    /// Running with people in it. Distinguished from `Open` because §4's
    /// demand-driven seeding wants to know which wars are actually being
    /// fought, not merely which ones exist.
    Active,
    /// A terminal condition has fired (§7); the war is playing out its
    /// ending. No new joiners.
    WindingDown,
    /// Combat is over and settlement is running (escrow, digest).
    Resolving,
    /// Finished and read-only.
    Archived,
};

inline const char* WarStateToString(WarState s) {
    switch (s) {
        case WarState::Seeding:     return "seeding";
        case WarState::Open:        return "open";
        case WarState::Active:      return "active";
        case WarState::WindingDown: return "winding_down";
        case WarState::Resolving:   return "resolving";
        case WarState::Archived:    return "archived";
    }
    return "seeding";
}

/// Returns nullopt for an unknown spelling rather than defaulting to
/// `Seeding`. A typo'd state must not silently reopen a war that had ended —
/// the same refuse-on-typo rule `SessionKindFromString` set for `rooms`.
inline std::optional<WarState> WarStateFromString(const std::string& s) {
    if (s == "seeding")      return WarState::Seeding;
    if (s == "open")         return WarState::Open;
    if (s == "active")       return WarState::Active;
    if (s == "winding_down") return WarState::WindingDown;
    if (s == "resolving")    return WarState::Resolving;
    if (s == "archived")     return WarState::Archived;
    return std::nullopt;
}

/// Is `from → to` a move this state machine allows?
///
/// Two rules beyond the obvious forward chain:
///   * `to == from` is legal, so a caller that re-asserts the state it already
///     has (an adoption pass on lobby restart, say) is a no-op and not an
///     error.
///   * **anything may go straight to `Archived`.** An operator-retire, a lobby
///     that finds a war whose room is gone, and a war that dies during seeding
///     all have to be expressible; refusing them would leave rows that no
///     legal transition can ever clean up.
/// Nothing leaves `Archived`. A finished war is finished; re-opening one would
/// re-open its escrow with it.
inline bool IsLegalWarTransition(WarState from, WarState to) {
    if (from == to)
        return true;
    if (from == WarState::Archived)
        return false;
    if (to == WarState::Archived)
        return true;
    switch (from) {
        case WarState::Seeding:     return to == WarState::Open;
        case WarState::Open:        return to == WarState::Active ||
                                           to == WarState::WindingDown;
        case WarState::Active:      return to == WarState::WindingDown;
        case WarState::WindingDown: return to == WarState::Resolving;
        case WarState::Resolving:   return false;  // → Archived only, above
        case WarState::Archived:    return false;
    }
    return false;
}

/// Why this war exists (§1 `origin`). Kept because §4's demand-driven seeding
/// is only self-limiting if the Director can tell its own seeded wars from an
/// operator's flagship — a pool of demand-seeded wars that also counts the
/// curated ones would stop seeding exactly when a live-ops event ran.
enum class WarOrigin : uint8_t {
    /// Created explicitly by a human (live-ops flagship, or the ordinary
    /// player-created war the lobby already has).
    Operator = 0,
    /// Seeded by the Director because a faction had waiting players and no
    /// open slot anywhere (§4).
    Demand,
    /// Booted from an authored scenario file, which §3 calls a war template.
    Scenario,
    /// Seeded by a schedule (a season opening, a weekly theatre rotation).
    Scheduled,
};

inline const char* WarOriginToString(WarOrigin o) {
    switch (o) {
        case WarOrigin::Operator:  return "operator";
        case WarOrigin::Demand:    return "demand";
        case WarOrigin::Scenario:  return "scenario";
        case WarOrigin::Scheduled: return "scheduled";
    }
    return "operator";
}

inline std::optional<WarOrigin> WarOriginFromString(const std::string& s) {
    if (s == "operator")  return WarOrigin::Operator;
    if (s == "demand")    return WarOrigin::Demand;
    if (s == "scenario")  return WarOrigin::Scenario;
    if (s == "scheduled") return WarOrigin::Scheduled;
    return std::nullopt;
}

// ── The plan: what a seed decides before anything is written ───────────────

/// One side of a war being seeded: a faction, the Spring team it is seated
/// on, its human capacity and the start box it deploys from.
///
/// `slotCap` is the same number `war_side_capacities` carries and the same
/// number `DeployHasSeat` compares against — one concept, not a parallel one.
struct WarSideSeed {
    std::string factionId;
    uint8_t     team = 0;
    unsigned    slotCap = WAR_SIDE_CAPACITY_DEFAULT;
    /// Index into the map's start positions. Assigned in side order, which is
    /// what makes a war's sides reproducible from its row alone.
    int         startBox = -1;
    /// §4's underdog incentive. A FLAG, never a reassignment: it marks this
    /// side as the one a bonus onboarding grant applies to (teams'
    /// `JOIN_GRANT`), pulling *that faction's own* waiting players toward the
    /// war that needs them. Seeded false — nothing is outnumbered yet in a
    /// war with no players — and maintained by task 2.
    bool        incentivised = false;
};

/// Everything a caller must decide before the Director can size a war.
/// Deliberately values only: no room, no db, no map object. The map's
/// contribution is `startBoxCount`, read from `MapMetadataDb` by the caller,
/// because §3's constraint on the Director is exactly one number — it must
/// not place more faction sides than the map supports.
struct WarSeedRequest {
    std::string name;
    /// The theatre: a map id. Named `theatre` in the row to match §1's
    /// vocabulary, but it is a map id and nothing else.
    std::string theatre;
    std::string gameId;
    /// A `scenarios/<name>.lua` world file (persistence §5) — §3 calls a
    /// scenario file a war template. Empty means the map's default.
    std::string scenario;
    /// The factions that will field a side, in declaration order. Order is
    /// load-bearing: it fixes team numbers and start boxes, so the same
    /// request always produces the same war.
    std::vector<std::string> factions;
    WarOrigin   origin = WarOrigin::Operator;
    std::string seasonId;
    /// How many start positions the map publishes. `0` means "unknown" and is
    /// read permissively (see `PlanWarSeed`).
    unsigned    startBoxCount = 0;
    /// The account whose name the boot manifest uses as its host. A
    /// Director-seeded war has no human on any side yet, so this account is
    /// seated as a SPECTATOR (see `BuildWarBootManifest`).
    std::string hostUsername = "director";
    /// The AI seated on every declared side at boot, so each side exists as a
    /// real team from frame 0. See `BuildWarBootManifest` for why this is not
    /// optional in practice.
    std::string caretakerAi = "null";
    bool        autoStart = true;
};

/// The decided war, before a single row is written. `ok == false` carries the
/// refusal in `error` — the Director refuses rather than clamping, because
/// every refusal here is a request that would have produced a war somebody
/// cannot play (one side, or more sides than the map has corners).
struct WarSeedPlan {
    bool        ok = false;
    std::string error;

    std::string name;
    std::string theatre;
    std::string gameId;
    std::string scenario;
    WarOrigin   origin = WarOrigin::Operator;
    std::string seasonId;
    std::string hostUsername;
    std::string caretakerAi;
    bool        autoStart = true;

    std::vector<WarSideSeed> sides;

    /// The sides in the shape `WarSides.h`'s encoder wants. One producer for
    /// the modoption, and it is the existing encoder.
    WarSides SideTeams() const {
        WarSides out;
        out.reserve(sides.size());
        for (const auto& s : sides)
            out.emplace_back(s.factionId, s.team);
        return out;
    }
    WarSideCapacities SideCapacities() const {
        WarSideCapacities out;
        out.reserve(sides.size());
        for (const auto& s : sides)
            out.emplace_back(s.factionId, s.slotCap);
        return out;
    }
    /// Σ slotCap — the number of human player slots the game server must
    /// pre-allocate at spawn (§8.1, task 5). Recorded here because seed time
    /// is the only moment at which every side's cap is known at once.
    unsigned TotalSlotCap() const {
        unsigned total = 0;
        for (const auto& s : sides)
            total += s.slotCap;
        return total;
    }
};

/// Size a war's sides and lay out its teams. Pure — same discipline as
/// `WarSeeding.h`, `WarDeploy.h` and `DynamicJoin.h`, so §10's "seed a war →
/// correct rows + one boot call" test needs no database at all for this half.
///
/// Refusals, and why each one is a refusal and not a clamp:
///   * **fewer than two distinct factions.** §1: two-plus factions per war. A
///     one-side war has no opponent and no way to end (§7's terminal
///     conditions are all relative to another side).
///   * **more sides than the map has start boxes** (§3, when the count is
///     known). Placing a side with no start box produces a faction that boots
///     into another faction's corner or into the sea, and the map is the
///     authority on how many corners it has.
/// A duplicate faction is dropped rather than refused — the same
/// drop-the-entry rule `ParseWarSides` uses — because the second mention adds
/// nothing and dropping it leaves the other sides correctly numbered.
///
/// `startBoxCount == 0` is read as "the caller could not find out", not as
/// "this map has no start positions", and is permissive. A map whose metadata
/// has not been ingested yet must not make every war unseedable; the boot
/// itself will still fail loudly if the positions really are missing.
WarSeedPlan PlanWarSeed(const WarSeedRequest& request,
                        const WarSeedPopulation& population);

/// The boot call, as JSON text in the shape `--direct` / `runDirectStart`
/// already accepts (PLAN-quickstart.md; the manifest part landed via the
/// m-prep lane). **Seeding a war is one boot call** (§2.1) and this is it —
/// the Director emits the manifest and the existing composite does every
/// step of the actual creation, so there is no second room-creation path to
/// drift out of sync with `POST /api/rooms`.
///
/// Text, not `nlohmann::json`, purely so this header stays dependency-free
/// for the three headers that include it; the caller parses it back with the
/// same parser `--direct` uses on a file.
///
/// Three things in the emitted manifest are decisions, not formatting:
///
///   1. **The host is a SPECTATOR.** `runDirectStart` requires `players[0]`
///      and makes it the host. A Director-seeded war has no human on any
///      side, and seating the seeding account on side 0 would quietly enlist
///      an operator as a combatant for whichever faction happens to be first
///      in the list — and, worse, would occupy one of that side's `slotCap`
///      seats for the whole war.
///
///   2. **One caretaker AI per declared side.** A side with neither a player
///      nor an AI is a gap team: the engine materialises it, `GetTeamInfo`
///      reports leader `-1`, and it is neither playable nor cleanly absent.
///      Every side therefore boots with a real team behind it. It also makes
///      `runDirectStart`'s solo-team Null-AI safety net a no-op rather than a
///      surprise third participant — that net exists for a one-team skirmish
///      and would otherwise fire on every seeded war, since a spectator host
///      contributes no team at all.
///
///   3. **`war_sides` and `war_side_capacities` are written from the plan
///      through the existing encoders.** No string is assembled here. The
///      table is the Director's authority and the modoption is derived from
///      it, which is what keeps the client, the game server and the lobby
///      reading one answer.
std::string BuildWarBootManifest(const WarSeedPlan& plan);

// ── The rows ───────────────────────────────────────────────────────────────

/// A `wars` row: the war object, minus everything `rooms` already owns.
struct WarRecord {
    uint32_t    roomId = 0;
    std::string name;
    std::string theatre;
    std::string scenario;
    WarState    state = WarState::Seeding;
    WarOrigin   origin = WarOrigin::Operator;
    std::string seasonId;
    int64_t     createdAt = 0;
    int64_t     retiredAt = 0;
    /// The last sim frame the Director was told about. Advisory: it is a
    /// staleness measure for the adoption pass, not a clock anybody drives.
    int64_t     lastActiveFrame = 0;
    /// Σ slotCap as decided at seed time — the number the game server sized
    /// its player arrays for (§8.1). Stored rather than recomputed from
    /// `war_sides` because task 2 may raise a cap within the map limit after
    /// boot, and the number that matters for a dynamic join is the one the
    /// RUNNING process was spawned with.
    unsigned    spawnedSlotCap = 0;
    /// Why this war ended (`WarTerminalReasonToString`), empty while it is
    /// live. The Director's own half of the ending: `war_outcome` carries the
    /// facts only the sim can see, and a war can end for a reason the sim
    /// never sees at all (an operator retire, a season boundary, a faction
    /// driven out of the theatre), so this is the field that always exists.
    /// TEXT for the same reason `state` is — these rows are read at a sqlite
    /// prompt far more often than by C++.
    std::string terminalReason;

    bool IsLive() const {
        return state != WarState::Archived;
    }
};

/// A `war_sides` row.
struct WarSideRecord {
    uint32_t    roomId = 0;
    std::string factionId;
    int         team = -1;
    unsigned    slotCap = 0;
    int         startBox = -1;
    bool        incentivised = false;
};

/// The Director's durable half. Static, like `WarPlayerBindings` — there is
/// no per-instance state to hold, and the two processes that touch these
/// tables each own their own sqlite handle on the same file.
class WarDirector {
public:
    /// Create both tables if absent. Additive migration only, NO
    /// probe-and-drop: a `wars` row is the only copy of a war's origin,
    /// scenario and lifecycle stage, so a schema bump must `ALTER TABLE ADD
    /// COLUMN` the way `WarPlayerBindings` does rather than discard every
    /// live war because a column was added. (`rooms`/`game_servers` may drop
    /// and rebuild because they mirror live in-memory state; this does not.)
    static void EnsureTables(sqlite3* db);

    /// Write the war and its sides for `roomId`, from a plan.
    ///
    /// **Room ids are reused** — RoomManager hands out the lowest free id, so
    /// the row for a long-dead war can still be sitting on the id a new one
    /// is about to take. Registration therefore REPLACES: the `wars` row
    /// upserts and the war's `war_sides` rows are deleted first. The
    /// alternative — leaving stale sides behind — would give the new war the
    /// old one's factions the moment they differed.
    static bool Register(sqlite3* db, uint32_t roomId, const WarSeedPlan& plan,
                         int64_t now);

    /// Move a war to `to`, refusing an illegal transition (`IsLegalWarTransition`).
    /// Returns false for an unknown war as well as for a refused move — a
    /// caller that cannot tell those apart should be reading `Load` first.
    static bool SetState(sqlite3* db, uint32_t roomId, WarState to, int64_t now);

    /// Terminal: `Archived` plus `retired_at`. Legal from every state, so an
    /// operator-retire and a seeding failure are the same call.
    static bool Retire(sqlite3* db, uint32_t roomId, int64_t now);

    /// Record WHY the war ended (`WarTerminalReasonToString`, §7). First
    /// writer wins — a war ends once, and the sweep re-evaluates every few
    /// seconds while a war sits in `winding_down`/`resolving`, so without that
    /// guard the recorded ending could change after the players had been told
    /// what it was. Returns true only when this call is the one that wrote it.
    static bool SetTerminalReason(sqlite3* db, uint32_t roomId,
                                  const std::string& reason);

    /// Record the Σ slotCap the game server was actually spawned with (§8.1).
    /// Separate from `Register` because the plan is written before the boot
    /// call and this is known only after it.
    static bool RecordSpawnedSlotCap(sqlite3* db, uint32_t roomId,
                                     unsigned totalSlotCap);

    /// Advance the advisory activity stamp.
    static bool TouchActivity(sqlite3* db, uint32_t roomId, int64_t frame,
                              int64_t now);

    /// Flag (or clear) §4's underdog incentive on one side. A flag and
    /// nothing else — no player is moved, no faction is changed; the grant it
    /// authorises is teams' business.
    static bool SetSideIncentivised(sqlite3* db, uint32_t roomId,
                                    const std::string& factionId, bool on);

    /// Raise (or lower) a side's cap after seeding — §4's "cap is a soft
    /// target; the Director may raise it within the map limit if one faction
    /// floods". The map limit is the CALLER's to enforce: this table does not
    /// know the map.
    static bool SetSideSlotCap(sqlite3* db, uint32_t roomId,
                               const std::string& factionId, unsigned slotCap);

    static std::optional<WarRecord> Load(sqlite3* db, uint32_t roomId);
    static std::vector<WarSideRecord> SidesFor(sqlite3* db, uint32_t roomId);

    /// Every war not yet `archived`, newest first. This is the "set of live
    /// wars" the Director is defined as owning.
    static std::vector<WarRecord> ListLive(sqlite3* db);
    static std::vector<WarRecord> ListByState(sqlite3* db, WarState state);

    /// How many live wars field `factionId`. Feeds `WarSeedPopulation::
    /// warsFielding`, which is what makes the capacity rule self-limiting —
    /// and it is a query, not a count anybody maintains, so it cannot drift.
    static unsigned WarsFielding(sqlite3* db, const std::string& factionId);

    /// Drop both rows for a room id. For the id-reuse path only (a room
    /// deleted outright), NOT for a war that ended — that is `Retire`, and
    /// the difference is whether the war's history survives.
    static bool Forget(sqlite3* db, uint32_t roomId);
};
