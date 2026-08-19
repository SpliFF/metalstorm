/**
 * Terrain page GL layer — the `PageUploader` seam of streaming v2
 * (PLAN-maps.md §1.2.1), i.e. the one module that touches raw WebGL.
 *
 * ⚠ **DIVERGENCE (recorded in §1.2.1 and `terrain-page-cache.ts`): the
 * physical cache is filled with raw `gl.compressedTexSubImage3D`.** Babylon 9
 * has no public API for a partial update of a compressed 2D-array texture —
 * `RawTexture2DArray` takes uncompressed data and `updateTexture` has no
 * compressed-subimage path — so this module reaches the context through
 * `getEngineGl` (the single recorded upgrade point) exactly as `terrain.ts`
 * does for `compressedTexImage2D` on the DXT1 atlas. The texture is adopted
 * back into Babylon with `Engine.wrapWebGLTexture`, which IS the supported
 * seam for an externally created texture; only the sub-image call (and the
 * pre-wrap unbind below) is the divergence.
 *
 * GL error discipline is `buildAtlasPage`'s (PLAN-maps M8g): `getError`
 * reports the OLDEST error queued anywhere in the context, so the queue is
 * drained BEFORE our calls (reporting pre-existing damage instead of
 * swallowing it) and checked per call, so a warning names the call that
 * actually failed.
 */

import { Engine, Scene, Texture, RawTexture } from '@babylonjs/core';
import { getEngineGl } from './engine-gl.js';
import { drainGlErrors } from './terrain.js';
import { PAGE_PHYSICAL_TEXELS, PAGE_BYTES } from './terrain-page-grid.js';
import type { PageUploader, TerrainPageCache } from './terrain-page-cache.js';

/**
 * The physical page cache: one `TEXTURE_2D_ARRAY` of 520² BC1 layers, no
 * internal mips (the page pyramid IS the mip chain — `terrain-page-grid.ts`),
 * filled layer-by-layer via `compressedTexSubImage3D`.
 */
export class TerrainPageGlUploader implements PageUploader {
    readonly texture: WebGLTexture;
    readonly layers: number;
    private readonly gl: WebGL2RenderingContext;
    private readonly format: number;

    /** @throws when S3TC is unsupported or the array allocation fails. */
    constructor(gl: WebGL2RenderingContext, layers: number) {
        this.gl = gl;
        this.layers = layers;
        const ext = gl.getExtension('WEBGL_compressed_texture_s3tc') as
            { COMPRESSED_RGB_S3TC_DXT1_EXT: number } | null;
        if (!ext) throw new Error('[terrain-pages] S3TC not supported');
        this.format = ext.COMPRESSED_RGB_S3TC_DXT1_EXT;

        const pre = drainGlErrors(gl);
        if (pre.length > 0) {
            console.warn('[terrain-pages] gl error(s) already queued BEFORE '
                + 'the page-array allocation (not caused by it): '
                + pre.map((e) => `0x${e.toString(16)}`).join(', '));
        }
        const tex = gl.createTexture();
        if (!tex) throw new Error('[terrain-pages] createTexture failed');
        this.texture = tex;
        gl.bindTexture(gl.TEXTURE_2D_ARRAY, tex);
        // Immutable storage, exactly 1 level: pages carry no internal mips.
        gl.texStorage3D(gl.TEXTURE_2D_ARRAY, 1, this.format,
            PAGE_PHYSICAL_TEXELS, PAGE_PHYSICAL_TEXELS, layers);
        const allocErr = gl.getError();
        if (allocErr !== gl.NO_ERROR) {
            gl.bindTexture(gl.TEXTURE_2D_ARRAY, null);
            gl.deleteTexture(tex);
            throw new Error(`[terrain-pages] texStorage3D `
                + `${PAGE_PHYSICAL_TEXELS}²×${layers} DXT1 failed: `
                + `0x${allocErr.toString(16)}`);
        }
        gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
        const paramErr = gl.getError();
        if (paramErr !== gl.NO_ERROR) {
            console.warn('[terrain-pages] gl error after array sampler state: '
                + `0x${paramErr.toString(16)}`);
        }
        gl.bindTexture(gl.TEXTURE_2D_ARRAY, null);
        console.log(`[terrain-pages] allocated ${PAGE_PHYSICAL_TEXELS}²×`
            + `${layers} DXT1 page array (`
            + `${((layers * PAGE_BYTES) / (1024 * 1024)).toFixed(1)} MB)`);
    }

