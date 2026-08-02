import { describe, it, expect } from 'vitest';
import {
    NullEngine, Scene, FreeCamera, Vector3, Color3, Mesh, Matrix, MeshBuilder,
} from '@babylonjs/core';
import { SquadRenderBackend } from './squad-render-backend.js';
import type { ImpostorAtlas } from './impostor-renderer.js';
import type { SquadMemberModel } from './entity-renderer.js';

// Beta-units task 4b: members of defs with an impostor sprite atlas draw as
// camera-facing billboard quads (per-(defId, team) thin-instance pools);
// defs without an atlas keep the proxy capsule pools.

const ATLAS: ImpostorAtlas = {
    diffuseUri: '', walkFrames: 1, idleFrames: 1, width: 12, height: 12,
};

function makeBackend(atlasDefs: Set<number>) {
    const engine = new NullEngine();
    const scene = new Scene(engine);
    const camera = new FreeCamera('cam', new Vector3(100, 50, 0), scene);
    scene.activeCamera = camera;
    const backend = new SquadRenderBackend(scene, {
        getGroundHeight: () => 0,
        getTeamColor: () => new Color3(1, 0, 0),
        getImpostorAtlas: (defId) => (atlasDefs.has(defId) ? ATLAS : undefined),
    });
    return { backend, scene, camera };
}

function findMesh(scene: Scene, prefix: string): Mesh | undefined {
    return scene.meshes.find((m) => m.name.startsWith(prefix)) as Mesh | undefined;
}

