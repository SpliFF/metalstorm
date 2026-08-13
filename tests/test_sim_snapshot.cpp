// Tests for the purpose-written sim-snapshot walk (PLAN-persistence task 1b,
// Q-P1 option B).
//
// As with test_synced_input_journal.cpp, the point of these tests is not that
// the codec round-trips structs correctly — it is that THE WALK CANNOT
// SILENTLY FALL BEHIND THE STATE IT IS WALKING. Option B's one real weakness
// (Q-P1 constraint 4) is a synced field being added and quietly never
// snapshotted, so a resume restores a world missing something nobody notices
// until a campaign is a week old. Three mechanisms guard that, and the first
// two are the reason this file exists:
//
//   1. The field census (SimSnapshot.h `census`) destructures every member of
//      every serialized struct. A new field breaks the BUILD. The tests below
//      pin the counts so the census cannot be "fixed" by adding a name to the
//      binding without also writing the field.
//   2. The section table declares the state that is NOT covered yet, so a gap
//      is a named refusal instead of a hole in the payload.
//   3. LayoutHash() is derived from the section table, so a version bump moves
//      it mechanically (constraint 3) rather than by an author remembering to.

#include <doctest/doctest.h>

#include "Server/SimSnapshot.h"
#include "Server/OrgGroups.h"
#include "Server/StandingOrders.h"
#include "Sim/Misc/GlobalSynced.h"
#include "Sim/Units/UnitHandler.h"   // the slow-update cursor (Q-P4)
#include "Sim/Misc/Wind.h"           // envResHandler (the wind section)
#include "System/GlobalRNG.h"
#include "Lua/LuaHandleSynced.h"   // CSplitLuaHandle::gameParams (task 1d-b)

#include <algorithm>
#include <set>
#include <string>

using namespace simsnapshot;

namespace {

void resetManagers()
{
    standingOrders.SetChangeNotifier(nullptr);
    orgGroups.SetChangeNotifier(nullptr);
    directiveManager.SetChangeNotifier(nullptr);
    standingOrders.Clear();
    orgGroups.Clear();
    directiveManager.Clear();
}

/// Every field of StandingOrderConditions set to a non-default value, so a
/// field that is written but never read (or vice versa) shows up as a
/// difference rather than as two matching defaults.
StandingOrderConditions loudConditions()
{
    StandingOrderConditions c;
    c.idleOnly = false;
    c.squadTypes = {7, 9, 4211};
    c.withinCenter = float3(11.0f, 22.0f, 33.0f);
    c.withinRadius = 512.5f;
    c.outsideCenter = float3(-1.0f, -2.0f, -3.0f);
    c.outsideRadius = 64.25f;
    c.minStrength = 1234.5f;
    c.hasCapabilities = {"amphib", "radar"};
    c.orgGroup = 77;
    return c;
}

bool sameConditions(const StandingOrderConditions& a, const StandingOrderConditions& b)
{
    return a.idleOnly == b.idleOnly
        && a.squadTypes == b.squadTypes
        && a.withinCenter == b.withinCenter
        && a.withinRadius == b.withinRadius
        && a.outsideCenter == b.outsideCenter
        && a.outsideRadius == b.outsideRadius
        && a.minStrength == b.minStrength
        && a.hasCapabilities == b.hasCapabilities
        && a.orgGroup == b.orgGroup;
}

/// Populate all three managers directly (bypassing Create(), which would
/// renumber ids and stamp its own frames) so the fixture can exercise values
/// the public API cannot produce — an assigned set, a non-1 nextId, a group
/// mid-directive.
void stageFixture()
{
    resetManagers();

    StandingOrder o;
    o.id = 5;
    o.team = 2;
    o.authorPlayerId = 3;
    o.type = StandingOrderType::SupplyRoute;
    o.priority = 42;
    o.params = {1.5f, -2.5f, 3.0f, 4.0f};
    o.conditions = loudConditions();
    o.active = false;
    o.createdAtFrame = 900;
    o.expiresAtFrame = 108900;
    o.assigned = {31, 17, 92};
    StandingOrder o2;
    o2.id = 6;
    o2.team = 0;
    o2.type = StandingOrderType::RallyPoint;
    o2.params = {0.0f, 0.0f, 0.0f};
    standingOrders.RestoreState({o, o2}, 7);

    OrgGroup g;
    g.id = 3;
    g.echelon = Echelon::Platoon;
    g.team = 2;
    g.parentId = 0;
    g.members = {101, 102, 103};
    g.name = "3rd Armoured";
    g.currentDirectiveId = 11;
    g.postureJson = R"({"roe":"free","casualty":0.4})";
    g.createdAtFrame = 450;
    orgGroups.RestoreState({g}, 4);

    Directive d;
    d.id = 11;
    d.team = 2;
    d.groupId = 3;
    d.authorPlayerId = 3;
    d.type = DirectiveType::Overwatch;
    d.priority = 9;
    d.shape = OrderShape::Polygon;
    d.params = {10.0f, 0.0f, 10.0f, 20.0f, 0.0f, 20.0f};
    d.conditions = loudConditions();
    d.requestedStrength = 2500;
    d.phasesJson = R"({"phase":"hold"})";
    d.active = true;
    d.createdAtFrame = 460;
    d.expiresAtFrame = 0;
    d.assigned = {101, 102};
    d.assignedStrength = 1875.5f;
    directiveManager.RestoreState({d}, 12);

    gs->frameNum = 12345;
    gs->paused = true;
    gsRNG.SetSeed(4242, true);
    // Draw a few times so the generator is somewhere non-initial: a restore
    // that only re-seeds would land back at the seed and pass a test written
    // against a freshly-seeded generator.
    for (int i = 0; i < 17; ++i) (void)gsRNG.NextInt();
}

} // namespace

TEST_SUITE("SimSnapshot") {

// ─────────────────── The completeness tripwires ───────────────────

TEST_CASE("the field census matches what the codec writes") {
    // These numbers are the contract. If the build got here, the structured
    // bindings in SimSnapshot.cpp still name every member — so a mismatch
    // here means somebody widened a binding without widening the codec.
    StandingOrderConditions c;
    StandingOrder o;
    OrgGroup g;
    Directive d;
    CHECK(census::Conditions(c) == 9);
    CHECK(census::Order(o) == 11);
    CHECK(census::Group(g) == 9);
    CHECK(census::Directive_(d) == 16);
}

TEST_CASE("every section is either implemented or declares who owns the gap") {
    // A section with neither an implementation nor a note is a hole nobody
    // is accountable for — which is exactly the state Q-P1 constraint 4 was
    // written to prevent.
    REQUIRE(!Sections().empty());
    std::set<uint16_t> ids;
    for (const auto& s : Sections()) {
        INFO("section: " << s.name);
        CHECK(s.name != nullptr);
        CHECK(std::string(s.name).size() > 0);
        // Ids are unique and never reused.
        CHECK(ids.insert(static_cast<uint16_t>(s.id)).second);
        if (s.implemented) {
            CHECK(s.version > 0);
        } else {
            CHECK(std::string(s.note).size() > 0);
        }
    }
}

TEST_CASE("the section table declares no gaps left") {
    // Pinned deliberately: *adding* a new unimplemented section without saying
    // so must fail here. task 1e (features) was the last declared gap — 1c
    // filled teams + units and DECLARED features, which the table had never
    // mentioned at all (a gap MissingSections() could not report because the
    // section did not exist), and 1d filled syncedLua.
    //
    // With this empty, the ONLY thing still keeping the serializer detached at
    // boot is one level below the table: the synced-Lua coverage ledger, i.e.
    // the nine gadgets task 1d-b has to author. That refusal lives in
    // Serialize() and in server_main's attach gate, not here.
    CHECK(MissingSections().empty());
}

TEST_CASE("state that is deliberately not captured says what rebuilds it") {
    REQUIRE(!DerivedNotCaptured().empty());
    for (const auto& d : DerivedNotCaptured()) {
        INFO("omission: " << d.what);
        CHECK(std::string(d.what).size() > 0);
        CHECK(std::string(d.rebuiltBy).size() > 0);
    }
}

// ───────────────────────── LayoutHash (E1) ─────────────────────────

TEST_CASE("LayoutHash is stable, non-trivial and folds every implemented section") {
    SimSnapshotSerializer ser;
    const uint64_t h = ser.LayoutHash();
    CHECK(h == ser.LayoutHash());   // pure
    CHECK(h != 0);
    CHECK(h != 1469598103934665603ull);   // not the unfolded FNV basis

    // Recompute independently from the table. This is the check that makes
    // constraint 3 mechanical: if a section's version is bumped and the hash
    // does NOT move, one of the two is not reading the table.
    uint64_t expect = 1469598103934665603ull;
    const auto fold = [&expect](uint64_t v) {
        for (int i = 0; i < 8; ++i) {
            expect ^= uint64_t(uint8_t(v >> (8 * i)));
            expect *= 1099511628211ull;
        }
    };
    fold(kPayloadVersion);
    int implemented = 0;
    for (const auto& s : Sections()) {
        if (!s.implemented) continue;
        fold(static_cast<uint64_t>(s.id));
        fold(s.version);
        ++implemented;
    }
    // + gameRules (task 1d-b), + envResources (the wind),
    // + defNames (PLAN-def-reconciliation task 1),
    // + defScalars (PLAN-def-reconciliation task 3)
    CHECK(implemented == 12);
    CHECK(h == expect);
}

// ────────────────────── Refusal while incomplete ──────────────────────

TEST_CASE("Serialize's completeness gate passes and the payload carries every section") {
    // The honest-refusal property, from the other side now that the table is
    // complete (task 1e): Serialize() must emit EVERY section the table
    // declares, in table order. This is the test that would catch a section
    // marked implemented with no writer behind it — SerializeImplemented's
    // default branch refuses, and the count below would be short.
    //
    // In-process there is no gadget handler, so the second gate (synced-Lua
    // coverage) has nothing to report and Serialize() runs the full walk. On a
    // real game that gate is what still refuses; it needs a live handler and is
    // exercised at boot (server_main), not here.
    stageFixture();
    REQUIRE(MissingSections().empty());

    SimSnapshotSerializer ser;
    std::vector<uint8_t> out;
    std::string err;
    REQUIRE_MESSAGE(ser.Serialize(out, err), err);

    // Walk the envelope and collect the section ids actually written.
    REQUIRE(out.size() > 6);
    const auto u16 = [&out](size_t at) {
        return uint16_t(out[at]) | uint16_t(uint16_t(out[at + 1]) << 8);
    };
    const auto u32 = [&out](size_t at) {
        uint32_t v = 0;
        for (int i = 0; i < 4; ++i) v |= uint32_t(out[at + i]) << (8 * i);
        return v;
    };
    CHECK(u16(0) == kPayloadVersion);
    const uint32_t count = u32(2);

    std::vector<uint16_t> written;
    size_t at = 6;
    for (uint32_t i = 0; i < count; ++i) {
        REQUIRE(at + 8 <= out.size());
        written.push_back(u16(at));
        const uint32_t len = u32(at + 4);
        at += 8 + len;
    }
    CHECK(at == out.size());

    std::vector<uint16_t> expect;
    for (const auto& s : Sections()) {
        if (s.implemented) expect.push_back(static_cast<uint16_t>(s.id));
    }
    CHECK(written == expect);
    CHECK(count == expect.size());
}

TEST_CASE("Frame reports the sim frame the next capture would take") {
    SimSnapshotSerializer ser;
    gs->frameNum = 777;
    CHECK(ser.Frame() == 777);
}

// ───────────────── Round-trip of the implemented sections ─────────────────
//
// Serialize() refuses while the walk is incomplete, so the sections that ARE
// implemented are exercised through the same code path with the gate lifted:
// SerializeImplemented() is the body Serialize() runs after its check. Without
// this the four landed sections would have no round-trip coverage at all until
// task 1d, which is a milestone shipping untested code.

TEST_CASE("the implemented sections round-trip every field") {
    stageFixture();
    const uint64_t rngBefore = gsRNG.GetGenState();
    const uint64_t rngStreamBefore = gsRNG.GetGenStream();

    SimSnapshotSerializer ser;
    std::vector<uint8_t> payload;
    std::string err;
    REQUIRE_MESSAGE(ser.SerializeImplemented(payload, err), err);
    CHECK(payload.size() > 6);

    // Wipe everything the way a fresh process would have it.
    resetManagers();
    gs->frameNum = -1;
    gs->paused = false;
    gsRNG.SetSeed(1, true);
    REQUIRE(gsRNG.GetGenState() != rngBefore);

    REQUIRE_MESSAGE(ser.Deserialize(payload.data(), payload.size(), err), err);

    CHECK(gs->frameNum == 12345);
    CHECK(gs->paused == true);
    CHECK(gsRNG.GetGenState() == rngBefore);
    CHECK(gsRNG.GetGenStream() == rngStreamBefore);

    // Standing orders
    const auto& orders = standingOrders.GetAllOrders();
    REQUIRE(orders.size() == 2);
    CHECK(standingOrders.NextId() == 7);
    const StandingOrder& o = orders[0];
    CHECK(o.id == 5);
    CHECK(o.team == 2);
    CHECK(o.authorPlayerId == 3);
    CHECK(o.type == StandingOrderType::SupplyRoute);
    CHECK(o.priority == 42);
    CHECK(o.params == std::vector<float>{1.5f, -2.5f, 3.0f, 4.0f});
    CHECK(sameConditions(o.conditions, loudConditions()));
    CHECK(o.active == false);
    CHECK(o.createdAtFrame == 900);
    CHECK(o.expiresAtFrame == 108900);
    CHECK(o.assigned == std::unordered_set<uint32_t>{31, 17, 92});
    CHECK(orders[1].id == 6);
    CHECK(orders[1].type == StandingOrderType::RallyPoint);

    // Org groups
    const auto& groups = orgGroups.GetAllGroups();
    REQUIRE(groups.size() == 1);
    CHECK(orgGroups.NextId() == 4);
    const OrgGroup& g = groups[0];
    CHECK(g.id == 3);
    CHECK(g.echelon == Echelon::Platoon);
    CHECK(g.team == 2);
    CHECK(g.parentId == 0);
    CHECK(g.members == std::vector<uint32_t>{101, 102, 103});
    CHECK(g.name == "3rd Armoured");
    CHECK(g.currentDirectiveId == 11);
    CHECK(g.postureJson == R"({"roe":"free","casualty":0.4})");
    CHECK(g.createdAtFrame == 450);

    // Directives
    const auto& dirs = directiveManager.GetAllDirectives();
    REQUIRE(dirs.size() == 1);
    CHECK(directiveManager.NextId() == 12);
    const Directive& d = dirs[0];
    CHECK(d.id == 11);
    CHECK(d.team == 2);
    CHECK(d.groupId == 3);
    CHECK(d.authorPlayerId == 3);
    CHECK(d.type == DirectiveType::Overwatch);
    CHECK(d.priority == 9);
    CHECK(d.shape == OrderShape::Polygon);
    CHECK(d.params.size() == 6);
    CHECK(d.params[4] == 0.0f);
    CHECK(d.params[5] == 20.0f);
    CHECK(sameConditions(d.conditions, loudConditions()));
    CHECK(d.requestedStrength == 2500);
    CHECK(d.phasesJson == R"({"phase":"hold"})");
    CHECK(d.active == true);
    CHECK(d.createdAtFrame == 460);
    CHECK(d.expiresAtFrame == 0);
    CHECK(d.assigned == std::unordered_set<uint32_t>{101, 102});
    CHECK(d.assignedStrength == 1875.5f);

    resetManagers();
}

TEST_CASE("an assigned set serialises in a reproducible order") {
    // The set is unordered; two snapshots of identical state must still be
    // byte-identical, or a "did anything change" comparison is noise.
    stageFixture();
    SimSnapshotSerializer ser;
    std::vector<uint8_t> a, b;
    std::string err;
    REQUIRE(ser.SerializeImplemented(a, err));
    // Rebuild the same assigned set in a different insertion order.
    StandingOrder o = standingOrders.GetAllOrders()[0];
    StandingOrder o2 = standingOrders.GetAllOrders()[1];
    o.assigned.clear();
    for (const uint32_t id : {92u, 31u, 17u}) o.assigned.insert(id);
    standingOrders.RestoreState({o, o2}, 7);
    REQUIRE(ser.SerializeImplemented(b, err));
    CHECK(a == b);
    resetManagers();
}

// ──────────────── Refusing rather than half-loading (§2) ────────────────

TEST_CASE("a truncated payload is refused and leaves the sim untouched") {
    stageFixture();
    SimSnapshotSerializer ser;
    std::vector<uint8_t> payload;
    std::string err;
    REQUIRE(ser.SerializeImplemented(payload, err));

    // A fresh, recognisably different world.
    resetManagers();
    gs->frameNum = 4;
    gs->paused = false;
    StandingOrder keep;
    keep.id = 99;
    keep.team = 1;
    standingOrders.RestoreState({keep}, 100);

    for (const size_t cut : {size_t(1), size_t(5), payload.size() / 2, payload.size() - 1}) {
        INFO("truncated to " << cut << " of " << payload.size());
        std::string e;
        CHECK_FALSE(ser.Deserialize(payload.data(), cut, e));
        CHECK(e.size() > 0);
        // Nothing was applied: still the fresh world, not a half-loaded one.
        CHECK(gs->frameNum == 4);
        CHECK(gs->paused == false);
        REQUIRE(standingOrders.GetAllOrders().size() == 1);
        CHECK(standingOrders.GetAllOrders()[0].id == 99);
        CHECK(standingOrders.NextId() == 100);
        CHECK(orgGroups.GetAllGroups().empty());
        CHECK(directiveManager.GetAllDirectives().empty());
    }
    resetManagers();
}

TEST_CASE("a wrong payload version is refused, never reinterpreted") {
    stageFixture();
    SimSnapshotSerializer ser;
    std::vector<uint8_t> payload;
    std::string err;
    REQUIRE(ser.SerializeImplemented(payload, err));
    resetManagers();
    gs->frameNum = 4;

    payload[0] = static_cast<uint8_t>(kPayloadVersion + 1);
    std::string e;
    CHECK_FALSE(ser.Deserialize(payload.data(), payload.size(), e));
    CHECK(e.find("version") != std::string::npos);
    CHECK(gs->frameNum == 4);
    resetManagers();
}

TEST_CASE("an unknown section id is refused rather than skipped") {
    // Skipping would be the tempting forward-compatible choice and is wrong
    // here: E1 already refuses foreign engine/layout hashes before a payload
    // reaches this code, so an unknown section means the bytes are not what
    // the header says they are.
    stageFixture();
    SimSnapshotSerializer ser;
    std::vector<uint8_t> payload;
    std::string err;
    REQUIRE(ser.SerializeImplemented(payload, err));
    resetManagers();
    gs->frameNum = 4;

    // First section header starts at byte 6 (u16 version + u32 count).
    payload[6] = 0xFE;
    payload[7] = 0xFF;
    std::string e;
    CHECK_FALSE(ser.Deserialize(payload.data(), payload.size(), e));
    CHECK(e.find("unknown section") != std::string::npos);
    CHECK(gs->frameNum == 4);
    resetManagers();
}

TEST_CASE("a section version the codec does not speak is refused") {
    stageFixture();
    SimSnapshotSerializer ser;
    std::vector<uint8_t> payload;
    std::string err;
    REQUIRE(ser.SerializeImplemented(payload, err));
    resetManagers();
    gs->frameNum = 4;

    payload[8] = 0x7F;   // first section's version word
    std::string e;
    CHECK_FALSE(ser.Deserialize(payload.data(), payload.size(), e));
    CHECK(e.find("version") != std::string::npos);
    CHECK(gs->frameNum == 4);
    resetManagers();
}

TEST_CASE("trailing bytes after the last section are refused") {
    stageFixture();
    SimSnapshotSerializer ser;
    std::vector<uint8_t> payload;
    std::string err;
    REQUIRE(ser.SerializeImplemented(payload, err));
    resetManagers();
    gs->frameNum = 4;

    payload.push_back(0xAB);
    std::string e;
    CHECK_FALSE(ser.Deserialize(payload.data(), payload.size(), e));
    CHECK(e.find("trailing") != std::string::npos);
    CHECK(gs->frameNum == 4);
    resetManagers();
}

// ───────────────────────── The RNG setter ─────────────────────────

TEST_CASE("SetGenState puts the synced RNG back on the same track") {
    // The gap this closes: GetGenState() was write-only, so a resumed sim
    // could only be re-seeded and its first draw diverged from the snapshot's
    // own track — which statsdump::ComputeStateHash folds into the desync hash.
    gsRNG.SetSeed(31337, true);
    for (int i = 0; i < 5; ++i) (void)gsRNG.NextInt();
    const uint64_t state = gsRNG.GetGenState();
    const uint64_t stream = gsRNG.GetGenStream();

    std::vector<uint32_t> expected;
    for (int i = 0; i < 10; ++i) expected.push_back(gsRNG.NextInt());

    // Somewhere else entirely.
    gsRNG.SetSeed(1, true);
    for (int i = 0; i < 100; ++i) (void)gsRNG.NextInt();
    CHECK(gsRNG.GetGenState() != state);

    gsRNG.SetGenState(state, stream);
    CHECK(gsRNG.GetGenState() == state);
    std::vector<uint32_t> replayed;
    for (int i = 0; i < 10; ++i) replayed.push_back(gsRNG.NextInt());
    CHECK(replayed == expected);
}

TEST_CASE("restoring the stream matters, not just the position") {
    // Neutralisation check: restoring `val` alone is the obvious half-fix, and
    // it produces a different draw sequence. If this ever passes with the
    // stream left alone, the stream is not load-bearing and the snapshot can
    // drop a word — but it is, so it must not.
    gsRNG.SetSeed(555, true);
    const uint64_t state = gsRNG.GetGenState();
    const uint64_t stream = gsRNG.GetGenStream();
    std::vector<uint32_t> expected;
    for (int i = 0; i < 6; ++i) expected.push_back(gsRNG.NextInt());

    gsRNG.SetGenState(state, stream ^ 0x2ull);   // a different (still odd) stream
    std::vector<uint32_t> wrong;
    for (int i = 0; i < 6; ++i) wrong.push_back(gsRNG.NextInt());
    CHECK(wrong != expected);

    gsRNG.SetGenState(state, stream);
    std::vector<uint32_t> right;
    for (int i = 0; i < 6; ++i) right.push_back(gsRNG.NextInt());
    CHECK(right == expected);
}

// ───────────────────── The restore notifies clients ─────────────────────

TEST_CASE("a restore notifies both the teams that had state and the ones that get it") {
    // A resumed client must not be left showing the pre-restore board. The
    // failure mode is the *departing* side: a team whose orders are replaced
    // by none gets no notification if the notifier only walks the new state.
    resetManagers();
    StandingOrder before;
    before.id = 1;
    before.team = 4;
    standingOrders.RestoreState({before}, 2);

    std::set<int> notified;
    standingOrders.SetChangeNotifier([&](int team) { notified.insert(team); });

    StandingOrder after;
    after.id = 2;
    after.team = 6;
    standingOrders.RestoreState({after}, 3);

    CHECK(notified.count(4) == 1);   // lost its orders
    CHECK(notified.count(6) == 1);   // gained one
    resetManagers();
}

} // TEST_SUITE

