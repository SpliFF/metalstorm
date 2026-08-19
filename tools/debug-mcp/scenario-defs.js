/**
 * Offline def-name universe for `validate_scenario`.
 *
 * `game_scenario.lua`'s validate() rejects an unknown `def` on units, halls,
 * civilians and world features — a typo there stages a war that boots clean
 * and is silently missing the thing the fight was designed around
 * (game_scenario.lua:261-265, :344-368). To make that check offline we need
 * the same name universe the sim builds from UnitDefs/FeatureDefs.
 *
 * Since `63287c0e4e` the server bakes defs as brotli-compressed Lua
 * (`cache/defs/<key>/{unitdefs,featuredefs,weapondefs}.lua.br`, shape
 * `return { base_url = …, defs = { { name = 'ms_…', … }, … } }`), which is
 * exactly a name-recoverable form. The pre-v14 FlatBuffer `.bin` files are
 * legacy: they cover unitdefs/weapondefs only — **feature defs have no `.bin`
 * form at all** — so this reader is `.lua.br`-first and the caller degrades
 * honestly when neither exists rather than inventing unknown-def errors out of
 * an empty universe.
 *
 * server.js's `loadDefsCache`/`listDefsFromCache` still read the `.bin` path
 * for `get_unit_def`/`list_unit_defs`; unifying those on this reader is the
 * job of the deferred `unitdefs.json.br` sidecar work, which is why this is a
 * standalone module rather than an edit in place.
 */
import { join } from 'path';
import { existsSync, readdirSync, readFileSync, statSync } from 'fs';
import { brotliDecompressSync } from 'zlib';
import { evalBareLua } from './scenario-lua.js';

/**
 * Def names of `kind` for `gameId`, read from the newest baked cache key.
 *
 * @param {string} projectRoot repo root (server.js's PROJECT_ROOT convention)
 * @param {string} gameId
 * @param {'unitdefs'|'featuredefs'|'weapondefs'} kind
 * @returns {{defs: Map<string, object>, source: string, file: string, mtime: string}|null}
 *          null when no baked cache exists — the caller must then SKIP every
 *          unknown-def rule, never fail them. The map is name -> the whole
 *          baked def, so rules that need more than existence (the feature
 *          chain rule needs `custom_params.chain_pitch`) can have it.
 */
export function loadDefNames(projectRoot, gameId, kind) {
    const dir = join(projectRoot, 'data', 'games', gameId, 'cache', 'defs');
    if (!existsSync(dir)) return null;

    // Newest wins, same rule as loadDefsCache: several cache keys coexist
    // (the key changes when the schema version or content hash moves) and the
    // freshest is the one the last server run baked.
    let best = null;
    let bestMtime = 0;
    for (const k of readdirSync(dir)) {
        const file = join(dir, k, `${kind}.lua.br`);
        if (!existsSync(file)) continue;
        const m = statSync(file).mtimeMs;
        if (m > bestMtime) { best = file; bestMtime = m; }
    }
    if (!best) return null;

    let source;
    try {
        source = brotliDecompressSync(readFileSync(best)).toString('utf8');
    } catch (e) {
        return null;
    }
    const r = evalBareLua(source, `${kind}.lua.br`);
    if (!r.ok || !Array.isArray(r.table.defs)) return null;

    const defs = new Map();
    for (const d of r.table.defs)
        if (d && typeof d.name === 'string' && d.name) defs.set(d.name, d);
    if (!defs.size) return null;

    return {
        defs,
        source: 'lua.br',
        file: best,
        mtime: new Date(bestMtime).toISOString(),
    };
}

/**
 * Region keys declared by `data/maps/<mapId>/mapdata/regions.lua`.
 *
 * Best-effort by construction: the authoritative graph is the live one
 * (`GG.Regions.Keys()`, game_scenario.lua:396-412), and a map processed since
 * this file was written can drift from it. A map that ships no `regions.lua`
 * uses the 2048-elmo GRID provider and addresses regions by grid key ("2:2") —
 * for those this returns null and the caller skips, which is correct: any
 * string can be a grid key. Since PLAN-maps M9l every terragen map DOES ship a
 * graph (archipelago.py emits it), so the grid-key case is now
 * `green_flat_x34_v3` and the imported maps that were never regenerated.
 *
 * @returns {{keys: Set<string>, file: string}|null}
 */
export function loadRegionKeys(projectRoot, mapId) {
    if (!mapId) return null;
    const file = join(projectRoot, 'data', 'maps', mapId, 'mapdata', 'regions.lua');
    if (!existsSync(file)) return null;
    const r = evalBareLua(readFileSync(file, 'utf8'), 'regions.lua');
    if (!r.ok || !Array.isArray(r.table.regions)) return null;
    const keys = new Set();
    for (const reg of r.table.regions)
        if (reg && typeof reg.key === 'string' && reg.key) keys.add(reg.key);
    if (!keys.size) return null;
    return { keys, file };
}
