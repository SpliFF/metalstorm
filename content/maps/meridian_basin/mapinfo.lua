--------------------------------------------------------------------------------
--------------------------------------------------------------------------------
-- mapinfo.lua — Meridian Basin
-- Generated from meridian_layout.json (PLAN-metalstorm-beta-map.md task 3a)
local mapinfo = {
	name = "Meridian Basin",
	description = "Purpose-built beta map for Metalstorm — 24 named regions, 4 civilian districts, 3 land crossings, 2 naval pockets. Ridge corridors, ford chokepoints, slope-banded terrain.",
	author = "Meridian Generator",
	version = "v1",
	mapfile = "maps/meridian_basin.smf",
	modtype = 3, --// 1 = primary, 0 = hidden, 3 = map
	notDeformable = false, -- Metalstorm supports deformable terrain
	tidalStrength = 0,
	gravity = 150, -- Standard Spring gravity
	maxMetal = 0, -- Metalstorm uses authority, not metal
	extractorRadius = 0,
	autoShowMetal = false,
	smf = {
		minheight = -80, -- Deep channel/lake bottoms
		maxheight = 1400, -- Ridge crests
		smtFileName0 = "maps/meridian_basin.smt",
	},
	resources = {
		detailTex = "detailtexbright.bmp",
	},
	atmosphere = {
		minWind = 5,
		maxWind = 22,
		fogStart = -0.3,
		fogEnd = 2.0,
		fogColor = {0.24, 0.26, 0.30},
		-- Near-neutral lighting: the terrain tiles are flat swatches from the
		-- shared palette atlas (art/STYLE.md — "colour comes from the palette,
		-- not from lighting"), so a tinted sun/ambient repaints the whole map.
		-- The original values here were copy-pasted from green_flat_x34_v3
		-- (orange sun + lime ambient) and turned the concrete/steel palette
		-- olive — see the 2026-07-26 map-rendering fix.
		sunColor = {1.0, 0.97, 0.92},
		skyColor = {0.65, 0.70, 0.78},
		skyDir = {1.0, 0.8, 1.0},
		cloudDensity = 0.1,
		cloudColor = {1.0, 1.0, 1.0},
	},
	lighting = {
		sunStartAngle = 0.0,
		sunOrbitTime = 1440.0,
		sunDir = {1, 0.7, 1},
		groundAmbientColor = {0.45, 0.46, 0.48},
		groundDiffuseColor = {0.9, 0.9, 0.9},
		groundSpecularColor = {0.5, 0.5, 0.5},
		groundShadowDensity = 0.8,
		unitAmbientColor = {0.4, 0.4, 0.4},
		unitDiffuseColor = {1.0, 1.0, 1.0},
		unitSpecularColor = {0.3, 0.3, 0.3},
		unitShadowDensity = 0.8,
		specularExponent = 100.0,
	},
	water = {
		-- Water present: west_narrows channel, ford crossings, still_mere lake
		-- Depth ranges: ford (<=12), shallow (12-20), deep (20-30), channel (>30)
		-- See meridian_layout.json water_bands for moveclass thresholds
		damage = 0,
		absorb = {0.0, 0.0, 0.0},
		baseColor = {0.0, 0.2, 0.3},
		minColor = {0.0, 0.1, 0.15},
		surfaceColor = {0.5, 0.7, 0.8},
		planeColor = {0.0, 0.2, 0.3},
	},
	-- Start positions from meridian_layout.json (8 total: 2 sides × 4 players/side)
	-- North side: team IDs 0-3, South side: team IDs 4-7
	-- Coordinates from start_positions.north + start_positions.south
	teams = {
		-- North side (z=1200)
		[0] = {startPos = {x = 2400, z = 1200}},
		[1] = {startPos = {x = 6600, z = 1200}},
		[2] = {startPos = {x = 9400, z = 1200}},
		[3] = {startPos = {x = 13400, z = 1200}},
		-- South side (z=15184)
		[4] = {startPos = {x = 2400, z = 15184}},
		[5] = {startPos = {x = 6600, z = 15184}},
		[6] = {startPos = {x = 9400, z = 15184}},
		[7] = {startPos = {x = 13400, z = 15184}},
	},
	terrainTypes = {
		[0] = {
			name = "Default",
			hardness = 1,
			receiveTracks = true,
			moveSpeeds = {
				tank  = 1,
				kbot  = 1,
				hover = 1,
				ship  = 1,
			},
		},
	}
}

--------------------------------------------------------------------------------
--------------------------------------------------------------------------------
-- Helper
local function lowerkeys(ta)
	local fix = {}

	for i, v in pairs(ta) do
		if (type(i) == "string") then
			if (i ~= i:lower()) then
				fix[#fix + 1] = i
			end
		end

		if (type(v) == "table") then
			lowerkeys(v)
		end
	end

	for i = 1, #fix do
		local idx = fix[i]
		ta[idx:lower()] = ta[idx]
		ta[idx] = nil
	end
end

lowerkeys(mapinfo)

--------------------------------------------------------------------------------
--------------------------------------------------------------------------------
-- Map Options
if (Spring) then
	local function tmerge(t1, t2)
		for i, v in pairs(t2) do
			if (type(v) == "table") then
				t1[i] = t1[i] or {}
				tmerge(t1[i], v)
			else
				t1[i] = v
			end
		end
	end

	-- make code safe in unitsync
	if (not Spring.GetMapOptions) then
		Spring.GetMapOptions = function() return {} end
	end

	function tobool(val)
		local t = type(val)

		if (t == 'nil') then
			return false
		elseif (t == 'boolean') then
			return val
		elseif (t == 'number') then
			return (val ~= 0)
		elseif (t == 'string') then
			return ((val ~= '0') and (val ~= 'false'))
		end

		return false
	end

	getfenv()["mapinfo"] = mapinfo
	local files = VFS.DirList("mapconfig/mapinfo/", "*.lua")
	table.sort(files)

	for i = 1, #files do
		local newcfg = VFS.Include(files[i])

		if newcfg then
			lowerkeys(newcfg)
			tmerge(mapinfo, newcfg)
		end
	end

	getfenv()["mapinfo"] = nil
end

--------------------------------------------------------------------------------
--------------------------------------------------------------------------------
return mapinfo
--------------------------------------------------------------------------------
--------------------------------------------------------------------------------