// ═══════════ Task 1c — the teams + units sections (PLAN-persistence §7.1c) ═══════════
//
// The codec works on the plain state structs, never on a CUnit/CTeam, which is
// what makes it testable here: a doctest cannot stand up a map, a def handler
// and a team handler, so a codec written straight against CUnit* would have
// shipped with no round-trip coverage at all. The CAPTURE and APPLY halves are
// the parts that need a live sim and are verified on a running server.
//
// Two properties are checked, and the second is the one that catches the
// failure this file exists for:
//
//   1. A LOUD fixture (every field set to a distinct non-default value)
//      survives encode -> decode field for field. A field the writer skips
//      comes back as its default and the comparison fails.
//   2. RE-ENCODE SYMMETRY: encode(decode(bytes)) == bytes. This is what catches
//      a field that is *written but never read* - the round-trip comparison
//      alone would pass on a struct whose reader silently left it at default
//      only if the comparison forgot it too, and the byte compare cannot be
//      forgotten.

namespace {

ResPair resPair(float m, float e) { ResPair r; r.metal = m; r.energy = e; return r; }

TeamStatsState loudStats(int seed)
{
    TeamStatsState s;
    s.frame = seed;
    s.metalUsed = seed + 0.5f;      s.energyUsed = seed + 1.5f;
    s.metalProduced = seed + 2.5f;  s.energyProduced = seed + 3.5f;
    s.metalExcess = seed + 4.5f;    s.energyExcess = seed + 5.5f;
    s.metalReceived = seed + 6.5f;  s.energyReceived = seed + 7.5f;
    s.metalSent = seed + 8.5f;      s.energySent = seed + 9.5f;
    s.damageDealt = seed + 10.5f;   s.damageReceived = seed + 11.5f;
    s.unitsProduced = seed + 12;
    s.unitsDied = seed + 13;
    s.unitsReceived = seed + 14;
    s.unitsSent = seed + 15;
    s.unitsCaptured = seed + 16;
    s.unitsOutCaptured = seed + 17;
    s.unitsKilled = seed + 18;
    return s;
}

bool sameStats(const TeamStatsState& a, const TeamStatsState& b)
{
    return a.frame == b.frame
        && a.metalUsed == b.metalUsed && a.energyUsed == b.energyUsed
        && a.metalProduced == b.metalProduced && a.energyProduced == b.energyProduced
        && a.metalExcess == b.metalExcess && a.energyExcess == b.energyExcess
        && a.metalReceived == b.metalReceived && a.energyReceived == b.energyReceived
        && a.metalSent == b.metalSent && a.energySent == b.energySent
        && a.damageDealt == b.damageDealt && a.damageReceived == b.damageReceived
        && a.unitsProduced == b.unitsProduced && a.unitsDied == b.unitsDied
        && a.unitsReceived == b.unitsReceived && a.unitsSent == b.unitsSent
        && a.unitsCaptured == b.unitsCaptured
        && a.unitsOutCaptured == b.unitsOutCaptured
        && a.unitsKilled == b.unitsKilled;
}

/// One of each rulesParam variant arm, because the type discriminator is the
/// part of that encoding that can be wrong without any length changing.
std::vector<RulesParamState> loudRulesParams()
{
    std::vector<RulesParamState> ps;
    RulesParamState a; a.key = "flag";  a.los = 32; a.type = 0; a.b = true;      ps.push_back(a);
    RulesParamState b; b.key = "score"; b.los = 4;  b.type = 1; b.f = 1234.5f;   ps.push_back(b);
    RulesParamState c; c.key = "name";  c.los = 1;  c.type = 2; c.s = "vanguard"; ps.push_back(c);
    return ps;
}

bool sameRulesParams(const std::vector<RulesParamState>& a,
                     const std::vector<RulesParamState>& b)
{
    if (a.size() != b.size()) return false;
    for (size_t i = 0; i < a.size(); ++i) {
        if (a[i].key != b[i].key || a[i].los != b[i].los || a[i].type != b[i].type)
            return false;
        if (a[i].b != b[i].b || a[i].f != b[i].f || a[i].s != b[i].s)
            return false;
    }
    return true;
}

TeamState loudTeam()
{
    TeamState s;
    s.teamNum = 501;
    s.isDead = true;
    s.gaia = true;
    s.leader = 504;
    s.incomeMultiplier = 505.5f;
    s.startPosX = 506.5f;
    s.startPosY = 507.5f;
    s.startPosZ = 508.5f;
    s.res = resPair(509.25f, 509.75f);
    s.resStorage = resPair(510.25f, 510.75f);
    s.resPull = resPair(511.25f, 511.75f);
    s.resPrevPull = resPair(512.25f, 512.75f);
    s.resIncome = resPair(513.25f, 513.75f);
    s.resPrevIncome = resPair(514.25f, 514.75f);
    s.resExpense = resPair(515.25f, 515.75f);
    s.resPrevExpense = resPair(516.25f, 516.75f);
    s.resShare = resPair(517.25f, 517.75f);
    s.resDelayedShare = resPair(518.25f, 518.75f);
    s.resSent = resPair(519.25f, 519.75f);
    s.resPrevSent = resPair(520.25f, 520.75f);
    s.resReceived = resPair(521.25f, 521.75f);
    s.resPrevReceived = resPair(522.25f, 522.75f);
    s.resPrevExcess = resPair(523.25f, 523.75f);
    s.nextHistoryEntry = 524;
    // statHistory: set by hand
    // modParams: set by hand
    s.statHistory = {loudStats(3), loudStats(90)};
    s.modParams = loudRulesParams();
    return s;
}

bool sameTeam(const TeamState& a, const TeamState& b)
{
    if (a.statHistory.size() != b.statHistory.size()) return false;
    for (size_t i = 0; i < a.statHistory.size(); ++i)
        if (!sameStats(a.statHistory[i], b.statHistory[i])) return false;
    if (!sameRulesParams(a.modParams, b.modParams)) return false;
    return true
        && a.teamNum == b.teamNum
        && a.isDead == b.isDead
        && a.gaia == b.gaia
        && a.leader == b.leader
        && a.incomeMultiplier == b.incomeMultiplier
        && a.startPosX == b.startPosX
        && a.startPosY == b.startPosY
        && a.startPosZ == b.startPosZ
        && a.res.metal == b.res.metal && a.res.energy == b.res.energy
        && a.resStorage.metal == b.resStorage.metal && a.resStorage.energy == b.resStorage.energy
        && a.resPull.metal == b.resPull.metal && a.resPull.energy == b.resPull.energy
        && a.resPrevPull.metal == b.resPrevPull.metal && a.resPrevPull.energy == b.resPrevPull.energy
        && a.resIncome.metal == b.resIncome.metal && a.resIncome.energy == b.resIncome.energy
        && a.resPrevIncome.metal == b.resPrevIncome.metal && a.resPrevIncome.energy == b.resPrevIncome.energy
        && a.resExpense.metal == b.resExpense.metal && a.resExpense.energy == b.resExpense.energy
        && a.resPrevExpense.metal == b.resPrevExpense.metal && a.resPrevExpense.energy == b.resPrevExpense.energy
        && a.resShare.metal == b.resShare.metal && a.resShare.energy == b.resShare.energy
        && a.resDelayedShare.metal == b.resDelayedShare.metal && a.resDelayedShare.energy == b.resDelayedShare.energy
        && a.resSent.metal == b.resSent.metal && a.resSent.energy == b.resSent.energy
        && a.resPrevSent.metal == b.resPrevSent.metal && a.resPrevSent.energy == b.resPrevSent.energy
        && a.resReceived.metal == b.resReceived.metal && a.resReceived.energy == b.resReceived.energy
        && a.resPrevReceived.metal == b.resPrevReceived.metal && a.resPrevReceived.energy == b.resPrevReceived.energy
        && a.resPrevExcess.metal == b.resPrevExcess.metal && a.resPrevExcess.energy == b.resPrevExcess.energy
        && a.nextHistoryEntry == b.nextHistoryEntry
        ;
}

// ──────── Option A fixtures: the move type (PLAN-persistence §7.1c) ────────
//
// Every field gets a DISTINCT value (a running counter; bools cycle on a
// period of 3 so an adjacent-pair swap cannot cancel out), and the comparison
// is a flattened vector of every field rather than a hand-written operator==,
// so a field read back into the wrong member fails on the value and a field
// never read at all fails on the re-encode symmetry check.

/// @p off shifts every field, so the parked move type's base and the script
/// controller's base can be told apart - two AMoveType halves filled with the
/// same numbers would let a codec that collapsed them pass.
movetypesnapshot::BaseState loudBase(int off = 0)
{
    movetypesnapshot::BaseState v;
    v.goalX = 1 + off;
    v.goalY = 2 + off;
    v.goalZ = 3 + off;
    v.oldPosX = 4 + off;
    v.oldPosY = 5 + off;
    v.oldPosZ = 6 + off;
    v.oldSlowUpdatePosX = 7 + off;
    v.oldSlowUpdatePosY = 8 + off;
    v.oldSlowUpdatePosZ = 9 + off;
    v.oldCollisionUpdatePosX = 10 + off;
    v.oldCollisionUpdatePosY = 11 + off;
    v.oldCollisionUpdatePosZ = 12 + off;
    v.progressState = 13 + off;
    v.maxSpeed = 14 + off;
    v.maxSpeedDef = 15 + off;
    v.maxWantedSpeed = 16 + off;
    v.maneuverLeash = 17 + off;
    v.waterline = 18 + off;
    v.useHeading = ((19 + off) % 3) != 0;
    v.useWantedSpeed0 = ((20 + off) % 3) != 0;
    v.useWantedSpeed1 = ((21 + off) % 3) != 0;
    return v;
}

void flatten(const movetypesnapshot::BaseState& v, std::vector<double>& o)
{
    o.push_back(v.goalX);
    o.push_back(v.goalY);
    o.push_back(v.goalZ);
    o.push_back(v.oldPosX);
    o.push_back(v.oldPosY);
    o.push_back(v.oldPosZ);
    o.push_back(v.oldSlowUpdatePosX);
    o.push_back(v.oldSlowUpdatePosY);
    o.push_back(v.oldSlowUpdatePosZ);
    o.push_back(v.oldCollisionUpdatePosX);
    o.push_back(v.oldCollisionUpdatePosY);
    o.push_back(v.oldCollisionUpdatePosZ);
    o.push_back(v.progressState);
    o.push_back(v.maxSpeed);
    o.push_back(v.maxSpeedDef);
    o.push_back(v.maxWantedSpeed);
    o.push_back(v.maneuverLeash);
    o.push_back(v.waterline);
    o.push_back(v.useHeading);
    o.push_back(v.useWantedSpeed0);
    o.push_back(v.useWantedSpeed1);
}

movetypesnapshot::GroundState loudGround()
{
    movetypesnapshot::GroundState v;
    v.currWayPointX = 22;
    v.currWayPointY = 23;
    v.currWayPointZ = 24;
    v.nextWayPointX = 25;
    v.nextWayPointY = 26;
    v.nextWayPointZ = 27;
    v.earlyCurrWayPointX = 28;
    v.earlyCurrWayPointY = 29;
    v.earlyCurrWayPointZ = 30;
    v.earlyNextWayPointX = 31;
    v.earlyNextWayPointY = 32;
    v.earlyNextWayPointZ = 33;
    v.waypointDirX = 34;
    v.waypointDirY = 35;
    v.waypointDirZ = 36;
    v.flatFrontDirX = 37;
    v.flatFrontDirY = 38;
    v.flatFrontDirZ = 39;
    v.lastAvoidanceDirX = 40;
    v.lastAvoidanceDirY = 41;
    v.lastAvoidanceDirZ = 42;
    v.mainHeadingPosX = 43;
    v.mainHeadingPosY = 44;
    v.mainHeadingPosZ = 45;
    v.skidRotVectorX = 46;
    v.skidRotVectorY = 47;
    v.skidRotVectorZ = 48;
    v.turnRate = 49;
    v.turnSpeed = 50;
    v.turnAccel = 51;
    v.accRate = 52;
    v.decRate = 53;
    v.myGravity = 54;
    v.maxReverseDist = 55;
    v.minReverseAngle = 56;
    v.maxReverseSpeed = 57;
    v.sqSkidSpeedMult = 58;
    v.wantedSpeed = 59;
    v.currentSpeed = 60;
    v.deltaSpeed = 61;
    v.currWayPointDist = 62;
    v.prevWayPointDist = 63;
    v.goalRadius = 64;
    v.ownerRadius = 65;
    v.extraRadius = 66;
    v.skidRotSpeed = 67;
    v.skidRotAccel = 68;
    v.forceFromMovingCollideesX = 69;
    v.forceFromMovingCollideesY = 70;
    v.forceFromMovingCollideesZ = 71;
    v.forceFromStaticCollideesX = 72;
    v.forceFromStaticCollideesY = 73;
    v.forceFromStaticCollideesZ = 74;
    v.resultantForcesX = 75;
    v.resultantForcesY = 76;
    v.resultantForcesZ = 77;
    v.numIdlingUpdates = 78;
    v.numIdlingSlowUpdates = 79;
    v.wantedHeading = 80;
    v.minScriptChangeHeading = 81;
    v.wantRepathFrame = 82;
    v.lastRepathFrame = 83;
    v.bestLastWaypointDist = 84;
    v.bestReattemptedLastWaypointDist = 85;
    v.setHeading = 86;
    v.setHeadingDir = 87;
    v.limitSpeedForTurning = 88;
    v.oldSpeed = 89;
    v.newSpeed = 90;
    v.atGoal = true;
    v.atEndOfPath = true;
    v.wantRepath = false;
    v.moveFailed = true;
    v.lastWaypoint = true;
    v.reversing = false;
    v.idling = true;
    v.pushResistant = true;
    v.pushResistanceBlockActive = false;
    v.canReverse = true;
    v.useMainHeading = true;
    v.useRawMovement = false;
    v.pathingFailed = true;
    v.pathingArrived = true;
    v.positionStuck = false;
    v.forceStaticObjectCheck = true;
    v.avoidingUnits = true;
    return v;
}

void flatten(const movetypesnapshot::GroundState& v, std::vector<double>& o)
{
    o.push_back(v.currWayPointX);
    o.push_back(v.currWayPointY);
    o.push_back(v.currWayPointZ);
    o.push_back(v.nextWayPointX);
    o.push_back(v.nextWayPointY);
    o.push_back(v.nextWayPointZ);
    o.push_back(v.earlyCurrWayPointX);
    o.push_back(v.earlyCurrWayPointY);
    o.push_back(v.earlyCurrWayPointZ);
    o.push_back(v.earlyNextWayPointX);
    o.push_back(v.earlyNextWayPointY);
    o.push_back(v.earlyNextWayPointZ);
    o.push_back(v.waypointDirX);
    o.push_back(v.waypointDirY);
    o.push_back(v.waypointDirZ);
    o.push_back(v.flatFrontDirX);
    o.push_back(v.flatFrontDirY);
    o.push_back(v.flatFrontDirZ);
    o.push_back(v.lastAvoidanceDirX);
    o.push_back(v.lastAvoidanceDirY);
    o.push_back(v.lastAvoidanceDirZ);
    o.push_back(v.mainHeadingPosX);
    o.push_back(v.mainHeadingPosY);
    o.push_back(v.mainHeadingPosZ);
    o.push_back(v.skidRotVectorX);
    o.push_back(v.skidRotVectorY);
    o.push_back(v.skidRotVectorZ);
    o.push_back(v.turnRate);
    o.push_back(v.turnSpeed);
    o.push_back(v.turnAccel);
    o.push_back(v.accRate);
    o.push_back(v.decRate);
    o.push_back(v.myGravity);
    o.push_back(v.maxReverseDist);
    o.push_back(v.minReverseAngle);
    o.push_back(v.maxReverseSpeed);
    o.push_back(v.sqSkidSpeedMult);
    o.push_back(v.wantedSpeed);
    o.push_back(v.currentSpeed);
    o.push_back(v.deltaSpeed);
    o.push_back(v.currWayPointDist);
    o.push_back(v.prevWayPointDist);
    o.push_back(v.goalRadius);
    o.push_back(v.ownerRadius);
    o.push_back(v.extraRadius);
    o.push_back(v.skidRotSpeed);
    o.push_back(v.skidRotAccel);
    o.push_back(v.forceFromMovingCollideesX);
    o.push_back(v.forceFromMovingCollideesY);
    o.push_back(v.forceFromMovingCollideesZ);
    o.push_back(v.forceFromStaticCollideesX);
    o.push_back(v.forceFromStaticCollideesY);
    o.push_back(v.forceFromStaticCollideesZ);
    o.push_back(v.resultantForcesX);
    o.push_back(v.resultantForcesY);
    o.push_back(v.resultantForcesZ);
    o.push_back(v.numIdlingUpdates);
    o.push_back(v.numIdlingSlowUpdates);
    o.push_back(v.wantedHeading);
    o.push_back(v.minScriptChangeHeading);
    o.push_back(v.wantRepathFrame);
    o.push_back(v.lastRepathFrame);
    o.push_back(v.bestLastWaypointDist);
    o.push_back(v.bestReattemptedLastWaypointDist);
    o.push_back(v.setHeading);
    o.push_back(v.setHeadingDir);
    o.push_back(v.limitSpeedForTurning);
    o.push_back(v.oldSpeed);
    o.push_back(v.newSpeed);
    o.push_back(v.atGoal);
    o.push_back(v.atEndOfPath);
    o.push_back(v.wantRepath);
    o.push_back(v.moveFailed);
    o.push_back(v.lastWaypoint);
    o.push_back(v.reversing);
    o.push_back(v.idling);
    o.push_back(v.pushResistant);
    o.push_back(v.pushResistanceBlockActive);
    o.push_back(v.canReverse);
    o.push_back(v.useMainHeading);
    o.push_back(v.useRawMovement);
    o.push_back(v.pathingFailed);
    o.push_back(v.pathingArrived);
    o.push_back(v.positionStuck);
    o.push_back(v.forceStaticObjectCheck);
    o.push_back(v.avoidingUnits);

}

movetypesnapshot::AirState loudAir()
{
    movetypesnapshot::AirState v;
    v.aircraftState = 109;
    v.collisionState = 110;
    v.oldGoalPosX = 111;
    v.oldGoalPosY = 112;
    v.oldGoalPosZ = 113;
    v.reservedLandingPosX = 114;
    v.reservedLandingPosY = 115;
    v.reservedLandingPosZ = 116;
    v.landRadiusSq = 117;
    v.wantedHeight = 118;
    v.orgWantedHeight = 119;
    v.accRate = 120;
    v.decRate = 121;
    v.altitudeRate = 122;
    v.collide = false;
    v.autoLand = true;
    v.dontLand = true;
    v.useSmoothMesh = false;
    v.canSubmerge = true;
    v.floatOnWater = true;
    return v;
}

void flatten(const movetypesnapshot::AirState& v, std::vector<double>& o)
{
    o.push_back(v.aircraftState);
    o.push_back(v.collisionState);
    o.push_back(v.oldGoalPosX);
    o.push_back(v.oldGoalPosY);
    o.push_back(v.oldGoalPosZ);
    o.push_back(v.reservedLandingPosX);
    o.push_back(v.reservedLandingPosY);
    o.push_back(v.reservedLandingPosZ);
    o.push_back(v.landRadiusSq);
    o.push_back(v.wantedHeight);
    o.push_back(v.orgWantedHeight);
    o.push_back(v.accRate);
    o.push_back(v.decRate);
    o.push_back(v.altitudeRate);
    o.push_back(v.collide);
    o.push_back(v.autoLand);
    o.push_back(v.dontLand);
    o.push_back(v.useSmoothMesh);
    o.push_back(v.canSubmerge);
    o.push_back(v.floatOnWater);
}

movetypesnapshot::HoverState loudHover()
{
    movetypesnapshot::HoverState v;
    v.flyState = 129;
    v.bankingAllowed = true;
    v.airStrafe = true;
    v.wantToStop = false;
    v.goalDistance = 133;
    v.currentBank = 134;
    v.currentPitch = 135;
    v.turnRate = 136;
    v.maxDrift = 137;
    v.maxTurnAngle = 138;
    v.wantedSpeedX = 139;
    v.wantedSpeedY = 140;
    v.wantedSpeedZ = 141;
    v.deltaSpeedX = 142;
    v.deltaSpeedY = 143;
    v.deltaSpeedZ = 144;
    v.circlingPosX = 145;
    v.circlingPosY = 146;
    v.circlingPosZ = 147;
    v.randomWindX = 148;
    v.randomWindY = 149;
    v.randomWindZ = 150;
    v.forceHeading = true;
    v.wantedHeading = 152;
    v.forcedHeading = 153;
    v.waitCounter = 154;
    v.lastMoveRate = 155;
    return v;
}

void flatten(const movetypesnapshot::HoverState& v, std::vector<double>& o)
{
    o.push_back(v.flyState);
    o.push_back(v.bankingAllowed);
    o.push_back(v.airStrafe);
    o.push_back(v.wantToStop);
    o.push_back(v.goalDistance);
    o.push_back(v.currentBank);
    o.push_back(v.currentPitch);
    o.push_back(v.turnRate);
    o.push_back(v.maxDrift);
    o.push_back(v.maxTurnAngle);
    o.push_back(v.wantedSpeedX);
    o.push_back(v.wantedSpeedY);
    o.push_back(v.wantedSpeedZ);
    o.push_back(v.deltaSpeedX);
    o.push_back(v.deltaSpeedY);
    o.push_back(v.deltaSpeedZ);
    o.push_back(v.circlingPosX);
    o.push_back(v.circlingPosY);
    o.push_back(v.circlingPosZ);
    o.push_back(v.randomWindX);
    o.push_back(v.randomWindY);
    o.push_back(v.randomWindZ);
    o.push_back(v.forceHeading);
    o.push_back(v.wantedHeading);
    o.push_back(v.forcedHeading);
    o.push_back(v.waitCounter);
    o.push_back(v.lastMoveRate);
}

movetypesnapshot::StrafeState loudStrafe()
{
    movetypesnapshot::StrafeState v;
    v.maneuverBlockTime = 156;
    v.maneuverState = 157;
    v.maneuverSubState = 158;
    v.loopbackAttack = false;
    v.isFighter = true;
    v.wingDrag = 161;
    v.wingAngle = 162;
    v.invDrag = 163;
    v.crashDrag = 164;
    v.frontToSpeed = 165;
    v.speedToFront = 166;
    v.myGravity = 167;
    v.maxBank = 168;
    v.maxPitch = 169;
    v.turnRadius = 170;
    v.maxAileron = 171;
    v.maxElevator = 172;
    v.maxRudder = 173;
    v.attackSafetyDistance = 174;
    v.crashAileron = 175;
    v.crashElevator = 176;
    v.crashRudder = 177;
    v.lastRudderPos0 = 178;
    v.lastRudderPos1 = 179;
    v.lastElevatorPos0 = 180;
    v.lastElevatorPos1 = 181;
    v.lastAileronPos0 = 182;
    v.lastAileronPos1 = 183;
    return v;
}

void flatten(const movetypesnapshot::StrafeState& v, std::vector<double>& o)
{
    o.push_back(v.maneuverBlockTime);
    o.push_back(v.maneuverState);
    o.push_back(v.maneuverSubState);
    o.push_back(v.loopbackAttack);
    o.push_back(v.isFighter);
    o.push_back(v.wingDrag);
    o.push_back(v.wingAngle);
    o.push_back(v.invDrag);
    o.push_back(v.crashDrag);
    o.push_back(v.frontToSpeed);
    o.push_back(v.speedToFront);
    o.push_back(v.myGravity);
    o.push_back(v.maxBank);
    o.push_back(v.maxPitch);
    o.push_back(v.turnRadius);
    o.push_back(v.maxAileron);
    o.push_back(v.maxElevator);
    o.push_back(v.maxRudder);
    o.push_back(v.attackSafetyDistance);
    o.push_back(v.crashAileron);
    o.push_back(v.crashElevator);
    o.push_back(v.crashRudder);
    o.push_back(v.lastRudderPos0);
    o.push_back(v.lastRudderPos1);
    o.push_back(v.lastElevatorPos0);
    o.push_back(v.lastElevatorPos1);
    o.push_back(v.lastAileronPos0);
    o.push_back(v.lastAileronPos1);
}

movetypesnapshot::ScriptState loudScript()
{
    movetypesnapshot::ScriptState v;
    v.velVecX = 184;
    v.velVecY = 185;
    v.velVecZ = 186;
    v.relVelX = 187;
    v.relVelY = 188;
    v.relVelZ = 189;
    v.rotX = 190;
    v.rotY = 191;
    v.rotZ = 192;
    v.rotVelX = 193;
    v.rotVelY = 194;
    v.rotVelZ = 195;
    v.minsX = 196;
    v.minsY = 197;
    v.minsZ = 198;
    v.maxsX = 199;
    v.maxsY = 200;
    v.maxsZ = 201;
    v.tag = 202;
    v.drag = 203;
    v.groundOffset = 204;
    v.gravityFactor = 205;
    v.windFactor = 206;
    v.extrapolate = false;
    v.useRelVel = true;
    v.useRotVel = true;
    v.trackSlope = false;
    v.trackGround = true;
    v.trackLimits = true;
    v.noBlocking = false;
    v.groundStop = true;
    v.limitsStop = true;
    v.scriptNotify = 216;
    return v;
}

void flatten(const movetypesnapshot::ScriptState& v, std::vector<double>& o)
{
    o.push_back(v.velVecX);
    o.push_back(v.velVecY);
    o.push_back(v.velVecZ);
    o.push_back(v.relVelX);
    o.push_back(v.relVelY);
    o.push_back(v.relVelZ);
    o.push_back(v.rotX);
    o.push_back(v.rotY);
    o.push_back(v.rotZ);
    o.push_back(v.rotVelX);
    o.push_back(v.rotVelY);
    o.push_back(v.rotVelZ);
    o.push_back(v.minsX);
    o.push_back(v.minsY);
    o.push_back(v.minsZ);
    o.push_back(v.maxsX);
    o.push_back(v.maxsY);
    o.push_back(v.maxsZ);
    o.push_back(v.tag);
    o.push_back(v.drag);
    o.push_back(v.groundOffset);
    o.push_back(v.gravityFactor);
    o.push_back(v.windFactor);
    o.push_back(v.extrapolate);
    o.push_back(v.useRelVel);
    o.push_back(v.useRotVel);
    o.push_back(v.trackSlope);
    o.push_back(v.trackGround);
    o.push_back(v.trackLimits);
    o.push_back(v.noBlocking);
    o.push_back(v.groundStop);
    o.push_back(v.limitsStop);
    o.push_back(v.scriptNotify);
}

movetypesnapshot::MoveTypeState loudMove(movetypesnapshot::Kind kind)
{
    movetypesnapshot::MoveTypeState m;
    m.kind = static_cast<uint8_t>(kind);
    m.base = loudBase();
    m.ground = loudGround();
    m.air = loudAir();
    m.hover = loudHover();
    m.strafe = loudStrafe();
    m.script = loudScript();
    m.scriptBase = loudBase(1000);
    return m;
}

/// Flattens ONLY the arms `kind` says are written. The unwritten arms are
/// deliberately not compared: the codec does not carry them, so requiring them
/// to survive would be asserting a fidelity the payload never claimed.
std::vector<double> flattenMove(const movetypesnapshot::MoveTypeState& m)
{
    using movetypesnapshot::Kind;
    std::vector<double> o;
    o.push_back(m.kind);
    if (m.kind == static_cast<uint8_t>(Kind::None))
        return o;
    flatten(m.base, o);
    switch (static_cast<Kind>(m.kind)) {
        case Kind::Ground:    flatten(m.ground, o); break;
        case Kind::HoverAir:  flatten(m.air, o); flatten(m.hover, o); break;
        case Kind::StrafeAir: flatten(m.air, o); flatten(m.strafe, o); break;
        default: break;
    }
    o.push_back(m.scriptControlled);
    if (m.scriptControlled) {
        flatten(m.scriptBase, o);
        flatten(m.script, o);
    }
    return o;
}

UnitState loudUnit()
{
    UnitState s;
    s.id = 101;
    s.unitDefName = "loud-unitDefName";
    s.team = 103;
    s.buildFacing = 104;
    s.beingBuilt = true;
    s.posX = 106.5f;
    s.posY = 107.5f;
    s.posZ = 108.5f;
    s.speedX = 109.5f;
    s.speedY = 110.5f;
    s.speedZ = 111.5f;
    s.heading = 112;
    s.frontX = 113.5f;
    s.frontY = 114.5f;
    s.frontZ = 115.5f;
    s.rightX = 116.5f;
    s.rightY = 117.5f;
    s.rightZ = 118.5f;
    s.upX = 119.5f;
    s.upY = 120.5f;
    s.upZ = 121.5f;
    s.physicalState = 122;
    s.collidableState = 123;
    s.health = 124.5f;
    s.maxHealth = 125.5f;
    s.paralyzeDamage = 126.5f;
    s.captureProgress = 127.5f;
    s.buildProgress = 128.5f;
    s.experience = 129.5f;
    s.recentDamage = 130.5f;
    s.power = 131.5f;
    s.mass = 132.5f;
    s.buildTime = 133.5f;
    s.terraformLeft = 134.5f;
    s.repairAmount = 135.5f;
    s.metalExtract = 136.5f;
    s.cost = resPair(137.25f, 137.75f);
    s.harvested = resPair(138.25f, 138.75f);
    s.harvestStorage = resPair(139.25f, 139.75f);
    s.storage = resPair(140.25f, 140.75f);
    s.fireState = 141;
    s.moveState = 142;
    s.armoredState = true;
    s.armoredMultiple = 144.5f;
    s.curArmorMultiple = 145.5f;
    s.armorType = 146;
    s.category = 147;
    s.maxRange = 148.5f;
    s.reloadSpeed = 149.5f;
    s.flankingBonusMode = 150;
    s.flankingDirX = 151.5f;
    s.flankingDirY = 152.5f;
    s.flankingDirZ = 153.5f;
    s.flankingBonusMobility = 154.5f;
    s.flankingBonusMobilityAdd = 155.5f;
    s.flankingBonusAvgDamage = 156.5f;
    s.flankingBonusDifDamage = 157.5f;
    s.onTempHoldFire = true;
    s.forceUseWeapons = true;
    s.allowUseWeapons = true;
    s.inBuildStance = true;
    s.useHighTrajectory = true;
    s.selfDCountdown = 163;
    s.delayedWreckLevel = 164;
    s.featureDefID = 165;
    s.lastAttackFrame = 166;
    s.lastFireWeapon = 167;
    s.lastNanoAdd = 168;
    s.restTime = 169;
    s.losRadius = 170;
    s.airLosRadius = 171;
    s.realLosRadius = 172;
    s.realAirLosRadius = 173;
    s.radarRadius = 174;
    s.sonarRadius = 175;
    s.jammerRadius = 176;
    s.sonarJamRadius = 177;
    s.seismicRadius = 178;
    s.seismicSignature = 179.5f;
    s.decloakDistance = 180.5f;
    s.stealth = true;
    s.sonarStealth = true;
    s.isCloaked = true;
    s.wantCloak = true;
    s.alwaysVisible = true;
    s.useAirLos = true;
    s.posErrX = 187.5f;
    s.posErrY = 188.5f;
    s.posErrZ = 189.5f;
    s.posErrDeltaX = 190.5f;
    s.posErrDeltaY = 191.5f;
    s.posErrDeltaZ = 192.5f;
    s.nextPosErrorUpdate = 193;
    s.activated = true;
    s.neutral = true;
    s.upright = true;
    s.groundLevelled = true;
    s.stunned = true;
    s.invulnerable = true;
    s.noSelect = true;
    s.transporterId = 201;
    s.loadingTransportId = 202;
    s.unloadingTransportId = 203;
    s.transportCapacityUsed = 204;
    s.transportMassUsed = 205.5f;
    // commands: set by hand
    s.tagCounter = 207;
    s.repeatOrders = true;
    s.lastUserCommand = 209;
    s.lastFinishCommand = 210;
    // weapons: set by hand
    // modParams: set by hand
    s.cost = resPair(1.5f, 2.5f);
    s.harvested = resPair(3.5f, 4.5f);
    s.harvestStorage = resPair(5.5f, 6.5f);
    s.storage = resPair(7.5f, 8.5f);
    s.transportees = {{11, 3}, {12, 5}};

    CommandState move;
    move.cmdID = 10;            // CMD_MOVE
    move.aiCallbackID = 7;
    move.timeOut = 99999;
    move.tag = 44;
    move.options = 0x20;
    move.params = {100.5f, 0.0f, 200.25f};
    CommandState build;
    build.cmdID = -42;          // a build order is a negative def id
    build.aiCallbackID = -1;
    build.timeOut = 123;
    build.tag = 45;
    build.options = 0;
    // More than MAX_COMMAND_PARAMS worth, so the pooled-params path is covered
    // on the way back into a real Command.
    build.params = {1, 2, 3, 4, 5, 6, 7, 8, 9, 10};
    s.commands = {move, build};

    WeaponState w0; w0.reloadStatus = 4000; w0.salvoLeft = 2; w0.nextSalvo = 4010;
                    w0.numStockpiled = 3; w0.numStockpileQued = 1;
                    w0.weaponDefName = "glaive_cannon";
    WeaponState w1; w1.reloadStatus = 4100; w1.salvoLeft = 0; w1.nextSalvo = 0;
                    w1.numStockpiled = 0; w1.numStockpileQued = 7;
                    w1.weaponDefName = "raven_rocket";
    s.weapons = {w0, w1};
    s.modParams = loudRulesParams();
    s.activeIndex = 37;
    s.move = loudMove(movetypesnapshot::Kind::Ground);
    return s;
}

bool sameUnit(const UnitState& a, const UnitState& b)
{
    if (a.transportees != b.transportees) return false;
    if (a.commands.size() != b.commands.size()) return false;
    for (size_t i = 0; i < a.commands.size(); ++i) {
        const auto& x = a.commands[i];
        const auto& y = b.commands[i];
        if (x.cmdID != y.cmdID || x.aiCallbackID != y.aiCallbackID ||
            x.timeOut != y.timeOut || x.tag != y.tag || x.options != y.options ||
            x.params != y.params)
            return false;
    }
    if (a.weapons.size() != b.weapons.size()) return false;
    for (size_t i = 0; i < a.weapons.size(); ++i) {
        const auto& x = a.weapons[i];
        const auto& y = b.weapons[i];
        if (x.reloadStatus != y.reloadStatus || x.salvoLeft != y.salvoLeft ||
            x.nextSalvo != y.nextSalvo || x.numStockpiled != y.numStockpiled ||
            x.numStockpileQued != y.numStockpileQued ||
            x.weaponDefName != y.weaponDefName)
            return false;
    }
    if (!sameRulesParams(a.modParams, b.modParams)) return false;
    return true
        && a.id == b.id
        && a.unitDefName == b.unitDefName
        && a.team == b.team
        && a.buildFacing == b.buildFacing
        && a.beingBuilt == b.beingBuilt
        && a.posX == b.posX
        && a.posY == b.posY
        && a.posZ == b.posZ
        && a.speedX == b.speedX
        && a.speedY == b.speedY
        && a.speedZ == b.speedZ
        && a.heading == b.heading
        && a.frontX == b.frontX
        && a.frontY == b.frontY
        && a.frontZ == b.frontZ
        && a.rightX == b.rightX
        && a.rightY == b.rightY
        && a.rightZ == b.rightZ
        && a.upX == b.upX
        && a.upY == b.upY
        && a.upZ == b.upZ
        && a.physicalState == b.physicalState
        && a.collidableState == b.collidableState
        && a.health == b.health
        && a.maxHealth == b.maxHealth
        && a.paralyzeDamage == b.paralyzeDamage
        && a.captureProgress == b.captureProgress
        && a.buildProgress == b.buildProgress
        && a.experience == b.experience
        && a.recentDamage == b.recentDamage
        && a.power == b.power
        && a.mass == b.mass
        && a.buildTime == b.buildTime
        && a.terraformLeft == b.terraformLeft
        && a.repairAmount == b.repairAmount
        && a.metalExtract == b.metalExtract
        && a.cost.metal == b.cost.metal && a.cost.energy == b.cost.energy
        && a.harvested.metal == b.harvested.metal && a.harvested.energy == b.harvested.energy
        && a.harvestStorage.metal == b.harvestStorage.metal && a.harvestStorage.energy == b.harvestStorage.energy
        && a.storage.metal == b.storage.metal && a.storage.energy == b.storage.energy
        && a.fireState == b.fireState
        && a.moveState == b.moveState
        && a.armoredState == b.armoredState
        && a.armoredMultiple == b.armoredMultiple
        && a.curArmorMultiple == b.curArmorMultiple
        && a.armorType == b.armorType
        && a.category == b.category
        && a.maxRange == b.maxRange
        && a.reloadSpeed == b.reloadSpeed
        && a.flankingBonusMode == b.flankingBonusMode
        && a.flankingDirX == b.flankingDirX
        && a.flankingDirY == b.flankingDirY
        && a.flankingDirZ == b.flankingDirZ
        && a.flankingBonusMobility == b.flankingBonusMobility
        && a.flankingBonusMobilityAdd == b.flankingBonusMobilityAdd
        && a.flankingBonusAvgDamage == b.flankingBonusAvgDamage
        && a.flankingBonusDifDamage == b.flankingBonusDifDamage
        && a.onTempHoldFire == b.onTempHoldFire
        && a.forceUseWeapons == b.forceUseWeapons
        && a.allowUseWeapons == b.allowUseWeapons
        && a.inBuildStance == b.inBuildStance
        && a.useHighTrajectory == b.useHighTrajectory
        && a.selfDCountdown == b.selfDCountdown
        && a.delayedWreckLevel == b.delayedWreckLevel
        && a.featureDefID == b.featureDefID
        && a.lastAttackFrame == b.lastAttackFrame
        && a.lastFireWeapon == b.lastFireWeapon
        && a.lastNanoAdd == b.lastNanoAdd
        && a.restTime == b.restTime
        && a.losRadius == b.losRadius
        && a.airLosRadius == b.airLosRadius
        && a.realLosRadius == b.realLosRadius
        && a.realAirLosRadius == b.realAirLosRadius
        && a.radarRadius == b.radarRadius
        && a.sonarRadius == b.sonarRadius
        && a.jammerRadius == b.jammerRadius
        && a.sonarJamRadius == b.sonarJamRadius
        && a.seismicRadius == b.seismicRadius
        && a.seismicSignature == b.seismicSignature
        && a.decloakDistance == b.decloakDistance
        && a.stealth == b.stealth
        && a.sonarStealth == b.sonarStealth
        && a.isCloaked == b.isCloaked
        && a.wantCloak == b.wantCloak
        && a.alwaysVisible == b.alwaysVisible
        && a.useAirLos == b.useAirLos
        && a.posErrX == b.posErrX
        && a.posErrY == b.posErrY
        && a.posErrZ == b.posErrZ
        && a.posErrDeltaX == b.posErrDeltaX
        && a.posErrDeltaY == b.posErrDeltaY
        && a.posErrDeltaZ == b.posErrDeltaZ
        && a.nextPosErrorUpdate == b.nextPosErrorUpdate
        && a.activated == b.activated
        && a.neutral == b.neutral
        && a.upright == b.upright
        && a.groundLevelled == b.groundLevelled
        && a.stunned == b.stunned
        && a.invulnerable == b.invulnerable
        && a.noSelect == b.noSelect
        && a.transporterId == b.transporterId
        && a.loadingTransportId == b.loadingTransportId
        && a.unloadingTransportId == b.unloadingTransportId
        && a.transportCapacityUsed == b.transportCapacityUsed
        && a.transportMassUsed == b.transportMassUsed
        && a.tagCounter == b.tagCounter
        && a.repeatOrders == b.repeatOrders
        && a.lastUserCommand == b.lastUserCommand
        && a.lastFinishCommand == b.lastFinishCommand
        && a.activeIndex == b.activeIndex
        && flattenMove(a.move) == flattenMove(b.move)
        ;
}

} // namespace

