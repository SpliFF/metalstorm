/**
 * map-lighting — fetch a map's `mapinfo.lua`, execute it through Fengari
 * on the main thread, and extract the `lighting` table as a plain JS
 * object. The server has no involvement in lighting — it's pure renderer
 * data authored by the mapmaker.
 *
 * mapinfo.lua is a Lua chunk that returns a `mapinfo` table. Most maps
 * call `lowerkeys(mapinfo)` before returning, so the lighting keys land
 * lowercase (`sundir`, `groundambientcolor`, etc.). We tolerate both
 * lowercase and the original `camelCase` form when reading the table.
 *
 * The `if (Spring)` merge block that all maps wrap their map-options
 * code in is skipped because we deliberately don't install a `Spring`
 * global. Maps that pull lighting overrides from `mapconfig/mapinfo/`
 * lose those overrides — acceptable for now, the override path is rare.
 */
import { LuaRuntime, type LuaValue } from './lua-runtime.js';

export interface MapLighting {
    /** Unit-length direction FROM the world TO the sun (Recoil convention). */
    sunDir: [number, number, number];
    groundAmbient: [number, number, number];
    groundDiffuse: [number, number, number];
    groundSpecular: [number, number, number];
    groundShadowDensity: number;
    unitAmbient: [number, number, number];
    unitDiffuse: [number, number, number];
    unitSpecular: [number, number, number];
    unitShadowDensity: number;
    specularExponent: number;
    /** Mirror of `mapinfo.legacyCoordSystem` — true means Z must be flipped on import. */
    legacyCoordSystem: boolean;
}

const DEFAULTS: MapLighting = {
    sunDir: [0.5, 1.0, 0.3],
    groundAmbient: [0.5, 0.5, 0.5],
    groundDiffuse: [0.9, 0.9, 0.9],
    groundSpecular: [0.1, 0.1, 0.1],
    groundShadowDensity: 0.8,
    unitAmbient: [0.4, 0.4, 0.4],
    unitDiffuse: [1.0, 1.0, 1.0],
    unitSpecular: [0.3, 0.3, 0.3],
    unitShadowDensity: 0.8,
    specularExponent: 100.0,
    legacyCoordSystem: true,
};

/** A fresh copy of the fallback lighting (used as the base state for runtime
 * `Spring.SetSunLighting`/`SetSunDirection` before `mapinfo.lua` resolves). */
export function defaultMapLighting(): MapLighting {
    return cloneMapLighting(DEFAULTS);
}

/**
 * The map's `atmosphere` table, as read by `gl.GetAtmosphere` / written by
 * `Spring.SetAtmosphere`. Pure renderer data authored in `mapinfo.lua`'s
 * `atmosphere` sub-table — the server has no involvement (same client-only
 * model as the `lighting` table above; see feedback_lighting_client_only).
 *
 * Field shapes + defaults mirror Recoil `CMapInfo::ReadAtmosphere`
 * (rts/Map/MapInfo.cpp) and the `ISky` storage types the engine reads them
 * into: `fogColor` is a `float4` (alpha defaulted to 1), the named colours are
 * `float3`, and `skyAxisAngle` is a `float4` (axis xyz + angle w).
 */
export interface MapAtmosphere {
    fogStart: number;
    fogEnd: number;
    fogColor: [number, number, number, number];
    skyColor: [number, number, number];
    sunColor: [number, number, number];
    cloudColor: [number, number, number];
    skyAxisAngle: [number, number, number, number];
}

const ATMOSPHERE_DEFAULTS: MapAtmosphere = {
    fogStart: 0.1,
    fogEnd: 1.0,
    fogColor: [0.7, 0.7, 0.8, 1.0],
    skyColor: [0.1, 0.15, 0.7],
    sunColor: [1.0, 1.0, 1.0],
    cloudColor: [1.0, 1.0, 1.0],
    skyAxisAngle: [0.0, 0.0, 1.0, 0.0],
};

