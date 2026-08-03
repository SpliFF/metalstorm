/* This file is part of the Spring engine (GPL v2 or later), see LICENSE.html */

#include "CosmeticFire.h"

#include "WeaponDef.h"
#include "Weapon.h"
#include "Game/GameHelper.h"
#include "Map/Ground.h"
#include "Sim/Misc/CollisionHandler.h"
#include "Sim/Misc/CollisionVolume.h"
#include "Server/ProjectileEventCollector.h"
#include "Server/SoundEventCollector.h"
#include "Sim/Misc/DamageArray.h"
#include "Sim/Misc/GlobalSynced.h"
#include "Sim/Projectiles/ProjectileParams.h"
#include "Sim/Projectiles/WeaponProjectiles/WeaponProjectileTypes.h"
#include "Sim/Units/Unit.h"
#include "Sim/Units/UnitHandler.h"
#include "System/Config/ConfigHandler.h"
#include "System/EventHandler.h"

#include <algorithm>
#include <cmath>

// PLAN-latency L2.1/L2.3. Default ON since 2026-08-03. It shipped OFF, and the
// three things it was waiting on have each been closed by measurement rather
// than by argument — recorded here because "why is this on?" is the question a
// reader will have, and the answers are not guessable from the code:
//
// 1. No client consumer. Closed by L2.2: `cosmetic-flight.ts` +
//    `spawnCosmetic`/`detonateCosmetic` invent and draw the arc on the L1
//    presentation timeline, and convergence is exact by construction (the
//    endpoint is taken verbatim off the wire, measured 0.000 elmos on 750/750
//    detonations).
// 2. Combat balance. L2.1 measured 2.8x over-delivery against the simulated
//    path. Closed by L2.2 at 0.96x (1v1) / 0.94x (20v20) on identical shot
//    counts — and note the L2.1 diagnosis (fire-time target pose) was only
//    part of it; the arc-fidelity corrections in CosmeticFire.h did most of
//    the work.
// 3. Authored FX had never been seen reading an *invented* bolt in a game that
//    actually has such widgets. Closed on ZK: `gfx_projectile_lights.lua`
//    lights Tier-C bolts through the A3 live map, 7,222 point lights landing
//    on a cosmetic bolt (best 0.0005 elmos) carrying the widget's own
//    arithmetic over ZK's authored light params.
//
// Turn it off with `LatencyCosmeticFire = 0` in springsettings.cfg; the
// simulated path is untouched and still correct.
CONFIG(bool, LatencyCosmeticFire)
	.defaultValue(true)
	.description("PLAN-latency L2.1: resolve FX_TIER_COSMETIC weapon shots at fire time"
	             " instead of spawning a sim projectile. Requires an L2.2-capable client"
	             " to render the result.");

CosmeticFireQueue cosmeticFireQueue;


float3 CosmeticFlightPos(const float3& origin, const float3& launchVel, float gravity, float t)
{
	// CProjectile::Update integrates per tick as `speed += g; pos += speed`,
	// applying gravity BEFORE the position step (Projectile.cpp ~117). After n
	// ticks that is p0 + n*v0 + g*(1+2+...+n), i.e.
	//
	//     p.y = y0 + v0.y*t + 0.5*g*t*(t + 1)
	//
	// NOT the textbook 0.5*g*t^2. The extra half-step `0.5*g*t` is small per
	// frame and easy to dismiss, but it is a systematic bias in one direction
	// and it compounds over a flight: with g negative the textbook form rides
	// ABOVE the real shell by 0.5*|g|*t, so the walk clears a hull the sim
	// clips and then flies on to hit the ground further out.
	//
	// Measured cost of getting this wrong on papertanks (heavy cannon, 250
	// elmos, both tanks pinned so shot counts match exactly): the substituted
	// shots landed a mean 36 elmos from the target against the sim's 30, and
	// scored 16/48 damage events against the sim's 41/48 — a 3.1x damage
	// SHORTFALL, on a shallow arc where a ~2 elmo vertical error becomes tens
	// of elmos of horizontal overfly. See PLAN-latency-impl.md Phase L2.2.
	float3 p = origin + launchVel * t;
	p.y += 0.5f * gravity * t * (t + 1.0f);
	return p;
}


