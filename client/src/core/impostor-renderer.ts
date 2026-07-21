/**
 * ImpostorRenderer — billboard/impostor LOD tier for distant units.
 *
 * Per PLAN-metalstorm-beta-units.md §2.1: every unit has up to three
 * representations — full model, impostor (camera-facing quad), and icon.
 * This module handles the impostor tier: textured quads with atlas frames
 * selected by quantized heading (8 views) × animation flipbook frame.
 *
 * Architecture:
 * - One mesh per (defId, team), thin-instanced across all units of that type
 * - Per-instance attributes: world position, heading (for frame select), team ID
 * - Atlas texture: 8 headings × N animation frames (walk, idle), team mask
 * - Heading quantization: unit's rotation → nearest 45° heading → atlas column
 * - Animation frame: driven by velocity/state (coordinated with fx-offload X4)
 *
 * Coordination with PLAN-fx-offload.md X2 (piece-transform texture / animation):
 * The per-instance attribute pattern here (heading, animFrame, teamId) is
 * COMPATIBLE with X2's planned data-texture substrate — when X2 lands, both
 * the impostor path and the full-model skinning path will share the same
 * instance-data structures. This implementation deliberately uses a subset of
 * X2's eventual schema so no breaking changes are required later.
 *
 * FIDELITY NOTE: This is the simplified impostor path (no authored atlases
 * yet, no baked impostor generation pipeline). The renderer is **ready** for
 * atlases once beta-units B1 lands; for now it renders a placeholder.
 */

import {
    Scene,
    Mesh,
    MeshBuilder,
    Vector3,
    Matrix,
    StandardMaterial,
    Texture,
    Color3,
    Engine,
    type CascadedShadowGenerator,
} from '@babylonjs/core';
import type { PresentationClock } from './presentation-clock.js';
import type { EntityStateSnapshot } from './entity-state.js';

/** Impostor atlas metadata — per unit def. Sourced from the def's client
 *  content or auto-derived from the model. */
export interface ImpostorAtlas {
    /** Atlas texture URI (diffuse + alpha). 8 columns (headings 0°, 45°, …, 315°)
     *  × N rows (animation frames: walk[0..k], idle[0..m]). */
    diffuseUri: string;
    /** Team-color mask atlas URI (R = blend amount, same layout). */
    teamMaskUri?: string;
    /** Number of walk-cycle frames (atlas rows [0, walkFrames)). */
    walkFrames: number;
    /** Number of idle frames (atlas rows [walkFrames, walkFrames+idleFrames)). */
    idleFrames: number;
    /** Quad size in world units (elmos). Derived from model bounds. */
    width: number;
    height: number;
}

/** LOD tier — drives EntityRenderer's per-entity visibility decision. */
export enum LodTier {
    /** Full 3D model, all pieces, thin-instanced per piece. */
    Full = 'full',
    /** Camera-facing billboard quad, atlas frame by heading × anim. */
    Impostor = 'impostor',
    /** Strategic map symbol (not rendered by EntityRenderer). */
    Icon = 'icon',
}

/** Per-def LOD thresholds (world-space distance from camera). */
export interface LodThresholds {
    /** Distance beyond which to switch from Full → Impostor (elmos). */
    impostorDistance: number;
    /** Distance beyond which to switch from Impostor → Icon (elmos). */
    iconDistance: number;
}

/** Per-instance impostor data (populated by EntityRenderer each frame). */
interface ImpostorInstance {
    /** Entity world position (XYZ). */
    x: number;
    y: number;
    z: number;
    /** Unit's heading in radians (0 = +Z, π/2 = +X, Babylon RH). */
    heading: number;
    /** Current animation frame index (0-based row in the atlas). */
    animFrame: number;
    /** Team ID (for team-colour shader). */
    team: number;
}

/** Quantize a heading (radians) to the nearest atlas column (0–7). */
function quantizeHeading(radians: number): number {
    // 8 headings: 0° (col 0), 45° (col 1), ..., 315° (col 7)
    // Normalize to [0, 2π), then divide into 8 bins
    let normalized = radians % (2 * Math.PI);
    if (normalized < 0) normalized += 2 * Math.PI;
    return Math.floor((normalized + Math.PI / 8) / (Math.PI / 4)) % 8;
}