describe('SquadRenderBackend impostor sprite members', () => {
    it('routes members of an atlas def into a per-(defId, team) sprite pool', () => {
        const { backend, scene } = makeBackend(new Set([7]));
        backend.setSquadTeam(1, 2);
        const h = backend.createMember(1, 0, { defId: 7, variant: 0 });
        backend.updateMember(h, 10, 0, 20, 0, 0);
        backend.flush();

        const sprite = findMesh(scene, 'squadSprite_d7_t2');
        expect(sprite).toBeDefined();
        expect(sprite!.thinInstanceCount).toBe(1);
        // No capsule pool was created for this member.
        expect(findMesh(scene, 'squadMember_t2')).toBeUndefined();
    });

    it('keeps capsule pools for defs without an atlas', () => {
        const { backend, scene } = makeBackend(new Set());
        backend.setSquadTeam(1, 0);
        const h = backend.createMember(1, 0, { defId: 7, variant: 0 });
        backend.updateMember(h, 0, 0, 0, 0, 0);
        backend.flush();

        expect(findMesh(scene, 'squadMember_t0')).toBeDefined();
        expect(findMesh(scene, 'squadSprite_')).toBeUndefined();
    });

    it('re-billboards an idle sprite member when the camera turns', () => {
        const { backend, scene, camera } = makeBackend(new Set([7]));
        backend.setSquadTeam(1, 0);
        const h = backend.createMember(1, 0, { defId: 7, variant: 0 });
        backend.updateMember(h, 0, 0, 0, 0, 0);
        backend.flush();
        const mesh = findMesh(scene, 'squadSprite_d7_t0')!;
        const before = Array.from(
            (mesh.thinInstanceGetWorldMatrices()[0]).toArray());

        // Member is NOT updated again — only the camera turns.
        camera.rotation.y += 1.0;
        backend.flush();
        const after = Array.from(
            (mesh.thinInstanceGetWorldMatrices()[0]).toArray());
        expect(after).not.toEqual(before);
        // Translation (ground anchor + half-height lift) is unchanged.
        expect(after.slice(12, 15)).toEqual(before.slice(12, 15));
        expect(after[13]).toBe(ATLAS.height / 2);
    });

    // §Card orientation: the card rotation is shared per frame AND whether it
    // tilts with camera pitch is a property of the ATLAS (cardTiltsWithPitch).
    describe('card orientation', () => {
        /** The card's local up in world space = matrix row 1. */
        const localUp = (m: Float32Array | number[]) =>
            [m[4], m[5], m[6]] as [number, number, number];
        /** Where the card's base edge sits = translation − halfH · localUp. */
        const basePoint = (m: Float32Array | number[], halfH: number) =>
            [m[12] - halfH * m[4], m[13] - halfH * m[5], m[14] - halfH * m[6]];

        function spriteMatrix(atlas: ImpostorAtlas, pitchDown: number) {
            const engine = new NullEngine();
            const scene = new Scene(engine);
            const camera = new FreeCamera('cam', new Vector3(0, 200, -200), scene);
            camera.rotation.x = pitchDown; // look down at the ground
            scene.activeCamera = camera;
            const backend = new SquadRenderBackend(scene, {
                getGroundHeight: () => 0,
                getTeamColor: () => new Color3(1, 0, 0),
                getImpostorAtlas: () => atlas,
            });
            backend.setSquadTeam(1, 0);
            const h = backend.createMember(1, 0, { defId: 7, variant: 0 });
            backend.updateMember(h, 0, 0, 0, 0, 0);
            backend.flush();
            const mesh = findMesh(scene, 'squadSprite_d7_t0')!;
            return Array.from(mesh.thinInstanceGetWorldMatrices()[0].toArray());
        }

        it('keeps a single-view atlas card upright under a steep camera', () => {
            // No pitch rows to show, so tilting would lay the one horizon-level
            // view flat on the ground (a unit that looks like it fell over).
            const m = spriteMatrix(ATLAS, 1.2);
            const [ux, uy, uz] = localUp(m);
            expect(ux).toBeCloseTo(0, 6);
            expect(uy).toBeCloseTo(1, 6);
            expect(uz).toBeCloseTo(0, 6);
            // Upright ⇒ the lift is world-up ⇒ base sits on the ground.
            expect(m[13]).toBeCloseTo(ATLAS.height / 2, 6);
        });

        it('tilts a pitch-row atlas card and keeps its base on the ground', () => {
            const tilted: ImpostorAtlas = {
                ...ATLAS,
                layout: { yawBins: 8, pitchBins: 3, frames: 1 },
            };
            const m = spriteMatrix(tilted, 1.2);
            // The card leans back to face the steep camera...
            expect(localUp(m)[1]).toBeLessThan(0.9);
            // ...and the ground-anchor lift leans with it, so the base edge
            // stays pinned to the member's ground position (0, 0, 0) rather
            // than the card hovering half its height above the terrain.
            const [bx, by, bz] = basePoint(m, tilted.height / 2);
            expect(bx).toBeCloseTo(0, 5);
            expect(by).toBeCloseTo(0, 5);
            expect(bz).toBeCloseTo(0, 5);
        });

        it('shares one rotation across members, so a squad never fans out', () => {
            const tilted: ImpostorAtlas = {
                ...ATLAS,
                layout: { yawBins: 8, pitchBins: 3, frames: 1 },
            };
            const engine = new NullEngine();
            const scene = new Scene(engine);
            const camera = new FreeCamera('cam', new Vector3(0, 40, -40), scene);
            camera.rotation.x = 0.8;
            scene.activeCamera = camera;
            const backend = new SquadRenderBackend(scene, {
                getGroundHeight: () => 0,
                getTeamColor: () => new Color3(1, 0, 0),
                getImpostorAtlas: () => tilted,
            });
            backend.setSquadTeam(1, 0);
            // Two members spread wide either side of the camera axis — the case
            // that produced the visible radial fan-out at point-blank range.
            const a = backend.createMember(1, 0, { defId: 7, variant: 0 });
            const b = backend.createMember(1, 1, { defId: 7, variant: 0 });
            backend.updateMember(a, -30, 0, 0, 0, 0);
            backend.updateMember(b, 30, 0, 0, 0, 0);
            backend.flush();
            const mesh = findMesh(scene, 'squadSprite_d7_t0')!;
            const ma = mesh.thinInstanceGetWorldMatrices()[0].toArray();
            const mb = mesh.thinInstanceGetWorldMatrices()[1].toArray();
            // Identical 3×3 rotation blocks; only the translation differs.
            for (const i of [0, 1, 2, 4, 5, 6, 8, 9, 10]) {
                expect(mb[i]).toBeCloseTo(ma[i], 6);
            }
            expect(mb[12]).not.toBeCloseTo(ma[12], 3);
        });
    });

    it('a released sprite slot stops rendering and is reusable', () => {
        // (kept below; the real-model suite follows this describe block)
        const { backend, scene } = makeBackend(new Set([7]));
        backend.setSquadTeam(1, 0);
        const h = backend.createMember(1, 0, { defId: 7, variant: 0 });
        backend.updateMember(h, 5, 0, 5, 0, 0);
        backend.releaseMember(h);
        backend.flush();
        const mesh = findMesh(scene, 'squadSprite_d7_t0')!;
        // Slot collapsed to zero scale — matrix is all zeros.
        const m = mesh.thinInstanceGetWorldMatrices()[0].toArray();
        expect(Array.from(m).every((v) => v === 0)).toBe(true);
    });
});

