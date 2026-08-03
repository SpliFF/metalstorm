// PLAN-latency L3 — Tier-S keyframe emission policy.
//
// The policy decides which sim frames carry a spline knot. Getting it wrong
// is expensive in two opposite directions and neither is visible from reading
// the code:
//
//   * too few knots and a guided missile's rendered path cuts the corner on
//     every stage transition, which is the exact defect the old 30-frame
//     rotor had;
//   * two knots on one frame and the client has a degenerate spline segment
//     (two distinct control points at the same parameter), which is a divide
//     -by-zero in any frame-parametrised interpolator.
//
// DecideKeyframe is pure, so all of that tests here without a sim, a map, or
// a projectile. What is NOT covered here — and is therefore L3's in-browser
// gate, not a unit test — is whether the resulting knot density is enough for
// the spline to track the sim path within a few elmos.

#include <doctest/doctest.h>

#include "Sim/Projectiles/TrajectoryKeyframes.h"

#include <set>
#include <utility>
#include <vector>

namespace {

/// A projectile that has already emitted its Launch knot on `frame`, in
/// `stage`. The starting point for every test that is not about the launch.
KeyframeState After(int frame, uint8_t stage = KEYFRAME_STAGE_NONE)
{
	KeyframeState st;
	st.lastFrame = frame;
	st.lastStage = stage;
	return st;
}

/// Run the policy across a frame range the way a projectile's Update would,
/// advancing the state on every emission. Returns the frames that got a knot,
/// paired with the kind, so a test can assert on the whole pattern rather
/// than one frame at a time.
std::vector<std::pair<int, uint8_t>> Sweep(KeyframeState st, uint32_t projId,
                                           int fromFrame, int toFrame,
                                           uint8_t stage, bool guided)
{
	std::vector<std::pair<int, uint8_t>> out;
	for (int f = fromFrame; f <= toFrame; ++f) {
		uint8_t kind = 0xEE;
		if (DecideKeyframe(st, projId, f, stage, guided, kind)) {
			out.emplace_back(f, kind);
			st.lastFrame = f;
			st.lastStage = stage;
		}
	}
	return out;
}

} // namespace


TEST_CASE("L3 keyframes: the first knot is always a Launch")
{
	KeyframeState fresh;               // lastFrame == -1
	uint8_t kind = 0xEE;

	// True regardless of frame, stage or guidance — a projectile cannot have
	// a spline until it has a first control point.
	CHECK(DecideKeyframe(fresh, /*projId=*/7, /*frame=*/0, KEYFRAME_STAGE_NONE, false, kind));
	CHECK(kind == KEYFRAME_LAUNCH);

	kind = 0xEE;
	CHECK(DecideKeyframe(fresh, /*projId=*/7, /*frame=*/12345, /*stage=*/2, true, kind));
	CHECK(kind == KEYFRAME_LAUNCH);
}


TEST_CASE("L3 keyframes: unguided projectiles get no heartbeat")
{
	// A cannon shell's path between knots is the closed-form arc the client
	// already solves exactly (L2.2). Sampling it would be pure waste, so the
	// policy must stay silent across a whole flight's worth of frames.
	const auto emitted = Sweep(After(100), /*projId=*/3, 101, 400,
	                           KEYFRAME_STAGE_NONE, /*guided=*/false);
	CHECK(emitted.empty());
}


TEST_CASE("L3 keyframes: a guided projectile pins its launch stage immediately")
{
	// The Launch knot is written by the constructor, which cannot know the
	// derived class's guidance stage and records STAGE_NONE. The first
	// Update therefore reports a transition out of the sentinel, one frame
	// after launch.
	//
	// That is intended, not an artefact: the launch knot's velocity is the
	// muzzle vector before any steering ran, so a second knot carrying the
	// post-steer state is exactly what the spline wants at the start of the
	// flight. It costs one extra knot per guided projectile per flight.
	uint8_t kind = 0xEE;
	CHECK(DecideKeyframe(After(/*frame=*/100, KEYFRAME_STAGE_NONE), /*projId=*/4,
	                     /*frame=*/101, /*stage=*/1, /*guided=*/true, kind));
	CHECK(kind == KEYFRAME_STAGE_CHANGE);
}


