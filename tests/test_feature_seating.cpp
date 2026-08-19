// PLAN-maps.md §2j option C — the seating rule a bridge span is laid by.
//
// The subject is Sim/Features/FeatureSeating.h: the pure half of "a span holds
// the level it was staged at instead of being floated up by the ground clamp".
// CFeature::UpdatePosition' branch on it needs a sim, a map and a ground mesh;
// the rule itself needs none of those, which is why it lives in a header.
//
// The numbers here are the MEASURED ones from §2j/§M3, not invented ones:
//   * ms_road_bridge decks at 1.5 above its origin, ms_rail_bridge at 3.8
//     (features/bridges.lua, customparams.deck_top, measured off the shipped
//     glTF — a single shared constant would be 2.3 elmos wrong for one of them)
//   * a chain staged at y = 0 over a ford held 0.00 / 0.00 / 0.00 / 0.00
//   * the same chain map-placed held -31.0 / -34.5 / -45.9 / -57.6

#include <doctest/doctest.h>

#include "Sim/Features/FeatureSeating.h"

using namespace FeatureSeating;

static spring::unordered_map<std::string, std::string> params(
	std::initializer_list<std::pair<const std::string, std::string>> kv
) {
	spring::unordered_map<std::string, std::string> m;
	for (const auto& p: kv)
		m[p.first] = p.second;
	return m;
}