// A squad def with a real 3D model must draw its members AS that model, not as
// the team-coloured proxy capsule. This was the bulk of the 2026-08-03 "the
// scenario starts with units that are mostly placeholders" report: `ms_tanks_s2`
// carries `override objectname = 'fable_tank'`, the glTF ships and loads fine,
// and every member still rendered as a blue capsule.

const MODEL_Y_OFFSET = 3;

/** A two-piece stand-in model: a hull at the origin and a turret raised 5
 *  elmos, so a test can tell "rest transform applied" from "identity". */
function makeModel(scene: Scene): SquadMemberModel {
    const hull = MeshBuilder.CreateBox('hull', { size: 4 }, scene);
    const turret = MeshBuilder.CreateBox('turret', { size: 2 }, scene);
    return {
        pieces: [
            { mesh: hull, rest: Matrix.Identity() },
            { mesh: turret, rest: Matrix.Translation(0, 5, 0) },
        ],
        yOffset: MODEL_Y_OFFSET,
    };
}

function makeModelBackend(opts: { modelReady: boolean }) {
    const engine = new NullEngine();
    const scene = new Scene(engine);
    scene.activeCamera = new FreeCamera('cam', new Vector3(0, 50, -50), scene);
    const state = { ready: opts.modelReady, model: null as SquadMemberModel | null };
    const backend = new SquadRenderBackend(scene, {
        getGroundHeight: () => 0,
        getTeamColor: () => new Color3(1, 0, 0),
        getImpostorAtlas: () => undefined,
        getSquadMemberModel: () => {
            if (!state.ready) return null;
            state.model ??= makeModel(scene);
            return state.model;
        },
    });
    return { backend, scene, state };
}

