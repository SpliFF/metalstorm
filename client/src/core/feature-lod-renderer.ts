/**
 * feature-lod-renderer.ts — the Babylon side of the map-feature LOD tier
 * (PLAN-maps.md M6 / §1.4).
 *
 * Vegetation-scale maps place tens of thousands of trees. Drawing them all as
 * full-mesh thin instances at every distance is what this module replaces:
 *
 *   NEAR   full .glb mesh, thin-instanced per tile, casts CSM shadows
 *          (identical to the pre-LOD path, just chunked)
 *   FAR    one baked impostor card per placement, thin-instanced per tile,
 *          NO shadow casting (atlas impostors cast whole-silhouette shadows —
 *          the carried limitation documented in PLAN-metalstorm-impostors.md,
 *          acceptable for vegetation only because we skip it entirely)
 *   CULLED nothing; past ~10k elmos an impostor is sub-pixel and the terrain
 *          far-field bake carries the forest read
 *
 * The tier is chosen PER TILE, not per instance (see feature-lod.ts for why),
 * which lets every thin-instance MATRIX buffer be built once at load and
 * uploaded as a STATIC buffer. Steady-state cost of the whole system is a
 * `setEnabled()` per tile a few times per second. Only two small dynamic
 * buffers exist: a 1-float-per-instance `ditherFade` (written only while a
 * tile crossfades) and a 1-float-per-instance `impostorCell` (written only on
 * a re-partition pass, far tiles only).
 *
 * Feature types with NO baked atlas never reach this module — feature-renderer
 * keeps its original single-mesh path for them, so every existing map renders
 * exactly as before.
 */

import {
    Scene,
    Camera,
    Mesh,
    AbstractMesh,
    MeshBuilder,
    Material,
    PBRMaterial,
    StandardMaterial,
    Matrix,
    Quaternion,
    Vector3,
    BoundingInfo,
    Texture,
    ShadowGenerator,
} from '@babylonjs/core';

import {
    FeatureTier,
    DEFAULT_FEATURE_LOD_CONFIG,
    partitionIntoTiles,
    tierForTile,
    distanceToTile,
    cameraMovedEnough,
    farInstanceCount,
    type FeatureLodConfig,
    type FeatureTile,
    type LodPlacement,
    type LodModelExtent,
} from './feature-lod.js';
import { DitherFadePlugin } from './dither-fade-plugin.js';
import { ImpostorUvPlugin } from './impostor-uv-plugin.js';
import { selectAtlasCell, atlasCellCount, type AtlasLayout } from './impostor-atlas.js';

/** Baked impostor atlas for one feature type. */
export interface FeatureImpostorAtlas {
    /** URL of the `<stem>_impostor.ktx2` sprite sheet. */
    diffuseUrl: string;
    /** Grid convention — see impostor-atlas.ts. */
    layout: AtlasLayout;
    /** Card size in local units at scale 1 (defaults to the model extent). */
    width: number;
    height: number;
    /** Height above the placement point that the card's CENTRE sits at, local
     *  units at scale 1. `bake_impostors.py` frames each view on the model's
     *  bounding-sphere centre, so this is its `centreY`; without it a tall
     *  thin model's card floats or sinks. Defaults to `height / 2`. */
    lift?: number;
    /** Row 0 is the top row of the atlas image. */
    topDown: boolean;
    /** Per-type override of `impostorDistance`. */
    impostorDistance?: number;
}

export interface FeatureLodTypeInput {
    typeName: string;
    /** The loaded .glb primary mesh. Used as a GEOMETRY SOURCE only — it is
     *  disabled and every tile mesh is a clone that shares its geometry. */
    template: Mesh;
    placements: LodPlacement[];
    atlas: FeatureImpostorAtlas;
    modelExtent: LodModelExtent;
}

