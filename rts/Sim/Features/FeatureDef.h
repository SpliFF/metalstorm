/* This file is part of the Spring engine (GPL v2 or later), see LICENSE.html */

#ifndef FEATURE_DEF_H
#define FEATURE_DEF_H

#include "Sim/Objects/SolidObjectDef.h"
#include "System/float3.h"

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

	/// PLAN-maps.md §2j option C: height of the trafficable deck above this
	/// def's own model origin, or 0 for "no deck declared" (every def that is
	/// not a bridge span). A positive value SEATS the feature: it holds the y
	/// it was staged at instead of being clamped up to the ground, so a chain
	/// of spans lays a level deck. Resolved from the `deckHeight` featuredef
	/// key or, failing that, from the already-published
	/// `customparams.deck_top`. See Sim/Features/FeatureSeating.h.
	float deckHeight;

	bool destructable;
	bool autoreclaim;
	bool burnable;
	bool floating;
	bool geoThermal;
};

#endif
