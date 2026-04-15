/**
 * EntityRenderer — thin-instanced entity rendering with real models.
 *
 * When the server sends GameUnitDefs, this renderer preloads each
 * unit type's .glb model. Entities are grouped by (defId, team) for
 * batched draw calls via thin instances. Defs without a model fall
 * back to coloured procedural shapes (box/cylinder/cone/sphere).
 *
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
    BoundingInfo,
    SceneLoader,
} from '@babylonjs/core';
// Register glTF loader plugin so SceneLoader can read .glb files.
import '@babylonjs/loaders/glTF/index.js';
import type { EntityStateSnapshot } from './entity-state.js';
import { EntityInterpolator } from './entity-interpolator.js';
import type { UnitDefInfo } from './connection.js';
import { stampUrl } from '../config.js';

const TEAM_COLORS = [
    new Color3(0.2, 0.5, 1.0),
    new Color3(1.0, 0.3, 0.2),
    new Color3(0.2, 0.8, 0.3),
    new Color3(1.0, 0.8, 0.1),
];

// Fallback shape types for defs without models
enum UnitShape { Box = 0, Cylinder, Cone, Sphere }
const SHAPE_COUNT = 4;

function defIdToShape(defId: number): UnitShape {
    return (defId % SHAPE_COUNT) as UnitShape;
}

export interface EntityMeta {
    defId: number;
    team: number;
    healthScale: number;
}

/** Loaded model template for a unit def — the mesh used as thin-instance source. */
interface ModelTemplate {
    mesh: Mesh;
    /** Vertical offset to shift the model up so its base sits at Y=0.
     *  Computed from the bounding box minimum Y after import. */
    yOffset: number;
}

export class EntityRenderer {
    private scene: Scene;
    private interpolator = new EntityInterpolator();
    private entityMeta = new Map<number, EntityMeta>();
    private teamMaterials: StandardMaterial[] = [];

    // --- Model loading ---
    /** defId → loaded model template (null = no model, use fallback shape). */
    private modelTemplates = new Map<number, ModelTemplate | null>();
    /** Resolves when all model preloading is complete. */
    private modelsReady: Promise<void> = Promise.resolve();
    /** defId → modelUrl for logging/debugging. */
    private defModelUrls = new Map<number, string>();

    // --- Render meshes ---
    // Keyed by a string `"model:{defId}:{team}"` or `"shape:{shape}:{team}"`.
    // Each key owns its own Mesh so thin-instance buffers don't collide.
    private renderMeshes = new Map<string, Mesh>();

    // --- Fallback shape meshes (created on demand) ---
    private shapeMeshes = new Map<number, Mesh>();

    // Selection ring
    private selectionMesh: Mesh | null = null;
    private selectedIds: number[] = [];

    constructor(scene: Scene) {
        this.scene = scene;

        for (let i = 0; i < TEAM_COLORS.length; i++) {
            const mat = new StandardMaterial(`team${i}Mat`, scene);
            mat.diffuseColor = TEAM_COLORS[i];
            mat.specularColor = new Color3(0.3, 0.3, 0.3);
            this.teamMaterials.push(mat);
        }
    }

    /**
     * Register unit defs and start loading their models. Called
     * incrementally as the server streams defs for newly encountered
     * unit types — safe to call multiple times with overlapping sets.
     */
    setUnitDefs(defs: UnitDefInfo[]): void {
        const loadPromises: Promise<void>[] = [];
        let loaded = 0;
        let skipped = 0;
        let alreadyKnown = 0;

        for (const def of defs) {
            // Skip defs we already know about
            if (this.defModelUrls.has(def.defId)) {
                alreadyKnown++;
                continue;
            }

            this.defModelUrls.set(def.defId, def.modelUrl);

            if (!def.modelUrl) {
                this.modelTemplates.set(def.defId, null);
                skipped++;
                continue;
            }

            loadPromises.push(this.loadModel(def).then(tmpl => {
                this.modelTemplates.set(def.defId, tmpl);
                if (tmpl) loaded++;
                else skipped++;
            }));
        }

        if (loadPromises.length > 0 || skipped > 0) {
            const batchReady = Promise.all(loadPromises).then(() => {
                console.log(
                    `[entity-renderer] defs batch: ${loaded} loaded, ${skipped} fallback` +
                    (alreadyKnown > 0 ? `, ${alreadyKnown} already known` : '')
                );
            });
            // Chain onto any outstanding load promises
            this.modelsReady = this.modelsReady.then(() => batchReady);
        }
    }

