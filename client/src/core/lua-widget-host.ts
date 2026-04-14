/**
 * LuaWidgetHost — loads and runs a set of Spring-style Lua widgets against
 * a Babylon scene. This is the top-level entry point that wires together
 * the Lua runtime, the Spring compat shim, the gl.* bridge, and the
 * engine render loop.
 *
 * Usage:
 *   const host = new LuaWidgetHost(scene, mapData);
 *   await host.loadWidgets(mapData.widgets);
 *   // Host registers itself on scene.onBeforeRenderObservable and will
 *   // dispatch widget callins every frame until dispose().
 */
import type { Scene } from '@babylonjs/core/scene';
import type { FreeCamera } from '@babylonjs/core/Cameras/freeCamera';
import { Matrix } from '@babylonjs/core/Maths/math.vector';
import type { ParsedMapData } from './map-data.js';
import { LuaWidget } from './lua-widget.js';
import { LuaGLBridge } from './lua-gl-bridge.js';
import {
    buildSpringGlobals,
    type SpringAPIContext,
} from './lua-spring-api.js';
import type { LuaValue } from './lua-runtime.js';

/** Options passed to the widget host constructor. */
export interface LuaWidgetHostOptions {
    /**
     * Game ID whose LuaUI base will be pre-fetched and executed in every
     * widget's Lua state before the widget's own source runs. If unset,
     * widgets run with only the JS-side Spring shim available.
     *
     * The host fetches files from `/api/games/data/{gameId}/LuaUI/...`.
     */
    gameId?: string;

    /**
     * Paths (relative to `LuaUI/`) of game base files to load in order.
     * Each file is executed once per widget so globals it defines (WG,
     * widgetHandler, LUAUI_DIRNAME, etc.) are visible when the widget's
     * source runs. Defaults to just `widgets.lua`.
     */
    gameBaseFiles?: string[];
}

export class LuaWidgetHost {
    private scene: Scene;
    private camera: FreeCamera;
    private map: ParsedMapData;
    private widgets: LuaWidget[] = [];
    private bridge: LuaGLBridge;
    private ctx: SpringAPIContext;
    private vfsFiles = new Map<string, string>();
    private startTime = performance.now() / 1000;
    private currentFrame = 0;
    private renderObserver: { remove: () => void } | null = null;
    /** Fetched text of each game base file, in load order. */
    private gameBaseSources: { path: string; source: string }[] = [];
    /**
     * Shared Widget Globals table. A single JS object reference is pushed
     * into every widget's Lua state so mutations from one widget are
     * visible to the next. Spring's widget manager uses this as the
     * cross-widget state bus.
     */
    private WG: Record<string, LuaValue> = {};
    private options: LuaWidgetHostOptions;

    constructor(scene: Scene, camera: FreeCamera, map: ParsedMapData, options: LuaWidgetHostOptions = {}) {
        this.scene = scene;
        this.camera = camera;
        this.map = map;
        this.options = options;

        // Reach through Babylon for the raw WebGL2 context. Babylon doesn't
        // expose it on the public type, but the engine has _gl internally.
        const engine = scene.getEngine();
        const gl = (engine as unknown as { _gl: WebGL2RenderingContext })._gl;
        this.bridge = new LuaGLBridge(gl, map.mapSourceUrl);

        // Upload the heightmap as a normalised R8 texture usable as the
        // `$heightmap` engine sampler. Widgets that sample `$heightmap`
        // directly (rather than building their own coast-detection FBO)
        // will see the real terrain.
        const heightTex = buildHeightmapTexture(gl, map);
        if (heightTex) this.bridge.setEngineHeightmap(heightTex);

        this.ctx = {
            mapSizeX: map.widthElmos,
            mapSizeZ: map.heightElmos,
            heightmap: map.heightmap,
            heightmapWidth: map.mapx + 1,
            heightmapHeight: map.mapy + 1,
            minHeight: map.minHeight,
            maxHeight: map.maxHeight,
            squareSize: map.squareSize,
            vfsFiles: this.vfsFiles,
            gameRulesParams: new Map([
                // Stub key the lava widget queries.
                ['_map_ref_lava_level', 0],
            ]),
            getGameSeconds: () => (performance.now() / 1000) - this.startTime,
        };
    }

