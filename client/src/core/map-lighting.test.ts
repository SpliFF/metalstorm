import { describe, it, expect, vi, afterEach } from 'vitest';
import {
    loadMapLighting, normaliseSunDir, defaultMapLighting,
    mergeSunLighting, setSunDirectionLighting, readSunParam,
    loadMapAtmosphere, defaultMapAtmosphere, mergeAtmosphere,
    loadMapWaterAbsorption, defaultMapWaterAbsorption,
} from './map-lighting.js';

// A mapinfo.lua shaped like the real maps that broke: lighting is authored,
// and the file ends with an UNGUARDED map-options merge block using getfenv()
// + VFS (Lua-5.1 / engine globals fengari + this parser lack). The fix
// installs harmless getfenv/setfenv/VFS stubs so the chunk runs to
// `return mapinfo` instead of erroring out to dark defaults.
const MAPINFO_WITH_MERGE_BLOCK = `
local mapinfo = {
	name = "Test",
	lighting = {
		groundAmbientColor = { 0.7, 1, 0.9 },
		groundShadowDensity = 0.437,
		sunDir = { 1, 0.81, -0.75 },
		unitDiffuseColor = { 1, 0.98, 0.92 },
	},
	legacyCoordSystem = true,
}

local function lowerkeys(ta)
	local fix = {}
	for i,v in pairs(ta) do
		if (type(i) == "string") and (i ~= i:lower()) then fix[#fix+1] = i end
		if (type(v) == "table") then lowerkeys(v) end
	end
	for i=1,#fix do local idx = fix[i]; ta[idx:lower()] = ta[idx]; ta[idx] = nil end
end
lowerkeys(mapinfo)

do
	local function tmerge(t1, t2)
		for i,v in pairs(t2) do
			if (type(v) == "table") then t1[i] = t1[i] or {}; tmerge(t1[i], v)
			else t1[i] = v end
		end
	end
	getfenv()["mapinfo"] = mapinfo
		local files = VFS.DirList("mapconfig/mapinfo/", "*.lua")
		table.sort(files)
		for i=1,#files do
			local newcfg = VFS.Include(files[i])
			if newcfg then lowerkeys(newcfg); tmerge(mapinfo, newcfg) end
		end
	getfenv()["mapinfo"] = nil
end

return mapinfo
`;

function stubFetch(body: string, ok = true, status = 200) {
    vi.stubGlobal('fetch', vi.fn(async () => ({
        ok, status,
        text: async () => body,
    })));
}

afterEach(() => { vi.unstubAllGlobals(); });

describe('loadMapLighting', () => {
    it('extracts authored lighting past an unguarded getfenv/VFS merge block', async () => {
        stubFetch(MAPINFO_WITH_MERGE_BLOCK);
        const m = await loadMapLighting('/api/maps/data/test');
        // Authored values, not DEFAULTS (groundAmbient default is [0.5,0.5,0.5]).
        expect(m.groundAmbient).toEqual([0.7, 1, 0.9]);
        expect(m.groundShadowDensity).toBeCloseTo(0.437, 5);
        expect(m.sunDir).toEqual([1, 0.81, -0.75]);
        expect(m.unitDiffuse[0]).toBeCloseTo(1, 5);
        expect(m.legacyCoordSystem).toBe(true);
    });

    it('falls back to defaults on HTTP error', async () => {
        stubFetch('', false, 500);
        const m = await loadMapLighting('/api/maps/data/missing');
        expect(m.groundAmbient).toEqual([0.5, 0.5, 0.5]); // DEFAULTS
    });

    it('falls back to defaults on a genuinely broken chunk', async () => {
        stubFetch('this is not lua = = =');
        const m = await loadMapLighting('/api/maps/data/broken');
        expect(m.groundAmbient).toEqual([0.5, 0.5, 0.5]); // DEFAULTS
    });

    it('still parses a Spring-guarded merge block (Spring stays uninstalled)', async () => {
        stubFetch(`
local mapinfo = { lighting = { groundAmbientColor = { 0.2, 0.3, 0.4 } } }
if Spring then
	mapinfo.lighting.groundAmbientColor = { 9, 9, 9 } -- never runs
end
return mapinfo
`);
        const m = await loadMapLighting('/api/maps/data/guarded');
        expect(m.groundAmbient).toEqual([0.2, 0.3, 0.4]);
    });
});

describe('normaliseSunDir', () => {
    it('normalises to unit length', () => {
        const [x, y, z] = normaliseSunDir([1, 0.81, -0.75]);
        expect(Math.hypot(x, y, z)).toBeCloseTo(1, 5);
    });
    it('falls back to up for a degenerate vector', () => {
        expect(normaliseSunDir([0, 0, 0])).toEqual([0, 1, 0]);
    });
});

