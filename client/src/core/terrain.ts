/**
 * Terrain — heightmap mesh + DXT1 tile texture compositing.
 *
 * Builds a terrain mesh from uint16 heightmap data and textures it
 * by compositing 32x32 DXT1 tiles into larger WebGL textures using
 * compressedTexSubImage2D. No intermediate format conversion — raw
 * DXT1 bytes go straight from the server to the GPU.
 *
 * Spring coordinate system: X = east, Y = up, Z = south.
 * Each map square is SQUARE_SIZE (8) elmos wide.
 * Each tile covers 4x4 map squares = 32x32 texels.
 */

import {
    Scene,
    Mesh,
    VertexData,
    StandardMaterial,
    Texture,
    Color3,
    Vector3,
    VertexBuffer,
} from '@babylonjs/core';

const SQUARE_SIZE = 8;
const TILE_PIXELS = 32;
const TILE_DXT1_SIZE = 512; // (32/4)*(32/4)*8 bytes per tile mip0
const SQUARES_PER_TILE = 4; // each tile covers 4x4 squares

// DXT1 block size
const DXT1_BLOCK_BYTES = 8;

export interface MapDimensions {
    mapx: number;
    mapy: number;
    minHeight: number;
    maxHeight: number;
    tilesX: number;
    tilesZ: number;
}

/**
 * Build a terrain mesh from uint16 heightmap data.
 * Heights are scaled from uint16 (0-65535) to world units using min/max height.
 */
export function buildTerrainMesh(
    scene: Scene,
    dims: MapDimensions,
    heightData: Uint16Array,
): Mesh {
    const hmW = dims.mapx + 1; // vertices = squares + 1
    const hmH = dims.mapy + 1;

    // Subsample for performance (target ~512 vertices per axis max)
    const MAX_VERTS = 512;
    const stepX = Math.max(1, Math.floor(hmW / MAX_VERTS));
    const stepZ = Math.max(1, Math.floor(hmH / MAX_VERTS));
    const gridW = Math.floor((hmW - 1) / stepX) + 1;
    const gridH = Math.floor((hmH - 1) / stepZ) + 1;

    const numVerts = gridW * gridH;
    const positions = new Float32Array(numVerts * 3);
    const normals = new Float32Array(numVerts * 3);
    const uvs = new Float32Array(numVerts * 2);

    const hRange = dims.maxHeight - dims.minHeight;

    for (let gz = 0; gz < gridH; gz++) {
        const srcZ = Math.min(gz * stepZ, hmH - 1);
        for (let gx = 0; gx < gridW; gx++) {
            const srcX = Math.min(gx * stepX, hmW - 1);
            const idx = gz * gridW + gx;

            const raw = heightData[srcZ * hmW + srcX];
            const worldY = dims.minHeight + (raw / 65535) * hRange;

            positions[idx * 3 + 0] = srcX * SQUARE_SIZE;
            positions[idx * 3 + 1] = worldY;
            positions[idx * 3 + 2] = srcZ * SQUARE_SIZE;

            // UV maps to full map extent (0..1)
            uvs[idx * 2 + 0] = gx / (gridW - 1);
            uvs[idx * 2 + 1] = gz / (gridH - 1);
        }
    }

    // Triangle indices. Wind CCW when viewed from +Y (above) so the
    // computed normals point up. Cross product is (edge1) × (edge2):
    // for the top-left triangle we want (tr - tl) × (bl - tl) which gives
    // (+X) × (+Z) = +Y, i.e. up-pointing normal. That means the vertex
    // order must be tl, tr, bl (the 2nd and 3rd operands come after the
    // first vertex in the cross product).
    const numQuads = (gridW - 1) * (gridH - 1);
    const indices = new Uint32Array(numQuads * 6);
    let ti = 0;
    for (let gz = 0; gz < gridH - 1; gz++) {
        for (let gx = 0; gx < gridW - 1; gx++) {
            const tl = gz * gridW + gx;
            const tr = tl + 1;
            const bl = (gz + 1) * gridW + gx;
            const br = bl + 1;
            indices[ti++] = tl; indices[ti++] = tr; indices[ti++] = bl;
            indices[ti++] = tr; indices[ti++] = br; indices[ti++] = bl;
        }
    }

    VertexData.ComputeNormals(positions, indices, normals);

    const mesh = new Mesh('terrain', scene);
    const vd = new VertexData();
    vd.positions = positions;
    vd.indices = indices;
    vd.normals = normals;
    vd.uvs = uvs;
    vd.applyToMesh(mesh);

    // Default material (replaced when textures load)
    const mat = new StandardMaterial('terrainMat', scene);
    mat.diffuseColor = new Color3(0.3, 0.35, 0.2);
    mat.specularColor = new Color3(0.05, 0.05, 0.05);
    mat.backFaceCulling = false;
    mesh.material = mat;

    console.log(`[terrain] mesh: ${gridW}x${gridH} vertices (step ${stepX})`);
    return mesh;
}