/** A fresh copy of the Recoil-default atmosphere (used as the base store in the
 * GL bridge before `mapinfo.lua` resolves, and as the fallback on parse fail). */
export function defaultMapAtmosphere(): MapAtmosphere {
    return cloneMapAtmosphere(ATMOSPHERE_DEFAULTS);
}

/** Case-insensitive table lookup — handles both `sunDir` and `sundir`. */
function tget(t: Record<string, LuaValue> | null, key: string): LuaValue {
    if (!t) return null;
    if (key in t) return t[key];
    const lower = key.toLowerCase();
    if (lower in t) return t[lower];
    for (const k of Object.keys(t)) {
        if (k.toLowerCase() === lower) return t[k];
    }
    return null;
}

function asVec3(v: LuaValue, fallback: [number, number, number]): [number, number, number] {
    // Lua sequences come through as JS arrays. Some maps author colours
    // as {r=, g=, b=} tables too — accept both shapes.
    if (Array.isArray(v) && v.length >= 3) {
        return [Number(v[0]) || 0, Number(v[1]) || 0, Number(v[2]) || 0];
    }
    if (v && typeof v === 'object') {
        const o = v as Record<string, LuaValue>;
        const r = tget(o, 'r');
        if (r !== null) {
            return [Number(r) || 0, Number(tget(o, 'g')) || 0, Number(tget(o, 'b')) || 0];
        }
    }
    return fallback;
}

function asVec4(
    v: LuaValue, fallback: [number, number, number, number],
): [number, number, number, number] {
    if (Array.isArray(v) && v.length >= 4) {
        return [Number(v[0]) || 0, Number(v[1]) || 0, Number(v[2]) || 0, Number(v[3]) || 0];
    }
    // A 3-vector authored where a float4 is expected (e.g. fogColor) keeps the
    // fallback's 4th component — matches Recoil's float3→float4 widening (alpha 1).
    if (Array.isArray(v) && v.length === 3) {
        return [Number(v[0]) || 0, Number(v[1]) || 0, Number(v[2]) || 0, fallback[3]];
    }
    return fallback;
}

function asNumber(v: LuaValue, fallback: number): number {
    if (typeof v === 'number') return v;
    if (typeof v === 'string') {
        const n = Number(v);
        if (Number.isFinite(n)) return n;
    }
    return fallback;
}

function asBool(v: LuaValue, fallback: boolean): boolean {
    if (typeof v === 'boolean') return v;
    if (typeof v === 'number') return v !== 0;
    return fallback;
}

/**
 * Run `mapinfo.lua` source through Fengari and return the `mapinfo` table.
 * Returns null if the chunk fails to parse or doesn't yield a table.
 */
function parseMapinfo(source: string, chunkName: string): Record<string, LuaValue> | null {
    const rt = new LuaRuntime(`mapinfo:${chunkName}`);
    try {
        // Most maps end with a map-options merge block that, in-engine, runs
        // against `getfenv()` (Lua 5.1) and a `VFS` global to pull lighting
        // overrides from `mapconfig/mapinfo/*.lua`. fengari is Lua 5.3 (no
        // getfenv/setfenv) and we install no VFS, so an *unguarded* block
        // (e.g. pools_of_ilys) hits a nil call and the whole chunk errors
        // before `return mapinfo` — the map then renders with dark default
        // lighting. Install harmless stubs so the block runs to completion:
        // VFS lists no config files, so the (rare) override path is skipped,
        // exactly as documented in this module's header. `getfenv` returns a
        // throwaway table — the block only uses it to expose `mapinfo` to the
        // VFS.Include'd configs we're not loading. (Maps that guard the block
        // with `if Spring then` are still skipped — we deliberately install no
        // `Spring` global.) DirList must return an empty Lua *table* (`{}`),
        // not a JS `[]`, since a function returning `[]` marshals to zero Lua
        // values → `nil` → `table.sort(files)` would error.
        rt.setGlobal('getfenv', () => ({}));
        rt.setGlobal('setfenv', () => undefined);
        rt.setGlobal('VFS', {
            DirList: () => ({}),
            Include: () => null,
        });
        // The chunk returns the mapinfo table via `return mapinfo`.
        // evalString captures one return value.
        const result = rt.evalString(source, chunkName);
        if (!result || typeof result !== 'object' || Array.isArray(result)) {
            return null;
        }
        return result as Record<string, LuaValue>;
    } finally {
        rt.dispose();
    }
}

