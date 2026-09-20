// PLAN-maps.md §2j option C — the seating rule a bridge span is laid by.
//
// The subject is Sim/Features/FeatureSeating.h: the pure half of "a span holds
// the level it was staged at instead of being floated up by the ground clamp".
// CFeature::UpdatePosition' branch on it needs a sim, a map and a ground mesh;
// the rule itself needs none of those, which is why it lives in a header.
//
// The numbers here are the MEASURED ones from §2j/§M3, not invented ones:
//   * ms_road_bridge and ms_rail_bridge deck at EXACTLY 0 above their origin
//     since §2j option A (2026-08-19) re-authored both with the origin ON the
//     deck; ms_anc_bridge_span still decks at 56 elmos over a footings origin
//     (features/bridges.lua, customparams.deck_top — a single shared constant
//     would be 56 elmos wrong for one of them)
//   * a chain staged at y = 0 over a ford held 0.00 / 0.00 / 0.00 / 0.00
//   * the same chain map-placed held -31.0 / -34.5 / -45.9 / -57.6
//
// ⚠️ THE CASE THAT REGRESSED, AND WHY TWO OF THESE TESTS EXIST. The first cut
// of the header spelled seating as `deckHeight > 0.0f`. Option A then made the
// honest deck_top of both shipped spans 0, so neither was seated any more and
// both were back on the clamp option C existed to escape. Declaration and
// offset are now separate fields of DeckSpec; "a deck declared AT the origin
// is still a deck" is asserted below, and it is what fails if anyone puts the
// sign test back.

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

/// No deck declared — a wreck, a relic, a tree, a rock.
static const DeckSpec NO_DECK  = DeckSpec{};
/// The two shipped steel spans since option A: a deck AT the origin.
static const DeckSpec AT_DECK  = DeckSpec{true, 0.0f};
/// The ancient span, whose origin is still its footings.
static const DeckSpec ANCIENT  = DeckSpec{true, 56.0f};
/// The pre-option-A road span, kept as a case: the offset must stay free.
static const DeckSpec PIER_1_5 = DeckSpec{true, 1.5f};

