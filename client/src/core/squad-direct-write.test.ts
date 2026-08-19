// squad-direct-write.test.ts — milestone S5 (PLAN-metalstorm-squad-performance
// §13): the SoA kernel writes member transforms STRAIGHT into the backend's
// thin-instance buffers, the flush uploads only the range that was touched, and
// nothing lands in the W-row.
//
// This is the only suite that drives the REAL squad system (data/games/…/squads)
// against the REAL SquadRenderBackend. Both halves of S5 are seams between the
// two trees — a pool view handed out by the backend, written by the kernel — and
// a fake backend on one side of that seam can agree with a fake kernel on the
// other while the shipped pair disagrees. The decisive case here is therefore a
// MATCHED PAIR: identical scenario, once with the direct path available and once
// with it hidden (the `updateMember` path), asserting the drawn matrices are
// bit-identical. Two write paths for one picture is exactly the shape that
// drifts, so the test is what keeps them one picture.

import { describe, it, expect } from 'vitest';
import {
    NullEngine, Scene, FreeCamera, Vector3, Color3, Matrix, Quaternion,
} from '@babylonjs/core';
import {
    SquadRenderBackend, writeYawMatrix, setLegacyFullUpload,
} from './squad-render-backend.js';
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

/** A sprite-only def (atlas, no member model) — the pinnable population, and
 *  91 % of members at the XL battle. */
function makeStack(opts: { atlas?: boolean } = {}) {
    const engine = new NullEngine();
    const scene = new Scene(engine);
    scene.activeCamera = new FreeCamera('cam', new Vector3(0, 400, -400), scene);
    const backend = new SquadRenderBackend(scene, {
        getGroundHeight: () => 0,
        getTeamColor: () => new Color3(1, 0, 0),
        getImpostorAtlas: () => (opts.atlas === false ? undefined : ATLAS),
    });
    return { engine, scene, backend };
}

const DEF = {
    defId: 7, squadSize: 9, formationType: 'blob', formationRadius: 24,
    maxSpeed: 30, customParams: {},
};

/** The kernel's direct path is discovered by feature detection (`acquireSlot`),
 *  so hiding those four methods is how the matched control runs the same squads
 *  down the `updateMember` path — no flag, no second code path in the kernel. */
function hideDirectApi(backend: SquadRenderBackend): SquadRenderBackend {
    const proxy = Object.create(backend) as Record<string, unknown>;
    for (const k of ['acquireSlot', 'getPoolView', 'markDirty', 'slotPoolId', 'slotIndex']) {
        proxy[k] = undefined;
    }
    proxy.poolGeneration = undefined;
    // The methods the kernel DOES use must stay bound to the real backend.
    for (const k of ['createMember', 'updateMember', 'destroyMember', 'releaseMember',
        'spawnWreck', 'despawnWreck', 'fadeWreck', 'groundHeight', 'isOnScreen',
        'setSquadTeam', 'flush', 'setIcon', 'clearIcon']) {
        const fn = (backend as unknown as Record<string, unknown>)[k];
        if (typeof fn === 'function') proxy[k] = (fn as (...a: unknown[]) => unknown).bind(backend);
    }
    return proxy as unknown as SquadRenderBackend;
}

/** Run `frames` frames of one squad walking east and return the drawn matrices
 *  of every pool, flattened — i.e. the picture, not the bookkeeping. */
function runScenario(backend: SquadRenderBackend, frames: number): Float32Array {
    const mgr = new SquadManager(backend, { engine: 'soa' });
    mgr.syncSquad(1, { x: 0, y: 0, z: 0, heading: 0, health: 100, maxHealth: 100 }, DEF);
    for (let f = 1; f <= frames; f++) {
        mgr.syncPose(1, { x: f * 4, y: 0, z: 0, heading: 0.3 });
        mgr.update(1 / 60);
    }
    backend.flush();
    const out: number[] = [];
    for (const mesh of (backend as unknown as { scene: Scene }).scene.meshes) {
        if (!mesh.thinInstanceCount) continue;
        const data = (mesh as unknown as {
            _thinInstanceDataStorage: { matrixData: Float32Array };
        })._thinInstanceDataStorage.matrixData;
        for (let i = 0; i < mesh.thinInstanceCount * 16; i++) out.push(data[i]);
    }
    return new Float32Array(out);
}

