// SimSnapshot — the purpose-written synced-state walk behind ISimSerializer
// (PLAN-persistence.md Q-P1 option B, task 1b).
//
// WHAT THIS IS
// ------------
// GameStateStore owns everything *around* a snapshot — framing, integrity,
// atomic commits, retention, the E1/E2 ladders — and takes an opaque payload
// from an ISimSerializer. This module is that serializer: a hand-written walk
// over the server's own synced state, modelled on the existing wire
// serializers (EntityStateSerializer, ProjectileStateSerializer,
// PieceStateSerializer, BuildActivitySerializer) rather than on creg, which is
// stubbed out in this tree and is not coming back (Q-P1's decision block).
//
// SECTIONS, AND WHY THE UNIMPLEMENTED ONES ARE *DECLARED*
// ------------------------------------------------------
// The payload is a list of self-describing sections. Every part of the synced
// state the walk must eventually cover has a SectionSpec here — including the
// parts that are not written yet. That is the point: option B's one real
// weakness is a piece of synced state silently vanishing on resume, so the
// gaps are enumerated in code, reported by MissingSections(), and asserted by
// the tripwire in tests/test_sim_snapshot.cpp. An unimplemented required
// section makes Serialize() *refuse by name* — there is no configuration in
// which this module hands the store a payload it knows is incomplete.
//
// LAYOUT HASH
// -----------
// Q-P1 constraint 3 says the layout hash must move on every shape change, and
// notes the E1 refusal is only load-bearing if it actually does. Relying on an
// author to remember is the failure mode, so LayoutHash() is *derived* from
// the section table: every section carries a version, the hash folds
// (id, version) for each, and the only way to change what a section emits
// without changing the hash is to change the emit code and not its version —
// which the round-trip tests catch, because they are written against the
// shape.
//
// COVERAGE CONTRACT — what a restored world is, and is not
// -------------------------------------------------------
// A restored snapshot reinstates synced state the server owns *authoritatively
// and durably*. It deliberately does not attempt to reinstate state the sim
// rebuilds on its own within a tick or two (LOS/radar maps, quad-field
// membership, path caches): those are derived, and a walk that wrote them
// would be claiming a fidelity it cannot check. Anything derived is listed in
// kDerivedNotCaptured below with the reason, so "not in the payload" is never
// ambiguous between "rebuilt" and "forgotten".
//
// PURITY
// ------
// Unlike GameStateStore this module DOES touch sim globals (gs, gsRNG,
// standingOrders, orgGroups, directiveManager) — that is its job. It links
// into spring-tests, which builds the full sim sources, so the round-trip
// guarantees are covered by plain doctests.
#pragma once

#include "Server/GameStateStore.h"   // gamestate::ISimSerializer
#include "Server/StandingOrders.h"   // StandingOrder(Conditions) (census)
#include "Server/OrgGroups.h"        // OrgGroup, Directive (census)

#include <cstdint>
#include <string>
#include <vector>

