/**
 * ProjectileRenderer — renders in-flight projectiles from server state.
 *
 * Receives weapon definitions (visual type, color, size) and per-tick
 * projectile snapshots (position, direction, weapon def id). Groups
 * projectiles by weapon def and renders each group as thin instances
 * of a type-appropriate mesh (sphere for cannon, cylinder for laser,
 * cone for missile, etc.).
 */

import {
    Scene,
    MeshBuilder,
    Mesh,
    StandardMaterial,
    Color3,
    Matrix,
} from '@babylonjs/core';

import type { WeaponDefInfo } from './connection.js';
import type { ProjectileStateSnapshot } from './projectile-state.js';

/** Visual type enum — matches ProjectileVisualType in protocol.fbs */
const enum VisualType {
    Cannon = 0,
    Laser = 1,
    BeamLaser = 2,
    Missile = 3,
    Lightning = 4,
    Flame = 5,
}

/** Default colors per visual type when weapon def doesn't specify one. */
const DEFAULT_COLORS: Record<number, [number, number, number]> = {
    [VisualType.Cannon]:    [1.0, 0.8, 0.2],   // yellow-orange
    [VisualType.Laser]:     [1.0, 0.2, 0.2],   // red
    [VisualType.BeamLaser]: [0.2, 1.0, 0.2],   // green
    [VisualType.Missile]:   [0.8, 0.8, 0.8],   // grey-white
    [VisualType.Lightning]: [0.5, 0.5, 1.0],   // blue-white
    [VisualType.Flame]:     [1.0, 0.4, 0.0],   // orange
};

/** Per-weapon-def rendering template. */
interface WeaponVisual {
    defId: number;
    mesh: Mesh;
    material: StandardMaterial;
    visualType: number;
}

export class ProjectileRenderer {
    private scene: Scene;
    private weaponVisuals = new Map<number, WeaponVisual>();
    private activeCount = 0;

    /** Fallback for projectiles with unknown weapon def. */
    private fallbackVisual: WeaponVisual;

    constructor(scene: Scene) {
        this.scene = scene;
        this.fallbackVisual = this.createVisual(0, VisualType.Cannon, 1.0, [1, 0.8, 0.2], 0.8);
    }

    /**
     * Register weapon definitions from the server.
     * Creates a mesh template + material per weapon def.
     */
    setWeaponDefs(defs: WeaponDefInfo[]): void {
        // Dispose old visuals
        for (const v of this.weaponVisuals.values()) {
            v.mesh.dispose();
            v.material.dispose();
        }
        this.weaponVisuals.clear();

        for (const def of defs) {
            const hasColor = def.colorR > 0 || def.colorG > 0 || def.colorB > 0;
            const color: [number, number, number] = hasColor
                ? [def.colorR, def.colorG, def.colorB]
                : (DEFAULT_COLORS[def.visualType] ?? DEFAULT_COLORS[VisualType.Cannon]);

            const size = Math.max(0.5, def.size > 0 ? def.size : 1.0);
            const intensity = def.intensity > 0 ? def.intensity : 0.8;

            const visual = this.createVisual(def.defId, def.visualType, size, color, intensity);
            this.weaponVisuals.set(def.defId, visual);
        }

        console.log(`[projectile-renderer] registered ${defs.length} weapon visual(s)`);
    }

