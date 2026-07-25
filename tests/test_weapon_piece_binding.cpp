// BUG A regression: scriptless (null-script) units must bind each weapon's
// muzzle/aim piece from the model by the authoring name convention, so
// ProjectileFired events carry the true per-turret muzzle position on
// multi-turret units (e.g. Metalstorm's fable_train_gun with three roof
// weapons: turret/muzzle, turret2/muzzle2, turret3/muzzle3).
//
// The full path (CWeapon::ResolveFallbackWeaponPieces) needs a live CUnit +
// CWeapon, which the headless test harness doesn't stand up. These tests pin
// the two pieces that path is built on:
//   1. LocalModel::GetPieceByName — case-insensitive name → piece lookup.
//   2. The slot → piece-name convention (weapon slot N maps to "muzzle"/
//      "turret" for slot 1 and "muzzleN"/"turretN" for slot ≥ 2), asserting
//      the three weapons of a fable_train_gun-shaped model resolve to three
//      DISTINCT muzzle pieces rather than all collapsing onto a bare "muzzle".
#include <doctest/doctest.h>
#include "Sim/Units/Scripts/LocalModelPieceStub.h"
#include <string>
#include <vector>

namespace {
// Build a fable_train_gun-shaped model: body → {turret/barrel/muzzle,
// turret2/barrel2/muzzle2, turret3/barrel3/muzzle3} plus a couple of decoys
// whose names merely *start* with "muzzle"/"turret" (must NOT match an exact
// lookup). Names mirror data/games/metalstorm/models/fable_train_gun.gltf.
S3DModel MakeGunCarModel() {
    S3DModel m;
    const char* names[] = {
        "body",
        "turret",  "barrel",  "muzzle",
        "turret2", "barrel2", "muzzle2",
        "turret3", "barrel3", "muzzle3",
        "muzzleflash_decoy", "TurretRing",
    };
    for (const char* n : names) {
        S3DModelPiece p;
        p.name = n;
        m.pieces.push_back(p);
    }
    m.numPieces = static_cast<int>(m.pieces.size());
    return m;
}

// Mirror of CWeapon::ResolveFallbackWeaponPieces' name convention: weaponNum
// is 0-based; the model names slot 1 without a suffix.
std::string MuzzleNameForWeapon(int weaponNum) {
    const int slot = weaponNum + 1;
    return "muzzle" + ((slot <= 1) ? std::string() : std::to_string(slot));
}
std::string TurretNameForWeapon(int weaponNum) {
    const int slot = weaponNum + 1;
    return "turret" + ((slot <= 1) ? std::string() : std::to_string(slot));
}
} // namespace

TEST_SUITE("weapon piece binding (BUG A)") {
    TEST_CASE("GetPieceByName resolves exact names case-insensitively") {
        S3DModel mdl = MakeGunCarModel();
        LocalModel lm;
        lm.SetModel(&mdl);

        CHECK(lm.GetPieceByName("muzzle")  != nullptr);
        CHECK(lm.GetPieceByName("MUZZLE")  != nullptr);   // case-insensitive
        CHECK(lm.GetPieceByName("Muzzle2") != nullptr);
        CHECK(lm.GetPieceByName("turret3") != nullptr);

        // Exact-match only — a longer name that merely starts with "muzzle"
        // must not be returned for "muzzle".
        CHECK(lm.GetPieceByName("muzzle") != lm.GetPieceByName("muzzleflash_decoy"));
        CHECK(lm.GetPieceByName("muzzleflash_decoy") != nullptr);

        // Absent names resolve to null.
        CHECK(lm.GetPieceByName("muzzle4") == nullptr);
        CHECK(lm.GetPieceByName("")        == nullptr);
    }

    TEST_CASE("three weapons resolve to three DISTINCT muzzle/turret pieces") {
        S3DModel mdl = MakeGunCarModel();
        LocalModel lm;
        lm.SetModel(&mdl);

        // Weapons 0,1,2 (def slots 1,2,3) → muzzle, muzzle2, muzzle3.
        const LocalModelPiece* m0 = lm.GetPieceByName(MuzzleNameForWeapon(0));
        const LocalModelPiece* m1 = lm.GetPieceByName(MuzzleNameForWeapon(1));
        const LocalModelPiece* m2 = lm.GetPieceByName(MuzzleNameForWeapon(2));
        REQUIRE(m0 != nullptr);
        REQUIRE(m1 != nullptr);
        REQUIRE(m2 != nullptr);
        // The whole point of BUG A: NOT all the same piece.
        CHECK(m0 != m1);
        CHECK(m1 != m2);
        CHECK(m0 != m2);
        CHECK(m0->original->name == "muzzle");
        CHECK(m1->original->name == "muzzle2");
        CHECK(m2->original->name == "muzzle3");

        // Aim pieces resolve to the matching turret per slot.
        CHECK(lm.GetPieceByName(TurretNameForWeapon(0))->original->name == "turret");
        CHECK(lm.GetPieceByName(TurretNameForWeapon(1))->original->name == "turret2");
        CHECK(lm.GetPieceByName(TurretNameForWeapon(2))->original->name == "turret3");
    }

    TEST_CASE("single-turret model: slot-1 weapon binds the bare muzzle") {
        // Most units carry one weapon and a single "turret"/"muzzle" pair.
        S3DModel m;
        for (const char* n : {"body", "turret", "muzzle"}) {
            S3DModelPiece p; p.name = n; m.pieces.push_back(p);
        }
        m.numPieces = static_cast<int>(m.pieces.size());
        LocalModel lm;
        lm.SetModel(&m);

        CHECK(lm.GetPieceByName(MuzzleNameForWeapon(0)) != nullptr);
        CHECK(lm.GetPieceByName(TurretNameForWeapon(0)) != nullptr);
        // No second weapon piece exists — a would-be slot-2 lookup is null,
        // which is what makes the CWeapon fallback leave it unbound cleanly.
        CHECK(lm.GetPieceByName(MuzzleNameForWeapon(1)) == nullptr);
    }
}