TEST_CASE("L3 keyframes: guided projectiles heartbeat on a fixed interval")
{
	// Steady state: past the launch-stage knot above, so the only rule left
	// in play is the rotor.
	const uint32_t projId = 4;
	const auto emitted = Sweep(After(0, /*stage=*/1), projId, 1, 200,
	                           /*stage=*/1, /*guided=*/true);

	REQUIRE(!emitted.empty());
	for (const auto& [frame, kind] : emitted)
		CHECK(kind == KEYFRAME_HEARTBEAT);

	// Exactly one per interval, no gaps and no doubles.
	for (size_t i = 1; i < emitted.size(); ++i)
		CHECK(emitted[i].first - emitted[i - 1].first == KEYFRAME_HEARTBEAT_INTERVAL);

	// 200 frames at one per interval, give or take where the id's phase
	// falls relative to the window.
	CHECK(emitted.size() >= static_cast<size_t>(200 / KEYFRAME_HEARTBEAT_INTERVAL));
	CHECK(emitted.size() <= static_cast<size_t>(200 / KEYFRAME_HEARTBEAT_INTERVAL) + 1);
}


TEST_CASE("L3 keyframes: the heartbeat is twice the rate of the rotor it replaces")
{
	// The old ProjectileTrajectoryEvent rotor ran at 30 frames; decision 5
	// halves that. Pinned because it is a bandwidth-visible number that the
	// L3 gate measures, and a silent change to it would invalidate the
	// measurement rather than fail anything.
	CHECK(KEYFRAME_HEARTBEAT_INTERVAL == 15);
	CHECK(30 / KEYFRAME_HEARTBEAT_INTERVAL == 2);
}


TEST_CASE("L3 keyframes: a salvo does not clump its heartbeats on one frame")
{
	// Every projectile in a salvo launches on the same frame. If the rotor
	// phase came from the launch frame rather than the id, all of them would
	// heartbeat together forever and the batch would spike every interval.
	std::set<int> firstHeartbeatFrames;
	for (uint32_t projId = 0; projId < KEYFRAME_HEARTBEAT_INTERVAL; ++projId) {
		// Same launch frame and same stage for every projectile in the
		// salvo — the id is the only thing that differs.
		const auto emitted = Sweep(After(0, /*stage=*/1), projId, 1, 100, /*stage=*/1, true);
		REQUIRE(!emitted.empty());
		firstHeartbeatFrames.insert(emitted.front().first);
	}

	// One distinct phase per id across a full interval — maximal spreading.
	CHECK(firstHeartbeatFrames.size() == static_cast<size_t>(KEYFRAME_HEARTBEAT_INTERVAL));
}


TEST_CASE("L3 keyframes: a stage change emits immediately, off the rotor")
{
	// Stage transitions are where the path hinges. Waiting up to a full
	// interval to record one is what makes a uniformly sampled starburst cut
	// the corner, so the knot has to land on the transition frame itself.
	const uint32_t projId = 5;

	// Pick a frame the rotor definitely does NOT cover for this id.
	int offRotorFrame = 40;
	while ((offRotorFrame % KEYFRAME_HEARTBEAT_INTERVAL)
	       == static_cast<int>(projId % KEYFRAME_HEARTBEAT_INTERVAL))
		++offRotorFrame;

	uint8_t kind = 0xEE;
	CHECK(DecideKeyframe(After(offRotorFrame - 1, /*stage=*/1), projId, offRotorFrame,
	                     /*stage=*/2, /*guided=*/true, kind));
	CHECK(kind == KEYFRAME_STAGE_CHANGE);
}


TEST_CASE("L3 keyframes: an unguided projectile still reports stage changes")
{
	// `guided` gates the heartbeat only. A projectile with stages but no
	// heartbeat (were one to exist) must still pin its hinges.
	uint8_t kind = 0xEE;
	CHECK(DecideKeyframe(After(50, /*stage=*/0), /*projId=*/6, /*frame=*/51,
	                     /*stage=*/1, /*guided=*/false, kind));
	CHECK(kind == KEYFRAME_STAGE_CHANGE);
}


