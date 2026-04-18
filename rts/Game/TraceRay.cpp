/* This file is part of the Spring engine (GPL v2 or later), see LICENSE.html */

#include "TraceRay.h"
#include "GlobalUnsynced.h"
#include "Map/Ground.h"
#include "Sim/Features/Feature.h"
#include "Sim/Misc/CollisionHandler.h"
#include "Sim/Misc/CollisionVolume.h"
#include "Sim/Misc/LosHandler.h"
#include "Sim/Misc/QuadField.h"
#include "Sim/Misc/TeamHandler.h"
#include "Sim/Units/UnitDef.h"
#include "Sim/Units/UnitHandler.h"
#include "Sim/Units/UnitTypes/Factory.h"
#include "Sim/Weapons/PlasmaRepulser.h"
#include "Sim/Weapons/WeaponDef.h"
#include "System/SpringMath.h"

#include <algorithm>
#include <vector>


inline static bool TestConeHelper(
	const float3& tstPos,
	const float3& tstDir,
	const float length,
	const float spread,
	const CSolidObject* obj
) {
	const CollisionVolume* cv = &obj->collisionVolume;
	const float3 cvRelVec = cv->GetWorldSpacePos(obj) - tstPos;
	const float  cvRelDst = Clamp(cvRelVec.dot(tstDir), 0.0f, length);
	const float  coneSize = cvRelDst * spread + 1.0f;
	const float3 hitVec = tstDir * cvRelDst;
	const float3 hitPos = tstPos + hitVec;

	bool ret = false;

	if (obj->GetBlockingMapID() < unitHandler.MaxUnits()) {
		ret = ret || ((cv->GetPointSurfaceDistance(static_cast<const CUnit*>(obj), nullptr, tstPos) - coneSize) <= 0.0f);
		ret = ret || ((cv->GetPointSurfaceDistance(static_cast<const CUnit*>(obj), nullptr, hitPos) - coneSize) <= 0.0f);
	} else {
		ret = ret || ((cv->GetPointSurfaceDistance(static_cast<const CFeature*>(obj), nullptr, tstPos) - coneSize) <= 0.0f);
		ret = ret || ((cv->GetPointSurfaceDistance(static_cast<const CFeature*>(obj), nullptr, hitPos) - coneSize) <= 0.0f);
	}

	return ret;
}


inline static bool TestTrajectoryConeHelper(
	const float3& tstPos,
	const float3& tstDir,
	float length,
	float linear,
	float quadratic,
	float spread,
	float baseSize,
	const CSolidObject* obj
) {
	const CollisionVolume* cv = &obj->collisionVolume;
	const float3 cvRelVec = cv->GetWorldSpacePos(obj) - tstPos;
	const float  cvRelDst = Clamp(cvRelVec.dot(tstDir), 0.0f, length);
	const float  coneSize = cvRelDst * spread + baseSize;
	const float3 hitVec = tstDir * cvRelDst;
	const float3 hitPos = (tstPos + hitVec) + (UpVector * (quadratic * cvRelDst * cvRelDst + linear * cvRelDst));

	bool ret = false;

	if (obj->GetBlockingMapID() < unitHandler.MaxUnits()) {
		ret = ret || ((cv->GetPointSurfaceDistance(static_cast<const CUnit*>(obj), nullptr, tstPos) - coneSize) <= 0.0f);
		ret = ret || ((cv->GetPointSurfaceDistance(static_cast<const CUnit*>(obj), nullptr, hitPos) - coneSize) <= 0.0f);
	} else {
		ret = ret || ((cv->GetPointSurfaceDistance(static_cast<const CFeature*>(obj), nullptr, tstPos) - coneSize) <= 0.0f);
		ret = ret || ((cv->GetPointSurfaceDistance(static_cast<const CFeature*>(obj), nullptr, hitPos) - coneSize) <= 0.0f);
	}

	return ret;
}