TEST_CASE("task 1c: the field censuses are armed") {
    // Same contract as 1b's: the count each census destructures is pinned here,
    // so a field added to a state struct fails the BUILD (the binding count is
    // wrong) and a field added to the binding without being written fails HERE.
    CHECK(census::Res(ResPair{}) == 2);
    CHECK(census::RulesParam(RulesParamState{}) == 6);
    CHECK(census::Stats(TeamStatsState{}) == 20);
    CHECK(census::Cmd(CommandState{}) == 6);
    CHECK(census::Weapon(WeaponState{}) == 6);
    CHECK(census::Team(TeamState{}) == 26);
    CHECK(census::Unit(UnitState{}) == 115);

    // Option A: one count per move-type class, so a member added to (say)
    // CStrafeAirMoveType names the arm it belongs to instead of moving a
    // single aggregate number.
    CHECK(census::MoveBase(movetypesnapshot::BaseState{}) == 21);
    CHECK(census::MoveGround(movetypesnapshot::GroundState{}) == 86);
    CHECK(census::MoveAir(movetypesnapshot::AirState{}) == 20);
    CHECK(census::MoveHover(movetypesnapshot::HoverState{}) == 27);
    CHECK(census::MoveStrafe(movetypesnapshot::StrafeState{}) == 28);
    CHECK(census::MoveScript(movetypesnapshot::ScriptState{}) == 33);
    CHECK(census::MoveType_(movetypesnapshot::MoveTypeState{}) == 9);

    // The wind. This count is also the tie to EnvResourceHandler's own
    // CR_REG_METADATA list: 11 creg members, four of them float3s the state
    // struct flattens into three scalars each.
    CHECK(census::EnvResource(envressnapshot::EnvResourceState{}) == 19);

    // Task 3's two. These are the def-scalar audit in code: a scalar added to
    // UnitDefScalars must be captured off the def, encoded, and given a
    // disposition in ReconcileScalars, and this is where forgetting shows up.
    CHECK(census::UnitDefScalars_(UnitDefScalars{}) == 26);
    CHECK(census::FeatureDefScalars_(FeatureDefScalars{}) == 4);
}

