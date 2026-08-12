/* This file is part of the Spring engine (GPL v2 or later), see LICENSE.html */

#ifndef ENV_RESOURCE_HANDLER_H
#define ENV_RESOURCE_HANDLER_H

#include <vector>

#include "Sim/Misc/GlobalConstants.h"
#include "Sim/Misc/WindSnapshot.h"
#include "System/float3.h"

class CUnit;

// updates time-varying global environment (wind, tidal) energy resources
class EnvResourceHandler
{
	CR_DECLARE_STRUCT(EnvResourceHandler)

public:
	EnvResourceHandler() { ResetState(); }
	EnvResourceHandler(const EnvResourceHandler&) = delete;

	EnvResourceHandler& operator = (const EnvResourceHandler&) = delete;

	void ResetState();
	void LoadTidal(float curStrength) { curTidalStrength = curStrength; }
	void LoadWind(float minStrength, float maxStrength);
	void Update();

	bool AddGenerator(CUnit* u);
	bool DelGenerator(CUnit* u);

	float GetMaxWindStrength() const { return maxWindStrength; }
	float GetMinWindStrength() const { return minWindStrength; }
	float GetAverageWindStrength() const { return ((minWindStrength + maxWindStrength) * 0.5f); }
	float GetCurrentWindStrength() const { return curWindStrength; }
	float GetCurrentTidalStrength() const { return curTidalStrength; }

	const float3& GetCurrentWindVec() const { return curWindVec; }
	const float3& GetCurrentWindDir() const { return curWindDir; }

	/// Snapshot walk (PLAN-persistence, the wind section). Authored inside the
	/// class because every member is private and creg is stubbed in this tree,
	/// exactly as AMoveType::Snapshot{Capture,Apply} are.
	void SnapshotCapture(envressnapshot::EnvResourceState& s) const;
	/// REPLACES the whole handler state, including both generator lists. Must
	/// run AFTER the unit roster is rebuilt: Update() dereferences
	/// unitHandler.GetUnit(id) with no null check, so a captured id that the
	/// restored roster does not carry would be a crash rather than a drift, and
	/// the clamp that drops it needs the roster to be there to ask.
	void SnapshotApply(const envressnapshot::EnvResourceState& s);

private:
	// update all generators every 15 seconds
	static constexpr int WIND_UPDATE_RATE = 15 * GAME_SPEED;

	float curTidalStrength = 0.0f;
	float curWindStrength = 0.0f;

	float minWindStrength = 0.0f;
	float maxWindStrength = 0.0f;

	float3 curWindDir;
	float3 curWindVec; // curWindDir * curWindStrength
	float3 newWindVec;
	float3 oldWindVec;

	int windDirTimer = 0;

	std::vector<int> allGeneratorIDs;
	std::vector<int> newGeneratorIDs;
};

extern EnvResourceHandler envResHandler;

#endif

