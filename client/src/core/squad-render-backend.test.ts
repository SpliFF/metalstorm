import { describe, it, expect } from 'vitest';
import {
    NullEngine, Scene, FreeCamera, Vector3, Color3, Matrix, Mesh, MeshBuilder,
} from '@babylonjs/core';
import { SquadRenderBackend, type MemberModel } from './squad-render-backend.js';
import type { ImpostorAtlas } from './impostor-renderer.js';

// Members of defs with an impostor sprite atlas draw as camera-facing billboard
// quads (per-(defId, team) thin-instance pools); defs without an atlas keep the
// proxy capsule pools. With a 3D member model (M4) they swap to the real body
// within impostorDistance and back to the sprite beyond it.

const ATLAS: ImpostorAtlas = {
    diffuseUri: '', walkFrames: 1, idleFrames: 1, width: 12, height: 12,
    yawBins: 8, pitchBins: 3, frames: 1,
};

interface HostOpts {
    /** defId → MemberModel factory (or undefined = model not available yet). */
    models?: Map<number, (scene: Scene) => Mesh | undefined>;
    impostorDist?: number;
}

function makeBackend(atlasDefs: Set<number>, opts: HostOpts = {}) {
    const engine = new NullEngine();
    const scene = new Scene(engine);
    const camera = new FreeCamera('cam', new Vector3(100, 50, 0), scene);
    scene.activeCamera = camera;
    const memberMeshes = new Map<string, Mesh>();
    const backend = new SquadRenderBackend(scene, {
        getGroundHeight: () => 0,
        getTeamColor: () => new Color3(1, 0, 0),
        getImpostorAtlas: (defId) => (atlasDefs.has(defId) ? ATLAS : undefined),
        getMemberModel: opts.models
            ? (defId, team): MemberModel | undefined => {
                const factory = opts.models!.get(defId);
                if (!factory) return undefined;
                const key = `${defId}:${team}`;
                let mesh = memberMeshes.get(key);
                if (!mesh) {
                    const m = factory(scene);
                    if (!m) return undefined;         // still loading
                    memberMeshes.set(key, m);
                    mesh = m;
                }
                return { mesh, restWorld: Matrix.Identity(), yOffset: 0, height: 10 };
            }
            : undefined,
        getImpostorDistance: opts.models
            ? () => opts.impostorDist ?? 900
            : undefined,
    });
    return { backend, scene, camera, memberMeshes };
}

