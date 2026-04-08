/**
 * EntityRenderer — manages Babylon.js meshes from entity state snapshots.
 *
 * Creates/updates/removes simple box meshes to visualise entity positions
 * received from the server. This is a placeholder renderer — Phase 2 will
 * replace boxes with real unit models via thin instances.
 */

import {
    Scene,
    MeshBuilder,
    Mesh,
    StandardMaterial,
    Color3,
    Vector3,
} from '@babylonjs/core';
import type { EntityStateSnapshot } from './entity-state.js';

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

    constructor(scene: Scene) {
        this.scene = scene;

        // Create shared materials per team
        for (let i = 0; i < TEAM_COLORS.length; i++) {
            const mat = new StandardMaterial(`team${i}Mat`, scene);
            mat.diffuseColor = TEAM_COLORS[i];
            mat.specularColor = new Color3(0.3, 0.3, 0.3);
            this.materials.push(mat);
        }

        // Template mesh (hidden) — cloned for each entity
        this.templateMesh = MeshBuilder.CreateBox('entityTemplate', { size: 16 }, scene);
        this.templateMesh.isVisible = false;
    }

    /** Apply a new entity state snapshot — create, update, and remove meshes. */
    update(snapshot: EntityStateSnapshot): void {
        const { count, entityIds, positionsX, positionsY, positionsZ, headings, health, teams } = snapshot;
        if (!entityIds) return;

        const seen = new Set<number>();

        for (let i = 0; i < count; i++) {
            const id = entityIds[i];
            seen.add(id);

            let mesh = this.meshes.get(id);
            if (!mesh) {
                mesh = this.templateMesh.clone(`entity_${id}`);
                mesh.isVisible = true;
                this.meshes.set(id, mesh);
            }

            // Position — Spring coords: X = right, Y = up, Z = forward
            // Babylon coords: same convention (Y-up)
            if (positionsX && positionsZ) {
                mesh.position.x = positionsX[i];
                mesh.position.z = positionsZ[i];
            }
            if (positionsY) {
                mesh.position.y = positionsY[i];
            }

            // Heading — u16 (0–65535) maps to 0°–360°
            if (headings) {
                mesh.rotation.y = (headings[i] / 65535) * Math.PI * 2;
            }

            // Team colour
            if (teams) {
                const teamIdx = teams[i] % this.materials.length;
                mesh.material = this.materials[teamIdx];
            }

            // Health — scale Y to show damage (simple visual indicator)
            if (health) {
                const ratio = health[i] / 65535;
                mesh.scaling.y = 0.3 + ratio * 0.7; // 30%–100% height
            }
        }

        // Remove meshes for entities no longer in the snapshot
        for (const [id, mesh] of this.meshes) {
            if (!seen.has(id)) {
                mesh.dispose();
                this.meshes.delete(id);
            }
        }
    }

    /** Number of currently rendered entities. */
    get entityCount(): number {
        return this.meshes.size;
    }

    dispose(): void {
        for (const mesh of this.meshes.values()) {
            mesh.dispose();
        }
        this.meshes.clear();
        this.templateMesh.dispose();
        for (const mat of this.materials) {
            mat.dispose();
        }
    }
}
