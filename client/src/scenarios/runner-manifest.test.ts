// @vitest-environment happy-dom
/**
 * The `/api/rooms/direct` manifest ScenarioRunner.startDirect() builds (S4.2).
 *
 * WHY THIS EXISTS. Two things about the `scenario` field are invisible until a
 * war boots wrong, and both are one character away from each other:
 *
 *  - it must be TOP-LEVEL. `modoptions.scenario` alone is overwritten by the
 *    map's own default in the lobby's chooseScenario, so a manifest that spells
 *    it only as a modoption boots the map's default scenario and looks, from
 *    the client, exactly like a scenario that did nothing;
 *  - `undefined` (omit the key → map default) and `''` (explicitly no scenario)
 *    are DIFFERENT launches. A truthiness spread collapses the second into the
 *    first, which is a scenario silently gaining content it asked not to have.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { ScenarioRunner } from './runner.js';
import type { Scenario } from './types.js';

const baseScenario = (over: Partial<Scenario> = {}): Scenario => ({
    name: 'manifest-probe',
    description: 'manifest shape only — never actually launched here',
    map: 'meridian_basin',
    gameId: 'metalstorm',
    aiSlots: [{ aiId: 'NullAI', team: 1 }],
    setup: async () => {},
    ...over,
});

/** Drive startDirect() with fetch stubbed, and return the POSTed manifest. */
async function manifestFor(scenario: Scenario): Promise<any> {
    let body: any = null;
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init: any) => {
        body = JSON.parse(init.body);
        return {
            ok: true,
            json: async () => ({
                id: 7,
                sessions: { test1: 'tok' },
                players: [{ username: 'test1', player_id: 3 }],
            }),
        };
    }));
    const lobby = { attachSession: vi.fn(), setCurrentRoomFromJson: vi.fn() };
    const runner = new ScenarioRunner(scenario, lobby as any, () => null);
    await (runner as any).startDirect();
    return body;
}

describe('startDirect manifest', () => {
    beforeEach(() => vi.unstubAllGlobals());
    afterEach(() => vi.unstubAllGlobals());

    it('omits `scenario` entirely when the scenario does not name one', async () => {
        const m = await manifestFor(baseScenario());
        expect('scenario' in m).toBe(false);
        expect('modoptions' in m).toBe(false);
    });

    it('sends `scenario` at the TOP LEVEL, not inside modoptions', async () => {
        const m = await manifestFor(baseScenario({ scenario: 'crossing_standoff' }));
        expect(m.scenario).toBe('crossing_standoff');
        expect(m.modoptions?.scenario).toBeUndefined();
    });

    it('sends an empty `scenario` rather than dropping it (explicitly none)', async () => {
        const m = await manifestFor(baseScenario({ scenario: '' }));
        expect('scenario' in m).toBe(true);
        expect(m.scenario).toBe('');
    });

    it('passes modoptions through untouched', async () => {
        const m = await manifestFor(baseScenario({ modoptions: { startmetal: '5000' } }));
        expect(m.modoptions).toEqual({ startmetal: '5000' });
    });

    it('still carries the fields the direct pipeline already relied on', async () => {
        const m = await manifestFor(baseScenario({ playerTeam: 2, playerStartPos: 1 }));
        expect(m.map).toBe('meridian_basin');
        expect(m.game).toBe('metalstorm');
        expect(m.autoStart).toBe(true);
        expect(m.aiSlots).toEqual([{ aiId: 'NullAI', team: 1 }]);
        expect(m.players[0]).toMatchObject({ username: 'test1', team: 2, startPos: 1 });
    });
});