    private async loadModel(def: UnitDefInfo): Promise<ModelTemplate | null> {
        try {
            const lastSlash = def.modelUrl.lastIndexOf('/');
            const baseUrl = def.modelUrl.substring(0, lastSlash + 1);
            const fileName = def.modelUrl.substring(lastSlash + 1);

            const result = await SceneLoader.ImportMeshAsync(
                '', baseUrl, stampUrl(fileName), this.scene,
            );

            // Pick the first mesh with actual geometry
            let primary: Mesh | null = null;
            for (const m of result.meshes) {
                if (m instanceof Mesh && m.getTotalVertices() > 0) {
                    primary = m;
                    break;
                }
            }

            if (!primary) {
                console.warn(`[entity-renderer] ${def.name}: glb has no geometry`);
                return null;
            }

            // Compute bounding box BEFORE detaching from the import
            // hierarchy so world transforms are included.
            primary.refreshBoundingInfo();
            const bb = primary.getBoundingInfo().boundingBox;
            const yOffset = -bb.minimumWorld.y;

            // Hide all imported meshes except the primary, and detach
            // it from the import root so its transform is independent.
            for (const m of result.meshes) {
                if (m !== primary) m.setEnabled(false);
            }
            primary.parent = null;
            primary.position.set(0, 0, 0);
            primary.rotationQuaternion = Quaternion.Identity();
            primary.scaling.set(1, 1, 1);
            primary.isPickable = false;
            primary.isVisible = false; // Hidden until instances are set
            primary.thinInstanceEnablePicking = false;
            primary.alwaysSelectAsActiveMesh = true;
            primary.setBoundingInfo(new BoundingInfo(
                new Vector3(-1e6, -1e6, -1e6),
                new Vector3(1e6, 1e6, 1e6),
            ));
            primary.renderingGroupId = 2;

            console.log(
                `[entity-renderer] ${def.name}: model loaded, ` +
                `yOffset=${yOffset.toFixed(1)}, verts=${primary.getTotalVertices()}`,
            );

            return { mesh: primary, yOffset };
        } catch (err) {
            console.warn(
                `[entity-renderer] ${def.name}: failed to load ${def.modelUrl}`,
                err,
            );
            return null;
        }
    }

    /** Replace the selected-unit id list. Called by InputManager. */
    setSelection(ids: readonly number[]): void {
        this.selectedIds = ids.slice();
    }

    /**
     * Build a fallback Mesh for one (shape, team) pair. Each shape is
     * shifted upward by half its height and baked so the base sits at y=0.
     */
    private buildFallbackMesh(shape: UnitShape, team: number): Mesh {
        const name = `render_fallback_${shape}_${team}`;
        let mesh: Mesh;
        let height: number;
        switch (shape) {
            case UnitShape.Box:
                height = 12;
                mesh = MeshBuilder.CreateBox(name, { width: 16, height, depth: 20 }, this.scene);
                break;
            case UnitShape.Cylinder:
                height = 14;
                mesh = MeshBuilder.CreateCylinder(name, { height, diameter: 18, tessellation: 8 }, this.scene);
                break;
            case UnitShape.Cone:
                height = 16;
                mesh = MeshBuilder.CreateCylinder(name, { height, diameterTop: 0, diameterBottom: 16, tessellation: 8 }, this.scene);
                break;
            case UnitShape.Sphere:
            default:
                height = 14;
                mesh = MeshBuilder.CreateSphere(name, { diameter: 14, segments: 6 }, this.scene);
                break;
        }
        mesh.position.y = height / 2;
        mesh.bakeCurrentTransformIntoVertices();
        mesh.material = this.teamMaterials[team];
        mesh.thinInstanceEnablePicking = false;
        mesh.alwaysSelectAsActiveMesh = true;
        mesh.setBoundingInfo(new BoundingInfo(
            new Vector3(-1e6, -1e6, -1e6),
            new Vector3(1e6, 1e6, 1e6),
        ));
        mesh.renderingGroupId = 2;
        return mesh;
    }

