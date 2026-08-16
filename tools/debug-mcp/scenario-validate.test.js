/**
 * `node --test tools/debug-mcp/` — the offline scenario validator.
 *
 * Three kinds of case, in order of what they protect:
 *
 *  1. **The regression sweep.** Every scenario this repo ships boots today, so
 *     every one of them must validate with zero errors. This is the only
 *     bound on "does the rule inventory actually mirror the two parsers, or
 *     did I invent a rule neither has" — a false-positive rule fails here
 *     loudly instead of blocking a real author later. It is what caught
 *     zero-victory being modelled as an error when four shipped scenarios
 *     legitimately have no terminal objective.
 *  2. **One negative per rule id**, as in-memory sources, so each rule is
 *     shown to fire on the shape it claims to catch.
 *  3. **The CMD mirror pin**, re-derived from LuaConstCMD.cpp.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { evalBareLua } from './scenario-lua.js';
import { loadDefNames, loadRegionKeys } from './scenario-defs.js';
import { validateScenario, runScenarioValidation, CMD_NAMES } from './scenario-validate.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const GAME = 'metalstorm';
const SCENARIO_DIR = join(ROOT, 'data', 'games', GAME, 'scenarios');

/** Rules against an in-memory source, with the real repo's def universe. */
const UNITS = loadDefNames(ROOT, GAME, 'unitdefs');
const FEATURES = loadDefNames(ROOT, GAME, 'featuredefs');

function findings(luaBody, opts = {}) {
    const r = evalBareLua(luaBody, 'fixture.lua');
    assert.ok(r.ok, `fixture did not evaluate: ${r.error}`);
    return validateScenario(r.table, {
        unitDefs: UNITS ? UNITS.defs : null,
        featureDefs: FEATURES ? FEATURES.defs : null,
        regionKeys: null,
        mapDirExists: null,
        ...opts,
    });
}
const has = (f, severity, rule) => f.some((x) => x.severity === severity && x.rule === rule);

// A minimal scenario that validates clean — every negative below is this plus
// exactly one defect, so a firing rule is unambiguously the defect's.
const BASE = `return {
  version = 1,
  world = { map = 'green_flat_x34_v3' },
  sides = { { faction = 'compact', team = 0 }, { faction = 'union', team = 1 } },
  units = {
    { def = 'ms_soldiers_s1', team = 0, x = 100, z = 100 },
    { def = 'ms_soldiers_s1', team = 1, x = 900, z = 900 },
  },
  objectives = { { type = 'destroy_all', victory = true } },
}`;

// --- 1. regression sweep --------------------------------------------------

test('every shipped scenario validates with zero errors', async () => {
    const ids = readdirSync(SCENARIO_DIR)
        .filter((f) => f.endsWith('.lua'))
        .map((f) => f.replace(/\.lua$/, ''));
    assert.ok(ids.length >= 5, `expected the shipped scenarios, found ${ids.length}`);
    for (const id of ids) {
        const r = await runScenarioValidation({ projectRoot: ROOT, gameId: GAME, scenarioId: id });
        const errs = r.findings.filter((f) => f.severity === 'error');
        assert.deepEqual(errs, [], `${id} reported errors: ${JSON.stringify(errs, null, 2)}`);
    }
});

test('the baked def caches are readable and name-keyed', () => {
    assert.ok(UNITS, 'no unitdefs.lua.br — bake defs by running a game once');
    assert.ok(FEATURES, 'no featuredefs.lua.br');
    assert.ok(UNITS.defs.size > 50, `only ${UNITS.defs.size} unit defs`);
    // The chain rule needs more than the name: it reads custom_params.
    const bridge = FEATURES.defs.get('ms_rail_bridge');
    assert.ok(bridge && bridge.custom_params.chain_pitch, 'ms_rail_bridge has no chain_pitch');
});

test('the base fixture is clean, so every negative below is its own defect', () => {
    assert.deepEqual(findings(BASE).filter((f) => f.severity === 'error'), []);
});

