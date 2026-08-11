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
#include "System/GlobalRNG.h"

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

TEST_CASE("the declared gaps are the ones this milestone left") {
    // Pinned deliberately: filling one of these in without updating this list
    // is fine (the test fails, you delete a line); *adding* a new unimplemented
    // section without saying so is not.
    const std::vector<std::string> missing = MissingSections();
    REQUIRE(missing.size() == 3);
    CHECK(missing[0] == "teams");
    CHECK(missing[1] == "units");
    CHECK(missing[2] == "syncedLua");
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
    CHECK(implemented == 4);
    CHECK(h == expect);
}

// ────────────────────── Refusal while incomplete ──────────────────────

TEST_CASE("Serialize refuses by name while a declared section is unimplemented") {
    // The honest-refusal property: this serializer never hands the store a
    // payload it knows is missing state. The error must NAME the gaps, because
    // "checkpoint failed" with no reason is what GameStateStore's own module
    // header calls out as the thing it exists to avoid.
    stageFixture();
    SimSnapshotSerializer ser;
    std::vector<uint8_t> out;
    std::string err;
    CHECK_FALSE(ser.Serialize(out, err));
    CHECK(out.empty());
    for (const auto& name : MissingSections()) {
        INFO("err: " << err);
        CHECK(err.find(name) != std::string::npos);
    }
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
