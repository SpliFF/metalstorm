/**
 * LuaGLBridge — implements the Spring `gl.*` Lua API against WebGL2.
 *
 * Covers the full surface area needed for Spring widgets including:
 *   - Shader management (CreateShader, UseShader, Uniform*, GLSL translation)
 *   - Texture management (CreateTexture, Texture, TextureInfo)
 *   - FBO/RBO (CreateFBO, ActiveFBO, IsValidFBO, CreateRBO)
 *   - VAO (GetVAO with instanced DrawArrays)
 *   - Immediate-mode drawing (BeginEnd, Vertex, Color, TexCoord, Rect, TexRect)
 *     via ImmediateModeRenderer vertex batcher
 *   - Matrix stack (MatrixMode, Push/Pop, Translate, Scale, Rotate, Ortho)
 *   - Fixed-function state (Blending, BlendFunc, BlendFuncSeparate, Scissor,
 *     StencilTest/Func/Op, ColorMask, DepthTest, DepthMask, AlphaTest)
 *   - Display lists (CreateList, CallList, DeleteList)
 *   - Queries (GetViewSizes, TextureInfo)
 *
 * State hygiene: between widget calls Babylon does not know about shader
 * programs or buffers we bound. The widget host snapshots/restores GL state
 * so Babylon's state cache stays in sync.
 */
import { markOpaque, type LuaValue } from './lua-runtime.js';
import { ImmediateModeRenderer } from './lua-gl-immediate.js';
import { createLuaFontObject } from './lua-gl-font.js';

/** Handle returned by gl.CreateShader — opaque to Lua. */
export interface LuaShaderHandle {
    __type: 'shader';
    program: WebGLProgram;
    uniforms: Map<string, WebGLUniformLocation>;
}

/** Handle returned by gl.CreateTexture. */
export interface LuaTextureHandle {
    __type: 'texture';
    tex: WebGLTexture;
    width: number;
    height: number;
}

/** Handle returned by gl.CreateFBO. */
export interface LuaFBOHandle {
    __type: 'fbo';
    fbo: WebGLFramebuffer;
    colorAttachments: LuaTextureHandle[];
}

/**
 * Handle returned by gl.GetVAO. Must be a plain Lua table (not opaque
 * userdata) so the widget can call `VAO:DrawArrays(...)` / `VAO:Delete()`
 * — Lua's method-call sugar (`:`) requires the value to be indexable
 * with a metatable, which lightuserdata lacks.
 *
 * The DrawArrays/Delete functions receive the VAO table as their first
 * argument via the `:` sugar and must ignore it.
 */
export interface LuaVAOHandle {
    __type: 'vao';
    DrawArrays(
        _self: LuaValue,
        mode: LuaValue,
        count: LuaValue,
        first: LuaValue,
        instanceCount: LuaValue,
    ): void;
    Delete(_self: LuaValue): void;
    /** GL4 stubs — no-op for now. ZK's instancevbotable.lua attaches
     *  vertex/instance/index buffers on every VAO it creates. */
    DrawElements(..._args: LuaValue[]): LuaValue;
    AttachVertexBuffer(..._args: LuaValue[]): LuaValue;
    AttachInstanceBuffer(..._args: LuaValue[]): LuaValue;
    AttachIndexBuffer(..._args: LuaValue[]): LuaValue;
    ClearAttachedBuffers(..._args: LuaValue[]): LuaValue;
}

/**
 * Commands the bridge hands off when a widget calls one of the engine
 * `gl.*MiniMap*` entry points. The bridge can't render the minimap
 * itself — it lives on the main thread — so the worker translates these
 * into postMessage envelopes for the host.
 */
export type MinimapBridgeCommand =
    | { kind: 'geometry'; x: number; y: number; w: number; h: number }
    | { kind: 'events' }
    | { kind: 'draw' };

/** Textures bound by name — Spring's engine texture slots like "$heightmap". */
export interface EngineTextures {
    /** Heightmap sampler in [0,1] normalised form. */
    heightmap?: WebGLTexture;
    /** Shadow map (optional — stubbed to 1x1 white). */
    shadow?: WebGLTexture;
    /** Info tex (optional — stubbed to 1x1 black). */
    info?: WebGLTexture;
}

/**
 * Cache of image-loaded textures keyed by normalised path. Populated
 * lazily as Lua code references them.
 */
type TextureCache = Map<string, LuaTextureHandle>;


export class LuaGLBridge {
    private gl: WebGL2RenderingContext;
    /** Map source URL base — used to resolve `:a:LuaUI\\Images\\foo.png` → HTTP fetch. */
    private mapSourceUrl: string;
    private engineTex: EngineTextures;
    /** Currently bound shader — tracked so gl.Uniform* calls target the right program. */
    private currentShader: LuaShaderHandle | null = null;
    private textureCache: TextureCache = new Map();
    /** 1x1 fallback textures. */
    private whiteTex: WebGLTexture | null = null;
    private blackTex: WebGLTexture | null = null;
    /** Immediate-mode renderer for gl.BeginEnd / gl.Rect / gl.TexRect etc. */
    private imm: ImmediateModeRenderer;
    /** Tracks the currently bound texture on unit 0 for immediate-mode textured flag. */
    private boundTextureUnit0: WebGLTexture | null = null;
    /** Tracks whether a texture is bound on unit 0 (for immediate-mode draw). */
    private hasTextureUnit0 = false;
    /** RBO handles for gl.CreateRBO / gl.DeleteRBO. */
    private rboHandles = new Map<number, WebGLRenderbuffer>();
    private nextRboId = 1;

    /** Base URL for game assets (e.g. http://localhost:8011/api/games/data/zk) */
    private gameBaseUrl = '';
    /** Search paths for short texture names (no directory component).
     *  Tried in order against gameBaseUrl. E.g. ["LuaUI/Widgets/chili_old/Skins/Evolved/"] */
    private textureSearchPaths: string[] = [];
    /** Asset URL overrides keyed by normalised path. Lets the host resolve
     *  texture paths like "LuaUI/Images/quit.png" to a bundled asset URL
     *  instead of an HTTP fetch off the game base URL. Used by `?widgetTest`. */
    private assetOverrides = new Map<string, string>();
    /** Resolves a Spring `'#' .. unitDefID` texture reference to the
     *  unit's `buildPic` filename (without directory). Returns null if the
     *  defId is unknown. The bridge then loads it from
     *  `${gameBaseUrl}/unitpics/<buildPic>`. Set by the host (worker holds
     *  the unit-def map; bridge does not). */
    private buildPicResolver: ((defId: number) => string | null) | null = null;
    /** Sink for `gl.ConfigMiniMap` / `gl.DrawMiniMap` / `gl.DrawMiniMapEvents`
     *  calls. The bridge has no minimap of its own — the native Minimap
     *  lives on the main thread — so the worker installs an emitter that
     *  posts `minimapGeometry` / `minimapEvents` messages back. Null in
     *  contexts that don't run a minimap (tests, lobby preview, etc.);
     *  the bridge silently no-ops in that case. */
    private minimapEmitter: ((cmd: MinimapBridgeCommand) => void) | null = null;

    /** PLAN-coordinate-system Option A: handedness is a *direction*
     *  property, not a positional one. When the legacy-LH bridge is on,
     *  direction-vector Z components mirror (gl.Rotate axis, LoadMatrix
     *  rotation block); world positions pass through unchanged. The
     *  immediate-mode stack is RH-native; legacy widgets reach it via
     *  per-callout adapters. Default false (RH-native). Set on first
     *  GameInfo broadcast by `setLegacyCoordSystem`. */
    private legacyCoordSystem = false;

    /** Toggle the legacy-LH coord bridge. Called from the worker once
     *  the server's `GameInfo.legacy_coord_system` flag arrives. The
     *  bridge looks at it on every `gl.*` call that consumes a direction
     *  Z, so flipping mid-game is safe in principle — the assumption is
     *  that the server treats the flag as immutable per game session,
     *  matching the C++ side's `modInfo.legacyCoordSystem`. */
    setLegacyCoordSystem(value: boolean): void {
        this.legacyCoordSystem = value;
    }

    /** Mirror Z on a direction-vector component (rotation axis, etc.). */
    private flipDirZ(z: number): number {
        return this.legacyCoordSystem ? -z : z;
    }

    constructor(gl: WebGL2RenderingContext, mapSourceUrl: string, engineTex: EngineTextures = {}) {
        this.gl = gl;
        this.mapSourceUrl = mapSourceUrl;
        this.engineTex = engineTex;
        this.whiteTex = this.createSolidTexture(255, 255, 255, 255);
        this.blackTex = this.createSolidTexture(0, 0, 0, 255);
        this.imm = new ImmediateModeRenderer(gl);
    }

    /** Wire the minimap-command sink. Called by the worker host once it
     *  has built its postMessage bridge. Without an emitter `gl.DrawMiniMap`
     *  and friends are silent no-ops, which is the right behaviour in
     *  tests / lobby preview where no native minimap exists. */
    setMinimapEmitter(emitter: ((cmd: MinimapBridgeCommand) => void) | null): void {
        this.minimapEmitter = emitter;
    }

    /** Resize the OffscreenCanvas owned by this bridge's GL context. */
    resizeCanvas(width: number, height: number): void {
        const canvas = this.gl.canvas as OffscreenCanvas;
        canvas.width = width;
        canvas.height = height;
        this.gl.viewport(0, 0, width, height);
    }

    /** Build the `gl` global for the Lua runtime. */
    /** Set the base URL for game assets (textures loaded by path). */
    setGameBaseUrl(url: string): void { this.gameBaseUrl = url; }

    /** Add directories to search for short texture names (e.g. skin dirs). */
    addTextureSearchPaths(...paths: string[]): void {
        for (const p of paths) {
            if (!this.textureSearchPaths.includes(p)) {
                this.textureSearchPaths.push(p);
            }
        }
    }

    /** Register a resolver for Spring's `'#' .. unitDefID` build-pic syntax.
     *  The fn returns the def's `buildPic` filename (or null on miss). */
    setBuildPicResolver(fn: (defId: number) => string | null): void {
        this.buildPicResolver = fn;
    }

    /** Expose the WebGL context for external use. */
    getGL(): WebGL2RenderingContext { return this.gl; }

