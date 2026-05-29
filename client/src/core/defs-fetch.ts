/**
 * defs-fetch — eager HTTP fetch for the game's UnitDefs / WeaponDefs /
 * CegDefs / FeatureDefs.
 *
 * Format: brotli-compressed canonical Lua source written by
 * spring-server's bake step (LuaDefsSerializer + CompressBrotli) and
 * served by the Vite static-data plugin with `Content-Encoding: br`.
 * The browser decompresses transparently, so `fetch()` returns plain
 * Lua source text we just `load()` in a Fengari sandbox.
 *
 * Browser HTTP caching uses Last-Modified / ETag from the static
 * plugin — no cache-buster on the URL needed (the cache key in the
 * path already changes when modOptions or game version change).
 *
 * See PLAN-defs.md for the design rationale (Lua source vs FB vs
 * JSON vs bytecode).
 */
import {
    lua,
    lauxlib,
    lualib,
    to_luastring,
    to_jsstring,
} from 'fengari-web';

import type { DefCache } from './def-cache.js';
import type {
    UnitDefInfo,
    WeaponDefInfo,
    CegDefInfo,
    FeatureDefInfo,
    SoundRefInfo,
    CegSpawnInfo,
    CegPropertyInfo,
    GroundFlashInfo,
} from './connection.js';

// ─── Public API ──────────────────────────────────────────────────

/** Fetch all four def categories in parallel, decode via a sandboxed
 *  Fengari Lua state, and push into DefCache. unit + weapon are
 *  required (throws if missing); CEG + feature are best-effort
 *  (older bakes may be missing them — projectile renderer falls back
 *  to BUILTIN_EFFECTS, feature renderer to placeholder cubes). */
export async function fetchAndIngestDefs(
    gameId: string,
    cacheKey: string,
    defCache: DefCache,
): Promise<void> {
    if (!gameId || !cacheKey) return;
    // Relative URL: served by the Vite static-data plugin in dev and
    // by nginx/CDN in prod (the lobby dropped `/api/games/data/*` in
    // commit 78027e4004).
    const base = `/api/games/data/${gameId}/cache/defs/${cacheKey}`;

    const [unitSrc, weaponSrc, cegSrc, featureSrc] = await Promise.all([
        fetchLua(`${base}/unitdefs.lua.br`),
        fetchLua(`${base}/weapondefs.lua.br`),
        fetchLuaOptional(`${base}/cegdefs.lua.br`),
        fetchLuaOptional(`${base}/featuredefs.lua.br`),
    ]);

    // One sandboxed Lua state for the lifetime of this load. Each
    // chunk runs to completion and pops its result back to JS, so
    // we can re-use the state across chunks without state bleed.
    const sandbox = openSandbox();
    try {
        const unitDefs = evalDefsTable(sandbox, unitSrc, 'unitdefs');
        const weaponDefs = evalDefsTable(sandbox, weaponSrc, 'weapondefs');
        defCache.addUnitDefs(toUnitDefInfos(unitDefs));
        defCache.addWeaponDefs(toWeaponDefInfos(weaponDefs));

        if (cegSrc) {
            try {
                const cegDefs = evalDefsTable(sandbox, cegSrc, 'cegdefs');
                defCache.addCegDefs(toCegDefInfos(cegDefs));
            } catch (err) {
                console.warn('[defs-fetch] CEG ingest failed; falling back to BUILTIN_EFFECTS:', err);
            }
        }
        if (featureSrc) {
            try {
                const featureDefs = evalDefsTable(sandbox, featureSrc, 'featuredefs');
                defCache.addFeatureDefs(toFeatureDefInfos(featureDefs));
            } catch (err) {
                console.warn('[defs-fetch] FeatureDefs ingest failed; wrecks will render as placeholders:', err);
            }
        }
    } finally {
        lua.lua_close(sandbox);
    }
}

// ─── HTTP ────────────────────────────────────────────────────────

async function fetchLua(url: string): Promise<string> {
    const r = await fetch(url);
    if (!r.ok) throw new Error(`def fetch ${r.status}: ${url}`);
    return r.text();
}

async function fetchLuaOptional(url: string): Promise<string | null> {
    try {
        const r = await fetch(url);
        if (!r.ok) return null;
        return r.text();
    } catch {
        return null;
    }
}

// ─── Fengari sandbox ─────────────────────────────────────────────

