/* This file is part of the Spring engine (GPL v2 or later), see LICENSE.html */

#include "Sim/Projectiles/TrajectoryKeyframes.h"

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