TEST_CASE("option A: every move-type class round-trips its own arm") {
    using movetypesnapshot::Kind;

    for (const Kind kind : {Kind::None, Kind::Static, Kind::Ground,
                            Kind::HoverAir, Kind::StrafeAir, Kind::Script}) {
        INFO("kind " << int(kind));

        UnitState u = loudUnit();
        u.move = loudMove(kind);

        std::vector<uint8_t> bytes;
        EncodeUnits({u}, bytes);

        std::vector<UnitState> out;
        std::string err;
        REQUIRE_MESSAGE(DecodeUnits(bytes.data(), bytes.size(), out, err), err);
        REQUIRE(out.size() == 1);
        CHECK(flattenMove(u.move) == flattenMove(out[0].move));
        CHECK(out[0].move.kind == static_cast<uint8_t>(kind));

        // Catches a field written but never read: re-encoding what came back
        // has to produce the same bytes.
        std::vector<uint8_t> again;
        EncodeUnits(out, again);
        CHECK(again == bytes);
    }
}

TEST_CASE("option A: a unit under Lua move control keeps both halves") {
    // The live moveType is a CScriptMoveType and the real one is parked in
    // prevMoveType. `kind` names the PARKED type - a payload that recorded
    // only the controller would restore a tank as a script-driven object
    // forever.
    UnitState u = loudUnit();
    u.move = loudMove(movetypesnapshot::Kind::Ground);
    u.move.scriptControlled = true;

    std::vector<uint8_t> bytes;
    EncodeUnits({u}, bytes);

    std::vector<UnitState> out;
    std::string err;
    REQUIRE_MESSAGE(DecodeUnits(bytes.data(), bytes.size(), out, err), err);
    REQUIRE(out.size() == 1);
    CHECK(out[0].move.scriptControlled);
    CHECK(out[0].move.kind == static_cast<uint8_t>(movetypesnapshot::Kind::Ground));
    CHECK(flattenMove(u.move) == flattenMove(out[0].move));

    // And the two halves are really two: the script arm costs bytes over the
    // same unit without it.
    UnitState plain = u;
    plain.move.scriptControlled = false;
    std::vector<uint8_t> plainBytes;
    EncodeUnits({plain}, plainBytes);
    CHECK(plainBytes.size() < bytes.size());
}

TEST_CASE("option A: only the arm the discriminant names costs bytes") {
    // A Metalstorm world is mostly buildings, and a building's move type is a
    // CStaticMoveType with no members of its own. If the codec wrote every arm
    // regardless of kind, the payload would carry a CGroundMoveType's 87
    // fields for each of them.
    UnitState stat = loudUnit();
    stat.move = loudMove(movetypesnapshot::Kind::Static);
    UnitState ground = loudUnit();
    ground.move = loudMove(movetypesnapshot::Kind::Ground);
    UnitState none = loudUnit();
    none.move = loudMove(movetypesnapshot::Kind::None);

    std::vector<uint8_t> statBytes, groundBytes, noneBytes;
    EncodeUnits({stat}, statBytes);
    EncodeUnits({ground}, groundBytes);
    EncodeUnits({none}, noneBytes);

    CHECK(noneBytes.size() < statBytes.size());
    CHECK(statBytes.size() < groundBytes.size());
    // The base is 21 fields; the ground arm is 86 more, most of them 4 bytes.
    CHECK(groundBytes.size() - statBytes.size() > 86 * 1);
}

TEST_CASE("option A: an unknown move-type discriminant is a refusal") {
    // There is no way to skip an arm of unknown length, so a payload written
    // by a binary with a different move-type set has to fail at the tag rather
    // than at a garbled field several hundred bytes later.
    UnitState u = loudUnit();
    u.move = loudMove(movetypesnapshot::Kind::Ground);

    std::vector<uint8_t> bytes;
    EncodeUnits({u}, bytes);

    std::vector<UnitState> ref;
    std::string err;
    REQUIRE_MESSAGE(DecodeUnits(bytes.data(), bytes.size(), ref, err), err);

    // The discriminant is the last byte the unit writes before its move arm;
    // find it by re-encoding the same unit with a different kind and taking
    // the first byte that differs.
    UnitState other = u;
    other.move.kind = static_cast<uint8_t>(movetypesnapshot::Kind::Static);
    std::vector<uint8_t> otherBytes;
    EncodeUnits({other}, otherBytes);

    size_t at = 0;
    while (at < bytes.size() && at < otherBytes.size() && bytes[at] == otherBytes[at]) ++at;
    REQUIRE(at < bytes.size());
    CHECK(bytes[at] == static_cast<uint8_t>(movetypesnapshot::Kind::Ground));

    std::vector<uint8_t> bad = bytes;
    bad[at] = 99;
    std::vector<UnitState> out;
    std::string err2;
    CHECK_FALSE(DecodeUnits(bad.data(), bad.size(), out, err2));

    // And it has to fail AT THE TAG. Without the tag check the decode still
    // fails - but only by accident, because the arm it skipped leaves unread
    // trailing bytes at the end of the section, which is a length coincidence
    // and not a check: a payload whose arms happened to balance would decode
    // into a silently wrong world. Checked with the guard removed: the case
    // above passes either way, this line is the one that does not.
    INFO("error was: " << err2);
    CHECK(err2.find("truncated") != std::string::npos);
    CHECK(err2.find("trailing") == std::string::npos);
}

TEST_CASE("task 1c: the teams section round-trips every field") {
    const std::vector<TeamState> in = {loudTeam(), TeamState{}};
    std::vector<uint8_t> bytes;
    EncodeTeams(in, bytes);
    REQUIRE(bytes.size() > 4);

    std::vector<TeamState> out;
    std::string err;
    REQUIRE_MESSAGE(DecodeTeams(bytes.data(), bytes.size(), out, err), err);
    REQUIRE(out.size() == 2);
    CHECK(sameTeam(in[0], out[0]));
    CHECK(sameTeam(in[1], out[1]));

    // Re-encode symmetry: catches a field written but never read.
    std::vector<uint8_t> again;
    EncodeTeams(out, again);
    CHECK(again == bytes);
}

TEST_CASE("task 1c: the units section round-trips every field") {
    UnitState second = loudUnit();
    second.id = 999;
    second.unitDefName = "other";
    second.commands.clear();
    second.weapons.clear();
    second.transportees.clear();
    second.modParams.clear();

    const std::vector<UnitState> in = {loudUnit(), second, UnitState{}};
    std::vector<uint8_t> bytes;
    EncodeUnits(in, bytes);
    REQUIRE(bytes.size() > 4);

    std::vector<UnitState> out;
    std::string err;
    REQUIRE_MESSAGE(DecodeUnits(bytes.data(), bytes.size(), out, err), err);
    REQUIRE(out.size() == 3);
    for (size_t i = 0; i < in.size(); ++i) {
        INFO("unit index " << i);
        CHECK(sameUnit(in[i], out[i]));
    }

    std::vector<uint8_t> again;
    EncodeUnits(out, again);
    CHECK(again == bytes);
}

TEST_CASE("task 1c: a truncated section is a refusal at every cut point") {
    // §2's "never half-load". A short read must fail, not return the units it
    // managed to decode - a partial roster IS a corrupted world.
    std::vector<uint8_t> teamBytes;
    EncodeTeams({loudTeam(), loudTeam()}, teamBytes);
    std::vector<uint8_t> unitBytes;
    EncodeUnits({loudUnit(), loudUnit()}, unitBytes);

    for (size_t cut = 1; cut < teamBytes.size(); ++cut) {
        std::vector<TeamState> out;
        std::string err;
        INFO("teams cut at " << cut << " of " << teamBytes.size());
        CHECK_FALSE(DecodeTeams(teamBytes.data(), cut, out, err));
        CHECK(!err.empty());
    }
    for (size_t cut = 1; cut < unitBytes.size(); ++cut) {
        std::vector<UnitState> out;
        std::string err;
        INFO("units cut at " << cut << " of " << unitBytes.size());
        CHECK_FALSE(DecodeUnits(unitBytes.data(), cut, out, err));
        CHECK(!err.empty());
    }
}

TEST_CASE("task 1c: trailing bytes inside a section are a refusal") {
    // The one failure this framing exists to catch: writer and reader disagree
    // about the shape while the section version says they agree.
    std::vector<uint8_t> bytes;
    EncodeUnits({loudUnit()}, bytes);
    bytes.push_back(0x7f);

    std::vector<UnitState> out;
    std::string err;
    CHECK_FALSE(DecodeUnits(bytes.data(), bytes.size(), out, err));
    CHECK(err.find("trailing") != std::string::npos);

    std::vector<uint8_t> teamBytes;
    EncodeTeams({loudTeam()}, teamBytes);
    teamBytes.push_back(0);
    std::vector<TeamState> tout;
    CHECK_FALSE(DecodeTeams(teamBytes.data(), teamBytes.size(), tout, err));
    CHECK(err.find("trailing") != std::string::npos);
}

TEST_CASE("task 1c: an absurd count is refused before it is allocated") {
    // A corrupt length must be a decode failure, not a multi-gigabyte reserve.
    std::vector<uint8_t> bytes = {0xff, 0xff, 0xff, 0xff};
    std::vector<UnitState> units;
    std::vector<TeamState> teams;
    std::string err;
    CHECK_FALSE(DecodeUnits(bytes.data(), bytes.size(), units, err));
    CHECK_FALSE(DecodeTeams(bytes.data(), bytes.size(), teams, err));
    CHECK(units.empty());
    CHECK(teams.empty());
}

TEST_CASE("task 1c: an empty section is legal and stays empty") {
    // A game with no units yet (pre-GameStart, or every unit dead) must produce
    // a payload that restores to an empty roster rather than a refusal.
    std::vector<uint8_t> bytes;
    EncodeUnits({}, bytes);
    std::vector<UnitState> out;
    std::string err;
    REQUIRE_MESSAGE(DecodeUnits(bytes.data(), bytes.size(), out, err), err);
    CHECK(out.empty());
}

// ─────────── Q-P4: the activeUnits order is state, not presentation ───────────
//
// The payload is written in ascending-id order so two captures of the same world
// are byte-comparable. `CUnitHandler::activeUnits` is in *insertion* order, and
// `SlowUpdateUnits` walks it in a staggered slice — one 1/UNIT_SLOWUPDATE_RATE
// window per frame — so which slot a unit sits in decides which frame it is
// slow-updated on, and `CWeapon::SlowUpdate` draws from the synced RNG. Restoring
// in id order therefore moved every unit into a different slow-update frame and
// the resumed world drew a different number of times on its FIRST tick, with
// every unit byte-identical. Measured on meridian_basin at frame 60 over 20
// ticks: arm A 39 draws in two consecutive frames, arm B 63 scattered over nine.

namespace {

UnitState atIndex(int32_t id, uint32_t activeIndex)
{
    UnitState s;
    s.id = id;
    s.activeIndex = activeIndex;
    return s;
}

std::vector<int32_t> orderOf(const std::vector<UnitState>& in)
{
    return RestoredActiveOrder(in);
}

} // namespace

TEST_CASE("Q-P4: the restore order is the captured activeUnits order, not id order") {
    // Exactly the shape the live capture has: ids ascending in the payload,
    // insertion order a different permutation entirely.
    const std::vector<UnitState> in = {
        atIndex(503, 4), atIndex(852, 0), atIndex(872, 3),
        atIndex(965, 1), atIndex(1070, 2),
    };
    CHECK(orderOf(in) == std::vector<int32_t>{852, 965, 1070, 872, 503});
}

TEST_CASE("Q-P4: an index collision still yields one order, not an unstable one") {
    // std::sort is not stable, so an activeIndex that is not a clean permutation
    // — an older payload that carried none, a hand-built fixture, a partial
    // roster — would otherwise let two restores of the SAME bytes disagree, and
    // then capturing the order buys nothing. The id is the tie-break.
    const std::vector<UnitState> allZero = {
        atIndex(30, 0), atIndex(10, 0), atIndex(20, 0),
    };
    CHECK(orderOf(allZero) == std::vector<int32_t>{10, 20, 30});

    const std::vector<UnitState> partial = {
        atIndex(30, 0), atIndex(10, 7), atIndex(20, 0), atIndex(40, 7),
    };
    CHECK(orderOf(partial) == std::vector<int32_t>{20, 30, 10, 40});
}

TEST_CASE("Q-P4: an empty roster orders to nothing rather than misbehaving") {
    CHECK(orderOf({}).empty());
}

TEST_CASE("Q-P4: the slow-update cursor is clamped to the restored roster") {
    // The cursor is a raw index into activeUnits and SlowUpdateUnits computes
    // `activeUnits.size() - idxBeg`; a payload from a bigger world would
    // underflow that size_t and slow-update the whole vector in one frame.
    const size_t was = unitHandler.GetActiveSlowUpdateUnit();
    unitHandler.SetActiveSlowUpdateUnit(999999);
    CHECK(unitHandler.GetActiveSlowUpdateUnit() <= unitHandler.GetActiveUnits().size());
    unitHandler.SetActiveSlowUpdateUnit(was);
}

// ─────────────── Task 1e: the features section (§7.1e) ───────────────

