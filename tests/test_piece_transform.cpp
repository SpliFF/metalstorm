// Sign-convention tests for the headless server's LocalModelPiece stub
// under the RH world (PLAN-coordinate-system Phase 2+).
//
// Spring scripts call `Turn(piece, axis, +angle)` and expect a specific
// visual effect — `Turn(y, +a)` turns RIGHT, `Turn(x, +a)` pitches DOWN,
// `Turn(z, +a)` rolls RIGHT — preserved from the original LH authoring
// convention. The stub composes per-piece transforms via Spring's
// LH-canonical `RotateEulerYXZ(rot)` primitives, which under RH semantics
// produce exactly that visual: LH RotY(+a) is numerically RH RotY(-a),
// and the script's "+a means right" intent maps cleanly.
//
// These tests pin down the resulting matrix so a future "tidy up" of the
// stub doesn't reintroduce a sign flip. The earlier Phase 2a attempt to
// special-case Z (`R(rot.x, rot.y, -rot.z)`) inverted X/Y rotations and
// caused legs to render up and turrets to aim mirrored.
#include <doctest/doctest.h>
#include "Sim/Units/Scripts/LocalModelPieceStub.h"
#include "System/float3.h"
#include "System/Matrix44f.h"
#include <cmath>

namespace {
constexpr float kAimEps = 1e-4f;

// The piece's local +Z basis (back-of-piece in RH) after the chain.
float3 RotatedZ(const LocalModelPiece& p) {
    const CMatrix44f m = p.GetModelSpaceMatrix();
    const float3 origin = m.GetPos();
    return (m * float3(0.0f, 0.0f, 1.0f)) - origin;
}

// The piece's local -Z basis = forward / muzzle direction in RH.
float3 RotatedNegZ(const LocalModelPiece& p) {
    const CMatrix44f m = p.GetModelSpaceMatrix();
    const float3 origin = m.GetPos();
    return (m * float3(0.0f, 0.0f, -1.0f)) - origin;
}
}

