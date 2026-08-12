/* This file is part of the Spring engine (GPL v2 or later), see LICENSE.html */


#include "Wind.h"
#include "GlobalSynced.h"
#include "Sim/Units/Unit.h"
#include "Sim/Units/UnitHandler.h"
#include "System/ContainerUtil.h"
#include "System/Log/ILog.h"
#include "System/SpringMath.h"

#include <algorithm>

#include "System/Misc/TracyDefs.h"

CR_BIND(EnvResourceHandler, )

CR_REG_METADATA(EnvResourceHandler, (
	CR_MEMBER(curTidalStrength),
	CR_MEMBER(curWindStrength),
	CR_MEMBER(minWindStrength),
	CR_MEMBER(maxWindStrength),

	CR_MEMBER(curWindVec),
	CR_MEMBER(curWindDir),

	CR_MEMBER(newWindVec),
	CR_MEMBER(oldWindVec),

	CR_MEMBER(windDirTimer),

	CR_MEMBER(allGeneratorIDs),
	CR_MEMBER(newGeneratorIDs)
))


EnvResourceHandler envResHandler;


void EnvResourceHandler::ResetState()
{
	RECOIL_DETAILED_TRACY_ZONE;
	curTidalStrength = 0.0f;
	curWindStrength = 0.0f;
	minWindStrength = 0.0f;
	maxWindStrength = 100.0f;

	curWindDir = RgtVector;
	curWindVec = ZeroVector;
	newWindVec = ZeroVector;
	oldWindVec = ZeroVector;

	windDirTimer = 0;

	allGeneratorIDs.clear();
	allGeneratorIDs.reserve(256);
	newGeneratorIDs.clear();
	newGeneratorIDs.reserve(256);
}

void EnvResourceHandler::LoadWind(float minStrength, float maxStrength)
{
	RECOIL_DETAILED_TRACY_ZONE;
	minWindStrength = std::min(minStrength, maxStrength);
	maxWindStrength = std::max(minStrength, maxStrength);

	curWindVec = mix(curWindDir * GetAverageWindStrength(), RgtVector * GetAverageWindStrength(), curWindDir == RgtVector);
	oldWindVec = curWindVec;
}


void EnvResourceHandler::SnapshotCapture(envressnapshot::EnvResourceState& s) const
{
	s.curTidalStrength = curTidalStrength;
	s.curWindStrength = curWindStrength;
	s.minWindStrength = minWindStrength;
	s.maxWindStrength = maxWindStrength;

	s.curWindDirX = curWindDir.x; s.curWindDirY = curWindDir.y; s.curWindDirZ = curWindDir.z;
	s.curWindVecX = curWindVec.x; s.curWindVecY = curWindVec.y; s.curWindVecZ = curWindVec.z;
	s.newWindVecX = newWindVec.x; s.newWindVecY = newWindVec.y; s.newWindVecZ = newWindVec.z;
	s.oldWindVecX = oldWindVec.x; s.oldWindVecY = oldWindVec.y; s.oldWindVecZ = oldWindVec.z;

	s.windDirTimer = windDirTimer;

	s.allGeneratorIDs.assign(allGeneratorIDs.begin(), allGeneratorIDs.end());
	s.newGeneratorIDs.assign(newGeneratorIDs.begin(), newGeneratorIDs.end());
}

void EnvResourceHandler::SnapshotApply(const envressnapshot::EnvResourceState& s)
{
	curTidalStrength = s.curTidalStrength;
	curWindStrength = s.curWindStrength;
	minWindStrength = s.minWindStrength;
	maxWindStrength = s.maxWindStrength;

	curWindDir = float3(s.curWindDirX, s.curWindDirY, s.curWindDirZ);
	curWindVec = float3(s.curWindVecX, s.curWindVecY, s.curWindVecZ);
	newWindVec = float3(s.newWindVecX, s.newWindVecY, s.newWindVecZ);
	oldWindVec = float3(s.oldWindVecX, s.oldWindVecY, s.oldWindVecZ);

	// The timer is read as `windDirTimer / float(WIND_UPDATE_RATE)` and stepped
	// modulo WIND_UPDATE_RATE + 1, so anything outside that range is not a
	// phase this handler can be in. A payload from a differently-built binary
	// reaching here is already an E1 failure, but the blend factor is fed to
	// smoothstep and a wild value would be silent rather than loud.
	windDirTimer = std::clamp(s.windDirTimer, 0, WIND_UPDATE_RATE);

	// The lists are REPLACED, not merged with what the roster rebuild produced,
	// and every id is checked against that roster: Update() calls
	// unitHandler.GetUnit(id)->UpdateWind() with no null check, so a captured
	// generator whose unit is not in the restored world is a null dereference on
	// the next wind update — up to 450 frames after the restore that caused it.
	const auto restored = envressnapshot::RestoreGenerators(s, [](int id) {
		return unitHandler.GetUnit(id) != nullptr;
	});
	allGeneratorIDs = restored.allGeneratorIDs;
	newGeneratorIDs = restored.newGeneratorIDs;

	if (restored.dropped > 0) {
		LOG_L(L_WARNING, "[%s] dropped %d captured wind generator(s) with no unit "
		                 "in the restored roster", __func__, restored.dropped);
	}
}