namespace simsnapshot {

/// Section identity. Values are stable and are NEVER reused — a section that
/// is retired leaves its number burned, so an old blob can still be told apart
/// from a new one that happens to occupy the same slot.
enum class SectionId : uint16_t {
    Globals        = 1,  ///< sim frame + synced RNG position
    StandingOrders = 2,  ///< StandingOrderManager (Q-P1 constraint 2)
    OrgGroups      = 3,  ///< OrgGroupManager (Q-P1 constraint 2)
    Directives     = 4,  ///< DirectiveManager (rides with OrgGroups)
    Teams          = 5,  ///< resources, statistics, rulesParams — task 1c
    Units          = 6,  ///< unitHandler + command queues — task 1c
    SyncedLua      = 7,  ///< gadget-owned synced Lua state — task 1d
    Features       = 8,  ///< wrecks/map features — task 1e
};

/// One entry per part of the synced state the walk must cover. `implemented`
/// false is a declaration of a known gap, not an oversight — `note` says which
/// milestone owns it.
struct SectionSpec {
    SectionId   id;
    uint16_t    version;      ///< bump on ANY change to what this section emits
    const char* name;
    bool        implemented;
    const char* note;
};

/// The section table. Stable order; the payload is written in this order.
const std::vector<SectionSpec>& Sections();

/// Names of the declared-but-unimplemented sections, in table order. Empty
/// means the walk is complete and the serializer may be attached to the store.
std::vector<std::string> MissingSections();

/// Synced state that is deliberately NOT in the payload because the sim
/// rebuilds it, paired with what rebuilds it. Reported at boot alongside
/// MissingSections() so the two kinds of absence are never confused.
struct DerivedOmission {
    const char* what;
    const char* rebuiltBy;
};
const std::vector<DerivedOmission>& DerivedNotCaptured();

/// Payload framing version. Independent of the section versions: this is the
/// envelope (section count + per-section header), not the contents.
inline constexpr uint16_t kPayloadVersion = 1;

// ──────────── Task 1c: the sim-object state structs (§7.1c) ────────────
//
// The `teams` and `units` sections are split into a CAPTURE half that touches
// the sim (CTeam, CUnit, CCommandAI, unitLoader) and a CODEC half that only
// sees the plain structs below. That is not tidiness: a doctest cannot stand up
// a map, a def handler and a team handler, so a codec written directly against
// CUnit* would have shipped with no round-trip coverage at all. With the seam,
// everything about the *bytes* is testable in-process and only Capture/Apply
// need a live server to verify.
//
// The fidelity contract — which CUnit/CTeam member is captured, re-derived,
// rebuilt or deliberately dropped, and why — is PLAN-persistence.md §7.1c.
// These structs ARE that contract in code: a field here is a captured field.

/// One SResourcePack. Two named floats rather than float[2], so the census
/// counts them and a third resource cannot appear silently.
struct ResPair {
    float metal  = 0.0f;
    float energy = 0.0f;
};

/// One TeamStatistics row. Mirrors the engine struct exactly (it is a packed
/// POD with a fixed shape and is written to demo files, so it does not drift).
struct TeamStatsState {
    int32_t frame = 0;
    float metalUsed = 0.0f,     energyUsed = 0.0f;
    float metalProduced = 0.0f, energyProduced = 0.0f;
    float metalExcess = 0.0f,   energyExcess = 0.0f;
    float metalReceived = 0.0f, energyReceived = 0.0f;
    float metalSent = 0.0f,     energySent = 0.0f;
    float damageDealt = 0.0f,   damageReceived = 0.0f;
    int32_t unitsProduced = 0;
    int32_t unitsDied = 0;
    int32_t unitsReceived = 0;
    int32_t unitsSent = 0;
    int32_t unitsCaptured = 0;
    int32_t unitsOutCaptured = 0;
    int32_t unitsKilled = 0;
};

/// One LuaRulesParams::Param, flattened out of its std::variant so the codec
/// has a discriminator on the wire instead of an index into a type list that a
/// later engine bump could reorder.
struct RulesParamState {
    std::string key;
    int32_t     los  = 0;
    uint8_t     type = 0;   ///< 0 = bool, 1 = float, 2 = string
    bool        b    = false;
    float       f    = 0.0f;
    std::string s;
};

struct TeamState {
    int32_t teamNum = 0;
    bool    isDead = false;
    bool    gaia = false;

    // The mutable TeamBase halves (§7.1c: colours, ally-team and side name are
    // start-script identity and are E1's problem, not the walk's).
    int32_t leader = -1;
    float   incomeMultiplier = 1.0f;
    float   startPosX = 0.0f, startPosY = 0.0f, startPosZ = 0.0f;

    ResPair res, resStorage;
    ResPair resPull, resPrevPull;
    ResPair resIncome, resPrevIncome;
    ResPair resExpense, resPrevExpense;
    ResPair resShare, resDelayedShare;
    ResPair resSent, resPrevSent;
    ResPair resReceived, resPrevReceived;
    ResPair resPrevExcess;