    /** Compute the render-group key for a (defId, team) pair. */
    private renderKey(defId: number, team: number): string {
        const tmpl = this.modelTemplates.get(defId);
        if (tmpl) return `model:${defId}:${team}`;
        const shape = defIdToShape(defId);
        const teamIdx = team % this.teamMaterials.length;
        return `shape:${shape}:${teamIdx}`;
    }

    /**
     * Get or create a render mesh for a (defId, team) pair. If a model
     * template exists for this defId, clone it and apply team material.
     * Otherwise fall back to a procedural shape.
     */
    private getOrCreateRenderMesh(defId: number, team: number): Mesh {
        const tmpl = this.modelTemplates.get(defId);
        if (tmpl) {
            const key = `model:${defId}:${team}`;
            let mesh = this.renderMeshes.get(key);
            if (!mesh) {
                // Clone the template so each team gets its own thin-instance buffer
                mesh = tmpl.mesh.clone(`unit_${defId}_team${team}`);
                mesh.makeGeometryUnique();

                // Preserve the original material (PBR from glTF) if
                // present — it has textures and proper lighting. Only
                // fall back to a flat team-colour material when the
                // model has no material at all.
                if (!mesh.material) {
                    const teamColor = TEAM_COLORS[team % TEAM_COLORS.length];
                    const mat = new StandardMaterial(`unit_${defId}_team${team}_mat`, this.scene);
                    mat.diffuseColor = teamColor;
                    mat.specularColor = new Color3(0.3, 0.3, 0.3);
                    mesh.material = mat;
                }

                mesh.isPickable = false;
                mesh.isVisible = false;
                mesh.thinInstanceEnablePicking = false;
                mesh.alwaysSelectAsActiveMesh = true;
                mesh.setBoundingInfo(new BoundingInfo(
                    new Vector3(-1e6, -1e6, -1e6),
                    new Vector3(1e6, 1e6, 1e6),
                ));
                mesh.renderingGroupId = 2;
                this.renderMeshes.set(key, mesh);
            }
            return mesh;
        }

        // Fallback: procedural shape
        const shape = defIdToShape(defId);
        const teamIdx = team % this.teamMaterials.length;
        const key = `shape:${shape}:${teamIdx}`;
        let mesh = this.renderMeshes.get(key);
        if (!mesh) {
            mesh = this.buildFallbackMesh(shape, teamIdx);
            this.renderMeshes.set(key, mesh);
        }
        return mesh;
    }

    /**
     * Build the selection-ring template on first use.
     */
    private ensureSelectionMesh(): Mesh {
        if (this.selectionMesh) return this.selectionMesh;
        const mesh = MeshBuilder.CreateTorus('selection_ring', {
            diameter: 26,
            thickness: 3,
            tessellation: 24,
        }, this.scene);
        mesh.scaling.y = 0.15;
        mesh.bakeCurrentTransformIntoVertices();

        const mat = new StandardMaterial('selectionMat', this.scene);
        mat.diffuseColor = new Color3(0, 0, 0);
        mat.emissiveColor = new Color3(1.0, 0.9, 0.2);
        mat.specularColor = new Color3(0, 0, 0);
        mat.disableLighting = true;
        mesh.material = mat;

        mesh.thinInstanceEnablePicking = false;
        mesh.alwaysSelectAsActiveMesh = true;
        mesh.setBoundingInfo(new BoundingInfo(
            new Vector3(-1e6, -1e6, -1e6),
            new Vector3(1e6, 1e6, 1e6),
        ));
        mesh.renderingGroupId = 3;
        mesh.isVisible = false;
        this.selectionMesh = mesh;
        return mesh;
    }

