/* This file is part of the Spring engine (GPL v2 or later), see LICENSE.html */

#ifndef FEATURE_DEF_H
#define FEATURE_DEF_H

#include "Sim/Objects/SolidObjectDef.h"
#include "System/float3.h"
#include "Sim/Features/FeatureSeating.h"

enum {
	DRAWTYPE_MODEL = 0,
	DRAWTYPE_TREE  = 1, // >= different types of trees
	DRAWTYPE_NONE = -1,
};



struct FeatureDef: public SolidObjectDef
{
	FeatureDef();

	std::string description;
	/// feature that this turn into when killed (not reclaimed)
	int deathFeatureDefID;

	float reclaimTime;

	int drawType;

	/// -1 := only if it is the 1st wreckage of the unitdef (default), 0 := no it isn't, 1 := yes it is
	int resurrectable;

	int smokeTime;

	/// PLAN-maps.md §2j option C: whether this def declares a trafficable deck
	/// and, if so, how far that deck sits above its own model origin. A def
	/// that DECLARES one is SEATED — it holds the y it was staged at instead
	/// of being clamped up to the ground, so a chain of spans lays a level
	/// deck. The two facts are separate: a height of 0 is an ordinary deck
	/// (§2j option A put both shipped spans' origins ON their deck), NOT the
	/// way "no deck" is spelled. Resolved from the `deckHeight` featuredef key
	/// or, failing that, from the already-published `customparams.deck_top`.
	/// See Sim/Features/FeatureSeating.h.
	FeatureSeating::DeckSpec deck;

	bool destructable;
	bool autoreclaim;
	bool burnable;
	bool floating;
	bool geoThermal;
};

#endif
