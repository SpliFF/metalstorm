/* This file is part of the Spring engine (GPL v2 or later), see LICENSE.html */

// TrajectoryKeyframes — PLAN-latency L3, the Tier-S keyframe stream.
//
// LATENCY-STANDIN: this is a deliberate, sanctioned deviation from Recoil.
//
// L2 removed Tier-C shots from the simulation entirely. Tier-S shots stay —
// their outcome is genuinely contingent (they can be shielded, intercepted, or
// hit something that wandered into the path), so the server must keep running
// them. What L3 changes is how their motion reaches the client.
//
// The old contract (ProjectileTrajectoryEvent) was "rewrite your local pos/vel
// to these values and keep integrating". That has two defects the presentation
// timeline makes unfixable:
//
//   1. It has no frame stamp. The client applies the correction whenever the
//      packet lands, which is `D` frames ahead of what the presentation cursor
//      is currently showing. The projectile therefore jumps — hence the
//      extrapolate-and-snap loop and the `TRAIL_RESET_DELTA_SQ` hack that
//      exists purely to hide the ribbon those jumps leave behind.
//   2. The rendered position is a function of when packets arrived, not of the
//      cursor P. L2.3 established that "motion is a pure function of P" is
//      load-bearing rather than theoretical: the presentation cursor genuinely
//      steps backwards on ~0.9 % of ticks, and anything holding integrator
//      state mis-renders when it does.
//
// A keyframe is a *knot*: a position and velocity stamped with the sim frame
// they hold at. The client fits a Catmull-Rom spline through the knots
// parametrised by frame and evaluates it at P. Motion becomes a pure function
// of P, corrections stop existing as a category, and the terminal knot lands
// exactly on the explosion because both are stamped with the same frame.
//
// Emission policy, and why it is cheaper than what it replaces:
//
//   * Unguided projectiles (cannon shells, plain explosives) get Launch,
//     Bounce and Terminal only. Their path between knots is a closed-form
//     ballistic arc the client reproduces exactly from launch state plus
//     gravity — the same solver L2.2 already validated to 0.000 elmos. No
//     heartbeat is needed and none is sent.
//   * Guided projectiles (missiles, starbursts) steer in ways the client
//     cannot reproduce, so they get a heartbeat as well, at
//     KEYFRAME_HEARTBEAT_INTERVAL frames (PLAN-latency decision 5) — twice
//     the rate of the 30-frame trajectory rotor it replaces — plus a knot at
//     every guidance stage transition, which is where the path actually bends
//     and where a uniform sample rate is worst.
//
// Net: unguided shots lose their (rare) trajectory events, guided shots
// double their sample rate but stop needing the snap-hiding machinery. The
// L3 gate measures the resulting bandwidth rather than asserting it.
//
// Everything in this header is a pure function of its arguments plus a small
// per-projectile state struct. That is deliberate: the policy is the part
// worth testing, and it tests without a sim.

#pragma once

#include <cstdint>

struct WeaponDef;

/// Wire values — must match schemas/protocol.fbs `TrajectoryKeyframeKind`.
enum TrajectoryKeyframeKindValue : uint8_t {
	KEYFRAME_LAUNCH       = 0,
	KEYFRAME_HEARTBEAT    = 1,
	KEYFRAME_STAGE_CHANGE = 2,
	KEYFRAME_RETARGET     = 3,
	KEYFRAME_BOUNCE       = 4,
	KEYFRAME_TERMINAL     = 5,
};

/// Heartbeat cadence for guided projectiles, in sim frames (decision 5).
/// The rotor below staggers the phase per projectile, so this is the interval
/// between a given projectile's heartbeats, not a global emission period.
constexpr int KEYFRAME_HEARTBEAT_INTERVAL = 15;

/// Sentinel for "this projectile has no guidance stages" — an unguided
/// projectile passes this at every site so it can never trip a stage change.
constexpr uint8_t KEYFRAME_STAGE_NONE = 0xFFu;

/// Per-projectile emission state. Two bytes' worth of bookkeeping, carried on
/// CWeaponProjectile rather than in a side table so there is no per-tick map
/// lookup and no lifetime to manage.
struct KeyframeState {
	/// Sim frame of the last keyframe written for this projectile.
	/// -1 means "none yet", which is what makes the first one a Launch.
	int32_t lastFrame = -1;
	/// Guidance stage recorded at that keyframe.
	uint8_t lastStage = KEYFRAME_STAGE_NONE;
};

/// Is the Tier-S keyframe stream enabled? Reads `LatencyTierSKeyframes` once.
///
/// While this is off the server emits the legacy ProjectileTrajectoryEvent
/// stream and no keyframes; while it is on the two swap over, so a client
/// never sees both descriptions of the same projectile and cannot double-
/// apply them. Defaults OFF until an L3-capable client ships — see
/// PLAN-latency-impl.md §L3.
bool TierSKeyframesEnabled();

/// Does a projectile of this weaponDef participate in the keyframe stream?
///
/// The test is "does this projectile have a flight the client must draw over
/// time", not "is it Tier S". Hit-scan projectiles (beams, lightning) resolve
/// within one tick and are drawn from their Fired event alone, so a spline
/// through them would be a spline through a single point. Everything else
/// that reaches the sim as a live CWeaponProjectile is, by L2's construction,
/// Tier S: a substitutable Tier-C shot never spawns one in the first place.
bool KeyframesApplyTo(const WeaponDef* wd);

/// Pure policy: should frame `frame` carry a keyframe for this projectile,
/// and of what kind? Returns false when nothing should be emitted.
///
/// `stage` is a call-site-defined guidance stage id (KEYFRAME_STAGE_NONE for
/// projectiles that have none); `guided` enables the heartbeat. Precedence is
/// Launch > StageChange > Heartbeat: the first knot is always a Launch even if
/// the rotor would also have fired, and a stage change on a heartbeat frame is
/// reported as the stage change, because that is the more informative label
/// for the same knot. Bounce, Retarget and Terminal are emitted directly by
/// their sites — they are events, not sampling decisions.
///
/// At most one SAMPLED keyframe per projectile per frame: a projectile that
/// already wrote a knot on `frame` is never asked for another. Event knots
/// (Bounce, Terminal) bypass this policy entirely and may land on a frame a
/// sampled knot already covered — they carry the post-event state, they are
/// pushed second, and the client resolves the pair by taking the later of
/// two knots sharing a frame (see schemas/protocol.fbs TrajectoryKeyframe).
bool DecideKeyframe(const KeyframeState& st, uint32_t projId, int frame,
                    uint8_t stage, bool guided, uint8_t& outKind);
