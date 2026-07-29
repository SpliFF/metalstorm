-- Meridian Basin vegetation & rock props (PLAN-maps.md M6).
--
-- The four def names MUST match tools/mapgen/terragen/vegetation.py's
-- TEMPERATE_SPECIES — that scatter emits the featureplacer `objectlist`
-- entries that reference these by name.
--
-- Models are native glTF (authored by tools/mapgen/gen_vegetation_models.py,
-- authored in elmos) and are installed into the processed map verbatim by
-- FeatureProcessor; they carry their own KTX2 image URIs, so no `texture`
-- field is needed here.
--
-- footprint is in heightmap squares (1 square = 8 elmos): trees block
-- movement, scrub does not (you can drive through a bush), boulders do.
-- `radius` is the collision sphere the sim uses — kept close to the trunk /
-- rock body rather than the canopy, so a forest is passable at the gaps
-- rather than being a solid wall the pathfinder refuses.

return lowerkeys({

	tree_conifer = {
		name         = "Conifer",
		description  = "Ridge conifer",
		object       = "tree_conifer.gltf",
		footprintX   = 3,
		footprintZ   = 3,
		height       = 105,
		radius       = 20,
		blocking     = true,
		reclaimable  = true,
		metal        = 0,
		energy       = 250,
		damage       = 500,
		flammable    = 1,
		category     = "vegetation",
	},

	tree_broadleaf = {
		name         = "Broadleaf",
		description  = "Valley broadleaf",
		object       = "tree_broadleaf.gltf",
		footprintX   = 4,
		footprintZ   = 4,
		height       = 93,
		radius       = 24,
		blocking     = true,
		reclaimable  = true,
		metal        = 0,
		energy       = 300,
		damage       = 600,
		flammable    = 1,
		category     = "vegetation",
	},

	bush_scrub = {
		name         = "Scrub",
		description  = "Low scrub",
		object       = "bush_scrub.gltf",
		footprintX   = 2,
		footprintZ   = 2,
		height       = 21,
		radius       = 12,
		blocking     = false,
		reclaimable  = true,
		metal        = 0,
		energy       = 40,
		damage       = 120,
		flammable    = 1,
		category     = "vegetation",
	},

	rock_boulder = {
		name         = "Boulder",
		description  = "Weathered boulder",
		object       = "rock_boulder.gltf",
		footprintX   = 3,
		footprintZ   = 3,
		height       = 24,
		radius       = 20,
		blocking     = true,
		reclaimable  = true,
		metal        = 15,
		energy       = 0,
		damage       = 1600,
		flammable    = 0,
		category     = "rock",
	},

	rock_boulder_large = {
		name         = "Outcrop",
		description  = "Rock outcrop",
		object       = "rock_boulder_large.gltf",
		footprintX   = 9,
		footprintZ   = 9,
		height       = 42,
		radius       = 38,
		blocking     = true,
		reclaimable  = true,
		metal        = 60,
		energy       = 0,
		damage       = 6000,
		flammable    = 0,
		category     = "rock",
	},

})
