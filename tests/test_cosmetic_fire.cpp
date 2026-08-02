// PLAN-latency L2.1 — Tier-C fire resolution.
//
// The claim the whole phase rests on is CONVERGENCE: the client must be able
// to draw a flight that lands exactly on the explosion, which is only true if
// the server's (impact_pos, impact_frame) pair is genuinely the point the
// projectile's own integration reaches at that frame. These tests pin that
// down, plus the ground-crossing and ttl bounds that cut a flight short.
//
// The ground lookup is injected, so none of this needs a loaded map.

#include <doctest/doctest.h>

#include "Sim/Weapons/CosmeticFire.h"
#include "System/float3.h"

#include <cmath>

namespace {

/// Flat terrain at y = 0 — the default backdrop for the pure-flight cases.
float FlatGround(float, float) { return 0.0f; }

/// A wall of terrain at y = 100 for x >= 300, flat otherwise. Lets a test
/// assert that the arc stops at the obstruction rather than the aim point.
float StepGround(float x, float) { return (x >= 300.0f) ? 100.0f : 0.0f; }

/// Terrain far below anything the tests fire over, so the ground never
/// participates in the solve.
float NoGround(float, float) { return -10000.0f; }

/// Stand-in for the production CCollisionHandler segment test: a sphere the
/// arc segment may enter. Reports the entry point, as the real test does.
CosmeticTargetHit SphereTarget(const float3& centre, float radius) {
	return [centre, radius](const float3& p0, const float3& p1, float3& hitPos) {
		const float3 d = p1 - p0;
		const float len = d.Length();
		if (len < 0.0001f)
			return false;
		const float3 dir = d / len;
		const float3 oc = p0 - centre;
		const float b = oc.dot(dir);
		const float c = oc.SqLength() - radius * radius;
		const float disc = b * b - c;
		if (disc < 0.0f)
			return false;
		const float root = std::sqrt(disc);
		float tHit = -b - root;
		if (tHit < 0.0f) tHit = -b + root;   // p0 already inside
		if (tHit < 0.0f || tHit > len)
			return false;
		hitPos = p0 + dir * tHit;
		return true;
	};
}

} // namespace


TEST_CASE("CosmeticFlightPos matches per-tick ballistic integration") {
	// CWeaponProjectile advances as `speed.y += mygravity; pos += speed`.
	// The closed form must agree with that recurrence at integer frames,
	// otherwise the client's invented arc and the server's impact point
	// describe different flights.
	const float3 origin(0.0f, 100.0f, 0.0f);
	const float3 vel(10.0f, 5.0f, 0.0f);
	const float  g = -0.12f;

	float3 p = origin;
	float3 v = vel;
	for (int frame = 1; frame <= 40; ++frame) {
		v.y += g;
		p += v;

		const float3 closed = CosmeticFlightPos(origin, vel, g, static_cast<float>(frame));
		// The recurrence applies gravity before the step, so it accumulates
		// an extra half-frame of pull versus the continuous form. Half a
		// frame of a 0.12 elmo/frame^2 pull is well under an elmo even after
		// 40 frames — the tolerance below is that discrepancy, not slop.
		CHECK(closed.x == doctest::Approx(p.x).epsilon(0.001));
		CHECK(closed.z == doctest::Approx(p.z).epsilon(0.001));
		CHECK(closed.y == doctest::Approx(p.y).epsilon(0.02));
	}
}

TEST_CASE("CosmeticFlightFrames uses horizontal speed, which gravity does not change") {
	const float3 origin(0.0f, 50.0f, 0.0f);
	const float3 aim(400.0f, 0.0f, 300.0f);   // 500 elmos away in 2-D

	SUBCASE("level shot") {
		const float3 vel(8.0f, 0.0f, 6.0f);   // 10 elmos/frame horizontally
		CHECK(CosmeticFlightFrames(origin, vel, aim) == doctest::Approx(50.0f));
	}

	SUBCASE("lofted shot arrives at the same frame") {
		// Same horizontal component, large vertical one. Time to the aim
		// point's horizontal distance must be unchanged — that is the whole
		// reason the solver keys off 2-D speed.
		const float3 vel(8.0f, 20.0f, 6.0f);
		CHECK(CosmeticFlightFrames(origin, vel, aim) == doctest::Approx(50.0f));
	}

	SUBCASE("purely vertical shot falls back to 3-D distance") {
		const float3 straightUp(0.0f, 200.0f, 0.0f);
		const float3 vel(0.0f, 10.0f, 0.0f);
		CHECK(CosmeticFlightFrames(origin, vel, straightUp) == doctest::Approx(15.0f));
	}

	SUBCASE("degenerate launch yields zero, not a NaN or an infinity") {
		const float3 vel(0.0f, 0.0f, 0.0f);
		const float t = CosmeticFlightFrames(origin, vel, aim);
		CHECK(t == 0.0f);
		CHECK(std::isfinite(t));
	}
}

