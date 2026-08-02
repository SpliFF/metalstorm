/**
 * FeatureRenderer — render map features using their real models.
 *
 * The server preprocessing pipeline converts each Spring `.s3o` model to
 * glTF 2.0 binary (`.glb`) via the `modelimporter` tool, and each `.tga`
 * texture to `.png` via ImageMagick. Both URLs are delivered in the
 * `MapFeatureDefInfo` array on the parsed map data.
 *
 * For each feature type with a `modelUrl`, we load the glb once via
 * Babylon's `SceneLoader`, take its first concrete mesh, then push every
 * placement of that type into a thin-instance matrix buffer. Types with
 * no model fall back to a small placeholder box so the player still sees
 * something on the map.
 */

import {
    Scene,
    MeshBuilder,
    StandardMaterial,
    PBRMaterial,
    Material,
    Color3,
    Mesh,
    Matrix,
    Quaternion,
    Vector3,
    SceneLoader,
    ShadowGenerator,
    Texture,
} from '@babylonjs/core';
// Side-effect import: registers the glTF loader plugin so SceneLoader
// can read our `.glb` files. Without this, .glb requests fail with
// "Unable to find a plugin to load .glb files".
import '@babylonjs/loaders/glTF/index.js';

import type { ParsedMapData, MapFeatureInstance, MapFeatureDefInfo } from './map-data.js';
import type { FeatureDefInfo, FeatureSpawnInfo } from './connection.js';
import type { DefCache } from './def-cache.js';
import { FeatureLodController, type FeatureImpostorAtlas } from './feature-lod-renderer.js';
import { DEFAULT_FEATURE_LOD_CONFIG, type FeatureLodConfig, type LodPlacement } from './feature-lod.js';
import { DEFAULT_ATLAS_LAYOUT, normalizeAtlasLayout } from './impostor-atlas.js';

/// Hash a string to a stable RGB tint — used only for placeholder boxes
/// so each fallback type still gets a distinct colour.
function typeColour(name: string): Color3 {
    let h = 2166136261;
    for (let i = 0; i < name.length; i++) {
        h ^= name.charCodeAt(i);
        h = (h * 16777619) >>> 0;
    }
    return new Color3(
        ((h & 0xff) / 255) * 0.5 + 0.3,
        (((h >> 8) & 0xff) / 255) * 0.5 + 0.3,
        (((h >> 16) & 0xff) / 255) * 0.5 + 0.3,
    );
}

const PLACEHOLDER_EXTENT = 32;

/// Build the per-instance matrix buffer for a list of placements.
/// Each instance is positioned at the absolute world coordinates the
/// server sent. Feature Y is part of the synced sim state (pathfinding,
/// LOS, projectile collision all depend on it), so `FeatureProcessor`
/// on the server samples the heightmap at placement time and stores
/// the real ground Y — the client just renders what it's given.
function buildInstanceMatrices(instances: MapFeatureInstance[]): Float32Array {
    const matrices = new Float32Array(instances.length * 16);
    for (let i = 0; i < instances.length; i++) {
        const f = instances[i];
        const scale = Math.max(0.25, f.relativeSize);
        const rot = Quaternion.FromEulerAngles(0, f.rotation, 0);
        const m = Matrix.Compose(
            new Vector3(scale, scale, scale),
            rot,
            new Vector3(f.x, f.y, f.z),
        );
        m.copyToArray(matrices, i * 16);
    }
    return matrices;
}

/// Take the loaded glb's mesh list and pick the one we should thin-instance.
/// SceneLoader returns the scene root + every imported child mesh; we want
/// the first child that actually has geometry.
function pickPrimaryMesh(meshes: import('@babylonjs/core').AbstractMesh[]): Mesh | null {
    for (const m of meshes) {
        if (m instanceof Mesh && m.getTotalVertices() > 0) {
            return m;
        }
    }
    return null;
}

/// Apply the per-feature texture (a `.ktx2` from the server pipeline)
/// to the loaded mesh's material. Backface culling is disabled so
/// single-quad foliage remains visible from both sides, matching
/// Spring's renderer behaviour.
///
/// KTX2 alpha is well-defined — the encoder packs RGBA correctly and
/// the transcoder hands it to the GPU intact, so the OPAQUE-mode PNG-
/// cutout workaround the legacy pipeline needed is gone.
function applyTexture(mesh: Mesh, def: MapFeatureDefInfo, scene: Scene) {
    if (!def.textureUrl) return;
    const mat = mesh.material;
    if (!mat) return;

    const tex = new Texture(def.textureUrl, scene);

    if (mat instanceof StandardMaterial) {
        mat.diffuseTexture?.dispose();
        mat.diffuseTexture = tex;
    } else if (mat instanceof PBRMaterial) {
        mat.albedoTexture?.dispose();
        mat.albedoTexture = tex;
    } else {
        tex.dispose();
        return;
    }

    mat.backFaceCulling = false;
}

