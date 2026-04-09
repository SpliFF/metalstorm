/**
 * TerrainTexture — loads KTX2 BC1 map texture chunks and applies to terrain.
 *
 * The server processes Spring SMF/SMT map data into a grid of 256x256
 * KTX2 BC1 texture chunks. This loader fetches the layout, loads chunks
 * on demand, and creates textured ground tiles in the Babylon.js scene.
 *
 * Each chunk maps to a section of the terrain mesh. The BC1 data is
 * uploaded directly to the GPU via compressedTexImage2D — no CPU decode.
 */

import {
    Scene,
    Mesh,
    MeshBuilder,
    RawTexture,
    StandardMaterial,
    Texture,
    Vector3,
    Color3,
    Constants,
} from '@babylonjs/core';

interface ChunkLayout {
    chunksX: number;
    chunksZ: number;
    chunkTiles: number;
    chunkPixels: number;
    tilesX: number;
    tilesZ: number;
    tilePixels: number;
}

// KTX2 header constants
const KTX2_MAGIC = [0xAB, 0x4B, 0x54, 0x58, 0x20, 0x32, 0x30, 0xBB, 0x0D, 0x0A, 0x1A, 0x0A];
const SQUARE_SIZE = 8; // Spring elmos per heightmap square

/**
 * Parse a minimal KTX2 file and extract the BC1 mip0 data.
 * Returns { width, height, bc1Data } or null.
 */
function parseKTX2(buffer: ArrayBuffer): { width: number; height: number; data: Uint8Array } | null {
    const view = new DataView(buffer);

    // Verify magic
    for (let i = 0; i < 12; i++) {
        if (view.getUint8(i) !== KTX2_MAGIC[i]) return null;
    }

    const width = view.getUint32(20, true);
    const height = view.getUint32(24, true);
    const levelCount = view.getUint32(40, true);
    if (levelCount < 1) return null;

    // Read level 0 index (at offset 80)
    const dataOffset = Number(view.getBigUint64(80, true));
    const dataLength = Number(view.getBigUint64(88, true));

    return {
        width,
        height,
        data: new Uint8Array(buffer, dataOffset, dataLength),
    };
}

/**
 * Create a Babylon.js texture from BC1/DXT1 compressed data.
 */
function createBC1Texture(
    scene: Scene,
    name: string,
    width: number,
    height: number,
    bc1Data: Uint8Array,
): RawTexture | null {
    const engine = scene.getEngine();

    // Create compressed texture via Babylon.js API
    // Constants.TEXTUREFORMAT_COMPRESSED_RGB_S3TC_DXT1 = 33776 (0x83F1)
    const S3TC_DXT1 = 33776;

    const texture = RawTexture.CreateRGBTexture(
        null, width, height, scene,
        false, false, Texture.BILINEAR_SAMPLINGMODE,
    );

    // Upload compressed data directly through the engine
    const gl = (engine as any)._gl as WebGL2RenderingContext;
    if (!gl) return texture; // fallback: empty texture

    const ext = gl.getExtension('WEBGL_compressed_texture_s3tc');
    if (!ext) {
        console.warn('[terrain-tex] S3TC not supported');
        return texture;
    }

    const webglTex = (texture.getInternalTexture() as any)?._webGLTexture;
    if (!webglTex) return texture;

    gl.bindTexture(gl.TEXTURE_2D, webglTex);
    gl.compressedTexImage2D(
        gl.TEXTURE_2D, 0, ext.COMPRESSED_RGB_S3TC_DXT1_EXT,
        width, height, 0, bc1Data,
    );
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.bindTexture(gl.TEXTURE_2D, null);

    const internalTex = texture.getInternalTexture();
    if (internalTex) {
        internalTex.width = width;
        internalTex.height = height;
        internalTex.isReady = true;
    }

    return texture;
}