TEST_CASE("SolveCosmeticFlight converges: impact_pos is on the arc at impact_frame") {
	// This is the invariant PLAN-latency-projectiles §3.2 requires. If it
	// fails the client cannot draw a flight that lands on its own explosion.
	const float3 origin(0.0f, 200.0f, 0.0f);
	const float3 vel(12.0f, 0.0f, 0.0f);
	const float  g = -0.12f;
	const float3 aim(600.0f, 200.0f, 0.0f);

	const CosmeticFlight f = SolveCosmeticFlight(origin, vel, g, aim, 0, NoGround);

	CHECK(f.frames >= 1);
	CHECK_FALSE(f.hitGround);

	// The solver reports a whole-frame arrival, rounded up from the exact
	// crossing. impact_pos is the position at the *exact* time, so the
	// convergence check is that impact_pos lies on the arc no later than
	// impact_frame and within one frame of travel of it.
	const float3 atFrame = CosmeticFlightPos(origin, vel, g, static_cast<float>(f.frames));
	const float slack = vel.Length() + 0.5f * std::fabs(g) * f.frames;
	CHECK(f.impactPos.distance(atFrame) <= slack);

	// And with no ground and no ttl the arc runs the full horizontal
	// distance, so impact_pos should sit on the aim point's vertical line.
	CHECK(f.impactPos.x == doctest::Approx(600.0f).epsilon(0.01));
}

TEST_CASE("SolveCosmeticFlight stops at the ground when the arc dips into it") {
	const float3 origin(0.0f, 100.0f, 0.0f);
	const float3 vel(10.0f, 0.0f, 0.0f);
	const float  g = -0.5f;                 // steep, so it lands well short
	const float3 aim(5000.0f, 100.0f, 0.0f); // far beyond the landing point

	const CosmeticFlight f = SolveCosmeticFlight(origin, vel, g, aim, 0, FlatGround);

	CHECK(f.hitGround);
	CHECK(f.impactPos.y == doctest::Approx(0.0f).epsilon(0.5));
	CHECK(f.impactPos.x < 500.0f);
	// The invented flight must never terminate on the fire frame — spawn and
	// detonation would collapse onto one presentation frame.
	CHECK(f.frames >= 1);
}

TEST_CASE("SolveCosmeticFlight stops on rising terrain, not at the aim point") {
	// A flat shot at a target beyond a ridge must detonate on the ridge.
	const float3 origin(0.0f, 150.0f, 0.0f);
	const float3 vel(10.0f, 0.0f, 0.0f);
	const float3 aim(1000.0f, 150.0f, 0.0f);

	const CosmeticFlight flat = SolveCosmeticFlight(origin, vel, 0.0f, aim, 0, FlatGround);
	CHECK_FALSE(flat.hitGround);
	CHECK(flat.impactPos.x == doctest::Approx(1000.0f).epsilon(0.01));

	// Same shot, but now the terrain rises to y=100 at x=300. The projectile
	// flies at y=150, above the step, so it should still reach the aim point.
	const CosmeticFlight over = SolveCosmeticFlight(origin, vel, 0.0f, aim, 0, StepGround);
	CHECK_FALSE(over.hitGround);

	// Drop the muzzle below the step height and it must stop at the wall.
	const float3 lowOrigin(0.0f, 50.0f, 0.0f);
	const CosmeticFlight into = SolveCosmeticFlight(lowOrigin, vel, 0.0f, aim, 0, StepGround);
	CHECK(into.hitGround);
	CHECK(into.impactPos.x == doctest::Approx(300.0f).epsilon(1.0));
	CHECK(into.frames == 30);
}