float CosmeticFlightFrames(const float3& origin, const float3& launchVel, const float3& aimPos)
{
	const float3 delta = aimPos - origin;

	// Horizontal speed is unaffected by gravity, so horizontal distance over
	// horizontal speed is the exact arrival time for a ballistic arc. This is
	// the same quantity CCannon::FireImpl already computes as `predict`.
	const float speed2D = launchVel.Length2D();
	if (speed2D > 0.001f)
		return delta.Length2D() / speed2D;

	// Straight up/down (or a degenerate aim): fall back to 3-D.
	const float speed3D = launchVel.Length();
	if (speed3D > 0.001f)
		return delta.Length() / speed3D;

	return 0.0f;
}


float3 CosmeticPredictedPose(const float3& pos, const float3& velPerFrame, float frames)
{
	if (!(frames > 0.0f) || !std::isfinite(frames))
		return pos;

	return pos + velPerFrame * frames;
}


CosmeticFlight SolveCosmeticFlight(
	const float3& origin,
	const float3& launchVel,
	float gravity,
	const float3& aimPos,
	int ttl,
	float (*groundAt)(float x, float z),
	const CosmeticTargetHit& targetHit
) {
	CosmeticFlight out;

	float t = CosmeticFlightFrames(origin, launchVel, aimPos);

	// A degenerate launch (zero velocity, or the muzzle already on the aim
	// point) still has to produce a usable event: one frame, terminating at
	// the aim point.
	if (!(t > 0.0f)) {
		out.frames = 1;
		out.impactPos = aimPos;
		return out;
	}

	// How far the walk is allowed to run — NOT the same thing as the time to
	// the aim point.
	//
	// A real projectile flies until it hits something or its ttl expires. It
	// does not stop when it draws level with what it was aimed at: a cannon
	// gets `ttl = predict * 2` precisely so a shot sprayed high can overfly
	// its target and come down well behind it, dealing little or nothing.
	//
	// L2.1 walked only as far as the aim point, and that was its largest
	// error by a wide margin. A sprayed shot that should have sailed past
	// instead terminated in mid-air directly over the target and delivered
	// near-full AoE. Measured on papertanks against a STATIONARY heavy tank
	// — where no pose-prediction effect can exist at all — the substitution
	// landed 306 dmg/shot against the sim's 132. Extending the horizon to
	// ttl brings it back to the sim's own number (see PLAN-latency-impl.md
	// Phase L2.2). The aim-point time survives only as the fallback for an
	// unbounded shot, which has nothing else to terminate it.
	const float horizon = (ttl > 0) ? static_cast<float>(ttl) : t;

	// Walk the arc looking for the first termination — the target's collision
	// volume or the ground, whichever comes first. Sampling per frame matches
	// the sim's own collision granularity (CWeaponProjectile only tests once
	// per tick), so this finds the same crossing tick the real projectile
	// would have. Bisect inside that tick for a clean impact point rather
	// than a stair-stepped one.
	const int steps = static_cast<int>(std::ceil(horizon));
	float  tEnd = horizon;
	bool   ground = false;
	bool   onTarget = false;
	float3 targetHitPos;

	auto belowGround = [&](const float3& p) {
		return p.y <= groundAt(p.x, p.z);
	};

	float3 prev = origin;
	for (int i = 1; i <= steps; ++i) {
		const float ti = std::min(static_cast<float>(i), horizon);
		const float3 p = CosmeticFlightPos(origin, launchVel, gravity, ti);

		// Unit first, then terrain — the order CProjectileHandler::CheckCollisions
		// uses, and the one that lets a shell landing at its target's feet count
		// as the direct hit it was aimed to be.
		const bool tgt = targetHit && targetHit(prev, p, targetHitPos);
		const bool grd = !tgt && belowGround(p);
		if (!tgt && !grd) {
			prev = p;
			continue;
		}

		if (tgt) {
			// The collision test reports the exact entry point, so there is
			// nothing to bisect: convert it back to a frame offset along the
			// step it happened in.
			const float segLen = (p - prev).Length();
			const float frac = (segLen > 0.001f)
				? std::clamp((targetHitPos - prev).Length() / segLen, 0.0f, 1.0f)
				: 0.0f;
			tEnd = static_cast<float>(i - 1) + frac * (ti - static_cast<float>(i - 1));
			onTarget = true;
			break;
		}

		// Detonate at the TICK, not at the exact ground crossing inside it.
		//
		// This looks like a downgrade and is the opposite. A real projectile
		// is only collision-tested once per tick, so it overshoots the true
		// crossing by up to a full frame of travel and bursts *there*. On a
		// shallow direct-fire arc that overshoot is ~10 elmos horizontally —
		// well inside an AoE radius, so it decides how much damage the shot
		// delivers. Bisecting to the "clean" crossing pulls every ground burst
		// short of where the sim would have put it, which reads as the
		// substitution hitting harder than the real shell: measured 1.83x
		// total damage with the bisection in, against a sim whose ground
		// bursts sat at a repeatable 30 elmos while the bisected ones spread
		// 9-36 (PLAN-latency-impl.md Phase L2.2).
		//
		// Prettiness is not the goal here — the impact point is a damage input
		// first and a visual second, and the client draws the arc through
		// whatever endpoint this returns either way.
		tEnd = ti;
		ground = true;
		break;
	}

	out.hitGround = ground;
	out.hitTarget = onTarget;
	out.impactPos = onTarget
		? targetHitPos
		: CosmeticFlightPos(origin, launchVel, gravity, tEnd);
	// Round up: the presentation timeline is frame-quantised, and arriving on
	// the frame *after* the true crossing keeps the visual from terminating
	// before the damage does.
	out.frames = std::max(1, static_cast<int>(std::ceil(tEnd)));
	return out;
}