/**
 * Fetch `mapinfo.lua` from a map's source directory and extract the
 * lighting fields. Returns DEFAULTS for any field the map omits.
 *
 * If the fetch or parse fails entirely, returns DEFAULTS — the renderer
 * still has usable values to apply.
 */
export async function loadMapLighting(mapSourceUrl: string): Promise<MapLighting> {
    const url = `${mapSourceUrl}/mapinfo.lua`;
    let source: string;
    try {
        const res = await fetch(url);
        if (!res.ok) {
            console.warn(`[map-lighting] ${url}: HTTP ${res.status}; using defaults`);
            return { ...DEFAULTS };
        }
        source = await res.text();
    } catch (e) {
        console.warn(`[map-lighting] fetch ${url}: ${e}; using defaults`);
        return { ...DEFAULTS };
    }

    const mapinfo = parseMapinfo(source, url);
    if (!mapinfo) {
        console.warn(`[map-lighting] ${url}: parse failed; using defaults`);
        return { ...DEFAULTS };
    }

    const lighting = tget(mapinfo, 'lighting');
    const lt = (lighting && typeof lighting === 'object' && !Array.isArray(lighting))
        ? lighting as Record<string, LuaValue>
        : null;

    return {
        sunDir:              asVec3(tget(lt, 'sunDir'),              DEFAULTS.sunDir),
        groundAmbient:       asVec3(tget(lt, 'groundAmbientColor'),  DEFAULTS.groundAmbient),
        groundDiffuse:       asVec3(tget(lt, 'groundDiffuseColor'),  DEFAULTS.groundDiffuse),
        groundSpecular:      asVec3(tget(lt, 'groundSpecularColor'), DEFAULTS.groundSpecular),
        groundShadowDensity: asNumber(tget(lt, 'groundShadowDensity'), DEFAULTS.groundShadowDensity),
        unitAmbient:         asVec3(tget(lt, 'unitAmbientColor'),    DEFAULTS.unitAmbient),
        unitDiffuse:         asVec3(tget(lt, 'unitDiffuseColor'),    DEFAULTS.unitDiffuse),
        unitSpecular:        asVec3(tget(lt, 'unitSpecularColor'),   DEFAULTS.unitSpecular),
        unitShadowDensity:   asNumber(tget(lt, 'unitShadowDensity'), DEFAULTS.unitShadowDensity),
        specularExponent:    asNumber(tget(lt, 'specularExponent'),  DEFAULTS.specularExponent),
        legacyCoordSystem:   asBool(tget(mapinfo, 'legacyCoordSystem'), DEFAULTS.legacyCoordSystem),
    };
}

/**
 * The map's underwater-terrain absorption colours, from `mapinfo.lua`'s
 * `water` sub-table. In Recoil these three drive the SMF ground shader's
 * `SMF_WATER_ABSORPTION` block (shading of TERRAIN below the Y=0 water
 * plane, graded by depth) — they are NOT the water surface colour, which
 * is `surfaceColor`/`surfaceAlpha` (BumpWater). Same client-only model as
 * `lighting`/`atmosphere` above (see feedback_lighting_client_only); the
 * server's metadata.json carries the surface fields but not `absorb`.
 *
 * Defaults mirror Recoil `CMapInfo::ReadWater` (rts/Map/MapInfo.cpp):
 * all-zero — on maps that author no absorption colours, deep water floors
 * legitimately shade to black, exactly as in Recoil.
 */