namespace {

/// Every field of FeatureState set to a distinct non-default value, same
/// discipline as loudUnit(): a writer/reader pair that swaps two fields of the
/// same type is only visible if no two fields share a value.
FeatureState loudFeature()
{
    FeatureState f;
    f.id = 201;
    f.featureDefName = "loud-featureDefName";
    f.resurrectUnitDefName = "loud-resurrectUnitDefName";
    f.team = 204;
    f.heading = 205;
    f.buildFacing = 206;

    f.posX = 207.5f; f.posY = 208.5f; f.posZ = 209.5f;
    f.speedX = 210.5f; f.speedY = 211.5f; f.speedZ = 212.5f;
    f.frontX = 213.5f; f.frontY = 214.5f; f.frontZ = 215.5f;
    f.rightX = 216.5f; f.rightY = 217.5f; f.rightZ = 218.5f;
    f.upX = 219.5f; f.upY = 220.5f; f.upZ = 221.5f;
    f.collidableState = 222;

    f.radius = 223.5f; f.height = 224.5f;
    f.relMidX = 225.5f; f.relMidY = 226.5f; f.relMidZ = 227.5f;
    f.relAimX = 228.5f; f.relAimY = 229.5f; f.relAimZ = 230.5f;

    f.health = 231.5f; f.maxHealth = 232.5f; f.mass = 233.5f;
    f.reclaimTime = 234.5f; f.reclaimLeft = 235.5f; f.resurrectProgress = 236.5f;
    f.isRepairingBeforeResurrect = true;
    f.lastReclaimFrame = 238; f.fireTime = 239; f.smokeTime = 240;
    f.defResources = resPair(241.25f, 241.75f);
    f.resources = resPair(242.25f, 242.75f);

    f.moveCtrlEnabled = true;
    f.movementMaskX = 244.5f; f.movementMaskY = 245.5f; f.movementMaskZ = 246.5f;
    f.velocityMaskX = 247.5f; f.velocityMaskY = 248.5f; f.velocityMaskZ = 249.5f;
    f.impulseMaskX = 250.5f; f.impulseMaskY = 251.5f; f.impulseMaskZ = 252.5f;
    f.velVectorX = 253.5f; f.velVectorY = 254.5f; f.velVectorZ = 255.5f;
    f.accVectorX = 256.5f; f.accVectorY = 257.5f; f.accVectorZ = 258.5f;

    // The three blocking flags carry the OPPOSITE of their defaults, so a
    // reader that never writes them is a difference rather than a match.
    f.crushable = true;
    f.blockEnemyPushing = false;
    f.blockHeightChanges = true;
    f.noSelect = true;
    f.alwaysVisible = true;
    f.useAirLos = true;

    f.modParams = loudRulesParams();
    return f;
}

bool sameFeature(const FeatureState& a, const FeatureState& b)
{
    return a.id == b.id
        && a.featureDefName == b.featureDefName
        && a.resurrectUnitDefName == b.resurrectUnitDefName
        && a.team == b.team
        && a.heading == b.heading
        && a.buildFacing == b.buildFacing
        && a.posX == b.posX && a.posY == b.posY && a.posZ == b.posZ
        && a.speedX == b.speedX && a.speedY == b.speedY && a.speedZ == b.speedZ
        && a.frontX == b.frontX && a.frontY == b.frontY && a.frontZ == b.frontZ
        && a.rightX == b.rightX && a.rightY == b.rightY && a.rightZ == b.rightZ
        && a.upX == b.upX && a.upY == b.upY && a.upZ == b.upZ
        && a.collidableState == b.collidableState
        && a.radius == b.radius && a.height == b.height
        && a.relMidX == b.relMidX && a.relMidY == b.relMidY && a.relMidZ == b.relMidZ
        && a.relAimX == b.relAimX && a.relAimY == b.relAimY && a.relAimZ == b.relAimZ
        && a.health == b.health && a.maxHealth == b.maxHealth && a.mass == b.mass
        && a.reclaimTime == b.reclaimTime
        && a.reclaimLeft == b.reclaimLeft
        && a.resurrectProgress == b.resurrectProgress
        && a.isRepairingBeforeResurrect == b.isRepairingBeforeResurrect
        && a.lastReclaimFrame == b.lastReclaimFrame
        && a.fireTime == b.fireTime
        && a.smokeTime == b.smokeTime
        && a.defResources.metal == b.defResources.metal
        && a.defResources.energy == b.defResources.energy
        && a.resources.metal == b.resources.metal
        && a.resources.energy == b.resources.energy
        && a.moveCtrlEnabled == b.moveCtrlEnabled
        && a.movementMaskX == b.movementMaskX
        && a.movementMaskY == b.movementMaskY
        && a.movementMaskZ == b.movementMaskZ
        && a.velocityMaskX == b.velocityMaskX
        && a.velocityMaskY == b.velocityMaskY
        && a.velocityMaskZ == b.velocityMaskZ
        && a.impulseMaskX == b.impulseMaskX
        && a.impulseMaskY == b.impulseMaskY
        && a.impulseMaskZ == b.impulseMaskZ
        && a.velVectorX == b.velVectorX
        && a.velVectorY == b.velVectorY
        && a.velVectorZ == b.velVectorZ
        && a.accVectorX == b.accVectorX
        && a.accVectorY == b.accVectorY
        && a.accVectorZ == b.accVectorZ
        && a.crushable == b.crushable
        && a.blockEnemyPushing == b.blockEnemyPushing
        && a.blockHeightChanges == b.blockHeightChanges
        && a.noSelect == b.noSelect
        && a.alwaysVisible == b.alwaysVisible
        && a.useAirLos == b.useAirLos
        && sameRulesParams(a.modParams, b.modParams)
        ;
}

} // namespace

TEST_CASE("task 1e: the feature census is armed") {
    // Same contract as 1b's and 1c's: adding a member to FeatureState without
    // naming it in the structured binding fails the BUILD, and naming it there
    // without writing it fails HERE.
    CHECK(census::Feature(FeatureState{}) == 65);
}

TEST_CASE("task 1e: the features section round-trips every field") {
    FeatureState second = loudFeature();
    second.id = 777;
    second.featureDefName = "other-wreck";
    // A feature that resurrects into nothing is the common case (a tree, a
    // rock): the empty string has to survive as an empty string rather than
    // becoming a def lookup for "".
    second.resurrectUnitDefName = "";
    second.modParams.clear();

    const std::vector<FeatureState> in = {loudFeature(), second, FeatureState{}};
    std::vector<uint8_t> bytes;
    EncodeFeatures(in, bytes);
    REQUIRE(bytes.size() > 4);

    std::vector<FeatureState> out;
    std::string err;
    REQUIRE_MESSAGE(DecodeFeatures(bytes.data(), bytes.size(), out, err), err);
    REQUIRE(out.size() == 3);
    for (size_t i = 0; i < in.size(); ++i) {
        INFO("feature index " << i);
        CHECK(sameFeature(in[i], out[i]));
    }
    CHECK(out[1].resurrectUnitDefName.empty());

    // Re-encode symmetry: catches a field written but never read.
    std::vector<uint8_t> again;
    EncodeFeatures(out, again);
    CHECK(again == bytes);
}

TEST_CASE("task 1e: a truncated features section is a refusal at every cut point") {
    // Every byte, not every seventh: 1c's Finding 3 was two interior cut points
    // out of ~250 that decoded as SUCCESS, and a sampling sweep missed both.
    std::vector<uint8_t> bytes;
    EncodeFeatures({loudFeature(), loudFeature()}, bytes);
    for (size_t cut = 1; cut < bytes.size(); ++cut) {
        std::vector<FeatureState> out;
        std::string err;
        INFO("features cut at " << cut << " of " << bytes.size());
        CHECK_FALSE(DecodeFeatures(bytes.data(), cut, out, err));
        CHECK(!err.empty());
    }
}

TEST_CASE("task 1e: trailing bytes inside the features section are a refusal") {
    std::vector<uint8_t> bytes;
    EncodeFeatures({loudFeature()}, bytes);
    bytes.push_back(0x5a);

    std::vector<FeatureState> out;
    std::string err;
    CHECK_FALSE(DecodeFeatures(bytes.data(), bytes.size(), out, err));
    CHECK(err.find("trailing") != std::string::npos);
}

TEST_CASE("task 1e: an absurd feature count is refused before it is allocated") {
    std::vector<uint8_t> bytes = {0xff, 0xff, 0xff, 0xff};
    std::vector<FeatureState> out;
    std::string err;
    CHECK_FALSE(DecodeFeatures(bytes.data(), bytes.size(), out, err));
    CHECK(out.empty());
}

TEST_CASE("task 1e: an empty features section is legal and stays empty") {
    // A map with no features and no wrecks yet must restore to an empty set
    // rather than refuse.
    std::vector<uint8_t> bytes;
    EncodeFeatures({}, bytes);
    std::vector<FeatureState> out;
    std::string err;
    REQUIRE_MESSAGE(DecodeFeatures(bytes.data(), bytes.size(), out, err), err);
    CHECK(out.empty());
}

// ───────────────── task 1d-b: the gameRules section ─────────────────
//
// The section exists because of what task 1d-b found while writing the nine
// gadgets' Save/Load: EVERY other rulesParam family hangs off an object the
// walk already visits (team->modParams, u->modParams, f->modParams), and game
// rules params hang off a process-wide static on CSplitLuaHandle. They were the
// one family no section reached, and MissingSections() could not say so — the
// same shape as 1c's Finding 2, a section nobody had thought of.

namespace {

std::vector<RulesParamState> loudGameRules()
{
    // One of each discriminator, plus the two shapes that have bitten this
    // codec before: an empty string value (must survive as empty, not as a
    // missing key) and a non-default los mask.
    RulesParamState b;
    b.key = "war_can_end"; b.los = 0; b.type = 0; b.b = true;
    RulesParamState f;
    f.key = "regions_rev"; f.los = 1; f.type = 1; f.f = 4207.5f;
    RulesParamState s;
    s.key = "objective_12_type"; s.los = 3; s.type = 2; s.s = "control";
    RulesParamState empty;
    empty.key = "scenario_name"; empty.los = 3; empty.type = 2; empty.s = "";
    return {b, f, s, empty};
}

bool sameParam(const RulesParamState& a, const RulesParamState& b)
{
    return a.key == b.key && a.los == b.los && a.type == b.type &&
           a.b == b.b && a.f == b.f && a.s == b.s;
}

} // namespace

TEST_CASE("task 1d-b: the gameRules section round-trips every field") {
    const std::vector<RulesParamState> in = loudGameRules();
    std::vector<uint8_t> bytes;
    EncodeGameRules(in, bytes);
    REQUIRE(bytes.size() > 4);

    std::vector<RulesParamState> out;
    std::string err;
    REQUIRE_MESSAGE(DecodeGameRules(bytes.data(), bytes.size(), out, err), err);
    REQUIRE(out.size() == in.size());
    for (size_t i = 0; i < in.size(); ++i) {
        INFO("param index " << i << " (" << in[i].key << ")");
        CHECK(sameParam(in[i], out[i]));
    }
    CHECK(out[3].s.empty());

    // Re-encode symmetry: catches a field written but never read.
    std::vector<uint8_t> again;
    EncodeGameRules(out, again);
    CHECK(again == bytes);
}

TEST_CASE("task 1d-b: a truncated gameRules section is a refusal at every cut point") {
    // Every byte, not every seventh — 1c's Finding 3.
    std::vector<uint8_t> bytes;
    EncodeGameRules(loudGameRules(), bytes);
    for (size_t cut = 1; cut < bytes.size(); ++cut) {
        std::vector<RulesParamState> out;
        std::string err;
        INFO("gameRules cut at " << cut << " of " << bytes.size());
        CHECK_FALSE(DecodeGameRules(bytes.data(), cut, out, err));
        CHECK(!err.empty());
    }
}

TEST_CASE("task 1d-b: trailing bytes inside the gameRules section are a refusal") {
    std::vector<uint8_t> bytes;
    EncodeGameRules(loudGameRules(), bytes);
    bytes.push_back(0x5a);

    std::vector<RulesParamState> out;
    std::string err;
    CHECK_FALSE(DecodeGameRules(bytes.data(), bytes.size(), out, err));
    CHECK(err.find("trailing") != std::string::npos);
}

TEST_CASE("task 1d-b: an absurd gameRules count is refused before it is allocated") {
    std::vector<uint8_t> bytes = {0xff, 0xff, 0xff, 0xff};
    std::vector<RulesParamState> out;
    std::string err;
    CHECK_FALSE(DecodeGameRules(bytes.data(), bytes.size(), out, err));
    CHECK(out.empty());
}

TEST_CASE("task 1d-b: an empty gameRules section is legal and stays empty") {
    // A war whose gadgets have published nothing yet (pre-GameStart) must
    // restore to an empty map rather than refuse.
    std::vector<uint8_t> bytes;
    EncodeGameRules({}, bytes);
    std::vector<RulesParamState> out;
    std::string err;
    REQUIRE_MESSAGE(DecodeGameRules(bytes.data(), bytes.size(), out, err), err);
    CHECK(out.empty());
}

TEST_CASE("task 1d-b: capture is sorted, and apply REPLACES rather than merges") {
    // The property the whole section exists for. A gadget's Load could
    // republish its own keys, but only the ones it still owns — an objective
    // created after the captured frame would leave `objective_<id>_*` behind
    // forever. Apply has to be a replacement.
    //
    // gameParams is a static on CSplitLuaHandle, so this is exercisable
    // in-process: no sim, no gadget handler, no Lua state needed.
    LuaRulesParams::Params live;
    live["zulu"].value  = std::string("last-alphabetically");
    live["alpha"].value = 1.0f;
    live["mike"].value  = true;
    CSplitLuaHandle::SetGameParams(live);

    std::vector<RulesParamState> captured;
    CaptureGameRules(captured);
    REQUIRE(captured.size() == 3);
    // Sorted by key: an unordered_map's iteration order is not a property the
    // payload may depend on, or two captures of the SAME state differ.
    CHECK(captured[0].key == "alpha");
    CHECK(captured[1].key == "mike");
    CHECK(captured[2].key == "zulu");

    std::vector<uint8_t> bytes;
    EncodeGameRules(captured, bytes);
    std::vector<RulesParamState> reCaptured;
    CaptureGameRules(reCaptured);
    std::vector<uint8_t> again;
    EncodeGameRules(reCaptured, again);
    CHECK(again == bytes);

    // Now the world moves on: a key is added and one is changed, exactly as a
    // gadget publishing past the captured frame would do.
    LuaRulesParams::Params later = live;
    later["objective_99_state"].value = std::string("complete");
    later["alpha"].value = 2.0f;
    CSplitLuaHandle::SetGameParams(later);
    REQUIRE(CSplitLuaHandle::GetGameParams().size() == 4);

    ApplyGameRules(captured);
    const auto& after = CSplitLuaHandle::GetGameParams();
    // The key written after the capture is GONE — a merge would have kept it,
    // and a client would still be reading a resolved objective's params.
    CHECK(after.size() == 3);
    CHECK(after.find("objective_99_state") == after.end());
    const auto alphaIt = after.find("alpha");
    REQUIRE(alphaIt != after.end());
    CHECK(std::get<float>(alphaIt->second.value) == doctest::Approx(1.0f));

    CSplitLuaHandle::ClearGameParams();
}

// ── The payload navigators (PLAN-persistence §8) ──
//
// The round-trip harness reports where two payloads disagree. Reporting "byte
// 51 234" is unactionable; reporting "section 'units'" names an owner. These
// two functions are what turn one into the other, and both run on payloads
// that are already known to be odd — so they are written to give up with a
// description rather than to read past the end.

namespace {

// A payload in the on-the-wire shape: u16 version, u32 section count, then
// per section u16 id, u16 version, u32 length, body.
std::vector<uint8_t> framePayload(
    const std::vector<std::pair<uint16_t, std::vector<uint8_t>>>& sections)
{
    std::vector<uint8_t> out;
    auto u16 = [&out](uint16_t v) { out.push_back(uint8_t(v)); out.push_back(uint8_t(v >> 8)); };
    auto u32 = [&out](uint32_t v) {
        for (int i = 0; i < 4; ++i) out.push_back(uint8_t(v >> (8 * i)));
    };
    u16(1);
    u32(static_cast<uint32_t>(sections.size()));
    for (const auto& [id, body] : sections) {
        u16(id);
        u16(1);
        u32(static_cast<uint32_t>(body.size()));
        out.insert(out.end(), body.begin(), body.end());
    }
    return out;
}

}  // namespace

TEST_CASE("DescribeOffset: names the section a byte offset falls in") {
    // globals (id 1) with a 21-byte body, then units (id 6) with 10.
    const auto p = framePayload({{1, std::vector<uint8_t>(21, 0)},
                                 {6, std::vector<uint8_t>(10, 0)}});

    CHECK(DescribeOffset(p.data(), p.size(), 0).find("envelope") != std::string::npos);
    // 6 envelope + 8 section header = 14: the first body byte of `globals`.
    const std::string g = DescribeOffset(p.data(), p.size(), 14 + 4);
    CHECK(g.find("globals") != std::string::npos);
    CHECK(g.find("byte 4 of 21") != std::string::npos);
    // The second section's header, then its body.
    CHECK(DescribeOffset(p.data(), p.size(), 14 + 21).find("header of section id 6")
          != std::string::npos);
    CHECK(DescribeOffset(p.data(), p.size(), 14 + 21 + 8 + 3).find("units")
          != std::string::npos);
    // Past the end is described, not read.
    CHECK(DescribeOffset(p.data(), p.size(), p.size() + 100).find("past the end")
          != std::string::npos);
    CHECK(DescribeOffset(nullptr, 0, 0).find("past the end") != std::string::npos);
}

TEST_CASE("DescribeOffset: a corrupt section length terminates the walk") {
    // A length field that runs off the end must not loop or read out of
    // bounds — this function's whole job is to survive a payload the decoder
    // already refused.
    auto p = framePayload({{1, std::vector<uint8_t>(8, 0)}});
    p[6 + 4] = 0xFF; p[6 + 5] = 0xFF; p[6 + 6] = 0xFF; p[6 + 7] = 0x7F;
    const std::string d = DescribeOffset(p.data(), p.size(), p.size() - 1);
    CHECK_FALSE(d.empty());
}

TEST_CASE("DiffSections: names every section that disagrees, not just the first") {
    // The difference that matters to an investigation: "only globals" means
    // the two worlds are identical and only the RNG's position moved; "units
    // too" is a different bug entirely.
    const auto a = framePayload({{1, std::vector<uint8_t>(21, 0)},
                                 {5, std::vector<uint8_t>(30, 7)},
                                 {6, std::vector<uint8_t>(10, 3)}});

    SUBCASE("identical payloads disagree nowhere") {
        CHECK(DiffSections(a, a).empty());
    }
    SUBCASE("one differing byte in two sections names both") {
        auto b = a;
        b[14 + 4] = 9;                  // inside globals
        b[14 + 21 + 8 + 2] = 9;         // inside teams
        const auto d = DiffSections(a, b);
        REQUIRE(d.size() == 2);
        CHECK(d[0] == "globals");
        CHECK(d[1] == "teams");
    }
    SUBCASE("a section of a different length counts as disagreeing") {
        const auto b = framePayload({{1, std::vector<uint8_t>(21, 0)},
                                     {5, std::vector<uint8_t>(31, 7)},
                                     {6, std::vector<uint8_t>(10, 3)}});
        const auto d = DiffSections(a, b);
        REQUIRE(d.size() == 1);
        CHECK(d[0] == "teams");
    }
    SUBCASE("a section present on one side only is named as such") {
        const auto b = framePayload({{1, std::vector<uint8_t>(21, 0)},
                                     {6, std::vector<uint8_t>(10, 3)}});
        const auto d = DiffSections(a, b);
        REQUIRE(d.size() == 1);
        CHECK(d[0].find("teams") == 0);
        CHECK(d[0].find("absent") != std::string::npos);
    }
}

// ───────── CompareUnits (PLAN-persistence Q-P2, option D's metric) ─────────
//
// The round-trip harness's default bar is no longer "the two continuations are
// byte-identical" — §7.1c re-derives movement, so they are not — it is "the
// same units came out with the same outcomes", and the movement drift is
// MEASURED. These cases pin the measurement, because the bar is only as honest
// as the numbers it reads: a roster difference counted by SIZE rather than by
// id would miss two rosters that each hold one unit the other does not, and a
// heading delta that does not wrap would report one step as most of a circle.

namespace {

std::vector<uint8_t> unitsPayload(const std::vector<UnitState>& units)
{
    std::vector<uint8_t> body;
    EncodeUnits(units, body);
    return framePayload({{6, body}});
}

UnitState quietUnit(int32_t id)
{
    UnitState s;
    s.id = id;
    s.unitDefName = "ms_tank";
    s.team = 0;
    s.health = 100.0f;
    s.maxHealth = 100.0f;
    return s;
}

}  // namespace

TEST_CASE("CompareUnits: identical rosters measure zero of everything") {
    const auto p = unitsPayload({quietUnit(1), quietUnit(2), quietUnit(3)});
    const UnitsDivergence d = CompareUnits(p, p);
    CHECK(d.measured);
    CHECK(d.unitsA == 3);
    CHECK(d.unitsB == 3);
    CHECK(d.transform == 0);
    CHECK(d.vitals == 0);
    CHECK(d.onlyA == 0);
    CHECK(d.onlyB == 0);
    CHECK(d.maxPosDelta == doctest::Approx(0.0));
    CHECK(d.maxHeadingDelta == doctest::Approx(0.0));
    CHECK(d.first.empty());
}

