/* This file is part of the Spring engine (GPL v2 or later), see LICENSE.html */

/**
 * LuaCoordAdapt — legacy-LH ↔ RH-native coord bridge for Lua callouts.
 *
 * The engine + wire format speak glTF-native right-handed coords for
 * direction vectors (+X right, +Y up, -Z forward) but keep world *positions*
 * in `[0, mapX] × [0, mapY] × [0, mapZ]` — the same positive index space
 * Spring's spatial bins (heightmap, QuadField, BlockingMap, LOS grids)
 * use. Handed-ness is a basis-vector property: it changes the meaning of
 * +Z (forward → backward) and the sign of rotation cross products, but
 * does not move the world's origin or extents. The screen-space mapping
 * (camera "up" vector) is what makes "+Z = north = screen-top" visually
 * consistent with LH-authored content.
 *
 * Games whose Lua scripts were authored against Spring's legacy LH
 * frame (heading=0 → +Z, asymmetric piece offsets like `lwheel.offset.z`
 * positive for the left wheel) opt in via the `legacyCoordSystem = true`
 * flag in `modinfo.lua`. The bridge then mirrors Z on direction-vector
 * components at every coord-touching callout — and *only* on direction
 * components. World positions are passed through unchanged because they
 * never flipped in the first place.
 *
 * The two helpers below make the position-vs-direction distinction
 * explicit at every callsite:
 *
 *   FlipDirZ(z)  → -z when legacy active. Apply to direction-vector
 *                  scalars: frontdir, updir, rightdir, velocity, impulse,
 *                  ground normals, piece directions, weapon dir.
 *   FlipPosZ(z)  → no-op. Apply to position scalars: GetUnitPosition,
 *                  GetGroundHeight inputs, CreateUnit, SetUnitPosition,
 *                  marker positions, command param[2] of MOVE/ATTACK/etc.
 *                  (the helper exists purely as documentation — the
 *                  callsites could just pass the scalar through.)
 *
 * Heading itself is left alone: it's an opaque u16 rotation index, and
 * the same numeric value names the same visual rotation in both frames
 * (only the heading↔direction-vector conversion has to be adapted,
 * handled by FlipDirZ at the `Spring.GetVectorFromHeading` /
 * `Spring.GetHeadingFromVector` boundaries).
 *
 * FacingMap labels (FACING_NORTH/SOUTH/EAST/WEST) are also left alone.
 * Enum integer values were kept stable across the RH flip — what
 * changed was which heading each label resolves to (`GetHeadingFromFacing`
 * in SpringMath.inl: `FACING_NORTH → 0` now, was `FACING_SOUTH → 0`).
 * But the world-direction meaning of each label is preserved.
 *
 * The branch is a single bool test, branch-predictor friendly even in
 * tight unit-script loops. New games (legacyCoordSystem absent or false)
 * pay no overhead beyond the predicted-not-taken branch.
 *
 * Removal: `grep -r legacyCoordSystem` finds every site touching this
 * adapter. Deletion is one mechanical pass once no game needs the bridge.
 */
#ifndef LUA_COORD_ADAPT_H
#define LUA_COORD_ADAPT_H

#include "Sim/Misc/ModInfo.h"
#include "System/float3.h"
#include "System/Matrix44f.h"

namespace LuaCoordAdapt {

/// True when the active game opted into the legacy-LH bridge.
inline bool IsLegacy() { return modInfo.legacyCoordSystem; }

/// Mirror Z on a direction-vector scalar (frontdir, normal, velocity,
/// impulse, etc.). The handedness flip lives entirely in direction
/// space; positions stay in [0, mapZ] and use FlipPosZ instead.
inline float FlipDirZ(float z) { return IsLegacy() ? -z : z; }

/// No-op. Exists to make the position-vs-direction classification
/// explicit at every world-position callsite. World positions never
/// flipped under Option A — Spring's spatial bins index [0, mapZ] in
/// both LH and RH frames, and the camera "up" vector is what makes
/// "+Z = north = screen-top" visually consistent.
inline float FlipPosZ(float z) { return z; }

/// Mirror Z on a direction 3-vector (in place / pass-through both work).
inline float3 FlipDirVec(float3 v) {
	if (IsLegacy()) v.z = -v.z;
	return v;
}

/// Conjugate the rotation block of a 4×4 transform by diag(1, 1, -1, 1).
/// Negates the Z row and Z column, excluding m[10] (flipped twice).
/// Translation Z is NOT negated — positions don't flip under Option A.
inline CMatrix44f FlipMatrix(CMatrix44f m) {
	if (!IsLegacy()) return m;
	// Rotation block: negate (row 2, col 2) ∪ (col 2, row 2), excluding (2,2).
	m.m[ 2] = -m.m[ 2];   // col 0, row 2
	m.m[ 6] = -m.m[ 6];   // col 1, row 2
	m.m[ 8] = -m.m[ 8];   // col 2, row 0
	m.m[ 9] = -m.m[ 9];   // col 2, row 1
	// m.m[10] flips twice — leave alone.
	m.m[11] = -m.m[11];   // col 2, row 3 (always 0 for an affine xform)
	// m.m[14] (translation Z) — NOT negated; world positions stay in [0, mapZ].
	return m;
}

} // namespace LuaCoordAdapt

#endif // LUA_COORD_ADAPT_H