/**
 * Load the full terrain texture from KTX2 chunks and create ground planes.
 *
 * @param scene - Babylon.js scene
 * @param mapBaseUrl - base URL for map data (e.g. http://host:port/api/maps/data/mapId)
 * @param existingTerrainMesh - optional: hide this mesh once chunks are loaded
 */
export async function loadTerrainTexture(
    scene: Scene,
    mapBaseUrl: string,
    existingTerrainMesh?: Mesh,
): Promise<Mesh[]> {
    // Fetch layout
    const layoutResp = await fetch(`${mapBaseUrl}/layout.json`);
    if (!layoutResp.ok) {
        console.warn('[terrain-tex] no layout.json found');
        return [];
    }
    const layout: ChunkLayout = await layoutResp.json();

    console.log(`[terrain-tex] loading ${layout.chunksX}x${layout.chunksZ} chunks`);

    const meshes: Mesh[] = [];
    const chunkWorldSize = layout.chunkPixels * SQUARE_SIZE / layout.tilePixels;
    // Each tile covers tilePixels/texelPerSquare squares, each square is SQUARE_SIZE elmos
    // Actually: each tile is 32 texels covering 4 map squares (texelPerSquare=8, tileSize=32)
    // So 4 squares * 8 elmos = 32 elmos per tile
    // A chunk of 8 tiles = 8*32 = 256 elmos
    const tileSizeElmos = 4 * SQUARE_SIZE; // 32 elmos per tile
    const chunkSizeElmos = layout.chunkTiles * tileSizeElmos;

    // Load chunks in parallel (batch to avoid too many concurrent requests)
    const BATCH_SIZE = 16;
    const totalChunks = layout.chunksX * layout.chunksZ;
    let loaded = 0;

    for (let batch = 0; batch < totalChunks; batch += BATCH_SIZE) {
        const promises: Promise<void>[] = [];

        for (let i = batch; i < Math.min(batch + BATCH_SIZE, totalChunks); i++) {
            const cx = i % layout.chunksX;
            const cz = Math.floor(i / layout.chunksX);

            promises.push((async () => {
                const url = `${mapBaseUrl}/chunk_${cx}_${cz}.ktx2`;
                try {
                    const resp = await fetch(url);
                    if (!resp.ok) return;

                    const buf = await resp.arrayBuffer();
                    const ktx = parseKTX2(buf);
                    if (!ktx) return;

                    const texture = createBC1Texture(scene, `chunk_${cx}_${cz}`, ktx.width, ktx.height, ktx.data);
                    if (!texture) return;

                    // Create a ground plane for this chunk
                    const actualW = Math.min(layout.chunkTiles, layout.tilesX - cx * layout.chunkTiles) * tileSizeElmos;
                    const actualH = Math.min(layout.chunkTiles, layout.tilesZ - cz * layout.chunkTiles) * tileSizeElmos;

                    const ground = MeshBuilder.CreateGround(`terrain_chunk_${cx}_${cz}`, {
                        width: actualW,
                        height: actualH,
                        subdivisions: 1,
                    }, scene);

                    ground.position.x = cx * chunkSizeElmos + actualW / 2;
                    ground.position.z = cz * chunkSizeElmos + actualH / 2;
                    ground.position.y = 0.1; // slightly above heightmap mesh to prevent z-fighting

                    const mat = new StandardMaterial(`chunk_mat_${cx}_${cz}`, scene);
                    mat.diffuseTexture = texture;
                    mat.specularColor = new Color3(0.05, 0.05, 0.05);
                    mat.backFaceCulling = false;
                    ground.material = mat;

                    meshes.push(ground);
                    loaded++;
                } catch { /* chunk load failed, skip */ }
            })());
        }

        await Promise.all(promises);
    }

    console.log(`[terrain-tex] loaded ${loaded}/${totalChunks} chunks`);

    // Hide the vertex-coloured terrain mesh now that we have textures
    if (existingTerrainMesh && loaded > 0) {
        existingTerrainMesh.isVisible = false;
    }

    return meshes;
}