export interface MapWaterAbsorption {
    /** Absorption per elmo of depth, subtracted from `baseColor`. */
    absorb: [number, number, number];
    /** Shade at zero depth (the water "tint" on the terrain beneath). */
    baseColor: [number, number, number];
    /** Floor the depth-graded shade never darkens below. */
    minColor: [number, number, number];
}

const WATER_ABSORPTION_DEFAULTS: MapWaterAbsorption = {
    absorb: [0, 0, 0],
    baseColor: [0, 0, 0],
    minColor: [0, 0, 0],
};

/** A fresh copy of the Recoil-default water absorption. */
export function defaultMapWaterAbsorption(): MapWaterAbsorption {
    return {
        absorb: [...WATER_ABSORPTION_DEFAULTS.absorb],
        baseColor: [...WATER_ABSORPTION_DEFAULTS.baseColor],
        minColor: [...WATER_ABSORPTION_DEFAULTS.minColor],
    };
}

/** Extract the `water` absorption colours from a parsed `mapinfo` table,
 * filling any omitted field with the Recoil default. Pure — shared by
 * `loadMapWaterAbsorption`. */
export function extractWaterAbsorption(
    mapinfo: Record<string, LuaValue> | null,
): MapWaterAbsorption {
    const water = tget(mapinfo, 'water');
    const wt = (water && typeof water === 'object' && !Array.isArray(water))
        ? water as Record<string, LuaValue>
        : null;
    return {
        absorb:    asVec3(tget(wt, 'absorb'),    WATER_ABSORPTION_DEFAULTS.absorb),
        baseColor: asVec3(tget(wt, 'baseColor'), WATER_ABSORPTION_DEFAULTS.baseColor),
        minColor:  asVec3(tget(wt, 'minColor'),  WATER_ABSORPTION_DEFAULTS.minColor),
    };
}

/**
 * Fetch `mapinfo.lua` and extract the `water` absorption colours. Returns
 * Recoil defaults for omitted fields and on any fetch/parse failure.
 *
 * Note: this re-fetches the same `mapinfo.lua` that `loadMapLighting` reads;
 * the file is small and HTTP-cached, so the second request is served from
 * cache (same pattern as `loadMapAtmosphere`).
 */
export async function loadMapWaterAbsorption(
    mapSourceUrl: string,
): Promise<MapWaterAbsorption> {
    const url = `${mapSourceUrl}/mapinfo.lua`;
    let source: string;
    try {
        const res = await fetch(url);
        if (!res.ok) {
            console.warn(`[map-lighting] water ${url}: HTTP ${res.status}; using defaults`);
            return defaultMapWaterAbsorption();
        }
        source = await res.text();
    } catch (e) {
        console.warn(`[map-lighting] water fetch ${url}: ${e}; using defaults`);
        return defaultMapWaterAbsorption();
    }

    const mapinfo = parseMapinfo(source, url);
    if (!mapinfo) {
        console.warn(`[map-lighting] water ${url}: parse failed; using defaults`);
        return defaultMapWaterAbsorption();
    }
    return extractWaterAbsorption(mapinfo);
}

/**
 * Normalise a 3-vector. Recoil's `sunDir` is documented as unit-length
 * but mappers routinely author values like {1, 0.7, 1} that aren't.
 * Falls back to {0,1,0} if the input is degenerate.
 */
export function normaliseSunDir(v: [number, number, number]): [number, number, number] {
    const len = Math.hypot(v[0], v[1], v[2]);
    if (len < 1e-6) return [0, 1, 0];
    return [v[0] / len, v[1] / len, v[2] / len];
}

/** Deep-ish clone of a MapLighting (copies the colour arrays so a merge
 * never aliases the previous frame's vectors). */
