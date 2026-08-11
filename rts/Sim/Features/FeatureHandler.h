/* This file is part of the Spring engine (GPL v2 or later), see LICENSE.html */

#ifndef _FEATURE_HANDLER_H
#define _FEATURE_HANDLER_H

#include <vector>

#include "System/float3.h"
#include "System/Misc/NonCopyable.h"
#include "System/creg/creg_cond.h"
#include "System/UnorderedSet.hpp"
#include "Sim/Misc/GlobalConstants.h"
#include "Sim/Misc/SimObjectIDPool.h"

class CSolidObject;
struct UnitDef;
class LuaTable;
struct FeatureDef;

struct FeatureLoadParams {
	const CSolidObject* parentObj;
	const UnitDef* unitDef;
	const FeatureDef* featureDef;

	// not used if parentObj != nullptr
	float3 pos;
	float3 speed;

	int featureID;
	int teamID;
	int allyTeamID;

	short int heading;
	short int facing;

	int wreckLevels;
	int smokeTime;
};


class CFeature;
class CFeatureHandler : public spring::noncopyable
{
	CR_DECLARE_STRUCT(CFeatureHandler)

public:
	CFeatureHandler(): idPool(MAX_FEATURES) {}

	void Init();
	void Kill();

	CFeature* LoadFeature(const FeatureLoadParams& params);
	CFeature* CreateWreckage(const FeatureLoadParams& params);
	CFeature* GetFeature(unsigned int id) { return ((id < features.size())? features[id]: nullptr); }

	void UpdatePreFrame();
	void Update();

	bool UpdateFeature(CFeature* feature);
	bool TryFreeFeatureID(int id);
	bool AddFeature(CFeature* feature);
	void DeleteFeature(CFeature* feature);

	/// Destroy every live feature NOW and return every id to the pool, instead
	/// of on the next Update() pass. Added for the snapshot-restore path
	/// (PLAN-persistence task 1e): a restored payload claims the ids the live
	/// features hold, and CanAddFeature refuses an id the pool has not recycled
	/// yet — the deferred path only frees ids every 32 frames, which is long
	/// after the rebuild. Same reason CUnitHandler::GarbageCollectUnit exists on
	/// the unit side. Also drains the pending deletedFeatureIDs list, which is
	/// why this is one bulk call rather than a per-id one: those ids belong to
	/// features that are already gone, and leaving them pending while the caller
	/// re-creates features at arbitrary ids would trip TryFreeFeatureID's
	/// features[id] == nullptr assert and free a live feature's id twice.
	void ClearAllFeatures();

	void LoadFeaturesFromMap();

	void SetFeatureUpdateable(CFeature* feature);
	void TerrainChanged(int x1, int y1, int x2, int y2);

	const spring::unordered_set<int>& GetActiveFeatureIDs() const { return activeFeatureIDs; }

private:
	bool CanAddFeature(int id) const {
		// do we want to be assigned a random ID and are any left in pool?
		if (id < 0)
			return true;
		// is this ID not already in use *and* has it been recycled by pool?
		if (id < features.size())
			return (features[id] == nullptr && idPool.HasID(id));
		// AddFeature will not make new room for us
		return false;
	}

	void InsertActiveFeature(CFeature* feature);

private:
	SimObjectIDPool idPool;

	spring::unordered_set<int> activeFeatureIDs;
	std::vector<int> deletedFeatureIDs;
	std::vector<CFeature*> features;
	std::vector<CFeature*> updateFeatures;
};

extern CFeatureHandler featureHandler;


#endif // _FEATURE_HANDLER_H
