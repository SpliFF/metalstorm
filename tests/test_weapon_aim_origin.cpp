// Regression: a weapon whose aim/muzzle origin resolves to the unit's feet
// gets popped clear of the ground by CWeapon::UpdateWeaponVectors. That lift
// used to be a flat 10 elmos (stock Recoil's `UpVector * 10`, widened here by
// a radius term), which silently assumes Spring-scale models — stock units are
// 30-100 elmos tall.
//
// Metalstorm models are metre-scale. Measured 2026-08-03 on meridian_basin:
// ms_soldiers_s1 is 1.845 elmos tall and its .gltf authors a SINGLE `body`
// piece, so neither the unit script nor the name-convention fallback
// (ResolveFallbackWeaponPieces, see test_weapon_piece_binding.cpp) binds a
// muzzle or turret. relAimFromPos stays ZeroVector, aimFromPos lands exactly
// at the unit's feet, and the ground-clearance branch fires on every shot —
// lifting the firing origin to 10 elmos, 5.4x the model's own height.
// Everything downstream then reads from that empty air: the
// HaveFreeLineOfFire ray, the firing distance feeding
// StatCombat::HitProbability, and the VolleyOutcome attacker/counterbattery
// position.
//
// CWeapon::GroundClearanceLift is the pure part of that computation, split out
// so it can be pinned without standing up a live CUnit + CWeapon (which the
// headless harness does not do — same constraint as
// test_weapon_piece_binding.cpp).
//
// The invariant these tests pin: the lift NEVER exceeds the stock value (so no
// existing game's behaviour is amplified), and for a model shorter than the
// stock lift it equals that model's own half-height — i.e. the weapon fires
// from the model's centre, which is where a weapon with no authored muzzle
// piece belongs.
#include <doctest/doctest.h>

#include "Sim/Weapons/Weapon.h"

namespace {
// Stock lift, reproduced here so the tests assert against the rule rather
// than against the implementation they are pinning.
float StockLift(float radius) {
    return (10.0f > radius * 0.5f) ? 10.0f : radius * 0.5f;
}
} // namespace

TEST_SUITE("weapon aim origin ground-clearance lift") {

    // The reported bug, with the real measured numbers.
    TEST_CASE("metre-scale infantry fires from its own centre, not 10 elmos up") {
        // data/games/metalstorm/models/ms_soldiers_s1.gltf: height 1.845,
        // midpos.y 0.9225, model radius 1.0149.
        const float lift = CWeapon::GroundClearanceLift(1.0149f, 1.845f);

        // Old behaviour was a flat 10.0 — 5.4x the model's own height.
        CHECK(lift < 10.0f);
        // New behaviour: the model's half-height, i.e. its authored midpos.
        CHECK(lift == doctest::Approx(0.9225f).epsilon(0.001));
    }

    TEST_CASE("metre-scale vehicles land at their own mid-height") {
        // fable_tank (ms_tanks_s2): height 3.18, midpos.y 1.59, radius 5.7692.
        CHECK(CWeapon::GroundClearanceLift(5.7692f, 3.18f)
              == doctest::Approx(1.59f).epsilon(0.001));
        // wz_wheeled (ms_tanks_s1): height 1.8857, midpos.y 0.94286.
        CHECK(CWeapon::GroundClearanceLift(4.0622f, 1.8857f)
              == doctest::Approx(0.94285f).epsilon(0.001));
        // ms_staticdefense_s1: height 2.68, midpos.y 1.34.
        CHECK(CWeapon::GroundClearanceLift(4.2829f, 2.68f)
              == doctest::Approx(1.34f).epsilon(0.001));
    }

    // The faithful path must not move: PLAN-macro-combat.md §5 keeps ZK/BAR
    // on stock behaviour, and these lifts are shared engine code.
    TEST_CASE("Spring-scale models keep the stock lift") {
        // A typical ZK/BAR ground unit: tens of elmos tall, radius ~30.
        CHECK(CWeapon::GroundClearanceLift(30.0f, 40.0f)
              == doctest::Approx(StockLift(30.0f)));
        // A small Spring-scale unit: half-height still exceeds the flat 10.
        CHECK(CWeapon::GroundClearanceLift(12.0f, 25.0f)
              == doctest::Approx(10.0f));
        // Exactly at the boundary — half-height == the flat 10.
        CHECK(CWeapon::GroundClearanceLift(12.0f, 20.0f)
              == doctest::Approx(10.0f));
    }

    TEST_CASE("the lift never exceeds the stock value at any scale") {
        const float radii[]   = {0.5f, 1.0f, 4.0f, 12.0f, 30.0f, 120.0f};
        const float heights[] = {0.4f, 1.845f, 3.18f, 20.0f, 40.0f, 300.0f};
        for (float r : radii) {
            for (float h : heights) {
                const float lift = CWeapon::GroundClearanceLift(r, h);
                CHECK(lift <= StockLift(r) + 1e-4f);
                CHECK(lift > 0.0f);
            }
        }
    }

    TEST_CASE("a missing or degenerate model falls back safely") {
        // No model at all (height 0) -> stock lift, unchanged behaviour.
        CHECK(CWeapon::GroundClearanceLift(30.0f, 0.0f)
              == doctest::Approx(StockLift(30.0f)));
        CHECK(CWeapon::GroundClearanceLift(1.0f, 0.0f)
              == doctest::Approx(10.0f));
        // A degenerate sliver of a model must still clear the terrain.
        CHECK(CWeapon::GroundClearanceLift(1.0f, 0.2f)
              == doctest::Approx(0.5f));
    }
}