    /**
     * Update projectile visuals from a server state snapshot.
     * Groups projectiles by weapon def, builds thin instance matrices per group.
     */
    updateFromState(snapshot: ProjectileStateSnapshot): void {
        if (snapshot.count === 0) {
            // Hide all visuals
            for (const v of this.weaponVisuals.values()) {
                v.mesh.isVisible = false;
                v.mesh.thinInstanceCount = 0;
            }
            this.fallbackVisual.mesh.isVisible = false;
            this.fallbackVisual.mesh.thinInstanceCount = 0;
            this.activeCount = 0;
            return;
        }

        // Group projectile indices by weapon def id
        const groups = new Map<number, number[]>();
        for (let i = 0; i < snapshot.count; i++) {
            const wdId = snapshot.weaponDefIds ? snapshot.weaponDefIds[i] : 0;
            let group = groups.get(wdId);
            if (!group) {
                group = [];
                groups.set(wdId, group);
            }
            group.push(i);
        }

        // Track which visuals got updated (to hide the rest)
        const updatedDefs = new Set<number>();
        let totalCount = 0;

        for (const [wdId, indices] of groups) {
            const visual = this.weaponVisuals.get(wdId) ?? this.fallbackVisual;
            const defKey = this.weaponVisuals.has(wdId) ? wdId : -1;
            updatedDefs.add(defKey);

            const matrices = new Float32Array(indices.length * 16);

            for (let j = 0; j < indices.length; j++) {
                const i = indices[j];
                const x = snapshot.positionsX ? snapshot.positionsX[i] : 0;
                const y = snapshot.positionsY ? snapshot.positionsY[i] : 0;
                const z = snapshot.positionsZ ? snapshot.positionsZ[i] : 0;

                const matrix = Matrix.Translation(x, y, z);
                matrix.copyToArray(matrices, j * 16);
            }

            visual.mesh.isVisible = true;
            visual.mesh.thinInstanceSetBuffer('matrix', matrices, 16, false);
            visual.mesh.thinInstanceCount = indices.length;
            totalCount += indices.length;
        }

        // Hide visuals that have no projectiles this frame
        for (const [defId, visual] of this.weaponVisuals) {
            if (!updatedDefs.has(defId)) {
                visual.mesh.isVisible = false;
                visual.mesh.thinInstanceCount = 0;
            }
        }
        if (!updatedDefs.has(-1)) {
            this.fallbackVisual.mesh.isVisible = false;
            this.fallbackVisual.mesh.thinInstanceCount = 0;
        }

        this.activeCount = totalCount;
    }

    get count(): number {
        return this.activeCount;
    }

    dispose(): void {
        for (const v of this.weaponVisuals.values()) {
            v.mesh.dispose();
            v.material.dispose();
        }
        this.weaponVisuals.clear();
        this.fallbackVisual.mesh.dispose();
        this.fallbackVisual.material.dispose();
    }

    private createVisual(
        defId: number,
        visualType: number,
        size: number,
        color: [number, number, number],
        intensity: number,
    ): WeaponVisual {
        const mat = new StandardMaterial(`projMat_${defId}`, this.scene);
        mat.diffuseColor = new Color3(color[0], color[1], color[2]);
        mat.emissiveColor = new Color3(
            color[0] * intensity,
            color[1] * intensity,
            color[2] * intensity,
        );
        mat.specularColor = new Color3(0, 0, 0);

        let mesh: Mesh;
        const baseDiameter = 4 * size;

        switch (visualType) {
            case VisualType.Laser:
                // Elongated cylinder for laser bolts
                mesh = MeshBuilder.CreateCylinder(
                    `proj_${defId}`, { diameter: baseDiameter * 0.4, height: baseDiameter * 3, tessellation: 6 }, this.scene);
                break;
            case VisualType.BeamLaser:
                // Thin long cylinder for beam lasers
                mesh = MeshBuilder.CreateCylinder(
                    `proj_${defId}`, { diameter: baseDiameter * 0.2, height: baseDiameter * 6, tessellation: 6 }, this.scene);
                break;
            case VisualType.Missile:
                // Cone shape for missiles
                mesh = MeshBuilder.CreateCylinder(
                    `proj_${defId}`, { diameterTop: 0, diameterBottom: baseDiameter * 0.8, height: baseDiameter * 2, tessellation: 6 }, this.scene);
                break;
            case VisualType.Lightning:
            case VisualType.Flame:
                // Small sphere for lightning/flame particles
                mesh = MeshBuilder.CreateSphere(
                    `proj_${defId}`, { diameter: baseDiameter * 0.6, segments: 4 }, this.scene);
                break;
            case VisualType.Cannon:
            default:
                // Sphere for cannon shells
                mesh = MeshBuilder.CreateSphere(
                    `proj_${defId}`, { diameter: baseDiameter, segments: 4 }, this.scene);
                break;
        }

        mesh.material = mat;
        mesh.isVisible = false;
        mesh.thinInstanceEnablePicking = false;

        return { defId, mesh, material: mat, visualType };
    }
}
