import { test } from 'node:test';
import assert from 'node:assert/strict';
import { expandMatrix, setPath } from '../lib/matrix.mjs';

test('setPath creates intermediate objects/arrays and indexes numerically', () => {
    const root = {};
    setPath(root, 'aiSlots.0.profile', 'aggressive');
    assert.deepEqual(root, { aiSlots: [{ profile: 'aggressive' }] });

    setPath(root, 'aiSlots.1.team', 1);
    assert.equal(root.aiSlots[1].team, 1);
    assert.equal(root.aiSlots.length, 2);
});

// PLAN-headless.md §6 "Meta" requirement, verbatim: "the batch driver run on
// a 2x2x2 matrix produces 8 rows with distinct seeds."
test('2x2x2 matrix expands to 8 rows with distinct seeds', () => {
    const template = { map: '', game: 'papertanks', aiSlots: [{ aiId: 'basic_ai', team: 0 }] };
    const spec = {
        axes: [
            { path: 'aiSlots.0.profile', values: ['aggressive', 'default'] },
            { path: 'map', values: ['green_flat_x34_v3', 'pools_of_ilys_1.0.0'] },
            { path: 'seed', values: [1, 2] },
        ],
    };

    const rows = expandMatrix(spec, template);

    assert.equal(rows.length, 8);

    const seeds = rows.map(r => r.params.seed);
    assert.equal(new Set(seeds).size, 2, 'only 2 distinct seed values in the axis, but every row must carry one');
    assert.ok(seeds.every(s => s === 1 || s === 2));

    // Every row's full param combination must be unique (no duplicate rows).
    const combos = rows.map(r => JSON.stringify(r.params));
    assert.equal(new Set(combos).size, 8, 'all 8 rows must be distinct combinations');

    // Config overrides actually landed on the patched clone, not just `params`.
    for (const row of rows) {
        assert.equal(row.config.map, row.params.map);
        assert.equal(row.config.aiSlots[0].profile, row.params['aiSlots.0.profile']);
        assert.equal(row.config.seed, row.params.seed);
    }

    // The template itself must be untouched (each row gets its own clone).
    assert.equal(template.map, '');
});

test('no axes returns a single unmodified row', () => {
    const template = { map: 'x' };
    const rows = expandMatrix({ axes: [] }, template);
    assert.equal(rows.length, 1);
    assert.deepEqual(rows[0].params, {});
    assert.deepEqual(rows[0].config, template);
});