/// Build a placeholder box mesh + thin instances for a feature type
/// whose model failed to load. Only used as a debug fallback from the
/// catch branch — types with intentionally no model (decal-only
/// features) are skipped entirely upstream.
function renderPlaceholder(
    scene: Scene,
    typeName: string,
    instances: MapFeatureInstance[],
): Mesh {
    const base = MeshBuilder.CreateBox(
        `feature_placeholder_${typeName}`,
        { size: PLACEHOLDER_EXTENT },
        scene,
    );
    // CreateBox centres the mesh on its own origin, so a thin-instance
    // at ground height would end up half-buried. Shift geometry up by
    // half the extent and bake it in, so the origin sits at the base.
    base.position.y = PLACEHOLDER_EXTENT / 2;
    base.bakeCurrentTransformIntoVertices();
    const mat = new StandardMaterial(`featureMat_${typeName}`, scene);
    mat.diffuseColor = typeColour(typeName);
    mat.specularColor = new Color3(0.1, 0.1, 0.1);
    base.material = mat;
    base.isPickable = false;
    base.thinInstanceSetBuffer('matrix', buildInstanceMatrices(instances), 16, true);
    // Thin-instance batches are culled by the template mesh's bounding
    // info, which is a tiny box at the origin — not the union of all
    // instance world positions. Without these two calls the CPU-side
    // frustum test drops the entire batch the moment the origin goes
    // off-screen, and features wink out in zoom / pan passes.
    base.alwaysSelectAsActiveMesh = true;
    base.thinInstanceRefreshBoundingInfo(false);
    return base;
}

// ── Impostor LOD discovery (PLAN-maps.md M6 / §1.4) ──────────────────────
//
// A feature type gets the LOD treatment only when a baked impostor atlas
// exists for it. Discovery is by MANIFEST, not by probing: a per-models-dir
// `impostors.json` costs one request for the whole map, whereas HEAD-probing
// `<stem>_impostor.ktx2` per type costs a 404 per feature type on every map
// that has none (which is every map today). `probePerType` turns the probe
// path on for content that ships atlases without a manifest.

/**
 * One atlas description. Every field is optional — defaults are the v2 atlas
 * convention plus the model's own bounding box.
 *
 * Two spellings are accepted so the manifest and the baker's own per-model
 * sidecar (`tools/fable-model-forge/bake_impostors.py` writes
 * `<stem>_impostor.json` = `{cols, rows, cell, pitches, width, height,
 * centreY}`) can both be read without a conversion step in the content
 * pipeline. `yawBins`/`pitchBins` and `cols`/`rows` are the same thing.
 */
export interface ImpostorManifestEntry {
    /** Atlas filename relative to the models dir. Default `<stem>_impostor.ktx2`. */
    diffuse?: string;
    yawBins?: number;
    pitchBins?: number;
    frames?: number;
    /** Baker spelling of yawBins / pitchBins. */
    cols?: number;
    rows?: number;
    /** Elevation (degrees above the horizon) each row was baked at. Baker
     *  spelling is `pitchDegrees`; `pitches` is the older alias. */
    pitchDegrees?: number[];
    pitches?: number[];
    /** Relative yaw (DEGREES) that column 0 was baked at — the atlas's azimuth
     *  phase. Omitted = 0, i.e. column 0 is the instance's back, which is what
     *  `bake_impostors.py`'s default `vegetation` convention emits. */
    azimuthPhaseDegrees?: number;
    /** Card size in elmos at scale 1. Default = the model's own extents. */
    width?: number;
    height?: number;
    /** Height of the card CENTRE above the placement point (the baker frames
     *  on the bounding-sphere centre). Default = height / 2. */
    centreY?: number;
    /** Row 0 is the top row of the image (baker convention). Default true. */
    topDown?: boolean;
    /** Per-type swap distance override, elmos. */
    impostorDistance?: number;
}

