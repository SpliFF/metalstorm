/**
 * TerrainTexture — loads map texture and applies to the terrain mesh.
 *
 * Strategy: load the 1024x1024 minimap KTX2 (BC1) and apply it to the
 * existing heightmap terrain mesh as a diffuse texture. The terrain mesh
 * already has 0..1 UV coordinates that match the minimap perfectly.
 *
 * For higher resolution, a future version will load individual tile
 * chunks and composite them.
 */

import {
    Scene,
    Mesh,
    Texture,
    StandardMaterial,
    Color3,
    Constants,
} from '@babylonjs/core';

// KTX2 header magic
const KTX2_MAGIC = [0xAB, 0x4B, 0x54, 0x58, 0x20, 0x32, 0x30, 0xBB, 0x0D, 0x0A, 0x1A, 0x0A];

function parseKTX2(buffer: ArrayBuffer): { width: number; height: number; data: Uint8Array } | null {
    const view = new DataView(buffer);
    for (let i = 0; i < 12; i++) {
        if (view.getUint8(i) !== KTX2_MAGIC[i]) return null;
    }
    const width = view.getUint32(20, true);
    const height = view.getUint32(24, true);
    const levelCount = view.getUint32(40, true);
    if (levelCount < 1) return null;

    const dataOffset = Number(view.getBigUint64(80, true));
    const dataLength = Number(view.getBigUint64(88, true));
    return { width, height, data: new Uint8Array(buffer, dataOffset, dataLength) };
}

/**
 * Decode BC1/DXT1 compressed data to RGBA8 on CPU.
 * Needed when we want to composite or when S3TC isn't available.
 */
function decodeBC1toRGBA(bc1: Uint8Array, width: number, height: number): Uint8Array {
    const rgba = new Uint8Array(width * height * 4);
    const bw = width >> 2;
    const bh = height >> 2;

    for (let by = 0; by < bh; by++) {
        for (let bx = 0; bx < bw; bx++) {
            const off = (by * bw + bx) * 8;
            const c0 = bc1[off] | (bc1[off + 1] << 8);
            const c1 = bc1[off + 2] | (bc1[off + 3] << 8);
            const bits = bc1[off + 4] | (bc1[off + 5] << 8) | (bc1[off + 6] << 16) | (bc1[off + 7] << 24);

            const r = (c: number) => ((c >> 11) & 0x1f) * 255 / 31;
            const g = (c: number) => ((c >> 5) & 0x3f) * 255 / 63;
            const b = (c: number) => (c & 0x1f) * 255 / 31;

            const colors: number[][] = [
                [r(c0), g(c0), b(c0)],
                [r(c1), g(c1), b(c1)],
                [0, 0, 0],
                [0, 0, 0],
            ];

            if (c0 > c1) {
                colors[2] = colors[0].map((v, i) => (2 * v + colors[1][i]) / 3);
                colors[3] = colors[0].map((v, i) => (v + 2 * colors[1][i]) / 3);
            } else {
                colors[2] = colors[0].map((v, i) => (v + colors[1][i]) / 2);
                colors[3] = [0, 0, 0];
            }

            for (let py = 0; py < 4; py++) {
                for (let px = 0; px < 4; px++) {
                    const idx = (bits >> (2 * (py * 4 + px))) & 3;
                    const x = bx * 4 + px;
                    const y = by * 4 + py;
                    const o = (y * width + x) * 4;
                    rgba[o] = colors[idx][0];
                    rgba[o + 1] = colors[idx][1];
                    rgba[o + 2] = colors[idx][2];
                    rgba[o + 3] = 255;
                }
            }
        }
    }
    return rgba;
}

/**
 * Load the minimap texture from KTX2 and apply it to the terrain mesh.
 */
export async function loadTerrainTexture(
    scene: Scene,
    mapBaseUrl: string,
    terrainMesh?: Mesh,
): Promise<Mesh[]> {
    if (!terrainMesh) return [];

    // Load minimap KTX2
    const resp = await fetch(`${mapBaseUrl}/minimap.ktx2`);
    if (!resp.ok) {
        console.warn('[terrain-tex] minimap.ktx2 not found');
        return [];
    }

    const buf = await resp.arrayBuffer();
    const ktx = parseKTX2(buf);
    if (!ktx) {
        console.warn('[terrain-tex] failed to parse minimap KTX2');
        return [];
    }

    console.log(`[terrain-tex] minimap: ${ktx.width}x${ktx.height}, ${ktx.data.length} bytes BC1`);

    const engine = scene.getEngine();
    const gl = (engine as any)._gl as WebGL2RenderingContext | null;

    let texture: Texture;

    // Try compressed upload first (fastest, no CPU decode)
    const ext = gl?.getExtension('WEBGL_compressed_texture_s3tc');
    if (gl && ext) {
        const webglTex = gl.createTexture();
        gl.bindTexture(gl.TEXTURE_2D, webglTex);
        gl.compressedTexImage2D(
            gl.TEXTURE_2D, 0, ext.COMPRESSED_RGB_S3TC_DXT1_EXT,
            ktx.width, ktx.height, 0, ktx.data,
        );
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
        gl.bindTexture(gl.TEXTURE_2D, null);

        // Wrap in Babylon.js texture
        const internalTex = engine._createInternalTexture({ width: ktx.width, height: ktx.height }, false, false);
        (internalTex as any)._webGLTexture = webglTex;
        internalTex.width = ktx.width;
        internalTex.height = ktx.height;
        internalTex.isReady = true;

        texture = new Texture(null, scene);
        texture._texture = internalTex;
        console.log('[terrain-tex] using compressed BC1 upload');
    } else {
        // Fallback: decode to RGBA on CPU
        const rgba = decodeBC1toRGBA(ktx.data, ktx.width, ktx.height);
        const rawTex = engine.createRawTexture(
            rgba, ktx.width, ktx.height,
            Constants.TEXTUREFORMAT_RGBA,
            false, false, Texture.BILINEAR_SAMPLINGMODE, null,
            Constants.TEXTURETYPE_UNSIGNED_BYTE,
        );
        texture = new Texture(null, scene);
        texture._texture = rawTex;
        console.log('[terrain-tex] using CPU-decoded RGBA fallback');
    }

    // Apply to terrain mesh
    const mat = terrainMesh.material as StandardMaterial;
    if (mat) {
        mat.diffuseTexture = texture;
        mat.diffuseColor = new Color3(1, 1, 1);
        mat.specularColor = new Color3(0.05, 0.05, 0.05);
        console.log('[terrain-tex] applied to terrain mesh');
    }

    return [];
}