export function cloneMapLighting(l: MapLighting): MapLighting {
    return {
        sunDir: [...l.sunDir],
        groundAmbient: [...l.groundAmbient],
        groundDiffuse: [...l.groundDiffuse],
        groundSpecular: [...l.groundSpecular],
        groundShadowDensity: l.groundShadowDensity,
        unitAmbient: [...l.unitAmbient],
        unitDiffuse: [...l.unitDiffuse],
        unitSpecular: [...l.unitSpecular],
        unitShadowDensity: l.unitShadowDensity,
        specularExponent: l.specularExponent,
        legacyCoordSystem: l.legacyCoordSystem,
    };
}

/**
 * Merge a `Spring.SetSunLighting{…}` params table into a MapLighting,
 * returning a new object plus the list of unrecognised keys. Faithful to
 * Recoil's `CSunLighting::SetValue` (rts/Rendering/Env/SunLighting.cpp):
 * the colour keys (`groundAmbientColor`/`groundDiffuseColor`/
 * `groundSpecularColor`/`unitAmbientColor`/`unitDiffuseColor`/
 * `unitSpecularColor`, with `model*` aliases) and the scalar keys
 * (`specularExponent`/`groundShadowDensity`/`modelShadowDensity`). Recoil
 * `luaL_error`s on an unknown key; we collect them so the caller can warn
 * without killing the widget. Key lookup is case-insensitive to tolerate the
 * lowerkeys'd map path as well as raw widget-authored camelCase.
 */
export function mergeSunLighting(
    base: MapLighting,
    params: Record<string, LuaValue> | null,
): { lighting: MapLighting; unknown: string[] } {
    const out = cloneMapLighting(base);
    const unknown: string[] = [];
    if (!params || typeof params !== 'object') return { lighting: out, unknown };

    // Recoil's CSunLighting uses `groundShadowDensity` for the ground term and
    // `modelShadowDensity` for units; our single MapLighting splits the same
    // way (`unitShadowDensity` ← model). The keys below are the union of
    // Recoil's accepted names; the value side reuses asVec3/asNumber so the
    // {r,g,b} and sequence shapes both parse.
    const colourKeys: Record<string, keyof MapLighting> = {
        groundambientcolor: 'groundAmbient',
        grounddiffusecolor: 'groundDiffuse',
        groundspecularcolor: 'groundSpecular',
        unitambientcolor: 'unitAmbient',
        modelambientcolor: 'unitAmbient',
        unitdiffusecolor: 'unitDiffuse',
        modeldiffusecolor: 'unitDiffuse',
        unitspecularcolor: 'unitSpecular',
        modelspecularcolor: 'unitSpecular',
    };
    const scalarKeys: Record<string, keyof MapLighting> = {
        specularexponent: 'specularExponent',
        groundshadowdensity: 'groundShadowDensity',
        modelshadowdensity: 'unitShadowDensity',
        unitshadowdensity: 'unitShadowDensity',
    };

    for (const rawKey of Object.keys(params)) {
        const key = rawKey.toLowerCase();
        const v = params[rawKey];
        if (key in colourKeys) {
            const field = colourKeys[key] as
                'groundAmbient' | 'groundDiffuse' | 'groundSpecular'
                | 'unitAmbient' | 'unitDiffuse' | 'unitSpecular';
            out[field] = asVec3(v, out[field]);
        } else if (key in scalarKeys) {
            const field = scalarKeys[key] as
                'specularExponent' | 'groundShadowDensity' | 'unitShadowDensity';
            out[field] = asNumber(v, out[field]);
        } else {
            unknown.push(rawKey);
        }
    }
    return { lighting: out, unknown };
}