    uploadLayer(layer: number, bytes: Uint8Array): void {
        const gl = this.gl;
        if (layer < 0 || layer >= this.layers || bytes.length !== PAGE_BYTES) {
            console.warn(`[terrain-pages] bad upload: layer ${layer}/`
                + `${this.layers}, ${bytes.length} bytes (want ${PAGE_BYTES})`);
            return;
        }
        const pre = drainGlErrors(gl);
        if (pre.length > 0) {
            console.warn('[terrain-pages] gl error(s) already queued BEFORE '
                + `layer ${layer} upload (not caused by it): `
                + pre.map((e) => `0x${e.toString(16)}`).join(', '));
        }
        gl.bindTexture(gl.TEXTURE_2D_ARRAY, this.texture);
        gl.compressedTexSubImage3D(gl.TEXTURE_2D_ARRAY, 0,
            0, 0, layer, PAGE_PHYSICAL_TEXELS, PAGE_PHYSICAL_TEXELS, 1,
            this.format, bytes);
        const err = gl.getError();
        if (err !== gl.NO_ERROR) {
            console.warn(`[terrain-pages] gl error 0x${err.toString(16)} `
                + `uploading page layer ${layer} (${bytes.length} bytes)`);
        }
        gl.bindTexture(gl.TEXTURE_2D_ARRAY, null);
    }

    dispose(): void {
        this.gl.deleteTexture(this.texture);
    }
}

/**
 * Adopt the raw `TEXTURE_2D_ARRAY` into Babylon via `Engine.wrapWebGLTexture`
 * — the supported seam — then mark the InternalTexture `is2DArray` so every
 * later Babylon bind targets `TEXTURE_2D_ARRAY`.
 *
 * The one wrinkle: `wrapWebGLTexture` applies its sampling mode against
 * `TEXTURE_2D` (it cannot know the texture is an array before it returns),
 * and our texture name is already typed as an array, so that internal bind
 * fails with INVALID_OPERATION and its `texParameteri` calls would land on
 * whatever 2D texture the active unit happens to hold. Binding null to
 * `TEXTURE_2D` through Babylon's own cache-aware path first makes those
 * calls hit an empty binding (harmless errors we drain and attribute) rather
 * than silently rewriting a stranger's sampler state. The array's real
 * sampler state was already set at allocation time and is untouched by the
 * failed binds.
 */
export function wrapPageArrayTexture(
    scene: Scene, uploader: TerrainPageGlUploader,
): Texture {
    const engine = scene.getEngine() as Engine;
    const gl = getEngineGl(engine);
    (engine as unknown as {
        _bindTextureDirectly(target: number, tex: null): void;
    })._bindTextureDirectly(gl.TEXTURE_2D, null);
    const internalTex = engine.wrapWebGLTexture(
        uploader.texture, false, Texture.BILINEAR_SAMPLINGMODE,
        PAGE_PHYSICAL_TEXELS, PAGE_PHYSICAL_TEXELS);
    const expected = drainGlErrors(gl);
    if (expected.length > 3) {
        console.warn('[terrain-pages] unexpected gl error count wrapping the '
            + 'page array: '
            + expected.map((e) => `0x${e.toString(16)}`).join(', '));
    }
    internalTex.is2DArray = true;
    const tex = new Texture(null, scene);
    tex._texture = internalTex;
    return tex;
}

/**
 * The page-table (indirection) texture: RGBA8, `pageTableWidth ×
 * pageTableHeight`, NEAREST/NEAREST — the shader `texelFetch`es it, filtering
 * across entries would blend unrelated layer indices into nonsense.
 */
export class TerrainPageTableTexture {
    readonly texture: RawTexture;
    private uploadedRevision = -1;

    constructor(scene: Scene, private readonly cache: TerrainPageCache) {
        this.texture = new RawTexture(
            cache.pageTable, cache.pageTableWidth, cache.pageTableHeight,
            Engine.TEXTUREFORMAT_RGBA, scene,
            false /* no mips */, false /* invertY */,
            Texture.NEAREST_SAMPLINGMODE);
        this.texture.wrapU = Texture.CLAMP_ADDRESSMODE;
        this.texture.wrapV = Texture.CLAMP_ADDRESSMODE;
    }

    /** Re-upload only when `cache.revision` moved — a still camera with a
     *  settled cache uploads nothing. */
    sync(): void {
        if (this.cache.revision === this.uploadedRevision) return;
        this.uploadedRevision = this.cache.revision;
        this.texture.update(this.cache.pageTable);
    }

    dispose(): void {
        this.texture.dispose();
    }
}