type ImpostorManifest = Record<string, ImpostorManifestEntry>;

/** `.../models/tree_conifer.glb` → `.../models/` */
function modelDirOf(url: string): string {
    return url.substring(0, url.lastIndexOf('/') + 1);
}

/** `.../tree_conifer.glb` → `tree_conifer` */
function modelStemOf(url: string): string {
    const file = url.substring(url.lastIndexOf('/') + 1);
    const dot = file.lastIndexOf('.');
    return dot > 0 ? file.substring(0, dot) : file;
}

/// Fetch `<dir>impostors.json`. Missing / malformed / unreachable all mean
/// "this content ships no impostors" — never an error, the caller just keeps
/// the full-mesh path.
async function fetchImpostorManifest(dirUrl: string): Promise<ImpostorManifest | null> {
    try {
        const resp = await fetch(`${dirUrl}impostors.json`);
        if (!resp.ok) return null;
        const json: unknown = await resp.json();
        if (!json || typeof json !== 'object') return null;
        const rec = json as Record<string, unknown>;
        const atlases = (rec.atlases && typeof rec.atlases === 'object') ? rec.atlases : rec;
        return atlases as ImpostorManifest;
    } catch {
        return null;
    }
}

/// Fetch the baker's per-model `<stem>_impostor.json` sidecar. Null when the
/// model has none.
async function fetchAtlasSidecar(dirUrl: string, stem: string): Promise<ImpostorManifestEntry | null> {
    try {
        const resp = await fetch(`${dirUrl}${stem}_impostor.json`);
        if (!resp.ok) return null;
        const json: unknown = await resp.json();
        return (json && typeof json === 'object') ? json as ImpostorManifestEntry : null;
    } catch {
        return null;
    }
}

/// Last-resort discovery: the atlas image exists but carries no metadata.
async function probeImpostorAtlas(dirUrl: string, stem: string): Promise<boolean> {
    try {
        const resp = await fetch(`${dirUrl}${stem}_impostor.ktx2`, { method: 'HEAD' });
        return resp.ok;
    } catch {
        return false;
    }
}

/// Resolve the atlas description for one type. Manifest first (one request per
/// models dir); the baker's sidecar fills in whatever the manifest omitted, and
/// is the whole description in `probePerType` mode. Returns null when the type
/// has no atlas at all — the caller then keeps the original full-mesh path.
async function resolveAtlasEntry(
    dirUrl: string, stem: string,
    manifest: ImpostorManifest | null | undefined, probePerType: boolean,
): Promise<ImpostorManifestEntry | null> {
    const listed = manifest ? manifest[stem] : undefined;
    if (listed !== undefined) {
        const entry: ImpostorManifestEntry = (listed && typeof listed === 'object') ? listed : {};
        const hasGrid = entry.yawBins !== undefined || entry.cols !== undefined;
        const hasSize = entry.width !== undefined || entry.height !== undefined;
        if (hasGrid && hasSize) return entry;
        // Manifest listed it but didn't describe it — the baker's sidecar is
        // authoritative; explicit manifest fields still win.
        return { ...(await fetchAtlasSidecar(dirUrl, stem) ?? {}), ...entry };
    }
    if (!probePerType) return null;
    const sidecar = await fetchAtlasSidecar(dirUrl, stem);
    if (sidecar) return sidecar;
    return (await probeImpostorAtlas(dirUrl, stem)) ? {} : null;
}

/// Local-space extents of the loaded model, used for the impostor card size
/// and for inflating tile bounds so an edge-of-tile tree isn't culled by its
/// own trunk position.
function modelExtentsOf(mesh: Mesh): { radius: number; height: number; width: number } {
    const bb = mesh.getBoundingInfo().boundingBox;
    const min = bb.minimum;
    const max = bb.maximum;
    const spanX = Math.max(1e-3, max.x - min.x);
    const spanZ = Math.max(1e-3, max.z - min.z);
    return {
        radius: 0.5 * Math.max(spanX, spanZ),
        height: Math.max(1e-3, max.y - min.y),
        width: Math.max(spanX, spanZ),
    };
}

/// Build the atlas spec for a type, or null when it has none.
/** Exported for test: this is the seam where a manifest field silently going
 *  missing would make the runtime select cells against the wrong arc or phase. */
