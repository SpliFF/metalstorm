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
 * it. A bridge span WAS authored with its origin at the pier base, so the
 * trafficable deck sat `deck_top` ABOVE that origin, and the clamp carried
 * the span (and therefore the deck) up with any earthwork: the gap between the
 * road a unit drives on and the deck it should be driving on was INVARIANT
 * under every terrain lever. §2j measured it and the user ruled A + C.
 *
 * This header is the C half: a def that DECLARES a deck is SEATED — it holds
 * the y it was staged at instead of being floated up by the clamp, so a chain
 * of spans lays a LEVEL deck at a declared level. §M3 measured a chain staged
 * at y = 0 holding 0.00 across all four spans (the ground under a ford is
 * below 0, so the clamp never fired) against a map-placed chain's
 * -31.0 / -34.5 / -45.9 / -57.6 staircase; seating is that same behaviour made
 * explicit and extended to DRY ground, where the clamp did fire.
 *
 * ---------------------------------------------------------------------------
 * A DECK AT THE ORIGIN IS STILL A DECK (2026-09-20)
 * ---------------------------------------------------------------------------
 * The first cut of this file encoded "declares a deck" in the SIGN of the
 * offset — `IsSeated(float h) { return h > 0.0f; }` — which was writable only
 * while a deck could not BE the origin. §2j option A (`7b0f56b829`,
 * 2026-08-19) then re-authored `ms_road_bridge` and `ms_rail_bridge` with
 * their origin ON the deck, making their truthful `customparams.deck_top`
 * exactly 0, which that predicate read as "no deck declared". A cancelled C:
 * neither shipped span was seated any more and both were back on the clamp.
 *
 * So declaration and offset are now two SEPARATE facts, carried together in
 * `DeckSpec`: `declared` says the def has a deck at all, `height` says where
 * it is relative to the origin and is free to be 0 (or negative — a model
 * authored from its parapet down). Nothing infers one from the other.
 * `ResolveDeck` derives `declared` from the PRESENCE of the key, which is the
 * same contract the content-side reader already keeps: `tools/mapgen`'s
 * `ms_defs.feature_deck_top` RAISES on a def that declares none rather than
 * defaulting to 0, precisely so "a caller that treats 0 as missing" cannot
 * happen there. This file now matches it.
 *
 * Every feature that is not a span is unaffected, as before: a def with no
 * `deckHeight` key and no `customparams.deck_top` declares nothing and keeps
 * the historic clamp, byte for byte.
 * ---------------------------------------------------------------------------
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

	/// What a featuredef says about its trafficable deck. The two fields are
	/// independent on purpose — see the header comment: `height == 0.0f` is a
	/// perfectly ordinary deck (the origin IS the deck), and is NOT the way
	/// "no deck" is spelled. `declared == false` is.
	struct DeckSpec {
		bool  declared = false;
		float height   = 0.0f;
	};

	/// A def that declares a deck is seated; everything else keeps the clamp.
	inline bool IsSeated(const DeckSpec& deck) { return deck.declared; }

	/// The y a feature holds at the end of a tick, given where it is now and
	/// what the ground under it reads. A seated feature holds its own y; every
	/// other feature is clamped UP to the ground exactly as before.
	inline float SettleHeight(float posY, float groundHeight, const DeckSpec& deck)
	{
		if (IsSeated(deck))
			return posY;

		return std::max(groundHeight, posY);
	}

	/// The trafficable surface of a span standing at `posY`. This is the level
	/// a road, an abutment or a unit's wheels have to meet. A def with no deck
	/// has no deck: its "level" is simply where it stands.
	inline float DeckLevel(float posY, const DeckSpec& deck) { return posY + deck.height; }

	/// The y a span must be STAGED at for its deck to land on `deckLevel`.
	/// The scenario path passes exactly this to Spring.CreateFeature. With the
	/// shipped spans (origin on the deck, height 0) it degenerates to
	/// `deckLevel` itself — which is the point of option A, not a bug.
	inline float StagingHeightForDeck(float deckLevel, const DeckSpec& deck) { return deckLevel - deck.height; }

	/// Resolve a def's deck from what it published.
	///
	/// `haveExplicitKey` is whether the featuredef carries a `deckHeight` key
	/// at all (NOT whether its value is interesting) — an explicit key wins
	/// outright and may name any offset, 0 and negative included.
	///
	/// Otherwise `customparams.deck_top` is the fallback, because that is
	/// where the number already lives as published model data (§2j / R3c) —
	/// the content shipped it before the engine could read it, and inventing a
	/// parallel constant here would let the two disagree silently. PRESENCE of
	/// that key is the declaration; its value is just the offset.
	///
	/// An unparseable value reads as "no deck declared" rather than as an
	/// error: a def is content, and refusing to load a map over a typo'd
	/// customparam would be a worse failure than the span sitting where it
	/// always did.
	inline DeckSpec ResolveDeck(
		bool haveExplicitKey,
		float explicitKey,
		const spring::unordered_map<std::string, std::string>& customParams
	) {
		if (haveExplicitKey)
			return DeckSpec{true, explicitKey};

		const auto it = customParams.find("deck_top");

		if (it == customParams.end())
			return DeckSpec{};

		const std::string& raw = it->second;

		char* end = nullptr;
		const float parsed = std::strtof(raw.c_str(), &end);

		// strtof leaves `end` at the start on a total parse failure; a trailing
		// unit or comment ("1.5m") is a typo in the def, not a deck height.
		if (end == raw.c_str() || *end != '\0')
			return DeckSpec{};

		return DeckSpec{true, parsed};
	}

} // namespace FeatureSeating

#endif