    int32_t nextHistoryEntry = 0;
    std::vector<TeamStatsState>  statHistory;
    std::vector<RulesParamState> modParams;
};

/// One queued Command. `id[1]` (the AI callback id) travels too — dropping it
/// would make a resumed AI command's CommandFinished event unattributable.
struct CommandState {
    int32_t            cmdID = 0;
    int32_t            aiCallbackID = -1;
    int32_t            timeOut = 0;
    uint32_t           tag = 0;
    uint8_t            options = 0;
    std::vector<float> params;
};

/// Per-weapon durable state. Aim vectors and the current target are not here —
/// they are re-acquired on the next SlowUpdateWeapons (§7.1c).
struct WeaponState {
    int32_t reloadStatus = 0;
    int32_t salvoLeft = 0;
    int32_t nextSalvo = 0;
    int32_t numStockpiled = 0;
    int32_t numStockpileQued = 0;
};

struct UnitState {
    // ── creation key ──
    int32_t     id = -1;
    std::string unitDefName;   ///< by NAME: a def id is a load-order artefact
    int32_t     team = 0;
    int32_t     buildFacing = 0;
    bool        beingBuilt = false;

    // ── transform ──
    float   posX = 0.0f, posY = 0.0f, posZ = 0.0f;
    float   speedX = 0.0f, speedY = 0.0f, speedZ = 0.0f;
    int32_t heading = 0;
    float   frontX = 0.0f, frontY = 0.0f, frontZ = 0.0f;
    float   rightX = 0.0f, rightY = 0.0f, rightZ = 0.0f;
    float   upX = 0.0f, upY = 0.0f, upZ = 0.0f;
    uint32_t physicalState = 0;
    uint32_t collidableState = 0;

    // ── vitals + progress ──
    float health = 0.0f, maxHealth = 1.0f;
    float paralyzeDamage = 0.0f, captureProgress = 0.0f, buildProgress = 0.0f;
    float experience = 0.0f, recentDamage = 0.0f;
    float power = 0.0f, mass = 0.0f, buildTime = 0.0f;
    float terraformLeft = 0.0f, repairAmount = 0.0f, metalExtract = 0.0f;
    ResPair cost, harvested, harvestStorage, storage;

    // ── combat + posture ──
    int32_t fireState = 0, moveState = 0;
    bool    armoredState = false;
    float   armoredMultiple = 1.0f, curArmorMultiple = 1.0f;
    int32_t armorType = 0;
    uint32_t category = 0;
    float   maxRange = 0.0f, reloadSpeed = 1.0f;
    int32_t flankingBonusMode = 0;
    float   flankingDirX = 0.0f, flankingDirY = 0.0f, flankingDirZ = 0.0f;
    float   flankingBonusMobility = 0.0f, flankingBonusMobilityAdd = 0.0f;
    float   flankingBonusAvgDamage = 0.0f, flankingBonusDifDamage = 0.0f;
    bool    onTempHoldFire = false, forceUseWeapons = false, allowUseWeapons = true;
    bool    inBuildStance = false, useHighTrajectory = false;
    int32_t selfDCountdown = 0, delayedWreckLevel = -1, featureDefID = -1;
    int32_t lastAttackFrame = 0, lastFireWeapon = 0, lastNanoAdd = 0;
    uint32_t restTime = 0;

    // ── visibility ──
    int32_t losRadius = 0, airLosRadius = 0, realLosRadius = 0, realAirLosRadius = 0;
    int32_t radarRadius = 0, sonarRadius = 0, jammerRadius = 0;
    int32_t sonarJamRadius = 0, seismicRadius = 0;
    float   seismicSignature = 0.0f, decloakDistance = 0.0f;
    bool    stealth = false, sonarStealth = false;
    bool    isCloaked = false, wantCloak = false;
    bool    alwaysVisible = false, useAirLos = false;
    float   posErrX = 0.0f, posErrY = 0.0f, posErrZ = 0.0f;
    float   posErrDeltaX = 0.0f, posErrDeltaY = 0.0f, posErrDeltaZ = 0.0f;
    int32_t nextPosErrorUpdate = 0;

    // ── state flags ──
    bool activated = false, neutral = false, upright = false;
    bool groundLevelled = false, stunned = false, invulnerable = false;
    bool noSelect = false;

    // ── transport graph (restored in a second pass, once every unit exists) ──
    int32_t transporterId = -1;
    int32_t loadingTransportId = -1;
    int32_t unloadingTransportId = -1;
    int32_t transportCapacityUsed = 0;
    float   transportMassUsed = 0.0f;
    /// (transportee id, piece) pairs, in attach order.
    std::vector<std::pair<int32_t, int32_t>> transportees;

