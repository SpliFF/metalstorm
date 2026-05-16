/* This file is part of the Spring engine (GPL v2 or later), see LICENSE.html */

/**
 * LuaCoordAdapt — legacy-LH ↔ RH-native coord bridge for Lua callouts.
 *
 * Phase 3 of PLAN-coordinate-system.md. The engine + wire format now
 * speak glTF-native right-handed coords (+X right, +Y up, -Z forward).
 * Games whose Lua scripts were authored against Spring's legacy
 * left-handed frame (heading=0 → +Z, asymmetric piece offsets like
 * `lwheel.offset.z` positive for the left wheel) opt in via the
 * `legacyCoordSystem = true` flag in `modinfo.lua`.
 *
 * Every coord-touching Lua callout funnels values through the
 * branch-on-flag inline helpers below. When the flag is true, vector
 * Z (and the equivalent matrix entries) get mirrored at the bridge
 * so legacy widgets/gadgets see LH-style values even though the
 * underlying engine state is RH.
 *
 * Heading itself is left alone: it's an opaque u16 rotation index,
 * and the same numeric value names the same visual rotation in both
 * frames (only the heading → direction vector conversion has to be
 * adapted, which we handle by Z-flipping those vectors at the
 * `Spring.GetVectorFromHeading` / `Spring.GetHeadingFromVector`
 * callout boundaries).
 *
 * The branch is a single bool test, branch-predictor friendly even
 * in tight unit-script loops. New games (legacyCoordSystem absent
 * or false) pay no overhead beyond the predicted-not-taken branch.
 *
 * Removal: `grep -r legacyCoordSystem` finds every site touching
 * this adapter (helpers, callout uses, modinfo loader, the flag in
 * CModInfo and GameInfo). Deletion is one mechanical pass once no
 * game needs the bridge.
 */
#ifndef LUA_COORD_ADAPT_H
#define LUA_COORD_ADAPT_H

#include "Sim/Misc/ModInfo.h"
#include "Sim/Units/CommandAI/Command.h"
#include "System/float3.h"
#include "System/Matrix44f.h"

namespace LuaCoordAdapt {

/// True when the active game opted into the legacy-LH bridge.
inline bool IsLegacy() { return modInfo.legacyCoordSystem; }

/// Mirror Z on input or output position/direction scalars.
inline float FlipZ(float z) { return IsLegacy() ? -z : z; }

/// Mirror Z on a 3-vector (in place / pass-through both work).
inline float3 FlipVec(float3 v) {
	if (IsLegacy()) v.z = -v.z;
	return v;
}

/// Conjugate a 4×4 transform by diag(1, 1, -1, 1). Equivalent to
/// negating the Z row and Z column of the rotation block plus the
/// translation Z. m[10] flips twice, so it stays put.
inline CMatrix44f FlipMatrix(CMatrix44f m) {
	if (!IsLegacy()) return m;
	// Rotation block: negate (row 2, col 2) ∪ (col 2, row 2), excluding (2,2).
	m.m[ 2] = -m.m[ 2];   // col 0, row 2
	m.m[ 6] = -m.m[ 6];   // col 1, row 2
	m.m[ 8] = -m.m[ 8];   // col 2, row 0
	m.m[ 9] = -m.m[ 9];   // col 2, row 1
	// m.m[10] flips twice — leave alone.
	m.m[11] = -m.m[11];   // col 2, row 3 (always 0 for an affine xform)
	m.m[14] = -m.m[14];   // translation Z
	return m;
}

/// Flip the Z component of any position parameters embedded in a
/// command's `params` array. Spring command params have a stable
/// shape: position-bearing commands (CMD_MOVE, CMD_ATTACK, CMD_FIGHT,
/// CMD_PATROL, CMD_REPAIR, CMD_RECLAIM, CMD_CAPTURE, CMD_RESURRECT,
/// CMD_LOAD_UNITS, CMD_GUARD-with-pos, etc.) lay out as
/// (x, y, z) at params[0..2], optionally followed by a radius for
/// area commands. CMD_UNLOAD_UNIT shifts the position to params[0..2]
/// with the unitID at [3]. Build commands (negative cmdID) place the
/// build position at params[0..2] with facing at [3].
///
/// We piggy-back on `Command::IsMoveCommand()` / `IsBuildCommand()`
/// from rts/Sim/Units/CommandAI/Command.h to detect the position-
/// bearing shape and flip params[2] in place. Object-only variants
/// (numParams 1 or 2) don't carry a position, so we leave those.
inline void FlipCommandPositionZ(Command& cmd) {
	if (!IsLegacy()) return;

	const int id = cmd.GetID();
	const unsigned int n = cmd.GetNumParams();

	// Build commands: -id is the unitDefID; params layout is
	// (x, y, z, facing). Build a unit at z=N (LH) → engine sees z=-N.
	if (cmd.IsBuildCommand() && n >= 3) {
		cmd.SetParam(2, -cmd.GetParam(2));
		return;
	}

	switch (id) {
		case CMD_MOVE:
		case CMD_PATROL:
		case CMD_FIGHT:
		case CMD_ATTACK:
		case CMD_AREA_ATTACK:
		case CMD_MANUALFIRE:
		case CMD_LOAD_UNITS:
		case CMD_REPAIR:
		case CMD_RECLAIM:
		case CMD_RESURRECT:
		case CMD_CAPTURE:
		case CMD_RESTORE:
		case CMD_UNLOAD_UNIT:
		case CMD_UNLOAD_UNITS:
			// Object-only variants (1–2 params) carry no position.
			if (n >= 3)
				cmd.SetParam(2, -cmd.GetParam(2));
			break;
		default: break;
	}
}

} // namespace LuaCoordAdapt

#endif // LUA_COORD_ADAPT_H
