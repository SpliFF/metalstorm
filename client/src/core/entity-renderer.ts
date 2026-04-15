/**
 * EntityRenderer — per-piece thin-instanced entity rendering.
 *
 * Each unit type's glb model is loaded and decomposed into pieces
 * (chassis, turret, arms, legs, etc.). Each piece becomes a separate
 * thin-instance source mesh. All units of the same type share the
 * same piece meshes — 1000 tanks = 1 draw call per piece type, not
 * 1000 draw calls.
 *
 * The piece hierarchy from the glb is preserved so individual pieces
 * can be animated (turret rotation, walking legs) by overriding their
 * local transforms. For now all pieces use their rest pose from the
 * model file.
 *
 * Defs without a model fall back to a single procedural shape using
 * thin instances (box/cylinder/cone/sphere).
 */

import {
    Scene,
    MeshBuilder,
    Mesh,
    TransformNode,
    Matrix,
    Vector3,
    Quaternion,
    StandardMaterial,
    PBRMaterial,
    Color3,
    BoundingInfo,
    SceneLoader,
    Texture,
} from '@babylonjs/core';
import '@babylonjs/loaders/glTF/index.js';
// Register DDS texture loader so Babylon can handle .dds files directly.
import '@babylonjs/core/Materials/Textures/Loaders/ddsTextureLoader.js';
import type { EntityStateSnapshot } from './entity-state.js';
import { EntityInterpolator } from './entity-interpolator.js';
import type { UnitDefInfo } from './connection.js';
import { stampUrl } from '../config.js';

/** Parsed model config from a .config.lua sidecar. */
interface ModelConfig {
    tex1?: string;
    tex2?: string;
    invertteamcolor?: boolean;
}

/**
 * Fetch and parse a model's .config.lua sidecar file. The file is a
 * simple Lua `return { key = value, ... }` table — we extract texture
 * references with regexes rather than running a full Lua parser.
 */
async function fetchModelConfig(modelUrl: string): Promise<ModelConfig | null> {
    // modelUrl is like /api/games/data/zk/models/strikecom.glb
    // config is at /api/games/data/zk/models/strikecom.config.lua
    const configUrl = modelUrl.replace(/\.glb$/, '.config.lua');
    try {
        const resp = await fetch(configUrl);
        if (!resp.ok) return null;
        const lua = await resp.text();

        const tex1 = lua.match(/tex1\s*=\s*"([^"]+)"/)?.[1];
        const tex2 = lua.match(/tex2\s*=\s*"([^"]+)"/)?.[1];
        const invertMatch = lua.match(/invertteamcolor\s*=\s*(true|false)/);
        const invertteamcolor = invertMatch ? invertMatch[1] === 'true' : undefined;

        return { tex1, tex2, invertteamcolor };
    } catch {
        return null;
    }
}

/**
 * Resolve a texture filename from a config (e.g. "strikecom.dds") to
 * a full URL. Textures live in `unittextures/` alongside `models/`.
 */
function resolveTextureUrl(modelUrl: string, textureName: string): string {
    // modelUrl: /api/games/data/zk/models/strikecom.glb
    // texture:  /api/games/data/zk/unittextures/strikecom.dds
    const gameBase = modelUrl.substring(0, modelUrl.lastIndexOf('/models/'));
    return `${gameBase}/unittextures/${textureName}`;
}

/**
 * Apply legacy Spring textures (tex1 = diffuse, tex2 = team color mask)
 * to all meshes in a model. Creates a StandardMaterial with the diffuse
 * texture applied.
 */
function applyLegacyTextures(
    meshes: Mesh[],
    config: ModelConfig,
    modelUrl: string,
    scene: Scene,
): void {
    if (!config.tex1) return;

    const tex1Url = resolveTextureUrl(modelUrl, config.tex1);
    const diffuseTex = new Texture(tex1Url, scene);
    diffuseTex.hasAlpha = false;

    // TODO: tex2 is the team color mask — apply it as a second texture
    // with a custom shader or material plugin to blend team color where
    // the mask is bright. For now, just apply the diffuse texture.

    for (const mesh of meshes) {
        // Replace the default flat material with one that has the texture
        const mat = new StandardMaterial(mesh.name + '_mat', scene);
        mat.diffuseTexture = diffuseTex;
        mat.specularColor = new Color3(0.2, 0.2, 0.2);
        mesh.material = mat;
    }
}

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

