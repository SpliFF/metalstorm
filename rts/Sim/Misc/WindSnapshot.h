/* This file is part of the Spring engine (GPL v2 or later), see LICENSE.html */

// WindSnapshot — the restorable state of EnvResourceHandler (wind + tidal).
//
// WHY THIS EXISTS
// ---------------
// Wind is synced state on a 450-frame cycle that no snapshot section carried.
// `EnvResourceHandler::Update()` runs every sim frame: on the frame where
// `windDirTimer == 0` it draws TWO floats from the synced RNG to pick a new
// wind vector, and on the other 449 it blends `oldWindVec` → `newWindVec` by a
// smoothstep of the timer. So the timer is the phase of that cycle and the
// three vectors are its endpoints and its current position: a restore that
// starts them at their constructor values lands the resumed world on a
// different phase of the wind cycle, draws its next pair of floats on a
// different frame than the captured world would have, and every synced draw
// after that is off by two.
//
// It did not show up in the round-trip measurements (§8) for a mechanical
// reason worth recording: a 20- or 100-tick window never contains a wind
// update, so the only observable difference inside one is the blend, which no
// hash-bearing section reads. The defect is real and invisible at the fixture's
// scale — which is why it is captured rather than left to be rediscovered.
//
// WHAT IS AND IS NOT STATE
// ------------------------
// The field set is exactly EnvResourceHandler's CR_REG_METADATA list. creg is
// stubbed out in this tree (-DNOT_USING_CREG), but its member list is still the
// reference engine's own statement of what this handler's state is, so matching
// it is the faithful-reproduction answer rather than a judgement call.
// `minWindStrength`/`maxWindStrength`/`curTidalStrength` are map-loaded and
// would be re-derived identically by a resuming process; they ride along
// because creg carries them and because a pure setter over captured fields
// cannot disagree with itself.
//
// The two generator id lists ARE captured, and the split between them is the
// load-bearing part: `AddGenerator` puts a new wind generator in
// `newGeneratorIDs`, and `Update()` moves it to `allGeneratorIDs` only after
// pointing it at the current blended direction. Restoring a unit re-runs
// CUnit::PostInit, so the rebuild puts EVERY restored generator back in
// `newGeneratorIDs` — i.e. a world whose generators had all long since been
// introduced to the wind comes back claiming they are all brand new, and each
// one gets a script WindChanged() call it was not due. Apply therefore REPLACES
// both lists (the ApplyGameRules discipline) rather than merging with what the
// rebuild produced.
#pragma once

#include <cstdint>
#include <functional>
#include <vector>

namespace envressnapshot {

/// A plain aggregate, so the SimSnapshot field census can destructure it — the
/// same reason the move-type state structs are aggregates. Vectors are
/// flattened to scalars for the census and for the codec.
struct EnvResourceState {
	float curTidalStrength = 0.0f;
	float curWindStrength = 0.0f;
	float minWindStrength = 0.0f;
	float maxWindStrength = 0.0f;

	float curWindDirX = 0.0f, curWindDirY = 0.0f, curWindDirZ = 0.0f;
	float curWindVecX = 0.0f, curWindVecY = 0.0f, curWindVecZ = 0.0f;
	float newWindVecX = 0.0f, newWindVecY = 0.0f, newWindVecZ = 0.0f;
	float oldWindVecX = 0.0f, oldWindVecY = 0.0f, oldWindVecZ = 0.0f;

	/// Phase of the WIND_UPDATE_RATE cycle. 0 is the frame that draws.
	int32_t windDirTimer = 0;

	std::vector<int32_t> allGeneratorIDs;
	std::vector<int32_t> newGeneratorIDs;
};

/// What the two generator lists become on restore. Pure, and separate from
/// SnapshotApply for the same reason Q-P4's RestoredActiveOrder is separate from
/// the roster rebuild: the rule has three arms that a test can only see if it
/// can supply the roster (an id kept, an id with no unit dropped, an id in both
/// lists kept once), and standing up live CUnits in a doctest to reach them
/// would test the fixture instead of the rule.
struct RestoredGenerators {
	std::vector<int> allGeneratorIDs;
	std::vector<int> newGeneratorIDs;
	int dropped = 0;   ///< captured ids with no unit in the restored roster
};

/// `isLiveUnit` answers whether an id resolves to a unit in the restored world.
/// Update() dereferences that unit with no null check, so an id it says no to is
/// dropped rather than restored.
RestoredGenerators RestoreGenerators(const EnvResourceState& s,
                                     const std::function<bool(int)>& isLiveUnit);

} // namespace envressnapshot