TEST_CASE("L3 keyframes: STAGE_NONE never counts as a transition")
{
	// Unguided projectiles pass the sentinel at every site. If it compared
	// as an ordinary stage id it would read as a transition on the first
	// frame after launch and again whenever a guided sibling's id was
	// reused, emitting knots for projectiles that have no stages at all.
	const auto emitted = Sweep(After(10, KEYFRAME_STAGE_NONE), /*projId=*/8, 11, 300,
	                           KEYFRAME_STAGE_NONE, /*guided=*/false);
	CHECK(emitted.empty());

	// And it must not fire when a real stage id is *replaced* by the
	// sentinel either — that is a call site saying "no stage information",
	// not a transition to a fourth stage.
	uint8_t kind = 0xEE;
	CHECK_FALSE(DecideKeyframe(After(10, /*stage=*/2), /*projId=*/8, /*frame=*/11,
	                           KEYFRAME_STAGE_NONE, /*guided=*/false, kind));
}


TEST_CASE("L3 keyframes: a stage change on a rotor frame is labelled StageChange")
{
	// Same knot either way, but the more informative label wins — and this
	// pins that the two rules cannot both fire and produce two knots.
	const uint32_t projId = 9;
	const int rotorFrame = 60 + static_cast<int>(projId % KEYFRAME_HEARTBEAT_INTERVAL);
	REQUIRE((rotorFrame % KEYFRAME_HEARTBEAT_INTERVAL)
	        == static_cast<int>(projId % KEYFRAME_HEARTBEAT_INTERVAL));

	uint8_t kind = 0xEE;
	CHECK(DecideKeyframe(After(rotorFrame - 1, /*stage=*/1), projId, rotorFrame,
	                     /*stage=*/2, /*guided=*/true, kind));
	CHECK(kind == KEYFRAME_STAGE_CHANGE);
}


TEST_CASE("L3 keyframes: never two sampled knots on one frame")
{
	// The degenerate-segment guard. A projectile that already wrote a knot
	// on this frame — a Launch, or a Bounce that the site emitted directly —
	// must not be asked for another, whatever the rotor and stage say.
	const uint32_t projId = 11;
	const int frame = 45 + static_cast<int>(projId % KEYFRAME_HEARTBEAT_INTERVAL);

	uint8_t kind = 0xEE;
	// Rotor frame AND a stage change AND guided: every rule wants to fire.
	CHECK_FALSE(DecideKeyframe(After(frame, /*stage=*/1), projId, frame,
	                           /*stage=*/2, /*guided=*/true, kind));
}


TEST_CASE("L3 keyframes: wire kind values match the schema")
{
	// These cross the wire as raw bytes into schemas/protocol.fbs
	// TrajectoryKeyframeKind. Renumbering the enum without renumbering the
	// schema would mislabel every knot with no build error anywhere.
	CHECK(static_cast<int>(KEYFRAME_LAUNCH)       == 0);
	CHECK(static_cast<int>(KEYFRAME_HEARTBEAT)    == 1);
	CHECK(static_cast<int>(KEYFRAME_STAGE_CHANGE) == 2);
	CHECK(static_cast<int>(KEYFRAME_RETARGET)     == 3);
	CHECK(static_cast<int>(KEYFRAME_BOUNCE)       == 4);
	CHECK(static_cast<int>(KEYFRAME_TERMINAL)     == 5);

	// The sentinel must stay outside the value range so it can never be
	// mistaken for a real stage id.
	CHECK(KEYFRAME_STAGE_NONE > KEYFRAME_TERMINAL);
}


