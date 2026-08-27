// PLAN-metalstorm-combat-fixes.md §C1 — "the fallback muzzle emit direction
// points at the sky".
//
// The reported symptom was `Spring.GetUnitWeaponVectors(wz_tank, 1)` answering
// dir (0, 1, 0) on a unit whose barrel the client renders horizontally. §C1
// asked us to decide between two hypotheses: the SPRINGRTS_geometry per-piece
// rest-rotation conversion mishandles leaf pieces (leaving the muzzle's local
// -Z mapped onto world +Y), or the rigs are authored barrel-up.
//
// NEITHER holds. The diagnosis, verified against the shipped content:
//
//   * No metalstorm model authors a rest rotation on ANY piece. Every glTF
//     node matrix in the game is identity-rotation-plus-translation, and no
//     `SPRINGRTS_geometry.pieces[].rot` field appears in any of the 70
//     muzzle/turret/barrel pieces that ship. So the converter has nothing to
//     mishandle and the rigs are not barrel-up: the muzzle's emit dir is
//     exactly its local -Z.
//   * ModelConfigLoader treats an absent `rot` as identity
//     (ModelConfigLoader.cpp:139-151), so nothing is synthesised on load.
//   * CSolidObject::GetObjectSpaceVec negates the z term
//     (SolidObject.h:219), mapping model-space -Z onto the owner's +frontdir.
//     Horizontal in, horizontal out.
//
// The (0,1,0) reading came from the callout, not the model: for every
// projectile type except missile/torpedo/starburst, Spring.GetUnitWeaponVectors
// returns `wantedDir`, not `weaponDir` (LuaSyncedRead.cpp:5259-5266), and
// `wantedDir` is constructor-initialised to UpVector (Weapon.cpp:134) and only
// overwritten by UpdateWantedDir once the weapon has a target. An IDLE weapon
// therefore reports straight up regardless of its muzzle piece — which is
// exactly the state the measurement was taken in.
//
// These tests load the SHIPPED `.gltf` files through the real
// ModelConfigLoader — no synthetic fixture — build a LocalModel exactly as
// CUnit does, and read the emit dir back through the same
// LocalModelPiece::GetEmitDirPos that CWeapon::UpdateWeaponVectors calls on
// the name-convention fallback path.
//
// What they defend going forward is the authoring rule recorded in
// DESIGN-MODEL-BUILDING.md §16c: a muzzle piece's rest orientation must leave
// local -Z horizontal. A rig re-exported barrel-up, or an importer change that
// starts baking a bogus `rot` onto leaf pieces, breaks them here — at content
// build time — instead of downstream in muzzle flashes and ballistic launch
// vectors.
#include <doctest/doctest.h>

#include "Sim/Objects/ModelConfigLoader.h"
#include "Sim/Units/Scripts/LocalModelPieceStub.h"
#include "System/Matrix44f.h"
#include "System/float3.h"

#include <cmath>
#include <string>

namespace {

const std::string kModelDir =
    std::string(SPRING_SOURCE_DIR) + "/data/games/metalstorm/models/";

// Mirror of CWeapon::ResolveFallbackWeaponPieces (Weapon.cpp:244-249): weapon
// slot N (1-based) maps to "muzzle" for slot 1 and "muzzleN" for slot >= 2.
std::string MuzzleName(int slot) {
    return "muzzle" + ((slot <= 1) ? std::string() : std::to_string(slot));
}

// The emit dir as CWeapon::UpdateWeaponVectors reads it on the fallback path,
// in MODEL space — i.e. before owner->GetObjectSpaceVec rotates it into the
// unit's frame. That rotation is a rigid rotation of the owner's basis, so it
// cannot tilt a horizontal model-space dir out of the owner's own horizontal
// plane; checking model space is the meaningful "at rest" statement.
float3 MuzzleEmitDir(const LocalModel& lm, const std::string& pieceName) {
    const LocalModelPiece* p = lm.GetPieceByName(pieceName);
    REQUIRE(p != nullptr);
    float3 pos, dir;
    REQUIRE(p->GetEmitDirPos(pos, dir));
    return dir.SafeNormalize();
}

} // namespace