    // ── commands ──
    std::vector<CommandState> commands;
    int32_t tagCounter = 0;
    bool    repeatOrders = false;
    int32_t lastUserCommand = 0, lastFinishCommand = 0;

    // ── weapons + rulesParams ──
    std::vector<WeaponState>     weapons;
    std::vector<RulesParamState> modParams;
};

// ─────────── Capture / apply: the halves that touch the sim ───────────
//
// Split out of the codec so the codec is testable without a sim (see above).
// Apply* is only ever called from Deserialize's commit phase, after every
// fallible check has already passed.

void CaptureTeams(std::vector<TeamState>& out);

/// Staging-phase check for the teams section: a snapshot team that this game
/// does not have is a refusal, not a skipped row.
bool ResolveTeams(const std::vector<TeamState>& in, std::string& err);

void ApplyTeams(const std::vector<TeamState>& in);

void CaptureUnits(std::vector<UnitState>& out);

/// Resolve every unitDefName in `in` and validate the id set. Called during
/// STAGING — before anything is destroyed — because a def that no longer
/// exists is the one restore failure that cannot be rolled back once the live
/// roster is gone (§7.1c decision 2). `defIds[i]` is the resolved def id for
/// `in[i]`.
bool ResolveUnitDefs(const std::vector<UnitState>& in,
                     std::vector<int32_t>& defIds, std::string& err);

/// Destroy the live roster and rebuild it from `in`. Requires a preceding
/// successful ResolveUnitDefs with the same vector.
void ApplyUnits(const std::vector<UnitState>& in, const std::vector<int32_t>& defIds);

// ─────────────────────────── Section codecs ───────────────────────────
//
// Exposed for the round-trip tests: the encode/decode pair is the part of this
// module that can be exercised without a running sim.

void EncodeTeams(const std::vector<TeamState>& in, std::vector<uint8_t>& out);
bool DecodeTeams(const uint8_t* data, size_t size,
                 std::vector<TeamState>& out, std::string& err);

void EncodeUnits(const std::vector<UnitState>& in, std::vector<uint8_t>& out);
bool DecodeUnits(const uint8_t* data, size_t size,
                 std::vector<UnitState>& out, std::string& err);

// ──────────────────── The field-census tripwire ────────────────────
//
// Q-P1 constraint 4: "ship a completeness tripwire in the same milestone as
// the walk, not after it". Each function below destructures every member of
// the struct it names and returns the member count, so a field added to any
// of them is a BUILD failure on that struct rather than a field that silently
// stops being snapshotted. tests/test_sim_snapshot.cpp pins the counts against
// the number of fields the codec writes, which is what makes "the build still
// compiles" and "the walk still covers everything" the same statement.
namespace census {
int Conditions(const StandingOrderConditions& c);
int Order(const StandingOrder& o);
int Group(const OrgGroup& g);
int Directive_(const Directive& d);
int Team(const TeamState& t);
int Unit(const UnitState& u);
int Weapon(const WeaponState& w);
int Cmd(const CommandState& c);
int RulesParam(const RulesParamState& p);
int Stats(const TeamStatsState& s);
int Res(const ResPair& r);
} // namespace census

class SimSnapshotSerializer : public gamestate::ISimSerializer {
public:
    bool Serialize(std::vector<uint8_t>& out, std::string& err) override;
    bool Deserialize(const uint8_t* data, size_t size, std::string& err) override;
    uint64_t LayoutHash() const override;
    int32_t Frame() const override;

    /// The walk itself, WITHOUT the completeness gate — it emits the sections
    /// that are implemented and says nothing about the ones that are not.
    ///
    /// NOT a checkpoint. Serialize() is the only entry point that may produce
    /// a payload for the store, because a payload missing a declared section
    /// restores a partial world. This exists so the landed sections have
    /// round-trip coverage while the walk is incomplete (a milestone that
    /// shipped them untested until task 1d would be worse), and so tasks
    /// 1c/1d have the body to extend. Deserialize() needs no equivalent: it
    /// reads whatever sections the payload carries.
    bool SerializeImplemented(std::vector<uint8_t>& out, std::string& err);
};

} // namespace simsnapshot