describe('mergeSunLighting (Spring.SetSunLighting)', () => {
    it('maps Recoil colour keys onto the MapLighting fields', () => {
        const base = defaultMapLighting();
        const { lighting, unknown } = mergeSunLighting(base, {
            groundAmbientColor: [0.1, 0.2, 0.3],
            unitDiffuseColor: [1, 0.9, 0.8],
            unitSpecularColor: { r: 0.5, g: 0.4, b: 0.3 },
        });
        expect(lighting.groundAmbient).toEqual([0.1, 0.2, 0.3]);
        expect(lighting.unitDiffuse).toEqual([1, 0.9, 0.8]);
        expect(lighting.unitSpecular).toEqual([0.5, 0.4, 0.3]);
        expect(unknown).toEqual([]);
    });

    it('accepts the model* aliases for the unit* fields', () => {
        const base = defaultMapLighting();
        const { lighting } = mergeSunLighting(base, {
            modelAmbientColor: [0.2, 0.2, 0.2],
            modelDiffuseColor: [0.7, 0.7, 0.7],
        });
        expect(lighting.unitAmbient).toEqual([0.2, 0.2, 0.2]);
        expect(lighting.unitDiffuse).toEqual([0.7, 0.7, 0.7]);
    });

    it('maps the scalar shadow/specular keys (model→unit)', () => {
        const base = defaultMapLighting();
        const { lighting } = mergeSunLighting(base, {
            specularExponent: 42,
            groundShadowDensity: 0.6,
            modelShadowDensity: 0.5,
        });
        expect(lighting.specularExponent).toBe(42);
        expect(lighting.groundShadowDensity).toBe(0.6);
        expect(lighting.unitShadowDensity).toBe(0.5);
    });

    it('is case-insensitive and collects unknown keys', () => {
        const base = defaultMapLighting();
        const { lighting, unknown } = mergeSunLighting(base, {
            grounddiffusecolor: [0.4, 0.4, 0.4],
            bogusKey: 1,
        });
        expect(lighting.groundDiffuse).toEqual([0.4, 0.4, 0.4]);
        expect(unknown).toEqual(['bogusKey']);
    });

    it('does not mutate the base lighting', () => {
        const base = defaultMapLighting();
        const before = [...base.groundAmbient];
        mergeSunLighting(base, { groundAmbientColor: [9, 9, 9] });
        expect(base.groundAmbient).toEqual(before);
    });

    it('tolerates a null/empty params table', () => {
        const base = defaultMapLighting();
        const { lighting, unknown } = mergeSunLighting(base, null);
        expect(lighting.groundAmbient).toEqual(base.groundAmbient);
        expect(unknown).toEqual([]);
    });
});

const MAPINFO_WITH_ATMOSPHERE = `
local mapinfo = {
	name = "Test",
	atmosphere = {
		fogStart = 0.42,
		fogEnd = 1.8,
		fogColor = { 0.6, 0.65, 0.7 },
		skyColor = { 0.2, 0.25, 0.6 },
		sunColor = { 0.9, 0.8, 0.7 },
		cloudColor = { 0.5, 0.5, 0.55 },
		skyAxisAngle = { 0, 1, 0, 1.57 },
	},
}
return mapinfo
`;

describe('loadMapAtmosphere (gl.GetAtmosphere data source)', () => {
    it('extracts the authored atmosphere table', async () => {
        stubFetch(MAPINFO_WITH_ATMOSPHERE);
        const a = await loadMapAtmosphere('/api/maps/data/test');
        expect(a.fogStart).toBeCloseTo(0.42, 5);
        expect(a.fogEnd).toBeCloseTo(1.8, 5);
        // float3 authored where a float4 is read → 4th (alpha) keeps the default 1.
        expect(a.fogColor).toEqual([0.6, 0.65, 0.7, 1.0]);
        expect(a.skyColor).toEqual([0.2, 0.25, 0.6]);
        expect(a.sunColor).toEqual([0.9, 0.8, 0.7]);
        expect(a.cloudColor).toEqual([0.5, 0.5, 0.55]);
        expect(a.skyAxisAngle).toEqual([0, 1, 0, 1.57]);
    });

    it('falls back to Recoil defaults for an omitted atmosphere table', async () => {
        stubFetch(`return { name = "NoAtmo" }`);
        const a = await loadMapAtmosphere('/api/maps/data/noatmo');
        expect(a).toEqual(defaultMapAtmosphere());
        // Spot-check the Recoil MapInfo.cpp defaults.
        expect(a.fogStart).toBe(0.1);
        expect(a.fogEnd).toBe(1.0);
        expect(a.skyColor).toEqual([0.1, 0.15, 0.7]);
    });

    it('falls back to defaults on HTTP error and on a broken chunk', async () => {
        stubFetch('', false, 404);
        expect(await loadMapAtmosphere('/api/maps/data/missing')).toEqual(defaultMapAtmosphere());
        stubFetch('not lua = = =');
        expect(await loadMapAtmosphere('/api/maps/data/broken')).toEqual(defaultMapAtmosphere());
    });
});