describe('S5 §13b — the inline matrix write IS Babylon\'s compose', () => {
    it('agrees with Matrix.Compose(scale, RotationYawPitchRoll(yaw,0,0), t) float for float', () => {
        const mine = new Float32Array(16);
        const ref = Matrix.Identity();
        const q = new Quaternion();
        for (const h of [0, 0.3, 1.5707963, 2.9, -1.2, 6.28]) {
            for (const scale of [1, 0.25]) {
                writeYawMatrix(mine, 0, 12.5, -3.25, 900.75, h, scale);
                Quaternion.RotationYawPitchRollToRef(h, 0, 0, q);
                Matrix.ComposeToRef(
                    new Vector3(scale, scale, scale), q,
                    new Vector3(12.5, -3.25, 900.75), ref);
                const want = ref.m;
                for (let i = 0; i < 16; i++) {
                    expect(mine[i]).toBeCloseTo(want[i], 6);
                }
            }
        }
    });

    it('leaves the W-row clean — the shadow-only failure mode (docs/lighting.md)', () => {
        const mine = new Float32Array(16);
        writeYawMatrix(mine, 0, 7, 8, 9, 1.1, 1);
        expect([mine[3], mine[7], mine[11], mine[15]]).toEqual([0, 0, 0, 1]);
    });
});

describe('S5 §13a — the pinned-slot rule', () => {
    it('pins a sprite-only member (one reachable tier, one slot for life)', () => {
        const { backend } = makeStack();
        backend.setSquadTeam(1, 0);
        const h = backend.createMember(1, 0, { defId: 7, variant: 0 });
        const slot = backend.acquireSlot(h);
        expect(slot).not.toBeNull();
        expect(backend.slotPoolId(h)).toBe(slot!.poolId);
        expect(backend.slotIndex(h)).toBe(slot!.index);
        expect(backend.getPoolView(slot!.poolId)?.spritePos).toBeInstanceOf(Float32Array);
    });

    it('pins a capsule-only member (no atlas, no body)', () => {
        const { backend } = makeStack({ atlas: false });
        backend.setSquadTeam(1, 0);
        const h = backend.createMember(1, 0, { defId: 7, variant: 0 });
        const slot = backend.acquireSlot(h);
        expect(slot).not.toBeNull();
        // A capsule is centre-anchored, and the bias rides the view so a direct
        // writer cannot disagree with `updateMember` about where "on the ground"
        // is (9-elmo capsule → 4.5).
        expect(backend.getPoolView(slot!.poolId)?.yBias).toBeCloseTo(4.5, 6);
        expect(backend.getPoolView(slot!.poolId)?.spritePos).toBeUndefined();
    });

    it('REFUSES a member whose tier is re-decided from the camera each frame (M4/M5)', () => {
        const engine = new NullEngine();
        const scene = new Scene(engine);
        scene.activeCamera = new FreeCamera('cam', new Vector3(0, 40, 0), scene);
        const backend = new SquadRenderBackend(scene, {
            getGroundHeight: () => 0,
            getTeamColor: () => new Color3(1, 0, 0),
            getImpostorAtlas: () => ATLAS,
            // A def with BOTH an atlas and a body: model near, sprite far, both
            // mid-band — its pool changes with the camera, so its index cannot
            // be held by an outside writer.
            getMemberModel: () => undefined,
            getImpostorDistance: () => 500,
        });
        backend.setSquadTeam(1, 0);
        const h = backend.createMember(1, 0, { defId: 7, variant: 0 });
        expect(backend.acquireSlot(h)).toBeNull();
        expect(backend.slotPoolId(h)).toBe(-1);
    });
});