/**
 * Cached tile data so multiple consumers (terrain, minimap) don't
 * refetch the same bytes.
 */
const tileDataCache = new Map<string, Promise<{
    tileIndex: Int32Array;
    tilesData: Uint8Array;
}>>();

async function fetchTileData(mapBaseUrl: string): Promise<{
    tileIndex: Int32Array;
    tilesData: Uint8Array;
}> {
    let entry = tileDataCache.get(mapBaseUrl);
    if (!entry) {
        entry = (async () => {
            const [tileIndexResp, tilesResp] = await Promise.all([
                fetch(`${mapBaseUrl}/tileindex.bin`),
                fetch(`${mapBaseUrl}/tiles.dxt1`),
            ]);
            if (!tileIndexResp.ok || !tilesResp.ok) {
                throw new Error('failed to fetch tile data');
            }
            const tileIndex = new Int32Array(await tileIndexResp.arrayBuffer());
            const tilesData = new Uint8Array(await tilesResp.arrayBuffer());
            console.log(`[terrain] tile index: ${tileIndex.length} entries, ` +
                `tiles: ${tilesData.length} bytes (${tilesData.length / TILE_DXT1_SIZE} tiles)`);
            return { tileIndex, tilesData };
        })();
        tileDataCache.set(mapBaseUrl, entry);
    }
    return entry;
}

/**
 * Atlas texture covering the whole map, built from DXT1 tiles.
 */
export interface MapAtlasTexture {
    webglTex: WebGLTexture;
    width: number;
    height: number;
}

/**
 * Build a single DXT1 atlas texture covering the whole map.
 *
 * Each Spring tile is 32×32 px. The map has tilesX × tilesZ tiles.
 * Atlas dimensions = tilesX * 32 by tilesZ * 32 pixels.
 * Spring maps are typically 896×896 squares → 224×224 tiles → 7168×7168 px.
 * Max WebGL2 texture size is normally 16384, so this fits.
 */
export async function buildMapAtlasTexture(
    gl: WebGL2RenderingContext,
    mapBaseUrl: string,
    dims: MapDimensions,
): Promise<MapAtlasTexture | null> {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const ext = gl.getExtension('WEBGL_compressed_texture_s3tc') as any;
    if (!ext) { console.warn('[terrain] S3TC not supported'); return null; }

    const { tileIndex, tilesData } = await fetchTileData(mapBaseUrl);

    const atlasW = dims.tilesX * TILE_PIXELS;
    const atlasH = dims.tilesZ * TILE_PIXELS;
    const maxTex = gl.getParameter(gl.MAX_TEXTURE_SIZE);
    if (atlasW > maxTex || atlasH > maxTex) {
        console.warn(`[terrain] atlas ${atlasW}x${atlasH} exceeds MAX_TEXTURE_SIZE ${maxTex}`);
        return null;
    }
    console.log(`[terrain] building atlas: ${atlasW}x${atlasH} (${dims.tilesX}x${dims.tilesZ} tiles)`);

    const atlasTex = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, atlasTex);

    // Allocate the full DXT1 texture with zeroed blocks, then fill in tiles.
    const atlasDxt1Size = (atlasW / 4) * (atlasH / 4) * DXT1_BLOCK_BYTES;
    const blank = new Uint8Array(atlasDxt1Size);
    gl.compressedTexImage2D(
        gl.TEXTURE_2D, 0, ext.COMPRESSED_RGB_S3TC_DXT1_EXT,
        atlasW, atlasH, 0, blank);

    let placed = 0, skipped = 0;
    for (let tz = 0; tz < dims.tilesZ; tz++) {
        for (let tx = 0; tx < dims.tilesX; tx++) {
            const tileIdx = tileIndex[tz * dims.tilesX + tx];
            if (tileIdx < 0) { skipped++; continue; }

            const tileOffset = tileIdx * TILE_DXT1_SIZE;
            if (tileOffset + TILE_DXT1_SIZE > tilesData.length) { skipped++; continue; }

            const tileData = tilesData.subarray(tileOffset, tileOffset + TILE_DXT1_SIZE);
            gl.compressedTexSubImage2D(
                gl.TEXTURE_2D, 0,
                tx * TILE_PIXELS, tz * TILE_PIXELS, TILE_PIXELS, TILE_PIXELS,
                ext.COMPRESSED_RGB_S3TC_DXT1_EXT,
                tileData);
            placed++;
        }
    }

    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

    const glErr = gl.getError();
    if (glErr !== gl.NO_ERROR) {
        console.warn(`[terrain] gl error after atlas upload: 0x${glErr.toString(16)}`);
    }
    gl.bindTexture(gl.TEXTURE_2D, null);

    console.log(`[terrain] atlas built: ${placed} tiles placed, ${skipped} skipped`);
    return { webglTex: atlasTex, width: atlasW, height: atlasH };
}