    /**
     * Pre-fetch the map's VFS helpers and the game's LuaUI base, then
     * load each widget script. The game base is executed in every
     * widget's Lua state before the widget's own source so globals
     * like WG and widgetHandler are in scope when the widget runs.
     */
    async loadWidgets(widgetPaths: string[]): Promise<void> {
        if (widgetPaths.length === 0) return;

        // Map-level VFS fetches. `mapinfo.lua` is the one file most map
        // widgets pull in via VFS.Include to read world bounds, water
        // colours, etc. Other includes fall through silently.
        await this.prefetchVFS('mapinfo.lua');

        // Game-level base fetches. These populate gameBaseSources with
        // executable Lua chunks that get re-run in each widget's state
        // (widgets are isolated per-state, so their globals don't leak
        // across widgets but they all share the same JS `WG` table via
        // our pushValue identity preservation).
        await this.prefetchGameBase();

        // Fetch each widget source and create a LuaWidget for it.
        for (const path of widgetPaths) {
            const url = `${this.map.mapSourceUrl}/${path}`;
            try {
                const res = await fetch(url);
                if (!res.ok) {
                    console.warn(`[widget-host] fetch ${path}: ${res.status}`);
                    continue;
                }
                const source = await res.text();
                const widget = new LuaWidget(path, source);
                const globals = this.buildGlobals();
                const err = widget.load(globals, this.gameBaseSources);
                if (err) {
                    console.warn(`[widget-host] load ${path}: ${err}`);
                    continue;
                }
                widget.initialize();
                this.widgets.push(widget);
                console.log(`[widget-host] loaded ${path}: ${widget.info?.name ?? '(no name)'}`);
            } catch (e) {
                console.warn(`[widget-host] ${path}: ${e}`);
            }
        }

        if (this.widgets.length > 0) this.hookRenderLoop();
    }

    private async prefetchVFS(path: string): Promise<void> {
        const url = `${this.map.mapSourceUrl}/${path}`;
        try {
            const res = await fetch(url);
            if (!res.ok) return; // missing files are OK — widgets fall back
            const text = await res.text();
            this.vfsFiles.set(path, text);
        } catch {
            // Silent — missing VFS files are acceptable.
        }
    }

    /**
     * Fetch the game's LuaUI base files into `gameBaseSources`. Each
     * file is downloaded once and its source text stored for repeated
     * execution per widget. The URL base is derived from the map's
     * own `mapSourceUrl` (which already contains the lobby HTTP prefix)
     * and the game data endpoint `/api/games/data/{gameId}/`.
     */
    private async prefetchGameBase(): Promise<void> {
        const gameId = this.options.gameId;
        if (!gameId) return;
        const files = this.options.gameBaseFiles ?? ['widgets.lua'];

        // Strip `/api/maps/data/{mapId}` off the map source URL to get
        // the lobby HTTP origin. `mapSourceUrl` is of the form
        // `http://host:port/api/maps/data/{id}` — we want everything
        // before `/api/`.
        const origin = this.map.mapSourceUrl.replace(/\/api\/.*$/, '');
        const base = `${origin}/api/games/data/${gameId}/LuaUI`;

        for (const rel of files) {
            const url = `${base}/${rel}`;
            try {
                const res = await fetch(url);
                if (!res.ok) {
                    console.warn(`[widget-host] game base ${rel}: ${res.status}`);
                    continue;
                }
                const source = await res.text();
                this.gameBaseSources.push({ path: rel, source });
                console.log(`[widget-host] loaded game base ${rel} (${source.length} bytes)`);
            } catch (e) {
                console.warn(`[widget-host] game base ${rel}: ${e}`);
            }
        }
    }

    /**
     * Build the flat globals object installed into each widget's Lua
     * state. The shared WG table is injected by reference — the Lua
     * runtime's pushValue walks plain objects into Lua tables each call,
     * which means mutations from inside a widget don't propagate back
     * to JS. For cross-widget state sharing to actually work we'd need
     * a proper userdata wrapper; this is good enough for widgets that
     * only *read* WG to check for sibling-widget presence.
     */
    private buildGlobals(): Record<string, LuaValue> {
        const base = buildSpringGlobals(this.ctx);
        const gl = this.bridge.buildGlGlobal();
        return {
            ...base,
            gl,
            WG: this.WG,
        };
    }

    /**
     * Register the render-loop observer that dispatches callins.
     *
     * We use `onAfterRenderObservable` (not `onBefore`) because Babylon's
     * scene.render() clears the back buffer at the start — if we drew
     * in onBefore, everything the widget emits would be immediately
     * wiped by the clear. onAfter fires after Babylon has rendered
     * terrain + units, so the depth buffer is still populated and
     * widget draws depth-test correctly against real geometry.
     *
     * DrawScreen fires from a separate onBefore hook so widgets that
     * build helper textures (e.g. lava_layer's coast FBO) have them
     * ready when DrawWorldPreUnit runs at the end of the frame.
     */
    private hookRenderLoop(): void {
        const beforeObs = this.scene.onBeforeRenderObservable.add(() => {
            this.preDraw();
        });
        const afterObs = this.scene.onAfterRenderObservable.add(() => {
            this.postDraw();
        });
        this.renderObserver = {
            remove: () => {
                this.scene.onBeforeRenderObservable.remove(beforeObs);
                this.scene.onAfterRenderObservable.remove(afterObs);
            },
        };
    }

