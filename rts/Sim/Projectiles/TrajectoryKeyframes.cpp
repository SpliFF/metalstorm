/* This file is part of the Spring engine (GPL v2 or later), see LICENSE.html */

#include "Sim/Projectiles/TrajectoryKeyframes.h"

#include "Sim/Projectiles/WeaponProjectiles/WeaponProjectileTypes.h"
#include "Sim/Weapons/WeaponDef.h"
#include "System/Config/ConfigHandler.h"
#include "System/Log/ILog.h"

// PLAN-latency L3 — Tier-S keyframes. Defaults ON since the L3 gate
// (2026-08-03). It was OFF while no client splined through the stream; L3.2
// shipped that client and the gate then measured every presentation criterion
// green — see PLAN-latency-impl.md §"L3 gate". The gate was decided on
// presentation quality, deliberately: the stream *costs* +35.6 % of
// GameEventBatch per shot (L3.2's A/B), and that cost is accepted here rather
// than argued away. The mitigation levers are identified and measured-for, not
// applied — see L3.3 in the plan.
CONFIG(bool, LatencyTierSKeyframes)
	.defaultValue(true)
	.description("PLAN-latency L3: stream frame-stamped trajectory keyframes for"
	             " simulated (Tier-S) projectiles instead of ProjectileTrajectoryEvent"
	             " corrections. Requires an L3-capable client to render the result.");


// PLAN-latency L3.3 — the elision itself, behind its own switch.
//
// Defaults ON: it is the whole point of L3.3, and the client reconstructs what
// it removes exactly (see TrajectoryKeyframes.h `KeyframesRedundantFor`). The
// switch exists for two reasons, in this order of importance:
//
//   1. It makes L3.3 a PAIRED A/B on one binary, with the flag the only
//      difference — the methodology every measured claim in this lane has been
//      held to, and the only way to attribute a byte-count delta to the
//      elision rather than to a different battle. Without it the control arm
//      would need a separately built binary and "same shots" would be an
//      assumption instead of an observation.
//   2. It is the revert lever if the reconstruction is ever found to diverge
//      on some class this predicate wrongly claims. Turning it off restores
//      the L3-gate stream verbatim, at the L3-gate cost.
CONFIG(bool, LatencyKeyframeElision)
	.defaultValue(true)
	.description("PLAN-latency L3.3: omit the Tier-S keyframes the client can"
	             " reconstruct from ProjectileFiredEvent/OutcomeKnownEvent —"
	             " every Launch knot, and the Terminal knot of a closed-form"
	             " projectile class. Off restores the L3-gate stream.");


bool KeyframeElisionEnabled()
{
	static const bool enabled = []() {
		const bool on = (configHandler != nullptr)
			&& configHandler->GetBool("LatencyKeyframeElision");
		LOG_L(L_INFO, "[TrajectoryKeyframes] KeyframeElision %s",
		      on ? "ENABLED" : "disabled");
		return on;
	}();
	return enabled;
}


bool TierSKeyframesEnabled()
{
	// Logged once, at L_INFO, for the same reason ClassifyFxTiers is: in a
	// clone lane `lobby_main.cpp` prefers ./build/release/spring-server over
	// any other build, so a room can silently be served by a stale binary and
	// every measurement comes back a clean negative. This line is the
	// one-command check that the right server is running AND that the flag
	// reached it — `grep TierSKeyframes data/logs/game-N.log`.
	static const bool enabled = []() {
		const bool on = (configHandler != nullptr)
			&& configHandler->GetBool("LatencyTierSKeyframes");
		LOG_L(L_INFO, "[TrajectoryKeyframes] TierSKeyframes %s (heartbeat every %d frames)",
		      on ? "ENABLED" : "disabled", KEYFRAME_HEARTBEAT_INTERVAL);
		return on;
	}();
	return enabled;
}


bool KeyframesApplyTo(const WeaponDef* wd)
{
	if (wd == nullptr)
		return false;

	// A hit-scan "projectile" is a one-tick visual whose Fired event already
	// carries both endpoints. There is no flight to interpolate.
	return !wd->IsHitScanWeapon();
}


bool KeyframesRedundantForType(unsigned int projectileType)
{
	// Named by class rather than derived from a property, because the property
	// that matters — "Update() is pos += speed and nothing else" — is not on
	// the def. These three were read off their Update() implementations:
	// CEmgProjectile and CLaserProjectile are plain `pos += speed`,
	// CExplosiveProjectile adds only CProjectile::Update's constant gravity.
	// Everything else (Fireball's spark drift, Flame's curve, Missile and
	// Starburst steering, Torpedo's wake) does something the client's closed
	// form does not reproduce, and keeps its knots.
	//
	// UpdateGroundBounce is shared by all three and is not an exception: it
	// emits a Bounce knot, which this function does not suppress.
	constexpr unsigned int CLOSED_FORM_TYPES =
		WEAPON_EMG_PROJECTILE | WEAPON_LASER_PROJECTILE | WEAPON_EXPLOSIVE_PROJECTILE;

	return (projectileType & CLOSED_FORM_TYPES) != 0;
}


bool KeyframesRedundantFor(const WeaponDef* wd)
{
	return KeyframeElisionEnabled()
	    && KeyframesApplyTo(wd)
	    && KeyframesRedundantForType(wd->projectileType);
}


bool DecideKeyframe(const KeyframeState& st, uint32_t projId, int frame,
                    uint8_t stage, bool guided, uint8_t& outKind)
{
	// One knot per projectile per frame. Without this a stage change landing
	// on the projectile's rotor frame would write two knots at the same
	// spline parameter, which is a degenerate segment for the client.
	if (st.lastFrame == frame)
		return false;

	if (st.lastFrame < 0) {
		outKind = KEYFRAME_LAUNCH;
		return true;
	}

	// A stage change is where the path bends. Report it even on a frame the
	// heartbeat rotor would have covered anyway — same knot, better label.
	if (stage != KEYFRAME_STAGE_NONE && stage != st.lastStage) {
		outKind = KEYFRAME_STAGE_CHANGE;
		return true;
	}

	// Heartbeat rotor. Phase is seeded from the projectile id so a salvo
	// launched on one frame does not clump all its heartbeats onto the same
	// later frames — the same staggering the 30-frame trajectory rotor used,
	// at twice the rate.
	if (guided && (frame % KEYFRAME_HEARTBEAT_INTERVAL)
	            == static_cast<int>(projId % KEYFRAME_HEARTBEAT_INTERVAL)) {
		outKind = KEYFRAME_HEARTBEAT;
		return true;
	}

	return false;
}