// --- 2. one negative per rule --------------------------------------------

test('bare-parse: file-scope sim globals vanish from the lobby, not error', async () => {
    const r = await runScenarioValidation({
        projectRoot: ROOT, gameId: GAME,
        luaSource: 'Spring.Echo("hi")\nreturn { version = 1 }',
    });
    assert.equal(r.ok, false);
    assert.deepEqual(r.findings.map((f) => f.rule), ['bare-parse']);
    assert.match(r.findings[0].message, /BARE lua_State/);
});

test('bare-parse: a file that does not return a table', async () => {
    const r = await runScenarioValidation({ projectRoot: ROOT, luaSource: 'return 5' });
    assert.equal(r.findings[0].rule, 'bare-parse');
    assert.match(r.findings[0].message, /did not return a table/);
});

test('version: anything but 1', () => {
    assert.ok(has(findings(BASE.replace('version = 1', 'version = 2')), 'error', 'version'));
});

test('victory-count: zero is a warning (the war just never ends)', () => {
    const f = findings(BASE.replace('victory = true', 'victory = false'));
    assert.ok(has(f, 'warning', 'victory-count'));
    assert.equal(f.filter((x) => x.severity === 'error').length, 0);
});

test('victory-count: a tutorial with no victory is only info', () => {
    const f = findings(BASE.replace('version = 1', 'version = 1, tutorial = true')
        .replace('victory = true', 'victory = false'));
    assert.ok(has(f, 'info', 'victory-count'));
});

test('victory-count: two terminal objectives warn', () => {
    const f = findings(BASE.replace('{ type = \'destroy_all\', victory = true }',
        '{ type = \'destroy_all\', victory = true }, { type = \'control\', victory = true }'));
    assert.ok(has(f, 'warning', 'victory-count'));
});

test('side-unstaged: a playable side whose team has no units (endtoend D19)', () => {
    const f = findings(BASE.replace('{ faction = \'union\', team = 1 }', '{ faction = \'union\', team = 7 }'));
    assert.ok(has(f, 'error', 'side-unstaged'));
    assert.match(f.find((x) => x.rule === 'side-unstaged').message, /team 7/);
});

test('side-unstaged does NOT fire for an NPC side (every team is an ai entry)', () => {
    const f = findings(BASE
        .replace('{ faction = \'union\', team = 1 }', '{ faction = \'reavers\', team = 7 }')
        .replace('objectives =', 'ai = { { team = 7, profile = \'strategos\' } },\n  objectives ='));
    assert.ok(!has(f, 'error', 'side-unstaged'), JSON.stringify(f));
});

test('faction-key: a comma or colon drops the side from the room', () => {
    const f = findings(BASE.replace("faction = 'union'", "faction = 'union,north'"));
    assert.ok(has(f, 'error', 'faction-key'));
});

test('side-ignored: a side with no faction or no team gets no slot', () => {
    const f = findings(BASE.replace("{ faction = 'union', team = 1 }", "{ factoin = 'union', team = 1 }"));
    assert.ok(has(f, 'warning', 'side-ignored'));
});

test('side-capacity: a negative capacity is a typo, not "unlimited"', () => {
    const f = findings(BASE.replace("faction = 'union', team = 1", "faction = 'union', team = 1, capacity = -1"));
    assert.ok(has(f, 'warning', 'side-capacity'));
});

test('unknown-unitdef', () => {
    const f = findings(BASE.replace("def = 'ms_soldiers_s1', team = 1", "def = 'ms_soldeirs_s1', team = 1"));
    assert.ok(has(f, 'error', 'unknown-unitdef'));
    assert.equal(f.find((x) => x.rule === 'unknown-unitdef').path, 'units[2]');
});

test('unknown-cmd: an order naming no CMD constant', () => {
    const f = findings(BASE.replace('x = 100, z = 100', "x = 100, z = 100, orders = { { cmd = 'CHARGE' } }"));
    assert.ok(has(f, 'error', 'unknown-cmd'));
    assert.equal(f.find((x) => x.rule === 'unknown-cmd').path, 'units[1].orders[1]');
});

