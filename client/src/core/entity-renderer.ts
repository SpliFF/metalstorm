/**
 * EntityRenderer — manages Babylon.js thin instances from entity state.
 *
 * Groups entities by def_id and renders each group as a single draw call
 * using Babylon.js thin instances. Each unit type gets one base mesh;
 * individual entities are 4x4 transform matrices on that mesh.
 *
 * Uses snapshot interpolation for smooth movement between ~10Hz updates.
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

// Team colours
const TEAM_COLORS = [
    new Color3(0.2, 0.5, 1.0),   // team 0 — blue
    new Color3(1.0, 0.3, 0.2),   // team 1 — red
    new Color3(0.2, 0.8, 0.3),   // team 2 — green
    new Color3(1.0, 0.8, 0.1),   // team 3 — yellow
];

/** Per-entity metadata needed for rendering. */
export interface EntityMeta {
    defId: number;
    team: number;
    healthScale: number;  // 0.3–1.0
}

export class EntityRenderer {
    private scene: Scene;
    private interpolator = new EntityInterpolator();
    private entityMeta = new Map<number, EntityMeta>();
    private teamMaterials: StandardMaterial[] = [];

    // Thin instance base meshes keyed by defId
    private baseMeshes = new Map<number, Mesh>();

    // Default base mesh for unknown def IDs
    private defaultMesh: Mesh;

    constructor(scene: Scene) {
        this.scene = scene;

        for (let i = 0; i < TEAM_COLORS.length; i++) {
            const mat = new StandardMaterial(`team${i}Mat`, scene);
            mat.diffuseColor = TEAM_COLORS[i];
            mat.specularColor = new Color3(0.3, 0.3, 0.3);
            this.teamMaterials.push(mat);
        }

        // Default placeholder mesh (box) — used until real models are loaded
        this.defaultMesh = MeshBuilder.CreateBox('defMesh_default', { size: 16 }, scene);
        this.defaultMesh.isVisible = false;
        // Enable thin instances on the default mesh
        this.defaultMesh.thinInstanceEnablePicking = false;
    }

    /**
     * Feed a new server snapshot. Updates interpolator targets and entity metadata.
     */
    update(snapshot: EntityStateSnapshot, isDelta: boolean = false): void {
        const { count, entityIds, positionsX, positionsY, positionsZ, headings, health, defIds, teams } = snapshot;
        if (!entityIds) return;

        const now = performance.now();

        for (let i = 0; i < count; i++) {
            const id = entityIds[i];

            // Push position into interpolator
            this.interpolator.pushState(
                id,
                positionsX ? positionsX[i] : 0,
                positionsY ? positionsY[i] : 0,
                positionsZ ? positionsZ[i] : 0,
                headings ? headings[i] : 0,
                now,
            );

            // Update metadata
            let meta = this.entityMeta.get(id);
            if (!meta) {
                meta = { defId: 0, team: 0, healthScale: 1.0 };
                this.entityMeta.set(id, meta);
            }
            if (defIds) meta.defId = defIds[i];
            if (teams) meta.team = teams[i];
            if (health) meta.healthScale = 0.3 + (health[i] / 65535) * 0.7;
        }

        // On full snapshots, remove entities not present
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

    /**
     * Rebuild thin instance matrices from interpolated positions.
     * Call every render frame.
     */
    tick(): void {
        const now = performance.now();

        // Group entities by team (for now; later group by defId + team)
        // Each team gets its own set of thin instances on the default mesh
        const teamMatrices: Float32Array[] = [];
        const teamCounts: number[] = [];
        for (let t = 0; t < this.teamMaterials.length; t++) {
            teamMatrices.push(new Float32Array(this.entityMeta.size * 16));
            teamCounts.push(0);
        }

        for (const [id, meta] of this.entityMeta) {
            const lerped = this.interpolator.getInterpolated(id, now);
            if (!lerped) continue;

            const teamIdx = meta.team % this.teamMaterials.length;
            const rotation = (lerped.heading / 65535) * Math.PI * 2;

            const matrix = Matrix.Compose(
                new Vector3(1, meta.healthScale, 1),
                Quaternion.RotationYawPitchRoll(rotation, 0, 0),
                new Vector3(lerped.x, lerped.y, lerped.z),
            );

            const offset = teamCounts[teamIdx] * 16;
            matrix.copyToArray(teamMatrices[teamIdx], offset);
            teamCounts[teamIdx]++;
        }

        // Apply thin instances per team
        // We use separate mesh clones per team (with different materials)
        this.ensureTeamMeshes();
        for (let t = 0; t < this.teamMaterials.length; t++) {
            const mesh = this.getTeamMesh(t);
            if (teamCounts[t] > 0) {
                mesh.isVisible = true;
                mesh.thinInstanceSetBuffer(
                    'matrix',
                    teamMatrices[t].subarray(0, teamCounts[t] * 16),
                    16, false
                );
                mesh.thinInstanceCount = teamCounts[t];
            } else {
                mesh.isVisible = false;
                mesh.thinInstanceCount = 0;
            }
        }
    }

    private teamMeshes: Mesh[] = [];

    private ensureTeamMeshes(): void {
        if (this.teamMeshes.length > 0) return;
        for (let t = 0; t < this.teamMaterials.length; t++) {
            const mesh = this.defaultMesh.clone(`teamMesh_${t}`);
            mesh.material = this.teamMaterials[t];
            mesh.isVisible = false;
            this.teamMeshes.push(mesh);
        }
    }

    private getTeamMesh(team: number): Mesh {
        return this.teamMeshes[team % this.teamMeshes.length];
    }

    get entityCount(): number {
        return this.entityMeta.size;
    }

    /** Get metadata for all entities (for input hit testing). */
    getEntities(): IterableIterator<[number, EntityMeta]> {
        return this.entityMeta.entries();
    }

    /** Get interpolated position for a specific entity. */
    getEntityPosition(id: number): { x: number; y: number; z: number } | null {
        return this.interpolator.getInterpolated(id);
    }

    /** Remove a specific entity (on EntityDestroy from server). */
    removeEntity(id: number): void {
        this.entityMeta.delete(id);
        this.interpolator.remove(id);
    }

    dispose(): void {
        for (const mesh of this.teamMeshes) mesh.dispose();
        this.teamMeshes = [];
        for (const mesh of this.baseMeshes.values()) mesh.dispose();
        this.baseMeshes.clear();
        this.defaultMesh.dispose();
        this.entityMeta.clear();
        this.interpolator.clear();
        for (const mat of this.teamMaterials) mat.dispose();
    }
}

