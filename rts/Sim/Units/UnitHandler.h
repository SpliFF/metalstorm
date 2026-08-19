/* This file is part of the Spring engine (GPL v2 or later), see LICENSE.html */

#ifndef UNITHANDLER_H
#define UNITHANDLER_H

#include <algorithm>
#include <array>
#include <cstdint>
#include <vector>

#include "Sim/Misc/GlobalConstants.h"
#include "Sim/Misc/SimObjectIDPool.h"
#include "System/creg/STL_Map.h"

struct UnitDef;
class CUnit;
class CBuilderCAI;

class CUnitHandler
{
	CR_DECLARE_STRUCT(CUnitHandler)

public:
	CUnitHandler(): idPool(MAX_UNITS) {}

	void Init();
	void Kill();

	void DeleteScripts();

	void Update();
	bool AddUnit(CUnit* unit);

	bool CanAddUnit(int id) const {
		// do we want to be assigned a random ID and are any left in pool?
		if (id < 0)
			return (!idPool.IsEmpty());
		// is this ID not already in use *and* has it been recycled by pool?
		if (id < MaxUnits())
			return (units[id] == nullptr && idPool.HasID(id));
		// AddUnit will not make new room for us
		return false;
	}

	unsigned int NumUnitsByTeam      (int teamNum               ) const { return (unitsByDefs[teamNum][        0].size()); }
	unsigned int NumUnitsByTeamAndDef(int teamNum, int unitDefID) const { return (unitsByDefs[teamNum][unitDefID].size()); }
	unsigned int MaxUnits() const { return maxUnits; }
	unsigned int CalcMaxUnits() const;

	float MaxUnitRadius() const { return maxUnitRadius; }

	/// Returns true if a unit of type unitID can be built, false otherwise
	bool CanBuildUnit(const UnitDef* unitdef, int team) const;
	bool GarbageCollectUnit(unsigned int id);

	void AddBuilderCAI(CBuilderCAI*);
	void RemoveBuilderCAI(CBuilderCAI*);

	void ChangeUnitTeam(CUnit* unit, int oldTeamNum, int newTeamNum);

	// note: negative ID's are implicitly converted
	CUnit* GetUnitUnsafe(unsigned int id) const { return units[id]; }
	CUnit* GetUnit(unsigned int id) const { return ((id < MaxUnits())? units[id]: nullptr); }

	// Spawn generation for id `id`: bumped every time the slot is (re)assigned
	// to a unit. Lets deferred consumers (statistical combat's pending-outcome
	// ring) detect a destroyed-and-reused id and drop misattributed work.
	uint16_t GetUnitSpawnGen(unsigned int id) const {
		return ((id < spawnGens.size())? spawnGens[id]: uint16_t(0));
	}

	// PLAN-long-uptime §3 (S5) growth metrics. Occupancy answers "how much of
	// the id space is spoken for right now"; the generation sum answers "how
	// many times has a slot been handed to a new unit", which is the recycle
	// pressure §7.2 identified as the real S5 risk — ids are recycled, so
	// exhaustion is not the failure mode and aliasing is.
	//
	// Both readings come off the pool, NOT off MaxUnits(): the pool is
	// Expand()ed to MAX_UNITS while MaxUnits() is the mod-limited spawn cap
	// (31998 on Metalstorm), so mixing the two makes an idle game report -2
	// ids in use. Observed exactly that on the first live row.
	unsigned int NumFreeUnitIDs() const { return idPool.GetSize(); }
	unsigned int MaxUnitIDs() const { return idPool.MaxSize(); }

	// PLAN-long-uptime S5 task 6. GetUnitSpawnGen above guards consumers that
	// hold an id for a few frames INSIDE the sim; this guards the one that
	// holds ids for the whole match OUTSIDE it — a remote client, whose
	// id-keyed associations the sim cannot enumerate. Bumps only when an id
	// actually becomes re-issuable. See SimObjectIDPool::GetRecycleEpoch.
	uint32_t IdRecycleEpoch() const { return idPool.GetRecycleEpoch(); }
	uint64_t TotalUnitSpawnGens() const {
		uint64_t sum = 0;
		for (uint16_t g: spawnGens)
			sum += g;
		return sum;
	}

