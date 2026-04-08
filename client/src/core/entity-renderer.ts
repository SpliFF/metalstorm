/**
 * EntityRenderer — manages Babylon.js meshes from entity state snapshots.
 *
 * Creates/updates/removes simple box meshes to visualise entity positions
 * received from the server. Uses snapshot interpolation for smooth movement
 * between ~10Hz server updates.
 */

import {
    Scene,
    MeshBuilder,
    Mesh,
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

export class EntityRenderer {
    private scene: Scene;
    private meshes = new Map<number, Mesh>();
    private materials: StandardMaterial[] = [];
    private templateMesh: Mesh;
    private interpolator = new EntityInterpolator();

    constructor(scene: Scene) {
        this.scene = scene;

        for (let i = 0; i < TEAM_COLORS.length; i++) {
            const mat = new StandardMaterial(`team${i}Mat`, scene);
            mat.diffuseColor = TEAM_COLORS[i];
            mat.specularColor = new Color3(0.3, 0.3, 0.3);
            this.materials.push(mat);
        }

        this.templateMesh = MeshBuilder.CreateBox('entityTemplate', { size: 16 }, scene);
        this.templateMesh.isVisible = false;
    }

    /**
     * Feed a new server snapshot into the interpolator and update metadata.
     * @param isDelta If true, missing entities are kept; if false, they're removed.
     */
    update(snapshot: EntityStateSnapshot, isDelta: boolean = false): void {
        const { count, entityIds, positionsX, positionsY, positionsZ, headings, health, teams } = snapshot;
        if (!entityIds) return;

        const now = performance.now();

        for (let i = 0; i < count; i++) {
            const id = entityIds[i];

            // Ensure mesh exists
            let mesh = this.meshes.get(id);
            if (!mesh) {
                mesh = this.templateMesh.clone(`entity_${id}`);
                mesh.isVisible = true;
                this.meshes.set(id, mesh);
            }

            // Push position into interpolator
            if (positionsX && positionsZ) {
                this.interpolator.pushState(
                    id,
                    positionsX[i],
                    positionsY ? positionsY[i] : 0,
                    positionsZ[i],
                    headings ? headings[i] : 0,
                    now,
                );
            }

            // Team colour (metadata, no interpolation needed)
            if (teams) {
                const teamIdx = teams[i] % this.materials.length;
                mesh.material = this.materials[teamIdx];
            }

            // Health visual
            if (health) {
                const ratio = health[i] / 65535;
                mesh.scaling.y = 0.3 + ratio * 0.7;
            }
        }

        // On full snapshots, remove entities not present
        if (!isDelta) {
            const seen = new Set<number>();
            for (let i = 0; i < count; i++) seen.add(entityIds[i]);

            for (const [id, mesh] of this.meshes) {
                if (!seen.has(id)) {
                    mesh.dispose();
                    this.meshes.delete(id);
                    this.interpolator.remove(id);
                }
            }
        }
    }

    /**
     * Apply interpolated positions to all meshes. Call this every render frame.
     */
    tick(): void {
        const now = performance.now();

        for (const [id, mesh] of this.meshes) {
            const lerped = this.interpolator.getInterpolated(id, now);
            if (lerped) {
                mesh.position.x = lerped.x;
                mesh.position.y = lerped.y;
                mesh.position.z = lerped.z;
                mesh.rotation.y = (lerped.heading / 65535) * Math.PI * 2;
            }
        }
    }

    get entityCount(): number {
        return this.meshes.size;
    }

    dispose(): void {
        for (const mesh of this.meshes.values()) {
            mesh.dispose();
        }
        this.meshes.clear();
        this.interpolator.clear();
        this.templateMesh.dispose();
        for (const mat of this.materials) {
            mat.dispose();
        }
    }
}
