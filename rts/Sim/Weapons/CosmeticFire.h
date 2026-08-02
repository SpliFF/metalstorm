/* This file is part of the Spring engine (GPL v2 or later), see LICENSE.html */

// CosmeticFire — PLAN-latency L2.1, the Tier-C fire substitution.
//
// LATENCY-STANDIN: this is a deliberate, sanctioned deviation from Recoil.
//
// A weaponDef classified FX_TIER_COSMETIC (see WeaponDef::ClassifyFxTier,
// L2.0) does not get a CWeaponProjectile. Instead the whole shot is resolved
// at fire time from the launch state the weapon's own FireImpl already
// computed: flight duration, terminal position, and outcome. One
// FireOutcomeEvent goes on the wire in place of the Fired/Trajectory/Impact
// triple, and the damage is queued on the sim timeline so it lands on
// `impactFrame` exactly as the real projectile's Explode() would have.
//
// What this buys (PLAN-latency-projectiles §3): the client knows the endpoint
// AND the arrival frame up front, so it can invent a trajectory that provably
// terminates on the explosion — no extrapolate-and-snap, no creep. It also
// removes the projectile from the sim entirely: no per-tick integration, no
// collision tests, no event stream.
//
// What it costs, stated plainly:
//
//   * No collision en route. A Tier-C shot cannot hit something that wanders
//     into its path, and cannot be stopped by a shield or an interceptor that
//     comes up after the trigger is pulled. The classifier's job is to keep
//     anything whose outcome is genuinely contingent OUT of Tier C.
//   * The terminal point is predicted from the launch state against the
//     target's pose AT FIRE TIME, so a target that moves during the flight is
//     not tracked. **This is the big one, and it is bigger than the design
//     costed.** The simulated projectile has to connect with wherever the
//     target is on arrival; the substituted one only has to connect with
//     where it was aimed. Measured on a papertanks 1v1 at 250 elmos (heavy
//     cannon, 350 max damage, accuracy 80):
//
//         simulated:    44 shots / 2043 frames,  63.5 dmg/shot (18% of max)
//         substituted:  12 shots / 2048 frames, 179.8 dmg/shot (51% of max)
//
//     — a 2.8x jump in damage per shot. The lower shot count is a knock-on:
//     harder hits mean more explosion impulse, which shoves the target and
//     costs the shooter re-aim time (the simulated run fires at the reload
//     ceiling of 2.2 shots/100 frames; the substituted one at 0.59). Total
//     damage happens to land close (2158 vs 2795) but only by coincidence of
//     the two effects pulling opposite ways.
//
//     This is the sanctioned deviation of PLAN-latency-impl decision 2, but
//     the magnitude is a balance change, not a cosmetic one. It is why
//     `LatencyCosmeticFire` defaults OFF and why the L2 gate owes a decision:
//     resolve against a *predicted arrival* pose, or accept and rebalance.
//   * No feature fireStarter roll and no bounce/ricochet. Both are properties
//     of a collision that never happens.
//
// Hitscan weapons (BeamLaser, LargeBeamLaser, LightningCannon) are never
// substituted even when classified Tier C: their damage is applied inline by
// their own FireImpl and the "projectile" is a pure visual, so substituting
// would both double-apply damage and remove the beam. They also have nothing
// to gain — their Fired and Impact events already arrive together.

#pragma once

#include "System/float3.h"
#include <cstdint>
#include <functional>
#include <vector>

class CUnit;
class DynDamageArray;
struct ProjectileParams;
struct WeaponDef;

/// Outcome codes — wire values, kept in sync with schemas/protocol.fbs
/// `FireOutcome`.
enum CosmeticFireOutcome : uint8_t {
	COSMETIC_OUTCOME_HIT         = 0,
	COSMETIC_OUTCOME_MISS        = 1,
	COSMETIC_OUTCOME_SHIELDED    = 2,
	COSMETIC_OUTCOME_INTERCEPTED = 3,
	COSMETIC_OUTCOME_EXPIRED     = 4,
};

/// The resolved flight, in the form the wire event and the damage queue both
/// need. Produced by SolveCosmeticFlight().
struct CosmeticFlight {
	/// Flight duration in sim frames. Always >= 1 so spawn and detonation
	/// never collapse onto the same presentation frame.
	int    frames = 1;
	/// Where the invented flight terminates — and where the damage lands.
	float3 impactPos;
	/// True when the arc was cut short by the ground before reaching the
	/// aim point's horizontal distance.
	bool   hitGround = false;
	/// True when the arc entered the target's collision sphere. This is the
	/// difference between a shell that hits the tank it was aimed at and one
	/// that sails through and bursts in the dirt behind it.
	bool   hitTarget = false;
};