    /**
     * Pre-render tick: feed camera matrices, run GameFrame, and run
     * DrawScreen so widget FBO builds happen before the scene render
     * samples them.
     */
    private preDraw(): void {
        this.currentFrame++;

        const view = this.camera.getViewMatrix();
        const proj = this.scene.getProjectionMatrix();
        this.bridge.setCameraMatrices(
            toFloat32Array(view),
            toFloat32Array(proj),
        );

        // GameFrame: call every 2 render frames to approximate 30Hz when
        // running at 60fps. Close enough for widget GC/update.
        if (this.currentFrame % 2 === 0) {
            for (const w of this.widgets) w.gameFrame(this.currentFrame);
        }

        // DrawScreen — used by widgets to populate helper textures
        // (e.g. lava_layer's smoothHMTexID coast-detection FBO).
        for (const w of this.widgets) w.drawScreen();
    }

    /**
     * Post-render tick: run DrawWorldPreUnit. At this point Babylon has
     * finished drawing all scene meshes, the canvas framebuffer is
     * bound, and the depth buffer contains real terrain/unit depths.
     */
    private postDraw(): void {
        const engine = this.scene.getEngine();
        const gl = (engine as unknown as { _gl: WebGL2RenderingContext })._gl;

        // Snapshot the GL state Babylon leaves behind so we can restore
        // it at the end — Babylon's state cache will get out of sync
        // with the real driver otherwise.
        const savedProgram = gl.getParameter(gl.CURRENT_PROGRAM) as WebGLProgram | null;
        const savedVao = gl.getParameter(gl.VERTEX_ARRAY_BINDING) as WebGLVertexArrayObject | null;
        const savedBlend = gl.getParameter(gl.BLEND) as boolean;
        const savedDepthTest = gl.getParameter(gl.DEPTH_TEST) as boolean;
        const savedDepthMask = gl.getParameter(gl.DEPTH_WRITEMASK) as boolean;
        const savedFBO = gl.getParameter(gl.DRAW_FRAMEBUFFER_BINDING) as WebGLFramebuffer | null;

        // Make sure the canvas (default framebuffer) is bound — Babylon
        // may have left a render-target FBO bound if the scene uses
        // post-processing.
        gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, null);

        for (const w of this.widgets) w.drawWorldPreUnit();

        // Restore state so Babylon's next frame starts clean.
        gl.useProgram(savedProgram);
        gl.bindVertexArray(savedVao);
        gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, savedFBO);
        if (savedBlend) gl.enable(gl.BLEND); else gl.disable(gl.BLEND);
        if (savedDepthTest) gl.enable(gl.DEPTH_TEST); else gl.disable(gl.DEPTH_TEST);
        gl.depthMask(savedDepthMask);
        (engine as unknown as { wipeCaches: (bruteForce?: boolean) => void }).wipeCaches(true);
    }

    dispose(): void {
        this.renderObserver?.remove();
        this.renderObserver = null;
        for (const w of this.widgets) w.dispose();
        this.widgets = [];
    }
}

/**
 * Babylon's Matrix stores a single Float32Array of 16 elements internally.
 * For WebGL uniformMatrix4fv we need that array directly — extract it via
 * the `asArray()` method (copies) or `m.m` (reference).
 */
function toFloat32Array(m: Matrix): Float32Array {
    const arr = new Float32Array(16);
    const src = m.m;
    for (let i = 0; i < 16; i++) arr[i] = src[i];
    return arr;
}

/**
 * Build an R8 texture from the uint16 heightmap. Spring's `$heightmap`
 * engine sampler returns normalised height values — we pack them into
 * the red channel of an 8-bit texture (same precision as the lava
 * widget's coast-detection texture, which is also RGBA8).
 */
function buildHeightmapTexture(gl: WebGL2RenderingContext, map: ParsedMapData): WebGLTexture | null {
    const w = map.mapx + 1;
    const h = map.mapy + 1;
    if (!map.heightmap || map.heightmap.length < w * h) return null;
    const buf = new Uint8Array(w * h);
    for (let i = 0; i < w * h; i++) {
        // heightmap stores uint16 raw values in [0, 65535] mapping
        // linearly to [minHeight, maxHeight].
        buf[i] = map.heightmap[i] >> 8;
    }
    const tex = gl.createTexture();
    if (!tex) return null;
    const saved = gl.getParameter(gl.TEXTURE_BINDING_2D) as WebGLTexture | null;
    gl.bindTexture(gl.TEXTURE_2D, tex);
    // R8 single-channel — Spring's shader samples .x, which matches.
    // UNPACK_ALIGNMENT defaults to 4, which pads each row up to a 4-byte
    // boundary. For R8 (1 byte per pixel) and a typical Spring width of
    // mapx+1 (e.g. 7169 = 4n+1), WebGL then reads past the end of our
    // tightly-packed buffer. Force byte alignment before the upload.
    const savedAlign = gl.getParameter(gl.UNPACK_ALIGNMENT) as number;
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.R8, w, h, 0, gl.RED, gl.UNSIGNED_BYTE, buf);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, savedAlign);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.bindTexture(gl.TEXTURE_2D, saved);
    return tex;
}
