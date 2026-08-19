-- Shared vegetation & prop feature defs for terragen-generated maps.
-- Canonical copy: tools/mapgen/vegetation_defs.lua — generator scripts
-- (archipelago.py, …) install it as features/vegetation.lua in the map
-- package. content/maps/meridian_basin/features/vegetation.lua is the same
-- def set (in-tree because Meridian predates this shared copy).
--
-- Def names MUST match gen_vegetation_models.py SPECIES and the names the
-- placement layers emit (vegetation.TEMPERATE_SPECIES + placement.py).
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

	-- deadwood & roadside props (cosmetic scale: drivable, low damage)

	fallen_log = {
		name         = "Fallen log",
		description  = "Windthrown trunk",
		object       = "fallen_log.gltf",
		footprintX   = 4,
		footprintZ   = 1,
		height       = 7,
		radius       = 14,
		blocking     = false,
		reclaimable  = true,
		metal        = 0,
		energy       = 120,
		damage       = 250,
		flammable    = 1,
		category     = "vegetation",
	},

	tree_stump = {
		name         = "Stump",
		description  = "Old stump",
		object       = "tree_stump.gltf",
		footprintX   = 1,
		footprintZ   = 1,
		height       = 12,
		radius       = 6,
		blocking     = false,
		reclaimable  = true,
		metal        = 0,
		energy       = 60,
		damage       = 180,
		flammable    = 1,
		category     = "vegetation",
	},

	log_fence = {
		name         = "Fence",
		description  = "Broken split-rail fence",
		object       = "log_fence.gltf",
		footprintX   = 2,
		footprintZ   = 1,
		height       = 7,
		radius       = 9,
		blocking     = false,
		reclaimable  = true,
		metal        = 0,
		energy       = 50,
		damage       = 150,
		flammable    = 1,
		category     = "prop",
	},

	-- ruins (blocking stonework)

	standing_stone = {
		name         = "Standing stone",
		description  = "Weathered monolith",
		object       = "standing_stone.gltf",
		footprintX   = 2,
		footprintZ   = 2,
		height       = 33,
		radius       = 9,
		blocking     = true,
		reclaimable  = true,
		metal        = 20,
		energy       = 0,
		damage       = 3000,
		flammable    = 0,
		category     = "ruin",
	},

	ruin_pillar = {
		name         = "Broken pillar",
		description  = "Ruined colonnade pillar",
		object       = "ruin_pillar.gltf",
		footprintX   = 2,
		footprintZ   = 2,
		height       = 24,
		radius       = 8,
		blocking     = true,
		reclaimable  = true,
		metal        = 25,
		energy       = 0,
		damage       = 2500,
		flammable    = 0,
		category     = "ruin",
	},

	ruin_wall = {
		name         = "Ruined wall",
		description  = "Collapsed wall fragment",
		object       = "ruin_wall.gltf",
		footprintX   = 4,
		footprintZ   = 1,
		height       = 13,
		radius       = 15,
		blocking     = true,
		reclaimable  = true,
		metal        = 40,
		energy       = 0,
		damage       = 4000,
		flammable    = 0,
		category     = "ruin",
	},

	-- climate-scoped props (PLAN-maps M8o). A map package only carries the
	-- blocks its climate's palette names — terragen.package.filter_defs_lua
	-- drops the rest — so a temperate map's features/vegetation.lua is
	-- byte-identical to what shipped before these existed.

	dead_snag = {
		name         = "Dead snag",
		description  = "Standing deadwood",
		object       = "dead_snag.gltf",
		footprintX   = 2,
		footprintZ   = 2,
		height       = 72,
		radius       = 12,
		blocking     = true,
		reclaimable  = true,
		metal        = 0,
		energy       = 120,
		damage       = 260,
		flammable    = 1,
		category     = "vegetation",
	},

	cactus_column = {
		name         = "Saguaro",
		description  = "Columnar cactus",
		object       = "cactus_column.gltf",
		footprintX   = 2,
		footprintZ   = 2,
		height       = 54,
		radius       = 14,
		blocking     = true,
		reclaimable  = true,
		metal        = 0,
		energy       = 90,
		damage       = 200,
		flammable    = 1,
		category     = "vegetation",
	},

	desert_shrub = {
		name         = "Dry shrub",
		description  = "Desert scrub",
		object       = "desert_shrub.gltf",
		footprintX   = 2,
		footprintZ   = 2,
		height       = 16,
		radius       = 10,
		blocking     = false,
		reclaimable  = true,
		metal        = 0,
		energy       = 30,
		damage       = 90,
		flammable    = 1,
		category     = "vegetation",
	},

	palm = {
		name         = "Palm",
		description  = "Coastal palm",
		object       = "palm.gltf",
		footprintX   = 3,
		footprintZ   = 3,
		height       = 86,
		radius       = 18,
		blocking     = true,
		reclaimable  = true,
		metal        = 0,
		energy       = 220,
		damage       = 420,
		flammable    = 1,
		category     = "vegetation",
	},

})