export function atlasSpecFor(
    def: MapFeatureDefInfo, entry: ImpostorManifestEntry | null, extents: { width: number; height: number },
): FeatureImpostorAtlas | null {
    if (!entry) return null;
    const dir = modelDirOf(def.modelUrl);
    const stem = modelStemOf(def.modelUrl);
    return {
        diffuseUrl: `${dir}${entry.diffuse ?? `${stem}_impostor.ktx2`}`,
        layout: normalizeAtlasLayout({
            yawBins: entry.yawBins ?? entry.cols ?? DEFAULT_ATLAS_LAYOUT.yawBins,
            pitchBins: entry.pitchBins ?? entry.rows ?? DEFAULT_ATLAS_LAYOUT.pitchBins,
            frames: entry.frames ?? DEFAULT_ATLAS_LAYOUT.frames,
            pitchDegrees: entry.pitchDegrees ?? entry.pitches,
            azimuthPhaseDegrees: entry.azimuthPhaseDegrees,
        }),
        width: entry.width ?? extents.width,
        height: entry.height ?? extents.height,
        lift: entry.centreY,
        topDown: entry.topDown ?? true,
        impostorDistance: entry.impostorDistance,
    };
}

/// MapFeatureInstance → the shape the LOD math wants. Scale matches
/// `buildInstanceMatrices` exactly so the NEAR tier is byte-identical to the
/// pre-LOD path.
function toLodPlacements(instances: MapFeatureInstance[]): LodPlacement[] {
    return instances.map((f) => ({
        x: f.x, y: f.y, z: f.z,
        rotation: f.rotation,
        scale: Math.max(0.25, f.relativeSize),
    }));
}

/** What `renderMapFeatures` hands back. `lod` is null on maps whose features
 *  ship no impostor atlases — i.e. every map today. */
export interface MapFeatureRenderResult {
    /** Full-mesh thin-instance roots for types with no impostor tier, plus
     *  placeholders. Registered as shadow casters. */
    meshes: Mesh[];
    /** LOD controller for the types that DO have an atlas, or null. Must be
     *  ticked once per frame and disposed on map teardown. */
    lod: FeatureLodController | null;
}

/**
 * Render every map feature using its converted glb model.
 *
 * Types with a baked impostor atlas go through `FeatureLodController` —
 * spatially chunked tiles that swap full mesh → impostor card → nothing by
 * camera distance. Types without one keep the original single-mesh
 * whole-map thin-instance path unchanged.
 *
 * Loading is asynchronous (each glb is fetched + parsed by Babylon), so this
 * function returns a Promise that resolves once every type has been wired up.
 * Placements with `typeIndex` outside the `featureDefs` array are silently
 * dropped.
 */
