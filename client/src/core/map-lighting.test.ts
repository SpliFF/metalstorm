import { describe, it, expect, vi, afterEach } from 'vitest';
import { loadMapLighting, normaliseSunDir } from './map-lighting.js';

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
