import { describe, expect, it } from 'vitest';
import {
    AvailableScenarioInfo, defaultScenarioFor, parseScenarioList,
    resolveScenarioLabel, scenarioNote, scenarioOptionLabel, scenariosForMap,
} from './scenario-picker.js';

// The Create Game dialog's War row.
//
// THE REQUIREMENT THESE PIN DOWN: a procedurally generated war
// (tools/mapgen/scenariogen.py → the `generated_scenarios` table →
// `scenarios/gen_<id>.lua`) must be selectable in the picker exactly like a
// shipped one. The server makes that true by materialising rows into the
// directory ScenarioDiscovery scans before it scans it, so by the time the list
// reaches this module there is no distinction left to draw — and these tests
// assert precisely that: nothing here branches on the `gen_` prefix.

/// The shape `GET /api/games/metalstorm/scenarios` returns once a scenario has
/// been generated and stored: one authored war, one generated one, on the same
/// map. Field-for-field what lobby_main.cpp emits.
const API_RESPONSE = [
    {
        id: 'meridian_basin',
        displayName: 'Meridian Basin — Standard War',
        map: 'meridian_basin',
        tutorial: false,
        terminal: true,
        sides: [{ faction: 'compact', team: 0, staged: true }],
    },
    {
        id: 'gen_scorched_crossing_9jye',
        displayName: 'Ashen Reach — Standard War',
        map: 'scorched_crossing',
        tutorial: false,
        terminal: true,
        sides: [
            { faction: 'compact', team: 0, staged: true },
            { faction: 'union', team: 1, staged: true },
        ],
    },
    {
        id: 'tutorial_01',
        displayName: 'First Orders',
        map: 'scorched_crossing',
        tutorial: true,
        terminal: false,
        sides: [],
    },
];

function info(over: Partial<AvailableScenarioInfo>): AvailableScenarioInfo {
    return {
        id: 'gen_x_aaaa', displayName: 'A War', map: 'basin',
        tutorial: false, terminal: true, ...over,
    };
}

describe('parseScenarioList', () => {
    it('reads a DB-backed scenario out of the endpoint response', () => {
        const list = parseScenarioList(API_RESPONSE);
        expect(list).toHaveLength(3);

        const gen = list.find(s => s.id === 'gen_scorched_crossing_9jye');
        expect(gen).toEqual({
            id: 'gen_scorched_crossing_9jye',
            displayName: 'Ashen Reach — Standard War',
            map: 'scorched_crossing',
            tutorial: false,
            terminal: true,
        });
    });

    it('treats generated and shipped entries identically', () => {
        // Same fields, same parsing. If this ever needed a branch on the id,
        // the server-side design (materialise, then discover) would have
        // broken and generated wars would have become a second content path.
        const [shipped, generated] = parseScenarioList([
            API_RESPONSE[0], API_RESPONSE[1],
        ]);
        expect(Object.keys(shipped).sort()).toEqual(Object.keys(generated).sort());
    });

    it('survives a malformed or absent list rather than dropping the row', () => {
        expect(parseScenarioList(undefined)).toEqual([]);
        expect(parseScenarioList(null)).toEqual([]);
        expect(parseScenarioList({})).toEqual([]);
        expect(parseScenarioList([null, 3, 'x'])).toEqual([]);
        // An entry with no id is unusable as a modoption value — dropped.
        expect(parseScenarioList([{ displayName: 'nameless' }])).toEqual([]);
    });

    it('falls back to the id when the display name is missing', () => {
        expect(parseScenarioList([{ id: 'gen_a_bbbb' }])[0].displayName)
            .toBe('gen_a_bbbb');
    });

    it('defaults a malformed terminal flag to false, not true', () => {
        // The safe direction: a false negative shows a "no ending" warning,
        // a false positive promises an ending that is not there.
        expect(parseScenarioList([{ id: 'gen_a_bbbb' }])[0].terminal).toBe(false);
    });
});

describe('scenariosForMap', () => {
    const list = parseScenarioList(API_RESPONSE);

    it('offers a generated scenario for its own map', () => {
        const offerable = scenariosForMap(list, 'scorched_crossing');
        expect(offerable.map(s => s.id)).toEqual(['gen_scorched_crossing_9jye']);
    });

    it('does not offer it for a different map', () => {
        // A scenario's region keys only make sense against its own map's
        // region graph; a cross-map pairing would stage a broken war.
        expect(scenariosForMap(list, 'meridian_basin').map(s => s.id))
            .toEqual(['meridian_basin']);
    });

    it('excludes tutorials even on the matching map', () => {
        expect(scenariosForMap(list, 'scorched_crossing')
            .some(s => s.id === 'tutorial_01')).toBe(false);
    });

    it('offers nothing when no map is selected', () => {
        expect(scenariosForMap(list, '')).toEqual([]);
    });
});

