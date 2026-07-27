import { describe, it, expect } from 'vitest';
import {
    NullEngine, Scene, FreeCamera, MeshBuilder, StandardMaterial, Vector3, Mesh,
} from '@babylonjs/core';
import { FeatureLodController } from './feature-lod-renderer.js';
import { FeatureTier, type LodPlacement } from './feature-lod.js';
import { DEFAULT_ATLAS_LAYOUT } from './impostor-atlas.js';

// PLAN-maps.md M6 — the Babylon half of the map-feature LOD tier. These cover
// the two things that are easy to get silently wrong: per-tile thin-instance
// buffer independence (Babylon clones SHARE geometry, and thin-instance
// buffers live on the geometry) and the tier -> mesh-enabled wiring.

function place(x: number, z: number, y = 0): LodPlacement {
    return { x, y, z, rotation: 0, scale: 1 };
}

function makeHarness(placements: LodPlacement[]) {
    const engine = new NullEngine();
    const scene = new Scene(engine);
    const camera = new FreeCamera('cam', new Vector3(100, 100, 100), scene);
    const template = MeshBuilder.CreateBox('tree', { size: 10 }, scene);
    template.material = new StandardMaterial('treeMat', scene);

    const ctrl = new FeatureLodController(scene, null);
    ctrl.setConfig({
        tileSize: 1000,
        impostorDistance: 2000,
        cullDistance: 8000,
        cullCameraHeight: 1e9,
        hysteresis: 100,
        crossfadeMs: 0,
        updateIntervalMs: 0,
        cameraMoveEpsilon: 0,
    });
    ctrl.addType({
        typeName: 'tree',
        template,
        placements,
        atlas: {
            diffuseUrl: 'about:blank#tree_impostor.ktx2',
            layout: DEFAULT_ATLAS_LAYOUT,
            width: 20,
            height: 40,
            topDown: true,
        },
        modelExtent: { radius: 5, height: 10 },
    });
    return { scene, camera, ctrl, template };
}

/** Tile meshes are named `feat_<type>_<tier>_<ix>:<iz>`. */
function tileMesh(scene: Scene, name: string): Mesh {
    const m = scene.getMeshByName(name);
    expect(m, `mesh ${name} should exist`).toBeTruthy();
    return m as Mesh;
}

