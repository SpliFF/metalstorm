// SimSnapshot — see SimSnapshot.h for the design and the coverage contract.

#include "Server/SimSnapshot.h"

#include "Server/OrgGroups.h"
#include "Server/StandingOrders.h"
#include "Sim/Misc/GlobalSynced.h"
#include "System/GlobalRNG.h"

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
        {SectionId::Teams,          0, "teams",          false,
         "task 1c: team resources, statistics and rulesParams (modParams)"},
        {SectionId::Units,          0, "units",          false,
         "task 1c: unitHandler roster, unit state and CommandAI queues"},
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
    if (r.Remaining() < size_t(count)) return {};
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
    if (r.Remaining() < size_t(count)) return {};
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
    if (r.Remaining() < size_t(count)) return {};
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

const SectionSpec* SpecFor(uint16_t id)
{
    for (const auto& s : Sections()) {
        if (static_cast<uint16_t>(s.id) == id) return &s;
    }
    return nullptr;
}

} // namespace

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
    if (!haveGlobals || !haveOrders || !haveGroups || !haveDirs) {
        err = "payload is missing a required section";
        return false;
    }

    // ── Commit. Past this point nothing can fail. ──
    gs->frameNum = globals.frameNum;
    gs->paused   = globals.paused;
    gsRNG.SetGenState(globals.rngState, globals.rngStream);
    standingOrders.RestoreState(std::move(orders), ordersNextId);
    orgGroups.RestoreState(std::move(groups), groupsNextId);
    directiveManager.RestoreState(std::move(dirs), dirsNextId);
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

} // namespace census

} // namespace simsnapshot