/// Open a Fengari state with only the safe-for-untrusted-data stdlib
/// surface: pairs/ipairs/type/tostring/tonumber/select/error/pcall/
/// xpcall, plus the pure-functional string/table/math libs. No io /
/// os / package / debug / load / loadstring / loadfile / dofile /
/// require. Loaded chunks can only build tables and return them.
function openSandbox(): unknown {
    const L = lauxlib.luaL_newstate();
    // Open the full stdlib first (simplest path), then null out every
    // dangerous global. Defence in depth: even if a chunk had bytecode
    // (which mode='t' in load already rejects), it could not reach a
    // syscall.
    lualib.luaL_openlibs(L);
    for (const name of [
        'io', 'os', 'package', 'debug',
        'load', 'loadstring', 'loadfile', 'dofile', 'require',
        'collectgarbage', 'rawequal', 'rawget', 'rawset', 'rawlen',
        'setmetatable', 'getmetatable',
    ]) {
        lua.lua_pushnil(L);
        lua.lua_setglobal(L, to_luastring(name));
    }
    return L;
}

/// Compile + execute `source` in the given sandbox, return the
/// top-level Lua table converted to a JS object. Throws on parse /
/// exec error. mode='t' rejects bytecode chunks.
function evalDefsTable(L: any, source: string, chunkName: string): any {
    const top = lua.lua_gettop(L);
    const src = to_luastring(source);
    const name = to_luastring('=' + chunkName);
    const mode = to_luastring('t');
    const loadStatus = lauxlib.luaL_loadbufferx(L, src, src.length, name, mode);
    if (loadStatus !== lua.LUA_OK) {
        const errBytes = lua.lua_tostring(L, -1);
        const err = errBytes ? to_jsstring(errBytes) : '<unknown>';
        lua.lua_settop(L, top);
        throw new Error(`load ${chunkName}: ${err}`);
    }
    const execStatus = lua.lua_pcall(L, 0, 1, 0);
    if (execStatus !== lua.LUA_OK) {
        const errBytes = lua.lua_tostring(L, -1);
        const err = errBytes ? to_jsstring(errBytes) : '<unknown>';
        lua.lua_settop(L, top);
        throw new Error(`exec ${chunkName}: ${err}`);
    }
    if (lua.lua_type(L, -1) !== lua.LUA_TTABLE) {
        lua.lua_settop(L, top);
        throw new Error(`${chunkName}: expected table return, got something else`);
    }
    const obj = luaToJs(L, -1);
    lua.lua_settop(L, top);
    return obj;
}

/// Walk a Lua value at stack index `idx` and convert to a JS value.
/// Tables become arrays when keys are a pure 1..N sequence, else
/// plain objects with string-coerced keys.
function luaToJs(L: any, idx: number): any {
    const t = lua.lua_type(L, idx);
    switch (t) {
        case lua.LUA_TNIL: return null;
        case lua.LUA_TBOOLEAN: return lua.lua_toboolean(L, idx);
        case lua.LUA_TNUMBER: return lua.lua_tonumber(L, idx);
        case lua.LUA_TSTRING: {
            const b = lua.lua_tostring(L, idx);
            return b ? to_jsstring(b) : '';
        }
        case lua.LUA_TTABLE: return luaTableToJs(L, idx);
        default: return null;
    }
}

function luaTableToJs(L: any, idx: number): any {
    const absIdx = idx < 0 ? lua.lua_gettop(L) + idx + 1 : idx;

    // Probe whether this is a pure sequence (1..N integer keys).
    let isSequence = true;
    let maxIntKey = 0;
    let count = 0;
    lua.lua_pushnil(L);
    while (lua.lua_next(L, absIdx) !== 0) {
        count++;
        if (lua.lua_type(L, -2) === lua.LUA_TNUMBER) {
            const n = lua.lua_tonumber(L, -2);
            if (Number.isInteger(n) && n >= 1) {
                if (n > maxIntKey) maxIntKey = n;
            } else {
                isSequence = false;
            }
        } else {
            isSequence = false;
        }
        lua.lua_pop(L, 1);  // pop value, keep key
    }
    isSequence = isSequence && count === maxIntKey;

    if (isSequence) {
        const arr: any[] = new Array(count);
        for (let i = 1; i <= count; i++) {
            lua.lua_rawgeti(L, absIdx, i);
            arr[i - 1] = luaToJs(L, -1);
            lua.lua_pop(L, 1);
        }
        return arr;
    }

    const obj: Record<string, any> = {};
    lua.lua_pushnil(L);
    while (lua.lua_next(L, absIdx) !== 0) {
        let key: string;
        const keyType = lua.lua_type(L, -2);
        if (keyType === lua.LUA_TSTRING) {
            const kb = lua.lua_tostring(L, -2);
            key = kb ? to_jsstring(kb) : '';
        } else if (keyType === lua.LUA_TNUMBER) {
            key = String(lua.lua_tonumber(L, -2));
        } else {
            lua.lua_pop(L, 1);
            continue;
        }
        obj[key] = luaToJs(L, -1);
        lua.lua_pop(L, 1);
    }
    return obj;
}

