// PLAN-long-uptime S5 task 6 — the unit-id recycle guard.
//
// S5's original row read the risk as id-space EXHAUSTION and the sweep (§7.2)
// corrected it to ALIASING: ids are recycled, so an id is a name for a slot,
// not for a unit, and anything holding an id across the recycle is holding a
// reference to whatever took the slot next. Inside the sim that is already
// guarded per-id by CUnitHandler::GetUnitSpawnGen (DamageField, statistical
// combat), whose consumers hold an id for a few frames. The consumer that
// holds ids for the whole match is the remote client, and the sim cannot
// enumerate what it has built on them — so the recycle is ANNOUNCED and the
// client drops the lot.
//
// Two halves are decidable here: the pool's epoch (does it bump when, and only
// when, an id becomes re-issuable) and the announcer's window discipline (does
// the flag survive a lane that drops messages). The third half — that the flag
// reaches a browser and the browser flushes — is client work, covered by
// client/src/core/id-recycle-guard.test.ts.
#include <doctest/doctest.h>

#include "Server/IdRecycleAnnouncer.h"
#include "Server/EntityStateSerializer.h"
#include "Sim/Misc/SimObjectIDPool.h"
#include "Sim/Objects/SolidObject.h"
#include "Sim/Units/Unit.h"

#include <algorithm>
#include <vector>


namespace {

/// Take a specific id out of the pool, the way a spawning unit does
/// (AssignID with an id already chosen goes down ReserveID). FreeID asserts
/// the id is currently OUT, so nothing can be parked without this first.
void Spend(SimObjectIDPool& pool, uint32_t id)
{
    CSolidObject obj;
    obj.id = static_cast<int>(id);
    pool.AssignID(&obj);
}

} // namespace

TEST_CASE("S5 task 6: the pool bumps its recycle epoch when an id becomes re-issuable")
{
    SimObjectIDPool pool(8);
    pool.Expand(0, 8);

    CHECK(pool.GetRecycleEpoch() == 0u);
    CHECK(pool.GetSize() == 8u);

    SUBCASE("parking an id is not a recycle")
    {
        // FreeID(delayed=true) is what CUnitHandler::DeleteUnit does on every
        // death. The id goes to tempIDs and is NOT handed back out, so nothing
        // can alias yet and there is nothing to announce. Announcing here
        // instead would fire on every unit death in the game — the flag would
        // mean "a unit died", the client would flush its selection constantly,
        // and the guard would be worse than the defect.
        Spend(pool, 3);
        pool.FreeID(3, true);
        CHECK(pool.GetRecycleEpoch() == 0u);
        CHECK(pool.HasID(3) == false);
    }

    SUBCASE("an immediate free is not a recycle either")
    {
        // FreeID(delayed=false) puts the id straight back, but it was never
        // parked: no consumer has had a chance to build anything on it.
        Spend(pool, 3);
        pool.FreeID(3, false);
        CHECK(pool.GetRecycleEpoch() == 0u);
        CHECK(pool.HasID(3) == true);
    }

    SUBCASE("a targeted recycle bumps once, and only for a parked id")
    {
        // This is CUnitHandler::GarbageCollectUnit's path — used by
        // SimSnapshot::ApplyUnits (a restore claims the ids it is restoring)
        // and by Spring.DestroyUnit(..., recycleID=true).
        Spend(pool, 3);
        pool.FreeID(3, true);
        CHECK(pool.RecycleID(3) == true);
        CHECK(pool.GetRecycleEpoch() == 1u);
        CHECK(pool.HasID(3) == true);

        // A second call finds nothing parked and must not bump: the announcer
        // keys on the epoch MOVING, so a spurious bump is a spurious flush.
        CHECK(pool.RecycleID(3) == false);
        CHECK(pool.GetRecycleEpoch() == 1u);
    }

    SUBCASE("draining the pool recycles the whole parked set as ONE event")
    {
        // The bulk path, and the reason the guard is an event rather than a
        // per-unit generation on the wire: when freeIDs empties, every parked
        // id becomes re-issuable in one step, so a per-unit encoding would
        // carry no more information than this single bump — at 2 bytes per
        // unit per snapshot forever.
        //
        // Spend the pool one id at a time, parking each as it is spent. The
        // last spend empties freeIDs and drains tempIDs back into it.
        for (uint32_t spent = 0; spent < 8; ++spent) {
            uint32_t taken = 0;
            for (uint32_t id = 0; id < 8; ++id) {
                if (pool.HasID(id)) { taken = id; break; }
            }
            Spend(pool, taken);             // ReserveID: takes it out of freeIDs
            if (spent < 7) {
                CHECK(pool.GetRecycleEpoch() == 0u);
                pool.FreeID(taken, true);   // park it
            }
        }

        // The drain fired exactly once, on the spend that emptied the pool —
        // not once per parked id.
        CHECK(pool.GetRecycleEpoch() == 1u);
        CHECK(pool.GetSize() == 7u);
    }

    SUBCASE("Clear() resets the epoch")
    {
        Spend(pool, 3);
        pool.FreeID(3, true);
        pool.RecycleID(3);
        CHECK(pool.GetRecycleEpoch() == 1u);
        pool.Clear();
        CHECK(pool.GetRecycleEpoch() == 0u);
    }
}