TEST_CASE("CompareUnits: a moved unit is a transform difference with a magnitude") {
    std::vector<UnitState> a = {quietUnit(1), quietUnit(2)};
    std::vector<UnitState> b = a;
    b[1].posX = 3.0f;
    b[1].posZ = 4.0f;          // 3-4-5 triangle: exactly 5 elmos
    const UnitsDivergence d = CompareUnits(unitsPayload(a), unitsPayload(b));
    CHECK(d.transform == 1);
    CHECK(d.vitals == 0);
    CHECK(d.maxPosDelta == doctest::Approx(5.0));
    CHECK(d.maxPosDeltaUnitId == 2);
    CHECK(d.first.find("unit 2") != std::string::npos);
}

TEST_CASE("CompareUnits: damage is a vitals difference, not a transform one") {
    // The distinction the bar rests on: a resumed world may re-derive where a
    // unit walked, never who shot it.
    std::vector<UnitState> a = {quietUnit(1)};
    std::vector<UnitState> b = a;
    b[0].health = 40.0f;
    const UnitsDivergence d = CompareUnits(unitsPayload(a), unitsPayload(b));
    CHECK(d.transform == 0);
    CHECK(d.vitals == 1);
    CHECK(d.maxPosDelta == doctest::Approx(0.0));
}

TEST_CASE("CompareUnits: roster differences are counted by id, not by size") {
    // Two rosters of the SAME size, each holding one unit the other does not.
    // Counting "B has more than A" would report both sides clean.
    const auto a = unitsPayload({quietUnit(1), quietUnit(2)});
    const auto b = unitsPayload({quietUnit(1), quietUnit(3)});
    const UnitsDivergence d = CompareUnits(a, b);
    CHECK(d.unitsA == 2);
    CHECK(d.unitsB == 2);
    CHECK(d.onlyA == 1);
    CHECK(d.onlyB == 1);
}

TEST_CASE("CompareUnits: heading deltas take the short way round the circle") {
    std::vector<UnitState> a = {quietUnit(1)};
    a[0].heading = 32767;
    std::vector<UnitState> b = a;
    b[0].heading = -32768;     // one step further, not 359 degrees back
    const UnitsDivergence d = CompareUnits(unitsPayload(a), unitsPayload(b));
    CHECK(d.transform == 1);
    CHECK(d.maxHeadingDelta == doctest::Approx(360.0 / 65536.0));

    std::vector<UnitState> c = a;
    c[0].heading = 0;          // a quarter turn from 16384
    std::vector<UnitState> e = a;
    e[0].heading = 16384;
    CHECK(CompareUnits(unitsPayload(c), unitsPayload(e)).maxHeadingDelta ==
          doctest::Approx(90.0));
}

TEST_CASE("CompareUnits: a payload with no units section is NOT MEASURED") {
    // "Could not compare" must be distinguishable from "compared and agreed" —
    // the harness fails on the former.
    const auto good = unitsPayload({quietUnit(1)});
    const auto empty = framePayload({{1, std::vector<uint8_t>(21, 0)}});
    CHECK_FALSE(CompareUnits(good, empty).measured);
    CHECK_FALSE(CompareUnits(empty, good).measured);
    CHECK(DescribeUnitsDivergence(good, empty).find("could not be decoded") !=
          std::string::npos);
}

// ───────── DescribeRulesParamsDivergence (the static fixture's diagnosis) ─────────
//
// On `roundtrip_static` there are no moving units to blame, so a strict
// round-trip failure lands in the gadgets' own state — and "the gameRules
// section differs" over ~80 keys is not a diagnosis. These cover the three
// shapes a rules-params disagreement comes in, because they route to different
// investigations: a changed VALUE is a gadget that computed something else, a
// key present on one side only is a gadget that published (or lost) an entry.

namespace {

std::vector<uint8_t> gameRulesPayload(const std::vector<RulesParamState>& p)
{
    std::vector<uint8_t> body;
    EncodeGameRules(p, body);
    return framePayload({{static_cast<uint16_t>(SectionId::GameRules), body}});
}

RulesParamState numParam(const std::string& key, float v)
{
    RulesParamState p;
    p.key = key; p.los = 0; p.type = 1; p.f = v;
    return p;
}

}  // namespace

TEST_CASE("DescribeRulesParamsDivergence: identical param maps disagree in nothing") {
    const auto p = gameRulesPayload({numParam("warlog_seq", 3.0f)});
    const std::string d = DescribeRulesParamsDivergence(p, p, SectionId::GameRules);
    CHECK(d.find("1 vs 1 params") != std::string::npos);
    CHECK(d.find("0 differ in value") != std::string::npos);
    CHECK(d.find("0 only in arm A") != std::string::npos);
    CHECK(d.find("0 only in arm B") != std::string::npos);
}

TEST_CASE("DescribeRulesParamsDivergence: names the key and both values") {
    const auto a = gameRulesPayload({numParam("warlog_seq", 3.0f)});
    const auto b = gameRulesPayload({numParam("warlog_seq", 5.0f)});
    const std::string d = DescribeRulesParamsDivergence(a, b, SectionId::GameRules);
    CHECK(d.find("1 differ in value") != std::string::npos);
    CHECK(d.find("warlog_seq") != std::string::npos);
    CHECK(d.find("3.000000 vs 5.000000") != std::string::npos);
}

TEST_CASE("DescribeRulesParamsDivergence: a key is matched by NAME, not by position") {
    // The live finding this exists for: after a restore the same entries came
    // back under a differently spelled key (`warlog_1_kind` published as
    // `warlog_1.0_kind`), so the two maps held the same information and
    // disagreed on every row. Position-keyed, that reads as "everything
    // changed"; name-keyed, it reads as what it is — a key one side does not
    // have. The two maps here are also different SIZES, which a comparison
    // that walked them in step would run off the end of.
    const auto a = gameRulesPayload({numParam("warlog_1_kind", 1.0f),
                                     numParam("warlog_seq", 2.0f)});
    const auto b = gameRulesPayload({numParam("warlog_1.0_kind", 1.0f),
                                     numParam("warlog_seq", 2.0f),
                                     numParam("objective_3.0_state", 1.0f)});
    const std::string d = DescribeRulesParamsDivergence(a, b, SectionId::GameRules);
    CHECK(d.find("2 vs 3 params") != std::string::npos);
    CHECK(d.find("0 differ in value") != std::string::npos);
    CHECK(d.find("1 only in arm A") != std::string::npos);
    CHECK(d.find("2 only in arm B") != std::string::npos);
    CHECK(d.find("only A: warlog_1_kind") != std::string::npos);
    CHECK(d.find("objective_3.0_state") != std::string::npos);
}

TEST_CASE("DescribeRulesParamsDivergence: an undecodable side describes nothing") {
    // Same rule as CompareUnits: "could not compare" must never be spelled the
    // same way as "compared and agreed", so the caller can stay silent instead
    // of printing a clean bill of health for a section it never read.
    const auto good = gameRulesPayload({numParam("warlog_seq", 1.0f)});
    const auto none = framePayload({{1, std::vector<uint8_t>(21, 0)}});
    CHECK(DescribeRulesParamsDivergence(good, none, SectionId::GameRules).empty());
    CHECK(DescribeRulesParamsDivergence(none, good, SectionId::GameRules).empty());
}

// ───────────── The wind (EnvResourceHandler, the envResources section) ─────────────
//
// Wind is synced state on a 450-frame cycle: the frame where windDirTimer == 0
// draws two floats from the synced RNG, the other 449 blend towards what it
// drew. No section carried any of it, so a restore started the cycle at phase 0
// and drew its next pair on a different frame than the captured world would
// have. It never showed in a round-trip measurement because a 20- or 100-tick
// window does not contain a wind update at all.

namespace {

/// Every field distinct, same discipline as loudUnit(): a writer/reader pair
/// that swaps two fields of the same type is only visible if no two fields
/// share a value.
envressnapshot::EnvResourceState loudWind()
{
    envressnapshot::EnvResourceState e;
    e.curTidalStrength = 1.5f;
    e.curWindStrength = 2.5f;
    e.minWindStrength = 3.5f;
    e.maxWindStrength = 4.5f;

    e.curWindDirX = 5.5f;  e.curWindDirY = 6.5f;  e.curWindDirZ = 7.5f;
    e.curWindVecX = 8.5f;  e.curWindVecY = 9.5f;  e.curWindVecZ = 10.5f;
    e.newWindVecX = 11.5f; e.newWindVecY = 12.5f; e.newWindVecZ = 13.5f;
    e.oldWindVecX = 14.5f; e.oldWindVecY = 15.5f; e.oldWindVecZ = 16.5f;

    e.windDirTimer = 317;
    e.allGeneratorIDs = {41, 42, 43};
    e.newGeneratorIDs = {44};
    return e;
}

std::vector<uint8_t> windBytes(const envressnapshot::EnvResourceState& e)
{
    std::vector<uint8_t> out;
    EncodeEnvResources(e, out);
    return out;
}

} // namespace

TEST_CASE("the wind: the envResources section round-trips every field") {
    const auto in = loudWind();
    const auto bytes = windBytes(in);

    envressnapshot::EnvResourceState out;
    std::string err;
    REQUIRE(DecodeEnvResources(bytes.data(), bytes.size(), out, err));
    CHECK(err.empty());

    CHECK(out.curTidalStrength == in.curTidalStrength);
    CHECK(out.curWindStrength == in.curWindStrength);
    CHECK(out.minWindStrength == in.minWindStrength);
    CHECK(out.maxWindStrength == in.maxWindStrength);
    CHECK(out.curWindDirX == in.curWindDirX);
    CHECK(out.curWindDirY == in.curWindDirY);
    CHECK(out.curWindDirZ == in.curWindDirZ);
    CHECK(out.curWindVecX == in.curWindVecX);
    CHECK(out.curWindVecY == in.curWindVecY);
    CHECK(out.curWindVecZ == in.curWindVecZ);
    CHECK(out.newWindVecX == in.newWindVecX);
    CHECK(out.newWindVecY == in.newWindVecY);
    CHECK(out.newWindVecZ == in.newWindVecZ);
    CHECK(out.oldWindVecX == in.oldWindVecX);
    CHECK(out.oldWindVecY == in.oldWindVecY);
    CHECK(out.oldWindVecZ == in.oldWindVecZ);
    CHECK(out.windDirTimer == in.windDirTimer);
    // The lists keep their ORDER, not just their membership: the order
    // allGeneratorIDs is walked in is the order UpdateWind() is called in.
    CHECK(out.allGeneratorIDs == in.allGeneratorIDs);
    CHECK(out.newGeneratorIDs == in.newGeneratorIDs);
    // And the two lists stay distinct — the whole point of capturing both.
    CHECK(out.allGeneratorIDs.size() == 3);
    CHECK(out.newGeneratorIDs.size() == 1);
}

TEST_CASE("the wind: a truncated envResources section is a refusal at every cut point") {
    const auto full = windBytes(loudWind());
    for (size_t cut = 0; cut < full.size(); ++cut) {
        envressnapshot::EnvResourceState out;
        std::string err;
        CHECK_FALSE(DecodeEnvResources(full.data(), cut, out, err));
        CHECK_FALSE(err.empty());
    }
}

TEST_CASE("the wind: trailing bytes inside the envResources section are a refusal") {
    // The one failure the framing exists to catch: writer and reader disagree
    // about the shape while the version says they agree.
    auto bytes = windBytes(loudWind());
    bytes.push_back(0);
    envressnapshot::EnvResourceState out;
    std::string err;
    CHECK_FALSE(DecodeEnvResources(bytes.data(), bytes.size(), out, err));
    CHECK(err.find("trailing") != std::string::npos);
}

TEST_CASE("the wind: an absurd generator count is refused before it is allocated") {
    auto bytes = windBytes(loudWind());
    // The allGeneratorIDs count sits straight after 16 floats and the timer.
    const size_t countAt = 17 * 4;
    REQUIRE(bytes.size() > countAt + 4);
    for (int i = 0; i < 4; ++i) bytes[countAt + i] = 0xFF;

    envressnapshot::EnvResourceState out;
    std::string err;
    CHECK_FALSE(DecodeEnvResources(bytes.data(), bytes.size(), out, err));
    CHECK(err.find("generator ids") != std::string::npos);
}

TEST_CASE("the wind: an empty world's wind still round-trips") {
    const envressnapshot::EnvResourceState in;   // no generators, timer 0
    const auto bytes = windBytes(in);
    envressnapshot::EnvResourceState out;
    std::string err;
    REQUIRE(DecodeEnvResources(bytes.data(), bytes.size(), out, err));
    CHECK(out.allGeneratorIDs.empty());
    CHECK(out.newGeneratorIDs.empty());
    CHECK(out.windDirTimer == 0);
}

TEST_CASE("the wind: a captured generator with no unit in the restored roster is dropped") {
    // Update() calls unitHandler.GetUnit(id)->UpdateWind() with NO null check,
    // so a captured id the restored world does not carry is a crash up to 450
    // frames after the restore, not a drift.
    envressnapshot::EnvResourceState s;
    s.allGeneratorIDs = {7, 8};
    s.newGeneratorIDs = {9, -1};

    const auto only8 = envressnapshot::RestoreGenerators(s, [](int id) { return id == 8; });
    CHECK(only8.allGeneratorIDs == std::vector<int>{8});
    CHECK(only8.newGeneratorIDs.empty());
    CHECK(only8.dropped == 3);   // 7, 9 and the negative id

    const auto all = envressnapshot::RestoreGenerators(s, [](int id) { return id >= 0; });
    CHECK(all.allGeneratorIDs == std::vector<int>{7, 8});
    CHECK(all.newGeneratorIDs == std::vector<int>{9});
    CHECK(all.dropped == 1);     // the negative id is never a unit
}

TEST_CASE("the wind: an id in both captured lists is kept once, in the first") {
    // DelGenerator relies on "id is never present in both", and a duplicate
    // would be pushed into allGeneratorIDs again on every wind update — an
    // unbounded list — as well as telling one unit's script the wind changed
    // twice per cycle.
    envressnapshot::EnvResourceState s;
    s.allGeneratorIDs = {5, 6};
    s.newGeneratorIDs = {6, 7};

    const auto r = envressnapshot::RestoreGenerators(s, [](int) { return true; });
    CHECK(r.allGeneratorIDs == std::vector<int>{5, 6});
    CHECK(r.newGeneratorIDs == std::vector<int>{7});
    CHECK(r.dropped == 0);       // a de-duplicated id is not a dropped one
}

TEST_CASE("the wind: apply then capture is the identity, and the phase is clamped") {
    // The live handler, so this covers the capture/apply PAIRING rather than the
    // codec: a capture that reads oldWindVec into newWindVec's slot round-trips
    // through the codec perfectly and still restores the wrong world.
    envressnapshot::EnvResourceState was;
    envResHandler.SnapshotCapture(was);

    envressnapshot::EnvResourceState in = loudWind();
    // The generator lists are cleared by the roster filter here (spring-tests
    // stands up no units), so identity is asserted over the fields the live
    // handler can hold in this fixture.
    in.allGeneratorIDs.clear();
    in.newGeneratorIDs.clear();
    envResHandler.SnapshotApply(in);

    envressnapshot::EnvResourceState back;
    envResHandler.SnapshotCapture(back);
    CHECK(back.curTidalStrength == in.curTidalStrength);
    CHECK(back.curWindStrength == in.curWindStrength);
    CHECK(back.minWindStrength == in.minWindStrength);
    CHECK(back.maxWindStrength == in.maxWindStrength);
    CHECK(back.curWindDirX == in.curWindDirX);
    CHECK(back.curWindDirZ == in.curWindDirZ);
    CHECK(back.curWindVecY == in.curWindVecY);
    CHECK(back.newWindVecX == in.newWindVecX);
    CHECK(back.newWindVecZ == in.newWindVecZ);
    CHECK(back.oldWindVecX == in.oldWindVecX);
    CHECK(back.oldWindVecY == in.oldWindVecY);
    CHECK(back.oldWindVecZ == in.oldWindVecZ);
    CHECK(back.windDirTimer == 317);

    // The phase is an index into the cycle, stepped modulo WIND_UPDATE_RATE + 1
    // and divided by WIND_UPDATE_RATE to make a smoothstep argument. A value
    // from outside that range is not a phase this handler can be in, and it
    // would be silent rather than loud.
    envressnapshot::EnvResourceState wild = in;
    wild.windDirTimer = 999999;
    envResHandler.SnapshotApply(wild);
    envressnapshot::EnvResourceState clamped;
    envResHandler.SnapshotCapture(clamped);
    CHECK(clamped.windDirTimer == 450);   // 15 * GAME_SPEED

    wild.windDirTimer = -17;
    envResHandler.SnapshotApply(wild);
    envResHandler.SnapshotCapture(clamped);
    CHECK(clamped.windDirTimer == 0);

    envResHandler.SnapshotApply(was);
}

TEST_CASE("the wind: the envResources section is required, not optional") {
    // A payload without it restores a world whose wind cycle silently starts
    // over — the exact class of hole the section table exists to make loud.
    const auto& secs = Sections();
    const auto it = std::find_if(secs.begin(), secs.end(), [](const SectionSpec& s) {
        return s.id == SectionId::EnvResources;
    });
    REQUIRE(it != secs.end());
    CHECK(it->implemented);
    CHECK(std::string(it->name) == "envResources");
}

// ──── The def name tables (PLAN-def-reconciliation task 1) ────
//
// These are pure: CompareDefNames takes two tables, so the cases that matter —
// a def removed, a def renamed away, a def that kept its name and changed id —
// are testable without standing up two different def loads of one game, which
// no doctest in this tree can do.

namespace {

std::vector<uint8_t> defBytes(const DefNameTables& t)
{
    std::vector<uint8_t> out;
    EncodeDefNames(t, out);
    return out;
}

DefNameTables sampleDefs()
{
    DefNameTables t;
    t.units    = {{1, "glaive"}, {2, "raven"}, {3, "bastion"}};
    t.weapons  = {{0, "nodefweapon"}, {1, "glaive_cannon"}, {2, "raven_rocket"}};
    t.features = {{1, "wreck_glaive"}};
    return t;
}

}  // namespace

TEST_CASE("defNames: the section round-trips all three tables") {
    const DefNameTables in = sampleDefs();
    const auto bytes = defBytes(in);

    DefNameTables out;
    std::string err;
    REQUIRE(DecodeDefNames(bytes.data(), bytes.size(), out, err));
    REQUIRE(out.units.size() == 3);
    REQUIRE(out.weapons.size() == 3);
    REQUIRE(out.features.size() == 1);
    CHECK(out.units[0].id == 1);
    CHECK(out.units[0].name == "glaive");
    CHECK(out.units[2].name == "bastion");
    // Weapon id 0 is a real def (CWeaponDefHandler says so, unlike the unit and
    // feature handlers) — dropping it would shift every weapon index by one,
    // which is the exact corruption class this table exists to prevent.
    CHECK(out.weapons[0].id == 0);
    CHECK(out.weapons[0].name == "nodefweapon");
    CHECK(out.features[0].name == "wreck_glaive");
}

TEST_CASE("defNames: an empty def table round-trips as empty, not as absent") {
    const DefNameTables in;
    const auto bytes = defBytes(in);
    DefNameTables out;
    std::string err;
    REQUIRE(DecodeDefNames(bytes.data(), bytes.size(), out, err));
    CHECK(out.units.empty());
    CHECK(out.weapons.empty());
    CHECK(out.features.empty());
}

TEST_CASE("defNames: a truncated section is a refusal at every cut point") {
    const auto full = defBytes(sampleDefs());
    for (size_t cut = 0; cut < full.size(); ++cut) {
        DefNameTables out;
        std::string err;
        CHECK_FALSE(DecodeDefNames(full.data(), cut, out, err));
        CHECK_FALSE(err.empty());
    }
}