TEST_SUITE("FeatureSeating") {

TEST_CASE("a def with no deck keeps the historic up-clamp") {
	// Every feature that is not a span: wrecks, relics, trees, rocks. The rule
	// must be byte-identical to the max() it replaced or this change is a
	// world-wide regression rather than a bridge fix.
	CHECK(!IsSeated(0.0f));

	CHECK(SettleHeight(  0.0f,  120.0f, 0.0f) == doctest::Approx( 120.0f)); // buried -> lifted
	CHECK(SettleHeight(400.0f,  120.0f, 0.0f) == doctest::Approx( 400.0f)); // airborne -> held (gravity's job)
	CHECK(SettleHeight(  0.0f,  -57.6f, 0.0f) == doctest::Approx(   0.0f)); // over a ford -> clamp never fires
	CHECK(SettleHeight(-31.0f,  -31.0f, 0.0f) == doctest::Approx( -31.0f)); // already resting
}

TEST_CASE("a declared deck seats the span at its staged level") {
	CHECK(IsSeated(1.5f));
	CHECK(IsSeated(3.8f));

	// The staircase §M3 measured is exactly the ground-clamp arm. Seated, the
	// same four spans hold the level they were staged at.
	const float bed[4] = {-31.0f, -34.5f, -45.9f, -57.6f};

	for (const float g: bed) {
		CHECK(SettleHeight(0.0f, g, 0.0f) == doctest::Approx(0.0f));  // ford: below, clamp inert
		CHECK(SettleHeight(0.0f, g, 1.5f) == doctest::Approx(0.0f));  // seated: same answer
	}

	// The case the clamp actually broke: DRY ground above the staged level.
	// Unseated the span steps up with the bank (the rail run measured
	// 26.1 -> 40.8); seated it holds, and the deck stays level.
	CHECK(SettleHeight(0.0f, 26.1f, 0.0f) == doctest::Approx(26.1f));
	CHECK(SettleHeight(0.0f, 40.8f, 0.0f) == doctest::Approx(40.8f));
	CHECK(SettleHeight(0.0f, 26.1f, 1.5f) == doctest::Approx(0.0f));
	CHECK(SettleHeight(0.0f, 40.8f, 1.5f) == doctest::Approx(0.0f));
}

TEST_CASE("the deck is deckHeight above the origin, and the gap is what a unit drives in") {
	// A span standing on ground g decks at g + deck_top, so a unit driving on
	// the terrain under it is exactly deck_top low — inside the deck slab.
	CHECK(DeckLevel(0.0f, 1.5f) == doctest::Approx(1.5f));
	CHECK(DeckLevel(120.0f, 1.5f) == doctest::Approx(121.5f));
	CHECK(DeckLevel(120.0f, 3.8f) == doctest::Approx(123.8f));

	// ...and raising the ground by d raises the span with it, which is why the
	// gap is invariant under every earthwork (§2j: B cannot close it).
	const float d = 40.0f;
	CHECK(DeckLevel(120.0f + d, 1.5f) - (120.0f + d) == doctest::Approx(DeckLevel(120.0f, 1.5f) - 120.0f));

	// A def with no deck has no deck: its "level" is where it stands.
	CHECK(DeckLevel(120.0f, 0.0f) == doctest::Approx(120.0f));
}

TEST_CASE("staging height is the inverse, so a scenario can name the deck level") {
	// This is the number game_scenario.lua's stageFeatures would pass to
	// Spring.CreateFeature to put a road deck flush with a road at y = 118.
	CHECK(StagingHeightForDeck(118.0f, 1.5f) == doctest::Approx(116.5f));
	CHECK(DeckLevel(StagingHeightForDeck(118.0f, 1.5f), 1.5f) == doctest::Approx(118.0f));
	CHECK(DeckLevel(StagingHeightForDeck(-3.25f, 3.8f), 3.8f) == doctest::Approx(-3.25f));
}

TEST_CASE("deck height is resolved from the number the content already publishes") {
	// customparams.deck_top is the shipped source (features/bridges.lua). The
	// engine reads it rather than carrying a second copy that could drift.
	CHECK(ResolveDeckHeight(0.0f, params({{"deck_top", "1.5"}})) == doctest::Approx(1.5f));
	CHECK(ResolveDeckHeight(0.0f, params({{"deck_top", "3.8"}})) == doctest::Approx(3.8f));

	// An explicit featuredef key wins over the customparam.
	CHECK(ResolveDeckHeight(2.25f, params({{"deck_top", "1.5"}})) == doctest::Approx(2.25f));
	CHECK(ResolveDeckHeight(2.25f, params({})) == doctest::Approx(2.25f));

	// A def that says nothing declares no deck, and is therefore unaffected.
	CHECK(ResolveDeckHeight(0.0f, params({})) == 0.0f);
	CHECK(ResolveDeckHeight(0.0f, params({{"chain_pitch", "24"}})) == 0.0f);
	CHECK(!IsSeated(ResolveDeckHeight(0.0f, params({{"ms_feature_kind", "wreck"}}))));
}

TEST_CASE("a deck height that means nothing reads as no deck, not as an error") {
	// A def is content. Refusing to load a map over a typo'd customparam would
	// be a worse failure than the span sitting where it always did.
	CHECK(ResolveDeckHeight(0.0f, params({{"deck_top", ""}})) == 0.0f);
	CHECK(ResolveDeckHeight(0.0f, params({{"deck_top", "yes"}})) == 0.0f);
	CHECK(ResolveDeckHeight(0.0f, params({{"deck_top", "1.5m"}})) == 0.0f);
	CHECK(ResolveDeckHeight(0.0f, params({{"deck_top", "1.5 "}})) == 0.0f);

	// A deck below its own origin is not a thing a span can have, and a
	// negative seat would be a silent lever on every clamp.
	CHECK(ResolveDeckHeight(0.0f, params({{"deck_top", "-1.5"}})) == 0.0f);
	CHECK(ResolveDeckHeight(-1.5f, params({})) == 0.0f);
	CHECK(!IsSeated(-1.5f));
}

TEST_CASE("seating holds the SPAWN height — a map-placed span still cannot be level") {
	// Said out loud because the opposite is the natural reading, and because a
	// featureplacer objectlist entry carries only name/x/z/rot: LoadFeaturesFromMap
	// spawns at CGround::GetHeightReal, so a seated map-placed span holds the
	// seabed it was spawned on. It is level with NOTHING; it just stops moving.
	const float bed[4] = {-31.0f, -34.5f, -45.9f, -57.6f};

	for (const float g: bed)
		CHECK(SettleHeight(/*spawned at the ground*/ g, g, 1.5f) == doctest::Approx(g));

	// Only an explicit staged y (the scenario path) lays a level deck.
	for (const float g: bed)
		CHECK(SettleHeight(0.0f, g, 1.5f) == doctest::Approx(0.0f));
}

} // TEST_SUITE
