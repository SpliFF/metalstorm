/**
 * TerrainTexture — loads the minimap PNG and applies it to the terrain mesh.
 */

import {
    Scene,
    Mesh,
    Texture,
    StandardMaterial,
    Color3,
} from '@babylonjs/core';

export async function loadTerrainTexture(
    scene: Scene,
    mapBaseUrl: string,
    terrainMesh?: Mesh,
): Promise<void> {
    if (!terrainMesh) return;

    const imageUrl = `${mapBaseUrl}/minimap.png`;

    const texture = new Texture(imageUrl, scene, false, true, Texture.BILINEAR_SAMPLINGMODE, () => {
        console.log('[terrain-tex] minimap texture loaded');
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