/** A single piece (body part) within a model template. */
interface PieceInfo {
    /** The mesh with vertices in piece-local space. */
    mesh: Mesh;
    /** Piece name from the glb node (e.g. "Turret", "LegLeft"). */
    name: string;
    /** Index of the parent piece (-1 for root-level pieces). */
    parentIndex: number;
    /** Local transform relative to parent (from glb hierarchy).
     *  Multiply parent chain to get the rest-pose world matrix. */
    localMatrix: Matrix;
    /** Pre-computed rest-pose world matrix (product of all ancestors'
     *  localMatrix values). Used directly when no animation override. */
    restWorldMatrix: Matrix;
}

/** Loaded model template for a unit def. */
interface ModelTemplate {
    pieces: PieceInfo[];
    /** Vertical offset so the model's base sits at Y=0. */
    yOffset: number;
}

/** Per-piece thin-instance render mesh, keyed by (defId, team, pieceIdx). */
interface PieceRenderEntry {
    mesh: Mesh;
    pieceIdx: number;
}

export class EntityRenderer {
    private scene: Scene;
    private interpolator = new EntityInterpolator();
    private entityMeta = new Map<number, EntityMeta>();
    private teamMaterials: StandardMaterial[] = [];

    // --- Model loading ---
    private modelTemplates = new Map<number, ModelTemplate | null>();
    private modelsReady: Promise<void> = Promise.resolve();
    private defModelUrls = new Map<number, string>();

    // --- Render meshes ---
    // Per-piece thin-instance meshes, keyed by "model:{defId}:{team}:{pieceIdx}"
    // or "shape:{shape}:{team}" for fallbacks.
    private renderMeshes = new Map<string, Mesh>();

    // --- Fallback shape meshes ---
    private shapeMeshes = new Map<number, Mesh>();