	static CUnit* NewUnit(const UnitDef* ud);

	const std::vector<CUnit*>& GetUnitsToBeRemoved() const { return unitsToBeRemoved; }
	const std::vector<CUnit*>& GetActiveUnits() const { return activeUnits; }
	      std::vector<CUnit*>& GetActiveUnits()       { return activeUnits; }

	/// The staggered SlowUpdate cursor. Synced, cross-frame state: it only
	/// rewinds to 0 every UNIT_SLOWUPDATE_RATE frames, so on any other frame it
	/// says which slice of activeUnits SlowUpdateUnits() will visit next. A
	/// snapshot has to carry it (PLAN-persistence Q-P4) — a world resumed with
	/// the cursor at 0 slow-updates a different set of units than the world it
	/// claims to be, and CWeapon::SlowUpdate draws from the synced RNG.
	/// Recoil serializes the same member (CR_MEMBER(activeSlowUpdateUnit)).
	size_t GetActiveSlowUpdateUnit() const { return activeSlowUpdateUnit; }
	void SetActiveSlowUpdateUnit(size_t i) {
		// A payload from a world with more units than this one would otherwise
		// leave idxBeg past the end, where `activeUnits.size() - idxBeg`
		// underflows a size_t and the slice becomes the whole vector.
		activeSlowUpdateUnit = std::min(i, activeUnits.size());
	}

	const std::vector<CUnit*>& GetUnitsByTeam      (int teamNum               ) const { return unitsByDefs[teamNum][        0]; }
	const std::vector<CUnit*>& GetUnitsByTeamAndDef(int teamNum, int unitDefID) const { return unitsByDefs[teamNum][unitDefID]; }

	std::vector<CUnit*>& GetUnitsByTeam      (int teamNum               ) { return unitsByDefs[teamNum][        0]; }
	std::vector<CUnit*>& GetUnitsByTeamAndDef(int teamNum, int unitDefID) { return unitsByDefs[teamNum][unitDefID]; }

	const spring::unordered_map<unsigned int, CBuilderCAI*>& GetBuilderCAIs() const { return builderCAIs; }

private:
	void InsertActiveUnit(CUnit* unit);
	bool QueueDeleteUnit(CUnit* unit);
	void QueueDeleteUnits();
	void DeleteUnit(CUnit* unit);
	void DeleteUnits();
	void SlowUpdateUnits();
	void UpdateUnitPathing(const size_t idxBeg, const size_t idxEnd);
	void UpdateUnitMoveTypes();
	void UpdateUnitLosStates();
	void UpdateUnits();
	void UpdateUnitWeapons();

	void GetUnitsWithPathRequests(std::vector<CUnit*>& unitsToMove, const size_t idxBeg, const size_t idxEnd);
	void MultiThreadPathRequests(std::vector<CUnit*>& unitsToMove);
	void SingleThreadPathRequests(std::vector<CUnit*>& unitsToMove);

private:
	SimObjectIDPool idPool;

	std::vector<CUnit*> units;                                           ///< used to get units from IDs (0 if not created)
	std::vector<uint16_t> spawnGens;                                     ///< per-id spawn generation, bumped on slot (re)assignment
	std::array<std::vector<std::vector<CUnit*>>, MAX_TEAMS> unitsByDefs; ///< units sorted by team and unitDef

	std::vector<CUnit*> activeUnits;                                     ///< used to get all active units
	std::vector<CUnit*> unitsToBeRemoved;                                ///< units that will be removed at start of next update

	spring::unordered_map<unsigned int, CBuilderCAI*> builderCAIs;


	size_t activeSlowUpdateUnit = 0;  ///< first unit of batch that will be SlowUpdate'd this frame
	size_t activeUpdateUnit = 0;      ///< first unit of batch that will be SlowUpdate'd this frame


	///< global unit-limit (derived from the per-team limit)
	///< units.size() is equal to this and constant at runtime
	unsigned int maxUnits = 0;

	///< largest radius of any unit added so far (some
	///< spatial query filters in GameHelper use this)
	float maxUnitRadius = 0.0f;

	bool inUpdateCall = false;
};

extern CUnitHandler unitHandler;

#endif /* UNITHANDLER_H */