describe('SquadRenderBackend real-model members', () => {
    it('draws members of a modelled def as the model, not the proxy capsule', () => {
        const { backend, scene } = makeModelBackend({ modelReady: true });
        backend.setSquadTeam(1, 0);
        const h = backend.createMember(1, 0, { defId: 7, variant: 0 });
        backend.updateMember(h, 10, 0, 20, 0, 0);
        backend.flush();

        const hull = scene.meshes.find((m) => m.name === 'hull') as Mesh;
        const turret = scene.meshes.find((m) => m.name === 'turret') as Mesh;
        expect(hull.thinInstanceCount).toBe(1);
        expect(turret.thinInstanceCount).toBe(1);
        // The capsule pool must not have been created at all.
        expect(scene.meshes.find((m) => m.name.startsWith('squadMember_t')))
            .toBeUndefined();
    });

    it('composes piece rest transforms and the template yOffset', () => {
        const { backend, scene } = makeModelBackend({ modelReady: true });
        backend.setSquadTeam(1, 0);
        const h = backend.createMember(1, 0, { defId: 7, variant: 0 });
        // gait 0 ⇒ no bob, so the Y below is exact.
        backend.updateMember(h, 10, 100, 20, 0, 0);
        backend.flush();

        const hull = scene.meshes.find((m) => m.name === 'hull') as Mesh;
        const turret = scene.meshes.find((m) => m.name === 'turret') as Mesh;
        const hullM = hull.thinInstanceGetWorldMatrices()[0].toArray();
        const turretM = turret.thinInstanceGetWorldMatrices()[0].toArray();

        // Hull sits at the member position lifted by the template's yOffset —
        // NOT by the capsule's half-height (the old unconditional lift).
        expect(hullM[12]).toBeCloseTo(10, 6);
        expect(hullM[13]).toBeCloseTo(100 + MODEL_Y_OFFSET, 6);
        expect(hullM[14]).toBeCloseTo(20, 6);
        // Turret carries its own +5 rest offset on top.
        expect(turretM[13]).toBeCloseTo(100 + MODEL_Y_OFFSET + 5, 6);
    });

    it('upgrades a capsule member in place once its model finishes loading', () => {
        const { backend, scene, state } = makeModelBackend({ modelReady: false });
        backend.setSquadTeam(1, 0);
        const h = backend.createMember(1, 0, { defId: 7, variant: 0 });
        backend.updateMember(h, 10, 100, 20, 0, 0);
        backend.flush();

        // Model not loaded yet → capsule, as before.
        const capsule = scene.meshes.find(
            (m) => m.name === 'squadMember_t0') as Mesh;
        expect(capsule.thinInstanceCount).toBe(1);

        // The glTF lands. No further updateMember call — the swap must happen
        // on flush() alone, and must replay the member's last pose.
        state.ready = true;
        backend.flush();

        const hull = scene.meshes.find((m) => m.name === 'hull') as Mesh;
        expect(hull.thinInstanceCount).toBe(1);
        const hullM = hull.thinInstanceGetWorldMatrices()[0].toArray();
        expect(hullM[12]).toBeCloseTo(10, 6);
        expect(hullM[13]).toBeCloseTo(100 + MODEL_Y_OFFSET, 6);
        expect(hullM[14]).toBeCloseTo(20, 6);
        // The vacated capsule slot renders nothing.
        const capM = capsule.thinInstanceGetWorldMatrices()[0].toArray();
        expect(Array.from(capM).every((v) => v === 0)).toBe(true);
    });

    it('keeps the capsule for a def with neither an atlas nor a model', () => {
        const { backend, scene } = makeModelBackend({ modelReady: false });
        backend.setSquadTeam(1, 0);
        const h = backend.createMember(1, 0, { defId: 7, variant: 0 });
        backend.updateMember(h, 0, 0, 0, 0, 0);
        backend.flush();
        backend.flush(); // a retry that still resolves nothing must not throw

        const capsule = scene.meshes.find(
            (m) => m.name === 'squadMember_t0') as Mesh;
        expect(capsule.thinInstanceCount).toBe(1);
        expect(scene.meshes.find((m) => m.name === 'hull')).toBeUndefined();
    });

    it('releases every piece of a model member', () => {
        const { backend, scene } = makeModelBackend({ modelReady: true });
        backend.setSquadTeam(1, 0);
        const h = backend.createMember(1, 0, { defId: 7, variant: 0 });
        backend.updateMember(h, 10, 0, 20, 0, 0);
        backend.flush();
        backend.releaseMember(h);
        backend.flush();

        for (const name of ['hull', 'turret']) {
            const mesh = scene.meshes.find((m) => m.name === name) as Mesh;
            const m = mesh.thinInstanceGetWorldMatrices()[0].toArray();
            expect(Array.from(m).every((v) => v === 0)).toBe(true);
        }
    });

    it('an impostor atlas still wins over a real model', () => {
        // Infantry ship an authored sprite atlas AND (later) may gain a model;
        // the billboard is the intended render for them, so it must take
        // priority rather than being silently replaced by geometry.
        const engine = new NullEngine();
        const scene = new Scene(engine);
        scene.activeCamera = new FreeCamera('cam', new Vector3(0, 50, -50), scene);
        const backend = new SquadRenderBackend(scene, {
            getGroundHeight: () => 0,
            getTeamColor: () => new Color3(1, 0, 0),
            getImpostorAtlas: () => ATLAS,
            getSquadMemberModel: () => makeModel(scene),
        });
        backend.setSquadTeam(1, 0);
        const h = backend.createMember(1, 0, { defId: 7, variant: 0 });
        backend.updateMember(h, 0, 0, 0, 0, 0);
        backend.flush();

        const sprite = scene.meshes.find(
            (m) => m.name === 'squadSprite_d7_t0') as Mesh;
        expect(sprite.thinInstanceCount).toBe(1);
        const hull = scene.meshes.find((m) => m.name === 'hull') as Mesh | undefined;
        expect(hull?.thinInstanceCount ?? 0).toBe(0);
    });
});