void CosmeticFireQueue::Push(const PendingCosmeticImpact& p)
{
	pending.push_back(p);
}


void CosmeticFireQueue::Update(int frame)
{
	if (pending.empty())
		return;

	// Partition rather than erase-per-item: a busy frame can retire dozens.
	size_t w = 0;
	for (size_t r = 0; r < pending.size(); ++r) {
		PendingCosmeticImpact& p = pending[r];
		if (p.impactFrame > frame) {
			if (w != r)
				pending[w] = p;
			++w;
			continue;
		}

		CUnit* owner = (p.ownerId >= 0) ? unitHandler.GetUnit(p.ownerId) : nullptr;
		// The predicted target may have died during the flight; resolving it
		// again here (rather than caching a pointer) is both safer and the
		// honest answer — a dead unit takes no damage.
		CUnit* hitUnit = (p.targetUnitId >= 0) ? unitHandler.GetUnit(p.targetUnitId) : nullptr;

		if (p.damages != nullptr && p.weaponDef != nullptr) {
			const DamageArray& damageArray = p.damages->GetDynamicDamages(p.startPos, p.impactPos);
			const CExplosionParams params = {
				p.impactPos,
				float3(p.impactDir).SafeNormalize(),
				damageArray,
				p.weaponDef,
				owner,
				hitUnit,
				nullptr,                                              // hitFeature
				p.damages->craterAreaOfEffect,
				p.damages->damageAreaOfEffect,
				p.damages->edgeEffectiveness,
				p.damages->explosionSpeed,
				p.weaponDef->noExplode ? 0.3f : 1.0f,                 // gfxMod
				0.0f,                                                 // maxGroundDeformation
				p.weaponDef->impactOnly,
				p.weaponDef->noExplode || p.weaponDef->noSelfDamage,  // ignoreOwner
				true,                                                 // damageGround
				0u                                                    // projectileID — none exists
			};
			helper->Explosion(params);
			++applied;

			// Hit sound. CWeaponProjectile::Collision emits this on terrain
			// and feature hits; unit hits get theirs from CUnit::DoDamage.
			// Reproduced here for the same reason and with the same picks.
			if (hitUnit == nullptr && p.weaponDef->hitSound.NumSounds() > 0) {
				const bool wet = p.impactPos.y < 0.0f;
				const size_t fireCount = p.weaponDef->fireSound.NumSounds();
				const size_t hitCount  = p.weaponDef->hitSound.NumSounds();
				const size_t pick = (wet && hitCount > 1) ? 1u : 0u;
				const int soundId = static_cast<int>(fireCount + pick);
				if (eventHandler.AllowSound(p.weaponDef->id, /*kind=Weapon*/ 1,
				                            soundId, p.team, p.impactPos)) {
					SoundEventData se;
					se.soundId = static_cast<uint16_t>(soundId);
					se.sourceDefId = static_cast<uint16_t>(p.weaponDef->id);
					se.sourceKind = 1; // SoundSourceKind_Weapon
					se.position = p.impactPos;
					se.priority = 128;
					se.team = p.team;
					se.channel = SoundEventChannel::Battle;
					soundEvents.Push(se);
				}
			}
		}

		// DecRef does not tolerate null; the resolver always supplies an
		// array, but the queue is also driven by tests and by teardown.
		if (p.damages != nullptr)
			DynDamageArray::DecRef(p.damages);
	}

	pending.resize(w);
}


