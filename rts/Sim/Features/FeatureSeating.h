/* This file is part of the Spring engine (GPL v2 or later), see LICENSE.html */

#ifndef FEATURE_SEATING_H
#define FEATURE_SEATING_H

#include <algorithm>
#include <cstdlib>
#include <string>

#include "System/UnorderedMap.hpp"

/*
 * PLAN-maps.md §2j option C — a SEATED feature.
 *
 * `CFeature::UpdatePosition` ends every tick with
 *
 *     Move(UpVector * (max(CGround::GetHeightReal(x, z), pos.y) - pos.y))
 *
 * — a feature's y is clamped UP to the ground and can never be pushed below
 * it. A bridge span is authored with its origin at the pier base, so the
 * trafficable deck sits `deck_top` ABOVE that origin, and the clamp carries
 * the span (and therefore the deck) up with any earthwork: the gap between the
 * road a unit drives on and the deck it should be driving on is INVARIANT
 * under every terrain lever. §2j measured it and the user ruled A + C.
 *
 * This header is the C half: a def that declares a deck height is SEATED — it
 * holds the y it was staged at instead of being floated up by the clamp, so a
 * chain of spans lays a LEVEL deck at a declared level. §M3 measured a chain
 * staged at y = 0 holding 0.00 across all four spans (the ground under a ford
 * is below 0, so the clamp never fired) against a map-placed chain's
 * -31.0 / -34.5 / -45.9 / -57.6 staircase; seating is that same behaviour made
 * explicit and extended to DRY ground, where the clamp did fire.
 *
 * WHAT THIS DOES NOT DO — say it out loud, because the opposite is the natural
 * reading. Seating holds the SPAWN height. A map-placed span still cannot be
 * seated at a useful level: a featureplacer objectlist entry carries only
 * name/x/z/rot (rts/Server/FeatureProcessor.cpp) and
 * `CFeatureHandler::LoadFeaturesFromMap` spawns at `CGround::GetHeightReal`,
 * i.e. the seabed under a ford — so a seated map-placed span holds the seabed.
 * Only the scenario path (`game_scenario.lua`'s `stageFeatures`, which passes
 * an explicit `y` to `Spring.CreateFeature`) can lay a level deck. Nor does
 * this make a span pathable ON TOP of: the ground-blocking map is still single
 * layer and `blocking` is still binary. Seating is about where the deck IS,
 * not about what can walk on it.
 *
 * The functions are pure and header-only so the rule can be tested off-engine
 * (tests/test_feature_seating.cpp) without a sim, a map or a ground mesh.
 */
namespace FeatureSeating {

	/// A def declares a deck by publishing a positive height above its own
	/// origin. Zero (the default) means "no deck declared" — every feature
	/// that is not a span keeps the historic clamp, unchanged.
	inline bool IsSeated(float deckHeight) { return deckHeight > 0.0f; }

	/// The y a feature holds at the end of a tick, given where it is now and
	/// what the ground under it reads. A seated feature holds its own y; every
	/// other feature is clamped UP to the ground exactly as before.
	inline float SettleHeight(float posY, float groundHeight, float deckHeight)
	{
		if (IsSeated(deckHeight))
			return posY;

		return std::max(groundHeight, posY);
	}

	/// The trafficable surface of a span standing at `posY`. This is the level
	/// a road, an abutment or a unit's wheels have to meet.
	inline float DeckLevel(float posY, float deckHeight) { return posY + deckHeight; }

	/// The y a span must be STAGED at for its deck to land on `deckLevel`.
	/// The scenario path passes exactly this to Spring.CreateFeature.
	inline float StagingHeightForDeck(float deckLevel, float deckHeight) { return deckLevel - deckHeight; }

	/// Resolve a def's deck height: the explicit `deckHeight` featuredef key
	/// wins, and `customparams.deck_top` is the fallback because that is where
	/// the number already lives as published model data (§2j / R3c) — the
	/// content shipped it before the engine could read it, and inventing a
	/// parallel constant here would let the two disagree silently.
	///
	/// A negative or unparseable value reads as "no deck declared" rather than
	/// as an error: a deck below its own origin is not a thing a span can have,
	/// and a def that means nothing by the key should behave like every def
	/// that never set it.
	inline float ResolveDeckHeight(
		float explicitKey,
		const spring::unordered_map<std::string, std::string>& customParams
	) {
		if (explicitKey > 0.0f)
			return explicitKey;

		const auto it = customParams.find("deck_top");

		if (it == customParams.end())
			return 0.0f;

		const std::string& raw = it->second;

		char* end = nullptr;
		const float parsed = std::strtof(raw.c_str(), &end);

		// strtof leaves `end` at the start on a total parse failure; a trailing
		// unit or comment ("1.5m") is a typo in the def, not a deck height.
		if (end == raw.c_str() || *end != '\0')
			return 0.0f;

		return std::max(0.0f, parsed);
	}

} // namespace FeatureSeating

#endif
