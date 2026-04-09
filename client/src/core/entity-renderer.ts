/**
 * EntityRenderer — thin-instanced entity rendering with shape variety.
 *
 * Groups entities by (shape, team) for batched draw calls.
 * Shape is derived from defId until real models are loaded.
 * Uses snapshot interpolation for smooth movement.
 */

import {
    Scene,
    MeshBuilder,
    Mesh,
    Matrix,
    Vector3,
    Quaternion,
    StandardMaterial,
    Color3,
} from '@babylonjs/core';
import type { EntityStateSnapshot } from './entity-state.js';
import { EntityInterpolator } from './entity-interpolator.js';

const TEAM_COLORS = [
    new Color3(0.2, 0.5, 1.0),
    new Color3(1.0, 0.3, 0.2),
    new Color3(0.2, 0.8, 0.3),
    new Color3(1.0, 0.8, 0.1),
];

// Shape types — different geometries for visual distinction
enum UnitShape { Box = 0, Cylinder, Cone, Sphere }
const SHAPE_COUNT = 4;

/** Map defId to a shape. */
function defIdToShape(defId: number): UnitShape {
    return (defId % SHAPE_COUNT) as UnitShape;
}

export interface EntityMeta {
    defId: number;
    team: number;
    healthScale: number;
}

export class EntityRenderer {
    private scene: Scene;
    private interpolator = new EntityInterpolator();
    private entityMeta = new Map<number, EntityMeta>();
    private teamMaterials: StandardMaterial[] = [];

    // Template meshes per shape (hidden, used as source for thin instances)
    private shapeMeshes: Mesh[] = [];

    // Render meshes keyed by `shape * TEAM_COUNT + team`
    private renderMeshes = new Map<number, Mesh>();

    constructor(scene: Scene) {
        this.scene = scene;

        for (let i = 0; i < TEAM_COLORS.length; i++) {
            const mat = new StandardMaterial(`team${i}Mat`, scene);
            mat.diffuseColor = TEAM_COLORS[i];
            mat.specularColor = new Color3(0.3, 0.3, 0.3);
            this.teamMaterials.push(mat);
        }

        // Create shape templates
        const box = MeshBuilder.CreateBox('shape_box', { width: 16, height: 12, depth: 20 }, scene);
        const cyl = MeshBuilder.CreateCylinder('shape_cyl', { height: 14, diameter: 18, tessellation: 8 }, scene);
        const cone = MeshBuilder.CreateCylinder('shape_cone', { height: 16, diameterTop: 0, diameterBottom: 16, tessellation: 8 }, scene);
        const sphere = MeshBuilder.CreateSphere('shape_sphere', { diameter: 14, segments: 6 }, scene);

        this.shapeMeshes = [box, cyl, cone, sphere];
        for (const m of this.shapeMeshes) {
            m.isVisible = false;
            m.thinInstanceEnablePicking = false;
        }
    }

    update(snapshot: EntityStateSnapshot, isDelta: boolean = false): void {
        const { count, entityIds, positionsX, positionsY, positionsZ, headings, health, defIds, teams } = snapshot;
        if (!entityIds) return;

        const now = performance.now();

        for (let i = 0; i < count; i++) {
            const id = entityIds[i];

            this.interpolator.pushState(
                id,
                positionsX ? positionsX[i] : 0,
                positionsY ? positionsY[i] : 0,
                positionsZ ? positionsZ[i] : 0,
                headings ? headings[i] : 0,
                now,
            );

            let meta = this.entityMeta.get(id);
            if (!meta) {
                meta = { defId: 0, team: 0, healthScale: 1.0 };
                this.entityMeta.set(id, meta);
            }
            if (defIds) meta.defId = defIds[i];
            if (teams) meta.team = teams[i];
            if (health) meta.healthScale = 0.3 + (health[i] / 65535) * 0.7;
        }

        if (!isDelta) {
            const seen = new Set<number>();
            for (let i = 0; i < count; i++) seen.add(entityIds[i]);
            for (const id of this.entityMeta.keys()) {
                if (!seen.has(id)) {
                    this.entityMeta.delete(id);
                    this.interpolator.remove(id);
                }
            }
        }
    }

    tick(): void {
        const now = performance.now();
        const teamCount = this.teamMaterials.length;

        // Collect matrices grouped by (shape, team)
        const groups = new Map<number, { matrices: number[]; count: number }>();

        for (const [id, meta] of this.entityMeta) {
            const lerped = this.interpolator.getInterpolated(id, now);
            if (!lerped) continue;

            const shape = defIdToShape(meta.defId);
            const teamIdx = meta.team % teamCount;
            const groupKey = shape * teamCount + teamIdx;

            let group = groups.get(groupKey);
            if (!group) {
                group = { matrices: [], count: 0 };
                groups.set(groupKey, group);
            }

            const rotation = (lerped.heading / 65535) * Math.PI * 2;
            const matrix = Matrix.Compose(
                new Vector3(1, meta.healthScale, 1),
                Quaternion.RotationYawPitchRoll(rotation, 0, 0),
                new Vector3(lerped.x, lerped.y, lerped.z),
            );

            // Push 16 floats
            const arr = new Float32Array(16);
            matrix.copyToArray(arr, 0);
            for (let j = 0; j < 16; j++) group.matrices.push(arr[j]);
            group.count++;
        }

        // Update render meshes
        for (let shape = 0; shape < SHAPE_COUNT; shape++) {
            for (let team = 0; team < teamCount; team++) {
                const key = shape * teamCount + team;
                const group = groups.get(key);
                let mesh = this.renderMeshes.get(key);

                if (!group || group.count === 0) {
                    if (mesh) {
                        mesh.isVisible = false;
                        mesh.thinInstanceCount = 0;
                    }
                    continue;
                }

                if (!mesh) {
                    mesh = this.shapeMeshes[shape].clone(`render_${shape}_${team}`);
                    mesh.material = this.teamMaterials[team];
                    this.renderMeshes.set(key, mesh);
                }

                mesh.isVisible = true;
                const buf = new Float32Array(group.matrices);
                mesh.thinInstanceSetBuffer('matrix', buf, 16, false);
                mesh.thinInstanceCount = group.count;
            }
        }
    }

    get entityCount(): number {
        return this.entityMeta.size;
    }

    getEntities(): IterableIterator<[number, EntityMeta]> {
        return this.entityMeta.entries();
    }

    getEntityPosition(id: number): { x: number; y: number; z: number } | null {
        return this.interpolator.getInterpolated(id);
    }

    removeEntity(id: number): void {
        this.entityMeta.delete(id);
        this.interpolator.remove(id);
    }

    dispose(): void {
        for (const mesh of this.renderMeshes.values()) mesh.dispose();
        this.renderMeshes.clear();
        for (const mesh of this.shapeMeshes) mesh.dispose();
        this.entityMeta.clear();
        this.interpolator.clear();
        for (const mat of this.teamMaterials) mat.dispose();
    }
}