TEST_CASE("defNames: trailing bytes inside the section are a refusal") {
    auto bytes = defBytes(sampleDefs());
    bytes.push_back(0);
    DefNameTables out;
    std::string err;
    CHECK_FALSE(DecodeDefNames(bytes.data(), bytes.size(), out, err));
    CHECK(err.find("trailing") != std::string::npos);
}

TEST_CASE("defNames: an absurd def count is refused before it is allocated") {
    auto bytes = defBytes(sampleDefs());
    for (int i = 0; i < 4; ++i) bytes[i] = 0xFF;   // the unit table's count
    DefNameTables out;
    std::string err;
    CHECK_FALSE(DecodeDefNames(bytes.data(), bytes.size(), out, err));
    CHECK(err.find("unit defs") != std::string::npos);
}

TEST_CASE("CompareDefNames: identical tables are unchanged") {
    const auto t = sampleDefs();
    const DefDelta d = CompareDefNames(t.weapons, t.weapons);
    CHECK_FALSE(d.Changed());
    CHECK(d.unchanged == 3);
    CHECK(d.renumbered == 0);
    CHECK(d.removed == 0);
    CHECK(d.added == 0);
    CHECK(d.Describe() == "unchanged");
}

TEST_CASE("CompareDefNames: a RENUMBERED def is the finding, not a removal plus an add") {
    // The whole reason the comparison is keyed by name. A def that kept its
    // name and moved id is what silently retargets a positional weapon index
    // (§1's "index-shift corruption, the worst class"); an id-keyed diff would
    // report it as "1 removed, 1 added", which is a different — and
    // reassuringly symmetrical — diagnosis of a much more dangerous event.
    const std::vector<DefNameEntry> captured = {
        {0, "nodefweapon"}, {1, "glaive_cannon"}, {2, "raven_rocket"}};
    const std::vector<DefNameEntry> live = {
        {0, "nodefweapon"}, {1, "raven_rocket"}, {2, "glaive_cannon"}};

    const DefDelta d = CompareDefNames(captured, live);
    CHECK(d.Changed());
    CHECK(d.renumbered == 2);
    CHECK(d.unchanged == 1);
    CHECK(d.removed == 0);
    CHECK(d.added == 0);
    CHECK(d.Describe().find("2 renumbered") != std::string::npos);
    CHECK(d.Describe().find("glaive_cannon") != std::string::npos);
}

TEST_CASE("CompareDefNames: removals and additions are counted from opposite sides") {
    const std::vector<DefNameEntry> captured = {
        {1, "glaive"}, {2, "raven"}, {3, "old_bastion"}};
    const std::vector<DefNameEntry> live = {
        {1, "glaive"}, {2, "raven"}, {3, "new_bastion"}, {4, "wyvern"}};

    const DefDelta d = CompareDefNames(captured, live);
    CHECK(d.unchanged == 2);
    CHECK(d.removed == 1);
    // REQUIRE, not CHECK: the index below is what reads it, and a neutralised
    // build (an id-keyed comparison) leaves this empty — a CHECK there turns a
    // reported failure into a SIGSEGV, which is a worse report of the same fact.
    REQUIRE(d.removedNames.size() == 1);
    CHECK(d.removedNames[0] == "old_bastion");
    CHECK(d.added == 2);          // new_bastion AND wyvern
    CHECK(d.renumbered == 0);
    CHECK(d.Describe().find("1 removed (old_bastion)") != std::string::npos);
    CHECK(d.Describe().find("2 added") != std::string::npos);
}

TEST_CASE("CompareDefNames: a large delta names a few examples and says there are more") {
    std::vector<DefNameEntry> captured, live;
    for (int i = 1; i <= 40; ++i) {
        captured.push_back({i, "def_" + std::to_string(i)});
        live.push_back({41 - i, "def_" + std::to_string(i)});   // every id moved
    }
    const DefDelta d = CompareDefNames(captured, live);
    CHECK(d.renumbered == 40);
    // Capped, or a balance patch produces a 40-name log line nobody reads.
    CHECK(d.renumberedNames.size() == 5);
    CHECK(d.Describe().find("40 renumbered") != std::string::npos);
    CHECK(d.Describe().find("…") != std::string::npos);
}

TEST_CASE("defNames: the section is required, not optional") {
    // A payload without it can still be restored — it just cannot be told
    // which def vocabulary it was written against, which is the whole input to
    // PLAN-def-reconciliation's remap.
    const auto& secs = Sections();
    const auto it = std::find_if(secs.begin(), secs.end(), [](const SectionSpec& s) {
        return s.id == SectionId::DefNames;
    });
    REQUIRE(it != secs.end());
    CHECK(it->implemented);
    CHECK(std::string(it->name) == "defNames");
}

TEST_CASE("defNames: capture with no def handlers is empty tables, not a crash") {
    // spring-tests loads no game, so the three handlers are null here. That is
    // not a contrivance: the store is constructed before boot parses a def, and
    // a Serialize() in that window must produce a payload, not a segfault.
    //
    // ⚠ NAMED GAP: this is also why CaptureDefNames's *contents* are not
    // covered off-engine. The three loops do not share a start index — weapon
    // id 0 is a real def and unit/feature id 0 is not — and no doctest in this
    // tree can stand up a def load to check it. The codec and the comparison
    // above are fully covered; the capture's start indices are covered only by
    // a live server (PLAN-def-reconciliation task 1's field note).
    DefNameTables t;
    CaptureDefNames(t);
    std::vector<uint8_t> bytes;
    EncodeDefNames(t, bytes);
    DefNameTables back;
    std::string err;
    REQUIRE(DecodeDefNames(bytes.data(), bytes.size(), back, err));
    CHECK(back.units.size() == t.units.size());
    CHECK(back.weapons.size() == t.weapons.size());
    CHECK(back.features.size() == t.features.size());
}

// ──── The remap pass (PLAN-def-reconciliation task 2, §6's matrix) ────
//
// Pure, all of it: BuildDefRemap takes two vocabularies and a rename table,
// RemapPayload takes decoded structs, MatchWeaponSlots takes two name lists.
// That is the reason the seam is where it is — the dangerous half of this
// milestone is which id becomes which, and none of it needs a def load.

namespace {

/// The same vocabulary as sampleDefs(), after a balance patch that inserted a
/// unit def in the middle (so everything after it renumbers), renamed one,
/// removed another and added a weapon.
DefNameTables patchedDefs()
{
    DefNameTables t;
    t.units    = {{1, "glaive"}, {2, "hoplite"}, {3, "raven_mk2"}};
    t.weapons  = {{0, "nodefweapon"}, {1, "raven_rocket"}, {2, "glaive_cannon"},
                  {3, "hoplite_spear"}};
    t.features = {{1, "wreck_glaive"}};
    return t;
}

UnitState remapUnit(int32_t id, const std::string& def)
{
    UnitState u;
    u.id = id;
    u.unitDefName = def;
    return u;
}

CommandState buildCmd(int32_t unitDefId)
{
    CommandState c;
    c.cmdID = -unitDefId;   // the build-order encoding
    return c;
}

}  // namespace

TEST_CASE("task 2: a tuning-only patch remaps nothing") {
    // §3's fast path, and the case that must stay free: same names, same ids,
    // so steps 1-2 have no work and the payload is not touched.
    DefRemap m;
    std::string err;
    REQUIRE(BuildDefRemap(sampleDefs(), sampleDefs(), DefAliases{}, m, err));
    CHECK(m.Identity());
    CHECK(m.units.Map(2) == 2);

    std::vector<UnitState> units{remapUnit(7, "raven")};
    std::vector<FeatureState> features;
    std::vector<StandingOrder> orders;
    std::vector<Directive> dirs;
    RemapReport rep;
    RemapPayload(m, units, features, orders, dirs, rep);
    CHECK_FALSE(rep.Changed());
    CHECK(rep.Describe() == "nothing to remap");
    REQUIRE(units.size() == 1);
    CHECK(units[0].unitDefName == "raven");
}

TEST_CASE("task 2: an unrecorded vocabulary changes nothing (it does NOT read as removal)") {
    // The load-bearing negative. A snapshot taken before task 1 shipped the
    // defNames section decodes with empty tables, and reading that as "every
    // def was removed" would delete the entire world on resume - the one bug in
    // this pass that is worse than not having the pass.
    DefRemap m;
    std::string err;
    REQUIRE(BuildDefRemap(DefNameTables{}, patchedDefs(), DefAliases{}, m, err));
    CHECK(m.units.unknown);
    CHECK(m.Identity());
    CHECK(m.units.Map(3) == 3);
    CHECK_FALSE(m.units.Gone("raven"));

    std::vector<UnitState> units{remapUnit(1, "raven"), remapUnit(2, "bastion")};
    std::vector<FeatureState> features;
    std::vector<StandingOrder> orders;
    std::vector<Directive> dirs;
    RemapReport rep;
    RemapPayload(m, units, features, orders, dirs, rep);
    CHECK(units.size() == 2);
    CHECK(rep.unitsDropped == 0);

    // And the same the other way round: a live table this process has not
    // parsed yet (a headless run with no game) is equally unknown.
    DefRemap m2;
    REQUIRE(BuildDefRemap(sampleDefs(), DefNameTables{}, DefAliases{}, m2, err));
    CHECK(m2.units.unknown);
    CHECK(m2.Identity());
}

TEST_CASE("task 2: a renumbering is remapped, not reported as remove+add") {
    DefRemap m;
    std::string err;
    REQUIRE(BuildDefRemap(sampleDefs(), patchedDefs(), DefAliases{}, m, err));

    // glaive kept id 1; glaive_cannon moved 1 -> 2, raven_rocket 2 -> 1. That
    // swap is §1's worst class: both ids stay valid and each names the other's
    // weapon.
    CHECK(m.weapons.Map(0) == 0);
    CHECK(m.weapons.Map(1) == 2);
    CHECK(m.weapons.Map(2) == 1);
    // raven and bastion are gone (raven_mk2 is a different name - see the alias
    // case below for the same patch WITH a migrations entry).
    CHECK(m.units.Gone("raven"));
    CHECK(m.units.Gone("bastion"));
    CHECK(m.units.Map(2) == -1);
    CHECK_FALSE(m.units.Gone("glaive"));

    // A unit's delayed wreck is a raw feature def id and remaps through the
    // feature map; the units' own defs are names and are handled by removal.
    std::vector<UnitState> units{remapUnit(4, "glaive")};
    units[0].featureDefID = 1;
    units[0].commands = {buildCmd(1), buildCmd(3)};   // glaive, bastion
    std::vector<FeatureState> features;
    std::vector<StandingOrder> orders;
    std::vector<Directive> dirs;
    RemapReport rep;
    RemapPayload(m, units, features, orders, dirs, rep);

    REQUIRE(units.size() == 1);
    CHECK(units[0].featureDefID == 1);        // wreck_glaive kept its id
    // The build order for a def that is gone LEAVES the queue: -3 is still a
    // valid command id, it just builds whatever holds id 3 now.
    REQUIRE(units[0].commands.size() == 1);
    CHECK(units[0].commands[0].cmdID == -1);
    CHECK(rep.buildCmdsDropped == 1);
    CHECK(rep.buildCmdsRemapped == 0);
}

TEST_CASE("task 2: migrations.lua turns a removal into a rename") {
    DefAliases a;
    a.units["raven"] = "raven_mk2";
    DefRemap m;
    std::string err;
    REQUIRE(BuildDefRemap(sampleDefs(), patchedDefs(), a, m, err));

    // raven is no longer gone - it IS raven_mk2, and its id moved 2 -> 3.
    CHECK_FALSE(m.units.Gone("raven"));
    CHECK(m.units.Map(2) == 3);
    REQUIRE(m.unitRenames.count("raven") == 1);
    CHECK(m.unitRenames.at("raven") == "raven_mk2");

    std::vector<UnitState> units{remapUnit(9, "raven"), remapUnit(10, "bastion")};
    units[0].commands = {buildCmd(2)};
    std::vector<FeatureState> features;
    std::vector<StandingOrder> orders;
    std::vector<Directive> dirs;
    RemapReport rep;
    RemapPayload(m, units, features, orders, dirs, rep);

    // The renamed unit survives with the new name; bastion, which the game did
    // not alias, does not come back at all.
    REQUIRE(units.size() == 1);
    CHECK(units[0].id == 9);
    CHECK(units[0].unitDefName == "raven_mk2");
    CHECK(rep.unitsRenamed == 1);
    CHECK(rep.unitsDropped == 1);
    REQUIRE(rep.droppedUnitNames.size() == 1);
    CHECK(rep.droppedUnitNames[0] == "bastion");
    // Its own build order for a raven follows the rename.
    REQUIRE(units[0].commands.size() == 1);
    CHECK(units[0].commands[0].cmdID == -3);
    CHECK(rep.buildCmdsRemapped == 1);
}

TEST_CASE("task 2: E1 refuses an ambiguous rename") {
    std::string err;
    DefRemap m;

    SUBCASE("the alias source still exists") {
        // `glaive = "hoplite"` while this game defines both: the author renamed
        // something that did not go away, so there is no answer to what the old
        // glaives are now.
        DefAliases a;
        a.units["glaive"] = "hoplite";
        CHECK_FALSE(BuildDefRemap(sampleDefs(), patchedDefs(), a, m, err));
        CHECK(err.find("both") != std::string::npos);
        CHECK(err.find("glaive") != std::string::npos);
    }

    SUBCASE("two defs aliased onto one") {
        DefAliases a;
        a.units["raven"] = "hoplite";
        a.units["bastion"] = "hoplite";
        CHECK_FALSE(BuildDefRemap(sampleDefs(), patchedDefs(), a, m, err));
        CHECK(err.find("hoplite") != std::string::npos);
    }

    SUBCASE("an alias to a def this game does not have is a plain removal") {
        // Not an authoring bug the engine can prove: the target may have been
        // dropped from a later patch. The units go, loudly, by the removal path.
        DefAliases a;
        a.units["raven"] = "nothing_at_all";
        REQUIRE(BuildDefRemap(sampleDefs(), patchedDefs(), a, m, err));
        CHECK(m.units.Gone("raven"));
    }
}

TEST_CASE("task 2: a def-id FILTER that empties deactivates its order") {
    // The sharp edge of "remove what cannot be remapped":
    // StandingOrderConditions::squadTypes is a whitelist whose EMPTY state means
    // "any squad". Dropping its last entry would widen a recruiting order to a
    // wildcard - the opposite of what removing a def should do.
    DefRemap m;
    std::string err;
    REQUIRE(BuildDefRemap(sampleDefs(), patchedDefs(), DefAliases{}, m, err));

    std::vector<UnitState> units;
    std::vector<FeatureState> features;
    std::vector<StandingOrder> orders(2);
    orders[0].type = StandingOrderType::DefendArea;
    orders[0].conditions.squadTypes = {2, 3};        // raven, bastion: both gone
    orders[1].type = StandingOrderType::DefendArea;
    orders[1].conditions.squadTypes = {1, 3};        // glaive survives
    std::vector<Directive> dirs(1);
    dirs[0].type = DirectiveType::BuildBase;
    dirs[0].params = {100.0f, 0.0f, 200.0f, 1.0f, 3.0f};   // x, y, z, glaive, bastion
    dirs[0].conditions.squadTypes = {1};

    RemapReport rep;
    RemapPayload(m, units, features, orders, dirs, rep);

    CHECK(orders[0].conditions.squadTypes.empty());
    CHECK_FALSE(orders[0].active);
    CHECK(rep.ordersDeactivated == 1);

    REQUIRE(orders[1].conditions.squadTypes.size() == 1);
    CHECK(orders[1].conditions.squadTypes[0] == 1);
    CHECK(orders[1].active);

    // BuildBase geometry is never a def; the def list starts at param 3.
    REQUIRE(dirs[0].params.size() == 4);
    CHECK(dirs[0].params[0] == doctest::Approx(100.0f));
    CHECK(dirs[0].params[2] == doctest::Approx(200.0f));
    CHECK(dirs[0].params[3] == doctest::Approx(1.0f));
    CHECK(dirs[0].active);
    // Two filter entries in orders[0], one in orders[1], one BuildBase param.
    CHECK(rep.orderDefsDropped == 4);
}

TEST_CASE("task 2: a dropped unit does not stay in a transport graph") {
    DefRemap m;
    std::string err;
    REQUIRE(BuildDefRemap(sampleDefs(), patchedDefs(), DefAliases{}, m, err));

    std::vector<UnitState> units{remapUnit(1, "glaive"), remapUnit(2, "raven")};
    units[0].transportees = {{2, 0}, {3, 1}};
    units[1].transporterId = 1;
    std::vector<UnitState> alsoCarried{remapUnit(3, "glaive")};
    units.push_back(alsoCarried[0]);
    units[2].transporterId = 2;   // carried by the unit that is about to vanish
    std::vector<FeatureState> features;
    std::vector<StandingOrder> orders;
    std::vector<Directive> dirs;
    RemapReport rep;
    RemapPayload(m, units, features, orders, dirs, rep);

    REQUIRE(units.size() == 2);          // the raven is gone
    CHECK(rep.unitsDropped == 1);
    // Its slot in the transport's cargo list goes with it, and the unit IT was
    // carrying is no longer attached to a unit that will never be created.
    REQUIRE(units[0].transportees.size() == 1);
    CHECK(units[0].transportees[0].first == 3);
    CHECK(units[1].transporterId == -1);
}

TEST_CASE("task 2: features and resurrect targets follow their defs") {
    DefAliases a;
    a.features["wreck_glaive"] = "wreck_glaive_v2";
    DefNameTables live = patchedDefs();
    live.features = {{4, "wreck_glaive_v2"}};
    // The captured vocabulary has to CONTAIN the def a captured object names -
    // it was read off the same def load. A payload naming a def that its own
    // vocabulary never had is a corrupt payload, and ResolveFeatureDefs refuses
    // it; that is not this pass's case.
    DefNameTables captured = sampleDefs();
    captured.features.push_back({2, "wreck_of_nothing"});

    DefRemap m;
    std::string err;
    REQUIRE(BuildDefRemap(captured, live, a, m, err));
    CHECK(m.features.Map(1) == 4);

    std::vector<UnitState> units{remapUnit(1, "glaive")};
    units[0].featureDefID = 1;
    std::vector<FeatureState> features(2);
    features[0].id = 100;
    features[0].featureDefName = "wreck_glaive";
    features[0].resurrectUnitDefName = "raven";       // a def that is gone
    features[1].id = 101;
    features[1].featureDefName = "wreck_of_nothing";  // a def that is gone
    std::vector<StandingOrder> orders;
    std::vector<Directive> dirs;
    RemapReport rep;
    RemapPayload(m, units, features, orders, dirs, rep);

    CHECK(units[0].featureDefID == 4);
    CHECK(rep.wreckRemapped == 1);
    REQUIRE(features.size() == 1);
    CHECK(features[0].featureDefName == "wreck_glaive_v2");
    CHECK(rep.featuresRenamed == 1);
    CHECK(rep.featuresDropped == 1);
    // "Not resurrectable" is a real state; a resurrect target pointing at a
    // def that is gone would resurrect whatever holds that id now.
    CHECK(features[0].resurrectUnitDefName.empty());
    CHECK(rep.resurrectCleared == 1);
}