    buildGlGlobal(): Record<string, LuaValue> {
        const gl: Record<string, LuaValue> = {};

        // ── Shader management ───────────────────────────────────────
        gl['CreateShader'] = (opts: LuaValue) => this.createShader(opts);
        gl['UseShader'] = (handle: LuaValue) => this.useShader(handle);
        gl['DeleteShader'] = (handle: LuaValue) => this.deleteShader(handle);
        gl['GetShaderLog'] = () => this.lastShaderLog;
        gl['Uniform'] = (name: LuaValue, ...args: LuaValue[]) =>
            this.setUniform(name, args);
        gl['UniformInt'] = (name: LuaValue, ...args: LuaValue[]) =>
            this.setUniformInt(name, args);
        gl['UniformMatrix'] = (name: LuaValue, ...args: LuaValue[]) =>
            this.setUniformMatrix(name, args);
        gl['UniformArray'] = (name: LuaValue, _type: LuaValue, arr: LuaValue) =>
            this.setUniformArray(name, arr);

        // ── Texture management ──────────────────────────────────────
        gl['CreateTexture'] = (a: LuaValue, b: LuaValue, c: LuaValue) =>
            this.createTexture(a, b, c);
        gl['DeleteTexture'] = (h: LuaValue) => this.deleteTexture(h);
        // gl.DeleteTextureFBO — Spring API to delete a texture associated
        // with an FBO. We don't track that association explicitly, so just
        // route to plain DeleteTexture (Chili Minimap calls this with 0
        // when initialising; it must be a no-op in that case).
        gl['DeleteTextureFBO'] = (h: LuaValue) => {
            if (h && typeof h === 'object') this.deleteTexture(h);
        };
        gl['Texture'] = (unit: LuaValue, handleOrPath: LuaValue) => {
            this.bindTexture(unit, handleOrPath);
            return true; // Spring returns true on bind attempt
        };
        gl['TextureInfo'] = (handleOrPath: LuaValue) =>
            this.textureInfo(handleOrPath);

        // ── FBO / RBO ───────────────────────────────────────────────
        gl['CreateFBO'] = (opts: LuaValue) => this.createFBO(opts);
        gl['ActiveFBO'] = (fbo: LuaValue, callback: LuaValue) => this.activeFBO(fbo, callback);
        gl['DeleteFBO'] = (h: LuaValue) => this.deleteFBO(h);
        gl['IsValidFBO'] = (h: LuaValue) => this.isValidFBO(h);
        gl['CreateRBO'] = (w: LuaValue, h: LuaValue, opts: LuaValue) =>
            this.createRBO(w, h, opts);
        gl['DeleteRBO'] = (h: LuaValue) => this.deleteRBO(h);

        // ── VAO ─────────────────────────────────────────────────────
        gl['GetVAO'] = () => this.getVAO();

        // ── Fixed-function state ────────────────────────────────────
        gl['Blending'] = (a: LuaValue, b: LuaValue) => this.blending(a, b);
        gl['BlendFunc'] = (src: LuaValue, dst: LuaValue) => this.blendFunc(src, dst);
        gl['BlendFuncSeparate'] = (srcRGB: LuaValue, dstRGB: LuaValue,
            srcA: LuaValue, dstA: LuaValue) =>
            this.blendFuncSeparate(srcRGB, dstRGB, srcA, dstA);
        gl['DepthTest'] = (on: LuaValue) => this.depthTest(on);
        gl['DepthMask'] = (on: LuaValue) => this.depthMask(on);
        gl['ColorMask'] = (r: LuaValue, g?: LuaValue, b?: LuaValue, a?: LuaValue) =>
            this.colorMask(r, g, b, a);
        gl['Scissor'] = (x: LuaValue, y?: LuaValue, w?: LuaValue, h?: LuaValue) =>
            this.scissor(x, y, w, h);
        gl['StencilTest'] = (on: LuaValue) => this.stencilTest(on);
        gl['StencilFunc'] = (func: LuaValue, ref: LuaValue, mask: LuaValue) =>
            this.stencilFunc(func, ref, mask);
        gl['StencilOp'] = (sfail: LuaValue, dpfail: LuaValue, dppass: LuaValue) =>
            this.stencilOp(sfail, dpfail, dppass);
        gl['StencilMask'] = (mask: LuaValue) => this.stencilMask(mask);
        gl['AlphaTest'] = (on: LuaValue, threshold?: LuaValue) =>
            this.alphaTest(on, threshold);
        gl['LineWidth'] = (w: LuaValue) => this.lineWidth(w);
        gl['PolygonMode'] = (_face: LuaValue, _mode: LuaValue) => {
            // WebGL2 doesn't support polygon mode — always fill
        };
        gl['PushAttrib'] = (_bits: LuaValue) => { /* state snapshotted by host */ };
        gl['PopAttrib'] = () => { /* state restored by host */ };
        gl['Clear'] = (...args: LuaValue[]) => this.clear(args);
        gl['ActiveTexture'] = (unit: LuaValue, fn: LuaValue, ...args: LuaValue[]) => {
            // Spring signature: gl.ActiveTexture(unit, fn, arg1, arg2, ...)
            // Sets active texture unit, calls fn(args), then restores unit 0.
            const u = Number(unit);
            if (Number.isFinite(u) && u >= 0 && u <= 7) {
                this.gl.activeTexture(this.gl.TEXTURE0 + u);
            }
            if (typeof fn === 'function') {
                (fn as (...a: LuaValue[]) => void)(...args);
            }
            this.gl.activeTexture(this.gl.TEXTURE0);
        };

        // ── Matrix stack ────────────────────────────────────────────
        gl['MatrixMode'] = (m: LuaValue) => this.imm.matrixMode(Number(m));
        gl['PushMatrix'] = () => this.imm.pushMatrix();
        gl['PopMatrix'] = () => this.imm.popMatrix();
        // Snapshot/restore for the Chili CallChildren pcall wrapper. A
        // child Draw that errors mid-frame can leave unbalanced PushMatrix
        // or PushScissor calls; saving before and restoring after keeps
        // both the matrix stack AND scissor state consistent across
        // siblings. Returns/accepts an opaque JS object — fengari passes
        // it through Lua as userdata without conversion.
        gl['_saveMatrixState'] = () => {
            const glRaw = this.gl;
            const sciEnabled = glRaw.getParameter(glRaw.SCISSOR_TEST) as boolean;
            const sciBox = glRaw.getParameter(glRaw.SCISSOR_BOX) as Int32Array;
            return {
                stack: this.imm.saveStackDepth(),
                sciEnabled,
                sciBox: new Int32Array(sciBox),
            } as unknown as LuaValue;
        };
        gl['_restoreMatrixState'] = (state: LuaValue) => {
            if (state && typeof state === 'object') {
                const s = state as unknown as {
                    stack: { mv: number; pj: number; mvCur: Float32Array; pjCur: Float32Array };
                    sciEnabled: boolean;
                    sciBox: Int32Array;
                };
                if (s.stack) this.imm.restoreStackDepth(s.stack);
                const glRaw = this.gl;
                if (s.sciEnabled) {
                    glRaw.enable(glRaw.SCISSOR_TEST);
                    if (s.sciBox) {
                        glRaw.scissor(s.sciBox[0], s.sciBox[1], s.sciBox[2], s.sciBox[3]);
                    }
                } else {
                    glRaw.disable(glRaw.SCISSOR_TEST);
                }
            }
        };
        // Toggle per-flush instrumentation. From Lua: `gl._setFlushDebug("nubtron", 8)`
        // — the next 8 flushes will emit a single line into the debug log
        // (drainable via `_drainFlushDebug()`). Pass nil/null to stop early.
        gl['_setFlushDebug'] = (label: LuaValue, budget: LuaValue) => {
            const lbl = label === null || label === undefined ? null : String(label);
            const bud = budget !== null && budget !== undefined ? Number(budget) : 8;
            this.imm.setFlushDebug(lbl, bud);
        };
        // Drain the accumulated flush-debug lines as a single newline-joined
        // string so it round-trips cleanly through fengari (JS arrays are
        // converted to nil/userdata depending on bridge — strings are safe).
        gl['_drainFlushDebug'] = () => {
            const lines = this.imm.drainFlushDebugLog();
            return lines.join('\n') as unknown as LuaValue;
        };
        gl['LoadIdentity'] = () => this.imm.loadIdentity();
        gl['LoadMatrix'] = (...args: LuaValue[]) => this.loadMatrix(args);
        gl['MultMatrix'] = (...args: LuaValue[]) => this.multMatrixGL(args);
        // Translate carries a position; under Option A world positions
        // stay in [0, mapZ] in both LH and RH frames so no Z flip is
        // needed. Rotate's (x, y, z) is an axis vector — direction-style,
        // so its Z mirrors when the legacy bridge is active.
        gl['Translate'] = (x: LuaValue, y: LuaValue, z: LuaValue) =>
            this.imm.translate(Number(x), Number(y), Number(z ?? 0));
        gl['Scale'] = (x: LuaValue, y: LuaValue, z: LuaValue) =>
            this.imm.scale(Number(x), Number(y), Number(z ?? 1));
        gl['Rotate'] = (angle: LuaValue, x: LuaValue, y: LuaValue, z: LuaValue) =>
            this.imm.rotate(Number(angle), Number(x), Number(y), this.flipDirZ(Number(z)));
        gl['Ortho'] = (l: LuaValue, r: LuaValue, b: LuaValue, t: LuaValue,
            n: LuaValue, f: LuaValue) =>
            this.imm.ortho(Number(l), Number(r), Number(b), Number(t),
                Number(n ?? -1), Number(f ?? 1));
        gl['Billboard'] = () => this.imm.billboard();

        // ── Immediate mode ──────────────────────────────────────────
        gl['Color'] = (...args: LuaValue[]) => this.color(args);
        gl['Rect'] = (...args: LuaValue[]) => this.rect(args);
        gl['TexRect'] = (...args: LuaValue[]) => this.texRect(args);
        gl['BeginEnd'] = (mode: LuaValue, fn: LuaValue, ...extra: LuaValue[]) =>
            this.beginEnd(mode, fn, extra);
        gl['Vertex'] = (...args: LuaValue[]) => this.vertexGL(args);
        gl['TexCoord'] = (...args: LuaValue[]) => this.texCoordGL(args);
        gl['MultiTexCoord'] = (unit: LuaValue, s: LuaValue, t: LuaValue) =>
            this.imm.multiTexCoord(Number(unit), Number(s), Number(t));

        // ── Minimap bridge ─────────────────────────────────────────
        // The native Minimap lives on the main thread. These entry points
        // hand off the widget's positioning intent via an emitter that
        // the worker host wires to postMessage. ZK's chili minimap calls
        // ConfigMiniMap on every layout change and DrawMiniMap once per
        // DrawScreen pass; we ignore the latter because the native
        // renderer draws continuously, but the call still signals that
        // the chili widget has claimed the minimap (so the host can
        // switch ownership='widget' on first sight).
        gl['ConfigMiniMap'] = (x: LuaValue, y: LuaValue, w: LuaValue, h: LuaValue) => {
            const gx = Number(x ?? 0);
            const gy = Number(y ?? 0);
            const gw = Number(w ?? 0);
            const gh = Number(h ?? 0);
            this.minimapEmitter?.({ kind: 'geometry', x: gx, y: gy, w: gw, h: gh });
        };
        gl['DrawMiniMap'] = () => {
            this.minimapEmitter?.({ kind: 'draw' });
        };
        gl['DrawMiniMapEvents'] = () => {
            this.minimapEmitter?.({ kind: 'events' });
        };
        // Spring's `gl.SlaveMiniMap` enabled the old dual-screen minimap
        // mode. Our renderer is always single-screen — stub so widgets
        // don't fall through the gl-fallback metatable and lose calls.
        gl['SlaveMiniMap'] = (_enable: LuaValue) => undefined;

        // ── Display lists ───────────────────────────────────────────
        // JS-side CreateList — works for simple cases but loses metatables
        // on table arguments. The Lua wrapper in the worker overrides this
        // to preserve metatables (critical for Chili's gl.CreateList(self.DrawControl, self)).
        gl['CreateList'] = (fn: LuaValue, ...args: LuaValue[]) => this.createList(fn, ...args);
        // Recording API used by Lua-side gl.CreateList wrapper
        gl['_startRecording'] = () => this.imm.startRecording();
        gl['_stopRecording'] = () => this.imm.stopRecording();
        gl['_isRecording'] = () => this.imm.isRecording();
        gl['_inspectList'] = (id: LuaValue) => this.imm.inspectList(Number(id));
        gl['CallList'] = (id: LuaValue) => {
            this.imm.callList(Number(id));
            // Sync bridge texture tracking — display lists may have changed
            // the bound texture (e.g. gl.CreateList(gl.Texture, path))
            const st = this.imm.getTexturedState();
            this.hasTextureUnit0 = st.textured;
            this.boundTextureUnit0 = st.texture;
        };
        gl['DeleteList'] = (id: LuaValue) => this.imm.deleteList(Number(id));

        // ── Font ─────────────────────────────────────────────────────
        gl['LoadFont'] = (path: LuaValue, size?: LuaValue, outlineW?: LuaValue,
            outlineWeight?: LuaValue) => {
            return createLuaFontObject(
                this.gl, this.imm,
                String(path ?? 'FreeSansBold.otf'),
                Number(size ?? 12),
                Number(outlineW ?? 0),
                Number(outlineWeight ?? 0),
            );
        };
        gl['DeleteFont'] = (_handle: LuaValue) => {
            // Atlas cleanup handled by GC
        };

        // ── Queries ─────────────────────────────────────────────────
        gl['GetViewSizes'] = () => {
            const c = this.gl.canvas;
            return [c.width, c.height];
        };

        // gl.GetSun(param, [type]) — sun parameters used by shaders for
        // map/unit lighting. Returns either RGB triple, XYZ direction,
        // or a single scalar depending on param.
        gl['GetSun'] = (param: LuaValue, _type?: LuaValue) => {
            const p = String(param ?? '');
            switch (p) {
                case 'pos':            return [500, 1000, 500];
                case 'dir':            return [0.5, -0.7, 0.5];
                case 'specular':       return [1, 1, 1];
                case 'diffuse':        return [1, 1, 1];
                case 'ambient':        return [0.3, 0.3, 0.3];
                case 'specularExp':    return 16;
                case 'shadowDensity':  return 0.7;
                default:               return [1, 1, 1];
            }
        };

        // gl.GetWaterRendering(param) — water shader parameters. Real
        // values come from the map's mapinfo.lua; for solo/test mode a
        // bland default keeps widgets that read these from erroring.
        gl['GetWaterRendering'] = (param: LuaValue) => {
            const p = String(param ?? '');
            const defaults: Record<string, number | string | number[]> = {
                absorb:                  [0.0, 0.5, 1.0],
                baseColor:               [0.0, 0.4, 0.7],
                minColor:                [0.0, 0.2, 0.4],
                surfaceColor:            [0.4, 0.6, 0.8],
                surfaceAlpha:            0.55,
                diffuseColor:            [1.0, 1.0, 1.0],
                specularColor:           [1.0, 1.0, 1.0],
                specularPower:           20,
                specularFactor:          0.5,
                ambientFactor:           0.5,
                diffuseFactor:           1.0,
                fresnelMin:              0.2,
                fresnelMax:              0.8,
                fresnelPower:            4.0,
                reflectionDistortion:    1.0,
                blurBase:                2.0,
                blurExponent:            1.5,
                perlinStartFreq:         8.0,
                perlinLacunarity:        3.0,
                perlinAmplitude:         0.9,
                windSpeed:               1.0,
                shoreWaves:              1,
                forceRendering:          0,
                hasWaterPlane:           0,
                normalTexture:           '',
                foamTexture:             '',
                reflectionTexture:       '',
            };
            return defaults[p] ?? 0;
        };

        // gl.GetMapRendering(param) — per-map render flags. Mostly used
        // by widgets to decide whether to draw their own water/ground.
        gl['GetMapRendering'] = (param: LuaValue) => {
            const p = String(param ?? '');
            const defaults: Record<string, number | number[]> = {
                voidWater:                       0,
                voidGround:                      0,
                splatTexScales:                  [0.02, 0.02, 0.02, 0.02],
                splatTexMults:                   [1, 1, 1, 1],
                splatDetailNormalDiffuseAlpha:   0,
            };
            return defaults[p] ?? 0;
        };

        // gl.GetMatrixData(matrixName | matrixMode, [slot]) — returns the
        // 16 floats of the named matrix, or a single element at slot.
        // We only return identity for named matrices — the modelview/proj
        // stack values are managed internally by the immediate-mode helper
        // and not yet round-trippable. This is safe for shader setup that
        // multiplies by gl_ProjectionMatrix etc., as the engine binds the
        // actual matrices outside Lua.
        gl['GetMatrixData'] = (_arg: LuaValue, slot?: LuaValue) => {
            const ident = [1, 0, 0, 0,  0, 1, 0, 0,  0, 0, 1, 0,  0, 0, 0, 1];
            if (slot != null) return ident[Number(slot) | 0] ?? 0;
            return ident;
        };

        // gl.GetFontInfo(font) — returns metadata about a font handle.
        // The font object already exposes .lineheight / .descender so the
        // common cases are covered there; this is for widgets that prefer
        // the freestanding gl.GetFontInfo call.
        gl['GetFontInfo'] = (font: LuaValue) => {
            const f = font as Record<string, LuaValue> | null;
            if (!f) return { lineheight: 1.2, descender: -0.2, height: 1.0 };
            return {
                lineheight: Number(f.lineheight ?? 1.2),
                descender:  Number(f.descender  ?? -0.2),
                height:     Number(f.height     ?? 1.0),
            };
        };

        // gl.GetVBO([target]) — returns a buffer-object wrapper. We don't
        // have a real VBO implementation yet (parallel to GetVAO would be
        // significant work), so hand back a stub whose methods are all
        // no-ops. Widgets that test "if vbo then ..." still see truthy;
        // those that try to render via it silently no-op rather than
        // raising on a method-call-on-nil.
        gl['GetVBO'] = (_target?: LuaValue) => {
            const stub: Record<string, LuaValue> = {};
            const noop = (..._a: LuaValue[]): LuaValue => null;
            for (const name of ['Define', 'Upload', 'Update', 'Read',
                                'BindBufferRange', 'UnbindBufferRange',
                                'Delete', 'ModelsVBO', 'MatrixVBO',
                                'InstanceDataFromUnitDefIDs',
                                'InstanceDataFromFeatureDefIDs',
                                'InstanceDataFromUnitIDs',
                                'InstanceDataFromFeatureIDs']) {
                stub[name] = noop;
            }
            return stub;
        };

        return gl;
    }