export async function renderMapFeatures(
    scene: Scene, map: ParsedMapData, shadowGenerator: ShadowGenerator | null = null,
    lodConfig: Partial<FeatureLodConfig> = {},
): Promise<MapFeatureRenderResult> {
    // Bucket placements by type index.
    const buckets = new Map<number, MapFeatureInstance[]>();
    for (const f of map.features) {
        let b = buckets.get(f.typeIndex);
        if (!b) { b = []; buckets.set(f.typeIndex, b); }
        b.push(f);
    }

    const cfg: FeatureLodConfig = { ...DEFAULT_FEATURE_LOD_CONFIG, ...lodConfig };

    // One manifest fetch per distinct models directory (normally exactly one).
    const manifests = new Map<string, ImpostorManifest | null>();
    if (cfg.enabled) {
        const dirs = new Set<string>();
        for (const [typeIdx] of buckets) {
            const url = map.featureDefs[typeIdx]?.modelUrl;
            if (url) dirs.add(modelDirOf(url));
        }
        await Promise.all([...dirs].map(async (dir) => {
            manifests.set(dir, await fetchImpostorManifest(dir));
        }));
    }

    const results: Mesh[] = [];
    let lod: FeatureLodController | null = null;
    const lodFor = (): FeatureLodController => {
        if (!lod) {
            lod = new FeatureLodController(scene, shadowGenerator);
            lod.setConfig(cfg);
        }
        return lod;
    };
    let modelTypes = 0;
    let skippedTypes = 0;
    let placeholderTypes = 0;
    let lodTypes = 0;

    // Issue all glb loads in parallel.
    const promises: Promise<void>[] = [];
    for (const [typeIdx, instances] of buckets) {
        if (instances.length === 0) continue;
        const def: MapFeatureDefInfo | undefined = map.featureDefs[typeIdx];
        const typeName = map.featureTypes[typeIdx] ?? `type_${typeIdx}`;

        if (!def || !def.modelUrl) {
            // Intentionally model-less: decal-only features (geothermal
            // vents, metal spots, engine default tree slots that were
            // never authored with a .s3o, etc.). These exist in the sim
            // for collision/resource purposes but should be invisible
            // in the world — Spring renders them as nothing too. A
            // placeholder here would clutter the view with a box per
            // decal on every map.
            skippedTypes++;
            continue;
        }

        promises.push((async () => {
            try {
                // SceneLoader.ImportMeshAsync wants a base URL + filename pair.
                // Split the URL at the last '/' so it can resolve sibling
                // texture URIs relative to the glb.
                const lastSlash = def.modelUrl.lastIndexOf('/');
                const baseUrl = def.modelUrl.substring(0, lastSlash + 1);
                const fileName = def.modelUrl.substring(lastSlash + 1);

                // Don't stamp model URLs — see comment in
                // entity-renderer.ts loadModel().
                const result = await SceneLoader.ImportMeshAsync(
                    '', baseUrl, fileName, scene,
                );

                const primary = pickPrimaryMesh(result.meshes);
                if (!primary) {
                    console.warn(`[features] ${typeName}: glb has no geometry, falling back to placeholder`);
                    results.push(renderPlaceholder(scene, typeName, instances));
                    placeholderTypes++;
                    return;
                }

                // Hide every imported mesh except the one we'll thin-instance,
                // and detach the primary from the imported scene-root so its
                // own transform stops chaining onto the placement matrices.
                for (const m of result.meshes) {
                    if (m !== primary) m.setEnabled(false);
                }
                primary.parent = null;
                primary.position.set(0, 0, 0);
                primary.rotationQuaternion = Quaternion.Identity();
                primary.scaling.set(1, 1, 1);
                primary.isPickable = false;

                applyTexture(primary, def, scene);

                // PLAN-maps.md M6: does this type have a baked impostor atlas?
                // Manifest first (one request per models dir), the baker's
                // per-model sidecar for the details. No atlas → fall through to
                // the original single-mesh path, unchanged.
                const extents = modelExtentsOf(primary);
                const dir = modelDirOf(def.modelUrl);
                let entry: ImpostorManifestEntry | null = null;
                if (cfg.enabled) {
                    entry = await resolveAtlasEntry(
                        dir, modelStemOf(def.modelUrl),
                        manifests.get(dir), cfg.probePerType);
                }
                const atlas = atlasSpecFor(def, entry, extents);
                if (atlas) {
                    lodFor().addType({
                        typeName,
                        template: primary,
                        placements: toLodPlacements(instances),
                        atlas,
                        modelExtent: { radius: extents.radius, height: extents.height },
                    });
                    lodTypes++;
                    return;
                }

                primary.thinInstanceSetBuffer(
                    'matrix',
                    buildInstanceMatrices(instances),
                    16,
                    true,
                );
                // See renderPlaceholder() above for why these two calls
                // are required — without them the whole thin-instance
                // batch is frustum-culled when the template origin
                // leaves the view, so feature types wink out one by
                // one as the camera zooms in.
                primary.alwaysSelectAsActiveMesh = true;
                primary.thinInstanceRefreshBoundingInfo(false);
                results.push(primary);
                modelTypes++;
            } catch (err) {
                // Babylon raises "Scene has been disposed" when ImportMeshAsync
                // is in-flight while the scene tears down (game exit / lobby
                // restart). That isn't a content failure — swallow silently
                // since the disposed scene won't show anything anyway.
                if (scene.isDisposed) return;
                console.warn(`[features] ${typeName}: failed to load ${def.modelUrl}, falling back to placeholder`, err);
                results.push(renderPlaceholder(scene, typeName, instances));
                placeholderTypes++;
            }
        })());
    }

    await Promise.all(promises);

    // PLAN-lighting L3: register every feature mesh as a sun-shadow
    // caster + receiver. Static features dominate visual silhouette
    // (trees, wrecks, geothermals) so they're the biggest visual win.
    if (shadowGenerator) {
        for (const mesh of results) {
            shadowGenerator.addShadowCaster(mesh);
            mesh.receiveShadows = true;
        }
    }

    console.log(
        `[features] rendered ${map.features.length} placement(s) across ` +
        `${modelTypes} model type(s), ${lodTypes} impostor-LOD type(s), ` +
        `${placeholderTypes} load-failure placeholder(s), ` +
        `${skippedTypes} decal-only type(s) skipped`,
    );
    return { meshes: results, lod };
}

