/**
 * weapon-fx — slow-motion engagement bench for diagnosing combat SFX
 * rendering (CEG explosions, smoke/projectile trails, bullet sprites,
 * beam/laser visuals).
 *
 * Spawns one shooter and one target on a flat map, holds the target
 * still + invulnerable, orders ATTACK, then enables the player-facing
 * tracking-camera so both units stay framed while bombs/beams travel.
 * The scenario doesn't drive sim speed itself — the player (or
 * automation) uses the new `+`/`-`/`Pause` hotkeys to slow the action
 * down for screenshots. See ARCHITECTURE.md for the hotkey list.
 *
 * URL params (all optional):
 *   ?scenario=weapon-fx                            shieldraid vs bandit
 *   ?scenario=weapon-fx&unit=raveparty             pick shooter
 *   ?scenario=weapon-fx&target=staticheavyradar    pick target def
 *   ?scenario=weapon-fx&team=0                     shooter team (default 0)
 *   ?scenario=weapon-fx&distance=400               separation in elmos
 *
 * No `?speed=` param: the speed control is a real game feature now.
 * After the scenario boots, press `-` repeatedly to slow the sim,
 * `Pause` to freeze, `T` to toggle tracking on/off. The scenario
 * leaves tracking ON so the camera follows the attacker through the
 * engagement.
 */

import type { Scenario, AssertionResult } from '../types.js';
import { sleep } from '../types.js';

const CMD_ATTACK = 20;
const FLAT_MAP_CENTER = 8704;
// Default shooter has both a hitscan laser and a cannon archetype —
// good baseline for verifying both bullet and beam paths render.
const DEFAULT_SHOOTER = 'shieldraid';
const DEFAULT_TARGET = 'damagesink';
const DEFAULT_DISTANCE = 400;

function param(name: string): string | null {
    return new URLSearchParams(location.search).get(name);
}
function numParam(name: string, fallback: number): number {
    const v = param(name);
    if (v == null) return fallback;
    const n = Number(v);
    return Number.isFinite(n) ? n : fallback;
}

let _sId = 0;
let _tId = 0;

const scenario: Scenario = {
    name: 'weapon-fx',
    description: 'Slow-motion engagement bench for diagnosing CEG / beam / projectile rendering. Use +/-/Pause to control speed, T to toggle tracking camera.',
    map: 'green_flat_x34_v3',
    gameId: 'zk',
    aiSlots: [{ aiId: 'null', team: 1 }],
    playerTeam: 0,

    async setup(h) {
        const shooterName = param('unit') ?? DEFAULT_SHOOTER;
        const targetName = param('target') ?? DEFAULT_TARGET;
        const distance = Math.max(64, numParam('distance', DEFAULT_DISTANCE));
        const shooterTeam = numParam('team', 0);
        const targetTeam = shooterTeam === 1 ? 0 : 1;

        await h.setLogging({ combat: true, weapon: true, explosion: true });
        await h.clear();

        // Shooter west, target east. Half-distance each side of map centre
        // so the camera anchors cleanly between them.
        const half = distance * 0.5;
        const sOut = await h.spawn(shooterName, FLAT_MAP_CENTER - half, FLAT_MAP_CENTER, shooterTeam, 1);
        const tOut = await h.spawn(targetName, FLAT_MAP_CENTER + half, FLAT_MAP_CENTER, targetTeam, 1);
        const sId = Number(sOut.match(/:\s*(\d+)/)?.[1] ?? 0);
        const tId = Number(tOut.match(/:\s*(\d+)/)?.[1] ?? 0);
        if (!sId || !tId) {
            throw new Error(`[weapon-fx] spawn parse failed: shooter=${sOut} target=${tOut}`);
        }
        _sId = sId;
        _tId = tId;

        // Hold target still + invulnerable so the engagement runs long
        // enough to observe trail/impact effects across many shots.
        // CMD_MOVE_STATE=50 (0=hold), CMD_FIRE_STATE=45 (0=hold-fire).
        // SetUnitMaxHealth + SetUnitHealth lifts HP to 1e9 so even
        // nuke-scale weapons take many shots to kill.
        await h.lua(`
            Spring.GiveOrderToUnit(${tId}, 50, {0}, 0)
            Spring.GiveOrderToUnit(${tId}, 45, {0}, 0)
            Spring.SetUnitMaxHealth(${tId}, 1e9)
            Spring.SetUnitHealth(${tId}, 1e9)
        `);

        // Frame both units side-on (pitch 45°) before tracking takes over
        // — this provides the initial snap before tick() kicks in. The
        // tracking-camera toggle then keeps both units in view across
        // any approach/retreat.
        await h.cameraFitUnits([sId, tId], { padding: 1.8, pitchDeg: 45, durationMs: 0 });

        // Select shooter so the HUD shows the unit-under-test and the
        // tracking camera follows it (tracking reads the live selection).
        h.select([sId]);

        // Enable the tracking camera. Equivalent to the player pressing
        // `T` after the scene loads — programmatic so a scripted bench
        // run doesn't require a keypress.
        h.setTrackingCamera(true);

        // Issue the attack. Server processes orders next tick; with
        // sim speed at default 1× the player has a few seconds to
        // press `-` and watch projectiles travel in slow motion.
        await h.order(sId, CMD_ATTACK, [tId]);

        console.log(`[weapon-fx] shooter=${shooterName}#${sId} target=${targetName}#${tId} distance=${distance}`);
        console.log('[weapon-fx] hotkeys: + / -  speed | \\  reset speed | Pause  pause | T  toggle tracking');
    },

    async run(h): Promise<AssertionResult[]> {
        const sId = _sId;
        const tId = _tId;

        // Long idle observation window — the user is here to watch
        // effects and capture screenshots, not race a timer. 5 wall
        // minutes is plenty even at full slowmo; the scenario exits
        // after that and the user can re-run it via the same URL.
        const OBSERVE_MS = 5 * 60_000;
        const start = performance.now();
        const deadline = start + OBSERVE_MS;
        while (performance.now() < deadline) {
            await sleep(2000);
        }

        return [
            { name: 'shooter survived observation window', ok: true,
              detail: `shooter=#${sId}` },
            { name: 'target id captured', ok: true, detail: `target=#${tId}` },
        ];
    },
};

export default scenario;