TEST_CASE("task 2: weapon slots pair by name, not by position") {
    // The reorder case, which is the one a positional match gets wrong while
    // looking right: a def whose two weapons swapped order would hand the
    // stockpiled nuke's count to the machine gun.
    std::vector<WeaponState> captured(2);
    captured[0].weaponDefName = "machine_gun";
    captured[0].numStockpiled = 0;
    captured[1].weaponDefName = "nuke";
    captured[1].numStockpiled = 4;

    SUBCASE("reordered") {
        const auto from = MatchWeaponSlots(captured, {"nuke", "machine_gun"});
        REQUIRE(from.size() == 2);
        CHECK(from[0] == 1);
        CHECK(from[1] == 0);
    }

    SUBCASE("E4: a weapon added to the def starts fresh") {
        const auto from = MatchWeaponSlots(captured,
                                           {"machine_gun", "nuke", "laser"});
        REQUIRE(from.size() == 3);
        CHECK(from[0] == 0);
        CHECK(from[1] == 1);
        CHECK(from[2] == -1);
    }

    SUBCASE("a weapon removed from the def drops its captured slot") {
        const auto from = MatchWeaponSlots(captured, {"nuke"});
        REQUIRE(from.size() == 1);
        CHECK(from[0] == 1);
    }

    SUBCASE("two slots sharing one def keep their order") {
        std::vector<WeaponState> twin(2);
        twin[0].weaponDefName = "launcher"; twin[0].numStockpiled = 1;
        twin[1].weaponDefName = "launcher"; twin[1].numStockpiled = 9;
        const auto from = MatchWeaponSlots(twin, {"launcher", "launcher"});
        REQUIRE(from.size() == 2);
        CHECK(from[0] == 0);
        CHECK(from[1] == 1);
    }

    SUBCASE("a payload with no names at all matches positionally") {
        // A pre-task-2 units section, or any fixture that never set a name.
        // Matching those by name would pair every empty name with every other.
        std::vector<WeaponState> unnamed(3);
        const auto from = MatchWeaponSlots(unnamed, {"a", "b"});
        REQUIRE(from.size() == 2);
        CHECK(from[0] == 0);
        CHECK(from[1] == 1);
    }
}

// ─ The scalar pass (PLAN-def-reconciliation task 3, §2 steps 3-4 + §6) ─
//
// Pure for the same reason task 2's is: the dangerous half is which number wins
// when a def and a gadget disagree, and deciding that needs two scalar tables
// and a decoded payload, not a def load.

namespace {

/// One unit def's newborn values, as the snapshot recorded them.
UnitDefScalars bornScalars()
{
    UnitDefScalars s;
    s.maxHealth = 1000.0f;
    s.power = 100.0f;
    s.mass = 50.0f;
    s.buildTime = 300.0f;
    s.cost = {120.0f, 80.0f};
    s.armoredMultiple = 0.5f;
    s.armorType = 3;
    s.category = 4;
    s.maxRange = 700.0f;
    s.losRadius = 600;
    s.airLosRadius = 600;
    s.radarRadius = 0;
    s.decloakDistance = 75.0f;
    return s;
}

DefScalarTables bornTables()
{
    DefScalarTables t;
    t.units.emplace("raven", bornScalars());
    FeatureDefScalars f;
    f.maxHealth = 400.0f;
    f.mass = 200.0f;
    f.reclaimTime = 100.0f;
    f.defResources = {60.0f, 0.0f};
    t.features.emplace("wreck_raven", f);
    return t;
}

/// A unit of that def, captured with everything at its newborn value and half
/// its health gone.
UnitState bornUnit()
{
    UnitState u;
    u.id = 7;
    u.unitDefName = "raven";
    const UnitDefScalars s = bornScalars();
    u.maxHealth = s.maxHealth;
    u.health = s.maxHealth * 0.5f;
    u.power = s.power;
    u.mass = s.mass;
    u.buildTime = s.buildTime;
    u.cost = s.cost;
    u.armoredMultiple = s.armoredMultiple;
    u.curArmorMultiple = 1.0f;   // not armoredState
    u.armorType = s.armorType;
    u.category = s.category;
    u.maxRange = s.maxRange;
    u.losRadius = u.realLosRadius = s.losRadius;
    u.airLosRadius = u.realAirLosRadius = s.airLosRadius;
    u.decloakDistance = s.decloakDistance;
    u.reloadSpeed = 1.0f;
    return u;
}

}  // namespace

TEST_CASE("task 3: a retuned def re-derives, and health keeps its FRACTION") {
    DefScalarTables live = bornTables();
    live.units.at("raven").maxHealth = 500.0f;    // nerfed to half
    live.units.at("raven").buildTime = 600.0f;
    live.units.at("raven").maxRange = 900.0f;     // an up-gunned weapon

    std::vector<UnitState> units{bornUnit()};
    std::vector<FeatureState> features;
    ScalarReport rep;
    ReconcileScalars(bornTables(), live, DefRemap{}, units, features, rep);

    CHECK(rep.ran);
    CHECK(rep.unitDefsRetuned == 1);
    CHECK(rep.unitsTouched == 1);
    CHECK(rep.unitFieldsReDerived == 3);
    CHECK(rep.unitFieldsAuthored == 0);
    CHECK(rep.unitsHealthScaled == 1);
    // The whole point of "proportional, not clamp-only" (§3): the unit was at
    // 50 %, and it still is. A clamp would have left it at 500/500 — healed by
    // a nerf — and a straight copy at 500/500 too.
    CHECK(units[0].maxHealth == doctest::Approx(500.0f));
    CHECK(units[0].health == doctest::Approx(250.0f));
    CHECK(units[0].buildTime == doctest::Approx(600.0f));
    CHECK(units[0].maxRange == doctest::Approx(900.0f));
    CHECK(rep.Describe().find("1 unit health fractions preserved") !=
          std::string::npos);
}

TEST_CASE("task 3: a BUFF raises absolute health without healing the unit") {
    DefScalarTables live = bornTables();
    live.units.at("raven").maxHealth = 2000.0f;

    std::vector<UnitState> units{bornUnit()};
    std::vector<FeatureState> features;
    ScalarReport rep;
    ReconcileScalars(bornTables(), live, DefRemap{}, units, features, rep);

    CHECK(units[0].maxHealth == doctest::Approx(2000.0f));
    CHECK(units[0].health == doctest::Approx(1000.0f));
    // Still exactly as wounded as it was, which is §3's stated interaction with
    // the no-heal invariant.
    CHECK(units[0].health / units[0].maxHealth == doctest::Approx(0.5f));
}

TEST_CASE("task 3: an AUTHORED value survives the patch that would overwrite it") {
    // The load-bearing negative of this whole pass. Almost every audited field
    // is both a def cache and a Lua setter's target, so a value that does NOT
    // match the def it was born from belongs to a gadget and reconciling it
    // would silently revert Spring.SetUnitMaxHealth.
    DefScalarTables live = bornTables();
    live.units.at("raven").maxHealth = 500.0f;
    live.units.at("raven").cost = {200.0f, 200.0f};

    std::vector<UnitState> units{bornUnit()};
    units[0].maxHealth = 3000.0f;         // a gadget's boss unit
    units[0].health = 1500.0f;
    units[0].cost = {1.0f, 1.0f};         // and a gadget's price
    std::vector<FeatureState> features;
    ScalarReport rep;
    ReconcileScalars(bornTables(), live, DefRemap{}, units, features, rep);

    CHECK(rep.unitFieldsAuthored == 2);
    CHECK(units[0].maxHealth == doctest::Approx(3000.0f));
    CHECK(units[0].health == doctest::Approx(1500.0f));   // no fraction to scale
    CHECK(rep.unitsHealthScaled == 0);
    CHECK(units[0].cost.metal == doctest::Approx(1.0f));
}

TEST_CASE("task 3: a VETERAN is not read as authored") {
    // maxHealth and power are functions of the def AND experience, so comparing
    // a veteran's values against the raw def value reads every veteran in the
    // world as authored — and then the units that matter most keep their stale
    // maxHealth. The expected-newborn value therefore folds the SNAPSHOT's own
    // experience curve, which is why the curve travels in the section.
    DefScalarTables born = bornTables();
    born.expHealthScale = 1.0f;
    born.expPowerScale = 1.0f;
    DefScalarTables live = born;
    live.units.at("raven").maxHealth = 500.0f;

    std::vector<UnitState> units{bornUnit()};
    units[0].experience = 1.0f;           // limExperience 0.5
    units[0].maxHealth = 1500.0f;         // 1000 × (1 + 0.5)
    units[0].health = 750.0f;
    units[0].power = 150.0f;
    std::vector<FeatureState> features;
    ScalarReport rep;
    ReconcileScalars(born, live, DefRemap{}, units, features, rep);

    CHECK(rep.unitFieldsAuthored == 0);
    CHECK(units[0].maxHealth == doctest::Approx(750.0f));   // 500 × 1.5
    CHECK(units[0].health == doctest::Approx(375.0f));      // still 50 %
    CHECK(rep.unitsHealthScaled == 1);
}

TEST_CASE("task 3: armorType is re-derived, which is the index no remap could reach") {
    // Task 2's named gap. armorType is an index into the armor-type list, which
    // no section carries and no name-keyed map can rewrite — but it also has no
    // Lua setter and nothing mutates it after PreInit, so the fix is not a
    // fourth name table: it is not restoring a stale index at all.
    DefScalarTables live = bornTables();
    live.units.at("raven").armorType = 9;   // the armor list was reordered
    live.units.at("raven").category = 12;

    std::vector<UnitState> units{bornUnit()};
    std::vector<FeatureState> features;
    ScalarReport rep;
    ReconcileScalars(bornTables(), live, DefRemap{}, units, features, rep);

    CHECK(units[0].armorType == 9);
    CHECK(units[0].category == 12u);
    CHECK(rep.unitFieldsReDerived == 2);
}

TEST_CASE("task 3: an unrecorded scalar table changes NOTHING") {
    // The same one-directional guard as task 2's unknown vocabulary, and the
    // same reason: a pre-task-3 snapshot has no scalars, and reading that as
    // "every def was retuned to the live numbers" would overwrite every
    // authored scalar in the world in one pass.
    DefScalarTables live = bornTables();
    live.units.at("raven").maxHealth = 500.0f;

    std::vector<UnitState> units{bornUnit()};
    std::vector<FeatureState> features;
    ScalarReport rep;
    ReconcileScalars(DefScalarTables{}, live, DefRemap{}, units, features, rep);
    CHECK_FALSE(rep.ran);
    CHECK_FALSE(rep.Changed());
    CHECK(units[0].maxHealth == doctest::Approx(1000.0f));
    CHECK(rep.Describe() == "no def scalars recorded in this snapshot");

    // And the other direction: a process that has parsed no def yet.
    ScalarReport rep2;
    ReconcileScalars(bornTables(), DefScalarTables{}, DefRemap{}, units, features, rep2);
    CHECK_FALSE(rep2.ran);
    CHECK(units[0].maxHealth == doctest::Approx(1000.0f));
}

TEST_CASE("task 3: a tuning-only patch that tunes nothing touches nothing") {
    std::vector<UnitState> units{bornUnit()};
    std::vector<FeatureState> features;
    ScalarReport rep;
    ReconcileScalars(bornTables(), bornTables(), DefRemap{}, units, features, rep);
    CHECK(rep.ran);
    CHECK_FALSE(rep.Changed());
    CHECK(rep.Describe() == "no def scalar moved");
    CHECK(units[0].maxHealth == doctest::Approx(1000.0f));
    CHECK(rep.unitFieldsReDerived == 0);
    CHECK(rep.unitFieldsAuthored == 0);
}

TEST_CASE("task 3: a RENAMED def finds its own captured scalars") {
    // The pass runs after RemapPayload, so the payload carries live names while
    // the captured table is keyed by the snapshot's. Without the inverse rename
    // a renamed def's units would all report unknownDef and keep stale numbers.
    DefScalarTables live;
    live.units.emplace("raven_mk2", bornScalars());
    live.units.at("raven_mk2").maxHealth = 500.0f;

    DefRemap map;
    map.unitRenames.emplace("raven", "raven_mk2");

    std::vector<UnitState> units{bornUnit()};
    units[0].unitDefName = "raven_mk2";   // RemapPayload already did this
    std::vector<FeatureState> features;
    ScalarReport rep;
    ReconcileScalars(bornTables(), live, map, units, features, rep);

    CHECK(rep.unitsUnknownDef == 0);
    CHECK(rep.unitDefsRetuned == 1);
    CHECK(units[0].maxHealth == doctest::Approx(500.0f));
    CHECK(units[0].health == doctest::Approx(250.0f));
}

TEST_CASE("task 3: a def with no recorded scalars is left alone, not refused") {
    std::vector<UnitState> units{bornUnit()};
    units[0].unitDefName = "something_else";
    std::vector<FeatureState> features;
    ScalarReport rep;
    ReconcileScalars(bornTables(), bornTables(), DefRemap{}, units, features, rep);
    CHECK(rep.unitsUnknownDef == 1);
    CHECK(units[0].maxHealth == doctest::Approx(1000.0f));
}

TEST_CASE("task 3: mass is skipped where it is not a def cache") {
    // mass is the audit's one accumulator: it stays at its constructor value
    // while a unit is beingBuilt (Unit.cpp:268) and a transport ADDS its cargo's
    // mass into its own (Unit.cpp:2686). Re-deriving either would write a number
    // the def cannot know.
    DefScalarTables live = bornTables();
    live.units.at("raven").mass = 75.0f;

    std::vector<UnitState> units{bornUnit(), bornUnit(), bornUnit()};
    units[1].beingBuilt = true;
    units[2].transportees.push_back({99, 0});
    std::vector<FeatureState> features;
    ScalarReport rep;
    ReconcileScalars(bornTables(), live, DefRemap{}, units, features, rep);

    CHECK(units[0].mass == doctest::Approx(75.0f));   // an ordinary unit follows
    CHECK(units[1].mass == doctest::Approx(50.0f));
    CHECK(units[2].mass == doctest::Approx(50.0f));
    CHECK(rep.unitFieldsReDerived == 1);
}

TEST_CASE("task 3: a re-costed wreck keeps its reclaim FRACTION") {
    // The feature half of fraction preservation, and it needs its own rule:
    // `resources` is what is left to reclaim and CFeature caps it at
    // defResources, using the ratio as the reclaimed fraction. A cheapened def
    // would otherwise leave a half-reclaimed wreck holding more than the def
    // says it ever had.
    DefScalarTables live = bornTables();
    live.features.at("wreck_raven").defResources = {30.0f, 0.0f};
    live.features.at("wreck_raven").maxHealth = 200.0f;

    FeatureState f;
    f.featureDefName = "wreck_raven";
    f.maxHealth = 400.0f;
    f.health = 100.0f;            // a quarter
    f.mass = 200.0f;
    f.reclaimTime = 100.0f;
    f.defResources = {60.0f, 0.0f};
    f.resources = {30.0f, 0.0f};  // half reclaimed

    std::vector<UnitState> units;
    std::vector<FeatureState> features{f};
    ScalarReport rep;
    ReconcileScalars(bornTables(), live, DefRemap{}, units, features, rep);

    CHECK(rep.featureDefsRetuned == 1);
    CHECK(rep.featuresTouched == 1);
    CHECK(rep.featuresHealthScaled == 1);
    CHECK(rep.featuresResourcesScaled == 1);
    CHECK(features[0].maxHealth == doctest::Approx(200.0f));
    CHECK(features[0].health == doctest::Approx(50.0f));
    CHECK(features[0].defResources.metal == doctest::Approx(30.0f));
    CHECK(features[0].resources.metal == doctest::Approx(15.0f));
}

TEST_CASE("defScalars: the section round-trips every field of both tables") {
    DefScalarTables t = bornTables();
    t.expPowerScale = 0.25f;
    t.expHealthScale = 0.5f;
    t.expReloadScale = 0.125f;
    t.units.emplace("bastion", UnitDefScalars{});
    UnitDefScalars& b = t.units.at("bastion");
    b.stealth = true;
    b.sonarStealth = true;
    b.sonarJamRadius = 42;
    b.harvestStorage = {7.0f, 8.0f};
    b.storage = {9.0f, 10.0f};
    b.flankingBonusMode = 2;
    b.flankingBonusMobilityAdd = 1.0f;
    b.flankingBonusAvgDamage = 1.1f;
    b.flankingBonusDifDamage = 0.2f;
    b.seismicSignature = 3.5f;
    b.seismicRadius = 11;

    std::vector<uint8_t> bytes;
    EncodeDefScalars(t, bytes);
    DefScalarTables out;
    std::string err;
    REQUIRE(DecodeDefScalars(bytes.data(), bytes.size(), out, err));
    CHECK(err.empty());
    CHECK(out.expPowerScale == doctest::Approx(0.25f));
    CHECK(out.expHealthScale == doctest::Approx(0.5f));
    CHECK(out.expReloadScale == doctest::Approx(0.125f));
    REQUIRE(out.units.size() == 2);
    REQUIRE(out.features.size() == 1);
    CHECK(out.units.at("raven").armorType == 3);
    CHECK(out.units.at("raven").maxRange == doctest::Approx(700.0f));
    CHECK(out.units.at("bastion").stealth);
    CHECK(out.units.at("bastion").sonarStealth);
    CHECK(out.units.at("bastion").sonarJamRadius == 42);
    CHECK(out.units.at("bastion").storage.energy == doctest::Approx(10.0f));
    CHECK(out.units.at("bastion").harvestStorage.metal == doctest::Approx(7.0f));
    CHECK(out.units.at("bastion").flankingBonusMobilityAdd == doctest::Approx(1.0f));
    CHECK(out.units.at("bastion").flankingBonusDifDamage == doctest::Approx(0.2f));
    CHECK(out.units.at("bastion").seismicSignature == doctest::Approx(3.5f));
    CHECK(out.features.at("wreck_raven").reclaimTime == doctest::Approx(100.0f));
    CHECK(out.features.at("wreck_raven").defResources.metal == doctest::Approx(60.0f));

    // Two encodes of the same tables are byte-identical: the section is written
    // in sorted name order, not in hash-bucket order, or the §8 re-capture bar
    // would compare a payload against a permutation of itself.
    std::vector<uint8_t> again;
    EncodeDefScalars(out, again);
    CHECK(again == bytes);
}

TEST_CASE("defScalars: a truncated section is a refusal at every cut point") {
    std::vector<uint8_t> bytes;
    EncodeDefScalars(bornTables(), bytes);
    for (size_t cut = 0; cut < bytes.size(); ++cut) {
        DefScalarTables out;
        std::string err;
        CAPTURE(cut);
        CHECK_FALSE(DecodeDefScalars(bytes.data(), cut, out, err));
        CHECK_FALSE(err.empty());
    }
}

TEST_CASE("defScalars: trailing bytes inside the section are a refusal") {
    std::vector<uint8_t> bytes;
    EncodeDefScalars(bornTables(), bytes);
    bytes.push_back(0);
    DefScalarTables out;
    std::string err;
    CHECK_FALSE(DecodeDefScalars(bytes.data(), bytes.size(), out, err));
    CHECK(err.find("trailing") != std::string::npos);
}

TEST_CASE("defScalars: an absurd def count is refused before it is allocated") {
    std::vector<uint8_t> bytes(3 * 4, 0);      // the three scales
    bytes.push_back(0xff); bytes.push_back(0xff);
    bytes.push_back(0xff); bytes.push_back(0x0f);
    DefScalarTables out;
    std::string err;
    CHECK_FALSE(DecodeDefScalars(bytes.data(), bytes.size(), out, err));
    CHECK(err.find("claims") != std::string::npos);
}

TEST_CASE("defScalars: capture with no def handlers is empty tables, not a crash") {
    // Same shape as defNames': the store is built ~400 lines before the first
    // def is parsed, so this is a real state rather than a defensive check.
    DefScalarTables t;
    CaptureDefScalars(t);
    CHECK(t.Empty());
}

TEST_CASE("defScalars: the section is required, not optional") {
    const auto& secs = Sections();
    const auto it = std::find_if(secs.begin(), secs.end(), [](const SectionSpec& s) {
        return s.id == SectionId::DefScalars;
    });
    REQUIRE(it != secs.end());
    CHECK(it->implemented);
    CHECK(std::string(it->name) == "defScalars");
    CHECK(it->version == 1);
}

TEST_CASE("task 2: the pending-volley ring is declared uncaptured, not remapped") {
    // §E5 asks task 2 to remap the statistical-combat ring's weaponDefId. There
    // is no ring in the payload: it is dropped on the same argument as an
    // in-flight projectile. That is a declared omission rather than a silent
    // one, and this is the assertion that keeps it declared.
    const auto& omitted = DerivedNotCaptured();
    const bool named = std::any_of(omitted.begin(), omitted.end(),
        [](const DerivedOmission& o) {
            return std::string(o.what).find("statistical-combat") != std::string::npos;
        });
    CHECK(named);
}