describe('FeatureLodController', () => {
    it('chunks placements into per-tile meshes for both tiers', () => {
        const { scene, ctrl } = makeHarness([
            place(100, 100), place(200, 150), place(5000, 100), place(20000, 100),
        ]);
        // 3 tiles at tileSize 1000 -> 3 near + 3 far meshes.
        for (const key of ['0:0', '5:0', '20:0']) {
            expect(scene.getMeshByName(`feat_tree_near_${key}`)).toBeTruthy();
            expect(scene.getMeshByName(`feat_tree_far_${key}`)).toBeTruthy();
        }
        expect((ctrl.getStats().totals as { tiles: number }).tiles).toBe(3);
    });

    it('gives every tile its OWN thin-instance buffers (clones share geometry)', () => {
        const { scene } = makeHarness([place(100, 100), place(200, 150), place(5000, 100)]);
        const a = tileMesh(scene, 'feat_tree_near_0:0');
        const b = tileMesh(scene, 'feat_tree_near_5:0');
        expect(a.geometry).not.toBe(b.geometry);
        expect(a.geometry!.getVertexBuffer('world0'))
            .not.toBe(b.geometry!.getVertexBuffer('world0'));
        // ...and the instance counts really are per tile.
        expect(a.thinInstanceCount).toBe(2);
        expect(b.thinInstanceCount).toBe(1);
    });

    it('binds a ditherFade attribute on every tile mesh (unbound reads 0 = invisible)', () => {
        const { scene } = makeHarness([place(100, 100)]);
        for (const name of ['feat_tree_near_0:0', 'feat_tree_far_0:0']) {
            expect(tileMesh(scene, name).geometry!.getVertexBuffer('ditherFade')).toBeTruthy();
        }
    });

    it('assigns near / far / culled by tile distance and enables the matching mesh', () => {
        const { scene, camera, ctrl } = makeHarness([
            place(100, 100), place(5000, 100), place(20000, 100),
        ]);
        ctrl.update(camera, 1000);

        const totals = ctrl.getStats().totals as Record<string, number>;
        expect(totals.near).toBe(1);
        expect(totals.far).toBe(1);
        expect(totals.culled).toBe(1);

        expect(tileMesh(scene, 'feat_tree_near_0:0').isEnabled(false)).toBe(true);
        expect(tileMesh(scene, 'feat_tree_far_0:0').isEnabled(false)).toBe(false);
        expect(tileMesh(scene, 'feat_tree_near_5:0').isEnabled(false)).toBe(false);
        expect(tileMesh(scene, 'feat_tree_far_5:0').isEnabled(false)).toBe(true);
        expect(tileMesh(scene, 'feat_tree_near_20:0').isEnabled(false)).toBe(false);
        expect(tileMesh(scene, 'feat_tree_far_20:0').isEnabled(false)).toBe(false);
    });

    it('swaps tiers when the camera moves and never leaves both tiers drawn', () => {
        const { scene, camera, ctrl } = makeHarness([place(5000, 100)]);
        ctrl.update(camera, 1000);
        expect(tileMesh(scene, 'feat_tree_far_5:0').isEnabled(false)).toBe(true);

        camera.position.set(5000, 100, 100);
        ctrl.update(camera, 2000);
        expect(tileMesh(scene, 'feat_tree_near_5:0').isEnabled(false)).toBe(true);
        expect(tileMesh(scene, 'feat_tree_far_5:0').isEnabled(false)).toBe(false);
    });

    it('drops everything past the strategic-zoom camera height', () => {
        const { camera, ctrl } = makeHarness([place(100, 100), place(5000, 100)]);
        ctrl.setConfig({ cullCameraHeight: 4000 });
        camera.position.set(100, 12000, 100);
        ctrl.update(camera, 1000);
        const totals = ctrl.getStats().totals as Record<string, number>;
        expect(totals.culled).toBe(2);
        expect(totals.drawnMeshes).toBe(0);
    });

    it('honours a forced tier for A/B attribution', () => {
        const { camera, ctrl } = makeHarness([place(100, 100), place(5000, 100)]);
        ctrl.setForceTier(FeatureTier.Far);
        ctrl.update(camera, 1000);
        expect((ctrl.getStats().totals as Record<string, number>).far).toBe(2);
        ctrl.setForceTier(null);
        ctrl.update(camera, 2000);
        expect((ctrl.getStats().totals as Record<string, number>).near).toBe(1);
    });

    it('thins far tiles by farDensity with no buffer upload', () => {
        const placements = Array.from({ length: 100 }, (_, i) => place(5000 + i, 100));
        const { scene, camera, ctrl } = makeHarness(placements);
        ctrl.setConfig({ farDensity: 0.25 });
        ctrl.update(camera, 1000);
        expect(tileMesh(scene, 'feat_tree_far_5:0').thinInstanceCount).toBe(25);
    });

    it('refuses to re-tile after types are added (static buffers are the point)', () => {
        const { ctrl } = makeHarness([place(100, 100)]);
        expect(ctrl.setConfig({ tileSize: 99 }).tileSize).toBe(1000);
    });

    it('disposes every tile mesh', () => {
        const { scene, ctrl } = makeHarness([place(100, 100), place(5000, 100)]);
        const before = scene.meshes.filter(m => m.name.startsWith('feat_tree_')).length;
        expect(before).toBe(4);
        ctrl.dispose();
        expect(scene.meshes.filter(m => m.name.startsWith('feat_tree_')).length).toBe(0);
        expect(ctrl.typeCount).toBe(0);
    });

    it('is a no-op for a type with no placements', () => {
        const { ctrl } = makeHarness([]);
        expect(ctrl.typeCount).toBe(0);
    });
});