// ---------------------------------------------------------------------------
// PLAN-latency L3.3 — which projectile classes need no knots at all.
//
// The L3 gate accepted a measured +35.6 % of GameEventBatch per shot. This
// predicate is the lever that takes it back: for a class whose Update is
// `pos += speed` (plus at most a constant gravity), the client's closed form
// IS the sim's recurrence, so the Launch knot restates the ProjectileFiredEvent
// and the Terminal knot restates the OutcomeKnownEvent. Both are dropped and
// the class emits nothing.
//
// Getting the membership wrong is silent in both directions — a class wrongly
// included renders a flight the sim never flew, a class wrongly excluded just
// keeps paying — so the set is pinned here rather than inferred.
// ---------------------------------------------------------------------------

#include "Sim/Projectiles/WeaponProjectiles/WeaponProjectileTypes.h"

TEST_CASE("L3.3 redundancy: the closed-form classes send no knots")
{
	// Read off their Update() implementations, not off the def:
	//   CEmgProjectile::Update      pos += speed
	//   CLaserProjectile::UpdatePos SetPosition(pos + speed)
	//   CExplosiveProjectile        CProjectile::Update — speed += g; pos += speed
	CHECK(KeyframesRedundantForType(WEAPON_EMG_PROJECTILE));
	CHECK(KeyframesRedundantForType(WEAPON_LASER_PROJECTILE));
	CHECK(KeyframesRedundantForType(WEAPON_EXPLOSIVE_PROJECTILE));
}


TEST_CASE("L3.3 redundancy: anything the client cannot reproduce keeps its knots")
{
	// Steering the client has no model for. Missile and Starburst are also the
	// only two classes that call MaybeEmitKeyframe at all — excluding them here
	// is what keeps the guided heartbeat alive.
	CHECK_FALSE(KeyframesRedundantForType(WEAPON_MISSILE_PROJECTILE));
	CHECK_FALSE(KeyframesRedundantForType(WEAPON_STARBURST_PROJECTILE));
	CHECK_FALSE(KeyframesRedundantForType(WEAPON_TORPEDO_PROJECTILE));

	// Non-ballistic motion of other kinds: Fireball's spark drift, Flame's
	// curve. Neither steers, so neither gets a heartbeat — but neither flies
	// the closed-form arc either, so their Launch/Terminal pair is the only
	// truthful thing the client has and it stays.
	CHECK_FALSE(KeyframesRedundantForType(WEAPON_FIREBALL_PROJECTILE));
	CHECK_FALSE(KeyframesRedundantForType(WEAPON_FLAME_PROJECTILE));

	// Hit-scan classes never reach the predicate in the live path
	// (KeyframesApplyTo rejects them first), but the type test must not claim
	// them either — a beam has no flight to reconstruct from anything.
	CHECK_FALSE(KeyframesRedundantForType(WEAPON_BEAMLASER_PROJECTILE));
	CHECK_FALSE(KeyframesRedundantForType(WEAPON_LARGEBEAMLASER_PROJECTILE));
	CHECK_FALSE(KeyframesRedundantForType(WEAPON_LIGHTNING_PROJECTILE));

	// A projectile whose type never got set. Defaulting to "redundant" would
	// silently mute an unknown class's whole stream.
	CHECK_FALSE(KeyframesRedundantForType(0u));
	CHECK_FALSE(KeyframesRedundantForType(WEAPON_BASE_PROJECTILE));
}


TEST_CASE("L3.3 redundancy: suppression cannot unsuppress a later sampled knot")
{
	// The Fired site advances `lastFrame` whether or not it actually pushed a
	// Launch knot, because the client holds a knot at that frame either way.
	// If it did not, a suppressed launch would leave lastFrame at -1 and the
	// very next DecideKeyframe call would emit a *second* Launch mid-flight.
	KeyframeState st = After(100);
	uint8_t kind = 0xEE;
	CHECK_FALSE(DecideKeyframe(st, /*projId=*/7, /*frame=*/100,
	                           KEYFRAME_STAGE_NONE, /*guided=*/false, kind));

	KeyframeState fresh;   // lastFrame == -1, i.e. the bug this guards against
	CHECK(DecideKeyframe(fresh, /*projId=*/7, /*frame=*/100,
	                     KEYFRAME_STAGE_NONE, /*guided=*/false, kind));
	CHECK(kind == KEYFRAME_LAUNCH);
}