namespace TraceRay {

float TraceRay(const float3& p, const float3& d, float l, int f, const CUnit* o, CUnit*& hu, CFeature*& hf, CollisionQuery* cq)
{
	assert(o != nullptr);
	return (TraceRay(p, d, l, f, o->allyteam, o, hu, hf, cq));
}

float TraceRay(
	const float3& pos,
	const float3& dir,
	float traceLength,
	int traceFlags,
	int allyTeam,
	const CUnit* owner,
	CUnit*& hitUnit,
	CFeature*& hitFeature,
	CollisionQuery* hitColQuery
) {
	const bool scanForEnemies  = ((traceFlags & Collision::NOENEMIES   ) == 0);
	const bool scanForAllies   = ((traceFlags & Collision::NOFRIENDLIES) == 0);
	const bool scanForFeatures = ((traceFlags & Collision::NOFEATURES  ) == 0);
	const bool scanForNeutrals = ((traceFlags & Collision::NONEUTRALS  ) == 0);
	const bool scanForGround   = ((traceFlags & Collision::NOGROUND    ) == 0);
	const bool scanForCloaked  = ((traceFlags & Collision::NOCLOAKED   ) == 0);

	const bool scanForAnyUnits = scanForEnemies || scanForAllies || scanForNeutrals || scanForCloaked;

	hitFeature = nullptr;
	hitUnit = nullptr;

	if (dir == ZeroVector)
		return -1.0f;

	if (scanForFeatures || scanForAnyUnits) {
		CollisionQuery cq;

		QuadFieldQuery qfQuery;
		quadField.GetQuadsOnRay(qfQuery, pos, dir, traceLength);

		if (hitColQuery == nullptr)
			hitColQuery = &cq;

		if (scanForFeatures) {
			for (const int quadIdx: *qfQuery.quads) {
				const CQuadField::Quad& quad = quadField.GetQuad(quadIdx);

				for (CFeature* f: quad.features) {
					if (!f->HasCollidableStateBit(CSolidObject::CSTATE_BIT_QUADMAPRAYS))
						continue;

					if (CCollisionHandler::DetectHit(f, f->GetTransformMatrix(true), pos, pos + dir * traceLength, &cq, true)) {
						const float len = cq.GetHitPosDist(pos, dir);

						if (len >= traceLength)
							continue;

						traceLength = len;
						hitFeature = f;
						*hitColQuery = cq;
					}
				}
			}
		}

		if (scanForAnyUnits) {
			for (const int quadIdx: *qfQuery.quads) {
				const CQuadField::Quad& quad = quadField.GetQuad(quadIdx);

				for (CUnit* u: quad.units) {
					if (u == owner)
						continue;
					if (!u->HasCollidableStateBit(CSolidObject::CSTATE_BIT_QUADMAPRAYS))
						continue;

					bool doHitTest = false;
					doHitTest |= (scanForAllies   && u->allyteam == owner->allyteam);
					doHitTest |= (scanForEnemies  && u->allyteam != owner->allyteam);
					doHitTest |= (scanForNeutrals && u->IsNeutral());
					doHitTest |= (scanForCloaked  && u->IsCloaked());

					if (!doHitTest)
						continue;

					if (CCollisionHandler::DetectHit(u, u->GetTransformMatrix(true), pos, pos + dir * traceLength, &cq, true)) {
						const float len = cq.GetHitPosDist(pos, dir);

						if (len >= traceLength)
							continue;

						traceLength = len;
						hitUnit = u;
						*hitColQuery = cq;
					}
				}
			}

			if (hitUnit != nullptr)
				hitFeature = nullptr;
		}
	}

	if (scanForGround) {
		const float groundLength = CGround::LineGroundCol(pos, pos + dir * traceLength);

		if (traceLength > groundLength && groundLength > 0.0f) {
			traceLength = groundLength;
			hitUnit = nullptr;
			hitFeature = nullptr;
		}
	}

	return traceLength;
}


void TraceRayShields(
	const CWeapon* emitter,
	const float3& start,
	const float3& dir,
	float length,
	std::vector<SShieldDist>& hitShields
) {
	CollisionQuery cq;

	QuadFieldQuery qfQuery;
	quadField.GetQuadsOnRay(qfQuery, start, dir, length);

	for (const int quadIdx: *qfQuery.quads) {
		const CQuadField::Quad& quad = quadField.GetQuad(quadIdx);

		for (CPlasmaRepulser* r: quad.repulsers) {
			if (!r->CanIntercept(emitter->weaponDef->interceptedByShieldType, emitter->owner->allyteam))
				continue;

			if (CCollisionHandler::DetectHit(r->owner, &r->collisionVolume, r->owner->GetTransformMatrix(true), start, start + dir * length, &cq, true)) {
				if (cq.InsideHit() && r->weaponDef->exteriorShield)
					continue;

				const float len = cq.GetHitPosDist(start, dir);

				if (len <= 0.0f)
					continue;

				const auto hitCmp = [](const float a, const SShieldDist& b) { return (a < b.dist); };
				const auto insPos = std::upper_bound(hitShields.begin(), hitShields.end(), len, hitCmp);

				hitShields.insert(insPos, {r, len});
			}
		}
	}
}


bool TestCone(
	const float3& from,
	const float3& dir,
	float length,
	float spread,
	int allyteam,
	int traceFlags,
	CUnit* owner
) {
	QuadFieldQuery qfQuery;
	quadField.GetQuadsOnRay(qfQuery, from, dir, length);

	if (qfQuery.quads->empty())
		return true;

	const bool scanForAllies   = ((traceFlags & Collision::NOFRIENDLIES) == 0);
	const bool scanForNeutrals = ((traceFlags & Collision::NONEUTRALS  ) == 0);
	const bool scanForFeatures = ((traceFlags & Collision::NOFEATURES  ) == 0);

	for (const int quadIdx: *qfQuery.quads) {
		const CQuadField::Quad& quad = quadField.GetQuad(quadIdx);

		if (scanForAllies) {
			for (const CUnit* u: quad.teamUnits[allyteam]) {
				if (u == owner)
					continue;
				if (!u->HasCollidableStateBit(CSolidObject::CSTATE_BIT_QUADMAPRAYS))
					continue;
				if (TestConeHelper(from, dir, length, spread, u))
					return true;
			}
		}

		if (scanForNeutrals) {
			for (const CUnit* u: quad.units) {
				if (!u->IsNeutral())
					continue;
				if (u == owner)
					continue;
				if (!u->HasCollidableStateBit(CSolidObject::CSTATE_BIT_QUADMAPRAYS))
					continue;
				if (TestConeHelper(from, dir, length, spread, u))
					return true;
			}
		}

		if (scanForFeatures) {
			for (const CFeature* f: quad.features) {
				if (!f->HasCollidableStateBit(CSolidObject::CSTATE_BIT_QUADMAPRAYS))
					continue;
				if (TestConeHelper(from, dir, length, spread, f))
					return true;
			}
		}
	}

	return false;
}


bool TestTrajectoryCone(
	const float3& from,
	const float3& dir,
	float length,
	float linear,
	float quadratic,
	float spread,
	int allyteam,
	int traceFlags,
	CUnit* owner
) {
	QuadFieldQuery qfQuery;
	quadField.GetQuadsOnRay(qfQuery, from, dir, length);

	if (qfQuery.quads->empty())
		return true;

	const bool scanForAllies   = ((traceFlags & Collision::NOFRIENDLIES) == 0);
	const bool scanForNeutrals = ((traceFlags & Collision::NONEUTRALS  ) == 0);
	const bool scanForFeatures = ((traceFlags & Collision::NOFEATURES  ) == 0);

	for (const int quadIdx: *qfQuery.quads) {
		const CQuadField::Quad& quad = quadField.GetQuad(quadIdx);

		if (scanForAllies) {
			for (const CUnit* u: quad.teamUnits[allyteam]) {
				if (u == owner)
					continue;
				if (!u->HasCollidableStateBit(CSolidObject::CSTATE_BIT_QUADMAPRAYS))
					continue;
				if (TestTrajectoryConeHelper(from, dir, length, linear, quadratic, spread, 0.0f, u))
					return true;
			}
		}

		if (scanForNeutrals) {
			for (const CUnit* u: quad.units) {
				if (!u->IsNeutral())
					continue;
				if (u == owner)
					continue;
				if (!u->HasCollidableStateBit(CSolidObject::CSTATE_BIT_QUADMAPRAYS))
					continue;
				if (TestTrajectoryConeHelper(from, dir, length, linear, quadratic, spread, 0.0f, u))
					return true;
			}
		}

		if (scanForFeatures) {
			for (const CFeature* f: quad.features) {
				if (!f->HasCollidableStateBit(CSolidObject::CSTATE_BIT_QUADMAPRAYS))
					continue;
				if (TestTrajectoryConeHelper(from, dir, length, linear, quadratic, spread, 0.0f, f))
					return true;
			}
		}
	}

	return false;
}

} //namespace TraceRay