namespace envressnapshot {

RestoredGenerators RestoreGenerators(const EnvResourceState& s,
                                     const std::function<bool(int)>& isLiveUnit)
{
	RestoredGenerators out;

	const auto keep = [&](const std::vector<int32_t>& src, std::vector<int>& dst) {
		for (const int32_t id : src) {
			if (id < 0 || !isLiveUnit(int(id))) {
				++out.dropped;
				continue;
			}
			// The two lists are disjoint by construction (DelGenerator relies on
			// it: "id is never present in both"), so an id already kept is not
			// added twice. A duplicate would have the unit's script told the wind
			// changed twice per cycle, and every wind update would push the
			// duplicate into allGeneratorIDs again — an unbounded list.
			const auto seen = [id](const std::vector<int>& v) {
				return std::find(v.begin(), v.end(), int(id)) != v.end();
			};
			if (seen(out.allGeneratorIDs) || seen(out.newGeneratorIDs))
				continue;
			dst.push_back(int(id));
		}
	};
	keep(s.allGeneratorIDs, out.allGeneratorIDs);
	keep(s.newGeneratorIDs, out.newGeneratorIDs);
	return out;
}

} // namespace envressnapshot


bool EnvResourceHandler::AddGenerator(CUnit* u) {
	RECOIL_DETAILED_TRACY_ZONE;
	// duplicates should never happen, no need to check
	return (spring::VectorInsertUnique(newGeneratorIDs, u->id));
}

bool EnvResourceHandler::DelGenerator(CUnit* u) {
	RECOIL_DETAILED_TRACY_ZONE;
	// id is never present in both
	return (spring::VectorErase(newGeneratorIDs, u->id) || spring::VectorErase(allGeneratorIDs, u->id));
}



void EnvResourceHandler::Update()
{
	RECOIL_DETAILED_TRACY_ZONE;
	// zero-strength wind does not need updates
	if (maxWindStrength <= 0.0f)
		return;

	if (windDirTimer == 0) {
		oldWindVec = curWindVec;
		newWindVec = oldWindVec;

		// generate new wind direction
		float newStrength = 0.0f;

		do {
			newWindVec.x -= (gsRNG.NextFloat() - 0.5f) * maxWindStrength;
			newWindVec.z -= (gsRNG.NextFloat() - 0.5f) * maxWindStrength;
			newStrength = newWindVec.Length();
		} while (newStrength == 0.0f);

		// normalize and clamp s.t. minWindStrength <= strength <= maxWindStrength
		newWindVec /= newStrength;
		newWindVec *= (newStrength = std::clamp(newStrength, minWindStrength, maxWindStrength));

		// update generators
		for (const int unitID: allGeneratorIDs) {
			(unitHandler.GetUnit(unitID))->UpdateWind(newWindVec.x, newWindVec.z, newStrength);
		}
	} else {
		const float mod = smoothstep(0.0f, 1.0f, windDirTimer / float(WIND_UPDATE_RATE));

		// blend between old & new wind directions
		// note: generators added on simframes when timer is 0
		// do not receive a snapshot of the blended direction
		curWindVec = mix(oldWindVec, newWindVec, mod);
		curWindStrength = curWindVec.LengthNormalize();

		curWindDir = curWindVec;
		curWindVec = curWindDir * (curWindStrength = std::clamp(curWindStrength, minWindStrength, maxWindStrength));

		for (const int unitID: newGeneratorIDs) {
			// make newly added generators point in direction of wind
			(unitHandler.GetUnit(unitID))->UpdateWind(curWindDir.x, curWindDir.z, curWindStrength);
			allGeneratorIDs.push_back(unitID);
		}

		newGeneratorIDs.clear();
	}

	windDirTimer = (windDirTimer + 1) % (WIND_UPDATE_RATE + 1);
}