TEST_CASE("S5 task 6: the announcement survives a lane that drops messages")
{
    using EntityState::IdRecycleAnnouncer;

    SUBCASE("a quiet world never flags")
    {
        IdRecycleAnnouncer a;
        for (int i = 0; i < 100; ++i)
            CHECK(a.Tick(0, (i % 10) == 0) == false);
        CHECK(a.IsPending() == false);
    }

    SUBCASE("a recycle mid-period flags every message up to the next snapshot")
    {
        IdRecycleAnnouncer a;
        CHECK(a.Tick(0, true) == false);   // tick 0: full snapshot, quiet
        CHECK(a.Tick(0, false) == false);  // tick 1: delta, quiet

        // tick 2: the pool recycles. Deltas from here to the next full
        // snapshot all carry the flag — the lane is newest-wins, so the one
        // that survives to the client is not knowable here.
        CHECK(a.Tick(1, false) == true);
        CHECK(a.Tick(1, false) == true);
        CHECK(a.Tick(1, false) == true);

        // The full snapshot carries it and retires it.
        CHECK(a.Tick(1, true) == true);
        CHECK(a.IsPending() == false);
        CHECK(a.Tick(1, false) == false);
        CHECK(a.Tick(1, true) == false);
    }

    SUBCASE("a recycle landing ON a snapshot frame is not announced by one message")
    {
        // The failure this rule exists for: retiring on the raising tick would
        // put the whole announcement on a single message, and that message can
        // be superseded on the lane before it is delivered. It has to ride the
        // period that follows.
        IdRecycleAnnouncer a;
        CHECK(a.Tick(1, true) == true);
        CHECK(a.IsPending() == true);
        for (int i = 0; i < 9; ++i)
            CHECK(a.Tick(1, false) == true);
        CHECK(a.Tick(1, true) == true);
        CHECK(a.IsPending() == false);
    }

    SUBCASE("a second recycle inside the window re-arms it")
    {
        IdRecycleAnnouncer a;
        CHECK(a.Tick(1, false) == true);
        CHECK(a.Tick(2, true) == true);   // raised again on the snapshot tick
        CHECK(a.IsPending() == true);     // so it must NOT retire here
        CHECK(a.Tick(2, false) == true);
        CHECK(a.Tick(2, true) == true);
        CHECK(a.IsPending() == false);
    }
}

TEST_CASE("S5 task 6: the flag costs no payload and no field")
{
    // Bit 15 is outside FIELD_ALL, so it can never be mistaken for a field,
    // and a parser that reads each array under its own bit skips it for free.
    CHECK((EntityState::FIELD_ALL & EntityState::FLAG_ID_RECYCLED) == 0);
    CHECK(EntityState::FLAG_ID_RECYCLED == 0x8000);

    // Every declared field bit is inside FIELD_ALL — i.e. bit 15 is not
    // shadowing one that was going to be used.
    CHECK((EntityState::FIELD_ROLL & EntityState::FIELD_ALL) != 0);
    CHECK(EntityState::FIELD_ROLL < EntityState::FLAG_ID_RECYCLED);

    // The seam StateStreamer actually uses: it ORs the flag into the mask it
    // hands the serializer, so the serializer must write it through to the
    // header untouched and must not account for it in the buffer size. An
    // empty roster is enough — the header is where the flag lives.
    const std::vector<CUnit*> none;
    const auto plain = EntityState::SerializeUnits(none, EntityState::FIELD_ALL, -1, 1234);
    const auto flagged = EntityState::SerializeUnits(
        none, EntityState::FIELD_ALL | EntityState::FLAG_ID_RECYCLED, -1, 1234);

    REQUIRE(plain.size() == 8u);
    CHECK(flagged.size() == plain.size());

    auto maskOf = [](const std::vector<uint8_t>& b) {
        return static_cast<uint16_t>(b[6] | (b[7] << 8));
    };
    CHECK(maskOf(plain) == EntityState::FIELD_ALL);
    CHECK(maskOf(flagged) == static_cast<uint16_t>(EntityState::FIELD_ALL
                                                   | EntityState::FLAG_ID_RECYCLED));
    // base_frame + count are byte-identical either way.
    CHECK(std::equal(plain.begin(), plain.begin() + 6, flagged.begin()));
}
