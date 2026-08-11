// SimSnapshot — see SimSnapshot.h for the design and the coverage contract.

#include "Server/SimSnapshot.h"

#include "Server/OrgGroups.h"
#include "Server/StandingOrders.h"
#include "Sim/Misc/GlobalSynced.h"
#include "Sim/Misc/Team.h"
#include "Sim/Misc/TeamHandler.h"
#include "Sim/Units/CommandAI/CommandAI.h"
#include "Sim/Units/Unit.h"
#include "Sim/Units/UnitDef.h"
#include "Sim/Units/UnitDefHandler.h"
#include "Sim/Units/UnitHandler.h"
#include "Sim/Units/UnitLoader.h"
#include "Sim/Weapons/Weapon.h"
#include "System/GlobalRNG.h"
#include "System/SpringLog/SpringLog.h"

#define LOG_SECTION "snapshot"

#include <algorithm>
#include <cstring>

namespace simsnapshot {

// ─────────────────────────── The section table ───────────────────────────

const std::vector<SectionSpec>& Sections()
{
    static const std::vector<SectionSpec> kSections = {
        {SectionId::Globals,        1, "globals",        true,  ""},
        {SectionId::StandingOrders, 1, "standingOrders", true,  ""},
        {SectionId::OrgGroups,      1, "orgGroups",      true,  ""},
        {SectionId::Directives,     1, "directives",     true,  ""},
        {SectionId::Teams,          1, "teams",          true,  ""},
        {SectionId::Units,          1, "units",          true,  ""},
        {SectionId::Features,       0, "features",       false,
         "task 1e: wrecks and map features (reclaimLeft, resources, health, "
         "position). Declared 2026-08-11 by task 1c - the section table had no "
         "entry for them at all, so MissingSections() could not report the gap"},
        {SectionId::SyncedLua,      0, "syncedLua",      false,
         "task 1d: gadget-owned synced Lua state. PLAN-persistence §2's "
         "premise that SerializeLuaState round-trips the VM wholesale is "
         "false in this tree - it is a seven-line no-op, so the Lua half "
         "needs gadget Save/Load callins, not a verification pass"},
    };
    return kSections;
}

std::vector<std::string> MissingSections()
{
    std::vector<std::string> missing;
    for (const auto& s : Sections()) {
        if (!s.implemented)
            missing.emplace_back(s.name);
    }
    return missing;
}

const std::vector<DerivedOmission>& DerivedNotCaptured()
{
    static const std::vector<DerivedOmission> kDerived = {
        {"LOS / radar / jammer coverage maps",
         "CLosHandler recomputes per unit on the next slow-update pass"},
        {"quad-field membership",
         "CQuadField is repopulated as units are re-inserted"},
        {"path-finder caches and flow fields",
         "recomputed on demand from the command queue"},
        {"in-flight projectiles",
         "not rebuilt - deliberately dropped. A projectile's whole lifetime is "
         "well under one snapshot cadence, so carrying them buys a fraction of "
         "a second of fidelity for a section that has to track every weapon "
         "type. A resumed battle loses the shots that were in the air"},
    };
    return kDerived;
}

// ───────────────────────── Byte primitives ─────────────────────────
//
// Little-endian, explicit widths, no struct punning: the payload outlives the
// process that wrote it, and a snapshot is decoded by a binary that may have
// been rebuilt (E1 catches the incompatible cases, but only if the bytes are
// interpretable enough to reach the check).

namespace {

class Writer {
public:
    explicit Writer(std::vector<uint8_t>& buf) : out(buf) {}

    void U8(uint8_t v)   { out.push_back(v); }
    void U16(uint16_t v) { for (int i = 0; i < 2; ++i) out.push_back(uint8_t(v >> (8 * i))); }
    void U32(uint32_t v) { for (int i = 0; i < 4; ++i) out.push_back(uint8_t(v >> (8 * i))); }
    void U64(uint64_t v) { for (int i = 0; i < 8; ++i) out.push_back(uint8_t(v >> (8 * i))); }
    void I32(int32_t v)  { U32(static_cast<uint32_t>(v)); }
    void Bool(bool v)    { U8(v ? 1 : 0); }

    void F32(float v) {
        uint32_t bits = 0;
        std::memcpy(&bits, &v, sizeof(bits));
        U32(bits);
    }
    void Vec3(const float3& v) { F32(v.x); F32(v.y); F32(v.z); }

    void Str(const std::string& s) {
        U32(static_cast<uint32_t>(s.size()));
        out.insert(out.end(), s.begin(), s.end());
    }
    void Floats(const std::vector<float>& v) {
        U32(static_cast<uint32_t>(v.size()));
        for (const float f : v) F32(f);
    }
    void U32s(const std::vector<uint32_t>& v) {
        U32(static_cast<uint32_t>(v.size()));
        for (const uint32_t x : v) U32(x);
    }
    void Strs(const std::vector<std::string>& v) {
        U32(static_cast<uint32_t>(v.size()));
        for (const auto& s : v) Str(s);
    }
    /// An unordered_set has no order, and a snapshot that serialises one in
    /// hash order is not reproducible across rehashes - which would make a
    /// byte-comparison of two snapshots of the same state fail for no reason.
    /// Sorted, always.
    void U32Set(const std::unordered_set<uint32_t>& s) {
        std::vector<uint32_t> v(s.begin(), s.end());
        std::sort(v.begin(), v.end());
        U32s(v);
    }

    size_t Size() const { return out.size(); }

private:
    std::vector<uint8_t>& out;
};

/// Bounds-checked reader. Every read past the end sets `bad` and returns a
/// zero value rather than reading out of bounds; the caller checks Bad() once
/// at the end of a section instead of after every field.
class Reader {
public:
    Reader(const uint8_t* p, size_t n) : data(p), size(n) {}

    uint8_t U8() {
        if (!Want(1)) return 0;
        return data[pos++];
    }
    uint16_t U16() {
        if (!Want(2)) return 0;
        uint16_t v = uint16_t(data[pos]) | (uint16_t(data[pos + 1]) << 8);
        pos += 2;
        return v;
    }
    uint32_t U32() {
        if (!Want(4)) return 0;
        uint32_t v = 0;
        for (int i = 0; i < 4; ++i) v |= uint32_t(data[pos + i]) << (8 * i);
        pos += 4;
        return v;
    }
    uint64_t U64() {
        if (!Want(8)) return 0;
        uint64_t v = 0;
        for (int i = 0; i < 8; ++i) v |= uint64_t(data[pos + i]) << (8 * i);
        pos += 8;
        return v;
    }
    int32_t I32()  { return static_cast<int32_t>(U32()); }
    bool    Bool() { return U8() != 0; }

    float F32() {
        const uint32_t bits = U32();
        float v = 0.0f;
        std::memcpy(&v, &bits, sizeof(v));
        return v;
    }
    float3 Vec3() {
        float3 v;
        v.x = F32(); v.y = F32(); v.z = F32();
        return v;
    }

    std::string Str() {
        const uint32_t n = U32();
        if (!Want(n)) return {};
        std::string s(reinterpret_cast<const char*>(data + pos), n);
        pos += n;
        return s;
    }
    std::vector<float> Floats() {
        const uint32_t n = U32();
        // Check the whole run before reserving: a corrupt count of 4 billion
        // must not be a 16 GB allocation before it is a decode failure.
        if (!Want(size_t(n) * 4)) return {};
        std::vector<float> v(n);
        for (uint32_t i = 0; i < n; ++i) v[i] = F32();
        return v;
    }
    std::vector<uint32_t> U32s() {
        const uint32_t n = U32();
        if (!Want(size_t(n) * 4)) return {};
        std::vector<uint32_t> v(n);
        for (uint32_t i = 0; i < n; ++i) v[i] = U32();
        return v;
    }
    std::vector<std::string> Strs() {
        const uint32_t n = U32();
        // Each string costs at least its 4-byte length prefix.
        if (!Want(size_t(n) * 4)) return {};
        std::vector<std::string> v;
        v.reserve(n);
        for (uint32_t i = 0; i < n && !bad; ++i) v.push_back(Str());
        return v;
    }
    std::unordered_set<uint32_t> U32Set() {
        const std::vector<uint32_t> v = U32s();
        return {v.begin(), v.end()};
    }

    /// Skip `n` bytes (used to step over a section this build cannot decode).
    void Skip(size_t n) { if (Want(n)) pos += n; }

    /// Mark the read failed without consuming anything. Every "this count
    /// cannot fit in what is left" guard MUST go through here: a guard that
    /// only returns early leaves `bad` false, so a caller that checks Bad()
    /// and Remaining() sees a clean read of a struct that was silently left
    /// half-decoded. Found by the truncation sweep in test_sim_snapshot.cpp -
    /// two cut points out of ~250 decoded as SUCCESS before this existed.
    void Fail() { bad = true; }

    bool   Bad() const { return bad; }
    size_t Pos() const { return pos; }
    size_t Remaining() const { return bad ? 0 : size - pos; }

private:
    bool Want(size_t n) {
        if (bad || n > size - pos) { bad = true; return false; }
        return true;
    }

