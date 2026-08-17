import { describe, it, expect } from 'vitest';
import {
    buildPlayManifest, derivePlaySlots, parsePlayParams, pickAttachIdentity,
    isAttachableRoom, playRoomName, DEFAULT_PLAY_AI,
    type ScenarioInfo,
} from './play-boot';

const CROSSING: ScenarioInfo = {
    id: 'crossing_standoff',
    displayName: 'Scorched Crossing — The Standoff',
    map: 'scorched_crossing_v2.4',
    sides: [
        { faction: 'compact', team: 0, staged: true },
        { faction: 'union', team: 1, staged: true },
    ],
    terminal: true,
};

const SIDELESS: ScenarioInfo = {
    id: 'scenario_smoke_test', map: 'green_flat_x34_v3', sides: [],
};

describe('parsePlayParams', () => {
    it('returns null without ?play=', () => {
        expect(parsePlayParams('?direct=foo.json', '')).toBeNull();
    });

    it('parses the MCP attach URL, token from the hash', () => {
        const p = parsePlayParams(
            '?play=crossing_standoff&game=metalstorm&room=12&user=admin&skipBriefing=1',
            '#token=abc%3Adef')!;
        expect(p).toMatchObject({
            scenarioId: 'crossing_standoff', gameId: 'metalstorm',
            room: 12, user: 'admin', token: 'abc:def', skipBriefing: true,
        });
    });

    it('defaults game to metalstorm and leaves attach fields undefined', () => {
        const p = parsePlayParams('?play=tutorial_01', '')!;
        expect(p.gameId).toBe('metalstorm');
        expect(p.room).toBeUndefined();
        expect(p.token).toBeUndefined();
        expect(p.skipBriefing).toBe(false);
    });

    it('distinguishes &ai= (empty, meaning no AI) from an absent ai', () => {
        expect(parsePlayParams('?play=x&ai=', '')!.ai).toBe('');
        expect(parsePlayParams('?play=x', '')!.ai).toBeUndefined();
    });
});

describe('derivePlaySlots', () => {
    it('seats the host on the first side and AIs everyone else', () => {
        expect(derivePlaySlots(CROSSING.sides)).toEqual({
            hostTeam: 0, aiSlots: [{ aiId: 'strategos', team: 1 }],
        });
    });

    it('honours a side override, moving the AI to the other side', () => {
        expect(derivePlaySlots(CROSSING.sides, 'union')).toEqual({
            hostTeam: 1, aiSlots: [{ aiId: 'strategos', team: 0 }],
        });
    });

    it('throws with the valid faction list on an unknown side', () => {
        expect(() => derivePlaySlots(CROSSING.sides, 'martians'))
            .toThrow(/Valid: compact, union/);
    });

    it('ai:"" yields no AI slots', () => {
        expect(derivePlaySlots(CROSSING.sides, undefined, '').aiSlots).toEqual([]);
    });

    it('falls back to the legacy two-team shape for a sideless scenario', () => {
        expect(derivePlaySlots([], undefined, 'null')).toEqual({
            hostTeam: 0, aiSlots: [{ aiId: 'null', team: 1 }],
        });
        expect(derivePlaySlots([], undefined, '').aiSlots).toEqual([]);
    });
});

describe('buildPlayManifest', () => {
    it('puts the scenario at the TOP LEVEL, never in modoptions', () => {
        const m = buildPlayManifest(CROSSING, 'guest-4711',
            parsePlayParams('?play=crossing_standoff', '')!);
        expect(m.scenario).toBe('crossing_standoff');
        expect(m.modoptions).not.toHaveProperty('scenario');
    });

    it('scopes the room name per scenario and per user', () => {
        const m = buildPlayManifest(CROSSING, 'guest-4711',
            parsePlayParams('?play=crossing_standoff', '')!);
        expect(m.name).toBe('play:crossing_standoff:guest-4711');
        expect(playRoomName('a', 'b')).toBe('play:a:b');
    });

    it('defaults the browser AI to strategos and honours &ai=null', () => {
        const dflt = buildPlayManifest(CROSSING, 'u', parsePlayParams('?play=crossing_standoff', '')!);
        expect(dflt.aiSlots).toEqual([{ aiId: DEFAULT_PLAY_AI, team: 1 }]);
        const nul = buildPlayManifest(CROSSING, 'u', parsePlayParams('?play=crossing_standoff&ai=null', '')!);
        expect(nul.aiSlots).toEqual([{ aiId: 'null', team: 1 }]);
    });

    it('&map= overrides the scenario map; a scenario with neither is an error', () => {
        const m = buildPlayManifest(CROSSING, 'u', parsePlayParams('?play=crossing_standoff&map=green_flat_x34_v3', '')!);
        expect(m.map).toBe('green_flat_x34_v3');
        expect(() => buildPlayManifest({ id: 'x' }, 'u', parsePlayParams('?play=x', '')!))
            .toThrow(/declares no map/);
    });

    it('builds the sideless legacy shape', () => {
        const m = buildPlayManifest(SIDELESS, 'u', parsePlayParams('?play=scenario_smoke_test&ai=null', '')!);
        expect(m.players).toEqual([{ username: 'u', team: 0 }]);
        expect(m.aiSlots).toEqual([{ aiId: 'null', team: 1 }]);
    });
});

// Parity fixture — the same inputs must produce the same manifest here and in
// `tools/debug-mcp/scenario-manifest.js`'s buildScenarioManifest (minus the
// deliberate differences: room-name convention and the default AI). The two
// derivations are duplicated across the Node and browser build worlds; this
// fixture is what stops them from drifting. Update both files together.
describe('MCP parity fixture', () => {
    it('matches tools/debug-mcp/scenario-manifest.js for crossing_standoff', () => {
        const m = buildPlayManifest(CROSSING, 'admin',
            parsePlayParams('?play=crossing_standoff&game=metalstorm&ai=null', '')!);
        expect(m).toEqual({
            name: 'play:crossing_standoff:admin',
            game: 'metalstorm',
            map: 'scorched_crossing_v2.4',
            scenario: 'crossing_standoff',
            players: [{ username: 'admin', team: 0 }],
            aiSlots: [{ aiId: 'null', team: 1 }],
            modoptions: {},
            autoStart: true,
        });
    });

    it('matches for a side=union override', () => {
        const m = buildPlayManifest(CROSSING, 'admin',
            parsePlayParams('?play=crossing_standoff&side=union&ai=null', '')!);
        expect(m.players).toEqual([{ username: 'admin', team: 1 }]);
        expect(m.aiSlots).toEqual([{ aiId: 'null', team: 0 }]);
    });
});

describe('pickAttachIdentity / isAttachableRoom', () => {
    const room = { id: 12, state: 4, players: [{ username: 'admin', player_id: 42 }] };

    it('finds our player row', () => {
        expect(pickAttachIdentity(room, 'admin')).toEqual({ playerId: 42 });
    });

    it('misses cleanly for another user or a shapeless room', () => {
        expect(pickAttachIdentity(room, 'someone-else')).toBeNull();
        expect(pickAttachIdentity({}, 'admin')).toBeNull();
        expect(pickAttachIdentity(null, 'admin')).toBeNull();
    });

    it('refuses to attach to an Ended room (state 5)', () => {
        expect(isAttachableRoom(room)).toBe(true);
        expect(isAttachableRoom({ ...room, state: 5 })).toBe(false);
        expect(isAttachableRoom(undefined)).toBe(false);
    });
});