interface TileState {
    tile: FeatureTile;
    tier: FeatureTier;
    nearMesh: Mesh;
    farMesh: Mesh;
    /** Current dither fade per tier, 0..1. */
    nearFade: number;
    farFade: number;
    /** Per-instance attribute backing stores (all entries in a tile share the
     *  same fade — the buffer exists so one material can serve every tile). */
    nearFadeBuf: Float32Array;
    farFadeBuf: Float32Array;
    cellBuf: Float32Array | null;
    /** Whether nearMesh is currently in the CSM caster renderList. */
    castingShadow: boolean;
}

interface TypeState {
    name: string;
    template: Mesh;
    atlas: FeatureImpostorAtlas;
    modelExtent: LodModelExtent;
    tiles: TileState[];
    nearMaterial: Material;
    nearDither: DitherFadePlugin;
    farMaterial: PBRMaterial;
    farDither: DitherFadePlugin;
    farUv: ImpostorUvPlugin;
    /** Cached per-type config (base config + the type's own distance). */
    cfg: FeatureLodConfig;
    instanceCount: number;
}

const EPSILON_FADE = 1 / 512;

export class FeatureLodController {
    private scene: Scene;
    private shadowGenerator: ShadowGenerator | null;
    private types: TypeState[] = [];
    private cfg: FeatureLodConfig = { ...DEFAULT_FEATURE_LOD_CONFIG };
    private forcedTier: FeatureTier | null = null;

    private lastFrameMs = 0;
    private lastPassMs = -Infinity;
    private lastPassCam: { x: number; y: number; z: number } | null = null;
    /** Set when config changes so the next frame re-evaluates regardless of
     *  the throttle / camera-movement gates. */
    private dirty = true;
    /** First pass snaps fades instead of crossfading (no dissolve at load). */
    private firstPass = true;

    private billboardRot = Matrix.Identity();
    private scratchPos = new Vector3();
    private scratchQuat = new Quaternion();
    private scratchScale = new Vector3(1, 1, 1);
    private scratchMat = Matrix.Identity();
    private readonly identityQuat = Quaternion.Identity();

    constructor(scene: Scene, shadowGenerator: ShadowGenerator | null = null) {
        this.scene = scene;
        this.shadowGenerator = shadowGenerator;
    }

    get typeCount(): number { return this.types.length; }

    /** Build every tile mesh for one feature type. Called once per type during
     *  map load — nothing here runs at frame time. */
    addType(input: FeatureLodTypeInput): void {
        if (input.placements.length === 0) return;

        const template = input.template;
        template.setEnabled(false);

        const nearMaterial = template.material ?? new StandardMaterial(
            `featLodNear_${input.typeName}`, this.scene);
        template.material = nearMaterial;
        const nearDither = new DitherFadePlugin(nearMaterial);
        nearDither.useAttribute = true;
        nearDither.invertPattern = false;
        nearDither.isEnabled = true;

        const atlas = input.atlas;
        const farMaterial = new PBRMaterial(`featLodFar_${input.typeName}`, this.scene);
        farMaterial.metallic = 0;
        farMaterial.roughness = 1;
        const tex = new Texture(atlas.diffuseUrl, this.scene);
        tex.hasAlpha = true;
        farMaterial.albedoTexture = tex;
        farMaterial.useAlphaFromAlbedoTexture = true;
        farMaterial.transparencyMode = PBRMaterial.PBRMATERIAL_ALPHATEST;
        // Matches createImpostorMaterial(): the atlases are LANCZOS-downscaled
        // and mipmapped, so a 0.5 cutoff erodes thin branches into the mips.
        farMaterial.alphaCutOff = 0.4;
        farMaterial.backFaceCulling = false;
        farMaterial.twoSidedLighting = true;

        const farUv = new ImpostorUvPlugin(farMaterial);
        farUv.layout = atlas.layout;
        farUv.topDown = atlas.topDown;
        farUv.lift = atlas.lift ?? atlas.height * 0.5;
        farUv.billboard = true;
        farUv.cellSelect = atlasCellCount(atlas.layout) > 1;
        farUv.billboardRotation = this.billboardRot;
        farUv.isEnabled = true;

        const farDither = new DitherFadePlugin(farMaterial);
        farDither.useAttribute = true;
        // Complementary polarity to the near tier, so a 50/50 crossfade covers
        // every pixel exactly once instead of double-drawing half and holing
        // the other half through to the terrain.
        farDither.invertPattern = true;
        farDither.isEnabled = true;

        const type: TypeState = {
            name: input.typeName,
            template,
            atlas,
            modelExtent: input.modelExtent,
            tiles: [],
            nearMaterial,
            nearDither,
            farMaterial,
            farDither,
            farUv,
            cfg: this.deriveConfig(atlas),
            instanceCount: input.placements.length,
        };

        const tiles = partitionIntoTiles(input.placements, this.cfg.tileSize, input.modelExtent);
        for (const tile of tiles) {
            type.tiles.push(this.buildTile(type, tile));
        }
        this.types.push(type);
        this.dirty = true;
    }

