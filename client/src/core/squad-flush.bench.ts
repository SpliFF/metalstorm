// squad-flush.bench.ts — S5's acceptance rung, as far as a headless machine can
// take it. `npx vitest bench src/core/squad-flush.bench.ts`; NOT part of the gate
// (vitest's benchmark include is `*.bench.ts`, which `vitest run` does not pick
// up) — a perf assertion in a unit suite goes red on a loaded machine and then
// gets muted, which is worse than no assertion.
//
// ⚠ WHAT THIS DOES NOT MEASURE. The acceptance in §14 S5 is the `flushMs`
// counter at the 5 000-member rung in the BROWSER. Under NullEngine there is no
// GL: `thinInstancePartialBufferUpdate` reaches a buffer with no GPU behind it,
// so the bytes saved by a dirty range cost nothing here and the upload arms
// converge. What IS real here is the CPU half S5 rewrote — the per-member matrix
// compose, the sprite billboard recompose, and the per-member `updateMember`
// call the direct path removes. Read this as the CPU-side arm of the acceptance,
// with the GPU-side arm still owed a quiet machine and a browser.

import { bench, describe } from 'vitest';
import { NullEngine, Scene, FreeCamera, Vector3, Color3 } from '@babylonjs/core';
import { SquadRenderBackend, setLegacyFullUpload } from './squad-render-backend.js';
import type { ImpostorAtlas } from './impostor-renderer.js';
// eslint-disable-next-line import/no-relative-packages
import { SquadManager } from '../../../data/games/metalstorm/client/squads/squad-manager.js';
import {
    createSchedule, scheduleReset, schedulePush, stepMembers, STEP_FULL, STEP_COAST,
// eslint-disable-next-line import/no-relative-packages
} from '../../../data/games/metalstorm/client/squads/soa-kernel.js';

const ATLAS: ImpostorAtlas = {
    diffuseUri: '', walkFrames: 1, idleFrames: 1, width: 12, height: 12,
};

const SQUADS = 200;
const SIZE = 25;          // 200 × 25 = 5 000 members, §0c's rung

const DEF = {
    defId: 7, squadSize: SIZE, formationType: 'blob', formationRadius: 24,
    maxSpeed: 30, customParams: {},
};

function stack(hideDirect: boolean, squads = SQUADS, engineKind = 'soa') {
    const engine = new NullEngine();
    const scene = new Scene(engine);
    scene.activeCamera = new FreeCamera('cam', new Vector3(0, 800, -800), scene);
    const real = new SquadRenderBackend(scene, {
        getGroundHeight: () => 0,
        getTeamColor: () => new Color3(1, 0, 0),
        getImpostorAtlas: () => ATLAS,
    });
    let backend: SquadRenderBackend = real;
    if (hideDirect) {
        const proxy = Object.create(real) as Record<string, unknown>;
        for (const k of ['acquireSlot', 'getPoolView', 'markDirty', 'slotPoolId', 'slotIndex']) {
            proxy[k] = undefined;
        }
        proxy.poolGeneration = undefined;
        for (const k of ['createMember', 'updateMember', 'destroyMember', 'releaseMember',
            'spawnWreck', 'despawnWreck', 'fadeWreck', 'groundHeight', 'isOnScreen',
            'setSquadTeam', 'flush']) {
            const fn = (real as unknown as Record<string, unknown>)[k];
            proxy[k] = (fn as (...a: unknown[]) => unknown).bind(real);
        }
        backend = proxy as unknown as SquadRenderBackend;
    }
    const mgr = new SquadManager(backend, { engine: engineKind });
    const cols = Math.ceil(Math.sqrt(squads));
    for (let i = 0; i < squads; i++) {
        mgr.syncSquad(i + 1, {
            x: (i % cols) * 140, y: 0, z: Math.floor(i / cols) * 140,
            heading: 0, health: 100, maxHealth: 100,
        }, DEF);
    }
    let f = 0;
    const frame = (): void => {
        f++;
        for (let i = 0; i < squads; i++) {
            mgr.syncPose(i + 1, {
                x: (i % cols) * 140 + f * 2, y: 0, z: Math.floor(i / cols) * 140, heading: 0.2,
            });
        }
        mgr.update(1 / 60);
        real.flush();
    };
    for (let w = 0; w < 30; w++) frame();       // warm the JIT on this shape
    return { frame, real, mgr };
}

describe('5 000 members: whole frame (steer + write + flush)', () => {
    const direct = stack(false);
    const legacy = stack(true);
    bench('S5 direct pool writes', () => { direct.frame(); });
    bench('updateMember per member (pre-S5 write path)', () => { legacy.frame(); });
});

describe('5 000 members: 1 squad stepping, 199 coasting (the governor at scale)', () => {
    // The shape the dirty range exists for. Every squad stepping means every
    // member is rewritten, so the range IS the whole prefix and there is nothing
    // to save — which is itself the finding: the range pays where the governor
    // is time-slicing (§12d) or the tier is reduced, not in a flat-out frame.
    const s = stack(false);
    for (let i = 0; i < 5; i++) s.frame();
    const list = [...(s.mgr as unknown as { squads: Map<number, unknown> }).squads.values()];
    const store = (s.mgr as unknown as { store: unknown }).store;
    const schedule = scheduleReset(createSchedule(), list.length);
    for (let i = 0; i < list.length; i++) {
        schedulePush(schedule, i, i === 3 ? STEP_FULL : STEP_COAST, 1 / 60);
    }
    const oneFrame = (): void => {
        stepMembers(store, list, null, null, [], s.real, 1 / 60, 1, schedule);
        s.real.flush();
    };
    for (let i = 0; i < 30; i++) oneFrame();
    bench('S5 dirty range + still-camera billboard skip', () => { oneFrame(); });
    bench('whole-prefix upload + full re-billboard (legacy arm)', () => {
        setLegacyFullUpload(true);
        try { oneFrame(); } finally { setLegacyFullUpload(false); }
    });
});

describe('S4\'s acceptance rung, re-run against the REAL backend (OO vs SoA)', () => {
    // S4 measured its ⅓ gate with the backend STUBBED and missed, and filed the
    // reason as S5's: the per-member backend call-out and its matrix compose are
    // what the SoA engine was supposed to remove, and until S5 it did not. So the
    // arms that answer the gate are OO-with-a-real-backend against
    // SoA-with-a-real-backend. Two rungs each so the MARGINAL per-squad cost can
    // be differenced by hand (mean@200 − mean@100) / 100, which is what cancels
    // the fixed per-frame overhead.
    const ooLo = stack(false, 100, 'oo');
    const ooHi = stack(false, 200, 'oo');
    const soaLo = stack(false, 100, 'soa');
    const soaHi = stack(false, 200, 'soa');
    bench('OO  100 squads', () => { ooLo.frame(); });
    bench('OO  200 squads', () => { ooHi.frame(); });
    bench('SoA 100 squads', () => { soaLo.frame(); });
    bench('SoA 200 squads', () => { soaHi.frame(); });
});
