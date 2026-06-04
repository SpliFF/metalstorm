/* This file is part of the Spring engine (GPL v2 or later), see LICENSE.html */

#include "LuaConstEngine.h"
#include "LuaHandle.h"
#include "LuaUtils.h"
#include "Game/GameVersion.h"
#include "System/Platform/Misc.h"

/******************************************************************************
 * Engine constants
 * @module Engine
 * @see rts/Lua/LuaConstEngine.cpp
******************************************************************************/

/*** Engine specific information
 *
 * @table Engine
 * @string version Returns the same as `spring  *sync-version`, e.g. "92"
 * @string versionFull 
 * @string versionPatchSet 
 * @string buildFlags (unsynced only) Gets additional engine buildflags, e.g. "OMP" or "MT-Sim DEBUG"
 * @number wordSize indicates the build type and is either 32 or 64 (or 0 in synced code)
 */

bool LuaConstEngine::PushEntries(lua_State* L)
{
	LuaPushNamedString(L, "version"        ,                                    SpringVersion::GetSync()          );
	LuaPushNamedString(L, "versionFull"    , (!CLuaHandle::GetHandleSynced(L))? SpringVersion::GetFull()      : "");
	LuaPushNamedString(L, "buildFlags"     , (!CLuaHandle::GetHandleSynced(L))? SpringVersion::GetAdditional(): "");

	// Version components (Recoil LuaConstEngine.cpp). Pushed UNCONDITIONALLY —
	// games' shared `common/constants.lua` runs `tonumber(Engine.versionMajor)`
	// etc. in both the synced env and the defs parser, and BAR crashed
	// ("compare number with nil") because these were absent / synced-gated.
	// All are numeric strings in our build (Major "105", Minor/PatchSet "0",
	// Commits "9999"). versionPatchSet was previously unsynced-only; make it
	// unconditional to match the rest and avoid a synced-context nil.
	LuaPushNamedString(L, "versionMajor"   , SpringVersion::GetMajor()   );
	LuaPushNamedString(L, "versionMinor"   , SpringVersion::GetMinor()   );
	LuaPushNamedString(L, "versionPatchSet", SpringVersion::GetPatchSet());
	LuaPushNamedString(L, "commitsNumber"  , SpringVersion::GetCommits() );

	#if 0
	LuaPushNamedNumber(L, "nativeWordSize", (!CLuaHandle::GetHandleSynced(L))? Platform::NativeWordSize() * 8: 0); // engine
	LuaPushNamedNumber(L, "systemWordSize", (!CLuaHandle::GetHandleSynced(L))? Platform::SystemWordSize() * 8: 0); // op-sys
	#else
	LuaPushNamedNumber(L, "wordSize", (!CLuaHandle::GetHandleSynced(L))? Platform::NativeWordSize() * 8: 0);
	#endif

	// FeatureSupport — cross-version capability table (Recoil LuaConstEngine.cpp).
	// Entries are bools that are false/nil on "old" engines and true on "new",
	// so `if Engine.FeatureSupport.Foo then` is forward-compatible. Games both
	// READ it (gl4 material/feature gating) and ASSIGN into it (BAR's
	// constants.lua sets FeatureSupport.targetBorderBug), so the table must
	// exist or indexing nil crashes the defs parse. Mirror Recoil's set.
	// NB key is capital "FeatureSupport" (the doc comment's lowercase is
	// misleading); games use Engine.FeatureSupport.
	lua_pushliteral(L, "FeatureSupport");
	lua_createtable(L, 0, 13);
		LuaPushNamedBool(L, "NegativeGetUnitCurrentCommand", true);
		LuaPushNamedBool(L, "hasExitOnlyYardmaps", true);
		LuaPushNamedNumber(L, "rmlUiApiVersion", 1);
		LuaPushNamedBool(L, "noAutoShowMetal", false);
		// MAX_PIECES_PER_MODEL = uint16_max - 1 (Rendering/Models/3DModelDefs.hpp
		// in Recoil; that header is stripped on the headless server, so the
		// literal stands in).
		LuaPushNamedNumber(L, "maxPiecesPerModel", 65534);
		LuaPushNamedBool(L, "transformsInGL4", true);
		LuaPushNamedNumber(L, "gunshipCruiseAltitudeMultiplier", 1.5f);
		LuaPushNamedBool(L, "noRefundForConstructionDecay", false);
		LuaPushNamedBool(L, "noRefundForFactoryCancel", false);
		LuaPushNamedBool(L, "noOffsetForFeatureID", false);
		LuaPushNamedBool(L, "noHandicapForReclaim", true);
		LuaPushNamedBool(L, "groupAddDoesntSelect", true);
		LuaPushNamedBool(L, "deadTeamsKeepUnitLimit", false);
	lua_rawset(L, -3);

	return true;
}

