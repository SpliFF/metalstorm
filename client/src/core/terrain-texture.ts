/**
 * TerrainTexture — loads the minimap PNG and applies it to the terrain mesh.
 */

import {
    Scene,
    Mesh,
    Texture,
    StandardMaterial,
    Color3,
    VertexBuffer,
} from '@babylonjs/core';

export async function loadTerrainTexture(
    scene: Scene,
    mapBaseUrl: string,
    terrainMesh?: Mesh,
): Promise<void> {
    if (!terrainMesh) return;

    const imageUrl = `${mapBaseUrl}/minimap.png`;

    const texture = new Texture(imageUrl, scene, false, true, Texture.BILINEAR_SAMPLINGMODE, () => {
        console.log('[terrain-tex] minimap texture loaded, applying to terrain');

        // Remove vertex colours so they don't multiply with/darken the texture
        if (terrainMesh.isVerticesDataPresent(VertexBuffer.ColorKind)) {
            terrainMesh.removeVerticesData(VertexBuffer.ColorKind);
        }
        // Force Babylon to not use vertex colour channel
        terrainMesh.hasVertexAlpha = false;

        // Replace material entirely to ensure clean state
        const mat = new StandardMaterial('terrainTexMat', scene);
        mat.diffuseTexture = texture;
        mat.diffuseColor = new Color3(1, 1, 1);
        mat.specularColor = new Color3(0.05, 0.05, 0.05);
        mat.backFaceCulling = false;
        terrainMesh.material = mat;
    }, (msg) => {
        console.warn('[terrain-tex] failed to load minimap:', msg);
    });
}