describe('S5 — the direct write and updateMember draw the same picture', () => {
    it('is bit-identical over 40 frames of a sprite-tier squad (matched pair)', () => {
        const direct = makeStack();
        const control = makeStack();
        const a = runScenario(direct.backend, 40);
        const b = runScenario(hideDirectApi(control.backend), 40);
        expect(a.length).toBeGreaterThan(9 * 16 - 1);
        expect(Array.from(a)).toEqual(Array.from(b));
    });

    it('is bit-identical for a CAPSULE squad too — the inline matrix write, end to end', () => {
        // The sprite arm above never exercises §13b: a sprite pool stores a pose
        // and the backend composes the card. A capsule member is the case where
        // the kernel writes the 16 floats itself, including the vertical bias.
        const a = runScenario(makeStack({ atlas: false }).backend, 40);
        const b = runScenario(hideDirectApi(makeStack({ atlas: false }).backend), 40);
        expect(a.length).toBe(9 * 16);
        expect(Array.from(a)).toEqual(Array.from(b));
        // …and it is drawn at the capsule's centre, not at the member's feet.
        expect(a[13]).toBeGreaterThan(4);
    });

    it('really took the direct path in the first arm (the control proves nothing on its own)', () => {
        const { backend } = makeStack();
        const mgr = new SquadManager(backend, { engine: 'soa' });
        let calls = 0;
        const real = backend.updateMember.bind(backend);
        backend.updateMember = (...args: Parameters<typeof real>): void => { calls++; real(...args); };
        mgr.syncSquad(1, { x: 0, y: 0, z: 0, heading: 0, health: 100, maxHealth: 100 }, DEF);
        for (let f = 1; f <= 10; f++) {
            mgr.syncPose(1, { x: f * 4, y: 0, z: 0, heading: 0 });
            mgr.update(1 / 60);
        }
        expect(calls).toBe(0);
        // …and the poses really landed in the pool the backend handed out.
        const store = (mgr as unknown as { store: { mDirectPool: Int32Array; mPoolIdx: Int32Array; mx: Float32Array } }).store;
        const view = backend.getPoolView(store.mDirectPool[0])!;
        expect(view.spritePos![0]).toBeCloseTo(store.mx[0], 4);
        expect(view.spriteAlive![store.mPoolIdx[0]]).toBe(1);
    });

    it('survives a pool compaction moving every slot (the generation re-read)', () => {
        const { backend } = makeStack();
        const mgr = new SquadManager(backend, { engine: 'soa' });
        // Enough squads that the sprite pool is well past the compaction gate
        // once half of them die.
        for (let id = 1; id <= 20; id++) {
            mgr.syncSquad(id, { x: id * 60, y: 0, z: 0, heading: 0, health: 100, maxHealth: 100 }, DEF);
        }
        mgr.update(1 / 60);
        backend.flush();
        const genBefore = backend.poolGeneration;
        for (let id = 1; id <= 20; id += 2) mgr.removeSquad(id);
        backend.flush();                       // compaction runs here
        expect(backend.poolGeneration).toBeGreaterThan(genBefore);

        for (let f = 1; f <= 5; f++) {
            for (let id = 2; id <= 20; id += 2) {
                mgr.syncPose(id, { x: id * 60 + f * 3, y: 0, z: 0, heading: 0 });
            }
            mgr.update(1 / 60);
        }
        backend.flush();
        // Every surviving member's pose must be at ITS slot: if the kernel had
        // kept the pre-compaction index it would be writing over a neighbour,
        // and some live slot would be left at a stale position.
        const mgrState = (mgr as unknown as {
            store: {
                mDirectPool: Int32Array; mPoolIdx: Int32Array; mPool: Int32Array;
                mx: Float32Array; mz: Float32Array;
            };
            squads: Map<number, { base: number; size: number }>;
        });
        const store = mgrState.store;
        let checked = 0;
        for (const [, sq] of mgrState.squads) {
            for (let i = sq.base; i < sq.base + sq.size; i++) {
                const poolId = store.mDirectPool[i];
                if (poolId < 0) continue;
                // The BACKEND is the authority on where this member's slot is —
                // reading the pose back through the kernel's own index would
                // agree with itself even when both are wrong.
                const handle = store.mPool[i];
                const truth = backend.slotIndex(handle);
                expect(store.mPoolIdx[i]).toBe(truth);
                const view = backend.getPoolView(backend.slotPoolId(handle))!;
                expect(view.spritePos![truth * 3]).toBeCloseTo(store.mx[i], 3);
                expect(view.spritePos![truth * 3 + 2]).toBeCloseTo(store.mz[i], 3);
                checked++;
            }
        }
        expect(checked).toBeGreaterThan(50);
    });

    it('finds no W-row pollution anywhere after a full run, and catches one when it is there', () => {
        const { backend } = makeStack();
        runScenario(backend, 30);
        expect(backend.auditWRows()).toEqual([]);
        // Sensitivity: the scanner is worth having only if it fires.
        const view = backend.getPoolView(0)!;
        view.matrices[15] = 0.5;              // e.g. "pack buildProgress in m[15]"
        expect(backend.auditWRows()[0]).toMatchObject({ poolId: 0, index: 0 });
    });
});

