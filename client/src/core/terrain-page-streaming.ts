/**
 * TerrainPageStreaming — the vertical-slice conductor for streaming v2
 * (PLAN-maps.md §1.2.1): wires the tested non-GPU core (`terrain-page-grid` /
 * `-visibility` / `-cache`) to the GL layer (`terrain-page-gl`) and the
 * shader (`terrain-page-plugin`), driven once per frame from
 * `scene.onBeforeRenderObservable`.
 *
 * Per frame:
 * 1. Build the `ViewFrustum` from the active camera — the same `m[0]`/`m[5]`
 *    + direction reading `ShadowDepthBounds.update` takes.
 * 2. `computeVisiblePages` — the CPU visible set (quadtree descent over
 *    `viewDepthRangeOfBox` × `HeightRangeGrid.rangeOverRect`; no GPU
 *    feedback pass, and that is settled — see `terrain-page-visibility.ts`).
 * 3. `cache.update` — touch/schedule/abort/rebuild-table.
 * 4. `TerrainPageTableTexture.sync` — re-upload the 8 KB table only when
 *    `cache.revision` moved, so a still camera uploads nothing.
 *
 * Sources: the real producer's HTTP `PageSource` (`terrain-page-http.ts`,
 * for maps that ship `ground_pages.bin` — format v19) or the **synthetic**
 * one (one hue per pyramid level, `terrain-page-synthetic.ts`) as the
 * explicit fallback / diagnostic. Which one is the `__terrainPages` debug
 * handle's choice in game-processor; nothing enables either in normal play.
 */

import { Vector3 } from '@babylonjs/core';
import type { Scene, Camera, Observer, BaseTexture } from '@babylonjs/core';
import { getEngineGl } from './engine-gl.js';
import {
    planPageGrid, residentLayerBudget, DEFAULT_CACHE_BYTES,
    PAGE_PAYLOAD_TEXELS, type PageGrid,
} from './terrain-page-grid.js';
import { computeVisiblePages } from './terrain-page-visibility.js';
import {
    TerrainPageCache, type PageSource, type PageCacheStats,
} from './terrain-page-cache.js';
import { SyntheticPageSource } from './terrain-page-synthetic.js';
import {
    TerrainPageGlUploader, TerrainPageTableTexture, wrapPageArrayTexture,
} from './terrain-page-gl.js';
import type { PageSampleGeometry } from './terrain-page-plugin.js';
import { HeightRangeGrid, type ViewFrustum } from './shadow-depth-bounds.js';
import type { TerrainMeshGroup } from './terrain.js';
import { attachTerrainPageSampleToTerrain, setTerrainPagePluginEnabled } from './terrain.js';

/** The map fields the streamer needs (a subset of ParsedMapData). */
export interface TerrainPageStreamingMap {
    widthElmos: number;
    heightElmos: number;
    heightmap: Uint16Array;
    mapx: number;
    mapy: number;
    minHeight: number;
    maxHeight: number;
    squareSize: number;
}

export interface TerrainPageStreamingOptions {
    source?: PageSource;
    /** Synthetic-source artificial latency window (ms), so page arrival is
     *  staggered and the cross-fade is observable. Ignored when `source` is
     *  given. */
    syntheticDelayMs?: [number, number];
    byteBudget?: number;
    maxPages?: number;
    levelBias?: number;
    predictPadFrac?: number;
    /** Floor on the visible-set descent — the real producer's
     *  `ground_pages.json.finestLevel` (levels finer than the source do not
     *  exist on disk). 0 (default) descends the full pyramid. */
    minLevel?: number;
}

const LOCAL_RIGHT = new Vector3(1, 0, 0);
const LOCAL_UP = new Vector3(0, 1, 0);
const LOCAL_FORWARD_RH = new Vector3(0, 0, -1);
const LOCAL_FORWARD_LH = new Vector3(0, 0, 1);

export class TerrainPageStreaming {
    readonly grid: PageGrid;
    readonly cache: TerrainPageCache;
    private readonly heights: HeightRangeGrid;
    private readonly uploader: TerrainPageGlUploader;
    private readonly table: TerrainPageTableTexture;
    private readonly atlasTexture: BaseTexture;
    private readonly observer: Observer<Scene>;
    private readonly maxPages: number;
    private readonly levelBias: number;
    private readonly minLevel: number;
    private readonly predictPadFrac: number;
    private readonly right = new Vector3();
    private readonly up = new Vector3();
    private readonly forward = new Vector3();