    // Selection ring (still uses thin instances directly)
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
     * Register unit defs and start loading their models.
     */
    setUnitDefs(defs: UnitDefInfo[]): void {
        const loadPromises: Promise<void>[] = [];
        let loaded = 0;
        let skipped = 0;
        let alreadyKnown = 0;

        for (const def of defs) {
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

            // Build piece list from the imported hierarchy. We need to
            // map glb nodes to pieces, preserving parent relationships.
            // The glb node tree may contain TransformNodes (no geometry)
            // as structural parents — we keep those as pieces too so the
            // hierarchy chain is unbroken.
            const allNodes = result.meshes as (Mesh | TransformNode)[];
            // Also include transform nodes that aren't meshes
            for (const tn of result.transformNodes || []) {
                if (!allNodes.includes(tn)) allNodes.push(tn);
            }

            // Map each node to an index for parent lookups
            const nodeToIndex = new Map<TransformNode, number>();
            for (let i = 0; i < allNodes.length; i++) {
                nodeToIndex.set(allNodes[i], i);
            }

            // Compute world matrices while hierarchy is intact
            for (const n of allNodes) n.computeWorldMatrix(true);

            // Build piece infos
            const pieces: PieceInfo[] = [];
            const nodeTopiece = new Map<TransformNode, number>();

            for (let i = 0; i < allNodes.length; i++) {
                const node = allNodes[i];
                const isMesh = node instanceof Mesh && node.getTotalVertices() > 0;

                // Skip the __root__ container Babylon creates
                if (node.name === '__root__') continue;

                // Find parent piece index
                let parentIndex = -1;
                let p = node.parent;
                while (p) {
                    if (nodeTopiece.has(p as TransformNode)) {
                        parentIndex = nodeTopiece.get(p as TransformNode)!;
                        break;
                    }
                    p = p.parent;
                }

                // Get local matrix relative to parent
                const localMatrix = node.getWorldMatrix().clone();
                if (parentIndex >= 0) {
                    // localMatrix = parentWorldInverse × worldMatrix
                    const parentWorld = pieces[parentIndex].restWorldMatrix;
                    const parentInv = Matrix.Invert(parentWorld);
                    localMatrix.copyFrom(parentInv.multiply(node.getWorldMatrix()));
                }

                const restWorldMatrix = node.getWorldMatrix().clone();

                const pieceIdx = pieces.length;
                nodeTopiece.set(node, pieceIdx);

                if (isMesh) {
                    const mesh = node as Mesh;
                    // Detach from hierarchy, keep vertices in piece-local space
                    mesh.parent = null;
                    mesh.position.set(0, 0, 0);
                    mesh.rotationQuaternion = Quaternion.Identity();
                    mesh.scaling.set(1, 1, 1);
                    mesh.isPickable = false;
                    mesh.isVisible = false;
                    mesh.thinInstanceEnablePicking = false;
                    mesh.alwaysSelectAsActiveMesh = true;
                    mesh.setBoundingInfo(new BoundingInfo(
                        new Vector3(-1e6, -1e6, -1e6),
                        new Vector3(1e6, 1e6, 1e6),
                    ));
                    mesh.renderingGroupId = 2;

                    pieces.push({
                        mesh,
                        name: node.name,
                        parentIndex,
                        localMatrix,
                        restWorldMatrix,
                    });
                } else {
                    // Structural node (no geometry) — still needed for
                    // hierarchy chain. Use a dummy mesh reference.
                    pieces.push({
                        mesh: null!,
                        name: node.name,
                        parentIndex,
                        localMatrix,
                        restWorldMatrix,
                    });
                    // Hide the node
                    node.setEnabled(false);
                }
            }

            // Filter to only pieces with geometry for rendering
            const geometryPieces = pieces.filter(p => p.mesh != null);

            if (geometryPieces.length === 0) {
                console.warn(`[entity-renderer] ${def.name}: glb has no geometry`);
                return null;
            }

            // Compute yOffset from rest-pose bounding boxes so the
            // model's base sits at Y=0.
            let minY = Infinity;
            for (const p of geometryPieces) {
                // Transform the piece-local bounding box by its rest
                // world matrix to get the actual Y extent.
                p.mesh.refreshBoundingInfo();
                const bb = p.mesh.getBoundingInfo().boundingBox;
                // Transform min/max corners by the rest world matrix
                const corners = [
                    Vector3.TransformCoordinates(bb.minimum, p.restWorldMatrix),
                    Vector3.TransformCoordinates(bb.maximum, p.restWorldMatrix),
                ];
                for (const c of corners) {
                    if (c.y < minY) minY = c.y;
                }
            }
            const yOffset = -minY;

            // Fetch model config (tex1/tex2/etc) and apply textures.
            // This runs in parallel with nothing — the model is already
            // loaded, we just need the texture metadata.
            const config = await fetchModelConfig(def.modelUrl);
            if (config?.tex1) {
                const meshesWithGeometry = geometryPieces.map(p => p.mesh);
                applyLegacyTextures(meshesWithGeometry, config, def.modelUrl, this.scene);
            }

            console.log(
                `[entity-renderer] ${def.name}: model loaded, ` +
                `${geometryPieces.length} piece(s) with geometry, ` +
                `${pieces.length} total nodes, yOffset=${yOffset.toFixed(1)}` +
                (config?.tex1 ? `, tex1=${config.tex1}` : ''),
            );

            return { pieces, yOffset };
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
     * Build a fallback Mesh for one (shape, team) pair.
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

    /**
     * Get or create the thin-instance render mesh for a specific piece
     * of a specific (defId, team). Clones the template piece mesh.
     */
    private getOrCreatePieceMesh(defId: number, team: number, pieceIdx: number, piece: PieceInfo): Mesh {
        const key = `model:${defId}:${team}:${pieceIdx}`;
        let mesh = this.renderMeshes.get(key);
        if (!mesh) {
            mesh = piece.mesh.clone(`unit_${defId}_t${team}_p${pieceIdx}_${piece.name}`);
            mesh.makeGeometryUnique();

            if (!mesh.material) {
                const teamColor = TEAM_COLORS[team % TEAM_COLORS.length];
                const mat = new StandardMaterial(`unit_${defId}_t${team}_p${pieceIdx}_mat`, this.scene);
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

    private getFallbackMesh(defId: number, team: number): Mesh {
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

        // Collect per-piece instance matrices.
        // Key: render mesh key → { mesh, matrices[], count }
        const groups = new Map<string, { mesh: Mesh; matrices: number[]; count: number }>();

        for (const [id, meta] of this.entityMeta) {
            const lerped = this.interpolator.getInterpolated(id, now);
            if (!lerped) continue;

            const tmpl = this.modelTemplates.get(meta.defId);

            if (tmpl) {
                // Entity world transform
                const rotation = (lerped.heading / 65535) * Math.PI * 2;
                const entityMatrix = Matrix.Compose(
                    new Vector3(1, 1, 1),
                    Quaternion.RotationYawPitchRoll(rotation, 0, 0),
                    new Vector3(lerped.x, lerped.y + tmpl.yOffset, lerped.z),
                );

                // Push one instance matrix per piece with geometry
                for (let pi = 0; pi < tmpl.pieces.length; pi++) {
                    const piece = tmpl.pieces[pi];
                    if (!piece.mesh) continue; // structural node, no geometry

                    const key = `model:${meta.defId}:${meta.team}:${pi}`;
                    let group = groups.get(key);
                    if (!group) {
                        const mesh = this.getOrCreatePieceMesh(meta.defId, meta.team, pi, piece);
                        group = { mesh, matrices: [], count: 0 };
                        groups.set(key, group);
                    }

                    // Instance matrix = entityWorld × pieceRestWorld
                    // This places piece-local vertices into final world position.
                    const instanceMatrix = piece.restWorldMatrix.multiply(entityMatrix);
                    const arr = new Float32Array(16);
                    instanceMatrix.copyToArray(arr, 0);
                    for (let j = 0; j < 16; j++) group.matrices.push(arr[j]);
                    group.count++;
                }
            } else {
                // Fallback shape
                const shape = defIdToShape(meta.defId);
                const teamIdx = meta.team % this.teamMaterials.length;
                const key = `shape:${shape}:${teamIdx}`;
                let group = groups.get(key);
                if (!group) {
                    const mesh = this.getFallbackMesh(meta.defId, meta.team);
                    group = { mesh, matrices: [], count: 0 };
                    groups.set(key, group);
                }

                const rotation = (lerped.heading / 65535) * Math.PI * 2;
                const matrix = Matrix.Compose(
                    new Vector3(1, meta.healthScale, 1),
                    Quaternion.RotationYawPitchRoll(rotation, 0, 0),
                    new Vector3(lerped.x, lerped.y, lerped.z),
                );
                const arr = new Float32Array(16);
                matrix.copyToArray(arr, 0);
                for (let j = 0; j < 16; j++) group.matrices.push(arr[j]);
                group.count++;
            }
        }

        // Update render meshes
        const activeKeys = new Set<string>();
        for (const [key, group] of groups) {
            activeKeys.add(key);
            group.mesh.isVisible = true;
            const buf = new Float32Array(group.matrices);
            group.mesh.thinInstanceSetBuffer('matrix', buf, 16, false);
            group.mesh.thinInstanceCount = group.count;
        }

        // Hide meshes not active this frame
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
        for (const tmpl of this.modelTemplates.values()) {
            if (tmpl) {
                for (const p of tmpl.pieces) {
                    if (p.mesh) p.mesh.dispose();
                }
            }
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