// ── Dynamic feature renderer (wrecks / debris / runtime spawns) ───────────
//
// `renderMapFeatures` above handles the static map-placed feature set:
// it loads each .glb once and thin-instances every placement, then
// returns. There's no add/remove API because map features never spawn
// or despawn after game start.
//
// Runtime-spawned features — wrecks from unit deaths,
// `Spring.CreateFeature` calls, debris dropped by explosions — arrive
// via the `FeatureLifecycleBatch` envelope. They share the same model
// types as map features but the placement set churns: each unit death
// spawns a new wreck, reclaim destroys it. `DynamicFeatureRenderer`
// owns a separate per-defId mesh pool, accepts spawn/remove events,
// and rebuilds the thin-instance matrix buffer on each batch.

interface DynamicInstance {
    featureId: number;
    x: number;
    y: number;
    z: number;
    /// Heading in radians (converted from Spring's 16-bit fixed-point).
    headingRad: number;
    /// Uniform scale — defaults to 1; we don't currently shrink wrecks
    /// over their lifetime (Spring's "fade as smoke ages" is a renderer
    /// concern that's out of scope for v1).
    scale: number;
}

interface DefBucket {
    /// Thin-instance template mesh. null until the .glb load resolves;
    /// pending instances accumulate in `pending` and get committed once
    /// the mesh is ready. A placeholder cube is created if loading fails.
    mesh: Mesh | null;
    /// Active instances keyed by featureId. We rebuild the matrix buffer
    /// on every change — wrecks churn slowly enough that incremental
    /// slot tracking would just be complexity for no measurable win.
    instances: Map<number, DynamicInstance>;
    /// Instances that arrived before the .glb resolved. Drained into
    /// `instances` once `mesh` is non-null.
    pending: DynamicInstance[];
    /// True once we've started the load — guards against double-loading
    /// when several spawns of the same def arrive in the same tick.
    loadStarted: boolean;
    /// Placeholder fallback flag. When true the mesh is a coloured cube
    /// (the .glb either had no URL or failed to load); we still render
    /// instances to make wrecks visible during dev.
    isPlaceholder: boolean;
}

/// Spring heading is 16-bit fixed-point: 0 = facing +Z, 16384 = +X
/// (90° clockwise looking down). 65536 = 360°. Convert to radians.
const HEADING_TO_RAD = (2 * Math.PI) / 65536;

export class DynamicFeatureRenderer {
    private scene: Scene;
    private defCache: DefCache;
    private buckets = new Map<number, DefBucket>();
    /// Reverse lookup so a Remove event can find the bucket without
    /// scanning every def. Cleared on remove.
    private featureToDef = new Map<number, number>();
    /// Spawns that arrived before their FeatureDef was registered in
    /// `DefCache` (the lifecycle batch raced ahead of `featuredefs.bin`,
    /// or the def was missing from the bake). Replay-drained whenever
    /// new defs come in.
    private orphanedSpawns: FeatureSpawnInfo[] = [];

    /** Sun-shadow caster sink (PLAN-lighting L3). Per-bucket meshes are
     *  registered once they finish loading (or when the placeholder
     *  lands). Pre-existing buckets are bulk-added when this is set. */
    private shadowGenerator: ShadowGenerator | null = null;

    constructor(scene: Scene, defCache: DefCache) {
        this.scene = scene;
        this.defCache = defCache;
        // Re-drain orphans every time a fresh def batch lands — a single
        // featuredefs.bin payload typically registers everything up
        // front, so this fires once and clears the queue, but the loop
        // handles arbitrary-order arrival without special-casing.
        this.defCache.onFeatureDefs(() => this.drainOrphans());
    }