// The pools_of_ilys shape that produced G1a: a pink absorption base authored
// for geothermal pools, with the standard lowerkeys() pass so keys land
// lowercase (`basecolor`, `mincolor`) — the reader must be case-insensitive.
const MAPINFO_WITH_WATER = `
local mapinfo = {
	name = "Test",
	water = {
		absorb    = { 0.011, 0.011, 0.015 },
		baseColor = { 0.90, 0.38, 0.48 },
		minColor  = { 0.0015, 0.0015, 0.0015 },
		surfaceColor = { 0.90, 0.80, 0.65 },
		surfaceAlpha = 0.2,
	},
}
local function lowerkeys(ta)
	local fix = {}
	for i,v in pairs(ta) do
		if (type(i) == "string") and (i ~= i:lower()) then fix[#fix+1] = i end
		if (type(v) == "table") then lowerkeys(v) end
	end
	for i=1,#fix do local idx = fix[i]; ta[idx:lower()] = ta[idx]; ta[idx] = nil end
end
lowerkeys(mapinfo)
return mapinfo
`;

describe('loadMapWaterAbsorption (SMF_WATER_ABSORPTION data source)', () => {
    it('extracts the authored absorption colours past a lowerkeys pass', async () => {
        stubFetch(MAPINFO_WITH_WATER);
        const w = await loadMapWaterAbsorption('/api/maps/data/pools');
        expect(w.absorb).toEqual([0.011, 0.011, 0.015]);
        expect(w.baseColor).toEqual([0.9, 0.38, 0.48]);
        expect(w.minColor).toEqual([0.0015, 0.0015, 0.0015]);
    });

    it('falls back to Recoil defaults (all-zero) for an omitted water table', async () => {
        stubFetch(`return { name = "NoWater" }`);
        const w = await loadMapWaterAbsorption('/api/maps/data/nowater');
        expect(w).toEqual(defaultMapWaterAbsorption());
        expect(w.absorb).toEqual([0, 0, 0]);
        expect(w.baseColor).toEqual([0, 0, 0]);
        expect(w.minColor).toEqual([0, 0, 0]);
    });

    it('falls back to defaults on HTTP error and on a broken chunk', async () => {
        stubFetch('', false, 404);
        expect(await loadMapWaterAbsorption('/api/maps/data/missing'))
            .toEqual(defaultMapWaterAbsorption());
        stubFetch('not lua = = =');
        expect(await loadMapWaterAbsorption('/api/maps/data/broken'))
            .toEqual(defaultMapWaterAbsorption());
    });
});

describe('mergeAtmosphere (Spring.SetAtmosphere)', () => {
    it('sets fogStart/fogEnd from numbers and colours from arrays', () => {
        const { atmosphere, unknown } = mergeAtmosphere(defaultMapAtmosphere(), {
            fogStart: 0.25,
            fogEnd: 1.5,
            fogColor: [0.1, 0.2, 0.3, 0.4],
            skyColor: [0.4, 0.5, 0.6],
        });
        expect(atmosphere.fogStart).toBe(0.25);
        expect(atmosphere.fogEnd).toBe(1.5);
        expect(atmosphere.fogColor).toEqual([0.1, 0.2, 0.3, 0.4]);
        expect(atmosphere.skyColor).toEqual([0.4, 0.5, 0.6]);
        expect(unknown).toEqual([]);
    });

    it('ignores a non-number fogStart and collects unknown keys', () => {
        const base = defaultMapAtmosphere();
        const { atmosphere, unknown } = mergeAtmosphere(base, {
            fogStart: 'oops',
            bogus: 1,
        });
        expect(atmosphere.fogStart).toBe(base.fogStart); // unchanged
        expect(unknown).toEqual(['bogus']);
    });

    it('does not mutate the base atmosphere', () => {
        const base = defaultMapAtmosphere();
        const before = [...base.fogColor];
        mergeAtmosphere(base, { fogColor: [9, 9, 9, 9] });
        expect(base.fogColor).toEqual(before);
    });

    it('tolerates a null params table', () => {
        const base = defaultMapAtmosphere();
        const { atmosphere, unknown } = mergeAtmosphere(base, null);
        expect(atmosphere).toEqual(base);
        expect(unknown).toEqual([]);
    });
});

