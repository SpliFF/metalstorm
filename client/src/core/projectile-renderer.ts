/**
 * ProjectileRenderer — placeholder for client-side projectile visuals.
 *
 * Phase 2 stub: creates simple particle-like meshes for active projectiles.
 * Phase 3 will replace these with proper beam lasers, missile trails,
 * explosion effects, etc. per PLAN-events.md.
 *
 * Projectile state will come from the server as part of the entity state
 * stream (projectiles are entities with short lifetimes). For now this
 * module provides the infrastructure for rendering transient visual effects.
 */

import {
    Scene,
    MeshBuilder,
    Mesh,
    StandardMaterial,
    Color3,
    Vector3,
    Matrix,
    Quaternion,
} from '@babylonjs/core';

/** Projectile types matching Spring's weapon categories. */
export enum ProjectileType {
    Cannon = 0,      // ballistic shell
    BeamLaser = 1,   // instant-hit beam
    Missile = 2,     // guided/ballistic missile
    Lightning = 3,   // lightning bolt
    Flame = 4,       // flamethrower stream
}

/** Per-projectile state from the server. */
export interface ProjectileState {
    id: number;
    type: ProjectileType;
    x: number;
    y: number;
    z: number;
    dirX: number;
    dirY: number;
    dirZ: number;
    ttl: number;    // frames remaining
}

export class ProjectileRenderer {
    private scene: Scene;
    private projectileMesh: Mesh;
    private material: StandardMaterial;
    private activeCount = 0;

    constructor(scene: Scene) {
        this.scene = scene;

        // Shared material for all projectiles (bright yellow/orange)
        this.material = new StandardMaterial('projectileMat', scene);
        this.material.diffuseColor = new Color3(1.0, 0.8, 0.2);
        this.material.emissiveColor = new Color3(0.8, 0.5, 0.1);
        this.material.specularColor = new Color3(0, 0, 0);

        // Small sphere as the base projectile mesh
        this.projectileMesh = MeshBuilder.CreateSphere(
            'projectileBase', { diameter: 4, segments: 4 }, scene);
        this.projectileMesh.material = this.material;
        this.projectileMesh.isVisible = false;
        this.projectileMesh.thinInstanceEnablePicking = false;
    }

    /**
     * Update projectile visuals from server state.
     * Currently a no-op until the server streams projectile data.
     */
    updateFromState(projectiles: ProjectileState[]): void {
        if (projectiles.length === 0) {
            this.projectileMesh.isVisible = false;
            this.projectileMesh.thinInstanceCount = 0;
            this.activeCount = 0;
            return;
        }

        const matrices = new Float32Array(projectiles.length * 16);

        for (let i = 0; i < projectiles.length; i++) {
            const p = projectiles[i];
            const matrix = Matrix.Translation(p.x, p.y, p.z);
            matrix.copyToArray(matrices, i * 16);
        }

        this.projectileMesh.isVisible = true;
        this.projectileMesh.thinInstanceSetBuffer('matrix', matrices, 16, false);
        this.projectileMesh.thinInstanceCount = projectiles.length;
        this.activeCount = projectiles.length;
    }

    get count(): number {
        return this.activeCount;
    }

    dispose(): void {
        this.projectileMesh.dispose();
        this.material.dispose();
    }
}