TEST_SUITE("LocalModelPiece transform") {
    TEST_CASE("identity rotation leaves +Z basis pointing +Z") {
        LocalModelPiece p;
        const float3 z = RotatedZ(p);
        CHECK(z.x == doctest::Approx(0.0f).epsilon(kAimEps));
        CHECK(z.y == doctest::Approx(0.0f).epsilon(kAimEps));
        CHECK(z.z == doctest::Approx(1.0f).epsilon(kAimEps));
    }

    TEST_CASE("positive yaw = turn right (-Z forward swings to +X)") {
        // Spring script: Turn(piece, y_axis, math.rad(45)) = turn 45° right.
        // In RH, "right" is +X and "forward" is -Z. The piece's forward
        // (-Z basis) should rotate towards +X by 45°.
        LocalModelPiece p;
        p.SetRotation(float3(0.0f, static_cast<float>(M_PI) * 0.25f, 0.0f));
        const float3 fwd = RotatedNegZ(p);
        const float r = std::sqrt(0.5f);
        CHECK(fwd.x == doctest::Approx(r).epsilon(kAimEps));      // RIGHT
        CHECK(fwd.y == doctest::Approx(0.0f).epsilon(kAimEps));
        CHECK(fwd.z == doctest::Approx(-r).epsilon(kAimEps));     // FORWARD
    }

    TEST_CASE("negative yaw = turn left (-Z forward swings to -X)") {
        LocalModelPiece p;
        p.SetRotation(float3(0.0f, -static_cast<float>(M_PI) * 0.25f, 0.0f));
        const float3 fwd = RotatedNegZ(p);
        const float r = std::sqrt(0.5f);
        CHECK(fwd.x == doctest::Approx(-r).epsilon(kAimEps));     // LEFT
        CHECK(fwd.y == doctest::Approx(0.0f).epsilon(kAimEps));
        CHECK(fwd.z == doctest::Approx(-r).epsilon(kAimEps));     // FORWARD
    }

    TEST_CASE("positive pitch = barrel tilts down (-Z forward swings to -Y)") {
        // Spring script: Turn(barrel, x_axis, +pitch) pitches the barrel
        // DOWN per the convention (engine pitch < 0 for targets below
        // horizon → script passes +|pitch|). Forward axis (-Z) should
        // rotate towards -Y.
        LocalModelPiece p;
        p.SetRotation(float3(static_cast<float>(M_PI) * 0.25f, 0.0f, 0.0f));
        const float3 fwd = RotatedNegZ(p);
        const float r = std::sqrt(0.5f);
        CHECK(fwd.x == doctest::Approx(0.0f).epsilon(kAimEps));
        CHECK(fwd.y == doctest::Approx(-r).epsilon(kAimEps));     // DOWN
        CHECK(fwd.z == doctest::Approx(-r).epsilon(kAimEps));     // FORWARD
    }

    TEST_CASE("negative pitch = barrel tilts up (-Z forward swings to +Y)") {
        LocalModelPiece p;
        p.SetRotation(float3(-static_cast<float>(M_PI) * 0.25f, 0.0f, 0.0f));
        const float3 fwd = RotatedNegZ(p);
        const float r = std::sqrt(0.5f);
        CHECK(fwd.x == doctest::Approx(0.0f).epsilon(kAimEps));
        CHECK(fwd.y == doctest::Approx(r).epsilon(kAimEps));      // UP
        CHECK(fwd.z == doctest::Approx(-r).epsilon(kAimEps));     // FORWARD
    }

    TEST_CASE("parent yaw composes with child translation") {
        // Tankarty chain: turret yawed -17° (= +17° left from forward),
        // barrel offset +25 along the parent's +Y (which is invariant under
        // the yaw). Origin should sweep in the world's XZ plane.
        LocalModelPiece turret;
        const float yaw = -static_cast<float>(M_PI) / 180.0f * 17.0f;
        turret.SetRotation(float3(0.0f, yaw, 0.0f));

        LocalModelPiece barrel;
        barrel.SetPosition(float3(0.0f, 0.0f, 10.0f));
        barrel.parent = &turret;

        const CMatrix44f m = barrel.GetModelSpaceMatrix();
        const float3 origin = m.GetPos();
        // LH RotY(yaw) sends (0,0,10) → (-10*sin(yaw), 0, 10*cos(yaw))
        // (the LH primitive is numerically RH RotY(-yaw)).
        CHECK(origin.x == doctest::Approx(-10.0f * std::sin(yaw)).epsilon(kAimEps));
        CHECK(origin.y == doctest::Approx(0.0f).epsilon(kAimEps));
        CHECK(origin.z == doctest::Approx(10.0f * std::cos(yaw)).epsilon(kAimEps));

        // Barrel's forward (-Z) should match the turret's yawed -Z direction:
        // for yaw=-17° in RH this is "turn 17° left" → forward leans toward -X.
        const float3 fwd = RotatedNegZ(barrel);
        CHECK(fwd.x == doctest::Approx(std::sin(yaw)).epsilon(kAimEps));
        CHECK(fwd.z == doctest::Approx(-std::cos(yaw)).epsilon(kAimEps));
    }

    TEST_CASE("multi-piece chain: turret yaw + barrel pitch composes correctly") {
        // Live ZK turretlaser chain regression: barrel pointed up when
        // target was below muzzle. With the corrected RH composition the
        // barrel's forward direction projects through the turret yaw and
        // gets a small -Y component from the +pitch.
        //
        // Topology: root → turret(yaw=+π/2 at (0,40,0)) → barrel(pitch=+0.197 at (0,25.6,0))
        // +π/2 yaw in RH = "turn right 90°" sends forward (-Z) → +X.
        // +0.197 pitch in RH gives the pre-yaw forward a small -Y tilt.
        // After the turret yaw rotates the tilted forward into world,
        // the y-component is preserved and the in-plane component lands on +X.
        LocalModelPiece root;
        LocalModelPiece turret;
        turret.SetPosition(float3(0.0f, 40.0f, 0.0f));
        turret.SetRotation(float3(0.0f, static_cast<float>(M_PI) * 0.5f, 0.0f));
        turret.parent = &root;

        LocalModelPiece barrel;
        barrel.SetPosition(float3(0.0f, 25.6f, 0.0f));
        barrel.SetRotation(float3(0.197f, 0.0f, 0.0f));
        barrel.parent = &turret;

        const float3 fwd = RotatedNegZ(barrel);
        CHECK(fwd.x == doctest::Approx(std::cos(0.197f)).epsilon(kAimEps));   // ≈ +0.981 (RIGHT)
        CHECK(fwd.y == doctest::Approx(-std::sin(0.197f)).epsilon(kAimEps));  // ≈ -0.196 (DOWN)
        CHECK(fwd.z == doctest::Approx(0.0f).epsilon(kAimEps));
    }

    TEST_CASE("GetEmitDirPos yields piece origin and rotated -Z") {
        LocalModelPiece turret;
        const float yaw = static_cast<float>(M_PI) * 0.5f; // +90deg, turn right in RH
        turret.SetRotation(float3(0.0f, yaw, 0.0f));

        LocalModelPiece flare;
        flare.SetPosition(float3(0.0f, 2.0f, 5.0f));
        flare.parent = &turret;

        float3 pos, dir;
        REQUIRE(flare.GetEmitDirPos(pos, dir));

        // +90deg yaw in RH: forward (-Z) rotates to +X, so a piece at
        // local (0, 2, 5) (= 5 units "back" along +Z) sweeps round to
        // world (-5, 2, 0).
        CHECK(pos.x == doctest::Approx(-5.0f).epsilon(kAimEps));
        CHECK(pos.y == doctest::Approx(2.0f).epsilon(kAimEps));
        CHECK(pos.z == doctest::Approx(0.0f).epsilon(kAimEps));

        // Emit direction is -Z basis: after +90° yaw, originally -Z
        // (forward) now points to +X.
        CHECK(dir.x == doctest::Approx(1.0f).epsilon(kAimEps));
        CHECK(dir.y == doctest::Approx(0.0f).epsilon(kAimEps));
        CHECK(dir.z == doctest::Approx(0.0f).epsilon(kAimEps));
    }
}