describe('setSunDirectionLighting (Spring.SetSunDirection)', () => {
    it('normalises the direction and preserves legacyCoordSystem', () => {
        const base = defaultMapLighting();
        const out = setSunDirectionLighting(base, 1, 0.81, -0.75);
        expect(Math.hypot(...out.sunDir)).toBeCloseTo(1, 5);
        expect(out.legacyCoordSystem).toBe(base.legacyCoordSystem);
    });
    it('keeps the authored shadow density (ignores the broken intensity arg)', () => {
        const base = defaultMapLighting();
        base.groundShadowDensity = 0.33;
        const out = setSunDirectionLighting(base, 0, 1, 0);
        expect(out.groundShadowDensity).toBe(0.33);
    });
});

describe('readSunParam (gl.GetSun)', () => {
    // The lighting a widget must round-trip: pools_of_ilys-style authored
    // values, distinct per field so a ground/unit mixup fails the test.
    function litBase() {
        const l = defaultMapLighting();
        l.sunDir = [0, 1, 0];
        l.groundAmbient = [0.7, 1.0, 0.9];
        l.groundDiffuse = [0.8, 0.7, 0.6];
        l.groundSpecular = [0.1, 0.2, 0.3];
        l.groundShadowDensity = 0.437;
        l.unitAmbient = [0.35, 0.36, 0.37];
        l.unitDiffuse = [1.0, 0.98, 0.92];
        l.unitSpecular = [0.5, 0.5, 0.55];
        l.unitShadowDensity = 0.62;
        l.specularExponent = 30;
        return l;
    }

    it('returns the light direction for no-arg, "pos" and "dir"', () => {
        const l = litBase();
        expect(readSunParam(l)).toEqual([0, 1, 0]);
        expect(readSunParam(l, 'pos')).toEqual([0, 1, 0]);
        expect(readSunParam(l, 'dir')).toEqual([0, 1, 0]);
    });

    it('normalises a non-unit stored direction (Recoil GetLightDir is unit)', () => {
        const l = litBase();
        l.sunDir = [0, 2, 0];
        expect(readSunParam(l, 'pos')).toEqual([0, 1, 0]);
    });

    it('selects ground values by default and unit values for a "u…" mode', () => {
        const l = litBase();
        expect(readSunParam(l, 'ambient')).toEqual([0.7, 1.0, 0.9]);
        expect(readSunParam(l, 'ambient', 'unit')).toEqual([0.35, 0.36, 0.37]);
        expect(readSunParam(l, 'diffuse')).toEqual([0.8, 0.7, 0.6]);
        expect(readSunParam(l, 'diffuse', 'unit')).toEqual([1.0, 0.98, 0.92]);
        expect(readSunParam(l, 'specular', 'ground')).toEqual([0.1, 0.2, 0.3]);
        expect(readSunParam(l, 'specular', 'unit')).toEqual([0.5, 0.5, 0.55]);
        expect(readSunParam(l, 'shadowDensity')).toBe(0.437);
        expect(readSunParam(l, 'shadowDensity', 'unit')).toBe(0.62);
        expect(readSunParam(l, 'specularExponent')).toBe(30);
    });

    it('returns nothing for an unknown param (Recoil pushes 0 values)', () => {
        expect(readSunParam(litBase(), 'nonsense')).toBeUndefined();
    });

    it('returns copies — mutating the result cannot corrupt the live store', () => {
        const l = litBase();
        const amb = readSunParam(l, 'ambient') as number[];
        amb[0] = 99;
        expect(l.groundAmbient[0]).toBe(0.7);
    });

    it('round-trips a SetSunLighting write (the ZK FullSunUpdate cycle)', () => {
        // gfx_sun_and_atmosphere reads every sun value via gl.GetSun and
        // writes the lot back through Spring.SetSunLighting. With a live
        // reader that must be the identity — G1c's churn was this cycle
        // reading stale stub constants instead.
        const l = litBase();
        const { lighting: after } = mergeSunLighting(l, {
            groundAmbientColor: readSunParam(l, 'ambient') as number[],
            unitDiffuseColor: readSunParam(l, 'diffuse', 'unit') as number[],
            groundShadowDensity: readSunParam(l, 'shadowDensity') as number,
            modelShadowDensity: readSunParam(l, 'shadowDensity', 'unit') as number,
        });
        expect(after).toEqual(l);
    });
});