/** Impostor quad renderer — one mesh per (defId, team), thin-instanced. */
export class ImpostorRenderer {
    private scene: Scene;
    private engine: Engine;

    /** Impostor meshes keyed by "impostor:{defId}:{team}". */
    private impostorMeshes = new Map<string, Mesh>();

    /** Atlas metadata per def. Populated lazily when a def streams. */
    private atlases = new Map<number, ImpostorAtlas>();

    /** LOD thresholds per def. */
    private lodThresholds = new Map<number, LodThresholds>();

    /** Presentation clock (drives animation frame timing). */
    private clock: PresentationClock | null = null;

    /** Shadow generator (if impostors should cast shadows). */
    private shadowGenerator: CascadedShadowGenerator | null = null;

    /** Pending instance data per (defId, team), drained each render. */
    private pendingInstances = new Map<string, ImpostorInstance[]>();

    constructor(scene: Scene, engine: Engine) {
        this.scene = scene;
        this.engine = engine;
    }

    setPresentationClock(clock: PresentationClock): void {
        this.clock = clock;
    }

    setShadowGenerator(gen: CascadedShadowGenerator | null): void {
        this.shadowGenerator = gen;
    }

    /** Register an impostor atlas for a def (called when def streams). */
    registerAtlas(defId: number, atlas: ImpostorAtlas): void {
        this.atlases.set(defId, atlas);
    }

    /** Register LOD thresholds for a def. */
    registerLodThresholds(defId: number, thresholds: LodThresholds): void {
        this.lodThresholds.set(defId, thresholds);
    }

    /** Add one impostor instance to the pending batch (called per visible entity). */
    addInstance(defId: number, team: number, x: number, y: number, z: number, heading: number): void {
        const key = `impostor:${defId}:${team}`;
        let batch = this.pendingInstances.get(key);
        if (!batch) {
            batch = [];
            this.pendingInstances.set(key, batch);
        }

        // FIDELITY-STANDIN: animation frame logic simplified.
        // Real implementation: check snapshot.state_anim (MOVING/IDLE),
        // sample gait phase from velocity × time → walk flipbook frame,
        // or use idle frame. For now: frame 0 always.
        const animFrame = 0;

        batch.push({
            x,
            y,
            z,
            heading,
            animFrame,
            team,
        });
    }

    /** Flush pending instances → thin-instance buffers. Called per render. */
    render(cameraPos: Vector3): void {
        // Group instances per mesh
        const groups = new Map<string, {
            mesh: Mesh;
            matrices: number[];
            headings: number[];
            frames: number[];
            count: number;
        }>();

        for (const [key, instances] of this.pendingInstances) {
            if (instances.length === 0) continue;

            const [, defIdStr, teamStr] = key.split(':');
            const defId = Number(defIdStr);
            const team = Number(teamStr);

            const mesh = this.getOrCreateImpostorMesh(defId, team);
            if (!mesh) continue;

            const group = {
                mesh,
                matrices: [] as number[],
                headings: [] as number[],
                frames: [] as number[],
                count: 0,
            };

            for (const inst of instances) {
                // World matrix: translation only (quad faces camera, no rotation)
                const mat = Matrix.Translation(inst.x, inst.y, inst.z);
                const arr = new Float32Array(16);
                mat.copyToArray(arr, 0);
                for (let i = 0; i < 16; i++) group.matrices.push(arr[i]);

                // Per-instance heading (for atlas column select)
                group.headings.push(quantizeHeading(inst.heading));
                // Per-instance anim frame (atlas row)
                group.frames.push(inst.animFrame);
                group.count++;
            }

            groups.set(key, group);
        }

        // Update mesh buffers
        for (const [key, group] of groups) {
            group.mesh.isVisible = true;
            const matBuf = new Float32Array(group.matrices);
            group.mesh.thinInstanceSetBuffer('matrix', matBuf, 16, false);

            // FIDELITY-STANDIN: per-instance heading/frame attributes not yet wired.
            // When fx-offload X2 lands, these become custom vertex attributes
            // (thinInstanceSetBuffer('heading', …) + shader reads). For now the
            // shader uses a fixed atlas frame (column 0, row 0).
            // TODO(fx-offload-X2): thinInstanceSetBuffer('heading', Float32Array(group.headings), 1)
            // TODO(fx-offload-X2): thinInstanceSetBuffer('animFrame', Float32Array(group.frames), 1)

            group.mesh.thinInstanceCount = group.count;
            group.mesh.thinInstanceRefreshBoundingInfo(false);
        }

        // Hide meshes not active this frame
        for (const [key, mesh] of this.impostorMeshes) {
            if (!groups.has(key)) {
                mesh.isVisible = false;
                mesh.thinInstanceCount = 0;
            }
        }

        // Clear pending
        this.pendingInstances.clear();
    }

