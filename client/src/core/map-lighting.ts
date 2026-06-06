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