describe('S5 §13c — dirty-range upload', () => {
    /** Record every partial upload a flush issues, as [kind, count, offset]. */
    function recordUploads(scene: Scene): [string, number, number][] {
        const seen: [string, number, number][] = [];
        for (const mesh of scene.meshes) {
            const orig = mesh.thinInstancePartialBufferUpdate.bind(mesh);
            mesh.thinInstancePartialBufferUpdate = (
                kind: string, dataOrLength: Float32Array | number, offset: number,
            ): void => {
                if (typeof dataOrLength === 'number') seen.push([kind, dataOrLength, offset]);
                orig(kind, dataOrLength, offset);
            };
        }
        return seen;
    }

    /** 20 squads in one pool, then hand the kernel a schedule where exactly one
     *  of them gets a real step and the other 19 COAST with an unmoved centroid
     *  — the governor's time-slicing at scale (§12d), and the only shape in which
     *  a big pool has a small dirty range. Driving the kernel directly is how the
     *  schedule is stated rather than provoked. */
    function twentySquads() {
        const stack = makeStack();
        const mgr = new SquadManager(stack.backend, { engine: 'soa' });
        for (let id = 1; id <= 20; id++) {
            mgr.syncSquad(id, { x: id * 60, y: 0, z: 0, heading: 0, health: 100, maxHealth: 100 }, DEF);
        }
        mgr.update(1 / 60);
        stack.backend.flush();
        const list = [...(mgr as unknown as { squads: Map<number, unknown> }).squads.values()];
        const store = (mgr as unknown as { store: unknown }).store;
        return { ...stack, mgr, list, store };
    }

    function stepOneOf(store: unknown, list: unknown[], backend: SquadRenderBackend,
        steppedIndex: number): void {
        const schedule = scheduleReset(createSchedule(), list.length);
        for (let i = 0; i < list.length; i++) {
            schedulePush(schedule, i, i === steppedIndex ? STEP_FULL : STEP_COAST, 1 / 60);
        }
        stepMembers(store, list, null, null, [], backend, 1 / 60, 1, schedule);
    }

    it('uploads only the touched range when one squad of a big pool steps', () => {
        const { backend, scene, store, list } = twentySquads();
        expect(backend.poolOccupancy().drawn).toBe(180);
        const uploads = recordUploads(scene);
        // Squad index 5 → slots 45..53 of 180.
        stepOneOf(store, list, backend, 5);
        backend.flush();
        const matrix = uploads.filter(([k]) => k === 'matrix');
        expect(matrix.length).toBe(1);
        expect(matrix[0][1]).toBeLessThanOrEqual(9);
        expect(matrix[0][2]).toBe(45);
        // The cell selector and the fade ride the same range, not a whole-array
        // re-upload (they were `thinInstanceBufferUpdated` before S5).
        expect(uploads.filter(([k]) => k === 'impostorCell')).toEqual([['impostorCell', 9, 45]]);

        // Matched control: the legacy arm uploads the whole prefix, which is what
        // makes the number above a measurement rather than a coincidence.
        setLegacyFullUpload(true);
        try {
            uploads.length = 0;
            stepOneOf(store, list, backend, 5);
            backend.flush();
            expect(uploads.filter(([k]) => k === 'matrix')).toEqual([['matrix', 180, 0]]);
        } finally {
            setLegacyFullUpload(false);
        }
    });

    it('uploads NOTHING for a pool of coasting squads under a still camera', () => {
        const { backend, scene, store, list } = twentySquads();
        const uploads = recordUploads(scene);
        const schedule = scheduleReset(createSchedule(), list.length);
        for (let i = 0; i < list.length; i++) schedulePush(schedule, i, STEP_COAST, 1 / 60);
        stepMembers(store, list, null, null, [], backend, 1 / 60, 1, schedule);
        backend.flush();
        // §13c's own goal: "idle members and unmoved coasting squads produce no
        // writes and therefore no upload". Pre-S5 this pool re-billboarded and
        // re-uploaded all 180 slots every frame regardless.
        expect(uploads).toEqual([]);
    });

    it('re-billboards every live card when the camera DOES move (and re-picks its atlas cell)', () => {
        const { backend, scene } = makeStack();
        const mgr = new SquadManager(backend, { engine: 'soa' });
        mgr.syncSquad(1, { x: 100, y: 0, z: 100, heading: 0, health: 100, maxHealth: 100 }, DEF);
        for (let f = 1; f <= 30; f++) {
            mgr.syncPose(1, { x: 100 + f, y: 0, z: 100, heading: 0 });
            mgr.update(1 / 60);
        }
        backend.flush();
        const view = backend.getPoolView(0)!;
        const before = view.matrices.slice(0, 9 * 16);
        // The card rotation follows the camera's ORIENTATION (computeCardRotation
        // reads its world matrix), so orbiting is what a still-camera fast path
        // must not swallow — a translation alone leaves every card correct.
        (scene.activeCamera as FreeCamera).rotation.y += 0.8;
        scene.activeCamera!.position = new Vector3(600, 300, -200);
        backend.flush();
        const after = view.matrices.slice(0, 9 * 16);
        // A card that did not re-face the new camera is the visible bug this
        // fast path could have introduced — and the fast path is reached here
        // precisely because nothing else changed this frame.
        expect(Array.from(after)).not.toEqual(Array.from(before));
    });
});