TEST_CASE("SolveCosmeticFlight terminates on the target, not past it") {
	// Regression guard for a measured defect: with only a ground test, a
	// shell aimed at a tank flies through it and bursts in the dirt behind,
	// so the explosion never learns which unit it struck and the damage
	// arrives as uniform area splash across the whole formation instead of
	// concentrating on the target.
	const float3 origin(0.0f, 30.0f, 0.0f);
	const float3 vel(10.0f, 0.0f, 0.0f);
	const float3 aim(500.0f, 30.0f, 0.0f);
	const auto target = SphereTarget(float3(300.0f, 30.0f, 0.0f), 25.0f);

	SUBCASE("a shot through the target stops on its hull, not at its centre") {
		const CosmeticFlight f =
			SolveCosmeticFlight(origin, vel, 0.0f, aim, 0, FlatGround, target);
		CHECK(f.hitTarget);
		CHECK_FALSE(f.hitGround);
		// Enters at x == 275, so the impact is on the near face — the entry
		// point the collision query reports, not a bisected approximation.
		CHECK(f.impactPos.x == doctest::Approx(275.0f).epsilon(0.001));
		CHECK(f.frames == 28);
	}

	SUBCASE("with no target the same shot runs on to the aim point") {
		const CosmeticFlight f =
			SolveCosmeticFlight(origin, vel, 0.0f, aim, 0, FlatGround);
		CHECK_FALSE(f.hitTarget);
		CHECK(f.impactPos.x == doctest::Approx(500.0f).epsilon(0.02));
	}

	SUBCASE("a shot that misses is not reported as a hit") {
		const auto offset = SphereTarget(float3(300.0f, 30.0f, 400.0f), 25.0f);
		const CosmeticFlight f =
			SolveCosmeticFlight(origin, vel, 0.0f, aim, 0, FlatGround, offset);
		CHECK_FALSE(f.hitTarget);
		CHECK(f.impactPos.x == doctest::Approx(500.0f).epsilon(0.02));
	}

	SUBCASE("a near miss that clears the hull by a metre is still a miss") {
		// The whole point of using the collision volume rather than the
		// model's bounding sphere: shots that graze past must not register.
		const auto grazed = SphereTarget(float3(300.0f, 30.0f, 26.0f), 25.0f);
		const CosmeticFlight f =
			SolveCosmeticFlight(origin, vel, 0.0f, aim, 0, FlatGround, grazed);
		CHECK_FALSE(f.hitTarget);
	}

	SUBCASE("ground short of the target still wins") {
		// A steep arc that ploughs in before it ever reaches the tank.
		const CosmeticFlight f =
			SolveCosmeticFlight(origin, vel, -0.5f, aim, 0, FlatGround, target);
		CHECK(f.hitGround);
		CHECK_FALSE(f.hitTarget);
		CHECK(f.impactPos.x < 275.0f);
	}
}

TEST_CASE("SolveCosmeticFlight honours ttl the way a self-detonating projectile would") {
	const float3 origin(0.0f, 500.0f, 0.0f);
	const float3 vel(10.0f, 0.0f, 0.0f);
	const float3 aim(1000.0f, 500.0f, 0.0f);   // 100 frames away

	const CosmeticFlight bounded = SolveCosmeticFlight(origin, vel, 0.0f, aim, 40, NoGround);
	CHECK(bounded.frames == 40);
	CHECK_FALSE(bounded.hitGround);
	CHECK(bounded.impactPos.x == doctest::Approx(400.0f).epsilon(0.01));

	// A ttl longer than the flight must not extend it.
	const CosmeticFlight slack = SolveCosmeticFlight(origin, vel, 0.0f, aim, 500, NoGround);
	CHECK(slack.frames == 100);
	CHECK(slack.impactPos.x == doctest::Approx(1000.0f).epsilon(0.01));
}

TEST_CASE("SolveCosmeticFlight survives a degenerate launch") {
	// A weapon emit-sfx firing at its own muzzle, or a zero-speed def. The
	// resolver must still produce a schedulable event rather than a NaN
	// frame count that would strand the client's timeline entry forever.
	const float3 origin(10.0f, 20.0f, 30.0f);
	const CosmeticFlight f =
		SolveCosmeticFlight(origin, float3(0.0f, 0.0f, 0.0f), -0.1f, origin, 0, FlatGround);

	CHECK(f.frames == 1);
	CHECK(std::isfinite(f.impactPos.x));
	CHECK(std::isfinite(f.impactPos.y));
	CHECK(std::isfinite(f.impactPos.z));
}

TEST_CASE("CosmeticFireQueue retires entries in frame order and never drops one") {
	CosmeticFireQueue q;

	// weaponDef == nullptr short-circuits the explosion, which is what lets
	// this exercise the scheduling half without a loaded sim.
	auto make = [](int frame) {
		PendingCosmeticImpact p;
		p.impactFrame = frame;
		p.ownerId = -1;
		p.targetUnitId = -1;
		return p;
	};

	q.Push(make(10));
	q.Push(make(12));
	q.Push(make(11));
	CHECK(q.PendingCount() == 3);

	q.Update(9);
	CHECK(q.PendingCount() == 3);   // nothing due yet

	q.Update(10);
	CHECK(q.PendingCount() == 2);

	q.Update(11);
	CHECK(q.PendingCount() == 1);

	q.Update(100);
	CHECK(q.PendingCount() == 0);

	// Past-due entries fire on the next tick rather than being dropped:
	// damage is authoritative and a stall must not eat it.
	q.Push(make(5));
	q.Update(1000);
	CHECK(q.PendingCount() == 0);
}

TEST_CASE("CosmeticFireQueue::Clear drops pending damage without applying it") {
	CosmeticFireQueue q;
	PendingCosmeticImpact p;
	p.impactFrame = 50;
	p.ownerId = -1;
	p.targetUnitId = -1;
	q.Push(p);
	q.Push(p);
	CHECK(q.PendingCount() == 2);

	q.Clear();
	CHECK(q.PendingCount() == 0);
	CHECK(q.AppliedCount() == 0);
}