    /** Get or create the impostor mesh for (defId, team). */
    private getOrCreateImpostorMesh(defId: number, team: number): Mesh | null {
        const key = `impostor:${defId}:${team}`;
        let mesh = this.impostorMeshes.get(key);
        if (mesh) return mesh;

        const atlas = this.atlases.get(defId);
        if (!atlas) {
            // No atlas registered yet — skip. EntityRenderer will retry
            // next frame once defs stream.
            console.warn(`[ImpostorRenderer] no atlas for def ${defId} (not yet registered)`);
            return null;
        }

        // Create a camera-facing billboard quad
        mesh = MeshBuilder.CreatePlane(
            `impostor_${defId}_${team}`,
            { width: atlas.width, height: atlas.height },
            this.scene,
        );
        mesh.billboardMode = Mesh.BILLBOARDMODE_ALL;
        mesh.isPickable = false;
        mesh.alwaysSelectAsActiveMesh = true;

        // FIDELITY-STANDIN: material + atlas texture binding simplified.
        // Real implementation: load atlas.diffuseUri + atlas.teamMaskUri,
        // bind to a shader with heading/frame → UV offset logic. For now:
        // a placeholder grey material (impostor path is inert until atlases land).
        const mat = new StandardMaterial(`impostor_mat_${defId}_${team}`, this.scene);
        mat.diffuseColor = new Color3(0.6, 0.6, 0.6);
        mat.specularColor = new Color3(0, 0, 0);
        mat.emissiveColor = new Color3(0, 0, 0);
        mat.alpha = 1.0;
        mesh.material = mat;

        // TODO(beta-units-B1): load atlas textures
        // const diffuseTex = new Texture(atlas.diffuseUri, this.scene);
        // mat.diffuseTexture = diffuseTex;
        // if (atlas.teamMaskUri) {
        //     const maskTex = new Texture(atlas.teamMaskUri, this.scene);
        //     // Apply team-color plugin (same pattern as entity-renderer.ts)
        // }

        // Shadow casting (if enabled)
        if (this.shadowGenerator) {
            this.shadowGenerator.addShadowCaster(mesh);
        }

        mesh.isVisible = false; // Hidden until instances populate
        this.impostorMeshes.set(key, mesh);
        return mesh;
    }

    /** Determine the LOD tier for a given entity. */
    determineLodTier(
        defId: number,
        worldPos: Vector3,
        cameraPos: Vector3,
        forceTier?: LodTier,
    ): LodTier {
        // Force-LOD override (model-viewer harness, debug)
        if (forceTier) return forceTier;

        const thresholds = this.lodThresholds.get(defId);
        if (!thresholds) {
            // No thresholds registered → default to full model
            return LodTier.Full;
        }

        const dist = Vector3.Distance(worldPos, cameraPos);
        if (dist >= thresholds.iconDistance) return LodTier.Icon;
        if (dist >= thresholds.impostorDistance) return LodTier.Impostor;
        return LodTier.Full;
    }

    /** Clean up all impostor meshes. */
    dispose(): void {
        for (const mesh of this.impostorMeshes.values()) {
            mesh.dispose();
        }
        this.impostorMeshes.clear();
        this.atlases.clear();
        this.lodThresholds.clear();
        this.pendingInstances.clear();
    }
}
