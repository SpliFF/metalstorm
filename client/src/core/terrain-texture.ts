/**
 * TerrainTexture — loads the minimap image and applies it to the terrain mesh.
 *
 * Uses the server-decoded BMP minimap (1024x1024) as a standard image
 * texture on the heightmap mesh. No custom KTX2/BC1 handling needed.
 */

import {
    Scene,
    Mesh,
    Texture,
    StandardMaterial,
    Color3,
} from '@babylonjs/core';

/**
 * Load the minimap texture and apply it to the terrain mesh.
 */
export async function loadTerrainTexture(
    scene: Scene,
    mapBaseUrl: string,
    terrainMesh?: Mesh,
): Promise<void> {
    if (!terrainMesh) return;

    const imageUrl = `${mapBaseUrl}/minimap.bmp`;

    // Load as a standard Babylon.js texture (handles BMP natively)
    const texture = new Texture(imageUrl, scene, false, true, Texture.BILINEAR_SAMPLINGMODE, () => {
        console.log('[terrain-tex] minimap texture loaded');

        // Apply to terrain mesh material
        const mat = terrainMesh.material as StandardMaterial;
        if (mat) {
            mat.diffuseTexture = texture;
            mat.diffuseColor = new Color3(1, 1, 1);
            mat.specularColor = new Color3(0.05, 0.05, 0.05);
        }
    }, (msg) => {
        console.warn('[terrain-tex] failed to load minimap:', msg);
    });
}