/** A dedicated body mesh factory for the MODEL tier. */
function bodyFactory(defId: number) {
    return (scene: Scene) =>
        MeshBuilder.CreateBox(`memberModel_d${defId}`, { size: 4 }, scene);
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

    it('screen-aligned cards do NOT twist when the camera only moves position', () => {
        // The anti-fan-out contract (PLAN M3): every card shares one rotation
        // derived from the camera view, not from each member's position → the
        // matrix is identical when only the camera translates.
        const { backend, scene, camera } = makeBackend(new Set([7]));
        backend.setSquadTeam(1, 0);
        const h = backend.createMember(1, 0, { defId: 7, variant: 0 });
        backend.updateMember(h, 0, 0, 0, 0, 0);
        camera.computeWorldMatrix(true);
        backend.flush();
        const mesh = findMesh(scene, 'squadSprite_d7_t0')!;
        const before = Array.from((mesh.thinInstanceGetWorldMatrices()[0]).toArray());

        // Member is NOT updated again — only the camera translates (no rotation).
        camera.position.set(-100, 50, 0);
        camera.computeWorldMatrix(true);
        backend.flush();
        const after = Array.from((mesh.thinInstanceGetWorldMatrices()[0]).toArray());
        expect(after).toEqual(before);
        // Ground anchor + half-height lift along the (unchanged) card up.
        expect(after[13]).toBeCloseTo(ATLAS.height / 2);
    });

    it('re-orients screen-aligned cards when the camera rotates', () => {
        const { backend, scene, camera } = makeBackend(new Set([7]));
        backend.setSquadTeam(1, 0);
        const h = backend.createMember(1, 0, { defId: 7, variant: 0 });
        backend.updateMember(h, 0, 0, 0, 0, 0);
        camera.computeWorldMatrix(true);
        backend.flush();
        const mesh = findMesh(scene, 'squadSprite_d7_t0')!;
        const before = Array.from((mesh.thinInstanceGetWorldMatrices()[0]).toArray());

        // Camera yaws — the shared card rotation must follow.
        camera.rotation.y += 0.6;
        camera.computeWorldMatrix(true);
        backend.flush();
        const after = Array.from((mesh.thinInstanceGetWorldMatrices()[0]).toArray());
        expect(after).not.toEqual(before);
    });

    it('draws a member within impostorDistance as the 3D model, not a sprite', () => {
        const models = new Map([[7, bodyFactory(7)]]);
        const { backend, scene } = makeBackend(new Set([7]), { models, impostorDist: 900 });
        backend.setSquadTeam(1, 2);
        const h = backend.createMember(1, 0, { defId: 7, variant: 0 });
        // Camera at (100,50,0); place the member ~10 elmos away → inside 900.
        backend.updateMember(h, 100, 0, 8, 0, 0);
        backend.flush();

        const model = findMesh(scene, 'memberModel_d7');
        expect(model).toBeDefined();
        expect(model!.thinInstanceCount).toBe(1);
        // The sprite pool exists (created for the initial resting tier) but has
        // no live instance for this member after it migrated to the model pool.
        const sprite = findMesh(scene, 'squadSprite_d7_t2');
        const sm = sprite!.thinInstanceGetWorldMatrices()[0].toArray();
        expect(Array.from(sm).every((v) => v === 0)).toBe(true);
    });

    it('draws a member beyond impostorDistance as the sprite, not the 3D model', () => {
        const models = new Map([[7, bodyFactory(7)]]);
        const { backend, scene } = makeBackend(new Set([7]), { models, impostorDist: 900 });
        backend.setSquadTeam(1, 0);
        const h = backend.createMember(1, 0, { defId: 7, variant: 0 });
        // Far from the camera (well beyond 900 elmos).
        backend.updateMember(h, -2000, 0, 2000, 0, 0);
        backend.flush();

        const sprite = findMesh(scene, 'squadSprite_d7_t0')!;
        expect(sprite.thinInstanceCount).toBe(1);
        // No model instance is live.
        const model = findMesh(scene, 'memberModel_d7');
        if (model) {
            const mm = model.thinInstanceGetWorldMatrices()[0]?.toArray();
            if (mm) expect(Array.from(mm).every((v) => v === 0)).toBe(true);
        }
    });

    it('migrates a member between sprite and model pools as it nears the camera', () => {
        const models = new Map([[7, bodyFactory(7)]]);
        const { backend, scene } = makeBackend(new Set([7]), { models, impostorDist: 900 });
        backend.setSquadTeam(1, 0);
        const h = backend.createMember(1, 0, { defId: 7, variant: 0 });

        // Start far → sprite.
        backend.updateMember(h, -3000, 0, 0, 0, 0);
        backend.flush();
        const sprite = findMesh(scene, 'squadSprite_d7_t0')!;
        expect(sprite.thinInstanceCount).toBe(1);

        // Move next to the camera → model, and the sprite slot goes dark.
        backend.updateMember(h, 100, 0, 6, 0, 0);
        backend.flush();
        const model = findMesh(scene, 'memberModel_d7')!;
        expect(model.thinInstanceCount).toBe(1);
        const sm = sprite.thinInstanceGetWorldMatrices()[0].toArray();
        expect(Array.from(sm).every((v) => v === 0)).toBe(true);

        // Back out → sprite again, model slot goes dark.
        backend.updateMember(h, -3000, 0, 0, 0, 0);
        backend.flush();
        expect(sprite.thinInstanceCount).toBeGreaterThanOrEqual(1);
        const spriteLive = sprite.thinInstanceGetWorldMatrices()[0].toArray();
        expect(Array.from(spriteLive).some((v) => v !== 0)).toBe(true);
        const mm = model.thinInstanceGetWorldMatrices()[0].toArray();
        expect(Array.from(mm).every((v) => v === 0)).toBe(true);
    });

    it('stays on the sprite tier until the model finishes loading, then migrates', () => {
        // Factory returns undefined (loading) first, then a mesh.
        let ready = false;
        const models = new Map<number, (s: Scene) => Mesh | undefined>([
            [7, (s) => (ready ? MeshBuilder.CreateBox('memberModel_d7', { size: 4 }, s) : undefined)],
        ]);
        const { backend, scene } = makeBackend(new Set([7]), { models, impostorDist: 900 });
        backend.setSquadTeam(1, 0);
        const h = backend.createMember(1, 0, { defId: 7, variant: 0 });

        // Close to the camera, but the model isn't loaded → sprite.
        backend.updateMember(h, 100, 0, 6, 0, 0);
        backend.flush();
        expect(findMesh(scene, 'squadSprite_d7_t0')!.thinInstanceCount).toBe(1);
        expect(findMesh(scene, 'memberModel_d7')).toBeUndefined();

        // Model loads → next update migrates it in.
        ready = true;
        backend.updateMember(h, 100, 0, 6, 0, 0);
        backend.flush();
        expect(findMesh(scene, 'memberModel_d7')!.thinInstanceCount).toBe(1);
    });

    it('does NOT dispose the borrowed model mesh on backend.dispose()', () => {
        const models = new Map([[7, bodyFactory(7)]]);
        const { backend, scene } = makeBackend(new Set([7]), { models, impostorDist: 900 });
        backend.setSquadTeam(1, 0);
        const h = backend.createMember(1, 0, { defId: 7, variant: 0 });
        backend.updateMember(h, 100, 0, 6, 0, 0);
        backend.flush();
        const model = findMesh(scene, 'memberModel_d7')!;
        expect(model.isDisposed()).toBe(false);

        backend.dispose();
        // EntityRenderer owns the mesh — the backend leaves it alive.
        expect(model.isDisposed()).toBe(false);
    });

    it('keeps members on the sprite tier when the host exposes no model API', () => {
        // No models map → getMemberModel/getImpostorDistance undefined.
        const { backend, scene } = makeBackend(new Set([7]));
        backend.setSquadTeam(1, 0);
        const h = backend.createMember(1, 0, { defId: 7, variant: 0 });
        backend.updateMember(h, 100, 0, 6, 0, 0);   // right next to the camera
        backend.flush();
        expect(findMesh(scene, 'squadSprite_d7_t0')!.thinInstanceCount).toBe(1);
    });

    it('a released sprite slot stops rendering and is reusable', () => {
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