    /** Per-frame. Cheap: one uniform write per type plus any live crossfades;
     *  the tier pass itself is throttled by `updateIntervalMs` +
     *  `cameraMoveEpsilon`. */
    update(camera: Camera, nowMs: number): void {
        if (this.types.length === 0) return;
        const dtMs = this.lastFrameMs > 0 ? Math.min(250, nowMs - this.lastFrameMs) : 0;
        this.lastFrameMs = nowMs;

        this.updateBillboardRotation(camera);

        const cam = camera.globalPosition ?? camera.position;
        const camXyz = { x: cam.x, y: cam.y, z: cam.z };

        const due = nowMs - this.lastPassMs >= this.cfg.updateIntervalMs;
        const moved = cameraMovedEnough(this.lastPassCam, camXyz, this.cfg.cameraMoveEpsilon);
        if (this.dirty || (due && moved)) {
            this.runTierPass(camXyz);
            this.lastPassMs = nowMs;
            this.lastPassCam = camXyz;
            this.dirty = false;
        }

        this.advanceCrossfades(this.firstPass ? Number.POSITIVE_INFINITY : dtMs);
        this.firstPass = false;
    }

    getConfig(): FeatureLodConfig { return { ...this.cfg }; }

    /** Live-tune from the devtools console (`__featureLod.set({...})`). Tile
     *  size only applies before the first type is added — re-partitioning
     *  later would rebuild every static buffer, which is exactly what this
     *  design exists to avoid. */
    setConfig(patch: Partial<FeatureLodConfig>): FeatureLodConfig {
        const rest: Partial<FeatureLodConfig> = { ...patch };
        if (this.types.length > 0) delete rest.tileSize;
        this.cfg = { ...this.cfg, ...rest };
        for (const type of this.types) type.cfg = this.deriveConfig(type.atlas);
        this.dirty = true;
        return this.getConfig();
    }

    /** Pin every tile to one tier (`null` = automatic) for A/B comparison. */
    setForceTier(tier: FeatureTier | null): FeatureTier | null {
        this.forcedTier = tier;
        this.dirty = true;
        return this.forcedTier;
    }

    getForceTier(): FeatureTier | null { return this.forcedTier; }

    /** Debug readout for `window.__gp('__featureLod.get()')`. */
    getStats(): Record<string, unknown> {
        const totals = { tiles: 0, near: 0, far: 0, culled: 0, nearInstances: 0, farInstances: 0, drawnMeshes: 0 };
        const types = this.types.map((t) => {
            const row = {
                name: t.name,
                tiles: t.tiles.length,
                instances: t.instanceCount,
                near: 0, far: 0, culled: 0,
                nearInstances: 0, farInstances: 0,
                impostorDistance: t.cfg.impostorDistance,
                atlas: `${t.atlas.layout.yawBins}x${t.atlas.layout.pitchBins}x${t.atlas.layout.frames}`,
            };
            for (const ts of t.tiles) {
                if (ts.tier === FeatureTier.Near) { row.near++; row.nearInstances += ts.tile.placements.length; }
                else if (ts.tier === FeatureTier.Far) { row.far++; row.farInstances += ts.farMesh.thinInstanceCount; }
                else row.culled++;
                if (ts.nearMesh.isEnabled(false)) totals.drawnMeshes++;
                if (ts.farMesh.isEnabled(false)) totals.drawnMeshes++;
            }
            totals.tiles += row.tiles;
            totals.near += row.near;
            totals.far += row.far;
            totals.culled += row.culled;
            totals.nearInstances += row.nearInstances;
            totals.farInstances += row.farInstances;
            return row;
        });
        return { config: this.getConfig(), forceTier: this.forcedTier, totals, types };
    }

