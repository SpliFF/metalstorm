/* This file is part of the Spring engine (GPL v2 or later), see LICENSE.html */


#include <algorithm>
#include <cctype>
#include <iostream>
#include <new>
#include <stdexcept>

#include "WeaponDefHandler.h"
#include "Lua/LuaParser.h"
#include "Sim/Misc/DamageArrayHandler.h"
#include "System/Exceptions.h"
#include "System/Log/ILog.h"
#include "System/StringUtil.h"

#include "System/Misc/TracyDefs.h"

// PLAN-replay T2-b / §7.9 T5-c: the handler is a process-lifetime singleton —
// Init() is called once per game load and Kill() is never called — so running
// its destructor during static destruction (__cxa_finalize, after main
// returns) is pure downside: any run that exercised weapon defs still holds
// IncRef'd DynDamageArray references from weapons/projectiles that were never
// torn down, and ~DynDamageArray's `assert(refCount == 1)` turns a clean exit
// into a SIGABRT (exit 134) AFTER "exited cleanly" was logged. That abort made
// spring-server's exit code unusable in CI (the determinism pair-run and the
// replay-verify gate both had to parse log lines instead). Construct the
// handler in static storage via placement-new so its destructor never runs;
// the process exit reclaims the memory. Same lifetime, same address stability,
// no destruction-order fiasco.
alignas(CWeaponDefHandler) static unsigned char gWeaponDefHandlerMem[sizeof(CWeaponDefHandler)];
CWeaponDefHandler* weaponDefHandler = new (gWeaponDefHandlerMem) CWeaponDefHandler();


void CWeaponDefHandler::Init(LuaParser* defsParser)
{
	RECOIL_DETAILED_TRACY_ZONE;
	const LuaTable& rootTable = defsParser->GetRoot().SubTable("WeaponDefs");

	if (!rootTable.IsValid())
		throw content_error("Error loading WeaponDefs");

	std::vector<std::string> weaponNames;
	rootTable.GetKeys(weaponNames);

	weaponDefsVector.reserve(weaponNames.size());
	weaponDefIDs.reserve(weaponNames.size());

	for (int wid = 0; wid < weaponNames.size(); wid++) {
		const std::string& name = weaponNames[wid];
		const LuaTable wdTable = rootTable.SubTable(name);
		weaponDefsVector.emplace_back(wdTable, name, wid);
		weaponDefIDs[name] = wid;
	}

	ClassifyFxTiers();
}


/// PLAN-latency L2.0 — assign every weaponDef a presentation tier, then log the
/// audit table once. Runs as a post-load pass because "can this weapon be
/// stopped by a shield?" depends on which shields exist in *this* game's def
/// set, which is only knowable after every def is parsed.
void CWeaponDefHandler::ClassifyFxTiers()
{
	RECOIL_DETAILED_TRACY_ZONE;

	unsigned int shieldInterceptMask = 0;
	for (const WeaponDef& wd: weaponDefsVector) {
		if (wd.isShield)
			shieldInterceptMask |= wd.shieldInterceptType;
	}

	int cosmetic = 0;
	for (WeaponDef& wd: weaponDefsVector) {
		wd.ClassifyFxTier(shieldInterceptMask);
		cosmetic += (wd.fxTier == FX_TIER_COSMETIC);
	}

	const int total = static_cast<int>(weaponDefsVector.size());
	LOG_L(L_INFO, "[WeaponDefHandler::%s] fxTier: %d/%d cosmetic, %d synced"
	              " (shieldInterceptMask=0x%x)",
	      __func__, cosmetic, total, total - cosmetic, shieldInterceptMask);

	// Per-def table — the audit artifact PLAN-latency-impl §L2.0 asks for.
	// L_DEBUG so a 400-weapon game does not flood a normal server log.
	for (const WeaponDef& wd: weaponDefsVector) {
		LOG_L(L_DEBUG, "[fxTier] %-40s %s", wd.name.c_str(),
		      (wd.fxTier == FX_TIER_COSMETIC) ? "cosmetic" : "synced");
	}
}



const WeaponDef* CWeaponDefHandler::GetWeaponDef(std::string wdName) const
{
	RECOIL_DETAILED_TRACY_ZONE;
	StringToLowerInPlace(wdName);

	const auto it = weaponDefIDs.find(wdName);

	if (it == weaponDefIDs.end())
		return nullptr;

	return &weaponDefsVector[it->second];
}


const WeaponDef* CWeaponDefHandler::GetWeaponDefByID(int id) const
{
	RECOIL_DETAILED_TRACY_ZONE;
	if (!IsValidWeaponDefID(id))
		return nullptr;

	return &weaponDefsVector[id];
}
