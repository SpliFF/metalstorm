import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkFixtureNonVacuous, peakTeamSum, DEFAULT_REQUIREMENTS } from '../lib/fixture-checks.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.join(HERE, '..', 'fixtures');

function snapshot(frame, teams) {
    return { frame, stateHash: '0000000000000000', teams };
}

// The exact shape of the bug this module exists to catch: 30 snapshots that
// agree perfectly between two runs, describing nothing.
test('the empty-world dump that shipped as a green gate is rejected', () => {
    const dump = {
        status: 'frame-limit',
        frame: 9000,
        snapshots: Array.from({ length: 30 }, (_, i) =>
            snapshot((i + 1) * 300, [
                { teamId: 0, numUnits: 0, damageDealt: 0, unitsDied: 0 },
                { teamId: 1, numUnits: 0, damageDealt: 0, unitsDied: 0 },
            ])),
    };

    const r = checkFixtureNonVacuous(dump);
    assert.equal(r.ok, false);
    assert.equal(r.measured.snapshots, 30);
    assert.equal(r.measured.units, 0);
    assert.equal(r.problems.length, 3, 'units, damage and deaths must each be named');
    assert.ok(r.problems.some(p => p.includes('EMPTY unit list')));
});

test('a run with units and combat but no deaths still fails', () => {
    const dump = {
        snapshots: [
            snapshot(300, [{ teamId: 0, numUnits: 12, damageDealt: 400, unitsDied: 0 }]),
            snapshot(600, [{ teamId: 0, numUnits: 12, damageDealt: 900, unitsDied: 0 }]),
        ],
    };
    const r = checkFixtureNonVacuous(dump);
    assert.equal(r.ok, false);
    assert.equal(r.problems.length, 1);
    assert.ok(r.problems[0].includes('unit-removal path is untested'));
});

test('a real skirmish dump passes', () => {
    const dump = {
        snapshots: [
            snapshot(300, [
                { teamId: 0, numUnits: 12, damageDealt: 0, unitsDied: 0 },
                { teamId: 1, numUnits: 12, damageDealt: 0, unitsDied: 0 },
            ]),
            snapshot(3000, [
                { teamId: 0, numUnits: 7, damageDealt: 5400, unitsDied: 5 },
                { teamId: 1, numUnits: 9, damageDealt: 4100, unitsDied: 3 },
            ]),
        ],
    };
    const r = checkFixtureNonVacuous(dump);
    assert.deepEqual(r.problems, []);
    assert.equal(r.ok, true);
    // Peak, not final: both teams were at 12 in the first snapshot.
    assert.equal(r.measured.units, 24);
    assert.equal(r.measured.deaths, 8);
});

test('peak is taken over the run, not read off the last snapshot', () => {
    const dump = {
        snapshots: [
            snapshot(300, [{ numUnits: 24, damageDealt: 0, unitsDied: 0 }]),
            snapshot(600, [{ numUnits: 0, damageDealt: 9999, unitsDied: 24 }]),
        ],
    };
    // A mutual annihilation ends at numUnits 0 and is the MOST exercised run,
    // not the least — reading the final snapshot would reject it.
    assert.equal(peakTeamSum(dump, 'numUnits'), 24);
    assert.equal(checkFixtureNonVacuous(dump).ok, true);
});

test('a malformed or empty dump is a loud failure, never a throw', () => {
    for (const bad of [undefined, null, {}, { snapshots: [] }, { snapshots: [{}] }]) {
        const r = checkFixtureNonVacuous(bad);
        assert.equal(r.ok, false);
        assert.ok(r.problems.length > 0);
    }
});

// The gate is only as good as the fixture it points at: assert the committed
// fixture actually asks the game to stage an army. Without this the next edit
// that drops `modOptions` restores the empty-world hole silently.
test('the committed determinism fixture asks for a start army', async () => {
    const cfg = JSON.parse(await readFile(path.join(FIXTURES, 'papertanks-determinism.json'), 'utf8'));
    assert.equal(cfg.modOptions?.startunits, 'skirmish',
        'papertanks-determinism.json must set modOptions.startunits or its state hash folds an empty unit list (PLAN-replay T2-c)');
    assert.ok((cfg.headless?.stateHashEvery ?? 0) > 0, 'no hash cadence means no determinism track');
    assert.ok(cfg.aiSlots?.length >= 2, 'a one-sided fixture cannot produce combat');
    assert.deepEqual(Object.keys(DEFAULT_REQUIREMENTS).sort(), ['damage', 'deaths', 'units']);
});