    /// Apply a per-tick FeatureLifecycleBatch. Spawns whose def isn't
    /// in DefCache yet are stashed in `orphanedSpawns`; everything else
    /// gets a mesh slot synchronously (the .glb may still be loading,
    /// but the matrix buffer rebuild defers).
    applyLifecycleBatch(spawns: FeatureSpawnInfo[], removed: number[]): void {
        // Removed before spawned: net no-op. Iterate removes first so a
        // single-tick spawn+remove (rare but possible via Lua) doesn't
        // leave a dangling instance.
        const touchedBuckets = new Set<number>();
        for (const id of removed) {
            const defId = this.featureToDef.get(id);
            if (defId === undefined) continue;
            this.featureToDef.delete(id);
            const bucket = this.buckets.get(defId);
            if (!bucket) continue;
            if (bucket.instances.delete(id)) {
                touchedBuckets.add(defId);
            } else {
                // Could have still been in `pending` — drop from there too.
                const idx = bucket.pending.findIndex(p => p.featureId === id);
                if (idx >= 0) bucket.pending.splice(idx, 1);
            }
        }

        for (const s of spawns) {
            const def = this.defCache.getFeatureDef(s.defId);
            if (!def) {
                this.orphanedSpawns.push(s);
                continue;
            }
            this.spawnInternal(s, def);
            touchedBuckets.add(s.defId);
        }

        for (const defId of touchedBuckets) {
            this.rebuildBucket(defId);
        }
    }

    /// Register the directional sun-shadow generator (PLAN-lighting L3).
    /// Adds every already-built bucket mesh as a caster; new buckets
    /// register themselves on load completion.
    setShadowGenerator(csm: ShadowGenerator | null): void {
        this.shadowGenerator = csm;
        if (!csm) return;
        for (const bucket of this.buckets.values()) {
            if (bucket.mesh) {
                csm.addShadowCaster(bucket.mesh);
                bucket.mesh.receiveShadows = true;
            }
        }
    }

    /// Drop every dynamic feature (game session ended / restart).
    dispose(): void {
        for (const bucket of this.buckets.values()) {
            bucket.mesh?.dispose();
        }
        this.buckets.clear();
        this.featureToDef.clear();
        this.orphanedSpawns.length = 0;
    }

    // ── internal ────────────────────────────────────────────────────

    private spawnInternal(s: FeatureSpawnInfo, def: FeatureDefInfo): void {
        const instance: DynamicInstance = {
            featureId: s.featureId,
            x: s.x,
            y: s.y,
            z: s.z,
            headingRad: s.heading * HEADING_TO_RAD,
            // FeatureDef.radius lacks a `relativeSize` analogue and the
            // server-side wreck scale is 1.0 — let the def's own model
            // dimensions speak for themselves.
            scale: 1.0,
        };
        this.featureToDef.set(s.featureId, s.defId);

        let bucket = this.buckets.get(s.defId);
        if (!bucket) {
            bucket = {
                mesh: null,
                instances: new Map(),
                pending: [],
                loadStarted: false,
                isPlaceholder: false,
            };
            this.buckets.set(s.defId, bucket);
            this.beginLoad(s.defId, def, bucket);
        }

        if (bucket.mesh) {
            bucket.instances.set(s.featureId, instance);
        } else {
            bucket.pending.push(instance);
        }
    }

    private drainOrphans(): void {
        if (this.orphanedSpawns.length === 0) return;
        const ready: FeatureSpawnInfo[] = [];
        const stillOrphaned: FeatureSpawnInfo[] = [];
        for (const s of this.orphanedSpawns) {
            if (this.defCache.getFeatureDef(s.defId)) ready.push(s);
            else stillOrphaned.push(s);
        }
        this.orphanedSpawns = stillOrphaned;
        if (ready.length > 0) {
            // Replay through the normal path — defs are now resolvable.
            this.applyLifecycleBatch(ready, []);
        }
    }