describe('defaultScenarioFor', () => {
    it('picks a generated terminal scenario, same as a shipped one', () => {
        const offerable = scenariosForMap(parseScenarioList(API_RESPONSE),
                                          'scorched_crossing');
        expect(defaultScenarioFor(offerable)?.id)
            .toBe('gen_scorched_crossing_9jye');
    });

    it('never defaults to a non-terminal scenario', () => {
        // Mirrors ScenarioDiscovery::DefaultForMap rule 3. A war with no
        // `victory = true` objective cannot end, and auto-applying one would
        // stage units and objectives the host never asked for while leaving
        // the war just as endless. It stays explicitly selectable.
        const endless = [info({ id: 'gen_a_aaaa', terminal: false })];
        expect(defaultScenarioFor(endless)).toBeNull();
    });

    it('prefers a terminal scenario over a non-terminal one', () => {
        expect(defaultScenarioFor([
            info({ id: 'gen_a_aaaa', terminal: false }),
            info({ id: 'gen_b_bbbb', terminal: true }),
        ])?.id).toBe('gen_b_bbbb');
    });

    it('breaks ties on the lowest id, as the server does', () => {
        // Deterministic, so the option the client labels "(default for this
        // map)" is the one the server actually applies when `scenario` is
        // omitted from the create request.
        expect(defaultScenarioFor([
            info({ id: 'gen_z_zzzz' }),
            info({ id: 'gen_a_aaaa' }),
            info({ id: 'meridian_basin' }),
        ])?.id).toBe('gen_a_aaaa');
    });

    it('is null for an empty list', () => {
        expect(defaultScenarioFor([])).toBeNull();
    });
});

describe('scenarioOptionLabel', () => {
    it('shows a generated war under its minted name, unadorned', () => {
        expect(scenarioOptionLabel(info({
            id: 'gen_scorched_crossing_9jye',
            displayName: 'Ashen Reach — Standard War',
            terminal: true,
        }))).toBe('Ashen Reach — Standard War');
    });

    it('marks a war that cannot end', () => {
        expect(scenarioOptionLabel(info({
            displayName: 'Endless Skirmish', terminal: false,
        }))).toBe('Endless Skirmish — no ending');
    });
});

describe('scenarioNote', () => {
    it('promises an ending for a terminal war', () => {
        const n = scenarioNote(info({ terminal: true }));
        expect(n.className).toBe('scenario-note');
        expect(n.text).toMatch(/victory objective is completed/);
    });

    it('warns for a non-terminal war', () => {
        const n = scenarioNote(info({ terminal: false }));
        expect(n.className).toBe('scenario-note endless');
        expect(n.text).toMatch(/no ending/);
    });

    it('warns when no war will be staged at all', () => {
        const n = scenarioNote(null);
        expect(n.className).toBe('scenario-note endless');
        expect(n.text).toMatch(/No war will be staged/);
    });
});

describe('resolveScenarioLabel', () => {
    const list = parseScenarioList(API_RESPONSE);

    it('resolves a generated id to its name on the room screen', () => {
        // Without this the room screen shows a raw `gen_<map>_<hash>` where
        // every other room shows a name.
        expect(resolveScenarioLabel(list, 'gen_scorched_crossing_9jye'))
            .toEqual({
                label: 'Ashen Reach — Standard War',
                known: true,
                terminal: true,
            });
    });

    it('resolves a shipped id the same way', () => {
        expect(resolveScenarioLabel(list, 'meridian_basin').label)
            .toBe('Meridian Basin — Standard War');
    });

    it('reports an unknown id as unknown rather than as endless', () => {
        // An id absent from the list means we have no list — the fetch failed,
        // or it is for another game — not that the war has no ending.
        const r = resolveScenarioLabel(list, 'gen_deleted_zzzz');
        expect(r.known).toBe(false);
        expect(r.label).toBe('gen_deleted_zzzz');
        expect(r.terminal).toBe(false);
    });
});