test('a known CMD name and a numeric id both pass', () => {
    const f = findings(BASE.replace('x = 100, z = 100',
        "x = 100, z = 100, orders = { { cmd = 'FIGHT' }, { cmd = 16 } }"));
    assert.ok(!has(f, 'error', 'unknown-cmd'));
});

test('unit-team: the "neutral" typo is rejected, not silently skipped', () => {
    const f = findings(BASE.replace("team = 1, x = 900", "team = 'nuetral', x = 900"));
    assert.ok(has(f, 'error', 'unit-team'));
});

test('unit-team: the literal "neutral" is fine (Gaia)', () => {
    const f = findings(BASE.replace("team = 1, x = 900", "team = 'neutral', x = 900"));
    assert.ok(!has(f, 'error', 'unit-team'));
});

test('landmark-name: a name ending in _x parses under a truncated name', () => {
    const f = findings(BASE.replace('x = 100, z = 100', "x = 100, z = 100, name = 'depot_x'"));
    assert.ok(has(f, 'error', 'landmark-name'));
    assert.match(f.find((x) => x.rule === 'landmark-name').message, /LAST underscore/);
});

test('landmark-collision: units[] and world.features[] are ONE name space', () => {
    const f = findings(BASE
        .replace('x = 100, z = 100', "x = 100, z = 100, name = 'ferry'")
        .replace("world = { map = 'green_flat_x34_v3' }",
            "world = { map = 'green_flat_x34_v3', features = { { def = 'ms_colossus_wreck', x = 5, z = 5, name = 'ferry' } } }"));
    assert.ok(has(f, 'error', 'landmark-collision'));
});

test('town-key + orphan-civilian-town', () => {
    const f = findings(BASE.replace('objectives =',
        "towns = { { key = 'harbour' }, { key = 'harbour' } },\n"
        + "  civilians = { units = { { def = 'ms_soldiers_s1', town = 'habour' } } },\n  objectives ="));
    assert.ok(has(f, 'error', 'town-key'));
    assert.ok(has(f, 'error', 'orphan-civilian-town'));
});

test('region-entry: neither a key nor x/z', () => {
    const f = findings(BASE.replace("world = { map = 'green_flat_x34_v3' }",
        "world = { map = 'green_flat_x34_v3', regions = { { name = 'The Basin' } } }"));
    assert.ok(has(f, 'error', 'region-entry'));
});

test('unknown-featuredef, feature-coords and feature-facing', () => {
    const f = findings(BASE.replace("world = { map = 'green_flat_x34_v3' }",
        "world = { map = 'green_flat_x34_v3', features = { { def = 'ms_no_such_wreck', facing = 'northeast' } } }"));
    assert.ok(has(f, 'error', 'unknown-featuredef'));
    assert.ok(has(f, 'error', 'feature-coords'));
    assert.ok(has(f, 'error', 'feature-facing'));
});

test('feature-chain: chain > 1 on a def with no chain_pitch stacks every segment', () => {
    const f = findings(BASE.replace("world = { map = 'green_flat_x34_v3' }",
        "world = { map = 'green_flat_x34_v3', features = { { def = 'ms_colossus_wreck', x = 5, z = 5, chain = 3 } } }"));
    assert.ok(has(f, 'error', 'feature-chain'));
});

test('feature-chain: a def that DOES declare chain_pitch is fine', () => {
    const f = findings(BASE.replace("world = { map = 'green_flat_x34_v3' }",
        "world = { map = 'green_flat_x34_v3', features = { { def = 'ms_rail_bridge', x = 5, z = 5, chain = 3 } } }"));
    assert.ok(!has(f, 'error', 'feature-chain'), JSON.stringify(f));
});