    // ============================================================
    // Immediate-mode drawing (real WebGL + FBO pixel-buffer fallback)
    // ============================================================

    private color(args: LuaValue[]): void {
        // gl.Color supports two call forms:
        //   gl.Color(r, g, b, a)   — 4 numbers
        //   gl.Color({r, g, b, a}) — single table (used widely in Chili)
        // Without the table-form unpacking, Number({...}) yields NaN and
        // colors silently become garbage — most visibly, a fully-transparent
        // {0,0,0,0} renders as opaque or a stale colour.
        let r: number, g: number, b: number, a: number;
        if (args.length === 1 && typeof args[0] === 'object' && args[0] !== null) {
            const t = args[0] as Record<string | number, LuaValue>;
            // Fengari tables are 1-indexed for sequence access
            r = Number(t[1] ?? t[0] ?? 1);
            g = Number(t[2] ?? t[1] ?? 1);
            b = Number(t[3] ?? t[2] ?? 1);
            a = Number(t[4] ?? t[3] ?? 1);
        } else {
            r = Number(args[0] ?? 1);
            g = Number(args[1] ?? 1);
            b = Number(args[2] ?? 1);
            a = Number(args[3] ?? 1);
        }
        this.imm.color(clamp01(r), clamp01(g), clamp01(b), clamp01(a));
    }

    private rect(args: LuaValue[]): void {
        const x1 = Number(args[0]);
        const y1 = Number(args[1]);
        const x2 = Number(args[2]);
        const y2 = Number(args[3]);
        if (!Number.isFinite(x1) || !Number.isFinite(y1) ||
            !Number.isFinite(x2) || !Number.isFinite(y2)) return;
        this.imm.setTextured(this.hasTextureUnit0, this.boundTextureUnit0);
        this.imm.rect(x1, y1, x2, y2);
    }

    private texRect(args: LuaValue[]): void {
        const x1 = Number(args[0]);
        const y1 = Number(args[1]);
        const x2 = Number(args[2]);
        const y2 = Number(args[3]);
        // Spring's gl.TexRect supports three signatures:
        //   gl.TexRect(x1, y1, x2, y2)                           -> UVs 0..1
        //   gl.TexRect(x1, y1, x2, y2, flipX, flipY)             -> boolean flip flags
        //   gl.TexRect(x1, y1, x2, y2, s1, t1, s2, t2)           -> explicit UVs
        // Chili's Image control and skinutils._DrawTextureAspect use the
        // boolean form heavily. Detecting on typeof avoids treating booleans
        // as Number(false)=0 / Number(true)=1, which would collapse the UV
        // box to a 1px stripe and hide every Image-rendered chili button.
        //
        // Note on flipY semantics: Chili widgets default to flipY=true to
        // compensate for `gl.Scale(1,-1,1)` against Spring's DevIL texture
        // upload (DevIL puts row 0 at the visual bottom of the source).
        // WebGL's `createImageBitmap` uploads row 0 = visual top, the opposite
        // convention — so the chili-intended "flip" is already implicit in
        // our texture data. We invert flipY here so chili's flipY=true (the
        // common case) maps to a natural sampling, rendering the image
        // upright instead of upside-down. flipX has no equivalent mismatch.
        let s1: number, t1: number, s2: number, t2: number;
        if (typeof args[4] === 'boolean' || typeof args[5] === 'boolean') {
            const flipX = !!args[4];
            const flipY = !!args[5];
            s1 = flipX ? 1 : 0;
            s2 = flipX ? 0 : 1;
            t1 = flipY ? 0 : 1;
            t2 = flipY ? 1 : 0;
        } else {
            s1 = Number(args[4] ?? 0);
            t1 = Number(args[5] ?? 0);
            s2 = Number(args[6] ?? 1);
            t2 = Number(args[7] ?? 1);
        }
        this.imm.setTextured(this.hasTextureUnit0, this.boundTextureUnit0);
        this.imm.texRect(x1, y1, x2, y2, s1, t1, s2, t2);
    }

