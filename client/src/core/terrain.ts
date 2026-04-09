/**
 * Terrain — loads and renders heightmap terrain from the server.
 *
 * Fetches the raw heightmap from /api/map/heightmap and builds a
 * subdivided ground mesh in Babylon.js. The heightmap is a grid of
 * (mapx+1) x (mapy+1) float32 corner heights.
 *
 * Spring coordinate system: X = east, Y = up, Z = south.
 * Each map square is SQUARE_SIZE (8) elmos wide.
 */

import {
    Scene,
    Mesh,
    VertexData,
    StandardMaterial,
    Color3,
    Vector3,
} from '@babylonjs/core';

const SQUARE_SIZE = 8;

export interface MapInfo {
    mapx: number;
    mapy: number;
    squareSize: number;
    widthElmos: number;
    heightElmos: number;
}

/**
 * Fetch map info from the server.
 */
export async function fetchMapInfo(baseUrl: string): Promise<MapInfo | null> {
    try {
        const resp = await fetch(`${baseUrl}/api/map/info`);
        if (!resp.ok) return null;
        return await resp.json() as MapInfo;
    } catch {
        return null;
    }
}

/**
 * Fetch and parse the raw heightmap from the server.
 * Returns { width, height, data: Float32Array } or null on failure.
 */
export async function fetchHeightmap(baseUrl: string): Promise<{
    width: number;
    height: number;
    data: Float32Array;
} | null> {
    try {
        const resp = await fetch(`${baseUrl}/api/map/heightmap`);
        if (!resp.ok) return null;

        const buf = await resp.arrayBuffer();
        const view = new DataView(buf);
        const width = view.getUint32(0, true);
        const height = view.getUint32(4, true);
        const data = new Float32Array(buf, 8, width * height);
        return { width, height, data };
    } catch {
        return null;
    }
}

/**
 * Build a terrain mesh from the heightmap.
 *
 * For large maps, we subsample the heightmap to keep the vertex count
 * manageable. A 512x512 map has 513x513 = ~263K vertices at full res;
 * we target ~65K vertices max (256x256 grid).
 */
export function buildTerrainMesh(
    scene: Scene,
    hmWidth: number,
    hmHeight: number,
    heightData: Float32Array,
): Mesh {
    // Subsample if needed (target ~256 vertices per axis max)
    const MAX_VERTS = 256;
    const stepX = Math.max(1, Math.floor(hmWidth / MAX_VERTS));
    const stepZ = Math.max(1, Math.floor(hmHeight / MAX_VERTS));

    const gridW = Math.floor((hmWidth - 1) / stepX) + 1;
    const gridH = Math.floor((hmHeight - 1) / stepZ) + 1;

    const numVertices = gridW * gridH;
    const positions = new Float32Array(numVertices * 3);
    const normals = new Float32Array(numVertices * 3);
    const colors = new Float32Array(numVertices * 4);
    const uvs = new Float32Array(numVertices * 2);

    // Find height range for colour mapping
    let minH = Infinity, maxH = -Infinity;
    for (let i = 0; i < heightData.length; i++) {
        if (heightData[i] < minH) minH = heightData[i];
        if (heightData[i] > maxH) maxH = heightData[i];
    }
    const hRange = Math.max(maxH - minH, 1);

    // Fill vertex positions
    for (let gz = 0; gz < gridH; gz++) {
        const srcZ = Math.min(gz * stepZ, hmHeight - 1);
        for (let gx = 0; gx < gridW; gx++) {
            const srcX = Math.min(gx * stepX, hmWidth - 1);
            const idx = gz * gridW + gx;

            const worldX = srcX * SQUARE_SIZE;
            const worldZ = srcZ * SQUARE_SIZE;
            const worldY = heightData[srcZ * hmWidth + srcX];

            positions[idx * 3 + 0] = worldX;
            positions[idx * 3 + 1] = worldY;
            positions[idx * 3 + 2] = worldZ;

            // Height-based vertex colour
            const t = (worldY - minH) / hRange; // 0..1
            if (worldY < 0) {
                // Below water: blue tint
                colors[idx * 4 + 0] = 0.15;
                colors[idx * 4 + 1] = 0.2;
                colors[idx * 4 + 2] = 0.35;
            } else if (t < 0.2) {
                // Low: sandy/beach
                colors[idx * 4 + 0] = 0.55 + t;
                colors[idx * 4 + 1] = 0.5 + t * 0.5;
                colors[idx * 4 + 2] = 0.3;
            } else if (t < 0.6) {
                // Mid: green
                colors[idx * 4 + 0] = 0.25;
                colors[idx * 4 + 1] = 0.35 + (t - 0.2) * 0.5;
                colors[idx * 4 + 2] = 0.15;
            } else if (t < 0.85) {
                // High: brown/rock
                colors[idx * 4 + 0] = 0.35 + (t - 0.6) * 0.4;
                colors[idx * 4 + 1] = 0.25 + (t - 0.6) * 0.2;
                colors[idx * 4 + 2] = 0.15;
            } else {
                // Peak: light grey/snow
                const s = 0.5 + (t - 0.85) * 2;
                colors[idx * 4 + 0] = s;
                colors[idx * 4 + 1] = s;
                colors[idx * 4 + 2] = s * 0.95;
            }
            colors[idx * 4 + 3] = 1.0; // alpha

            uvs[idx * 2 + 0] = gx / (gridW - 1);
            uvs[idx * 2 + 1] = gz / (gridH - 1);
        }
    }

    // Build triangle indices
    const numQuads = (gridW - 1) * (gridH - 1);
    const indices = new Uint32Array(numQuads * 6);
    let triIdx = 0;

    for (let gz = 0; gz < gridH - 1; gz++) {
        for (let gx = 0; gx < gridW - 1; gx++) {
            const tl = gz * gridW + gx;
            const tr = tl + 1;
            const bl = (gz + 1) * gridW + gx;
            const br = bl + 1;

            indices[triIdx++] = tl;
            indices[triIdx++] = bl;
            indices[triIdx++] = tr;

            indices[triIdx++] = tr;
            indices[triIdx++] = bl;
            indices[triIdx++] = br;
        }
    }

    // Compute normals
    VertexData.ComputeNormals(positions, indices, normals);

    // Create mesh
    const mesh = new Mesh('terrain', scene);
    const vertexData = new VertexData();
    vertexData.positions = positions;
    vertexData.indices = indices;
    vertexData.normals = normals;
    vertexData.colors = colors;
    vertexData.uvs = uvs;
    vertexData.applyToMesh(mesh);

    // Material using vertex colours
    const mat = new StandardMaterial('terrainMat', scene);
    mat.diffuseColor = new Color3(1, 1, 1); // let vertex colours drive colour
    mat.specularColor = new Color3(0.1, 0.1, 0.1);
    mat.backFaceCulling = false;
    mesh.material = mat;
    mesh.hasVertexAlpha = false;

    return mesh;
}

/**
 * Load terrain from the server and create the mesh.
 * Returns the mesh, or null if the server has no map loaded.
 */
export async function loadTerrain(scene: Scene, baseUrl: string): Promise<Mesh | null> {
    const hm = await fetchHeightmap(baseUrl);
    if (!hm) {
        console.warn('[terrain] no heightmap available from server');
        return null;
    }

    console.log(`[terrain] heightmap loaded: ${hm.width}x${hm.height} (${(hm.data.byteLength / 1024).toFixed(0)} KB)`);

    const mesh = buildTerrainMesh(scene, hm.width, hm.height, hm.data);

    console.log(`[terrain] mesh built: ${mesh.getTotalVertices()} vertices`);
    return mesh;
}