/**
 * Apply `Spring.SetSunDirection(x, y, z, intensity?)` to a MapLighting,
 * returning a new object. Faithful to Recoil
 * (`LuaUnsyncedCtrl::SetSunDirection` → `SetLightDir(float3(x,y,z).norm)`):
 * the direction is the world→sun vector. `legacyCoordSystem` is preserved so
 * the same Z-flip `applyMapLighting` applies to the authored `sunDir` also
 * applies to the runtime one (consistent interpretation). The `intensity`
 * 4th arg is intentionally ignored — Recoil notes it "seems broken atm, only
 * toggles shadows off when set to 0" — so we keep the authored shadow density.
 */
export function setSunDirectionLighting(
    base: MapLighting, x: number, y: number, z: number,
): MapLighting {
    const out = cloneMapLighting(base);
    out.sunDir = normaliseSunDir([x, y, z]);
    return out;
}

/**
 * Read one `gl.GetSun(param, mode)` value from a MapLighting. Faithful to
 * Recoil `LuaOpenGL::GetSun` (rts/Lua/LuaOpenGL.cpp:6742): no param, "pos"
 * and "dir" all return the (unit-length) world→sun light direction;
 * "ambient"/"diffuse"/"specular"/"shadowDensity" return the *current* sun
 * lighting state — the same store `Spring.SetSunLighting` writes — with
 * mode "ground" (default) or "unit" selecting the ground/model variant
 * (Recoil tests only `mode[0] == 'u'`). Unknown params return nothing.
 * Triples come back as arrays (the Lua bridge unpacks arrays to multiple
 * return values, matching Recoil's 3-value push).
 *
 * The direction is returned in the raw stored space (no legacy Z-flip) so a
 * widget round-trip `SetSunDirection(gl.GetSun("pos"))` is the identity —
 * the flip is applied once at scene-apply time (`applyMapLighting`).
 */
export function readSunParam(
    l: MapLighting, param?: string | null, mode?: string | null,
): number[] | number | undefined {
    if (param == null) return normaliseSunDir(l.sunDir);
    const unit = (mode ?? 'ground').charAt(0) === 'u';
    switch (String(param)) {
        case 'pos':
        case 'dir':              return normaliseSunDir(l.sunDir);
        case 'specularExponent': return l.specularExponent;
        case 'shadowDensity':    return unit ? l.unitShadowDensity : l.groundShadowDensity;
        case 'ambient':          return unit ? [...l.unitAmbient] : [...l.groundAmbient];
        case 'diffuse':          return unit ? [...l.unitDiffuse] : [...l.groundDiffuse];
        case 'specular':         return unit ? [...l.unitSpecular] : [...l.groundSpecular];
        default:                 return undefined;
    }
}

// ── Atmosphere (gl.GetAtmosphere / Spring.SetAtmosphere) ───────────────────

/** Copy a MapAtmosphere (fresh colour arrays so merges never alias). */
export function cloneMapAtmosphere(a: MapAtmosphere): MapAtmosphere {
    return {
        fogStart: a.fogStart,
        fogEnd: a.fogEnd,
        fogColor: [...a.fogColor],
        skyColor: [...a.skyColor],
        sunColor: [...a.sunColor],
        cloudColor: [...a.cloudColor],
        skyAxisAngle: [...a.skyAxisAngle],
    };
}

/** Extract the `atmosphere` sub-table from a parsed `mapinfo` table, filling any
 * omitted field with the Recoil default. Pure — shared by `loadMapAtmosphere`. */
export function extractAtmosphere(
    mapinfo: Record<string, LuaValue> | null,
): MapAtmosphere {
    const atmo = tget(mapinfo, 'atmosphere');
    const at = (atmo && typeof atmo === 'object' && !Array.isArray(atmo))
        ? atmo as Record<string, LuaValue>
        : null;
    return {
        fogStart:     asNumber(tget(at, 'fogStart'), ATMOSPHERE_DEFAULTS.fogStart),
        fogEnd:       asNumber(tget(at, 'fogEnd'),   ATMOSPHERE_DEFAULTS.fogEnd),
        fogColor:     asVec4(tget(at, 'fogColor'),     ATMOSPHERE_DEFAULTS.fogColor),
        skyColor:     asVec3(tget(at, 'skyColor'),     ATMOSPHERE_DEFAULTS.skyColor),
        sunColor:     asVec3(tget(at, 'sunColor'),     ATMOSPHERE_DEFAULTS.sunColor),
        cloudColor:   asVec3(tget(at, 'cloudColor'),   ATMOSPHERE_DEFAULTS.cloudColor),
        skyAxisAngle: asVec4(tget(at, 'skyAxisAngle'), ATMOSPHERE_DEFAULTS.skyAxisAngle),
    };
}