    dispose(): void {
        for (const type of this.types) {
            for (const ts of type.tiles) {
                ts.nearMesh.dispose();
                ts.farMesh.dispose();
            }
            // We own the far material + its atlas texture. The NEAR material
            // came from the .glb and may still be referenced by the other
            // (disabled) meshes of that import, so it is left to scene
            // teardown rather than pulled out from under them.
            type.farMaterial.albedoTexture?.dispose();
            type.farMaterial.dispose();
            type.template.dispose();
        }
        this.types = [];
    }

    // ── internal ────────────────────────────────────────────────────────

    private deriveConfig(atlas: FeatureImpostorAtlas): FeatureLodConfig {
        return atlas.impostorDistance && atlas.impostorDistance > 0
            ? { ...this.cfg, impostorDistance: atlas.impostorDistance }
            : { ...this.cfg };
    }

    private buildTile(type: TypeState, tile: FeatureTile): TileState {
        const n = tile.placements.length;

        // --- NEAR: clone of the .glb mesh, full placement transform baked per
        //     instance.
        //
        // makeGeometryUnique() is LOAD-BEARING, not tidiness. `Mesh.clone()`
        // shares the source Geometry by reference, and thin-instance buffers
        // are stored ON THE GEOMETRY (`Mesh.setVerticesBuffer` forwards to
        // `this._geometry`). Two clones sharing a geometry therefore share one
        // `world0..3` matrix buffer — the second tile silently overwrites the
        // first and both draw the same placements. Verified against Babylon
        // 9.1.0. The cost is a per-tile copy of the (small, foliage-scale)
        // vertex data; the tiles are separate draw calls regardless.
        const nearMesh = type.template.clone(
            `feat_${type.name}_near_${tile.key}`, null, true);
        nearMesh.makeGeometryUnique();
        nearMesh.parent = null;
        nearMesh.position.set(0, 0, 0);
        nearMesh.rotationQuaternion = Quaternion.Identity();
        nearMesh.scaling.set(1, 1, 1);
        nearMesh.material = type.nearMaterial;
        nearMesh.isPickable = false;
        nearMesh.receiveShadows = true;

        const nearMatrices = new Float32Array(n * 16);
        for (let i = 0; i < n; i++) {
            const p = tile.placements[i];
            this.scratchScale.set(p.scale, p.scale, p.scale);
            Quaternion.RotationAxisToRef(Vector3.UpReadOnly, p.rotation, this.scratchQuat);
            this.scratchPos.set(p.x, p.y, p.z);
            Matrix.ComposeToRef(this.scratchScale, this.scratchQuat, this.scratchPos, this.scratchMat);
            this.scratchMat.copyToArray(nearMatrices, i * 16);
        }
        const nearFadeBuf = new Float32Array(n);
        this.finishTierMesh(nearMesh, nearMatrices, nearFadeBuf, null);

        // --- FAR: one impostor card per placement. The instance matrix holds
        //     translation + uniform scale ONLY — orientation is the shared
        //     billboard uniform, so this buffer never has to be rebuilt.
        const farMesh = MeshBuilder.CreatePlane(
            `feat_${type.name}_far_${tile.key}`,
            { width: type.atlas.width, height: type.atlas.height, sideOrientation: Mesh.DOUBLESIDE },
            this.scene,
        );
        farMesh.material = type.farMaterial;
        farMesh.isPickable = false;
        farMesh.receiveShadows = false;

        const farMatrices = new Float32Array(n * 16);
        for (let i = 0; i < n; i++) {
            const p = tile.placements[i];
            this.scratchScale.set(p.scale, p.scale, p.scale);
            this.scratchPos.set(p.x, p.y, p.z);
            Matrix.ComposeToRef(
                this.scratchScale, this.identityQuat, this.scratchPos, this.scratchMat);
            this.scratchMat.copyToArray(farMatrices, i * 16);
        }
        const farFadeBuf = new Float32Array(n);
        const cellBuf = atlasCellCount(type.atlas.layout) > 1 ? new Float32Array(n) : null;
        this.finishTierMesh(farMesh, farMatrices, farFadeBuf, cellBuf);

        // The card's own extent + the ground-anchor lift live in the SHADER,
        // so the thin-instance bounds (computed from a quad centred on the
        // placement point) under-report. Inflate by the worst-case rotated
        // half-diagonal plus the lift so a pitched card never pops out at the
        // frustum edge. CULLINGSTRATEGY_BOUNDINGSPHERE_ONLY then makes the
        // test a single sphere check per tile.
        const maxScale = tile.placements.reduce((m, p) => Math.max(m, p.scale), 1);
        const halfDiag = 0.5 * Math.hypot(type.atlas.width, type.atlas.height) * maxScale;
        const pad = halfDiag + Math.abs(type.atlas.lift ?? type.atlas.height * 0.5) * maxScale;
        const bi = farMesh.getBoundingInfo();
        farMesh.setBoundingInfo(new BoundingInfo(
            new Vector3(bi.minimum.x - pad, bi.minimum.y - pad, bi.minimum.z - pad),
            new Vector3(bi.maximum.x + pad, bi.maximum.y + pad, bi.maximum.z + pad),
        ));
        farMesh.doNotSyncBoundingInfo = true;

        // Shadows: NEAR tiles within cfg.shadowDistance only — membership is
        // managed live by runTierPass. Impostor cards would cast
        // whole-silhouette shadows (PLAN-metalstorm-impostors.md carried
        // limitation), and Babylon submits every caster to every cascade, so
        // distant casters cost 4x for pixels nobody can see.

        return {
            tile,
            tier: FeatureTier.Culled,
            nearMesh,
            farMesh,
            nearFade: 0,
            farFade: 0,
            nearFadeBuf,
            farFadeBuf,
            cellBuf,
            castingShadow: false,
        };
    }

