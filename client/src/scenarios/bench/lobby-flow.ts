/**
 * lobby-flow — regression coverage for the legacy end-to-end lobby walk.
 *
 * PLAN-quickstart.md Part A made the direct-start pipeline
 * (`/api/rooms/direct`) the runner's default; the original login →
 * leaveAllRooms → createRoom → addAISlots → setPlayerSlot → ready →
 * startGame dance still exists (behind `?via=lobby`) but is no longer
 * exercised by every scenario run. This scenario earmarks that legacy
 * path a dedicated regression entry point — run deliberately with
 * `?scenario=lobby-flow&via=lobby`, not on the fast path.
 *
 * Assertions are deliberately minimal (spawn one unit, confirm it
 * exists): the point is proving the *lobby* dance reaches a booted,
 * controllable game, not exercising combat.
 */

import type { Scenario } from '../types.js';

const FLAT_MAP_CENTER = 8704; // green_flat_x34_v3 is 17408×17408 elmos

let _unitId = 0;

const scenario: Scenario = {
    name: 'lobby-flow',
    description: 'Regression coverage for the legacy end-to-end lobby dance (run with &via=lobby).',
    map: 'green_flat_x34_v3',
    gameId: 'zk',
    aiSlots: [{ aiId: 'null', team: 1 }],
    playerTeam: 0,
    async setup(h) {
        await h.clear();
        const out = await h.spawn('shieldraid', FLAT_MAP_CENTER, FLAT_MAP_CENTER, 0, 1);
        const id = Number(out.match(/:\s*(\d+)/)?.[1] ?? 0);
        if (!id) throw new Error(`spawn parse failed: ${out}`);
        _unitId = id;
    },
    async run(h) {
        const state = await h.unitState(_unitId);
        return [
            {
                name: 'unit exists after lobby-walk boot',
                ok: /id=\d+/.test(state),
                detail: state.split('\n')[0],
            },
        ];
    },
};

export default scenario;