/// Segment test against the shot's target, evaluated per frame-step of the
/// arc exactly as CProjectileHandler::CheckUnitCollisions tests a live
/// projectile's [prevPos, pos] segment. Returns true and writes `hitPos` when
/// the segment enters the target. Empty means "no unit target".
///
/// It is a callback rather than a sphere so production can hand it the real
/// CCollisionHandler test against the target's collision *volume*. Testing a
/// bounding sphere instead is not a close-enough approximation: `radius` is
/// the whole model's bounding sphere, so it registers hits the sim would
/// miss, and the substituted shot then out-damages the real one by several
/// times over. Measured on a papertanks 20v20 — see the note on
/// SolveCosmeticFlight.
using CosmeticTargetHit = std::function<bool(const float3& p0, const float3& p1, float3& hitPos)>;

/// Ballistic position `t` frames after launch. Mirrors the integration
/// CWeaponProjectile does per tick (`pos += speed; speed.y -= mygravity`),
/// in closed form. `gravity` is per-frame, as `mygravity` is.
float3 CosmeticFlightPos(const float3& origin, const float3& launchVel, float gravity, float t);

/// Frames until a shot launched from `origin` with `launchVel` reaches the
/// *horizontal* distance of `aimPos`. Horizontal speed is constant under
/// gravity, so this is exact for a ballistic arc; for a shot with no
/// horizontal component it falls back to 3-D distance over speed. Returns 0
/// when the launch velocity is degenerate.
float CosmeticFlightFrames(const float3& origin, const float3& launchVel, const float3& aimPos);

/// Resolve the whole flight. Pure except for the ground-height lookup, which
/// is injected so the solver is unit-testable without a loaded map: `groundAt`
/// returns the terrain height at an (x, z).
///
/// `ttl` bounds the flight the same way the real projectile's ttl does; pass
/// <= 0 for unbounded.
///
/// `targetHit` stands in for the one collision the substitution still models.
/// Ignoring it entirely was measurably wrong: with only a ground test, every
/// shot sails past the unit it was aimed at and ground-bursts behind it, so
/// the explosion never learns which unit it struck and damage arrives as
/// uniform area splash over the whole formation instead of concentrating on
/// the target.
CosmeticFlight SolveCosmeticFlight(
	const float3& origin,
	const float3& launchVel,
	float gravity,
	const float3& aimPos,
	int ttl,
	float (*groundAt)(float x, float z),
	const CosmeticTargetHit& targetHit = {}
);

/// Damage scheduled to land on a future sim frame, standing in for the
/// explosion the absent projectile would have produced.
struct PendingCosmeticImpact {
	int    impactFrame = 0;
	float3 impactPos;
	float3 impactDir;
	float3 startPos;                       // for GetDynamicDamages range falloff
	const DynDamageArray* damages = nullptr;  // ref-counted, released on fire
	const WeaponDef* weaponDef = nullptr;
	int    ownerId = -1;
	int    targetUnitId = -1;              // resolved again at impact time
	uint8_t team = 0;
};

/// Frame-ordered queue of pending Tier-C explosions. Ticked once per sim
/// frame from Simulation.cpp, immediately before projectileHandler.Update()
/// so a cosmetic impact and a real projectile impact on the same frame reach
/// the same GameEventBatch.
class CosmeticFireQueue {
public:
	void Push(const PendingCosmeticImpact& p);
	/// Fire everything due on or before `frame`. Past-due entries (possible
	/// after a load or a Lua-driven frame jump) fire immediately rather than
	/// being dropped — damage is authoritative and must never be lost.
	void Update(int frame);
	/// Release every pending entry without applying damage. Used on game
	/// teardown; also drops the DynDamageArray refs.
	void Clear();

	size_t PendingCount() const { return pending.size(); }
	/// Total explosions applied this game — the L2 gate's counter.
	uint64_t AppliedCount() const { return applied; }

private:
	std::vector<PendingCosmeticImpact> pending;
	uint64_t applied = 0;
};

extern CosmeticFireQueue cosmeticFireQueue;

/// Is the Tier-C substitution enabled at all? Reads the `LatencyCosmeticFire`
/// config var once. Default OFF — see the note in CosmeticFire.cpp.
bool CosmeticFireEnabled();

/// The seam. Called from WeaponProjectileFactory::FireWeaponProjectile with
/// the params the weapon's FireImpl built. Returns true when the shot was
/// resolved cosmetically and NO projectile should be spawned.
bool TryResolveCosmeticFire(const ProjectileParams& params);