// ─── Adapters: Lua snake_case → TS camelCase ─────────────────────

function num(v: any, def = 0): number {
    return typeof v === 'number' ? v : def;
}
function str(v: any, def = ''): string {
    return typeof v === 'string' ? v : def;
}
function bool(v: any, def = false): boolean {
    return typeof v === 'boolean' ? v : def;
}
function intArray(v: any): number[] {
    return Array.isArray(v) ? v.filter(x => typeof x === 'number') : [];
}
function stringMap(v: any): Record<string, string> {
    if (!v || typeof v !== 'object' || Array.isArray(v)) return {};
    const out: Record<string, string> = {};
    for (const [k, val] of Object.entries(v)) {
        if (typeof val === 'string') out[k] = val;
        else if (val != null) out[k] = String(val);
    }
    return out;
}

function toUnitDefInfos(parsed: any): UnitDefInfo[] {
    if (!parsed || !Array.isArray(parsed.defs)) return [];
    return parsed.defs.map((d: any) => ({
        defId: num(d.def_id),
        name: str(d.name),
        modelUrl: str(d.model_url),
        textureUrl: str(d.texture_url),
        humanName: str(d.human_name),
        tooltip: str(d.tooltip),
        wreckName: str(d.wreck_name),
        metalCost: num(d.metal_cost),
        energyCost: num(d.energy_cost),
        buildTime: num(d.build_time),
        metalMake: num(d.metal_make),
        energyMake: num(d.energy_make),
        metalUpkeep: num(d.metal_upkeep),
        energyUpkeep: num(d.energy_upkeep),
        metalStorage: num(d.metal_storage),
        energyStorage: num(d.energy_storage),
        extractsMetal: num(d.extracts_metal),
        health: num(d.health),
        mass: num(d.mass),
        radius: num(d.radius),
        xsize: num(d.xsize),
        zsize: num(d.zsize),
        speed: num(d.speed),
        turnRate: num(d.turn_rate),
        maxAcc: num(d.max_acc),
        maxDec: num(d.max_dec),
        // FB default for moveDefPathType was UINT32_MAX; the new emitter
        // omits the field when it equals that sentinel.
        moveDefPathType: num(d.move_def_path_type, 0xFFFFFFFF),
        losRadius: num(d.los_radius),
        airLosRadius: num(d.air_los_radius),
        radarRadius: num(d.radar_radius),
        sonarRadius: num(d.sonar_radius),
        jammerRadius: num(d.jammer_radius),
        seismicRadius: num(d.seismic_radius),
        flags: num(d.flags),
        buildDistance: num(d.build_distance),
        buildSpeed: num(d.build_speed),
        buildOptions: intArray(d.build_options),
        weaponDefIds: intArray(d.weapon_def_ids),
        customParams: stringMap(d.custom_params),
        repairSpeed: num(d.repair_speed),
        transportSize: num(d.transport_size),
        transportMass: num(d.transport_mass),
        transportCapacity: num(d.transport_capacity),
        yardmap: str(d.yardmap),
        script: str(d.script),
        buildPic: str(d.build_pic),
        trackType: str(d.track_type),
        maxVelocity: num(d.max_velocity),
        cost: num(d.cost),
        maxWeaponRange: num(d.max_weapon_range),
        maxThisUnit: num(d.max_this_unit),
        // FB defaulted both to true; emitter skips when value matches.
        canBeAssisted: bool(d.can_be_assisted, true),
        canSelfDestruct: bool(d.can_self_destruct, true),
        selfDCountdown: num(d.self_d_countdown),
        categoryBits: num(d.category_bits),
        sounds: toSoundRefs(d.sounds),
    }));
}

