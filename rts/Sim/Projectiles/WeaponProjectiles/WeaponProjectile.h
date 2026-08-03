/* This file is part of the Spring engine (GPL v2 or later), see LICENSE.html */

#ifndef WEAPON_PROJECTILE_H
#define WEAPON_PROJECTILE_H

#include "Sim/Projectiles/Projectile.h"
#include "Sim/Projectiles/ProjectileParams.h" // easier to include this here
#include "Sim/Projectiles/TrajectoryKeyframes.h" // KeyframeState (by value below)
#include "WeaponProjectileTypes.h"

struct WeaponDef;
struct ProjectileParams;
class DynDamageArray;



/**
 * Base class for all projectiles originating from a weapon or having
 * weapon-properties. Uses data from a weapon definition.
 */
class CWeaponProjectile : public CProjectile
{
	CR_DECLARE_DERIVED(CWeaponProjectile)
public:
	CWeaponProjectile(const ProjectileParams& params);
	virtual ~CWeaponProjectile();

	virtual void Explode(CUnit* hitUnit, CFeature* hitFeature, float3 impactPos, float3 impactDir);
	virtual void Collision() override;
	virtual void Collision(CFeature* feature) override;
	virtual void Collision(CUnit* unit) override;
	virtual void Update() override;
	/// @return 0=unaffected, 1=instant repulse, 2=gradual repulse
	virtual int ShieldRepulse(const float3& shieldPos, float shieldForce, float shieldMaxSpeed) { return 0; }

	void DependentDied(CObject* o) override;
	void PostLoad();

	void SetTargetObject(CWorldObject* newTarget) {
		if (newTarget != nullptr)
			targetPos = newTarget->pos;

		target = newTarget;
	}

	const CWorldObject* GetTargetObject() const { return target; }
	      CWorldObject* GetTargetObject()       { return target; }

	const WeaponDef* GetWeaponDef() const { return weaponDef; }

	int GetTimeToLive() const { return ttl; }
	void SetTimeToLive(int newTTL) { ttl = newTTL; }

	void SetStartPos(const float3& newStartPos) { startPos = newStartPos; }
	void SetTargetPos(const float3& newTargetPos) { targetPos = newTargetPos; }

	const float3& GetStartPos() const { return startPos; }
	const float3& GetTargetPos() const { return targetPos; }

	void SetBeingIntercepted(bool b) { targeted = b; }
	bool IsBeingIntercepted() const { return targeted; }
	bool CanBeInterceptedBy(const WeaponDef*) const;
	bool HasScheduledBounce() const { return bounced; }
	bool TraveledRange() const { return ((pos - startPos).SqLength() > (myrange * myrange)); }

	const DynDamageArray* damages;

	/// PLAN-latency L3 — record the outcome the sim actually resolved, for
	/// the benefit of the OutcomeKnownEvent the terminal site emits.
	///
	/// Shield absorption and interceptor kills both reach the projectile
	/// through the no-argument Collision() overload, which cannot tell them
	/// apart from a terrain hit and reports all three as Terrain. Callers
	/// that know better say so here first. (The legacy ProjectileImpactEvent
	/// keeps its existing — wrong — kind for those two cases; correcting it
	/// would change today's client VFX in a server-only milestone. The
	/// keyframe stream reports them accurately and supersedes it.)
	/// `targetId` is the shield-host unit or the interceptor's victim — the
	/// no-argument overload has no argument to derive it from.
	void SetWebOutcomeHint(uint8_t kind, uint32_t targetId = 0u) {
		webOutcomeHint = kind;
		webOutcomeTargetId = targetId;
	}

	/// PLAN-latency L3 — keyframe emission bookkeeping. Deliberately NOT
	/// creg-registered: it is presentation-stream state with no effect on
	/// simulation results, and a reload that resets it costs at most one
	/// redundant Launch knot.
	KeyframeState keyframeState;

protected:
	CWeaponProjectile() { }
	void UpdateInterception();
	virtual void UpdateGroundBounce();

	/// PLAN-latency L3 — write one keyframe for this projectile at the
	/// current sim frame and advance `keyframeState`. No-op when the feature
	/// is off or the weapon does not participate. See TrajectoryKeyframes.h.
	void EmitKeyframe(uint8_t kind, uint8_t stage);

	/// PLAN-latency L3 — sampling half of the above: ask the policy whether
	/// this frame needs a knot, and write it if so.
	void MaybeEmitKeyframe(uint8_t stage, bool guided);

	/// PLAN-latency L3 — terminal knot + OutcomeKnownEvent, emitted from the
	/// Collision sites so the spline provably ends on the explosion.
	void EmitOutcomeKnown(uint8_t impactKind, const float3& impactPos, uint32_t targetId);

	/// 0xFF = "not set, derive the kind from the collision arguments".
	uint8_t webOutcomeHint = 0xFFu;
	uint32_t webOutcomeTargetId = 0u;

protected:
	const WeaponDef* weaponDef;

	CWorldObject* target;

	unsigned int weaponNum;

	int ttl;
	int bounces;

	/// true if we are an interceptable projectile
	// and an interceptor projectile is on the way
	bool targeted;
	bool bounced;

	float3 startPos;
	float3 targetPos;

	float3 bounceHitPos;
	float3 bounceParams;
};

#endif /* WEAPON_PROJECTILE_H */