    /** @throws when WebGL2/S3TC is unavailable or the array allocation
     *  fails — the caller (a debug hook) reports rather than degrades. */
    constructor(
        private readonly scene: Scene,
        terrain: TerrainMeshGroup,
        map: TerrainPageStreamingMap,
        opts: TerrainPageStreamingOptions = {},
    ) {
        this.grid = planPageGrid(map.widthElmos, map.heightElmos);
        this.heights = new HeightRangeGrid(
            map.heightmap, map.mapx + 1, map.mapy + 1,
            map.minHeight, map.maxHeight, map.squareSize);
        this.maxPages = opts.maxPages ?? 256;
        this.levelBias = opts.levelBias ?? 0;
        this.predictPadFrac = opts.predictPadFrac ?? 0.25;
        this.minLevel = opts.minLevel ?? 0;

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const gl = getEngineGl(scene.getEngine() as any);
        const maxArrayLayers = gl.getParameter(gl.MAX_ARRAY_TEXTURE_LAYERS) as number;
        const layers = residentLayerBudget(
            opts.byteBudget ?? DEFAULT_CACHE_BYTES, maxArrayLayers);
        this.uploader = new TerrainPageGlUploader(gl, layers);

        const delay = opts.syntheticDelayMs ?? [40, 300];
        const source = opts.source ?? new SyntheticPageSource(delay[0], delay[1]);
        this.cache = new TerrainPageCache(this.grid, {
            maxLayers: layers, source, uploader: this.uploader,
        });
        this.table = new TerrainPageTableTexture(scene, this.cache);
        this.atlasTexture = wrapPageArrayTexture(scene, this.uploader);

        const L0 = this.grid.levels[0];
        const geometry: PageSampleGeometry = {
            baseScaleU: this.grid.mapElmosX / L0.pageElmos,
            baseScaleV: this.grid.mapElmosZ / L0.pageElmos,
            pagesX0: L0.pagesX,
            pagesZ0: L0.pagesZ,
            worldW: this.grid.mapElmosX,
            worldH: this.grid.mapElmosZ,
        };
        attachTerrainPageSampleToTerrain(
            terrain, this.atlasTexture, this.table.texture, geometry);

        this.observer = scene.onBeforeRenderObservable.add(() => this.tick());
        console.log(`[terrain-pages] streaming up: `
            + `${this.grid.levels[0].pagesX}x${this.grid.levels[0].pagesZ} L0 grid, `
            + `${this.grid.levels.length} levels, ${this.grid.totalPages} pages, `
            + `${layers} resident layers `
            + `(driver MAX_ARRAY_TEXTURE_LAYERS=${maxArrayLayers}), `
            + `page payload ${PAGE_PAYLOAD_TEXELS}²`);
    }

    private tick(): void {
        const camera = this.scene.activeCamera;
        if (!camera) return;
        const view = this.buildFrustum(camera);
        if (!view) return;
        const engine = this.scene.getEngine();
        const desired = computeVisiblePages(this.grid, this.heights, view, {
            viewportHeightPx: engine.getRenderHeight(),
            maxPages: this.maxPages,
            levelBias: this.levelBias,
            predictPadFrac: this.predictPadFrac,
            minLevel: this.minLevel,
        });
        this.cache.update(desired, performance.now());
        this.table.sync();
    }

    private buildFrustum(camera: Camera): ViewFrustum | null {
        const pm = camera.getProjectionMatrix().m;
        const xScale = pm[0], yScale = pm[5];
        const near = camera.minZ, far = camera.maxZ;
        if (!(xScale > 0) || !(yScale > 0) || !(far > near)) return null;
        camera.getDirectionToRef(LOCAL_RIGHT, this.right);
        camera.getDirectionToRef(LOCAL_UP, this.up);
        camera.getDirectionToRef(
            camera.getScene().useRightHandedSystem
                ? LOCAL_FORWARD_RH : LOCAL_FORWARD_LH,
            this.forward);
        return {
            pos: camera.globalPosition,
            right: this.right, up: this.up, forward: this.forward,
            xScale, yScale, near, far,
        };
    }

    getStats(): Readonly<PageCacheStats> & { revision: number } {
        return { ...this.cache.getStats(), revision: this.cache.revision };
    }

    /** Toggle the shader plugin (the streaming A/B arm) without tearing the
     *  cache down — the CPU side keeps running either way. */
    setPluginEnabled(terrain: TerrainMeshGroup | null, on: boolean): boolean {
        return setTerrainPagePluginEnabled(terrain, on);
    }

    dispose(terrain: TerrainMeshGroup | null): void {
        this.scene.onBeforeRenderObservable.remove(this.observer);
        this.cache.dispose();
        if (terrain) setTerrainPagePluginEnabled(terrain, false);
        this.table.dispose();
        this.atlasTexture.dispose();
        this.uploader.dispose();
    }
}