TEST_SUITE("FeatureSeating") {

TEST_CASE("a def with no deck keeps the historic up-clamp") {
	// Every feature that is not a span: wrecks, relics, trees, rocks. The rule
	// must be byte-identical to the max() it replaced or this change is a
	// world-wide regression rather than a bridge fix.
	//
	// This is also the mutation check in the OTHER direction: switch seating
	// on for a non-span (make IsSeated return true unconditionally, or let
	// ResolveDeck declare a deck for a def that published none) and every
	// CHECK below that expects a lift fails.
	CHECK(!IsSeated(NO_DECK));

	CHECK(SettleHeight(  0.0f,  120.0f, NO_DECK) == doctest::Approx( 120.0f)); // buried -> lifted
	CHECK(SettleHeight(400.0f,  120.0f, NO_DECK) == doctest::Approx( 400.0f)); // airborne -> held (gravity's job)
	CHECK(SettleHeight(  0.0f,  -57.6f, NO_DECK) == doctest::Approx(   0.0f)); // over a ford -> clamp never fires
	CHECK(SettleHeight(-31.0f,  -31.0f, NO_DECK) == doctest::Approx( -31.0f)); // already resting
	CHECK(SettleHeight(  0.0f,   26.1f, NO_DECK) == doctest::Approx(  26.1f)); // dry bank -> steps up with it
	CHECK(SettleHeight(  0.0f,   40.8f, NO_DECK) == doctest::Approx(  40.8f));
}

TEST_CASE("A DECK AT THE ORIGIN IS STILL A DECK") {
	// ⭐ THE REGRESSION CASE, and the one that was missing on 2026-08-19.
	//
	// §2j option A re-authored ms_road_bridge and ms_rail_bridge with their
	// origin ON the trafficable deck, so their truthful customparams.deck_top
	// is exactly 0 — measured off the shipped glTF, 28 deck verts at y = 0.000
	// for the road span, deck slab top at y = 0 for the rail span. Under the
	// old `deckHeight > 0.0f` predicate that read as "no deck declared" and
	// silently unseated BOTH shipped spans. Zero is an offset, not a verdict.
	CHECK(IsSeated(AT_DECK));

	// Restore the sign test and this is where it dies: a span at deck_top = 0
	// over a DRY ravine falls back onto the clamp and steps with the bank,
	// which is the exact staircase option C was written to escape.
	CHECK(SettleHeight(0.0f, 26.1f, AT_DECK) == doctest::Approx(0.0f));
	CHECK(SettleHeight(0.0f, 40.8f, AT_DECK) == doctest::Approx(0.0f));

	// ...and the resolver must reach the same verdict from the content the
	// two spans actually ship, which is the string "0".
	const DeckSpec road = ResolveDeck(false, 0.0f, params({{"deck_top", "0"}}));
	const DeckSpec rail = ResolveDeck(false, 0.0f, params({{"deck_top", "0.0"}}));
	CHECK(IsSeated(road));
	CHECK(IsSeated(rail));
	CHECK(road.height == doctest::Approx(0.0f));
	CHECK(rail.height == doctest::Approx(0.0f));

	// A deck at the origin stages at the level it decks at — option A's whole
	// point — and that is NOT the same statement as "it has no deck".
	CHECK(StagingHeightForDeck(118.0f, AT_DECK) == doctest::Approx(118.0f));
	CHECK(StagingHeightForDeck(118.0f, NO_DECK) == doctest::Approx(118.0f));
	CHECK(IsSeated(AT_DECK) != IsSeated(NO_DECK));
}

TEST_CASE("a declared deck seats the span at its staged level") {
	CHECK(IsSeated(PIER_1_5));
	CHECK(IsSeated(ANCIENT));

	// The staircase §M3 measured is exactly the ground-clamp arm. Seated, the
	// same four spans hold the level they were staged at.
	const float bed[4] = {-31.0f, -34.5f, -45.9f, -57.6f};

	for (const float g: bed) {
		CHECK(SettleHeight(0.0f, g, NO_DECK)  == doctest::Approx(0.0f)); // ford: below, clamp inert
		CHECK(SettleHeight(0.0f, g, AT_DECK)  == doctest::Approx(0.0f)); // seated: same answer
		CHECK(SettleHeight(0.0f, g, PIER_1_5) == doctest::Approx(0.0f));
	}

	// The case the clamp actually broke: DRY ground above the staged level.
	// Unseated the span steps up with the bank (the rail run measured
	// 26.1 -> 40.8); seated it holds, and the deck stays level.
	CHECK(SettleHeight(0.0f, 26.1f, PIER_1_5) == doctest::Approx(0.0f));
	CHECK(SettleHeight(0.0f, 40.8f, PIER_1_5) == doctest::Approx(0.0f));
	CHECK(SettleHeight(0.0f, 26.1f, ANCIENT)  == doctest::Approx(0.0f));
	CHECK(SettleHeight(0.0f, 40.8f, ANCIENT)  == doctest::Approx(0.0f));
}

TEST_CASE("the deck is deckHeight above the origin, and the gap is what a unit drives in") {
	// A span whose origin is the pier base decks at g + deck_top, so a unit
	// driving on the terrain under it is exactly deck_top low — inside the
	// deck slab. This is the gap §2j measured and option A closed by moving
	// the origin, which is why AT_DECK's gap is nothing.
	CHECK(DeckLevel(  0.0f, PIER_1_5) == doctest::Approx(  1.5f));
	CHECK(DeckLevel(120.0f, PIER_1_5) == doctest::Approx(121.5f));
	CHECK(DeckLevel(120.0f, ANCIENT)  == doctest::Approx(176.0f));
	CHECK(DeckLevel(120.0f, AT_DECK)  == doctest::Approx(120.0f));

	// ...and raising the ground by d raises an unseated span with it, which is
	// why the gap was invariant under every earthwork (§2j: B cannot close it).
	const float d = 40.0f;
	CHECK(DeckLevel(120.0f + d, PIER_1_5) - (120.0f + d) == doctest::Approx(DeckLevel(120.0f, PIER_1_5) - 120.0f));

	// A def with no deck has no deck: its "level" is where it stands.
	CHECK(DeckLevel(120.0f, NO_DECK) == doctest::Approx(120.0f));
}

TEST_CASE("staging height is the inverse, so a scenario can name the deck level") {
	// This is the number game_scenario.lua's stageFeatures would pass to
	// Spring.CreateFeature to put a road deck flush with a road at y = 118.
	CHECK(StagingHeightForDeck(118.0f, PIER_1_5) == doctest::Approx(116.5f));
	CHECK(DeckLevel(StagingHeightForDeck(118.0f, PIER_1_5), PIER_1_5) == doctest::Approx(118.0f));
	CHECK(DeckLevel(StagingHeightForDeck(-3.25f, ANCIENT), ANCIENT) == doctest::Approx(-3.25f));

	// The shipped spans: the arithmetic degenerates to identity because the
	// deck IS the origin. `y` names the deck, exactly as game_scenario.lua says.
	CHECK(DeckLevel(StagingHeightForDeck(118.0f, AT_DECK), AT_DECK) == doctest::Approx(118.0f));
}

TEST_CASE("deck height is resolved from the number the content already publishes") {
	// customparams.deck_top is the shipped source (features/bridges.lua). The
	// engine reads it rather than carrying a second copy that could drift.
	// PRESENCE of the key is the declaration; the value is only the offset —
	// the same contract tools/mapgen's ms_defs.feature_deck_top keeps, where
	// an undeclared def RAISES rather than answering 0.
	CHECK(ResolveDeck(false, 0.0f, params({{"deck_top", "0"}})).height   == doctest::Approx(0.0f));
	CHECK(ResolveDeck(false, 0.0f, params({{"deck_top", "1.5"}})).height == doctest::Approx(1.5f));
	CHECK(ResolveDeck(false, 0.0f, params({{"deck_top", "3.8"}})).height == doctest::Approx(3.8f));
	CHECK(ResolveDeck(false, 0.0f, params({{"deck_top", "56"}})).height  == doctest::Approx(56.0f));

	// An explicit featuredef key wins over the customparam — and it wins on
	// PRESENCE too, so an engine-side override may name 0 without being
	// mistaken for silence.
	CHECK(ResolveDeck(true, 2.25f, params({{"deck_top", "1.5"}})).height == doctest::Approx(2.25f));
	CHECK(ResolveDeck(true, 2.25f, params({})).height == doctest::Approx(2.25f));
	CHECK(IsSeated(ResolveDeck(true, 0.0f, params({{"deck_top", "1.5"}}))));
	CHECK(ResolveDeck(true, 0.0f, params({{"deck_top", "1.5"}})).height == doctest::Approx(0.0f));

	// A def that says nothing declares no deck, and is therefore unaffected.
	CHECK(!IsSeated(ResolveDeck(false, 0.0f, params({}))));
	CHECK(ResolveDeck(false, 0.0f, params({})).height == 0.0f);
	CHECK(!IsSeated(ResolveDeck(false, 0.0f, params({{"chain_pitch", "24"}}))));
	CHECK(!IsSeated(ResolveDeck(false, 0.0f, params({{"ms_feature_kind", "wreck"}}))));
}

TEST_CASE("a deck height that means nothing reads as no deck, not as an error") {
	// A def is content. Refusing to load a map over a typo'd customparam would
	// be a worse failure than the span sitting where it always did.
	CHECK(!IsSeated(ResolveDeck(false, 0.0f, params({{"deck_top", ""}}))));
	CHECK(!IsSeated(ResolveDeck(false, 0.0f, params({{"deck_top", "yes"}}))));
	CHECK(!IsSeated(ResolveDeck(false, 0.0f, params({{"deck_top", "1.5m"}}))));
	CHECK(!IsSeated(ResolveDeck(false, 0.0f, params({{"deck_top", "1.5 "}}))));

	// A NEGATIVE offset is not nonsense and is no longer swallowed: it names a
	// model authored from its parapet down, and the sign of the offset carries
	// no meaning at all now that declaration is its own field. (The old
	// resolver clamped this to 0 and unseated it, for the same reason it
	// unseated the shipped spans.)
	const DeckSpec below = ResolveDeck(false, 0.0f, params({{"deck_top", "-1.5"}}));
	CHECK(IsSeated(below));
	CHECK(below.height == doctest::Approx(-1.5f));
	CHECK(DeckLevel(120.0f, below) == doctest::Approx(118.5f));
	CHECK(StagingHeightForDeck(118.5f, below) == doctest::Approx(120.0f));
}

TEST_CASE("seating holds the SPAWN height — a map-placed span still cannot be level") {
	// Said out loud because the opposite is the natural reading, and because a
	// featureplacer objectlist entry carries only name/x/z/rot: LoadFeaturesFromMap
	// spawns at CGround::GetHeightReal, so a seated map-placed span holds the
	// seabed it was spawned on. It is level with NOTHING; it just stops moving.
	const float bed[4] = {-31.0f, -34.5f, -45.9f, -57.6f};

	for (const float g: bed)
		CHECK(SettleHeight(/*spawned at the ground*/ g, g, AT_DECK) == doctest::Approx(g));

	// Only an explicit staged y (the scenario path) lays a level deck.
	for (const float g: bed)
		CHECK(SettleHeight(0.0f, g, AT_DECK) == doctest::Approx(0.0f));
}

} // TEST_SUITE