/**
 * Fetch `mapinfo.lua` and extract the `atmosphere` table. Returns the Recoil
 * defaults for any field the map omits, and on any fetch/parse failure — so the
 * GL bridge's `gl.GetAtmosphere` always has numeric values to return (the crash
 * this fixes: BAR's `gui_options` compares `fogEnd <= fogStart` at Initialize).
 *
 * Note: this re-fetches the same `mapinfo.lua` that `loadMapLighting` reads; the
 * file is small and HTTP-cached, so the second request is served from cache.
 */
export async function loadMapAtmosphere(mapSourceUrl: string): Promise<MapAtmosphere> {
    const url = `${mapSourceUrl}/mapinfo.lua`;
    let source: string;
    try {
        const res = await fetch(url);
        if (!res.ok) {
            console.warn(`[map-lighting] atmosphere ${url}: HTTP ${res.status}; using defaults`);
            return defaultMapAtmosphere();
        }
        source = await res.text();
    } catch (e) {
        console.warn(`[map-lighting] atmosphere fetch ${url}: ${e}; using defaults`);
        return defaultMapAtmosphere();
    }

    const mapinfo = parseMapinfo(source, url);
    if (!mapinfo) {
        console.warn(`[map-lighting] atmosphere ${url}: parse failed; using defaults`);
        return defaultMapAtmosphere();
    }
    return extractAtmosphere(mapinfo);
}

/**
 * Merge a `Spring.SetAtmosphere{…}` params table into a MapAtmosphere, returning
 * a new object plus the list of unrecognised keys. Faithful to Recoil
 * `LuaUnsyncedCtrl::SetAtmosphere` (rts/Lua/LuaUnsyncedCtrl.cpp): table values
 * set the float4 colours / `skyAxisAngle`; number values set `fogStart`/`fogEnd`.
 * Recoil `luaL_error`s on an unknown key; we collect them so the caller can warn
 * without killing the widget.
 */
export function mergeAtmosphere(
    base: MapAtmosphere,
    params: Record<string, LuaValue> | null,
): { atmosphere: MapAtmosphere; unknown: string[] } {
    const out = cloneMapAtmosphere(base);
    const unknown: string[] = [];
    if (!params || typeof params !== 'object') return { atmosphere: out, unknown };

    const colourKeys: Record<string, 'fogColor' | 'skyColor' | 'sunColor' | 'cloudColor' | 'skyAxisAngle'> = {
        fogColor: 'fogColor',
        skyColor: 'skyColor',
        sunColor: 'sunColor',
        cloudColor: 'cloudColor',
        skyAxisAngle: 'skyAxisAngle',
    };

    for (const rawKey of Object.keys(params)) {
        const v = params[rawKey];
        if (rawKey === 'fogStart' || rawKey === 'fogEnd') {
            // Recoil only accepts these as numbers; ignore a non-number silently
            // (it falls through Recoil's `lua_isnumber` guard too).
            if (typeof v === 'number') out[rawKey] = v;
        } else if (rawKey in colourKeys) {
            const field = colourKeys[rawKey];
            if (field === 'fogColor' || field === 'skyAxisAngle') {
                out[field] = asVec4(v, out[field]);
            } else {
                out[field] = asVec3(v, out[field]);
            }
        } else {
            unknown.push(rawKey);
        }
    }
    return { atmosphere: out, unknown };
}