test('ai-slate: an unimplemented slate kind, and an empty kinds list', () => {
    const f = findings(BASE.replace('objectives =',
        "ai = { { team = 1, slate = { kinds = { 'ambush' } } }, { team = 1, slate = { kinds = {} } } },\n  objectives ="));
    assert.equal(f.filter((x) => x.rule === 'ai-slate' && x.severity === 'error').length, 2);
});

test('ai-team and ai-stipend', () => {
    const f = findings(BASE.replace('objectives =',
        "ai = { { team = 'red', stipend = { every = 300 } } },\n  objectives ="));
    assert.ok(has(f, 'error', 'ai-team'));
    assert.ok(has(f, 'error', 'ai-stipend'));
});

test('ai-region: a slate key this map\'s graph does not declare (warning, not error)', () => {
    const regions = loadRegionKeys(ROOT, 'green_flat_x34_v3');
    assert.ok(regions, 'green_flat_x34_v3 should ship a region graph');
    const f = findings(
        BASE.replace('objectives =', "ai = { { team = 1, slate = { kinds = { 'raid' }, home = 'atlantis' } } },\n  objectives ="),
        { regionKeys: regions.keys });
    assert.ok(has(f, 'warning', 'ai-region'));
    assert.ok(!has(f, 'error', 'ai-region'));
});

test('objective-phases: a chain the loader would skip rather than build', () => {
    // Every shape here leaves the parent a plain objective at runtime, with no
    // error anywhere — the author only finds out because the tutorial's second
    // beat never arrives.
    const bad = (phases) => findings(BASE.replace("{ type = 'destroy_all', victory = true }",
        `{ type = 'destroy_all', victory = true, phases = ${phases} }`));
    assert.ok(has(bad("'later'"), 'error', 'objective-phases'));
    assert.ok(has(bad('{ {} }'), 'error', 'objective-phases'));
    assert.ok(has(bad('{ { { reward = 1 } } }'), 'error', 'objective-phases'));
    assert.ok(has(bad("{ { { type = 'kill', phases = { { { type = 'kill' } } } } } }"),
        'error', 'objective-phases'));
});

test('objective-phases: the authorable one-level chain passes', () => {
    const f = findings(BASE.replace("{ type = 'destroy_all', victory = true }",
        "{ type = 'control', params = { regionKey = 'r1' }, victory = true, bounty = 10, phase = 1, "
        + "phases = { { { type = 'control', region = 'r1', reward = 40 } }, "
        + "{ { type = 'control', region = 'r2', reward = 80 } } } }"));
    assert.ok(!has(f, 'error', 'objective-phases'), JSON.stringify(f));
    assert.ok(!has(f, 'error', 'objective-chain-id'), JSON.stringify(f));
});

test('objective-chain-id: parentId is a runtime id, not a name', () => {
    const f = findings(BASE.replace("{ type = 'destroy_all', victory = true }",
        "{ type = 'destroy_all', victory = true, parentId = 'the_first_one', linkedId = {} }"));
    assert.equal(f.filter((x) => x.rule === 'objective-chain-id' && x.severity === 'error').length, 2);
});

test('standing-orders-noop: the top-level orders block is loudly ignored', () => {
    const f = findings(BASE.replace('objectives =', "orders = { { cmd = 'FIGHT' } },\n  objectives ="));
    assert.ok(has(f, 'warning', 'standing-orders-noop'));
});

test('gen-prefix: reserved for DB-owned generated wars', () => {
    const f = findings(BASE, { scenarioId: 'gen_meridian_deadbeef' });
    assert.ok(has(f, 'warning', 'gen-prefix'));
});

test('world-map: a map this machine does not have', () => {
    const f = findings(BASE, { mapDirExists: false });
    assert.ok(has(f, 'warning', 'world-map'));
});

