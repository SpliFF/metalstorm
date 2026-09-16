import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { encodeWire, encodeGuidance, luaLongString } from './guidance-wire.js';

const here = dirname(fileURLToPath(import.meta.url));
const FIXTURES = resolve(here, '../../data/games/metalstorm/LuaRules/Gadgets/parley/tests/wire-fixtures.tsv');

function loadFixtures() {
    if (!existsSync(FIXTURES)) return null;
    const rows = [];
    for (const line of readFileSync(FIXTURES, 'utf8').split('\n')) {
        if (!line || line.startsWith('#')) continue;
        const cols = line.split('\t');
        const [cmd, wire, ...fieldCols] = cols;
        const fields = {};
        for (const col of fieldCols) {
            const eq = col.indexOf('=');
            let key = col.slice(0, eq);
            const value = col.slice(eq + 1);
            if (key.endsWith('[]')) { key = key.slice(0, -2); fields[key] = value.split(','); }
            else fields[key] = value;
        }
        rows.push({ cmd, wire, fields });
    }
    return rows;
}

test('encodes every row of the shared cross-language fixture file byte-for-byte', (t) => {
    const rows = loadFixtures();
    if (!rows) { t.skip(`fixture file missing: ${FIXTURES}`); return; }
    assert.ok(rows.length > 10, 'fixture file parsed');
    for (const r of rows) assert.equal(encodeWire(r.cmd, r.fields), r.wire, r.cmd);
});

test('encodeGuidance produces the gadget field names and validates enums', () => {
    assert.equal(encodeGuidance({ op: 'stance', value: 'aggressive' }).wire, 'cmd=guidance.stance&value=aggressive');
    assert.equal(encodeGuidance({ op: 'paint', regionKey: 'north_gate_ridge', value: 'priority' }).wire,
        'cmd=guidance.paint&regionKey=north_gate_ridge&value=priority');
    assert.equal(encodeGuidance({ op: 'lock', groupId: 5, value: 'off' }).wire, 'cmd=guidance.lock&groupId=5&locked=0');
    assert.equal(encodeGuidance({ op: 'delegate', objectiveId: 42 }).wire, 'cmd=guidance.delegate&delegated=1&objectiveId=42');
    assert.equal(encodeGuidance({ op: 'fund', amount: 100, rateCap: 200 }).wire, 'cmd=guidance.fund&amount=100&rateCap=200');
    assert.equal(encodeGuidance({ op: 'veto', goalId: 'def:basin_a' }).wire, 'cmd=guidance.veto&goalId=def:basin_a');
    assert.match(encodeGuidance({ op: 'stance', value: 'berserk' }).error, /must be one of/);
    assert.match(encodeGuidance({ op: 'paint', value: 'priority' }).error, /regionKey/);
    assert.match(encodeGuidance({ op: 'fund' }).error, /amount/);
    assert.match(encodeGuidance({ op: 'nope' }).error, /unknown op/);
});

test('luaLongString picks a bracket level the payload cannot close', () => {
    assert.equal(luaLongString('abc'), '[[abc]]');
    assert.equal(luaLongString('a]]b'), '[=[a]]b]=]');
    assert.equal(luaLongString('a]=]b'), '[[a]=]b]]');
    assert.equal(luaLongString('a]]b]=]c'), '[==[a]]b]=]c]==]');
});