    private beginEnd(mode: LuaValue, fn: LuaValue, extra: LuaValue[]): void {
        if (typeof fn !== 'function') return;
        this.imm.setTextured(this.hasTextureUnit0, this.boundTextureUnit0);
        this.imm.beginEnd(Number(mode), () => {
            (fn as (...a: LuaValue[]) => void)(...extra);
        });
    }

    private vertexGL(args: LuaValue[]): void {
        this.imm.vertex(Number(args[0] ?? 0), Number(args[1] ?? 0));
    }

    private texCoordGL(args: LuaValue[]): void {
        this.imm.texCoord(Number(args[0] ?? 0), Number(args[1] ?? 0));
    }

    private loadMatrix(args: LuaValue[]): void {
        if (args.length >= 16) {
            const m = new Float32Array(16);
            for (let i = 0; i < 16; i++) m[i] = Number(args[i]);
            this.applyLegacyMatrixFlip(m);
            this.imm.loadMatrix(m);
        }
    }

    private multMatrixGL(args: LuaValue[]): void {
        if (args.length >= 16) {
            const m = new Float32Array(16);
            for (let i = 0; i < 16; i++) m[i] = Number(args[i]);
            this.applyLegacyMatrixFlip(m);
            this.imm.multMatrix(m);
        }
    }

    /** Conjugate the rotation block of a 4×4 by diag(1, 1, -1, 1) when
     *  bridging legacy LH widgets. Negates the Z row + Z column,
     *  excluding m[10] (flipped twice). Translation Z is NOT negated —
     *  positions stay in [0, mapZ] under Option A. Mirrors the
     *  server-side `LuaCoordAdapt::FlipMatrix` so widgets that read a
     *  piece matrix on the server and push it through `gl.LoadMatrix`
     *  get the expected visual result. */
    private applyLegacyMatrixFlip(m: Float32Array): void {
        if (!this.legacyCoordSystem) return;
        m[ 2] = -m[ 2];   // col 0, row 2
        m[ 6] = -m[ 6];   // col 1, row 2
        m[ 8] = -m[ 8];   // col 2, row 0
        m[ 9] = -m[ 9];   // col 2, row 1
        // m[10] flips twice — leave alone.
        m[11] = -m[11];   // col 2, row 3
        // m[14] (translation Z) — NOT negated; positions stay in [0, mapZ].
    }

    private createList(fn: LuaValue, ...args: LuaValue[]): number {
        if (typeof fn !== 'function') {
            console.warn(`[gl.CreateList] fn is not a function: type=${typeof fn} val=${fn}`);
            return 0;
        }
        const id = this.imm.createList(() => {
            (fn as (...a: LuaValue[]) => void)(...args);
        });
        return id;
    }

    private clear(args: LuaValue[]): void {
        const gl = this.gl;
        const mask = Number(args[0] ?? 0);
        if (args.length >= 5) {
            gl.clearColor(
                clamp01(Number(args[1])),
                clamp01(Number(args[2])),
                clamp01(Number(args[3])),
                clamp01(Number(args[4])),
            );
        }
        let glMask = 0;
        if (mask & 0x00004000) glMask |= gl.COLOR_BUFFER_BIT;
        if (mask & 0x00000100) glMask |= gl.DEPTH_BUFFER_BIT;
        if (mask & 0x00000400) glMask |= gl.STENCIL_BUFFER_BIT;
        if (glMask) gl.clear(glMask);
    }

    // ============================================================
    // State functions needed by Chili GUI
    // ============================================================

    private blendFunc(src: LuaValue, dst: LuaValue): void {
        const gl = this.gl;
        gl.enable(gl.BLEND);
        gl.blendFunc(Number(src), Number(dst));
    }

    private blendFuncSeparate(srcRGB: LuaValue, dstRGB: LuaValue,
        srcA: LuaValue, dstA: LuaValue): void {
        const gl = this.gl;
        gl.enable(gl.BLEND);
        gl.blendFuncSeparate(Number(srcRGB), Number(dstRGB),
            Number(srcA), Number(dstA));
    }

    private colorMask(r: LuaValue, g?: LuaValue, b?: LuaValue, a?: LuaValue): void {
        const gl = this.gl;
        if (typeof r === 'boolean' && g === undefined) {
            // Single boolean form: gl.ColorMask(false) / gl.ColorMask(true)
            gl.colorMask(r, r, r, r);
        } else {
            gl.colorMask(!!r, !!(g ?? r), !!(b ?? r), !!(a ?? r));
        }
    }

    private scissor(x: LuaValue, y?: LuaValue, w?: LuaValue, h?: LuaValue): void {
        const gl = this.gl;
        if (x === false || x === null || x === undefined) {
            gl.disable(gl.SCISSOR_TEST);
            return;
        }
        gl.enable(gl.SCISSOR_TEST);
        gl.scissor(Number(x), Number(y), Number(w), Number(h));
    }

    private stencilTest(on: LuaValue): void {
        const gl = this.gl;
        if (on === true || on === 1) gl.enable(gl.STENCIL_TEST);
        else gl.disable(gl.STENCIL_TEST);
    }

    private stencilFunc(func: LuaValue, ref: LuaValue, mask: LuaValue): void {
        this.gl.stencilFunc(Number(func), Number(ref), Number(mask));
    }

    private stencilOp(sfail: LuaValue, dpfail: LuaValue, dppass: LuaValue): void {
        this.gl.stencilOp(Number(sfail), Number(dpfail), Number(dppass));
    }

    private stencilMask(mask: LuaValue): void {
        this.gl.stencilMask(Number(mask));
    }

    private alphaTest(on: LuaValue, threshold?: LuaValue): void {
        // WebGL2 has no fixed-function alpha test — emulated in the
        // immediate-mode fragment shader via discard.
        if (on === false || on === 0) {
            this.imm.setAlphaThreshold(0);
        } else {
            this.imm.setAlphaThreshold(Number(threshold ?? 0));
        }
    }

    private lineWidth(w: LuaValue): void {
        // WebGL2 only supports lineWidth(1) on most implementations,
        // but we call it anyway for compliance.
        this.gl.lineWidth(Math.max(1, Number(w)));
    }

    private textureInfo(handleOrPath: LuaValue): Record<string, number> | null {
        if (typeof handleOrPath === 'object' && handleOrPath !== null) {
            const h = handleOrPath as unknown as LuaTextureHandle;
            if (h.__type === 'texture') {
                return { xsize: h.width, ysize: h.height };
            }
        }
        if (typeof handleOrPath === 'string') {
            const normalised = this.normaliseTexturePath(handleOrPath);
            const cached = this.textureCache.get(normalised);
            if (cached) {
                return { xsize: cached.width, ysize: cached.height };
            }
        }
        return null;
    }

    private isValidFBO(handle: LuaValue): boolean {
        if (!handle || typeof handle !== 'object' || Array.isArray(handle)) return false;
        const h = handle as unknown as LuaFBOHandle;
        if (h.__type !== 'fbo') return false;
        const gl = this.gl;
        const saved = gl.getParameter(gl.FRAMEBUFFER_BINDING);
        gl.bindFramebuffer(gl.FRAMEBUFFER, h.fbo);
        const status = gl.checkFramebufferStatus(gl.FRAMEBUFFER);
        gl.bindFramebuffer(gl.FRAMEBUFFER, saved);
        return status === gl.FRAMEBUFFER_COMPLETE;
    }

    private createRBO(w: LuaValue, h: LuaValue, opts: LuaValue): number {
        const gl = this.gl;
        const rbo = gl.createRenderbuffer();
        if (!rbo) return 0;
        gl.bindRenderbuffer(gl.RENDERBUFFER, rbo);
        // Default to DEPTH24_STENCIL8 which is what Chili uses
        const format = (opts && typeof opts === 'object' && !Array.isArray(opts))
            ? Number((opts as Record<string, LuaValue>)['format'] ?? gl.DEPTH24_STENCIL8)
            : gl.DEPTH24_STENCIL8;
        gl.renderbufferStorage(gl.RENDERBUFFER, format, Number(w), Number(h));
        gl.bindRenderbuffer(gl.RENDERBUFFER, null);
        const id = this.nextRboId++;
        this.rboHandles.set(id, rbo);
        return id;
    }

    private deleteRBO(handle: LuaValue): void {
        const id = Number(handle);
        const rbo = this.rboHandles.get(id);
        if (rbo) {
            this.gl.deleteRenderbuffer(rbo);
            this.rboHandles.delete(id);
        }
    }

    /** Expose the last shader error for gl.GetShaderLog(). */
    private lastShaderLog = '';

    /**
     * Set by translateGLSL when the rejection is by design (e.g. a
     * shader uses gl_Vertex and we want the widget to fall through to
     * its software path). createShader downgrades the console message
     * for these so the network/console isn't littered with red warnings
     * on every game start.
     */
    private expectedShaderReject = false;

    // ============================================================
    // Shader management
    // ============================================================

