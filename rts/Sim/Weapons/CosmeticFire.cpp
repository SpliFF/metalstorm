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

// PLAN-latency L2.1. Default OFF, for two independent reasons.
//
// 1. The substitution is only *observable* once the client renders it (L2.2):
//    with it on and no client-side consumer, a Tier-C weapon fires and nothing
//    is drawn, because the fired/impact events it replaces are exactly what
//    the current projectile renderer listens to. Damage stays correct either
//    way — that half is a rendering cliff, not a correctness one — but
//    shipping it on before L2.2 would make every MG, autocannon and mortar in
//    the game invisible.
// 2. It measurably changes combat balance: resolving against the target's
//    fire-time pose lands 2.8x the damage per shot that the simulated
//    projectile does. Numbers and method in CosmeticFire.h. That needs a
//    decision before it goes on anywhere, independent of the renderer.
//
// L2.2 clears reason 1. Reason 2 is the L2 gate's to settle.
CONFIG(bool, LatencyCosmeticFire)
	.defaultValue(false)
	.description("PLAN-latency L2.1: resolve FX_TIER_COSMETIC weapon shots at fire time"
	             " instead of spawning a sim projectile. Requires an L2.2-capable client"
	             " to render the result.");

CosmeticFireQueue cosmeticFireQueue;


float3 CosmeticFlightPos(const float3& origin, const float3& launchVel, float gravity, float t)
{
	// CWeaponProjectile integrates per tick as `speed.y += mygravity;
	// pos += speed` with mygravity already negative for downward pull. The
	// closed form of that recurrence at real-valued t is the usual
	// p = p0 + v0*t + 0.5*g*t^2 on the vertical axis.
	float3 p = origin + launchVel * t;
	p.y += 0.5f * gravity * t * t;
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

	// Bound by ttl exactly as the real projectile would self-detonate.
	if (ttl > 0)
		t = std::min(t, static_cast<float>(ttl));

	// Walk the arc looking for the first termination — the target's collision
	// sphere or the ground, whichever comes first. Sampling per frame matches
	// the sim's own collision granularity (CWeaponProjectile only tests once
	// per tick), so this finds the same crossing tick the real projectile
	// would have. Bisect inside that tick for a clean impact point rather
	// than a stair-stepped one.
	const int steps = static_cast<int>(std::ceil(t));
	float  tEnd = t;
	bool   ground = false;
	bool   onTarget = false;
	float3 targetHitPos;

	auto belowGround = [&](const float3& p) {
		return p.y <= groundAt(p.x, p.z);
	};

	float3 prev = origin;
	for (int i = 1; i <= steps; ++i) {
		const float ti = std::min(static_cast<float>(i), t);
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

		float lo = static_cast<float>(i - 1);
		float hi = ti;
		for (int iter = 0; iter < 12; ++iter) {
			const float mid = 0.5f * (lo + hi);
			if (belowGround(CosmeticFlightPos(origin, launchVel, gravity, mid)))
				hi = mid;
			else
				lo = mid;
		}
		tEnd = hi;
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
		// The one thing it cannot model is the target moving during the
		// flight: the pose is frozen at fire time.
		const CMatrix44f tgtMat = targetUnit->GetTransformMatrix(true);
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
