import { describe, it, expect } from 'vitest';
import { NullEngine, Scene, FreeCamera, Vector3, Color3, Mesh } from '@babylonjs/core';
import { SquadRenderBackend } from './squad-render-backend.js';
import type { ImpostorAtlas } from './impostor-renderer.js';

// Beta-units task 4b: members of defs with an impostor sprite atlas draw as
// camera-facing billboard quads (per-(defId, team) thin-instance pools);
// defs without an atlas keep the proxy capsule pools.

const ATLAS: ImpostorAtlas = {
    diffuseUri: '', walkFrames: 1, idleFrames: 1, width: 12, height: 12,
    yawBins: 8, pitchBins: 3, frames: 1,
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