void CosmeticFireQueue::Clear()
{
	for (const PendingCosmeticImpact& p : pending) {
		if (p.damages != nullptr)
			DynDamageArray::DecRef(p.damages);
	}
	pending.clear();
}


bool CosmeticFireEnabled()
{
	static const bool enabled = (configHandler != nullptr)
		&& configHandler->GetBool("LatencyCosmeticFire");
	return enabled;
}


/// Which projectile types the substitution can stand in for. The test is not
/// "is it Tier C" but "does this projectile carry the shot's entire damage
/// delivery in its own collision". Beam/lightning fail that (their FireImpl
/// applies damage inline and the projectile is decoration), so they keep the
/// real path regardless of tier.
static bool IsSubstitutableType(const WeaponDef* wd)
{
	if (wd->IsHitScanWeapon())
		return false;

	switch (wd->projectileType) {
		case WEAPON_EMG_PROJECTILE:
		case WEAPON_EXPLOSIVE_PROJECTILE:
		case WEAPON_FIREBALL_PROJECTILE:
		case WEAPON_LASER_PROJECTILE:
		case WEAPON_MISSILE_PROJECTILE:
			return true;
		// FLAME is excluded: CFlameProjectile grows its collision radius over
		// its life and damages repeatedly along the stream, so a single
		// terminal explosion is not a faithful stand-in for it.
		// STARBURST and TORPEDO are excluded by the classifier already
		// (strategicType forces Tier S); listed here so the reason survives
		// if the classifier ever changes.
		default:
			return false;
	}
}