    const uint8_t* data = nullptr;
    size_t size = 0;
    size_t pos = 0;
    bool bad = false;
};

// ──────────────────── The field-census tripwire ────────────────────
//
// Q-P1 constraint 4 asks for a completeness tripwire modelled on
// test_synced_input_journal.cpp's classifier coverage test: the way this walk
// quietly breaks is somebody adding a field to StandingOrder or Directive and
// nobody noticing it never gets written.
//
// There is no reflection to enumerate members with, so the census uses a
// structured binding that names every member: adding, removing or reordering a
// field makes the binding count wrong and the BUILD FAILS on the struct whose
// shape moved. Each function returns the field count it destructured, which
// tests/test_sim_snapshot.cpp pins against the count the codec below writes.
//
// This only works because these are plain aggregates (public members, no user
// constructors, no bases). If one ever grows a constructor, the binding stops
// compiling and the fix is an explicit member list - not deleting the census.

int CensusStandingOrderConditions(const StandingOrderConditions& c)
{
    const auto& [idleOnly, squadTypes, withinCenter, withinRadius, outsideCenter,
                 outsideRadius, minStrength, hasCapabilities, orgGroup] = c;
    (void)idleOnly; (void)squadTypes; (void)withinCenter; (void)withinRadius;
    (void)outsideCenter; (void)outsideRadius; (void)minStrength;
    (void)hasCapabilities; (void)orgGroup;
    return 9;
}

int CensusStandingOrder(const StandingOrder& o)
{
    const auto& [id, team, authorPlayerId, type, priority, params, conditions,
                 active, createdAtFrame, expiresAtFrame, assigned] = o;
    (void)id; (void)team; (void)authorPlayerId; (void)type; (void)priority;
    (void)params; (void)conditions; (void)active; (void)createdAtFrame;
    (void)expiresAtFrame; (void)assigned;
    return 11;
}

int CensusOrgGroup(const OrgGroup& g)
{
    const auto& [id, echelon, team, parentId, members, name, currentDirectiveId,
                 postureJson, createdAtFrame] = g;
    (void)id; (void)echelon; (void)team; (void)parentId; (void)members;
    (void)name; (void)currentDirectiveId; (void)postureJson; (void)createdAtFrame;
    return 9;
}

int CensusDirective(const Directive& d)
{
    const auto& [id, team, groupId, authorPlayerId, type, priority, shape, params,
                 conditions, requestedStrength, phasesJson, active, createdAtFrame,
                 expiresAtFrame, assigned, assignedStrength] = d;
    (void)id; (void)team; (void)groupId; (void)authorPlayerId; (void)type;
    (void)priority; (void)shape; (void)params; (void)conditions;
    (void)requestedStrength; (void)phasesJson; (void)active; (void)createdAtFrame;
    (void)expiresAtFrame; (void)assigned; (void)assignedStrength;
    return 16;
}

// ─────────────────────────── Section codecs ───────────────────────────

void WriteConditions(Writer& w, const StandingOrderConditions& c)
{
    w.Bool(c.idleOnly);
    w.U32s([&] {
        std::vector<uint32_t> v;
        v.reserve(c.squadTypes.size());
        for (const uint16_t t : c.squadTypes) v.push_back(t);
        return v;
    }());
    w.Vec3(c.withinCenter);
    w.F32(c.withinRadius);
    w.Vec3(c.outsideCenter);
    w.F32(c.outsideRadius);
    w.F32(c.minStrength);
    w.Strs(c.hasCapabilities);
    w.U32(c.orgGroup);
}

StandingOrderConditions ReadConditions(Reader& r)
{
    StandingOrderConditions c;
    c.idleOnly = r.Bool();
    for (const uint32_t t : r.U32s()) c.squadTypes.push_back(static_cast<uint16_t>(t));
    c.withinCenter = r.Vec3();
    c.withinRadius = r.F32();
    c.outsideCenter = r.Vec3();
    c.outsideRadius = r.F32();
    c.minStrength = r.F32();
    c.hasCapabilities = r.Strs();
    c.orgGroup = r.U32();
    return c;
}

void WriteGlobals(Writer& w)
{
    w.I32(gs->frameNum);
    w.U64(gsRNG.GetGenState());
    w.U64(gsRNG.GetGenStream());
    // `paused` is synced state the sim reads every tick. A snapshot taken
    // while paused that resumed un-paused would start ticking a world nobody
    // asked to run.
    w.Bool(gs->paused);
}

struct GlobalsState {
    int32_t  frameNum = 0;
    uint64_t rngState = 0;
    uint64_t rngStream = 0;
    bool     paused = false;
};

GlobalsState ReadGlobals(Reader& r)
{
    GlobalsState g;
    g.frameNum  = r.I32();
    g.rngState  = r.U64();
    g.rngStream = r.U64();
    g.paused    = r.Bool();
    return g;
}

void WriteStandingOrders(Writer& w)
{
    const auto& orders = standingOrders.GetAllOrders();
    w.U32(standingOrders.NextId());
    w.U32(static_cast<uint32_t>(orders.size()));
    for (const auto& o : orders) {
        w.U32(o.id);
        w.I32(o.team);
        w.I32(o.authorPlayerId);
        w.U8(static_cast<uint8_t>(o.type));
        w.U8(o.priority);
        w.Floats(o.params);
        WriteConditions(w, o.conditions);
        w.Bool(o.active);
        w.U32(o.createdAtFrame);
        w.U32(o.expiresAtFrame);
        w.U32Set(o.assigned);
    }
}

std::vector<StandingOrder> ReadStandingOrders(Reader& r, uint32_t& nextId)
{
    nextId = r.U32();
    const uint32_t count = r.U32();
    // Cheapest possible order is ~40 bytes; refuse an absurd count before
    // reserving anything.
    if (r.Remaining() < size_t(count)) { r.Fail(); return {}; }
    std::vector<StandingOrder> orders;
    orders.reserve(count);
    for (uint32_t i = 0; i < count && !r.Bad(); ++i) {
        StandingOrder o;
        o.id = r.U32();
        o.team = r.I32();
        o.authorPlayerId = r.I32();
        o.type = static_cast<StandingOrderType>(r.U8());
        o.priority = r.U8();
        o.params = r.Floats();
        o.conditions = ReadConditions(r);
        o.active = r.Bool();
        o.createdAtFrame = r.U32();
        o.expiresAtFrame = r.U32();
        o.assigned = r.U32Set();
        orders.push_back(std::move(o));
    }
    return orders;
}

void WriteOrgGroups(Writer& w)
{
    const auto& groups = orgGroups.GetAllGroups();
    w.U32(orgGroups.NextId());
    w.U32(static_cast<uint32_t>(groups.size()));
    for (const auto& g : groups) {
        w.U32(g.id);
        w.U8(static_cast<uint8_t>(g.echelon));
        w.I32(g.team);
        w.U32(g.parentId);
        w.U32s(g.members);
        w.Str(g.name);
        w.U32(g.currentDirectiveId);
        w.Str(g.postureJson);
        w.U32(g.createdAtFrame);
    }
}

std::vector<OrgGroup> ReadOrgGroups(Reader& r, uint32_t& nextId)
{
    nextId = r.U32();
    const uint32_t count = r.U32();
    if (r.Remaining() < size_t(count)) { r.Fail(); return {}; }
    std::vector<OrgGroup> groups;
    groups.reserve(count);
    for (uint32_t i = 0; i < count && !r.Bad(); ++i) {
        OrgGroup g;
        g.id = r.U32();
        g.echelon = static_cast<Echelon>(r.U8());
        g.team = r.I32();
        g.parentId = r.U32();
        g.members = r.U32s();
        g.name = r.Str();
        g.currentDirectiveId = r.U32();
        g.postureJson = r.Str();
        g.createdAtFrame = r.U32();
        groups.push_back(std::move(g));
    }
    return groups;
}

void WriteDirectives(Writer& w)
{
    const auto& dirs = directiveManager.GetAllDirectives();
    w.U32(directiveManager.NextId());
    w.U32(static_cast<uint32_t>(dirs.size()));
    for (const auto& d : dirs) {
        w.U32(d.id);
        w.I32(d.team);
        w.U32(d.groupId);
        w.I32(d.authorPlayerId);
        w.U8(static_cast<uint8_t>(d.type));
        w.U8(d.priority);
        w.U8(static_cast<uint8_t>(d.shape));
        w.Floats(d.params);
        WriteConditions(w, d.conditions);
        w.U32(d.requestedStrength);
        w.Str(d.phasesJson);
        w.Bool(d.active);
        w.U32(d.createdAtFrame);
        w.U32(d.expiresAtFrame);
        w.U32Set(d.assigned);
        w.F32(d.assignedStrength);
    }
}

std::vector<Directive> ReadDirectives(Reader& r, uint32_t& nextId)
{
    nextId = r.U32();
    const uint32_t count = r.U32();
    if (r.Remaining() < size_t(count)) { r.Fail(); return {}; }
    std::vector<Directive> dirs;
    dirs.reserve(count);
    for (uint32_t i = 0; i < count && !r.Bad(); ++i) {
        Directive d;
        d.id = r.U32();
        d.team = r.I32();
        d.groupId = r.U32();
        d.authorPlayerId = r.I32();
        d.type = static_cast<DirectiveType>(r.U8());
        d.priority = r.U8();
        d.shape = static_cast<OrderShape>(r.U8());
        d.params = r.Floats();
        d.conditions = ReadConditions(r);
        d.requestedStrength = r.U32();
        d.phasesJson = r.Str();
        d.active = r.Bool();
        d.createdAtFrame = r.U32();
        d.expiresAtFrame = r.U32();
        d.assigned = r.U32Set();
        d.assignedStrength = r.F32();
        dirs.push_back(std::move(d));
    }
    return dirs;
}

// ──────────── Task 1c codecs: teams + units (PLAN-persistence §7.1c) ────────────
//
// Everything here works on the plain state structs from the header, never on a
// CTeam/CUnit. That is what makes the bytes testable without a sim.

void WriteRes(Writer& w, const ResPair& r) { w.F32(r.metal); w.F32(r.energy); }
ResPair ReadRes(Reader& r) { ResPair p; p.metal = r.F32(); p.energy = r.F32(); return p; }

void WriteRulesParams(Writer& w, const std::vector<RulesParamState>& ps)
{
    w.U32(static_cast<uint32_t>(ps.size()));
    for (const auto& p : ps) {
        w.Str(p.key);
        w.I32(p.los);
        w.U8(p.type);
        w.Bool(p.b);
        w.F32(p.f);
        w.Str(p.s);
    }
}

std::vector<RulesParamState> ReadRulesParams(Reader& r)
{
    const uint32_t n = r.U32();
    // Cheapest param is a 4-byte key length + los + type + bool + float + a
    // 4-byte string length: refuse an absurd count before reserving.
    if (r.Remaining() < size_t(n) * 4) { r.Fail(); return {}; }
    std::vector<RulesParamState> ps;
    ps.reserve(n);
    for (uint32_t i = 0; i < n && !r.Bad(); ++i) {
        RulesParamState p;
        p.key  = r.Str();
        p.los  = r.I32();
        p.type = r.U8();
        p.b    = r.Bool();
        p.f    = r.F32();
        p.s    = r.Str();
        ps.push_back(std::move(p));
    }
    return ps;
}

void WriteStats(Writer& w, const TeamStatsState& s)
{
    w.I32(s.frame);
    w.F32(s.metalUsed);     w.F32(s.energyUsed);
    w.F32(s.metalProduced); w.F32(s.energyProduced);
    w.F32(s.metalExcess);   w.F32(s.energyExcess);
    w.F32(s.metalReceived); w.F32(s.energyReceived);
    w.F32(s.metalSent);     w.F32(s.energySent);
    w.F32(s.damageDealt);   w.F32(s.damageReceived);
    w.I32(s.unitsProduced);
    w.I32(s.unitsDied);
    w.I32(s.unitsReceived);
    w.I32(s.unitsSent);
    w.I32(s.unitsCaptured);
    w.I32(s.unitsOutCaptured);
    w.I32(s.unitsKilled);
}

TeamStatsState ReadStats(Reader& r)
{
    TeamStatsState s;
    s.frame = r.I32();
    s.metalUsed     = r.F32(); s.energyUsed     = r.F32();
    s.metalProduced = r.F32(); s.energyProduced = r.F32();
    s.metalExcess   = r.F32(); s.energyExcess   = r.F32();
    s.metalReceived = r.F32(); s.energyReceived = r.F32();
    s.metalSent     = r.F32(); s.energySent     = r.F32();
    s.damageDealt   = r.F32(); s.damageReceived = r.F32();
    s.unitsProduced    = r.I32();
    s.unitsDied        = r.I32();
    s.unitsReceived    = r.I32();
    s.unitsSent        = r.I32();
    s.unitsCaptured    = r.I32();
    s.unitsOutCaptured = r.I32();
    s.unitsKilled      = r.I32();
    return s;
}

void WriteTeam(Writer& w, const TeamState& t)
{
    w.I32(t.teamNum);
    w.Bool(t.isDead);
    w.Bool(t.gaia);
    w.I32(t.leader);
    w.F32(t.incomeMultiplier);
    w.F32(t.startPosX); w.F32(t.startPosY); w.F32(t.startPosZ);

    WriteRes(w, t.res);         WriteRes(w, t.resStorage);
    WriteRes(w, t.resPull);     WriteRes(w, t.resPrevPull);
    WriteRes(w, t.resIncome);   WriteRes(w, t.resPrevIncome);
    WriteRes(w, t.resExpense);  WriteRes(w, t.resPrevExpense);
    WriteRes(w, t.resShare);    WriteRes(w, t.resDelayedShare);
    WriteRes(w, t.resSent);     WriteRes(w, t.resPrevSent);
    WriteRes(w, t.resReceived); WriteRes(w, t.resPrevReceived);
    WriteRes(w, t.resPrevExcess);

    w.I32(t.nextHistoryEntry);
    w.U32(static_cast<uint32_t>(t.statHistory.size()));
    for (const auto& s : t.statHistory) WriteStats(w, s);
    WriteRulesParams(w, t.modParams);
}

TeamState ReadTeam(Reader& r)
{
    TeamState t;
    t.teamNum = r.I32();
    t.isDead = r.Bool();
    t.gaia = r.Bool();
    t.leader = r.I32();
    t.incomeMultiplier = r.F32();
    t.startPosX = r.F32(); t.startPosY = r.F32(); t.startPosZ = r.F32();

    t.res         = ReadRes(r); t.resStorage       = ReadRes(r);
    t.resPull     = ReadRes(r); t.resPrevPull      = ReadRes(r);
    t.resIncome   = ReadRes(r); t.resPrevIncome    = ReadRes(r);
    t.resExpense  = ReadRes(r); t.resPrevExpense   = ReadRes(r);
    t.resShare    = ReadRes(r); t.resDelayedShare  = ReadRes(r);
    t.resSent     = ReadRes(r); t.resPrevSent      = ReadRes(r);
    t.resReceived = ReadRes(r); t.resPrevReceived  = ReadRes(r);
    t.resPrevExcess = ReadRes(r);

    t.nextHistoryEntry = r.I32();
    const uint32_t n = r.U32();
    // A stats row is 80 bytes; the count check keeps a corrupt length from
    // reserving gigabytes before it fails.
    if (r.Remaining() < size_t(n) * 4) { r.Fail(); return t; }
    t.statHistory.reserve(n);
    for (uint32_t i = 0; i < n && !r.Bad(); ++i) t.statHistory.push_back(ReadStats(r));
    t.modParams = ReadRulesParams(r);
    return t;
}

void WriteCommand(Writer& w, const CommandState& c)
{
    w.I32(c.cmdID);
    w.I32(c.aiCallbackID);
    w.I32(c.timeOut);
    w.U32(c.tag);
    w.U8(c.options);
    w.Floats(c.params);
}

CommandState ReadCommand(Reader& r)
{
    CommandState c;
    c.cmdID        = r.I32();
    c.aiCallbackID = r.I32();
    c.timeOut      = r.I32();
    c.tag          = r.U32();
    c.options      = r.U8();
    c.params       = r.Floats();
    return c;
}

void WriteWeapon(Writer& w, const WeaponState& s)
{
    w.I32(s.reloadStatus);
    w.I32(s.salvoLeft);
    w.I32(s.nextSalvo);
    w.I32(s.numStockpiled);
    w.I32(s.numStockpileQued);
}

WeaponState ReadWeapon(Reader& r)
{
    WeaponState s;
    s.reloadStatus     = r.I32();
    s.salvoLeft        = r.I32();
    s.nextSalvo        = r.I32();
    s.numStockpiled    = r.I32();
    s.numStockpileQued = r.I32();
    return s;
}

void WriteUnit(Writer& w, const UnitState& u)
{
    w.I32(u.id);
    w.Str(u.unitDefName);
    w.I32(u.team);
    w.I32(u.buildFacing);
    w.Bool(u.beingBuilt);

    w.F32(u.posX); w.F32(u.posY); w.F32(u.posZ);
    w.F32(u.speedX); w.F32(u.speedY); w.F32(u.speedZ);
    w.I32(u.heading);
    w.F32(u.frontX); w.F32(u.frontY); w.F32(u.frontZ);
    w.F32(u.rightX); w.F32(u.rightY); w.F32(u.rightZ);
    w.F32(u.upX); w.F32(u.upY); w.F32(u.upZ);
    w.U32(u.physicalState);
    w.U32(u.collidableState);

    w.F32(u.health); w.F32(u.maxHealth);
    w.F32(u.paralyzeDamage); w.F32(u.captureProgress); w.F32(u.buildProgress);
    w.F32(u.experience); w.F32(u.recentDamage);
    w.F32(u.power); w.F32(u.mass); w.F32(u.buildTime);
    w.F32(u.terraformLeft); w.F32(u.repairAmount); w.F32(u.metalExtract);
    WriteRes(w, u.cost); WriteRes(w, u.harvested);
    WriteRes(w, u.harvestStorage); WriteRes(w, u.storage);

    w.I32(u.fireState); w.I32(u.moveState);
    w.Bool(u.armoredState);
    w.F32(u.armoredMultiple); w.F32(u.curArmorMultiple);
    w.I32(u.armorType);
    w.U32(u.category);
    w.F32(u.maxRange); w.F32(u.reloadSpeed);
    w.I32(u.flankingBonusMode);
    w.F32(u.flankingDirX); w.F32(u.flankingDirY); w.F32(u.flankingDirZ);
    w.F32(u.flankingBonusMobility); w.F32(u.flankingBonusMobilityAdd);
    w.F32(u.flankingBonusAvgDamage); w.F32(u.flankingBonusDifDamage);
    w.Bool(u.onTempHoldFire); w.Bool(u.forceUseWeapons); w.Bool(u.allowUseWeapons);
    w.Bool(u.inBuildStance); w.Bool(u.useHighTrajectory);
    w.I32(u.selfDCountdown); w.I32(u.delayedWreckLevel); w.I32(u.featureDefID);
    w.I32(u.lastAttackFrame); w.I32(u.lastFireWeapon); w.I32(u.lastNanoAdd);
    w.U32(u.restTime);

    w.I32(u.losRadius); w.I32(u.airLosRadius);
    w.I32(u.realLosRadius); w.I32(u.realAirLosRadius);
    w.I32(u.radarRadius); w.I32(u.sonarRadius); w.I32(u.jammerRadius);
    w.I32(u.sonarJamRadius); w.I32(u.seismicRadius);
    w.F32(u.seismicSignature); w.F32(u.decloakDistance);
    w.Bool(u.stealth); w.Bool(u.sonarStealth);
    w.Bool(u.isCloaked); w.Bool(u.wantCloak);
    w.Bool(u.alwaysVisible); w.Bool(u.useAirLos);
    w.F32(u.posErrX); w.F32(u.posErrY); w.F32(u.posErrZ);
    w.F32(u.posErrDeltaX); w.F32(u.posErrDeltaY); w.F32(u.posErrDeltaZ);
    w.I32(u.nextPosErrorUpdate);

    w.Bool(u.activated); w.Bool(u.neutral); w.Bool(u.upright);
    w.Bool(u.groundLevelled); w.Bool(u.stunned); w.Bool(u.invulnerable);
    w.Bool(u.noSelect);

    w.I32(u.transporterId);
    w.I32(u.loadingTransportId);
    w.I32(u.unloadingTransportId);
    w.I32(u.transportCapacityUsed);
    w.F32(u.transportMassUsed);
    w.U32(static_cast<uint32_t>(u.transportees.size()));
    for (const auto& p : u.transportees) { w.I32(p.first); w.I32(p.second); }

    w.U32(static_cast<uint32_t>(u.commands.size()));
    for (const auto& c : u.commands) WriteCommand(w, c);
    w.I32(u.tagCounter);
    w.Bool(u.repeatOrders);
    w.I32(u.lastUserCommand); w.I32(u.lastFinishCommand);

    w.U32(static_cast<uint32_t>(u.weapons.size()));
    for (const auto& s : u.weapons) WriteWeapon(w, s);
    WriteRulesParams(w, u.modParams);
}

UnitState ReadUnit(Reader& r)
{
    UnitState u;
    u.id = r.I32();
    u.unitDefName = r.Str();
    u.team = r.I32();
    u.buildFacing = r.I32();
    u.beingBuilt = r.Bool();

    u.posX = r.F32(); u.posY = r.F32(); u.posZ = r.F32();
    u.speedX = r.F32(); u.speedY = r.F32(); u.speedZ = r.F32();
    u.heading = r.I32();
    u.frontX = r.F32(); u.frontY = r.F32(); u.frontZ = r.F32();
    u.rightX = r.F32(); u.rightY = r.F32(); u.rightZ = r.F32();
    u.upX = r.F32(); u.upY = r.F32(); u.upZ = r.F32();
    u.physicalState = r.U32();
    u.collidableState = r.U32();

    u.health = r.F32(); u.maxHealth = r.F32();
    u.paralyzeDamage = r.F32(); u.captureProgress = r.F32(); u.buildProgress = r.F32();
    u.experience = r.F32(); u.recentDamage = r.F32();
    u.power = r.F32(); u.mass = r.F32(); u.buildTime = r.F32();
    u.terraformLeft = r.F32(); u.repairAmount = r.F32(); u.metalExtract = r.F32();
    u.cost = ReadRes(r); u.harvested = ReadRes(r);
    u.harvestStorage = ReadRes(r); u.storage = ReadRes(r);

    u.fireState = r.I32(); u.moveState = r.I32();
    u.armoredState = r.Bool();
    u.armoredMultiple = r.F32(); u.curArmorMultiple = r.F32();
    u.armorType = r.I32();
    u.category = r.U32();
    u.maxRange = r.F32(); u.reloadSpeed = r.F32();
    u.flankingBonusMode = r.I32();
    u.flankingDirX = r.F32(); u.flankingDirY = r.F32(); u.flankingDirZ = r.F32();
    u.flankingBonusMobility = r.F32(); u.flankingBonusMobilityAdd = r.F32();
    u.flankingBonusAvgDamage = r.F32(); u.flankingBonusDifDamage = r.F32();
    u.onTempHoldFire = r.Bool(); u.forceUseWeapons = r.Bool(); u.allowUseWeapons = r.Bool();
    u.inBuildStance = r.Bool(); u.useHighTrajectory = r.Bool();
    u.selfDCountdown = r.I32(); u.delayedWreckLevel = r.I32(); u.featureDefID = r.I32();
    u.lastAttackFrame = r.I32(); u.lastFireWeapon = r.I32(); u.lastNanoAdd = r.I32();
    u.restTime = r.U32();

    u.losRadius = r.I32(); u.airLosRadius = r.I32();
    u.realLosRadius = r.I32(); u.realAirLosRadius = r.I32();
    u.radarRadius = r.I32(); u.sonarRadius = r.I32(); u.jammerRadius = r.I32();
    u.sonarJamRadius = r.I32(); u.seismicRadius = r.I32();
    u.seismicSignature = r.F32(); u.decloakDistance = r.F32();
    u.stealth = r.Bool(); u.sonarStealth = r.Bool();
    u.isCloaked = r.Bool(); u.wantCloak = r.Bool();
    u.alwaysVisible = r.Bool(); u.useAirLos = r.Bool();
    u.posErrX = r.F32(); u.posErrY = r.F32(); u.posErrZ = r.F32();
    u.posErrDeltaX = r.F32(); u.posErrDeltaY = r.F32(); u.posErrDeltaZ = r.F32();
    u.nextPosErrorUpdate = r.I32();

    u.activated = r.Bool(); u.neutral = r.Bool(); u.upright = r.Bool();
    u.groundLevelled = r.Bool(); u.stunned = r.Bool(); u.invulnerable = r.Bool();
    u.noSelect = r.Bool();

    u.transporterId = r.I32();
    u.loadingTransportId = r.I32();
    u.unloadingTransportId = r.I32();
    u.transportCapacityUsed = r.I32();
    u.transportMassUsed = r.F32();
    {
        const uint32_t n = r.U32();
        if (r.Remaining() < size_t(n) * 8) { r.Fail(); return u; }
        u.transportees.reserve(n);
        for (uint32_t i = 0; i < n && !r.Bad(); ++i) {
            const int32_t tid = r.I32();
            const int32_t piece = r.I32();
            u.transportees.emplace_back(tid, piece);
        }
    }
    {
        const uint32_t n = r.U32();
        // Cheapest command is 17 bytes; 4 is the conservative floor.
        if (r.Remaining() < size_t(n) * 4) { r.Fail(); return u; }
        u.commands.reserve(n);
        for (uint32_t i = 0; i < n && !r.Bad(); ++i) u.commands.push_back(ReadCommand(r));
    }
    u.tagCounter = r.I32();
    u.repeatOrders = r.Bool();
    u.lastUserCommand = r.I32(); u.lastFinishCommand = r.I32();
    {
        const uint32_t n = r.U32();
        if (r.Remaining() < size_t(n) * 4) { r.Fail(); return u; }
        u.weapons.reserve(n);
        for (uint32_t i = 0; i < n && !r.Bad(); ++i) u.weapons.push_back(ReadWeapon(r));
    }
    u.modParams = ReadRulesParams(r);
    return u;
}

// ── The task 1c censuses (the structs above are aggregates, so the same
//    structured-binding trick as 1b's applies to all six) ──

int CensusResPair(const ResPair& r)
{
    const auto& [metal, energy] = r;
    (void)metal; (void)energy;
    return 2;
}

int CensusRulesParam(const RulesParamState& p)
{
    const auto& [key, los, type, b, f, s] = p;
    (void)key; (void)los; (void)type; (void)b; (void)f; (void)s;
    return 6;
}

int CensusStats(const TeamStatsState& s)
{
    const auto& [frame, metalUsed, energyUsed, metalProduced, energyProduced,
                 metalExcess, energyExcess, metalReceived, energyReceived,
                 metalSent, energySent, damageDealt, damageReceived,
                 unitsProduced, unitsDied, unitsReceived, unitsSent,
                 unitsCaptured, unitsOutCaptured, unitsKilled] = s;
    (void)frame; (void)metalUsed; (void)energyUsed; (void)metalProduced;
    (void)energyProduced; (void)metalExcess; (void)energyExcess;
    (void)metalReceived; (void)energyReceived; (void)metalSent; (void)energySent;
    (void)damageDealt; (void)damageReceived; (void)unitsProduced; (void)unitsDied;
    (void)unitsReceived; (void)unitsSent; (void)unitsCaptured;
    (void)unitsOutCaptured; (void)unitsKilled;
    return 20;
}

int CensusTeamState(const TeamState& t)
{
    const auto& [teamNum, isDead, gaia, leader, incomeMultiplier,
                 startPosX, startPosY, startPosZ,
                 res, resStorage, resPull, resPrevPull, resIncome, resPrevIncome,
                 resExpense, resPrevExpense, resShare, resDelayedShare,
                 resSent, resPrevSent, resReceived, resPrevReceived, resPrevExcess,
                 nextHistoryEntry, statHistory, modParams] = t;
    (void)teamNum; (void)isDead; (void)gaia; (void)leader; (void)incomeMultiplier;
    (void)startPosX; (void)startPosY; (void)startPosZ;
    (void)res; (void)resStorage; (void)resPull; (void)resPrevPull;
    (void)resIncome; (void)resPrevIncome; (void)resExpense; (void)resPrevExpense;
    (void)resShare; (void)resDelayedShare; (void)resSent; (void)resPrevSent;
    (void)resReceived; (void)resPrevReceived; (void)resPrevExcess;
    (void)nextHistoryEntry; (void)statHistory; (void)modParams;
    return 26;
}

int CensusCommandState(const CommandState& c)
{
    const auto& [cmdID, aiCallbackID, timeOut, tag, options, params] = c;
    (void)cmdID; (void)aiCallbackID; (void)timeOut; (void)tag; (void)options;
    (void)params;
    return 6;
}

int CensusWeaponState(const WeaponState& s)
{
    const auto& [reloadStatus, salvoLeft, nextSalvo, numStockpiled,
                 numStockpileQued] = s;
    (void)reloadStatus; (void)salvoLeft; (void)nextSalvo; (void)numStockpiled;
    (void)numStockpileQued;
    return 5;
}

int CensusUnitState(const UnitState& u)
{
    const auto& [id, unitDefName, team, buildFacing, beingBuilt,
                 posX, posY, posZ, speedX, speedY, speedZ, heading,
                 frontX, frontY, frontZ, rightX, rightY, rightZ, upX, upY, upZ,
                 physicalState, collidableState,
                 health, maxHealth, paralyzeDamage, captureProgress, buildProgress,
                 experience, recentDamage, power, mass, buildTime,
                 terraformLeft, repairAmount, metalExtract,
                 cost, harvested, harvestStorage, storage,
                 fireState, moveState, armoredState, armoredMultiple,
                 curArmorMultiple, armorType, category, maxRange, reloadSpeed,
                 flankingBonusMode, flankingDirX, flankingDirY, flankingDirZ,
                 flankingBonusMobility, flankingBonusMobilityAdd,
                 flankingBonusAvgDamage, flankingBonusDifDamage,
                 onTempHoldFire, forceUseWeapons, allowUseWeapons,
                 inBuildStance, useHighTrajectory,
                 selfDCountdown, delayedWreckLevel, featureDefID,
                 lastAttackFrame, lastFireWeapon, lastNanoAdd, restTime,
                 losRadius, airLosRadius, realLosRadius, realAirLosRadius,
                 radarRadius, sonarRadius, jammerRadius, sonarJamRadius,
                 seismicRadius, seismicSignature, decloakDistance,
                 stealth, sonarStealth, isCloaked, wantCloak,
                 alwaysVisible, useAirLos,
                 posErrX, posErrY, posErrZ,
                 posErrDeltaX, posErrDeltaY, posErrDeltaZ, nextPosErrorUpdate,
                 activated, neutral, upright, groundLevelled, stunned,
                 invulnerable, noSelect,
                 transporterId, loadingTransportId, unloadingTransportId,
                 transportCapacityUsed, transportMassUsed, transportees,
                 commands, tagCounter, repeatOrders, lastUserCommand,
                 lastFinishCommand, weapons, modParams] = u;
    (void)id; (void)unitDefName; (void)team; (void)buildFacing; (void)beingBuilt;
    (void)posX; (void)posY; (void)posZ; (void)speedX; (void)speedY; (void)speedZ;
    (void)heading; (void)frontX; (void)frontY; (void)frontZ;
    (void)rightX; (void)rightY; (void)rightZ; (void)upX; (void)upY; (void)upZ;
    (void)physicalState; (void)collidableState;
    (void)health; (void)maxHealth; (void)paralyzeDamage; (void)captureProgress;
    (void)buildProgress; (void)experience; (void)recentDamage; (void)power;
    (void)mass; (void)buildTime; (void)terraformLeft; (void)repairAmount;
    (void)metalExtract; (void)cost; (void)harvested; (void)harvestStorage;
    (void)storage; (void)fireState; (void)moveState; (void)armoredState;
    (void)armoredMultiple; (void)curArmorMultiple; (void)armorType; (void)category;
    (void)maxRange; (void)reloadSpeed; (void)flankingBonusMode;
    (void)flankingDirX; (void)flankingDirY; (void)flankingDirZ;
    (void)flankingBonusMobility; (void)flankingBonusMobilityAdd;
    (void)flankingBonusAvgDamage; (void)flankingBonusDifDamage;
    (void)onTempHoldFire; (void)forceUseWeapons; (void)allowUseWeapons;
    (void)inBuildStance; (void)useHighTrajectory; (void)selfDCountdown;
    (void)delayedWreckLevel; (void)featureDefID; (void)lastAttackFrame;
    (void)lastFireWeapon; (void)lastNanoAdd; (void)restTime;
    (void)losRadius; (void)airLosRadius; (void)realLosRadius;
    (void)realAirLosRadius; (void)radarRadius; (void)sonarRadius;
    (void)jammerRadius; (void)sonarJamRadius; (void)seismicRadius;
    (void)seismicSignature; (void)decloakDistance; (void)stealth;
    (void)sonarStealth; (void)isCloaked; (void)wantCloak; (void)alwaysVisible;
    (void)useAirLos; (void)posErrX; (void)posErrY; (void)posErrZ;
    (void)posErrDeltaX; (void)posErrDeltaY; (void)posErrDeltaZ;
    (void)nextPosErrorUpdate; (void)activated; (void)neutral; (void)upright;
    (void)groundLevelled; (void)stunned; (void)invulnerable; (void)noSelect;
    (void)transporterId; (void)loadingTransportId; (void)unloadingTransportId;
    (void)transportCapacityUsed; (void)transportMassUsed; (void)transportees;
    (void)commands; (void)tagCounter; (void)repeatOrders; (void)lastUserCommand;
    (void)lastFinishCommand; (void)weapons; (void)modParams;
    return 113;
}

/// Flatten a LuaRulesParams::Params map into the wire form, SORTED BY KEY: the
/// map is unordered, and a snapshot whose byte layout depends on hash order is
/// not comparable against a second snapshot of the same state.
std::vector<RulesParamState> CaptureRulesParams(const LuaRulesParams::Params& in)
{
    std::vector<RulesParamState> out;
    out.reserve(in.size());
    for (const auto& [key, param] : in) {
        RulesParamState p;
        p.key = key;
        p.los = param.los;
        if (std::holds_alternative<bool>(param.value)) {
            p.type = 0;
            p.b = std::get<bool>(param.value);
        } else if (std::holds_alternative<float>(param.value)) {
            p.type = 1;
            p.f = std::get<float>(param.value);
        } else {
            p.type = 2;
            p.s = std::get<std::string>(param.value);
        }
        out.push_back(std::move(p));
    }
    std::sort(out.begin(), out.end(),
              [](const RulesParamState& a, const RulesParamState& b) { return a.key < b.key; });
    return out;
}

void ApplyRulesParams(const std::vector<RulesParamState>& in, LuaRulesParams::Params& out)
{
    out.clear();
    for (const auto& p : in) {
        LuaRulesParams::Param param;
        param.los = p.los;
        switch (p.type) {
            case 0:  param.value = p.b; break;
            case 1:  param.value = p.f; break;
            default: param.value = p.s; break;
        }
        out[p.key] = std::move(param);
    }
}

const SectionSpec* SpecFor(uint16_t id)
{
    for (const auto& s : Sections()) {
        if (static_cast<uint16_t>(s.id) == id) return &s;
    }
    return nullptr;
}

} // namespace

// ───────────── Task 1c: section codecs (public, for the tests) ─────────────

void EncodeTeams(const std::vector<TeamState>& in, std::vector<uint8_t>& out)
{
    Writer w(out);
    w.U32(static_cast<uint32_t>(in.size()));
    for (const auto& t : in) WriteTeam(w, t);
}

bool DecodeTeams(const uint8_t* data, size_t size,
                 std::vector<TeamState>& out, std::string& err)
{
    Reader r(data, size);
    const uint32_t count = r.U32();
    if (r.Remaining() < size_t(count)) {
        err = "teams section claims " + std::to_string(count) + " teams in " +
              std::to_string(size) + " bytes";
        return false;
    }
    out.clear();
    out.reserve(count);
    for (uint32_t i = 0; i < count && !r.Bad(); ++i) out.push_back(ReadTeam(r));
    if (r.Bad()) {
        err = "teams section is truncated";
        return false;
    }
    if (r.Remaining() != 0) {
        err = "teams section has " + std::to_string(r.Remaining()) +
              " unread trailing bytes";
        return false;
    }
    return true;
}

void EncodeUnits(const std::vector<UnitState>& in, std::vector<uint8_t>& out)
{
    Writer w(out);
    w.U32(static_cast<uint32_t>(in.size()));
    for (const auto& u : in) WriteUnit(w, u);
}

bool DecodeUnits(const uint8_t* data, size_t size,
                 std::vector<UnitState>& out, std::string& err)
{
    Reader r(data, size);
    const uint32_t count = r.U32();
    if (r.Remaining() < size_t(count)) {
        err = "units section claims " + std::to_string(count) + " units in " +
              std::to_string(size) + " bytes";
        return false;
    }
    out.clear();
    out.reserve(count);
    for (uint32_t i = 0; i < count && !r.Bad(); ++i) out.push_back(ReadUnit(r));
    if (r.Bad()) {
        err = "units section is truncated";
        return false;
    }
    if (r.Remaining() != 0) {
        err = "units section has " + std::to_string(r.Remaining()) +
              " unread trailing bytes";
        return false;
    }
    return true;
}

// ───────────── Task 1c: capture / apply (the sim-touching halves) ─────────────
//
// THE TRIPWIRE FOR THESE TWO CLASSES. CTeam and CUnit are not aggregates
// (private members, base classes), so the structured-binding census cannot
// destructure them the way it does StandingOrder. The tripwire is instead a
// size assert: adding a member to either class almost always moves sizeof, and
// the failure message points at PLAN-persistence §7.1c so whoever added the
// field decides its disposition (captured / re-derived / rebuilt / dropped)
// instead of discovering years later that it was never snapshotted.
//
// Stated limitation, because it is real: a member that fits inside existing
// padding does NOT move sizeof. This assert is a prompt, not a proof — what
// proves the payload covers what it claims is the round-trip tests over the
// state structs above.
static_assert(sizeof(CTeam) == 624,
              "CTeam changed shape - revisit the snapshot fidelity contract "
              "(PLAN-persistence.md §7.1c) and TeamState, then update this size");
static_assert(sizeof(CUnit) == 4040,
              "CUnit changed shape - revisit the snapshot fidelity contract "
              "(PLAN-persistence.md §7.1c) and UnitState, then update this size");

void CaptureTeams(std::vector<TeamState>& out)
{
    out.clear();
    for (int i = 0; i < teamHandler.ActiveTeams(); ++i) {
        const CTeam* team = teamHandler.Team(i);
        TeamState s;
        s.teamNum = team->teamNum;
        s.isDead  = team->isDead;
        s.gaia    = team->gaia;
        s.leader  = team->GetLeader();
        s.incomeMultiplier = team->GetIncomeMultiplier();
        const float3& sp = team->GetStartPos();
        s.startPosX = sp.x; s.startPosY = sp.y; s.startPosZ = sp.z;

        const auto pack = [](const SResourcePack& p) {
            ResPair r; r.metal = p.metal; r.energy = p.energy; return r;
        };
        s.res             = pack(team->res);
        s.resStorage      = pack(team->resStorage);
        s.resPull         = pack(team->resPull);
        s.resPrevPull     = pack(team->resPrevPull);
        s.resIncome       = pack(team->resIncome);
        s.resPrevIncome   = pack(team->resPrevIncome);
        s.resExpense      = pack(team->resExpense);
        s.resPrevExpense  = pack(team->resPrevExpense);
        s.resShare        = pack(team->resShare);
        s.resDelayedShare = pack(team->resDelayedShare);
        s.resSent         = pack(team->resSent);
        s.resPrevSent     = pack(team->resPrevSent);
        s.resReceived     = pack(team->resReceived);
        s.resPrevReceived = pack(team->resPrevReceived);
        s.resPrevExcess   = pack(team->resPrevExcess);

        s.nextHistoryEntry = team->nextHistoryEntry;
        s.statHistory.reserve(team->statHistory.size());
        for (const TeamStatistics& st : team->statHistory) {
            TeamStatsState o;
            o.frame = st.frame;
            o.metalUsed = st.metalUsed;         o.energyUsed = st.energyUsed;
            o.metalProduced = st.metalProduced; o.energyProduced = st.energyProduced;
            o.metalExcess = st.metalExcess;     o.energyExcess = st.energyExcess;
            o.metalReceived = st.metalReceived; o.energyReceived = st.energyReceived;
            o.metalSent = st.metalSent;         o.energySent = st.energySent;
            o.damageDealt = st.damageDealt;     o.damageReceived = st.damageReceived;
            o.unitsProduced = st.unitsProduced;
            o.unitsDied = st.unitsDied;
            o.unitsReceived = st.unitsReceived;
            o.unitsSent = st.unitsSent;
            o.unitsCaptured = st.unitsCaptured;
            o.unitsOutCaptured = st.unitsOutCaptured;
            o.unitsKilled = st.unitsKilled;
            s.statHistory.push_back(o);
        }
        s.modParams = CaptureRulesParams(team->modParams);
        out.push_back(std::move(s));
    }
}

bool ResolveTeams(const std::vector<TeamState>& in, std::string& err)
{
    for (const auto& s : in) {
        if (!teamHandler.IsValidTeam(s.teamNum)) {
            err = "snapshot has team " + std::to_string(s.teamNum) +
                  " but this game has " + std::to_string(teamHandler.ActiveTeams()) +
                  " teams";
            return false;
        }
    }
    return true;
}

void ApplyTeams(const std::vector<TeamState>& in)
{
    for (const auto& s : in) {
        CTeam* team = teamHandler.Team(s.teamNum);
        team->isDead = s.isDead;
        team->gaia   = s.gaia;
        team->SetLeader(s.leader);
        team->SetIncomeMultiplier(s.incomeMultiplier);
        team->SetStartPos(float3(s.startPosX, s.startPosY, s.startPosZ));

        const auto unpack = [](const ResPair& r) { return SResourcePack(r.metal, r.energy); };
        team->res             = unpack(s.res);
        team->resStorage      = unpack(s.resStorage);
        team->resPull         = unpack(s.resPull);
        team->resPrevPull     = unpack(s.resPrevPull);
        team->resIncome       = unpack(s.resIncome);
        team->resPrevIncome   = unpack(s.resPrevIncome);
        team->resExpense      = unpack(s.resExpense);
        team->resPrevExpense  = unpack(s.resPrevExpense);
        team->resShare        = unpack(s.resShare);
        team->resDelayedShare = unpack(s.resDelayedShare);
        team->resSent         = unpack(s.resSent);
        team->resPrevSent     = unpack(s.resPrevSent);
        team->resReceived     = unpack(s.resReceived);
        team->resPrevReceived = unpack(s.resPrevReceived);
        team->resPrevExcess   = unpack(s.resPrevExcess);

        team->nextHistoryEntry = s.nextHistoryEntry;
        // statHistory must never be empty: GetCurrentStats() is back() and is
        // called from the sim every SlowUpdate.
        team->statHistory.clear();
        for (const auto& o : s.statHistory) {
            TeamStatistics st;
            st.frame = o.frame;
            st.metalUsed = o.metalUsed;         st.energyUsed = o.energyUsed;
            st.metalProduced = o.metalProduced; st.energyProduced = o.energyProduced;
            st.metalExcess = o.metalExcess;     st.energyExcess = o.energyExcess;
            st.metalReceived = o.metalReceived; st.energyReceived = o.energyReceived;
            st.metalSent = o.metalSent;         st.energySent = o.energySent;
            st.damageDealt = o.damageDealt;     st.damageReceived = o.damageReceived;
            st.unitsProduced = o.unitsProduced;
            st.unitsDied = o.unitsDied;
            st.unitsReceived = o.unitsReceived;
            st.unitsSent = o.unitsSent;
            st.unitsCaptured = o.unitsCaptured;
            st.unitsOutCaptured = o.unitsOutCaptured;
            st.unitsKilled = o.unitsKilled;
            team->statHistory.push_back(st);
        }
        if (team->statHistory.empty())
            team->statHistory.emplace_back();

        ApplyRulesParams(s.modParams, team->modParams);
    }
}

void CaptureUnits(std::vector<UnitState>& out)
{
    out.clear();
    std::vector<CUnit*> live(unitHandler.GetActiveUnits().begin(),
                             unitHandler.GetActiveUnits().end());
    // Ascending id, so two snapshots of the same world are byte-comparable
    // (activeUnits is in insertion order, which a kill+rebuild reshuffles).
    std::sort(live.begin(), live.end(),
              [](const CUnit* a, const CUnit* b) { return a->id < b->id; });

    out.reserve(live.size());
    for (const CUnit* u : live) {
        // A dead unit is mid-teardown (its Killed script may still be running):
        // it is not state, and recreating it on restore would resurrect a
        // corpse that the sim is in the middle of deleting.
        if (u->isDead || u->unitDef == nullptr)
            continue;

        UnitState s;
        s.id = u->id;
        s.unitDefName = u->unitDef->name;
        s.team = u->team;
        s.buildFacing = u->buildFacing;
        s.beingBuilt = u->beingBuilt;

        s.posX = u->pos.x; s.posY = u->pos.y; s.posZ = u->pos.z;
        s.speedX = u->speed.x; s.speedY = u->speed.y; s.speedZ = u->speed.z;
        s.heading = u->heading;
        s.frontX = u->frontdir.x; s.frontY = u->frontdir.y; s.frontZ = u->frontdir.z;
        s.rightX = u->rightdir.x; s.rightY = u->rightdir.y; s.rightZ = u->rightdir.z;
        s.upX = u->updir.x; s.upY = u->updir.y; s.upZ = u->updir.z;
        s.physicalState = static_cast<uint32_t>(u->physicalState);
        s.collidableState = static_cast<uint32_t>(u->collidableState);

        s.health = u->health; s.maxHealth = u->maxHealth;
        s.paralyzeDamage = u->paralyzeDamage;
        s.captureProgress = u->captureProgress;
        s.buildProgress = u->buildProgress;
        s.experience = u->experience;
        s.recentDamage = u->recentDamage;
        s.power = u->power; s.mass = u->mass; s.buildTime = u->buildTime;
        s.terraformLeft = u->terraformLeft;
        s.repairAmount = u->repairAmount;
        s.metalExtract = u->metalExtract;
        const auto pack = [](const SResourcePack& p) {
            ResPair r; r.metal = p.metal; r.energy = p.energy; return r;
        };
        s.cost = pack(u->cost);
        s.harvested = pack(u->harvested);
        s.harvestStorage = pack(u->harvestStorage);
        s.storage = pack(u->storage);

        s.fireState = u->fireState; s.moveState = u->moveState;
        s.armoredState = u->armoredState;
        s.armoredMultiple = u->armoredMultiple;
        s.curArmorMultiple = u->curArmorMultiple;
        s.armorType = u->armorType;
        s.category = u->category;
        s.maxRange = u->maxRange; s.reloadSpeed = u->reloadSpeed;
        s.flankingBonusMode = u->flankingBonusMode;
        s.flankingDirX = u->flankingBonusDir.x;
        s.flankingDirY = u->flankingBonusDir.y;
        s.flankingDirZ = u->flankingBonusDir.z;
        s.flankingBonusMobility = u->flankingBonusMobility;
        s.flankingBonusMobilityAdd = u->flankingBonusMobilityAdd;
        s.flankingBonusAvgDamage = u->flankingBonusAvgDamage;
        s.flankingBonusDifDamage = u->flankingBonusDifDamage;
        s.onTempHoldFire = u->onTempHoldFire;
        s.forceUseWeapons = u->forceUseWeapons;
        s.allowUseWeapons = u->allowUseWeapons;
        s.inBuildStance = u->inBuildStance;
        s.useHighTrajectory = u->useHighTrajectory;
        s.selfDCountdown = u->selfDCountdown;
        s.delayedWreckLevel = u->delayedWreckLevel;
        s.featureDefID = u->featureDefID;
        s.lastAttackFrame = u->lastAttackFrame;
        s.lastFireWeapon = u->lastFireWeapon;
        s.lastNanoAdd = u->lastNanoAdd;
        s.restTime = u->restTime;

        s.losRadius = u->losRadius; s.airLosRadius = u->airLosRadius;
        s.realLosRadius = u->realLosRadius; s.realAirLosRadius = u->realAirLosRadius;
        s.radarRadius = u->radarRadius; s.sonarRadius = u->sonarRadius;
        s.jammerRadius = u->jammerRadius; s.sonarJamRadius = u->sonarJamRadius;
        s.seismicRadius = u->seismicRadius;
        s.seismicSignature = u->seismicSignature;
        s.decloakDistance = u->decloakDistance;
        s.stealth = u->stealth; s.sonarStealth = u->sonarStealth;
        s.isCloaked = u->isCloaked; s.wantCloak = u->wantCloak;
        s.alwaysVisible = u->alwaysVisible; s.useAirLos = u->useAirLos;
        s.posErrX = u->posErrorVector.x;
        s.posErrY = u->posErrorVector.y;
        s.posErrZ = u->posErrorVector.z;
        s.posErrDeltaX = u->posErrorDelta.x;
        s.posErrDeltaY = u->posErrorDelta.y;
        s.posErrDeltaZ = u->posErrorDelta.z;
        s.nextPosErrorUpdate = u->nextPosErrorUpdate;

        s.activated = u->activated;
        s.neutral = u->neutral;
        s.upright = u->upright;
        s.groundLevelled = u->groundLevelled;
        s.stunned = u->IsStunned();
        s.invulnerable = u->invulnerable;
        s.noSelect = u->noSelect;

        s.transporterId = (u->GetTransporter() != nullptr) ? u->GetTransporter()->id : -1;
        s.loadingTransportId = u->loadingTransportId;
        s.unloadingTransportId = u->unloadingTransportId;
        s.transportCapacityUsed = u->transportCapacityUsed;
        s.transportMassUsed = u->transportMassUsed;
        for (const CUnit::TransportedUnit& tu : u->transportedUnits) {
            if (tu.unit == nullptr) continue;
            s.transportees.emplace_back(tu.unit->id, tu.piece);
        }

        if (u->commandAI != nullptr) {
            const CCommandAI* cai = u->commandAI;
            s.commands.reserve(cai->commandQue.size());
            for (const Command& c : cai->commandQue) {
                CommandState cs;
                cs.cmdID = c.GetID(false);
                cs.aiCallbackID = c.GetID(true);
                cs.timeOut = c.GetTimeOut();
                cs.tag = c.GetTag();
                cs.options = c.GetOpts();
                cs.params.assign(c.GetParams(), c.GetParams() + c.GetNumParams());
                s.commands.push_back(std::move(cs));
            }
            s.tagCounter = cai->commandQue.GetTagCounter();
            s.repeatOrders = cai->repeatOrders;
            s.lastUserCommand = cai->lastUserCommand;
            s.lastFinishCommand = cai->lastFinishCommand;
        }

        s.weapons.reserve(u->weapons.size());
        for (const CWeapon* w : u->weapons) {
            WeaponState ws;
            if (w != nullptr) {
                ws.reloadStatus = w->reloadStatus;
                ws.salvoLeft = w->salvoLeft;
                ws.nextSalvo = w->nextSalvo;
                ws.numStockpiled = w->numStockpiled;
                ws.numStockpileQued = w->numStockpileQued;
            }
            s.weapons.push_back(ws);
        }
        s.modParams = CaptureRulesParams(u->modParams);

        out.push_back(std::move(s));
    }
}

bool ResolveUnitDefs(const std::vector<UnitState>& in,
                     std::vector<int32_t>& defIds, std::string& err)
{
    defIds.clear();
    defIds.reserve(in.size());

    std::vector<int32_t> seen;
    seen.reserve(in.size());

    for (const auto& s : in) {
        const UnitDef* ud = unitDefHandler->GetUnitDefByName(s.unitDefName);
        if (ud == nullptr) {
            // §7.1c: a def carried by name so that a missing one is loud. This
            // is the check that has to happen BEFORE the live roster is torn
            // down - there is no way back from a half-rebuilt world.
            err = "snapshot unit " + std::to_string(s.id) + " has unitDef '" +
                  s.unitDefName + "', which this game does not define";
            return false;
        }
        if (!teamHandler.IsValidTeam(s.team)) {
            err = "snapshot unit " + std::to_string(s.id) + " belongs to team " +
                  std::to_string(s.team) + ", which this game does not have";
            return false;
        }
        if (s.id < 0 || unsigned(s.id) >= unitHandler.MaxUnits()) {
            err = "snapshot unit id " + std::to_string(s.id) +
                  " is outside this game's unit-id space (max " +
                  std::to_string(unitHandler.MaxUnits()) + ")";
            return false;
        }
        if (std::find(seen.begin(), seen.end(), s.id) != seen.end()) {
            err = "snapshot has two units with id " + std::to_string(s.id);
            return false;
        }
        seen.push_back(s.id);
        defIds.push_back(ud->id);
    }
    return true;
}

namespace {

/// Everything about a restored unit that is not needed to create it.
void ApplyUnitState(CUnit* u, const UnitState& s)
{
    // ForcedMove rather than a raw pos write: it re-registers the unit with the
    // quad field and the ground-blocking map, which a bare assignment leaves
    // pointing at the spawn position.
    u->ForcedMove(float3(s.posX, s.posY, s.posZ));
    u->SetVelocityAndSpeed(float3(s.speedX, s.speedY, s.speedZ));
    u->heading = static_cast<short>(s.heading);
    u->buildFacing = static_cast<short>(s.buildFacing);
    u->frontdir = float3(s.frontX, s.frontY, s.frontZ);
    u->rightdir = float3(s.rightX, s.rightY, s.rightZ);
    u->updir    = float3(s.upX, s.upY, s.upZ);
    u->physicalState = static_cast<CSolidObject::PhysicalState>(s.physicalState);
    u->collidableState = static_cast<CSolidObject::CollidableState>(s.collidableState);

    u->maxHealth = s.maxHealth;
    u->health = s.health;
    u->paralyzeDamage = s.paralyzeDamage;
    u->captureProgress = s.captureProgress;
    u->buildProgress = s.buildProgress;
    u->experience = s.experience;
    // limExperience is a pure function of experience (rebuilt, not captured);
    // AddExperience(0) is the engine's own way of recomputing it.
    u->AddExperience(0.0f);
    u->recentDamage = s.recentDamage;
    u->power = s.power;
    u->SetMass(s.mass);
    u->buildTime = s.buildTime;
    u->terraformLeft = s.terraformLeft;
    u->repairAmount = s.repairAmount;
    u->metalExtract = s.metalExtract;
    u->cost = SResourcePack(s.cost.metal, s.cost.energy);
    u->harvested = SResourcePack(s.harvested.metal, s.harvested.energy);
    u->harvestStorage = SResourcePack(s.harvestStorage.metal, s.harvestStorage.energy);
    u->SetStorage(SResourcePack(s.storage.metal, s.storage.energy));

    u->fireState = s.fireState;
    u->moveState = s.moveState;
    u->armoredState = s.armoredState;
    u->armoredMultiple = s.armoredMultiple;
    u->curArmorMultiple = s.curArmorMultiple;
    u->armorType = s.armorType;
    u->category = s.category;
    u->maxRange = s.maxRange;
    u->reloadSpeed = s.reloadSpeed;
    u->flankingBonusMode = s.flankingBonusMode;
    u->flankingBonusDir = float3(s.flankingDirX, s.flankingDirY, s.flankingDirZ);
    u->flankingBonusMobility = s.flankingBonusMobility;
    u->flankingBonusMobilityAdd = s.flankingBonusMobilityAdd;
    u->flankingBonusAvgDamage = s.flankingBonusAvgDamage;
    u->flankingBonusDifDamage = s.flankingBonusDifDamage;
    u->onTempHoldFire = s.onTempHoldFire;
    u->forceUseWeapons = s.forceUseWeapons;
    u->allowUseWeapons = s.allowUseWeapons;
    u->inBuildStance = s.inBuildStance;
    u->useHighTrajectory = s.useHighTrajectory;
    u->selfDCountdown = s.selfDCountdown;
    u->delayedWreckLevel = s.delayedWreckLevel;
    u->featureDefID = s.featureDefID;
    u->lastAttackFrame = s.lastAttackFrame;
    u->lastFireWeapon = s.lastFireWeapon;
    u->lastNanoAdd = s.lastNanoAdd;
    u->restTime = s.restTime;

    u->realLosRadius = s.realLosRadius;
    u->realAirLosRadius = s.realAirLosRadius;
    // ChangeLos rather than two assignments: it tells the LOS handler the
    // radius moved, which is what makes the rebuilt LOS map match the payload.
    u->ChangeLos(s.losRadius, s.airLosRadius);
    u->radarRadius = s.radarRadius;
    u->sonarRadius = s.sonarRadius;
    u->jammerRadius = s.jammerRadius;
    u->sonarJamRadius = s.sonarJamRadius;
    u->seismicRadius = s.seismicRadius;
    u->seismicSignature = s.seismicSignature;
    u->decloakDistance = s.decloakDistance;
    u->stealth = s.stealth;
    u->sonarStealth = s.sonarStealth;
    u->isCloaked = s.isCloaked;
    u->wantCloak = s.wantCloak;
    u->alwaysVisible = s.alwaysVisible;
    u->useAirLos = s.useAirLos;
    u->posErrorVector = float3(s.posErrX, s.posErrY, s.posErrZ);
    u->posErrorDelta = float3(s.posErrDeltaX, s.posErrDeltaY, s.posErrDeltaZ);
    u->nextPosErrorUpdate = s.nextPosErrorUpdate;

    u->activated = s.activated;
    u->SetNeutral(s.neutral);
    u->upright = s.upright;
    u->groundLevelled = s.groundLevelled;
    u->SetStunned(s.stunned);
    u->invulnerable = s.invulnerable;
    u->noSelect = s.noSelect;

    u->loadingTransportId = s.loadingTransportId;
    u->unloadingTransportId = s.unloadingTransportId;
    u->transportCapacityUsed = s.transportCapacityUsed;
    u->transportMassUsed = s.transportMassUsed;

    if (u->commandAI != nullptr) {
        CCommandAI* cai = u->commandAI;
        cai->RestoreCommandQueue([&]() {
            std::vector<Command> cmds;
            cmds.reserve(s.commands.size());
            for (const auto& cs : s.commands) {
                Command c(cs.cmdID);
                c.SetAICmdID(cs.aiCallbackID);
                for (const float p : cs.params) c.PushParam(p);
                c.SetTimeOut(cs.timeOut);
                c.SetTag(cs.tag);
                c.SetOpts(cs.options);
                cmds.push_back(c);
            }
            return cmds;
        }(), s.tagCounter);
        cai->repeatOrders = s.repeatOrders;
        cai->lastUserCommand = s.lastUserCommand;
        cai->lastFinishCommand = s.lastFinishCommand;
        cai->selfDCountdown = s.selfDCountdown;
    }

    // The def decides how many weapons a unit has, so a count mismatch means
    // the defs moved under the snapshot (§2.1: there is no defsHash yet).
    // Apply what lines up and say so rather than dropping the stockpile
    // silently.
    if (s.weapons.size() != u->weapons.size()) {
        static bool warned = false;
        if (!warned) {
            warned = true;
            SLOG(SPRING_LOG_WARNING,
                 "snapshot restore: unit %d ('%s') has %zu weapons, the snapshot "
                 "recorded %zu - per-weapon state applied for the first %zu only",
                 u->id, s.unitDefName.c_str(), u->weapons.size(), s.weapons.size(),
                 std::min(u->weapons.size(), s.weapons.size()));
        }
    }
    for (size_t i = 0; i < std::min(u->weapons.size(), s.weapons.size()); ++i) {
        CWeapon* w = u->weapons[i];
        if (w == nullptr) continue;
        w->reloadStatus = s.weapons[i].reloadStatus;
        w->salvoLeft = s.weapons[i].salvoLeft;
        w->nextSalvo = s.weapons[i].nextSalvo;
        w->numStockpiled = s.weapons[i].numStockpiled;
        w->numStockpileQued = s.weapons[i].numStockpileQued;
    }

    ApplyRulesParams(s.modParams, u->modParams);
}

} // namespace

void ApplyUnits(const std::vector<UnitState>& in, const std::vector<int32_t>& defIds)
{
    // ── 1. tear the live roster down ──
    //
    // reclaimed = true (what CUnitHandler::QueueDeleteUnit itself passes), so
    // no wreck, no explosion and no death CEG: a restore is not a massacre.
    // GarbageCollectUnit is synchronous and recycles the id immediately, which
    // is required - the payload's units claim those same ids.
    std::vector<int> liveIds;
    liveIds.reserve(unitHandler.GetActiveUnits().size());
    for (const CUnit* u : unitHandler.GetActiveUnits())
        liveIds.push_back(u->id);

    for (const int id : liveIds) {
        CUnit* u = unitHandler.GetUnit(id);
        if (u == nullptr) continue;
        // QueueDeleteUnit refuses a unit whose death script has not finished;
        // there is no script to wait for when the world is being replaced.
        u->deathScriptFinished = true;
        unitHandler.GarbageCollectUnit(id);
    }

    // ── 2. rebuild ──
    for (size_t i = 0; i < in.size(); ++i) {
        const UnitState& s = in[i];
        UnitLoadParams params;
        params.unitDef = unitDefHandler->GetUnitDefByID(defIds[i]);
        params.builder = nullptr;
        params.pos = float3(s.posX, s.posY, s.posZ);
        params.speed = float3(s.speedX, s.speedY, s.speedZ);
        params.unitID = s.id;
        params.teamID = s.team;
        params.facing = s.buildFacing;
        params.beingBuilt = s.beingBuilt;
        // The ground under this unit was terraformed when it was first placed;
        // re-flattening on restore would re-cut a hole that the heightmap
        // already carries.
        params.flattenGround = false;

        CUnit* u = unitLoader->LoadUnit(params);
        if (u == nullptr) {
            // Every fallible condition was checked in ResolveUnitDefs, so this
            // is a bug rather than a data problem - but it must not be silent.
            SLOG(SPRING_LOG_ERROR,
                 "snapshot restore: could not create unit %d ('%s') for team %d",
                 s.id, s.unitDefName.c_str(), s.team);
            continue;
        }
        ApplyUnitState(u, s);
    }

    // ── 3. the transport graph, once every unit exists ──
    for (const auto& s : in) {
        if (s.transportees.empty()) continue;
        CUnit* transport = unitHandler.GetUnit(s.id);
        if (transport == nullptr) continue;
        for (const auto& [teeId, piece] : s.transportees) {
            CUnit* tee = unitHandler.GetUnit(teeId);
            if (tee == nullptr) continue;
            // force: the capacity/mass checks already passed when this unit was
            // loaded during the match, and a restored transport must not shed
            // its cargo because a check rounds differently.
            transport->AttachUnit(tee, piece, true);
        }
    }
}

// ───────────────────────── The serializer ─────────────────────────

uint64_t SimSnapshotSerializer::LayoutHash() const
{
    // FNV-1a over the envelope version plus (id, version) of every IMPLEMENTED
    // section. Unimplemented sections are excluded deliberately: they emit no
    // bytes, so including them would move the hash - and refuse every existing
    // snapshot - on the day a gap is filled in a way that changes nothing
    // about the sections that were already there.
    uint64_t h = 1469598103934665603ull;
    const auto fold = [&h](uint64_t v) {
        for (int i = 0; i < 8; ++i) {
            h ^= uint64_t(uint8_t(v >> (8 * i)));
            h *= 1099511628211ull;
        }
    };
    fold(kPayloadVersion);
    for (const auto& s : Sections()) {
        if (!s.implemented) continue;
        fold(static_cast<uint64_t>(s.id));
        fold(s.version);
    }
    return h;
}

int32_t SimSnapshotSerializer::Frame() const
{
    return (gs != nullptr) ? gs->frameNum : -1;
}

bool SimSnapshotSerializer::Serialize(std::vector<uint8_t>& out, std::string& err)
{
    const std::vector<std::string> missing = MissingSections();
    if (!missing.empty()) {
        // Refuse by name. A payload that silently omits declared state is the
        // exact failure mode option B was warned about; the store's honest
        // refusal is better than a snapshot that restores a partial world.
        err = "snapshot serializer incomplete - unimplemented sections: ";
        for (size_t i = 0; i < missing.size(); ++i)
            err += (i ? ", " : "") + missing[i];
        return false;
    }
    return SerializeImplemented(out, err);
}

bool SimSnapshotSerializer::SerializeImplemented(std::vector<uint8_t>& out, std::string& err)
{
    if (gs == nullptr) {
        err = "no sim: gs is null";
        return false;
    }

    Writer w(out);
    uint32_t written = 0;
    std::vector<uint8_t> section;

    for (const auto& s : Sections()) {
        if (!s.implemented) continue;

        section.clear();
        Writer sw(section);
        switch (s.id) {
            case SectionId::Globals:        WriteGlobals(sw);        break;
            case SectionId::StandingOrders: WriteStandingOrders(sw); break;
            case SectionId::OrgGroups:      WriteOrgGroups(sw);      break;
            case SectionId::Directives:     WriteDirectives(sw);     break;
            case SectionId::Teams: {
                std::vector<TeamState> teams;
                CaptureTeams(teams);
                EncodeTeams(teams, section);
            } break;
            case SectionId::Units: {
                std::vector<UnitState> units;
                CaptureUnits(units);
                EncodeUnits(units, section);
            } break;
            default:
                // An implemented section with no writer is a programming
                // error, not a runtime condition - fail the checkpoint rather
                // than emit a hole.
                err = std::string("no writer for implemented section '") + s.name + "'";
                return false;
        }

        w.U16(static_cast<uint16_t>(s.id));
        w.U16(s.version);
        w.U32(static_cast<uint32_t>(section.size()));
        out.insert(out.end(), section.begin(), section.end());
        ++written;
    }

    // Envelope header goes at the FRONT, so it is built last and prepended:
    // the section count is not known until the walk finishes.
    std::vector<uint8_t> head;
    Writer hw(head);
    hw.U16(kPayloadVersion);
    hw.U32(written);
    out.insert(out.begin(), head.begin(), head.end());
    return true;
}

bool SimSnapshotSerializer::Deserialize(const uint8_t* data, size_t size, std::string& err)
{
    if (gs == nullptr) {
        err = "no sim: gs is null";
        return false;
    }

    Reader r(data, size);
    const uint16_t version = r.U16();
    if (version != kPayloadVersion) {
        err = "payload version " + std::to_string(version) + ", expected " +
              std::to_string(kPayloadVersion);
        return false;
    }
    const uint32_t sectionCount = r.U32();

    // STAGING. §2's "mismatches refuse loudly, never half-load" is a hard
    // requirement of ISimSerializer::Deserialize, so nothing below touches
    // live state: every section decodes into a local, and the swap only
    // happens once the whole payload has been read without a single failure.
    bool haveGlobals = false, haveOrders = false, haveGroups = false, haveDirs = false;
    bool haveTeams = false, haveUnits = false;
    std::vector<TeamState> teams;
    std::vector<UnitState> units;
    std::vector<int32_t>   unitDefIds;
    GlobalsState globals;
    std::vector<StandingOrder> orders;
    uint32_t ordersNextId = 1;
    std::vector<OrgGroup> groups;
    uint32_t groupsNextId = 1;
    std::vector<Directive> dirs;
    uint32_t dirsNextId = 1;

    for (uint32_t i = 0; i < sectionCount; ++i) {
        const uint16_t id = r.U16();
        const uint16_t sver = r.U16();
        const uint32_t len = r.U32();
        if (r.Bad()) {
            err = "truncated section header at index " + std::to_string(i);
            return false;
        }
        if (len > r.Remaining()) {
            err = "section " + std::to_string(id) + " claims " + std::to_string(len) +
                  " bytes, only " + std::to_string(r.Remaining()) + " remain";
            return false;
        }

        const SectionSpec* spec = SpecFor(id);
        if (spec == nullptr) {
            // Not "skip the ones we don't know": a snapshot is same-binary by
            // construction (E1 refuses foreign engineHash before we get here),
            // so an unknown section means the payload is not what it claims.
            err = "unknown section id " + std::to_string(id);
            return false;
        }
        if (sver != spec->version) {
            err = std::string("section '") + spec->name + "' version " +
                  std::to_string(sver) + ", expected " + std::to_string(spec->version);
            return false;
        }

        Reader sr(data + r.Pos(), len);
        switch (spec->id) {
            case SectionId::Globals:
                globals = ReadGlobals(sr);
                haveGlobals = true;
                break;
            case SectionId::StandingOrders:
                orders = ReadStandingOrders(sr, ordersNextId);
                haveOrders = true;
                break;
            case SectionId::OrgGroups:
                groups = ReadOrgGroups(sr, groupsNextId);
                haveGroups = true;
                break;
            case SectionId::Directives:
                dirs = ReadDirectives(sr, dirsNextId);
                haveDirs = true;
                break;
            case SectionId::Teams:
                // These two decode through the public codec (the same entry
                // point the round-trip tests use) rather than a private reader,
                // so what the tests cover and what a restore runs are the same
                // code path. They report their own truncation, so the section
                // reader is consumed whole and the generic checks below see an
                // empty remainder.
                if (!DecodeTeams(data + r.Pos(), len, teams, err))
                    return false;
                sr.Skip(len);
                haveTeams = true;
                break;
            case SectionId::Units:
                if (!DecodeUnits(data + r.Pos(), len, units, err))
                    return false;
                sr.Skip(len);
                haveUnits = true;
                break;
            default:
                err = std::string("no reader for section '") + spec->name + "'";
                return false;
        }
        if (sr.Bad()) {
            err = std::string("section '") + spec->name + "' is truncated";
            return false;
        }
        // Trailing bytes inside a section mean the writer and reader disagree
        // about the shape while the version says they agree - the one failure
        // this framing exists to catch.
        if (sr.Remaining() != 0) {
            err = std::string("section '") + spec->name + "' has " +
                  std::to_string(sr.Remaining()) + " unread trailing bytes";
            return false;
        }
        r.Skip(len);
    }

    if (r.Bad() || r.Remaining() != 0) {
        err = "payload has " + std::to_string(r.Remaining()) + " trailing bytes";
        return false;
    }
    if (!haveGlobals || !haveOrders || !haveGroups || !haveDirs ||
        !haveTeams || !haveUnits) {
        err = "payload is missing a required section";
        return false;
    }

    // The last fallible work, and it MUST be here rather than in the commit
    // phase (§7.1c decision 2): resolving a unitDef name or validating a team
    // after the live roster has been torn down leaves a half-built world with
    // nothing to roll back to.
    if (!ResolveTeams(teams, err))
        return false;
    if (!ResolveUnitDefs(units, unitDefIds, err))
        return false;

    // ── Commit. Past this point nothing can fail. ──
    gs->frameNum = globals.frameNum;
    gs->paused   = globals.paused;
    gsRNG.SetGenState(globals.rngState, globals.rngStream);
    standingOrders.RestoreState(std::move(orders), ordersNextId);
    orgGroups.RestoreState(std::move(groups), groupsNextId);
    directiveManager.RestoreState(std::move(dirs), dirsNextId);
    // Teams before units: unit creation calls CTeam::AddUnit, which bumps the
    // team's (derived, uncaptured) unit count.
    ApplyTeams(teams);
    ApplyUnits(units, unitDefIds);
    return true;
}

// The censuses are referenced here so they are odr-used and the structured
// bindings are actually instantiated - an uninstantiated one would compile
// forever regardless of how the structs change, i.e. a tripwire that is not
// armed. tests/test_sim_snapshot.cpp pins the returned counts.
namespace census {
int Conditions(const StandingOrderConditions& c) { return CensusStandingOrderConditions(c); }
int Order(const StandingOrder& o)                { return CensusStandingOrder(o); }
int Group(const OrgGroup& g)                     { return CensusOrgGroup(g); }
int Directive_(const Directive& d)               { return CensusDirective(d); }
int Team(const TeamState& t)                     { return CensusTeamState(t); }
int Unit(const UnitState& u)                     { return CensusUnitState(u); }
int Weapon(const WeaponState& w)                 { return CensusWeaponState(w); }
int Cmd(const CommandState& c)                   { return CensusCommandState(c); }
int RulesParam(const RulesParamState& p)         { return CensusRulesParam(p); }
int Stats(const TeamStatsState& s)               { return CensusStats(s); }
int Res(const ResPair& r)                        { return CensusResPair(r); }

} // namespace census

} // namespace simsnapshot