    /**
     * Translate Spring's `#version 150 compatibility` GLSL into something
     * WebGL2 (GLSL ES 300) accepts. Spring shaders use core-profile
     * features (in/out, texture(), flat qualifier) that map cleanly to
     * GLSL ES 300, but GLSL ES is strict about implicit int→float
     * conversions that GLSL 150 allows. We do a pragmatic set of regex
     * fixups that cover the patterns used in real map widgets (tested
     * against scorched_crossing's lava_layer shader).
     */
    private translateGLSL(src: string, stage: 'vertex' | 'fragment'): string {
        // Detect legacy GLSL 1.10/1.20 (gui_xrayhaloselect,
        // map_edge_extension, etc.). They use `varying`, `attribute`,
        // `gl_FragColor`, `texture2D` — all removed in GLSL ES 3.0. We
        // rewrite them before the int→float pass below sees them.
        //
        // We deliberately do NOT translate `gl_Vertex` here. Spring's
        // legacy shaders that reference it expect the vertex stream to
        // be supplied by the caller's pipeline — but our immediate-mode
        // bridge always uses its OWN program for draw calls (flush()
        // unconditionally calls useProgram(this.program)). A user
        // shader that compiles successfully would never actually run,
        // and chili widgets like the minimap fadeShader use the
        // non-nil compile result as a signal to enable an offscreen
        // postprocess path that we don't support — see the
        // CleanUpFBO/elseif branches in gui_chili_minimap.lua. Keep
        // those shaders failing-compile so the simple path stays
        // selected.
        const isLegacy = /\bvarying\b|\battribute\b|\bgl_FragColor\b|\btexture2D\b/.test(src);
        if (/\bgl_Vertex\b/.test(src)) {
            this.lastShaderLog = 'CreateShader: legacy gl_Vertex not supported in immediate-mode bridge';
            // Mark the rejection as expected so createShader's log
            // formatter can downgrade the message — gui_chili_minimap's
            // fadeShader (and a handful of other ZK widgets) hit this
            // path on every game start, and they correctly fall back to
            // the simple draw path when CreateShader returns nil.
            this.expectedShaderReject = true;
            return '#error legacy_gl_Vertex_unsupported';
        }
        // GL4 shaders (#version 400+) use SSBOs, `layout(binding=...)`,
        // and other features that only exist in GLSL ES 3.1+. WebGL2 is
        // ES 3.0, so we can't translate them — reject early as expected
        // so widgets (api_chili_draw_gl4, gfx_outline_shader_gl4, etc.)
        // fall back to their non-gl4 path without warning spam.
        const versionMatch = src.match(/#version\s+(\d+)/);
        if (versionMatch && parseInt(versionMatch[1], 10) >= 400) {
            this.lastShaderLog = 'CreateShader: GL4 shader (#version ' + versionMatch[1] + ') not supported on WebGL2/ES 3.0';
            this.expectedShaderReject = true;
            return '#error gl4_shader_unsupported';
        }
        // Strip Spring's version directive entirely.
        let s = src.replace(/#version\s+\d+\s*(compatibility|core)?\s*/g, '');
        // Strip `#extension` directives. They reference desktop-GL
        // extensions (GL_ARB_*) that either don't exist in ES or are
        // already core in ES 3.0. Leaving them in place also breaks the
        // ordering rule — `#extension` must follow `#version` but
        // precede any non-preprocessor token, and our injected
        // precision qualifiers would push them out of order.
        s = s.replace(/^[ \t]*#extension\s+[^\n]*\n?/gm, '');
        // Inject ES 300 header with precision qualifiers. Fragment needs
        // high precision for the lava math.
        const header = stage === 'vertex'
            ? '#version 300 es\nprecision highp float;\nprecision highp int;\n'
            : '#version 300 es\nprecision highp float;\nprecision highp int;\nprecision highp sampler2D;\nprecision highp sampler2DShadow;\n';
        s = header + s;
        // GLSL ES 300 doesn't support `sampler2DShadow` without a
        // specific texture format — map it to a normal sampler2D; we
        // stub the shadow texture anyway.
        s = s.replace(/sampler2DShadow/g, 'sampler2D');

        // ---- Legacy GLSL 1.10 → ES 300 rewrites ----
        // Run before the int→float pass so the legacy keywords
        // (`varying`, `gl_FragColor`, `texture2D`) are gone by the time
        // the numeric promotion regexes run.
        if (isLegacy) {
            if (stage === 'vertex') {
                // `attribute` → `in`, `varying` → `out` (vertex emits).
                s = s.replace(/\battribute\b/g, 'in');
                s = s.replace(/\bvarying\b/g, 'out');
            } else {
                // Fragment: `varying` → `in`. Add an explicit out
                // variable to replace `gl_FragColor`. texture2D maps
                // to the new unified texture() function.
                s = s.replace(/\bvarying\b/g, 'in');
                s = s.replace(/\btexture2D\b/g, 'texture');
                if (/\bgl_FragColor\b/.test(s)) {
                    s = s.replace(/\bgl_FragColor\b/g, 'outFragColor');
                    // Anchor after `precision highp int;` so the float
                    // precision is in scope by the time we declare the
                    // vec4 out (otherwise GLSL ES errors on missing
                    // precision). Don't anchor on sampler2DShadow — it
                    // gets renamed to sampler2D by the regex above.
                    s = s.replace(
                        /(precision\s+highp\s+int;\n)/,
                        '$1out vec4 outFragColor;\n',
                    );
                }
            }
        }

        // ---- Int → float promotions ----
        //
        // GLSL ES 300 is strict: you cannot assign an integer literal to
        // a float, multiply/divide an int by a float, or construct a
        // float array from mixed-type literals. Spring's 150-compat
        // shaders do all of these. We rewrite them:

        // 1. `const float NAME = -?INT;` → append `.0` to the literal.
        //    e.g. `const float MIN_HEIGHT = -100;` → `= -100.0;`
        s = s.replace(
            /(\bconst\s+float\s+\w+\s*=\s*)(-?\d+)(\s*;)/g,
            '$1$2.0$3',
        );

        // 2. Integer literals inside `float[N](...)` array constructors.
        //    `float[NUM_LAYERS](1, 6.6, 8.4, ...)` must become
        //    `float[NUM_LAYERS](1.0, 6.6, 8.4, ...)`. We match the whole
        //    constructor body and replace bare ints with `.0` form.
        //    The look-ahead `(?![\w.])` rejects *any* digit or dot that
        //    follows — critical because otherwise `\d+` would backtrack
        //    from `34` to `3`, then happily append `.0` and produce the
        //    garbage `3.04.6` out of `34.6`.
        s = s.replace(
            /(\bfloat\s*\[[^\]]*\]\s*\()([^)]*)(\))/g,
            (_, start, body, end) => {
                const fixed = body.replace(
                    /(^|[^\w.])(-?\d+)(?![\w.])/g,
                    '$1$2.0',
                );
                return start + fixed + end;
            },
        );

        // 3. Bare int literal on LHS of arithmetic: `2*PI` → `2.0*PI`,
        //    `1+ scalePeriodFactor` → `1.0+ scalePeriodFactor`,
        //    `1 + 0.2*x` → `1.0 + 0.2*x`.
        //    - Negative look-behind `(?<![\w.])` avoids `x1`, `.1`, `21`.
        //    - Negative look-ahead `(?![\w.])` avoids `1.0`, `1e5`, `1x`.
        //    - We don't require what comes *after* the operator, so
        //      `1 + 0.2*x` matches (RHS is another number literal).
        s = s.replace(
            /(?<![\w.])(-?\d+)(?![\w.])(\s*[*/+\-])/g,
            '$1.0$2',
        );

        // 4. Bare int literal on RHS of arithmetic after an identifier,
        //    `)`, or member access: `/13` → `/13.0`, `gameSeconds/2` →
        //    `gameSeconds/2.0`. Look-ahead avoids `10.0`, `10e5`, `10]`.
        s = s.replace(
            /([A-Za-z_)](?:\.\w+)?\s*[*/+\-]\s*)(-?\d+)(?![\w.\]])/g,
            '$1$2.0',
        );