bool TryResolveCosmeticFire(const ProjectileParams& params)
{
	const WeaponDef* wd = params.weaponDef;
	if (wd == nullptr || !wd->IsCosmeticFx())
		return false;
	if (!CosmeticFireEnabled())
		return false;
	if (!IsSubstitutableType(wd))
		return false;

	const unsigned int ownerID = (params.owner != nullptr)
		? static_cast<unsigned int>(params.owner->id) : params.ownerID;
	const unsigned int teamID = (params.owner != nullptr)
		? static_cast<unsigned int>(params.owner->team) : params.teamID;

	// Mirror CWeaponProjectile's damages resolution exactly: the weapon
	// instance's array when it can be reached (Lua can retune it per unit at
	// runtime), else the def's.
	const DynDamageArray* damages = nullptr;
	if (ownerID != -1u && params.weaponNum != -1u) {
		const CUnit* owner = unitHandler.GetUnit(ownerID);
		const CWeapon* weapon = (owner != nullptr && params.weaponNum < owner->weapons.size())
			? owner->weapons[params.weaponNum] : nullptr;
		if (weapon != nullptr)
			damages = weapon->damages;
	}
	if (damages == nullptr)
		damages = &wd->damages;

	// `params.gravity` is the weapon's override; 0 means "use the map's",
	// which is what CProjectile's constructor resolves mygravity to. Only
	// ballistic types read it at all.
	const bool ballistic = (wd->projectileType == WEAPON_EXPLOSIVE_PROJECTILE)
	                    || (wd->projectileType == WEAPON_EMG_PROJECTILE);
	const float gravity = ballistic ? params.gravity : 0.0f;

	// The one collision the substitution still models: the shot's own target.
	// Everything else in the path is ignored (see the header's cost list).
	CUnit* targetUnit = dynamic_cast<CUnit*>(params.target);
	CosmeticTargetHit targetHit;
	if (targetUnit != nullptr) {
		// The same test CProjectileHandler::CheckUnitCollisions runs against a
		// live projectile's [prevPos, pos] segment, against the same collision
		// volume — so a shot the sim would have missed is still a miss here.
		//
		// Resolved against the target's PREDICTED ARRIVAL pose, not its pose
		// at fire time. This is the L2 decision the L2.1 measurement forced
		// (see the header): a simulated shell has to connect with wherever the
		// target is when it gets there, so testing against the fire-time pose
		// gave the substituted shot a target that had already left. Advancing
		// the pose by the flight time restores the thing the sim actually
		// tests.
		//
		// The lead estimate is the flight time to the aim point — exact for a
		// ballistic arc (horizontal speed is constant), and cheap: no
		// iteration, no state. It is deliberately the same constant-velocity
		// assumption CWeapon made when it computed `params.end`, so the
		// collision test and the aim it is testing agree. Bounded by ttl for
		// the same reason the flight itself is.
		float leadFrames = CosmeticFlightFrames(params.pos, params.speed, params.end);
		if (params.ttl > 0)
			leadFrames = std::min(leadFrames, static_cast<float>(params.ttl));

		CMatrix44f tgtMat = targetUnit->GetTransformMatrix(true);
		tgtMat.SetPos(CosmeticPredictedPose(tgtMat.GetPos(), targetUnit->speed, leadFrames));

		targetHit = [targetUnit, tgtMat](const float3& p0, const float3& p1, float3& hitPos) {
			CollisionQuery cq;
			if (!CCollisionHandler::DetectHit(targetUnit, tgtMat, p0, p1, &cq))
				return false;
			hitPos = cq.GetHitPos();
			return true;
		};
	}

	const CosmeticFlight flight = SolveCosmeticFlight(
		params.pos, params.speed, gravity, params.end, params.ttl,
		[](float x, float z) { return CGround::GetHeightReal(x, z, true); },
		targetHit);

	const int fireFrame   = gs->frameNum;
	const int impactFrame = fireFrame + flight.frames;

	// Outcome labels the visual; the damage is the same explosion at the same
	// point either way, so AoE still decides who is actually hurt — there is
	// no invented hit roll. What `hitTarget` changes is whether the explosion
	// is told which unit it struck, which is the difference between a direct
	// hit and a splash landing nearby.
	uint8_t outcome = COSMETIC_OUTCOME_MISS;
	int hitUnitId = -1;
	if (flight.hitTarget && targetUnit != nullptr) {
		outcome = COSMETIC_OUTCOME_HIT;
		hitUnitId = targetUnit->id;
	} else if (!flight.hitGround && params.ttl > 0 && flight.frames >= params.ttl) {
		// Bounded by ttl without reaching ground or target — a self-detonation,
		// not a miss on anything.
		outcome = COSMETIC_OUTCOME_EXPIRED;
	}

	PendingCosmeticImpact pend;
	pend.impactFrame  = impactFrame;
	pend.impactPos    = flight.impactPos;
	pend.impactDir    = params.speed;
	pend.startPos     = params.pos;
	pend.damages      = DynDamageArray::IncRef(damages);
	pend.weaponDef    = wd;
	pend.ownerId      = (ownerID != -1u) ? static_cast<int>(ownerID) : -1;
	pend.targetUnitId = hitUnitId;
	pend.team         = static_cast<uint8_t>(std::min(255u, teamID));
	cosmeticFireQueue.Push(pend);

	FireOutcomeEventData ev;
	ev.fireFrame   = static_cast<uint32_t>(fireFrame);
	ev.weaponDefId = static_cast<uint16_t>(wd->id);
	ev.ownerId     = (ownerID != -1u) ? static_cast<uint32_t>(ownerID) : 0u;
	ev.team        = pend.team;
	ev.origin      = params.pos;
	ev.targetId    = (targetUnit != nullptr) ? static_cast<uint32_t>(targetUnit->id) : 0u;
	ev.targetPos   = params.end;
	ev.outcome     = outcome;
	ev.impactFrame = static_cast<uint32_t>(impactFrame);
	ev.impactPos   = flight.impactPos;
	ev.gravity     = gravity;
	projectileEvents.PushFireOutcome(ev);

	return true;
}