    /** Shared tail of tile-mesh setup: static matrix buffer, dynamic
     *  attribute buffers, one bounding-info refresh, then culling config. */
    private finishTierMesh(
        mesh: Mesh, matrices: Float32Array,
        fadeBuf: Float32Array, cellBuf: Float32Array | null,
    ): void {
        // staticBuffer = true (4th arg): ~4x cheaper than an updatable buffer.
        // NEVER call thinInstanceSetMatrixAt on these — with a static buffer
        // that silently forces a full buffer recreation.
        mesh.thinInstanceSetBuffer('matrix', matrices, 16, true);
        mesh.thinInstanceSetBuffer('ditherFade', fadeBuf, 1, false);
        if (cellBuf) mesh.thinInstanceSetBuffer('impostorCell', cellBuf, 1, false);
        // Exactly once, while the mesh still syncs bounds; from here the tile
        // is static so nothing may recompute them.
        mesh.thinInstanceRefreshBoundingInfo(false);
        mesh.doNotSyncBoundingInfo = true;
        // Per-tile frustum culling is the whole point of chunking, so the
        // whole-map `alwaysSelectAsActiveMesh` escape hatch the single-mesh
        // path needs must stay OFF here.
        mesh.alwaysSelectAsActiveMesh = false;
        mesh.cullingStrategy = AbstractMesh.CULLINGSTRATEGY_BOUNDINGSPHERE_ONLY;
        mesh.setEnabled(false);
    }

