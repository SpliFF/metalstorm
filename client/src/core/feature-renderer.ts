/**
 * FeatureRenderer — placeholder rendering for map features.
 *
 * Features are static map objects (trees, rocks, wrecks) placed by the mapper.
 * Until we have a proper model pipeline (Assimp + shared Entity base class),
 * we render each one as a thin-instanced box coloured by feature type.
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
} from '@babylonjs/core';
import type { ParsedMapData, MapFeatureInstance } from './map-data.js';

/// Hash a string to a stable RGB tint so each feature type gets its own colour.
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

/// Rough default extents (elmos) per feature. Can be tuned per-type later.
const DEFAULT_FEATURE_EXTENTS = 32;

/**
 * Render every map feature as a thin-instanced box, grouped by type.
 * Returns the created meshes (one per type).
 */
export function renderMapFeatures(scene: Scene, map: ParsedMapData): Mesh[] {
    // Bucket features by type so each type becomes one thin-instance mesh
    const buckets = new Map<number, MapFeatureInstance[]>();
    for (const f of map.features) {
        let b = buckets.get(f.typeIndex);
        if (!b) { b = []; buckets.set(f.typeIndex, b); }
        b.push(f);
    }

    const meshes: Mesh[] = [];
    for (const [typeIdx, instances] of buckets) {
        if (instances.length === 0) continue;
        const typeName = map.featureTypes[typeIdx] ?? `type_${typeIdx}`;

        const base = MeshBuilder.CreateBox(
            `feature_${typeName}`,
            { size: DEFAULT_FEATURE_EXTENTS },
            scene,
        );
        const mat = new StandardMaterial(`featureMat_${typeName}`, scene);
        mat.diffuseColor = typeColour(typeName);
        mat.specularColor = new Color3(0.1, 0.1, 0.1);
        base.material = mat;
        base.isPickable = false;
        base.doNotSyncBoundingInfo = true;

        // Build a per-instance matrix buffer
        const matrices = new Float32Array(instances.length * 16);
        for (let i = 0; i < instances.length; i++) {
            const f = instances[i];
            const scale = Math.max(0.25, f.relativeSize);
            const rot = Quaternion.FromEulerAngles(0, f.rotation, 0);
            const m = Matrix.Compose(
                new Vector3(scale, scale * 2, scale),
                rot,
                new Vector3(f.x, f.y + (DEFAULT_FEATURE_EXTENTS * scale), f.z),
            );
            m.copyToArray(matrices, i * 16);
        }
        base.thinInstanceSetBuffer('matrix', matrices, 16, true);
        meshes.push(base);
    }

    console.log(`[features] rendered ${map.features.length} features in ${buckets.size} types`);
    return meshes;
}