function toWeaponDefInfos(parsed: any): WeaponDefInfo[] {
    if (!parsed || !Array.isArray(parsed.defs)) return [];
    return parsed.defs.map((d: any) => ({
        defId: num(d.def_id),
        name: str(d.name),
        projectileType: num(d.projectile_type),
        projectileSpeed: num(d.projectile_speed),
        range: num(d.range),
        aoe: num(d.aoe),
        size: num(d.size),
        intensity: num(d.intensity),
        colorR: num(d.color_r),
        colorG: num(d.color_g),
        colorB: num(d.color_b),
        color2R: num(d.color2_r, 1),
        color2G: num(d.color2_g, 1),
        color2B: num(d.color2_b, 1),
        thickness: num(d.thickness),
        coreThickness: num(d.core_thickness),
        laserHardStop: bool(d.laser_hard_stop),
        falloffRate: num(d.falloff_rate),
        duration: num(d.duration),
        highTrajectory: bool(d.high_trajectory),
        typeName: str(d.type_name),
        description: str(d.description),
        defaultDamage: num(d.default_damage),
        damages: Array.isArray(d.damages)
            ? d.damages.filter((x: any) => typeof x === 'number')
            : [],
        reloadTime: num(d.reload_time),
        salvoSize: num(d.salvo_size),
        salvoDelay: num(d.salvo_delay),
        accuracy: num(d.accuracy),
        sprayAngle: num(d.spray_angle),
        movingAccuracy: num(d.moving_accuracy),
        targetMoveError: num(d.target_move_error),
        leadLimit: num(d.lead_limit),
        edgeEffectiveness: num(d.edge_effectiveness),
        impulseFactor: num(d.impulse_factor),
        impulseBoost: num(d.impulse_boost),
        craterMult: num(d.crater_mult),
        craterBoost: num(d.crater_boost),
        craterAoe: num(d.crater_aoe),
        fireStarter: num(d.fire_starter),
        flightTime: num(d.flight_time),
        weaponAcceleration: num(d.weapon_acceleration),
        turnRate: num(d.turn_rate),
        uptime: num(d.uptime),
        coverageRange: num(d.coverage_range),
        stockpileTime: num(d.stockpile_time),
        metalCost: num(d.metal_cost),
        energyCost: num(d.energy_cost),
        flags: num(d.flags),
        customParams: stringMap(d.custom_params),
        modelUrl: str(d.model_url),
        texture1: str(d.texture1),
        texture2: str(d.texture2),
        texture3: str(d.texture3),
        cegTag: str(d.ceg_tag),
        explosionGenerator: str(d.explosion_generator),
        bounceExplosionGenerator: str(d.bounce_explosion_generator),
        scrollSpeed: num(d.scroll_speed),
        sounds: toSoundRefs(d.sounds),
    }) as WeaponDefInfo);
}

function toFeatureDefInfos(parsed: any): FeatureDefInfo[] {
    if (!parsed || !Array.isArray(parsed.defs)) return [];
    return parsed.defs.map((d: any) => ({
        defId: num(d.def_id),
        name: str(d.name),
        modelUrl: str(d.model_url),
        textureUrl: str(d.texture_url),
        drawType: num(d.draw_type),
        footprintX: num(d.footprint_x),
        footprintZ: num(d.footprint_z),
        height: num(d.height),
        radius: num(d.radius),
        mass: num(d.mass),
        health: num(d.health),
        blocking: bool(d.blocking),
        reclaimable: bool(d.reclaimable),
        destructable: bool(d.destructable),
        burnable: bool(d.burnable),
        floating: bool(d.floating),
        geoThermal: bool(d.geo_thermal),
        metal: num(d.metal),
        energy: num(d.energy),
        deathFeatureDefId: num(d.death_feature_def_id),
        smokeTime: num(d.smoke_time),
        reclaimTime: num(d.reclaim_time),
        scriptName: str(d.script_name),
        customParams: stringMap(d.custom_params),
    }) as FeatureDefInfo);
}

function toCegDefInfos(parsed: any): CegDefInfo[] {
    if (!parsed || !Array.isArray(parsed.defs)) return [];
    return parsed.defs.map((d: any) => ({
        tag: str(d.tag),
        spawns: Array.isArray(d.spawns) ? d.spawns.map((s: any) => ({
            spawnName: str(s.spawn_name),
            className: str(s.class_name),
            count: num(s.count),
            flags: num(s.flags),
            properties: s.properties
                ? Object.entries(s.properties).map(([k, v]) => ({
                    key: k,
                    value: typeof v === 'string' ? v : String(v),
                }) as CegPropertyInfo)
                : [],
        }) as CegSpawnInfo) : [],
        useDefaultExplosions: bool(d.use_default_explosions),
        groundFlash: d.ground_flash ? ({
            ttl: num(d.ground_flash.ttl),
            circleAlpha: num(d.ground_flash.circle_alpha),
            flashSize: num(d.ground_flash.flash_size),
            flashAlpha: num(d.ground_flash.flash_alpha),
            circleGrowth: num(d.ground_flash.circle_growth),
            colorR: num(d.ground_flash.color_r, 1),
            colorG: num(d.ground_flash.color_g, 1),
            colorB: num(d.ground_flash.color_b, 0.8),
            flags: num(d.ground_flash.flags),
        }) as GroundFlashInfo : null,
    }) as CegDefInfo);
}

function toSoundRefs(v: any): SoundRefInfo[] {
    if (!Array.isArray(v)) return [];
    return v.map(s => ({
        id: num(s.id),
        path: str(s.path),
        category: num(s.category),
        volume: num(s.volume, 1),
        pitch: num(s.pitch, 1),
        name: str(s.name),
    }) as SoundRefInfo);
}