TEST_SUITE("muzzle emit direction (PLAN-metalstorm-combat-fixes C)") {

    // The two units named in the bug report, loaded from the shipped files.
    TEST_CASE("wz_tank / fable_tank muzzles emit horizontally at rest") {
        for (const char* model : {"wz_tank", "fable_tank"}) {
            CAPTURE(model);
            S3DModel mdl;
            REQUIRE(ModelConfigLoader::LoadInto(mdl, kModelDir + model));

            LocalModel lm;
            lm.SetModel(&mdl);
            REQUIRE(lm.Initialized());

            const float3 dir = MuzzleEmitDir(lm, "muzzle");

            // The acceptance criterion: not pointing at the sky.
            CHECK(std::fabs(dir.y) < 1e-3f);
            // And specifically glTF-native forward, which is what the client
            // draws the barrel along.
            CHECK(dir.x == doctest::Approx(0.0f).epsilon(0.001));
            CHECK(dir.z == doctest::Approx(-1.0f).epsilon(0.001));
        }
    }

    // The muzzle sits several pieces deep (fable_tank: body -> turret ->
    // barrel -> muzzle). Pin that the parent-chain walk contributes only
    // translation, i.e. the muzzle really is at the barrel tip and still
    // pointing along it — a rest rotation wrongly baked onto ANY ancestor
    // would swing the leaf's -Z and fail the dir check above.
    TEST_CASE("the muzzle sits at the barrel tip, not the unit centre") {
        S3DModel mdl;
        REQUIRE(ModelConfigLoader::LoadInto(mdl, kModelDir + "fable_tank"));
        LocalModel lm;
        lm.SetModel(&mdl);

        const LocalModelPiece* muzzle = lm.GetPieceByName("muzzle");
        REQUIRE(muzzle != nullptr);
        const float3 pos = muzzle->GetAbsolutePos();

        // turret (0, 14.4, 2.4) + barrel (0, 5.28, -9.2) + muzzle (0, 0, -36.96)
        // — the authored metre offsets (1.8/0.3, 0.66/-1.15, 0/-4.62) ×8,
        // in elmos since the world-scale re-import (PLAN-world-scale.md §5
        // Option A, 2026-08-27; DESIGN-MODEL-BUILDING.md §12).
        CHECK(pos.x == doctest::Approx(0.0f).epsilon(0.001));
        CHECK(pos.y == doctest::Approx(19.68f).epsilon(0.001));
        CHECK(pos.z == doctest::Approx(-43.76f).epsilon(0.001));
    }

    // The authoring rule, applied to everything that ships. Any model that
    // grows a muzzle piece inherits this check for free.
    TEST_CASE("every shipped metalstorm muzzle piece is horizontal") {
        // Models with at least one name-convention muzzle piece, and how many
        // weapon slots each one names. Kept explicit rather than globbed so a
        // model that silently LOSES its muzzle piece shows up as a lookup
        // failure instead of quietly dropping out of the sweep.
        struct Rig { const char* model; int slots; };
        const Rig rigs[] = {
            {"wz_tank",          1},
            {"wz_wheeled",       1},
            {"wz_cyborg",        1},
            {"fable_tank",       1},
            {"fable_train_gun",  3},
        };

        for (const Rig& rig : rigs) {
            CAPTURE(rig.model);
            S3DModel mdl;
            REQUIRE(ModelConfigLoader::LoadInto(mdl, kModelDir + rig.model));
            LocalModel lm;
            lm.SetModel(&mdl);

            for (int slot = 1; slot <= rig.slots; ++slot) {
                CAPTURE(slot);
                const float3 dir = MuzzleEmitDir(lm, MuzzleName(slot));

                // The rule: horizontal. This is what §C is about, and it is
                // the only claim that holds for every rig here.
                CHECK(std::fabs(dir.y) < 1e-3f);

                // Because no shipped rig carries a rest rotation, every emit
                // dir is the untouched local -Z. Asserting the exact vector
                // (rather than a loose "forward-ish" bound) is what makes a
                // newly-baked `rot` on any piece or ancestor fail here.
                CHECK(dir.x == doctest::Approx(0.0f).epsilon(0.001));
                CHECK(dir.z == doctest::Approx(-1.0f).epsilon(0.001));
            }
        }

        // NOTE, deliberately not asserted: on fable_train_gun the slot-2
        // chain (turret2 -> barrel2 -> muzzle2) is translated toward +Z — a
        // rear-facing turret — while its emit dir, like every other piece in
        // the game, is -Z. So that muzzle emits out the front of a barrel
        // that points out the back. That is a real content inconsistency, but
        // it is a BACKWARDS dir, not a vertical one, and fixing it means
        // authoring a rest rotation on turret2 (or mirroring the rig), which
        // is out of scope for §C. Recorded here so the next person to touch
        // fable_train_gun finds it. The horizontality rule above is unaffected.
    }

    // Proof the checks above discriminate. A rig authored barrel-up — the
    // hypothesis §C1 asked us to rule out — carries a rest rotation that maps
    // local -Z onto +Y, and that is exactly what the sweep would catch.
    // Without this case, "no shipped rig is vertical" could be vacuously true
    // because the check itself was broken.
    TEST_CASE("a barrel-up rest rotation IS caught by these checks") {
        S3DModel mdl;
        mdl.pieces.resize(2);
        mdl.pieces[0].name = "turret";
        mdl.pieces[1].name = "muzzle";
        mdl.pieces[1].parent = &mdl.pieces[0];
        mdl.pieces[0].children.push_back(&mdl.pieces[1]);
        mdl.numPieces = 2;

        // Rx(+90) — columns (1,0,0), (0,0,1), (0,-1,0) — so the piece's local
        // -Z maps to -c2 = +Y: barrel straight up. Written column-wise the way
        // ModelConfigLoader loads `pieces[].rot` (SetX/Y/Z are R's columns).
        mdl.pieces[1].bakedRotMatrix.SetX(float3(1, 0, 0));
        mdl.pieces[1].bakedRotMatrix.SetY(float3(0, 0, 1));
        mdl.pieces[1].bakedRotMatrix.SetZ(float3(0, -1, 0));
        mdl.pieces[1].hasBakedRot = true;

        LocalModel lm;
        lm.SetModel(&mdl);

        const float3 dir = MuzzleEmitDir(lm, "muzzle");
        CHECK(dir.y == doctest::Approx(1.0f).epsilon(0.001));
        // The horizontality assertion the sweep makes would fail here...
        CHECK_FALSE(std::fabs(dir.y) < 1e-3f);
        // ...and so would step A's near-vertical trigger, below.
        CHECK(std::fabs(dir.dot(UpVector)) > 0.99f);
    }

    // The step-A safety net's trigger condition, stated as a property of the
    // shipped content: no metalstorm muzzle is near-vertical, so
    // UpdateWeaponVectors' |dir.dot(UpVector)| > 0.99 substitution never fires
    // on this game's rigs. It is there for content that has not been written
    // yet, not to paper over these models.
    TEST_CASE("the near-vertical safety net does not fire on shipped rigs") {
        for (const char* model : {"wz_tank", "wz_wheeled", "wz_cyborg",
                                  "fable_tank", "fable_train_gun"}) {
            CAPTURE(model);
            S3DModel mdl;
            REQUIRE(ModelConfigLoader::LoadInto(mdl, kModelDir + model));
            LocalModel lm;
            lm.SetModel(&mdl);

            const float3 dir = MuzzleEmitDir(lm, "muzzle");
            CHECK(std::fabs(dir.dot(UpVector)) <= 0.99f);
        }
    }
}
