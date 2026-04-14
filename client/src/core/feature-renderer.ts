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
    Color3,
    Mesh,
    Matrix,
    Quaternion,
    Vector3,
    SceneLoader,
    Texture,
} from '@babylonjs/core';
// Side-effect import: registers the glTF loader plugin so SceneLoader
// can read our `.glb` files. Without this, .glb requests fail with
// "Unable to find a plugin to load .glb files".
import '@babylonjs/loaders/glTF/index.js';

import type { ParsedMapData, MapFeatureInstance, MapFeatureDefInfo } from './map-data.js';
import { stampUrl } from '../config.js';

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

/// Apply the per-feature texture (already a `.png` from the server pipeline)
/// to the loaded mesh's material. Loaded glb materials reference the same
/// texture by relative URI but Babylon resolves it relative to the glb URL —
/// since both are served from `/api/maps/data/{id}/features/`, this
/// generally Just Works without an explicit override. We still attach an
/// explicit Texture so we can guarantee correct sampling settings.
function applyTexture(mesh: Mesh, def: MapFeatureDefInfo, scene: Scene) {
    if (!def.textureUrl) return;
    const mat = mesh.material;
    if (!mat || !(mat instanceof StandardMaterial)) {
        // glTF materials are PBRMaterial by default; the loader handles
        // the baseColorTexture binding for us. Nothing to do here.
        return;
    }
    const tex = new Texture(def.textureUrl, scene);
    tex.hasAlpha = false;
    mat.diffuseTexture = tex;
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

/**
 * Render every map feature using its converted glb model. Returns the list
 * of root meshes — one per feature type that successfully loaded, plus one
 * placeholder mesh per type that did not.
 *
 * Loading is asynchronous (each glb is fetched + parsed by Babylon), so this
 * function returns a Promise that resolves once every type has been wired up.
 * Placements with `typeIndex` outside the `featureDefs` array are silently
 * dropped.
 */
export async function renderMapFeatures(scene: Scene, map: ParsedMapData): Promise<Mesh[]> {
    // Bucket placements by type index.
    const buckets = new Map<number, MapFeatureInstance[]>();
    for (const f of map.features) {
        let b = buckets.get(f.typeIndex);
        if (!b) { b = []; buckets.set(f.typeIndex, b); }
        b.push(f);
    }

    const results: Mesh[] = [];
    let modelTypes = 0;
    let skippedTypes = 0;
    let placeholderTypes = 0;

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

                const result = await SceneLoader.ImportMeshAsync(
                    '', baseUrl, stampUrl(fileName), scene,
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
                console.warn(`[features] ${typeName}: failed to load ${def.modelUrl}, falling back to placeholder`, err);
                results.push(renderPlaceholder(scene, typeName, instances));
                placeholderTypes++;
            }
        })());
    }

    await Promise.all(promises);

    console.log(
        `[features] rendered ${map.features.length} placement(s) across ` +
        `${modelTypes} model type(s), ${placeholderTypes} load-failure placeholder(s), ` +
        `${skippedTypes} decal-only type(s) skipped`,
    );
    return results;
}
