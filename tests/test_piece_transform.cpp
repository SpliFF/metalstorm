// Sign-convention tests for the headless server's LocalModelPiece stub.
//
// Spring scripts call `Turn(piece, y_axis, +angle, ...)` expecting the piece's
// forward (+Z) basis to rotate by +angle around the unit-up axis using
// Spring's left-handed convention — positive yaw rotates +Z towards +X.
// Upstream Recoil composes the piece-space transform via
// `CQuaternion::FromEulerYPRNeg(-r)`, equivalent to
// `CMatrix44f::RotateEulerYXZ(-r)` per Quaternion.cpp:72.
//
// These tests pin down that convention so a future "tidy up" of the stub
// doesn't reintroduce the sign flip that produced the off-axis aim bug
// captured in memory/project_zk_aim_bench.md.
#include <doctest/doctest.h>
#include "Sim/Units/Scripts/LocalModelPieceStub.h"
#include "System/float3.h"
#include "System/Matrix44f.h"
#include <cmath>

namespace {
constexpr float kAimEps = 1e-4f;

float3 RotatedZ(const LocalModelPiece& p) {
    const CMatrix44f m = p.GetModelSpaceMatrix();
    const float3 origin = m.GetPos();
    return (m * float3(0.0f, 0.0f, 1.0f)) - origin;
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

    TEST_CASE("positive yaw rotates +Z towards +X (Spring left-handed)") {
        LocalModelPiece p;
        // 45 degrees positive yaw — Turn(piece, y_axis, math.rad(45)).
        // Spring scripts expect the piece's forward to rotate east.
        p.SetRotation(float3(0.0f, static_cast<float>(M_PI) * 0.25f, 0.0f));
        const float3 z = RotatedZ(p);
        const float r = std::sqrt(0.5f);
        CHECK(z.x == doctest::Approx(r).epsilon(kAimEps));
        CHECK(z.y == doctest::Approx(0.0f).epsilon(kAimEps));
        CHECK(z.z == doctest::Approx(r).epsilon(kAimEps));
    }

    TEST_CASE("negative yaw rotates +Z towards -X") {
        LocalModelPiece p;
        p.SetRotation(float3(0.0f, -static_cast<float>(M_PI) * 0.25f, 0.0f));
        const float3 z = RotatedZ(p);
        const float r = std::sqrt(0.5f);
        CHECK(z.x == doctest::Approx(-r).epsilon(kAimEps));
        CHECK(z.y == doctest::Approx(0.0f).epsilon(kAimEps));
        CHECK(z.z == doctest::Approx(r).epsilon(kAimEps));
    }

    TEST_CASE("parent yaw composes with child translation") {
        // Mirrors ZK's tankarty chain: turret yawed -17deg, barrel offset
        // by +Z inside the turret. With the correct sign convention the
        // barrel's model-space origin should sweep with the turret.
        LocalModelPiece turret;
        const float yaw = -static_cast<float>(M_PI) / 180.0f * 17.0f;
        turret.SetRotation(float3(0.0f, yaw, 0.0f));

        LocalModelPiece barrel;
        barrel.SetPosition(float3(0.0f, 0.0f, 10.0f));
        barrel.parent = &turret;

        const CMatrix44f m = barrel.GetModelSpaceMatrix();
        const float3 origin = m.GetPos();
        CHECK(origin.x == doctest::Approx(10.0f * std::sin(yaw)).epsilon(kAimEps));
        CHECK(origin.z == doctest::Approx(10.0f * std::cos(yaw)).epsilon(kAimEps));

        // Barrel's +Z should match the turret's yawed +Z direction.
        const float3 dir = (m * float3(0.0f, 0.0f, 1.0f)) - origin;
        CHECK(dir.x == doctest::Approx(std::sin(yaw)).epsilon(kAimEps));
        CHECK(dir.z == doctest::Approx(std::cos(yaw)).epsilon(kAimEps));
    }

    TEST_CASE("GetEmitDirPos yields piece origin and rotated +Z") {
        LocalModelPiece turret;
        const float yaw = static_cast<float>(M_PI) * 0.5f; // +90deg
        turret.SetRotation(float3(0.0f, yaw, 0.0f));

        LocalModelPiece flare;
        flare.SetPosition(float3(0.0f, 2.0f, 5.0f));
        flare.parent = &turret;

        float3 pos, dir;
        REQUIRE(flare.GetEmitDirPos(pos, dir));

        // +90deg yaw: forward (+Z) rotates to +X, so a piece at local
        // (0, 2, 5) sweeps round to roughly (5, 2, 0).
        CHECK(pos.x == doctest::Approx(5.0f).epsilon(kAimEps));
        CHECK(pos.y == doctest::Approx(2.0f).epsilon(kAimEps));
        CHECK(pos.z == doctest::Approx(0.0f).epsilon(kAimEps));

        CHECK(dir.x == doctest::Approx(1.0f).epsilon(kAimEps));
        CHECK(dir.y == doctest::Approx(0.0f).epsilon(kAimEps));
        CHECK(dir.z == doctest::Approx(0.0f).epsilon(kAimEps));
    }
}