    private updateSelectionRings(now: number): void {
        if (this.selectedIds.length === 0) {
            if (this.selectionMesh) {
                this.selectionMesh.isVisible = false;
                this.selectionMesh.thinInstanceCount = 0;
            }
            return;
        }

        const mesh = this.ensureSelectionMesh();
        const matrices: number[] = [];
        let count = 0;
        const tmp = new Float32Array(16);
        for (const id of this.selectedIds) {
            const p = this.interpolator.getInterpolated(id, now);
            if (!p) continue;
            const m = Matrix.Compose(
                new Vector3(1, 1, 1),
                Quaternion.Identity(),
                new Vector3(p.x, p.y + 1.0, p.z),
            );
            m.copyToArray(tmp, 0);
            for (let j = 0; j < 16; j++) matrices.push(tmp[j]);
            count++;
        }

        if (count === 0) {
            mesh.isVisible = false;
            mesh.thinInstanceCount = 0;
            return;
        }

        mesh.isVisible = true;
        const buf = new Float32Array(matrices);
        mesh.thinInstanceSetBuffer('matrix', buf, 16, false);
        mesh.thinInstanceCount = count;
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

        // Collect matrices grouped by render mesh key
        const groups = new Map<string, { mesh: Mesh; matrices: number[]; count: number }>();

        for (const [id, meta] of this.entityMeta) {
            const lerped = this.interpolator.getInterpolated(id, now);
            if (!lerped) continue;

            const key = this.renderKey(meta.defId, meta.team);
            let group = groups.get(key);
            if (!group) {
                const mesh = this.getOrCreateRenderMesh(meta.defId, meta.team);
                group = { mesh, matrices: [], count: 0 };
                groups.set(key, group);
            }

            const rotation = (lerped.heading / 65535) * Math.PI * 2;
            // Apply yOffset from model bounding box so the base sits
            // on the ground rather than the model being half-buried.
            const tmpl = this.modelTemplates.get(meta.defId);
            const yOff = tmpl?.yOffset ?? 0;
            const matrix = Matrix.Compose(
                new Vector3(1, meta.healthScale, 1),
                Quaternion.RotationYawPitchRoll(rotation, 0, 0),
                new Vector3(lerped.x, lerped.y + yOff, lerped.z),
            );

            const arr = new Float32Array(16);
            matrix.copyToArray(arr, 0);
            for (let j = 0; j < 16; j++) group.matrices.push(arr[j]);
            group.count++;
        }

        // Update render meshes — show groups with instances, hide empty ones
        const activeKeys = new Set<string>();
        for (const [key, group] of groups) {
            activeKeys.add(key);
            group.mesh.isVisible = true;
            const buf = new Float32Array(group.matrices);
            group.mesh.thinInstanceSetBuffer('matrix', buf, 16, false);
            group.mesh.thinInstanceCount = group.count;
        }

        // Hide meshes that had instances last frame but don't this frame
        for (const [rKey, mesh] of this.renderMeshes) {
            if (!activeKeys.has(rKey)) {
                mesh.isVisible = false;
                mesh.thinInstanceCount = 0;
            }
        }

        this.updateSelectionRings(now);
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
        // Dispose model templates
        for (const tmpl of this.modelTemplates.values()) {
            if (tmpl) tmpl.mesh.dispose();
        }
        this.modelTemplates.clear();
        if (this.selectionMesh) {
            this.selectionMesh.dispose();
            this.selectionMesh = null;
        }
        this.selectedIds = [];
        this.entityMeta.clear();
        this.interpolator.clear();
        for (const mat of this.teamMaterials) mat.dispose();
    }
}