        // 4b. Bare int literal on RHS of comparison with a float-valued
        //    swizzle/member access: `uvCoords.x >= 0` → `uvCoords.x >= 0.0`.
        //    We *require* the `.member` on the LHS because plain-identifier
        //    comparisons may be against an `int` varying (e.g. the lava
        //    widget's `if (layerNumber < 4)` — `layerNumber` is `flat in int`
        //    and must stay an integer comparison).
        s = s.replace(
            /([A-Za-z_)]\.\w+\s*(?:>=|<=|==|!=|>|<)\s*)(-?\d+)(?![\w.\]])/g,
            '$1$2.0',
        );

        // 4c. Assignment of bare int literal to a float variable:
        //    `fFactor = 0;` → `fFactor = 0.0;`. We can't distinguish
        //    `int i = 0;` from `float f = 0;` via regex alone, so we
        //    apply this per-line and skip any line that declares an
        //    integer type (`int`, `uint`, `ivec*`, `uvec*`, `bvec*`) or
        //    opens a for-loop counter. That rules out the declaration
        //    cases while catching pure reassignments like the lava
        //    widget's `fFactor = 0;`.
        s = s.split('\n').map(line => {
            if (/\b(int|uint|ivec[234]|uvec[234]|bvec[234])\b/.test(line)) return line;
            if (/\bfor\s*\(/.test(line)) return line;
            return line.replace(
                /(\b\w+\s*=\s*)(-?\d+)(\s*;)/g,
                '$1$2.0$3',
            );
        }).join('\n');

        // 5. `gl_InstanceID` used as a float operand. It's still an int
        //    (so array indexing `a[gl_InstanceID]` stays valid), but any
        //    arithmetic op with a float identifier must cast it.
        //    We catch the two canonical patterns `float_expr * gl_InstanceID`
        //    and `gl_InstanceID * float_expr` — anything where the ID is
        //    adjacent to an arithmetic operator outside a bracket context.
        s = s.replace(
            /([*/+\-])\s*gl_InstanceID\b(?!\s*\])/g,
            '$1 float(gl_InstanceID)',
        );
        s = s.replace(
            /\bgl_InstanceID\s*([*/+\-])/g,
            'float(gl_InstanceID) $1',
        );

        return s;
    }

    private createShader(opts: LuaValue): LuaShaderHandle | null {
        if (!opts || typeof opts !== 'object' || Array.isArray(opts)) {
            this.lastShaderLog = 'CreateShader: options must be a table';
            return null;
        }
        const rec = opts as Record<string, LuaValue>;
        const vsSrc = rec['vertex'];
        const fsSrc = rec['fragment'];
        if (typeof vsSrc !== 'string' || typeof fsSrc !== 'string') {
            this.lastShaderLog = 'CreateShader: missing vertex/fragment source';
            return null;
        }
        const gl = this.gl;
        // Reset the by-design rejection flag for this compile pass —
        // translateGLSL sets it when it returns an `#error` sentinel
        // for legacy attributes we deliberately don't translate.
        this.expectedShaderReject = false;
        const reportShaderFailure = (msg: string) => {
            if (this.expectedShaderReject) {
                console.debug('[gl.CreateShader]', msg);
            } else {
                console.warn('[gl.CreateShader]', msg);
            }
        };
        const vs = gl.createShader(gl.VERTEX_SHADER)!;
        gl.shaderSource(vs, this.translateGLSL(vsSrc, 'vertex'));
        gl.compileShader(vs);
        if (!gl.getShaderParameter(vs, gl.COMPILE_STATUS)) {
            this.lastShaderLog = 'VS: ' + (gl.getShaderInfoLog(vs) ?? '');
            gl.deleteShader(vs);
            reportShaderFailure(this.lastShaderLog);
            return null;
        }
        const fs = gl.createShader(gl.FRAGMENT_SHADER)!;
        gl.shaderSource(fs, this.translateGLSL(fsSrc, 'fragment'));
        gl.compileShader(fs);
        if (!gl.getShaderParameter(fs, gl.COMPILE_STATUS)) {
            this.lastShaderLog = 'FS: ' + (gl.getShaderInfoLog(fs) ?? '');
            gl.deleteShader(vs);
            gl.deleteShader(fs);
            reportShaderFailure(this.lastShaderLog);
            return null;
        }
        const program = gl.createProgram()!;
        gl.attachShader(program, vs);
        gl.attachShader(program, fs);
        gl.linkProgram(program);
        if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
            this.lastShaderLog = 'LINK: ' + (gl.getProgramInfoLog(program) ?? '');
            gl.deleteProgram(program);
            gl.deleteShader(vs);
            gl.deleteShader(fs);
            reportShaderFailure(this.lastShaderLog);
            return null;
        }
        gl.deleteShader(vs);
        gl.deleteShader(fs);

        const handle: LuaShaderHandle = markOpaque({
            __type: 'shader',
            program,
            uniforms: new Map(),
        });

        // Apply default uniformInt and uniformFloat blocks from opts so
        // the widget doesn't have to call gl.Uniform for each default.
        const savedProgram = gl.getParameter(gl.CURRENT_PROGRAM);
        gl.useProgram(program);
        const ui = rec['uniformInt'];
        if (ui && typeof ui === 'object' && !Array.isArray(ui)) {
            for (const [k, v] of Object.entries(ui as Record<string, LuaValue>)) {
                const loc = this.getUniformLocation(handle, k);
                if (loc) gl.uniform1i(loc, Number(v));
            }
        }
        const uf = rec['uniformFloat'];
        if (uf && typeof uf === 'object' && !Array.isArray(uf)) {
            for (const [k, v] of Object.entries(uf as Record<string, LuaValue>)) {
                const loc = this.getUniformLocation(handle, k);
                if (!loc) continue;
                if (Array.isArray(v)) {
                    if (v.length === 1) gl.uniform1f(loc, Number(v[0]));
                    else if (v.length === 2) gl.uniform2f(loc, Number(v[0]), Number(v[1]));
                    else if (v.length === 3) gl.uniform3f(loc, Number(v[0]), Number(v[1]), Number(v[2]));
                    else if (v.length === 4) gl.uniform4f(loc, Number(v[0]), Number(v[1]), Number(v[2]), Number(v[3]));
                } else if (typeof v === 'object' && v !== null) {
                    // Lua table passed as object — walk keys as integer indices
                    const arr = Object.values(v as Record<string, LuaValue>).map(Number);
                    if (arr.length === 1) gl.uniform1f(loc, arr[0]);
                    else if (arr.length === 2) gl.uniform2f(loc, arr[0], arr[1]);
                    else if (arr.length === 3) gl.uniform3f(loc, arr[0], arr[1], arr[2]);
                    else if (arr.length === 4) gl.uniform4f(loc, arr[0], arr[1], arr[2], arr[3]);
                } else {
                    gl.uniform1f(loc, Number(v));
                }
            }
        }
        gl.useProgram(savedProgram);
        return handle;
    }

    private useShader(handle: LuaValue): void {
        if (!handle || (typeof handle === 'number' && handle === 0)) {
            this.gl.useProgram(null);
            this.currentShader = null;
            return;
        }
        const h = handle as LuaShaderHandle;
        if (h.__type !== 'shader') return;
        this.gl.useProgram(h.program);
        this.currentShader = h;
    }

    private deleteShader(handle: LuaValue): void {
        if (!handle || typeof handle !== 'object' || Array.isArray(handle)) return;
        const h = handle as unknown as LuaShaderHandle;
        if (h.__type !== 'shader') return;
        this.gl.deleteProgram(h.program);
    }

    private getUniformLocation(shader: LuaShaderHandle, name: string): WebGLUniformLocation | null {
        if (shader.uniforms.has(name)) return shader.uniforms.get(name) ?? null;
        const loc = this.gl.getUniformLocation(shader.program, name);
        if (loc) shader.uniforms.set(name, loc);
        return loc;
    }

    private setUniform(name: LuaValue, args: LuaValue[]): void {
        if (!this.currentShader) return;
        const loc = this.getUniformLocation(this.currentShader, String(name));
        if (!loc) return;
        const gl = this.gl;
        // Spring's gl.Uniform handles both scalar and matching-value variants.
        if (args.length === 1) {
            // Could be a string like "view" for a special matrix — widget
            // uses this with UniformMatrix, not Uniform. Scalar case here.
            gl.uniform1f(loc, Number(args[0]));
        } else if (args.length === 2) {
            gl.uniform2f(loc, Number(args[0]), Number(args[1]));
        } else if (args.length === 3) {
            gl.uniform3f(loc, Number(args[0]), Number(args[1]), Number(args[2]));
        } else if (args.length >= 4) {
            gl.uniform4f(loc, Number(args[0]), Number(args[1]), Number(args[2]), Number(args[3]));
        }
    }

    private setUniformInt(name: LuaValue, args: LuaValue[]): void {
        if (!this.currentShader) return;
        const loc = this.getUniformLocation(this.currentShader, String(name));
        if (!loc) return;
        const gl = this.gl;
        if (args.length === 1) gl.uniform1i(loc, Number(args[0]));
        else if (args.length === 2) gl.uniform2i(loc, Number(args[0]), Number(args[1]));
        else if (args.length === 3) gl.uniform3i(loc, Number(args[0]), Number(args[1]), Number(args[2]));
        else if (args.length >= 4) gl.uniform4i(loc, Number(args[0]), Number(args[1]), Number(args[2]), Number(args[3]));
    }

    /** Cached matrices fed into UniformMatrix("view"/"projection"). */
    viewMatrix: Float32Array | null = null;
    projectionMatrix: Float32Array | null = null;

    private setUniformMatrix(name: LuaValue, args: LuaValue[]): void {
        if (!this.currentShader) return;
        const loc = this.getUniformLocation(this.currentShader, String(name));
        if (!loc) return;
        const gl = this.gl;
        // Spring accepts either a matrix name ("view"/"projection"/"camera"/
        // "shadow") or 16 floats / a Lua table.
        if (args.length === 1 && typeof args[0] === 'string') {
            const matName = args[0];
            let mat: Float32Array | null = null;
            if (matName === 'view' || matName === 'modelview') mat = this.viewMatrix;
            else if (matName === 'projection') mat = this.projectionMatrix;
            if (mat) gl.uniformMatrix4fv(loc, false, mat);
            return;
        }
        if (args.length === 16) {
            const m = new Float32Array(16);
            for (let i = 0; i < 16; i++) m[i] = Number(args[i]);
            gl.uniformMatrix4fv(loc, false, m);
        }
    }

    private setUniformArray(name: LuaValue, arr: LuaValue): void {
        if (!this.currentShader || !arr) return;
        const loc = this.getUniformLocation(this.currentShader, String(name));
        if (!loc) return;
        // Not used by lava_layer beyond constants — stub.
        void loc;
    }

    // ============================================================
    // Textures
    // ============================================================

    private createSolidTexture(r: number, g: number, b: number, a: number): WebGLTexture {
        const gl = this.gl;
        const tex = gl.createTexture()!;
        gl.bindTexture(gl.TEXTURE_2D, tex);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE,
            new Uint8Array([r, g, b, a]));
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
        return tex;
    }

    /**
     * gl.CreateTexture has two forms:
     *   gl.CreateTexture(width, height, opts) — allocates an empty texture
     *   gl.CreateTexture(path)                — loads from an image path
     */
    private createTexture(a: LuaValue, b: LuaValue, c: LuaValue): LuaTextureHandle | null {
        const gl = this.gl;
        if (typeof a === 'string') {
            // Path form — load via image fetch. Reuse the cached handle
            // when present so repeated CreateTexture calls share the
            // same underlying GPU texture (and so TextureInfo sees the
            // dimensions the loader filled in). Without this, every
            // call would mint a fresh magenta 1×1 stub.
            const path = a;
            const normalised = this.normaliseTexturePath(path);
            const cached = this.textureCache.get(normalised);
            if (cached) return cached;
            const tex = this.createSolidTexture(255, 0, 255, 255); // magenta placeholder
            const handle: LuaTextureHandle = markOpaque({
                __type: 'texture',
                tex,
                width: 1, height: 1,
            });
            const url = this.resolveTextureUrl(normalised);
            const fallbacks = this.buildFallbackUrls(normalised, url);
            // Fire off async load; replace data when ready.
            void this.loadImageInto(url, handle, fallbacks.length > 0 ? fallbacks : undefined);
            this.textureCache.set(normalised, handle);
            return handle;
        }
        if (typeof a === 'number' && typeof b === 'number') {
            const width = a;
            const height = b;
            const opts = (c && typeof c === 'object' && !Array.isArray(c))
                ? c as Record<string, LuaValue>
                : {};
            const format = Number(opts['format'] ?? gl.RGBA);
            const minFilter = Number(opts['min_filter'] ?? gl.LINEAR);
            const magFilter = Number(opts['mag_filter'] ?? gl.LINEAR);
            // Spring/ZK widgets (e.g. gui_chili_minimap) pass desktop GL's
            // GL.CLAMP (0x2900) which WebGL rejects with INVALID_ENUM.
            // Map it to CLAMP_TO_EDGE — the closest WebGL equivalent.
            const sanitiseWrap = (v: number): number =>
                v === 0x2900 ? gl.CLAMP_TO_EDGE : v;
            const wrapS = sanitiseWrap(Number(opts['wrap_s'] ?? gl.CLAMP_TO_EDGE));
            const wrapT = sanitiseWrap(Number(opts['wrap_t'] ?? gl.CLAMP_TO_EDGE));
            const tex = gl.createTexture()!;
            gl.bindTexture(gl.TEXTURE_2D, tex);
            // Use a web-safe internal format. Spring passes GL.RGBA (0x1908).
            const internalFormat = (format === gl.RGBA) ? gl.RGBA8 : gl.RGBA8;
            gl.texImage2D(gl.TEXTURE_2D, 0, internalFormat, width, height, 0,
                gl.RGBA, gl.UNSIGNED_BYTE, null);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, minFilter);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, magFilter);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, wrapS);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, wrapT);
            return markOpaque({ __type: 'texture' as const, tex, width, height });
        }
        return null;
    }

    private normaliseTexturePath(path: string): string {
        let p = path;
        // Strip Spring texture modifiers: :c:, :cl:, :n:, :a:, :l:, etc.
        // Format is :<modifier>:<path> where modifier can be multi-char.
        while (p.startsWith(':') && p.length >= 3) {
            const nextColon = p.indexOf(':', 1);
            if (nextColon > 0 && nextColon < 8) {
                p = p.substring(nextColon + 1);
            } else {
                break;
            }
        }
        p = p.replace(/\\/g, '/');
        if (p.startsWith('/')) p = p.substring(1);
        return p;
    }

    /** Register an asset URL override. The key is the normalised texture path
     *  (lowercase, forward-slash). Used by the worker in `?widgetTest` mode
     *  to map paths like "LuaUI/Images/quit.png" to bundled-asset URLs. */
    addAssetOverride(path: string, url: string): void {
        this.assetOverrides.set(this.normaliseTexturePath(path).toLowerCase(), url);
    }

    /** Compute fallback URLs to try if the primary URL 404s. Covers two
     *  cases: (a) build-pic case mismatch (`UnitDefs[].buildPic` is whatever
     *  the unitdef said; static-file routing is case-sensitive) and (b)
     *  short names that may live under one of the registered skin search
     *  paths instead of the game root. */
    private buildFallbackUrls(normalised: string, primaryUrl: string): string[] {
        const fallbacks: string[] = [];
        if (!this.gameBaseUrl) return fallbacks;
        if (normalised.startsWith('#')) {
            const id = parseInt(normalised.substring(1), 10);
            if (Number.isFinite(id) && this.buildPicResolver) {
                const pic = this.buildPicResolver(id);
                if (pic && pic !== pic.toLowerCase()) {
                    const lc = `${this.gameBaseUrl}/unitpics/${pic.toLowerCase()}`;
                    if (lc !== primaryUrl) fallbacks.push(lc);
                }
            }
            return fallbacks;
        }
        if (!normalised.includes('/')) {
            for (const sp of this.textureSearchPaths) {
                const fb = `${this.gameBaseUrl}/${sp}${normalised}`;
                if (fb !== primaryUrl) fallbacks.push(fb);
            }
        }
        return fallbacks;
    }

    /** Resolve a texture URL, trying search paths for short names. */
    private resolveTextureUrl(normalised: string): string {
        const override = this.assetOverrides.get(normalised.toLowerCase());
        if (override) return override;
        // Spring's `'#' .. unitDefID` build-pic syntax. UnitDefs[id].buildPic
        // is the bare filename (e.g. "commrecon.png"); the asset lives under
        // /api/games/data/<game>/unitpics/. If the resolver doesn't know the
        // defId or buildPic is empty, fall back to a guess via the def's
        // name — but that needs DefCache, which lives in the worker, so for
        // now we emit a likely-404 URL and let the magenta placeholder show.
        if (normalised.startsWith('#') && this.buildPicResolver && this.gameBaseUrl) {
            const id = parseInt(normalised.substring(1), 10);
            if (Number.isFinite(id)) {
                const pic = this.buildPicResolver(id);
                if (pic) return `${this.gameBaseUrl}/unitpics/${pic}`;
            }
        }
        // If the path has a directory component, use standard resolution
        if (normalised.includes('/')) {
            const lower = normalised.toLowerCase();
            const isGameAsset =
                lower.startsWith('luaui/') ||
                lower.startsWith('luarules/') ||
                lower.startsWith('luagaia/') ||
                lower.startsWith('anims/') ||
                lower.startsWith('bitmaps/') ||
                lower.startsWith('models/') ||
                lower.startsWith('objects3d/') ||
                lower.startsWith('sounds/') ||
                lower.startsWith('unittextures/');
            const baseUrl = isGameAsset ? this.gameBaseUrl : this.mapSourceUrl;
            return `${baseUrl}/${normalised}`;
        }
        // Short name (no directory) — try search paths against game URL
        // This handles skin textures like "tech_overlaywindow.png"
        if (this.textureSearchPaths.length > 0 && this.gameBaseUrl) {
            // Use the first search path (usually the active skin directory)
            return `${this.gameBaseUrl}/${this.textureSearchPaths[0]}${normalised}`;
        }
        // Fallback to game base URL
        return `${this.gameBaseUrl}/${normalised}`;
    }

    private async loadImageInto(url: string, handle: LuaTextureHandle, fallbackUrls?: string[]): Promise<void> {
        try {
            let res = await fetch(url);
            if (!res.ok && fallbackUrls) {
                for (const fb of fallbackUrls) {
                    res = await fetch(fb);
                    if (res.ok) break;
                }
            }
            if (!res.ok) {
                console.warn(`[gl.CreateTexture] ${url}: ${res.status}`);
                return;
            }
            // .dds → upload compressed blocks directly via S3TC, no
            // browser-side decode (createImageBitmap rejects DDS).
            if (/\.dds(\?|$)/i.test(url)) {
                const buf = await res.arrayBuffer();
                if (this.uploadDDS(buf, handle)) {
                    console.log(`[gl.CreateTexture] loaded DDS ${url} (${handle.width}x${handle.height})`);
                }
                return;
            }
            const blob = await res.blob();
            const bitmap = await createImageBitmap(blob);
            const gl = this.gl;
            gl.bindTexture(gl.TEXTURE_2D, handle.tex);
            gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, bitmap.width, bitmap.height,
                0, gl.RGBA, gl.UNSIGNED_BYTE, bitmap);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.REPEAT);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.REPEAT);
            gl.generateMipmap(gl.TEXTURE_2D);
            handle.width = bitmap.width;
            handle.height = bitmap.height;
            console.log(`[gl.CreateTexture] loaded ${url} (${bitmap.width}x${bitmap.height})`);
        } catch (e) {
            console.warn(`[gl.CreateTexture] ${url}: ${e}`);
        }
    }

    /**
     * Parse a DDS header and upload the compressed mip chain directly
     * via WEBGL_compressed_texture_s3tc. Supports DXT1/DXT3/DXT5 — the
     * formats Spring's own gameplay assets ship as. Returns true on
     * success.
     *
     * The header layout is the standard 124-byte DDS_HEADER following
     * the 4-byte 'DDS ' magic, with the 32-byte DDS_PIXELFORMAT block
     * starting at offset 76. We only look at width/height/mipmapCount
     * and the FourCC to pick the WebGL format constant.
     */
    private uploadDDS(buffer: ArrayBuffer, handle: LuaTextureHandle): boolean {
        const view = new DataView(buffer);
        if (buffer.byteLength < 128 || view.getUint32(0, true) !== 0x20534444 /* 'DDS ' */) {
            console.warn('[gl.CreateTexture] DDS: bad magic');
            return false;
        }
        const height = view.getUint32(12, true);
        const width  = view.getUint32(16, true);
        // dwMipMapCount is only valid when DDSD_MIPMAPCOUNT bit is set
        // in dwFlags; for non-mipmapped textures it can be 0 or 1.
        const mipCount = Math.max(1, view.getUint32(28, true));
        const fourCC   = view.getUint32(84, true);

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const ext = this.gl.getExtension('WEBGL_compressed_texture_s3tc') as any;
        if (!ext) {
            console.warn('[gl.CreateTexture] WEBGL_compressed_texture_s3tc not available');
            return false;
        }
        let format: number;
        let blockBytes: number;
        if (fourCC === 0x31545844 /* 'DXT1' */) {
            format = ext.COMPRESSED_RGB_S3TC_DXT1_EXT;
            blockBytes = 8;
        } else if (fourCC === 0x33545844 /* 'DXT3' */) {
            format = ext.COMPRESSED_RGBA_S3TC_DXT3_EXT;
            blockBytes = 16;
        } else if (fourCC === 0x35545844 /* 'DXT5' */) {
            format = ext.COMPRESSED_RGBA_S3TC_DXT5_EXT;
            blockBytes = 16;
        } else {
            const tag = String.fromCharCode(fourCC & 0xff, (fourCC >> 8) & 0xff, (fourCC >> 16) & 0xff, (fourCC >> 24) & 0xff);
            console.warn(`[gl.CreateTexture] DDS: unsupported FourCC '${tag}' (${fourCC.toString(16)})`);
            return false;
        }

        const gl = this.gl;
        gl.bindTexture(gl.TEXTURE_2D, handle.tex);
        let offset = 128;
        let w = width, h = height;
        let uploadedLevels = 0;
        for (let level = 0; level < mipCount; level++) {
            // Compressed block layout: blocks of 4×4 texels. Always at
            // least one block per dimension even when w/h drops below 4.
            const blocksW = Math.max(1, Math.ceil(w / 4));
            const blocksH = Math.max(1, Math.ceil(h / 4));
            const size = blocksW * blocksH * blockBytes;
            if (offset + size > buffer.byteLength) break;
            gl.compressedTexImage2D(gl.TEXTURE_2D, level, format, w, h, 0,
                new Uint8Array(buffer, offset, size));
            offset += size;
            uploadedLevels++;
            w = Math.max(1, w >> 1);
            h = Math.max(1, h >> 1);
        }

        // Min-filter must match the mip count we actually uploaded.
        const minFilter = uploadedLevels > 1 ? gl.LINEAR_MIPMAP_LINEAR : gl.LINEAR;
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, minFilter);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
        // If the file shipped only base level, telling WebGL the chain
        // ends at level 0 keeps sampling valid without forcing us to
        // synthesize mips for compressed data (which gl.generateMipmap
        // can't do for S3TC).
        if (uploadedLevels === 1) {
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_BASE_LEVEL, 0);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAX_LEVEL, 0);
        }
        handle.width = width;
        handle.height = height;
        return true;
    }

    private deleteTexture(handle: LuaValue): void {
        if (!handle || typeof handle !== 'object' || Array.isArray(handle)) return;
        const h = handle as unknown as LuaTextureHandle;
        if (h.__type !== 'texture') return;
        this.gl.deleteTexture(h.tex);
    }

    /**
     * gl.Texture(unit, handle_or_path_or_false).
     *
     * - false → unbind the unit
     * - string starting with `$` → engine texture (heightmap/shadow/info)
     * - string path → fetch + bind
     * - handle → bind that texture
     */
    private bindTexture(unitV: LuaValue, handleOrPath: LuaValue): void {
        const gl = this.gl;
        // Spring's gl.Texture has two forms:
        //   gl.Texture(path)         → bind to unit 0
        //   gl.Texture(unit, path)   → bind to specified unit
        //   gl.Texture(false)        → unbind unit 0
        let unit: number;
        if (handleOrPath === undefined || handleOrPath === null) {
            // Single-arg form: unitV is actually the path/handle/false
            handleOrPath = unitV;
            unit = 0;
        } else {
            unit = Number(unitV);
            if (!Number.isFinite(unit) || unit < 0 || unit > 7) return;
        }
        gl.activeTexture(gl.TEXTURE0 + unit);
        if (handleOrPath === false || handleOrPath === null || handleOrPath === undefined) {
            gl.bindTexture(gl.TEXTURE_2D, null);
            if (unit === 0) {
                this.hasTextureUnit0 = false;
                this.boundTextureUnit0 = null;
            }
            if (this.imm.isRecording()) {
                this.imm.recordTextureBind(unit, null);
            }
            return;
        }
        const trackAndRecord = (tex: WebGLTexture | null) => {
            if (unit === 0) {
                this.hasTextureUnit0 = tex !== null;
                this.boundTextureUnit0 = tex;
            }
            if (this.imm.isRecording()) {
                this.imm.recordTextureBind(unit, tex);
            }
        };

        if (typeof handleOrPath === 'string') {
            const s = handleOrPath;
            if (s.startsWith('$')) {
                let tex: WebGLTexture | null = null;
                if (s === '$heightmap') tex = this.engineTex.heightmap ?? this.whiteTex;
                else if (s === '$shadow') tex = this.engineTex.shadow ?? this.whiteTex;
                else if (s === '$info') tex = this.engineTex.info ?? this.blackTex;
                gl.bindTexture(gl.TEXTURE_2D, tex);
                trackAndRecord(tex);
                return;
            }
            const normalised = this.normaliseTexturePath(s);
            let handle = this.textureCache.get(normalised);
            if (!handle) {
                handle = markOpaque({
                    __type: 'texture' as const,
                    tex: this.createSolidTexture(255, 0, 255, 255),
                    width: 1, height: 1,
                });
                this.textureCache.set(normalised, handle);
                const primaryUrl = this.resolveTextureUrl(normalised);
                const fallbacks = this.buildFallbackUrls(normalised, primaryUrl);
                void this.loadImageInto(primaryUrl, handle, fallbacks.length > 0 ? fallbacks : undefined);
            }
            gl.bindTexture(gl.TEXTURE_2D, handle.tex);
            trackAndRecord(handle.tex);
            return;
        }
        if (typeof handleOrPath === 'object' && handleOrPath !== null) {
            const h = handleOrPath as unknown as LuaTextureHandle;
            if (h.__type === 'texture') {
                gl.bindTexture(gl.TEXTURE_2D, h.tex);
                trackAndRecord(h.tex);
            }
        }
    }

    // ============================================================
    // FBOs
    // ============================================================

    private createFBO(opts: LuaValue): LuaFBOHandle | Record<string, LuaValue> | null {
        // Spring's gl.CreateFBO accepts an optional opts table. If called
        // with no args, it returns an empty FBO that the caller mutates by
        // setting .color0, .depth, etc. Return a plain Lua-mutable table
        // (NOT markOpaque'd — userdata can't have fields assigned) so
        // widgets like Chili Minimap (which does `fbo = gl.CreateFBO();
        // fbo.color0 = ...`) work. The table has __type='fbo_deferred'
        // so activeFBO can detect it and bind attachments dynamically.
        if (!opts || typeof opts !== 'object' || Array.isArray(opts)) {
            return { __type: 'fbo_deferred', _native: null };
        }
        const rec = opts as Record<string, LuaValue>;
        const gl = this.gl;
        const fbo = gl.createFramebuffer()!;
        gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
        const attachments: LuaTextureHandle[] = [];
        // Color attachments (textures)
        for (let i = 0; i < 4; i++) {
            const key = `color${i}`;
            const t = rec[key];
            if (t && typeof t === 'object' && !Array.isArray(t)) {
                const th = t as unknown as LuaTextureHandle;
                if (th.__type === 'texture') {
                    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0 + i,
                        gl.TEXTURE_2D, th.tex, 0);
                    attachments.push(th);
                }
            }
        }
        // Depth/stencil RBO attachment (Chili uses DEPTH24_STENCIL8)
        const depthRbo = rec['depth'];
        if (typeof depthRbo === 'number') {
            const rbo = this.rboHandles.get(depthRbo);
            if (rbo) {
                gl.framebufferRenderbuffer(gl.FRAMEBUFFER,
                    gl.DEPTH_STENCIL_ATTACHMENT, gl.RENDERBUFFER, rbo);
            }
        }
        const stencilRbo = rec['stencil'];
        if (typeof stencilRbo === 'number') {
            const rbo = this.rboHandles.get(stencilRbo);
            if (rbo) {
                gl.framebufferRenderbuffer(gl.FRAMEBUFFER,
                    gl.STENCIL_ATTACHMENT, gl.RENDERBUFFER, rbo);
            }
        }
        const status = gl.checkFramebufferStatus(gl.FRAMEBUFFER);
        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
        if (status !== gl.FRAMEBUFFER_COMPLETE) {
            console.warn(`[gl.CreateFBO] incomplete: 0x${status.toString(16)}`);
            gl.deleteFramebuffer(fbo);
            return null;
        }
        return markOpaque({ __type: 'fbo' as const, fbo, colorAttachments: attachments });
    }

    /**
     * gl.ActiveFBO(fbo, callback) — bind the FBO and execute the callback.
     * The immediate-mode renderer and all gl.* state functions draw into
     * the bound framebuffer. When the callback returns, the previous
     * framebuffer is restored.
     */
    private activeFBO(fboV: LuaValue, callbackV: LuaValue): void {
        if (!fboV || typeof fboV !== 'object' || Array.isArray(fboV)) return;
        if (typeof callbackV !== 'function') return;
        const fboRec = fboV as Record<string, LuaValue>;
        // Deferred FBOs (created with no args via no-arg gl.CreateFBO) act
        // as a no-op binding: just run the callback with the default
        // framebuffer current. Chili Minimap uses one for offscreen
        // postprocessing — without our offscreen buffer the minimap
        // simply draws to the main canvas, which is fine for now.
        if (fboRec['__type'] === 'fbo_deferred') {
            try {
                (callbackV as (...a: LuaValue[]) => LuaValue | undefined)();
            } catch (e) {
                console.warn('[gl.ActiveFBO deferred] callback threw:', e);
            }
            return;
        }
        const fbo = fboV as unknown as LuaFBOHandle;
        if (fbo.__type !== 'fbo' || fbo.colorAttachments.length === 0) return;

        const gl = this.gl;
        const savedFBO = gl.getParameter(gl.FRAMEBUFFER_BINDING) as WebGLFramebuffer | null;
        const target = fbo.colorAttachments[0];
        const savedViewport = gl.getParameter(gl.VIEWPORT) as Int32Array;

        gl.bindFramebuffer(gl.FRAMEBUFFER, fbo.fbo);
        gl.viewport(0, 0, target.width, target.height);

        try {
            (callbackV as (...a: LuaValue[]) => LuaValue | undefined)();
        } catch (e) {
            console.warn('[gl.ActiveFBO] callback threw:', e);
        }

        gl.bindFramebuffer(gl.FRAMEBUFFER, savedFBO);
        gl.viewport(savedViewport[0], savedViewport[1],
            savedViewport[2], savedViewport[3]);
    }

    private deleteFBO(handle: LuaValue): void {
        if (!handle || typeof handle !== 'object' || Array.isArray(handle)) return;
        const h = handle as unknown as LuaFBOHandle;
        if (h.__type !== 'fbo') return;
        this.gl.deleteFramebuffer(h.fbo);
    }

    // ============================================================
    // VAO
    // ============================================================

    /**
     * gl.GetVAO returns a VAO wrapper. The lava_layer widget uses this to
     * draw an instanced empty quad — the shader generates positions from
     * gl_VertexID and gl_InstanceID with no vertex attributes required.
     *
     * In strict WebGL2 a drawArraysInstanced call with zero enabled
     * attributes is permitted but some drivers silently drop the draw.
     * We bind a tiny dummy buffer to attribute 0 so at least one stream
     * is active — the shader never reads it (it uses gl_VertexID) but
     * the presence of an enabled attribute satisfies the validator.
     *
     * Returned as a plain (non-opaque) table so the widget can invoke
     * methods via `VAO:DrawArrays(...)` — the `:` sugar passes the table
     * as the first argument, which our closures ignore.
     */
    private getVAO(): LuaVAOHandle {
        const gl = this.gl;
        const vao = gl.createVertexArray()!;
        gl.bindVertexArray(vao);
        const dummy = gl.createBuffer()!;
        gl.bindBuffer(gl.ARRAY_BUFFER, dummy);
        gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(4), gl.STATIC_DRAW);
        gl.enableVertexAttribArray(0);
        gl.vertexAttribPointer(0, 1, gl.FLOAT, false, 0, 0);
        gl.bindVertexArray(null);
        gl.bindBuffer(gl.ARRAY_BUFFER, null);

        // GL4 attach methods (AttachVertexBuffer / AttachInstanceBuffer /
        // AttachIndexBuffer) are no-ops here — we don't model real VBO
        // bindings, but ZK's instancevbotable.lua wires these on every VAO it
        // creates. Without the stubs the widget set fails to load with
        // "attempt to call a nil value (method 'AttachVertexBuffer')".
        const noopAttach = (..._args: LuaValue[]): LuaValue => null;
        return {
            __type: 'vao' as const,
            DrawArrays: (_self, mode, count, first, instanceCount) => {
                const m = Number(mode);
                const c = Number(count);
                const f = Number(first);
                const ic = Math.max(1, Number(instanceCount ?? 1));
                gl.bindVertexArray(vao);
                gl.drawArraysInstanced(m, f, c, ic);
                gl.bindVertexArray(null);
            },
            DrawElements: noopAttach,
            AttachVertexBuffer: noopAttach,
            AttachInstanceBuffer: noopAttach,
            AttachIndexBuffer: noopAttach,
            ClearAttachedBuffers: noopAttach,
            Delete: (_self) => {
                gl.deleteVertexArray(vao);
                gl.deleteBuffer(dummy);
            },
        };
    }

    // ============================================================
    // Fixed-function state
    // ============================================================

    private blending(a: LuaValue, b: LuaValue): void {
        const gl = this.gl;
        if (a === false) {
            gl.disable(gl.BLEND);
            return;
        }
        if (a === true) {
            gl.enable(gl.BLEND);
            gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
            return;
        }
        if (typeof a === 'string') {
            // Spring's named modes — "reset" = additive/default off
            gl.enable(gl.BLEND);
            if (a === 'reset') gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
            else if (a === 'add') gl.blendFunc(gl.SRC_ALPHA, gl.ONE);
            else if (a === 'alpha') gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
            else if (a === 'disable') gl.disable(gl.BLEND);
            return;
        }
        if (typeof a === 'number' && typeof b === 'number') {
            gl.enable(gl.BLEND);
            gl.blendFunc(a, b);
        }
    }

    private depthTest(v: LuaValue): void {
        const gl = this.gl;
        if (v === true || v === 1) gl.enable(gl.DEPTH_TEST);
        else if (v === false || v === 0) gl.disable(gl.DEPTH_TEST);
    }

    private depthMask(v: LuaValue): void {
        const gl = this.gl;
        gl.depthMask(v === true || v === 1);
    }

    /** Called by the host each frame to refresh the camera matrices. */
    setCameraMatrices(view: Float32Array, projection: Float32Array): void {
        this.viewMatrix = view;
        this.projectionMatrix = projection;
    }

    /** Called when the engine heightmap texture is ready. */
    setEngineHeightmap(tex: WebGLTexture): void {
        this.engineTex.heightmap = tex;
    }
}

function clamp01(n: number): number {
    if (!Number.isFinite(n)) return 0;
    if (n < 0) return 0;
    if (n > 1) return 1;
    return n;
}
