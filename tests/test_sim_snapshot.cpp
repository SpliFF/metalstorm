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
#include "System/GlobalRNG.h"
#include "Lua/LuaHandleSynced.h"   // CSplitLuaHandle::gameParams (task 1d-b)

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
    CHECK(implemented == 9);   // + gameRules (task 1d-b)
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
    WeaponState w1; w1.reloadStatus = 4100; w1.salvoLeft = 0; w1.nextSalvo = 0;
                    w1.numStockpiled = 0; w1.numStockpileQued = 7;
    s.weapons = {w0, w1};
    s.modParams = loudRulesParams();
    s.activeIndex = 37;
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
            x.numStockpileQued != y.numStockpileQued)
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
    CHECK(census::Weapon(WeaponState{}) == 5);
    CHECK(census::Team(TeamState{}) == 26);
    CHECK(census::Unit(UnitState{}) == 114);
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