/**
 * Composite DXT1 tiles into a full-map atlas texture and apply to terrain.
 */
export async function loadTerrainTextures(
    scene: Scene,
    terrainMesh: Mesh,
    mapBaseUrl: string,
    dims: MapDimensions,
): Promise<void> {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const gl = (scene.getEngine() as any)._gl as WebGL2RenderingContext;
    if (!gl) { console.warn('[terrain] no WebGL context'); return; }

    const atlas = await buildMapAtlasTexture(gl, mapBaseUrl, dims);
    if (!atlas) return;

    applyWebGLTexture(scene, terrainMesh, atlas.webglTex, atlas.width, atlas.height);
}

/**
 * Wrap a raw WebGL texture in a Babylon.js material and apply to mesh.
 * Uses Engine.wrapWebGLTexture() — the supported path for adopting an
 * externally-created GL texture into Babylon's material system.
 */
export function applyWebGLTexture(
    scene: Scene, mesh: Mesh,
    webglTex: WebGLTexture, width: number, height: number,
): void {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const engine = scene.getEngine() as any;
    const internalTex = engine.wrapWebGLTexture(webglTex, false, 1 /* nearest */, width, height);

    const texture = new Texture(null, scene);
    texture._texture = internalTex;

    // Remove vertex colours if present (they'd multiply with the sampled
    // diffuse colour and darken the terrain)
    if (mesh.isVerticesDataPresent(VertexBuffer.ColorKind)) {
        mesh.removeVerticesData(VertexBuffer.ColorKind);
    }
    mesh.hasVertexAlpha = false;

    const mat = new StandardMaterial('terrainTexMat', scene);
    mat.diffuseTexture = texture;
    mat.diffuseColor = new Color3(1, 1, 1);
    mat.specularColor = new Color3(0.05, 0.05, 0.05);
    mat.backFaceCulling = false;
    mesh.material = mat;
}

/**
 * Load heightmap from HTTP (raw uint16 binary with 8-byte header).
 * This is the game server's /api/map/heightmap format.
 */
export async function fetchHeightmap(url: string): Promise<{
    width: number; height: number; data: Uint16Array;
    minH: number; maxH: number;
} | null> {
    try {
        const resp = await fetch(url);
        if (!resp.ok) return null;
        const buf = await resp.arrayBuffer();
        const view = new DataView(buf);
        const width = view.getUint32(0, true);
        const height = view.getUint32(4, true);
        // The game server sends float32 heights; for raw uint16 from processed data,
        // we need the min/max from map info to scale.
        // Check if this is the game server format (float32) or processed format (uint16)
        if (buf.byteLength === 8 + width * height * 4) {
            // Float32 format from game server
            const floats = new Float32Array(buf, 8, width * height);
            // Convert to uint16 for the mesh builder
            let minH = Infinity, maxH = -Infinity;
            for (let i = 0; i < floats.length; i++) {
                if (floats[i] < minH) minH = floats[i];
                if (floats[i] > maxH) maxH = floats[i];
            }
            const range = maxH - minH || 1;
            const uint16 = new Uint16Array(floats.length);
            for (let i = 0; i < floats.length; i++) {
                uint16[i] = Math.round(((floats[i] - minH) / range) * 65535);
            }
            return { width, height, data: uint16, minH, maxH };
        }
        // Raw uint16 format from processed map data (no header)
        const uint16 = new Uint16Array(buf);
        return { width: 0, height: 0, data: uint16, minH: 0, maxH: 0 };
    } catch {
        return null;
    }
}