    private beginLoad(defId: number, def: FeatureDefInfo, bucket: DefBucket): void {
        if (bucket.loadStarted) return;
        bucket.loadStarted = true;

        // No model URL → placeholder cube. Spring-side this means the
        // FeatureDef has drawType != 0 (tree / decal) or modelimporter
        // didn't produce a .glb. Still render so wrecks are visible
        // during dev; a future pass can swap in real tree billboards.
        if (!def.modelUrl) {
            bucket.mesh = this.makePlaceholder(def);
            bucket.isPlaceholder = true;
            this.commitPending(defId, bucket);
            return;
        }

        const lastSlash = def.modelUrl.lastIndexOf('/');
        const baseUrl = def.modelUrl.substring(0, lastSlash + 1);
        const fileName = def.modelUrl.substring(lastSlash + 1);

        // Don't stamp model URLs — see entity-renderer.ts loadModel().
        SceneLoader.ImportMeshAsync('', baseUrl, fileName, this.scene)
            .then((result) => {
                if (this.scene.isDisposed) return;
                const primary = pickPrimaryMesh(result.meshes);
                if (!primary) {
                    console.warn(`[feature-dyn] ${def.name}: glb has no geometry, using placeholder`);
                    bucket.mesh = this.makePlaceholder(def);
                    bucket.isPlaceholder = true;
                    this.commitPending(defId, bucket);
                    return;
                }
                for (const m of result.meshes) {
                    if (m !== primary) m.setEnabled(false);
                }
                primary.parent = null;
                primary.position.set(0, 0, 0);
                primary.rotationQuaternion = Quaternion.Identity();
                primary.scaling.set(1, 1, 1);
                primary.isPickable = false;

                // Use the same texture-application heuristic as the map
                // path. FeatureDefInfo and MapFeatureDefInfo share the
                // (modelUrl, textureUrl) shape so the helper just works.
                if (def.textureUrl) {
                    const tex = new Texture(def.textureUrl, this.scene);
                    const mat = primary.material;
                    if (mat instanceof StandardMaterial) {
                        mat.diffuseTexture?.dispose();
                        mat.diffuseTexture = tex;
                        mat.backFaceCulling = false;
                    } else if (mat instanceof PBRMaterial) {
                        mat.albedoTexture?.dispose();
                        mat.albedoTexture = tex;
                        mat.backFaceCulling = false;
                    } else {
                        tex.dispose();
                    }
                }

                bucket.mesh = primary;
                this.commitPending(defId, bucket);
            })
            .catch((err) => {
                if (this.scene.isDisposed) return;
                console.warn(`[feature-dyn] ${def.name}: failed to load ${def.modelUrl}, using placeholder`, err);
                bucket.mesh = this.makePlaceholder(def);
                bucket.isPlaceholder = true;
                this.commitPending(defId, bucket);
            });
    }

    private commitPending(defId: number, bucket: DefBucket): void {
        // First time the bucket has a mesh — register as a shadow caster.
        // Subsequent commits skip (caster list is per-mesh; instance count
        // changes don't need re-registration).
        if (bucket.mesh && this.shadowGenerator) {
            this.shadowGenerator.addShadowCaster(bucket.mesh);
            bucket.mesh.receiveShadows = true;
        }
        if (bucket.pending.length === 0) {
            this.rebuildBucket(defId);
            return;
        }
        for (const p of bucket.pending) {
            bucket.instances.set(p.featureId, p);
        }
        bucket.pending.length = 0;
        this.rebuildBucket(defId);
    }

    private rebuildBucket(defId: number): void {
        const bucket = this.buckets.get(defId);
        if (!bucket || !bucket.mesh) return;
        const count = bucket.instances.size;
        if (count === 0) {
            bucket.mesh.thinInstanceCount = 0;
            return;
        }
        const matrices = new Float32Array(count * 16);
        let i = 0;
        for (const inst of bucket.instances.values()) {
            const rot = Quaternion.FromEulerAngles(0, inst.headingRad, 0);
            const m = Matrix.Compose(
                new Vector3(inst.scale, inst.scale, inst.scale),
                rot,
                new Vector3(inst.x, inst.y, inst.z),
            );
            m.copyToArray(matrices, i * 16);
            i++;
        }
        bucket.mesh.thinInstanceSetBuffer('matrix', matrices, 16, true);
        // Same frustum-culling guard as the map path: the template
        // mesh's bounding info doesn't capture instance world bounds.
        bucket.mesh.alwaysSelectAsActiveMesh = true;
        bucket.mesh.thinInstanceRefreshBoundingInfo(false);
    }

    private makePlaceholder(def: FeatureDefInfo): Mesh {
        // Footprint is in heightmap squares (SQUARE_SIZE=8 elmos). Pick
        // the larger of footprint and a 32-elmo floor so even zero-
        // footprint wrecks have a visible cube.
        const size = Math.max(32, Math.max(def.footprintX, def.footprintZ) * 8);
        const m = MeshBuilder.CreateBox(
            `feature_dyn_placeholder_${def.defId}`, { size }, this.scene);
        m.position.y = size / 2;
        m.bakeCurrentTransformIntoVertices();
        const mat = new StandardMaterial(`feature_dyn_mat_${def.defId}`, this.scene);
        mat.diffuseColor = typeColour(def.name);
        mat.specularColor = new Color3(0.1, 0.1, 0.1);
        m.material = mat;
        m.isPickable = false;
        return m;
    }
}