    private updateBillboardRotation(camera: Camera): void {
        const m = camera.getWorldMatrix().m;
        // Babylon stores translation at 12..14, so rows 0/1/2 are the camera's
        // right / up / toward-viewer axes (RH: local +Z points back at the
        // viewer). Mapping the card's local X/Y/Z onto them screen-aligns it.
        Matrix.FromValuesToRef(
            m[0], m[1], m[2], 0,
            m[4], m[5], m[6], 0,
            m[8], m[9], m[10], 0,
            0, 0, 0, 1,
            this.billboardRot,
        );
        // The plugin holds a reference to this same Matrix, so the per-frame
        // mutation above is all that is needed — but re-point it defensively
        // in case a type was added with a different instance.
        for (const type of this.types) type.farUv.billboardRotation = this.billboardRot;
    }

    private runTierPass(cam: { x: number; y: number; z: number }): void {
        for (const type of this.types) {
            for (const ts of type.tiles) {
                ts.tier = this.forcedTier ?? tierForTile(ts.tile, cam, ts.tier, type.cfg);
                // CSM caster membership: near tier AND within shadowDistance.
                const wantShadow = ts.tier === FeatureTier.Near
                    && distanceToTile(ts.tile, cam.x, cam.y, cam.z) <= type.cfg.shadowDistance;
                if (wantShadow !== ts.castingShadow && this.shadowGenerator) {
                    if (wantShadow) this.shadowGenerator.addShadowCaster(ts.nearMesh);
                    else this.shadowGenerator.removeShadowCaster(ts.nearMesh);
                    ts.castingShadow = wantShadow;
                }
                if (ts.tier !== FeatureTier.Far) continue;
                // Density is a pure thinInstanceCount write — the matrix
                // buffer is distance-sorted from the tile centre at build
                // time, so a prefix is an even thinning with zero uploads.
                ts.farMesh.thinInstanceCount = farInstanceCount(
                    ts.tile.placements.length, this.cfg.farDensity);
                this.refreshCells(type, ts, cam);
            }
        }
    }

    /** Recompute which atlas cell each card shows. Position-only — the shared
     *  billboard rotation handles camera orientation, so a pure camera turn
     *  never needs this. */
    private refreshCells(type: TypeState, ts: TileState, cam: { x: number; y: number; z: number }): void {
        const buf = ts.cellBuf;
        if (!buf) return;
        const layout = type.atlas.layout;
        const half = type.atlas.lift ?? type.atlas.height * 0.5;
        const ps = ts.tile.placements;
        for (let i = 0; i < ps.length; i++) {
            const p = ps[i];
            buf[i] = selectAtlasCell(
                cam.x - p.x,
                cam.y - (p.y + half * p.scale),
                cam.z - p.z,
                p.rotation, layout,
            );
        }
        ts.farMesh.thinInstanceBufferUpdated('impostorCell');
    }

    private advanceCrossfades(dtMs: number): void {
        const step = this.cfg.crossfadeMs > 0 ? dtMs / this.cfg.crossfadeMs : Infinity;
        for (const type of this.types) {
            for (const ts of type.tiles) {
                const nearTarget = ts.tier === FeatureTier.Near ? 1 : 0;
                const farTarget = ts.tier === FeatureTier.Far ? 1 : 0;
                this.stepFade(ts, true, nearTarget, step);
                this.stepFade(ts, false, farTarget, step);
            }
        }
    }

    private stepFade(ts: TileState, near: boolean, target: number, step: number): void {
        const current = near ? ts.nearFade : ts.farFade;
        if (current === target) return;
        let next: number;
        if (!Number.isFinite(step)) next = target;
        else if (current < target) next = Math.min(target, current + step);
        else next = Math.max(target, current - step);
        if (Math.abs(next - target) < EPSILON_FADE) next = target;
        if (near) ts.nearFade = next; else ts.farFade = next;

        const mesh = near ? ts.nearMesh : ts.farMesh;
        const buf = near ? ts.nearFadeBuf : ts.farFadeBuf;
        buf.fill(next);
        mesh.thinInstanceBufferUpdated('ditherFade');
        const visible = next > EPSILON_FADE;
        if (mesh.isEnabled(false) !== visible) mesh.setEnabled(visible);
    }
}