test('world-map: NO world.map at all is reported, not silently passed', () => {
    // The regression: deleting the map line from the shipped showcase war gave
    // ok:true with zero findings AND zero `skipped` — indistinguishable from a
    // fully checked clean file, while every map-dependent pass had been quietly
    // skipped. A warning (not an error): ScenarioDiscovery reads a missing map
    // as an empty mapId rather than rejecting the war.
    const f = findings(BASE.replace("world = { map = 'green_flat_x34_v3' },", ''));
    assert.ok(has(f, 'warning', 'world-map'), JSON.stringify(f));
    assert.ok(!has(f, 'error', 'world-map'), 'a war with no map still loads — warning, not error');
    const wm = f.find((x) => x.rule === 'world-map');
    assert.match(wm.message, /SKIPPED, not passed/);
});

test('world-map: a non-string map is still an error', () => {
    const f = findings(BASE.replace("map = 'green_flat_x34_v3'", 'map = 42'));
    assert.ok(has(f, 'error', 'world-map'), JSON.stringify(f));
});

test('region-graph-missing: says WHY when there is no map to graph', () => {
    const f = findings(
        BASE.replace("world = { map = 'green_flat_x34_v3' },",
                     "ai = { { team = 0, slate = { home = 'r1' } } },"),
        { regionKeys: null });
    const skipped = f.find((x) => x.rule === 'region-graph-missing');
    assert.ok(skipped, JSON.stringify(f));
    assert.match(skipped.message, /declares no world\.map/);
});

test('defs-cache-missing: an empty universe SKIPS the def rules, never fails them', () => {
    const f = findings(BASE.replace("def = 'ms_soldiers_s1', team = 1", "def = 'utterly_bogus', team = 1"),
        { unitDefs: null, featureDefs: null });
    assert.ok(has(f, 'skipped', 'defs-cache-missing'));
    assert.equal(f.filter((x) => x.severity === 'error').length, 0);
});

test('the acceptance case: two victories AND a bogus def in ONE call', () => {
    const f = findings(BASE
        .replace("def = 'ms_soldiers_s1', team = 1", "def = 'ms_soldeirs_s1', team = 1")
        .replace("{ type = 'destroy_all', victory = true }",
            "{ type = 'destroy_all', victory = true }, { type = 'control', victory = true }"));
    assert.ok(has(f, 'warning', 'victory-count'));
    assert.ok(has(f, 'error', 'unknown-unitdef'));
});

// --- 3. the CMD mirror ----------------------------------------------------

test('CMD_NAMES equals the CMD table LuaConstCMD.cpp actually pushes', () => {
    const src = readFileSync(join(ROOT, 'rts', 'Lua', 'LuaConstCMD.cpp'), 'utf8');
    const derived = new Set();
    for (const m of src.matchAll(/PUSH_CMD\(([A-Z_0-9]+)\)/g)) derived.add(m[1]);
    for (const m of src.matchAll(/LuaPushNamedNumber\(L,\s*"([A-Z_0-9]+)"/g)) derived.add(m[1]);
    assert.ok(derived.size > 40, `only ${derived.size} names derived — did the macro shape change?`);
    const missing = [...derived].filter((n) => !CMD_NAMES.has(n));
    const extra = [...CMD_NAMES].filter((n) => !derived.has(n));
    assert.deepEqual({ missing, extra }, { missing: [], extra: [] },
        'CMD_NAMES has drifted from rts/Lua/LuaConstCMD.cpp — update the constant in scenario-validate.js');
});

// --- the Lua->JS reader ---------------------------------------------------

test('a pure 1..n table reads back as a JS array, a mixed one as an object', () => {
    const r = evalBareLua("return { a = { 10, 20, 30 }, b = { [1] = 'x', k = 'y' } }");
    assert.deepEqual(r.table.a, [10, 20, 30]);
    assert.deepEqual(r.table.b, { 1: 'x', k: 'y' });
});

test('a self-referential table is bounded, not a hang', () => {
    const r = evalBareLua('local t = {} t.self = t return t');
    assert.ok(r.ok);
    // 16 levels of nesting then a truncation marker — no stack overflow.
    let node = r.table;
    let depth = 0;
    while (node && node.self) { node = node.self; depth++; }
    assert.ok(depth > 0 && depth <= 17, `depth ${depth}`);
});
