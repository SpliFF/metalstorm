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
import {
    translateAndInclude,
    hashSource,
    type GlslDiagnostic,
} from './glsl-translator.js';
import {
    defaultMapAtmosphere,
    mergeAtmosphere,
    type MapAtmosphere,
} from './map-lighting.js';

/** The engine light direction returned by `gl.GetAtmosphere("pos")` / the
 *  no-arg form (Recoil: `sky->GetLight()->GetLightDir()`). No BAR or ZK widget
 *  reads it (verified), so this stays a fixed engine default — matching
 *  `gl.GetSun("dir")` below — rather than the per-map sun direction, which
 *  flows to the renderer through scene-lighting, not this read seam. */
const ATMOSPHERE_LIGHT_DIR: readonly [number, number, number] = [0.5, -0.7, 0.5];

/**
 * Resolve a single `gl.GetAtmosphere(param)` query against the bridge's
 * atmosphere store. Pure (testable without a GL context). Mirrors Recoil
 * `LuaOpenGL::GetAtmosphere` (rts/Lua/LuaOpenGL.cpp): the no-arg / `"pos"` forms
 * return the 3-component light direction; `fogStart`/`fogEnd` return one number;
 * the colours / `skyAxisAngle` return their float3/float4 components. An
 * unrecognised param returns `undefined` (Recoil's `monostate` pushes nothing).
 *
 * A returned array is spread into multiple Lua return values by the runtime
 * marshaller, so `{ gl.GetAtmosphere("fogColor") }` yields `{r,g,b,a}` and
 * `gl.GetAtmosphere("fogEnd") <= gl.GetAtmosphere("fogStart")` compares numbers.
 */
export function atmosphereReturn(
    atmo: MapAtmosphere,
    lightDir: readonly [number, number, number],
    param?: string | null,
): number | number[] | undefined {
    if (param == null || param === '') return [...lightDir];
    switch (param) {
        case 'pos':          return [...lightDir];
        case 'fogStart':     return atmo.fogStart;
        case 'fogEnd':       return atmo.fogEnd;
        case 'fogColor':     return [...atmo.fogColor];
        case 'skyColor':     return [...atmo.skyColor];
        case 'sunColor':     return [...atmo.sunColor];
        case 'cloudColor':   return [...atmo.cloudColor];
        case 'skyAxisAngle': return [...atmo.skyAxisAngle];
        default:             return undefined;
    }
}

/**
 * Generate the world-space vertices of a terrain-following ground circle for
 * `gl.DrawGroundCircle`. Returns a flat `[x,y,z, x,y,z, …]` array of `divs`
 * points evenly spaced around a circle of radius `r` centred on (px, pz). Each
 * Y is sampled from `sample(x,z)` (real terrain height) so the ring hugs the
 * ground; when no sampler is wired the circle is drawn flat at `py`.
 *
 * Faithful to Recoil's glSurfaceCircle: angle `i/divs · 2π`, x = px + r·sin,
 * z = pz + r·cos. Extracted as a pure function so the geometry is unit-testable
 * without a WebGL2 context. `divs` is clamped to ≥3 by the caller.
 */
export function groundCircleVertices(
    px: number, py: number, pz: number, r: number, divs: number,
    sample: ((x: number, z: number) => number) | null,
): number[] {
    const out: number[] = [];
    for (let i = 0; i < divs; i++) {
        const a = (i / divs) * Math.PI * 2;
        const x = px + Math.sin(a) * r;
        const z = pz + Math.cos(a) * r;
        out.push(x, sample ? sample(x, z) : py, z);
    }
    return out;
}

/**
 * Synthesize a stable integer location id for gl.GetUniformLocation (WebGL2
 * exposes only opaque WebGLUniformLocation, but Recoil's API hands Lua a GLint
 * the widget caches and feeds back to gl.Uniform*). Dedupes repeat lookups per
 * shader via `locIds`, appends new opaque locations to the global `registry`
 * (index = id), and mirrors GL's -1 for an unknown/inactive uniform without
 * burning a slot. Pure (generic over the opaque location type) so it's
 * unit-testable without a GL context.
 */
export function internUniformLocation<T>(
    locIds: Map<string, number>,
    registry: (T | null)[],
    name: string,
    resolve: () => T | null,
): number {
    const cached = locIds.get(name);
    if (cached !== undefined) return cached;
    const loc = resolve();
    if (!loc) { locIds.set(name, -1); return -1; }
    const id = registry.length;
    registry.push(loc);
    locIds.set(name, id);
    return id;
}

/** Look up an opaque location previously interned by {@link internUniformLocation}
 *  by its integer id. Out-of-range / negative ids → null. */
export function resolveRegisteredLocation<T>(
    registry: (T | null)[], id: number,
): T | null {
    return (id >= 0 && id < registry.length) ? registry[id] : null;
}

/**
 * Normalise a Spring texture path: strip a leading texture-spec modifier
 * group and normalise slashes. Recoil (`CNamedTextures`, NamedTextures.cpp)
 * treats a leading ':' as the start of a flag group and reads chars until
 * the NEXT ':' — filter flags (`n`/`l`/`a`/`i`/`g`/`c`/`b`/`m`), tint
 * (`t<r>,<g>,<b>`) and resize (`r<w>,<h>`) — e.g. `:l:`, `:n:`,
 * `:lr104,104:` (BAR's top-bar metal/energy icons: load + resize to NxN).
 * The flags only affect filtering/sizing, never which file loads, so we drop
 * the whole group to recover the asset path.
 *
 * (Previously this capped the closing ':' at index < 8, which silently
 * failed for `:lr104,104:` — the unstripped `:lr104,104:LuaUI/Images/...`
 * then failed the `luaui/` game-asset test in resolveTextureUrl, mis-resolved
 * against the MAP base, and 404'd → magenta placeholder icons in the HUD.)
 */
export function normaliseTexturePath(path: string): string {
    let p = path;
    if (p.startsWith(':')) {
        const end = p.indexOf(':', 1);
        if (end > 0) p = p.substring(end + 1);
    }
    p = p.replace(/\\/g, '/');
    if (p.startsWith('/')) p = p.substring(1);
    return p;
}

/**
 * Does a normalised (modifier-stripped, lowercased) directory-qualified
 * texture path point at a GAME asset (vs. a map asset)? Game widgets ship
 * their art under these roots; everything else resolves against the map
 * source dir. The path MUST already be modifier-stripped (see
 * normaliseTexturePath) or a leading `:flags:` defeats the prefix test.
 */
export function isGameAssetPath(lowerNormalised: string): boolean {
    return (
        lowerNormalised.startsWith('luaui/') ||
        lowerNormalised.startsWith('luarules/') ||
        lowerNormalised.startsWith('luagaia/') ||
        lowerNormalised.startsWith('anims/') ||
        lowerNormalised.startsWith('bitmaps/') ||
        lowerNormalised.startsWith('icons/') ||
        lowerNormalised.startsWith('models/') ||
        lowerNormalised.startsWith('objects3d/') ||
        lowerNormalised.startsWith('sounds/') ||
        lowerNormalised.startsWith('unittextures/')
    );
}

/** Handle returned by gl.CreateShader — opaque to Lua. */
export interface LuaShaderHandle {
    __type: 'shader';
    program: WebGLProgram;
    uniforms: Map<string, WebGLUniformLocation>;
    /** Key into LuaGLBridge.programRegistry. Identical translated source
     *  collapses onto a single program; the key lets deleteShader
     *  refcount-decrement the right entry. Unset for ad-hoc handles that
     *  weren't registered. */
    programKey?: string;
    /** Uniform-name → integer location id handed out by gl.GetUniformLocation.
     *  WebGL2 has no integer uniform locations (only opaque
     *  WebGLUniformLocation), so the bridge synthesizes stable ids that index
     *  LuaGLBridge.uniformLocations; this dedupes repeat lookups per shader. */
    locIds?: Map<string, number>;
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
    /** Bumped each time an async CreateTexture load resolves (image or DDS).
     * Chili records skin 9-slice UVs from gl.TextureInfo, which reports the
     * 1×1 placeholder until the real texture arrives; a cached `_own_dlist`
     * bakes those stale UVs. The LuaUI host polls this counter and re-records
     * dlists whenever it advances, so late-loading skins self-heal without a
     * one-shot timer (PLAN-perf N2, bug #2). */
    private textureLoadGeneration = 0;
    /** 1x1 fallback textures. */
    private whiteTex: WebGLTexture | null = null;
    private blackTex: WebGLTexture | null = null;
    /**
     * C2 (drift #8): 1×1 DEPTH_COMPONENT stub with TEXTURE_COMPARE_MODE =
     * COMPARE_REF_TO_TEXTURE, depth 1.0. Authored shaders sample `$shadow`
     * as a `sampler2DShadow` (e.g. map_lava's `textureProj(shadowTex, …)`);
     * a depth-compare sampler bound to a colour texture without compare mode
     * is an INVALID_OPERATION at draw. The far-depth (1.0) value makes the
     * compare resolve to "fully lit" (coefficient 1.0 = no shadow) — a valid,
     * defined no-op rather than a crash. FIDELITY-STANDIN: this is NOT the
     * real engine shadow map (our shadows go through the CSM sampler2DArray
     * in zk-model-material; a single Spring `$shadow` map isn't rendered),
     * so authored-shader shadows are absent, not wrong. Warned once below.
     */
    private shadowStubTex: WebGLTexture | null = null;
    private warnedShadowStub = false;
    /** Immediate-mode renderer for gl.BeginEnd / gl.Rect / gl.TexRect etc. */
    private imm: ImmediateModeRenderer;
    /** Tracks the currently bound texture on unit 0 for immediate-mode textured flag. */
    private boundTextureUnit0: WebGLTexture | null = null;
    /** Tracks whether a texture is bound on unit 0 (for immediate-mode draw). */
    private hasTextureUnit0 = false;
    /** RBO handles for gl.CreateRBO / gl.DeleteRBO. */
    private rboHandles = new Map<number, WebGLRenderbuffer>();
    /** Lazily-created framebuffers for gl.RenderToTexture, one per texture
     *  handle. WeakMap so they're collected when the texture handle is. */
    private rttFBOs = new WeakMap<LuaTextureHandle, WebGLFramebuffer>();
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

    /** Samples terrain height at a world (x, z). Used by `gl.DrawGroundCircle`
     *  to follow the ground (the whole point of the *Ground* variant vs a flat
     *  `gl.DrawCircle`). The bridge has no heightmap of its own — the worker
     *  owns it via the EntityRenderer — so the host wires this in. Null until
     *  set (tests / lobby preview), in which case the circle is drawn flat at
     *  the caller-supplied Y. */
    private groundSampler: ((x: number, z: number) => number) | null = null;
    /** One-time warn latch for the ballistic `gl.DrawGroundCircle` variant. */
    private warnedBallisticCircle = false;

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

    /** Wire the terrain-height sampler for `gl.DrawGroundCircle`. The worker
     *  passes a closure over its EntityRenderer heightmap. Without it the
     *  ground circle falls back to a flat ring at the caller's Y. */
    setGroundSampler(sampler: ((x: number, z: number) => number) | null): void {
        this.groundSampler = sampler;
    }

    /** The map's `atmosphere` table (fog + sky/sun/cloud colours), read by
     *  `gl.GetAtmosphere` and written by `Spring.SetAtmosphere`. Initialised to
     *  the Recoil defaults so reads always return numbers before the per-map
     *  `mapinfo.lua` load resolves (see `setAtmosphere`). */
    private atmosphere: MapAtmosphere = defaultMapAtmosphere();

    /** Replace the atmosphere store with the map's authored values. The worker
     *  host calls this once `loadMapAtmosphere(mapinfo.lua)` resolves. */
    setAtmosphere(atmo: MapAtmosphere): void {
        this.atmosphere = atmo;
    }

    /** Merge a `Spring.SetAtmosphere{…}` params table into the store so a
     *  later `gl.GetAtmosphere` reads back the set value (faithful Get/Set
     *  round-trip). Returns the unknown keys for the caller to warn about.
     *  NB: this updates the read store only — there is no fog/sky renderer
     *  path yet, so the visual effect is a documented FIDELITY-STANDIN handled
     *  by the `Spring.SetAtmosphere` wrapper in lua-ui-host. */
    setAtmosphereParams(params: Record<string, LuaValue> | null): string[] {
        const { atmosphere, unknown } = mergeAtmosphere(this.atmosphere, params);
        this.atmosphere = atmosphere;
        return unknown;
    }

    /** Resize the OffscreenCanvas owned by this bridge's GL context. */
    resizeCanvas(width: number, height: number): void {
        const canvas = this.gl.canvas as OffscreenCanvas;
        canvas.width = width;
        canvas.height = height;
        this.gl.viewport(0, 0, width, height);
    }

    /** N3: reset the immediate renderer's per-pass GL state shadow. Called once
     *  at the top of each UI pass (runFrame) — Babylon's world render leaves
     *  different program/VAO/buffer bindings between passes, so the shadow must
     *  be invalidated so the pass's first flush re-issues all state. */
    beginImmediatePass(): void {
        this.imm.beginPass();
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
        // gl.GetUniformLocation(shader, name) — Recoil returns a GLint location
        // for the named uniform (or -1). Shader-heavy widgets (103× in BAR)
        // cache it once and feed it to gl.Uniform*(loc, …) in hot loops to skip
        // the per-frame name lookup. WebGL2 has only opaque WebGLUniformLocation,
        // so the bridge synthesizes a stable integer id (see getUniformLocId).
        gl['GetUniformLocation'] = (shader: LuaValue, name: LuaValue) =>
            this.getUniformLocId(shader, name);
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

        // ── Texture atlas family (CreateTextureAtlas / AddAtlasTexture /
        //    FinalizeTextureAtlas / GetAtlasTexture / DeleteTextureAtlas) ──
        // FIDELITY-STANDIN (not a WebGL2 capability gap — atlasing is fully
        // implementable here). The reason these are no-ops is the same as
        // gl.GetVBO (C3 / drift #9): there is NO reaching consumer on the
        // default widget set. Every game user is either a `*_gl4` widget that
        // self-disables when `Platform.glHaveGL4` is nil, or the FlowUI
        // atlas-maker (`flowui_atlas_gl4.lua`) which ships `enabled = false`.
        // Building the real packing+upload path now would be a mechanism with
        // no driver, so it is deferred to the Stage-5 GL4 substitution
        // decisions. Until then we keep faithful return *shapes* (so a future
        // non-GL4 caller doesn't crash on a nil) but make the gap LOUD once —
        // no-silent-GL-failures — so such a caller surfaces instead of
        // silently getting an empty atlas. Recoil signatures: LuaOpenGL.cpp
        // CreateTextureAtlas/FinalizeTextureAtlas/GetAtlasTexture.
        const ATLAS_STANDIN_ID = '$luatex_atlas_stub';
        gl['CreateTextureAtlas'] = (_x: LuaValue, _y: LuaValue, _alloc?: LuaValue) => {
            this.warnStandin('CreateTextureAtlas',
                'texture atlasing has no reaching WebGL2 consumer (all callers ' +
                'are GL4 or enabled=false widgets); returning an inert atlas id ' +
                '(Stage-5 / GL4-substitution gated). Sub-textures resolve empty.');
            return ATLAS_STANDIN_ID; // Recoil returns a string atlas name (truthy)
        };
        // AddAtlasTexture(atlas, subName) → no return value in Recoil.
        gl['AddAtlasTexture'] = (..._args: LuaValue[]) => { /* inert */ };
        // FinalizeTextureAtlas(atlas) → boolean "was it built". Honest: false.
        gl['FinalizeTextureAtlas'] = (..._args: LuaValue[]) => false;
        // GetAtlasTexture(atlas, subName) → (x1, x2, y1, y2, pageNum). The
        // standin atlas holds nothing, so return a degenerate zero region
        // (numbers, never nil, so `local x1,x2 = gl.GetAtlasTexture(...)`
        // arithmetic stays valid).
        gl['GetAtlasTexture'] = (..._args: LuaValue[]) => [0, 0, 0, 0, 0];
        // DeleteTextureAtlas(atlas) → boolean. Accept the cleanup (Shutdown
        // calls this on the inert id).
        gl['DeleteTextureAtlas'] = (..._args: LuaValue[]) => true;

        // ── FBO / RBO ───────────────────────────────────────────────
        gl['CreateFBO'] = (opts: LuaValue) => this.createFBO(opts);
        gl['ActiveFBO'] = (fbo: LuaValue, callback: LuaValue) => this.activeFBO(fbo, callback);
        gl['DeleteFBO'] = (h: LuaValue) => this.deleteFBO(h);
        gl['IsValidFBO'] = (h: LuaValue) => this.isValidFBO(h);
        // gl.RenderToTexture(tex, fn, ...args) — bind `tex` as an FBO colour
        // attachment, run `fn(...args)` with identity proj/modelview, restore.
        // LUPS gates `canRTT` on this existing; Groundflash + distortionFBO
        // both refuse to load without it.
        gl['RenderToTexture'] = (tex: LuaValue, fn: LuaValue, ...args: LuaValue[]) =>
            this.renderToTexture(tex, fn, args);
        // gl.CopyToTexture(tex, xoff, yoff, x, y, w, h [, target, level]) —
        // copyTexSubImage2D from the current framebuffer into `tex`.
        gl['CopyToTexture'] = (...a: LuaValue[]) => this.copyToTexture(a);
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
        // Recoil gl.Culling(bool) toggles GL_CULL_FACE; gl.Culling(mode)
        // enables it and sets the cull face (GL_FRONT/GL_BACK).
        gl['Culling'] = (arg: LuaValue) => this.culling(arg);
        // Recoil gl.PolygonOffset(bool) | (factor, units). WebGL2 has only
        // POLYGON_OFFSET_FILL (no LINE/POINT variants — desktop-GL only).
        gl['PolygonOffset'] = (a: LuaValue, b?: LuaValue) => this.polygonOffset(a, b);
        // Recoil gl.BlendEquation(mode) / BlendEquationSeparate(rgb, a).
        gl['BlendEquation'] = (mode: LuaValue) => this.gl.blendEquation(Number(mode));
        gl['BlendEquationSeparate'] = (rgb: LuaValue, a: LuaValue) =>
            this.gl.blendEquationSeparate(Number(rgb), Number(a));
        // Recoil gl.Viewport(x, y, w, h). Safe: gpRunUiPass saves/restores
        // the viewport around the UI pass so a widget can't leak it into the
        // world render.
        gl['Viewport'] = (x: LuaValue, y: LuaValue, w: LuaValue, h: LuaValue) =>
            this.gl.viewport(Number(x), Number(y), Math.max(0, Number(w)), Math.max(0, Number(h)));
        // Recoil gl.PointSize(size) → glPointSize. WebGL2 has no glPointSize
        // (point size is set via gl_PointSize in the vertex shader), and the
        // bridge's immediate-mode renderer draws no GL_POINTS, so this is a
        // documented no-op. FIDELITY-STANDIN.
        gl['PointSize'] = (_size: LuaValue) => {
            if (!this.warnedPointSize) {
                this.warnedPointSize = true;
                console.warn('[gl.PointSize] FIDELITY-STANDIN: no WebGL2 glPointSize; ' +
                    'no-op (point sizing needs gl_PointSize in a shader).');
            }
        };
        // WebGL2-unsupported fixed-function state. These all existed in
        // Recoil's GL2/3 path but have no core WebGL2 equivalent, so they are
        // documented no-op standins (vs. silently vanishing into the worker's
        // gl-fallback metatable). The visible cost is small: stippled lines
        // render solid, user clip planes don't cull, depth isn't clamped.
        // gl.LineStipple(factor, pattern) | (false) | ("") — 12× in BAR.
        // Faithful emulation would need a screen-space-distance fragment
        // discard in the immediate-mode line shader (revisit if dashed
        // overlays read wrong).
        gl['LineStipple'] = (..._args: LuaValue[]) =>
            this.warnStandin('LineStipple',
                'no WebGL2 line stipple; lines draw solid (shader emulation TODO).');
        // gl.ClipDistance(index, enable) — WebGL2 has no gl_ClipDistance.
        gl['ClipDistance'] = (..._args: LuaValue[]) =>
            this.warnStandin('ClipDistance', 'no WebGL2 clip distances; no-op.');
        // gl.DepthClamp(enable) — no GL_DEPTH_CLAMP in WebGL2.
        gl['DepthClamp'] = (_enable: LuaValue) =>
            this.warnStandin('DepthClamp', 'no WebGL2 GL_DEPTH_CLAMP; no-op.');
        // gl.ClipPlane(id, ...) — legacy fixed-function user clip planes,
        // removed in GL3+/WebGL2.
        gl['ClipPlane'] = (..._args: LuaValue[]) =>
            this.warnStandin('ClipPlane', 'no WebGL2 fixed-function clip planes; no-op.');
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
        // Monotonic counter of resolved async texture loads. The LuaUI host
        // polls this to invalidate Chili display lists that baked 1×1
        // placeholder UVs before their skin texture arrived (PLAN-perf N2).
        gl['_textureLoadGeneration'] = () =>
            this.textureLoadGeneration as unknown as LuaValue;
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
        // gl.DrawGroundCircle(px, py, pz, radius, resolution[, slope, gravity,
        // weaponDefID]) — a terrain-following ring, drawn world-space in the
        // current raster colour. Used by range-ring / area-command widgets in
        // both BAR (12×) and ZK. The basic 5-arg form is faithful (vertices
        // sample real ground height); the 8-arg ballistic form (weapon range
        // that bends with terrain slope + projectile gravity) needs weapon-def
        // ballistic data the bridge doesn't hold — see drawGroundCircle.
        gl['DrawGroundCircle'] = (...args: LuaValue[]) => this.drawGroundCircle(args);
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
        // Global gl.Text(text, x, y, size, options) — Spring's freestanding
        // text call (distinct from the font:Print handle API). Many BAR
        // widgets use it. Recoil draws it through the engine's default font
        // in the *current raster colour*; we lazily build one default font
        // object and delegate to its Print, seeding the text colour from the
        // immediate-mode current colour so gl.Color before gl.Text works.
        gl['Text'] = (text: LuaValue, x: LuaValue, y: LuaValue,
            size?: LuaValue, options?: LuaValue) => {
            const font = this.getDefaultFont();
            if (!font) return;
            const [r, g, b, a] = this.imm.getColor();
            (font['SetTextColor'] as (s: LuaValue, r: LuaValue, g: LuaValue, b: LuaValue, a: LuaValue) => void)(
                font, r, g, b, a);
            (font['Print'] as (...args: LuaValue[]) => void)(
                font, text, x, y, size ?? 12, options ?? '');
        };
        // gl.GetTextWidth(text) — freestanding metric over the default font
        // (handle variant lives on the font object). Recoil returns the
        // normalised width (multiply by font size for pixels).
        gl['GetTextWidth'] = (text: LuaValue) => {
            const font = this.getDefaultFont();
            const fn = font && (font['GetTextWidth'] as ((s: LuaValue, t: LuaValue) => LuaValue) | undefined);
            return fn ? fn(font, text) : 0;
        };

        // ── Queries ─────────────────────────────────────────────────
        gl['GetViewSizes'] = () => {
            const c = this.gl.canvas;
            return [c.width, c.height];
        };

        // gl.HasExtension(name) — Spring's desktop-GL extension probe.
        // ZK's LUPS `distortionFBO`, `ShockWave`, `Groundflash`, and a
        // handful of LuaShaders widgets read this at file-load time to
        // gate FBO/RTT/float-texture paths. WebGL2 makes most of these
        // core (NPOT, depth textures, sRGB, instanced arrays, float
        // textures), so we report the desktop-GL extension *strings*
        // ZK names as supported when their WebGL2 equivalent is core.
        //
        // Anything we don't recognise falls through to the underlying
        // `getExtension(name)` truthiness check — which catches WebGL
        // extensions like `EXT_color_buffer_float` when ZK queries by
        // their WebGL name directly.
        const KNOWN_DESKTOP_EXTENSIONS = new Set<string>([
            // NPOT support — WebGL2 always supports non-power-of-two
            // textures (no mipmap restriction for repeat wrapping).
            'GL_ARB_texture_non_power_of_two',
            // 32-bit + 16-bit float internal formats — WebGL2 ships
            // them as core (RGBA32F / RGBA16F), with rendering enabled
            // via EXT_color_buffer_float (queried separately below).
            'GL_ARB_texture_float',
            'GL_ARB_half_float_pixel',
            'GL_OES_texture_float',
            // Depth textures — core in WebGL2.
            'GL_ARB_depth_texture',
            'GL_OES_depth_texture',
            // FBOs / MRTs — core.
            'GL_ARB_framebuffer_object',
            'GL_EXT_framebuffer_object',
            'GL_EXT_framebuffer_blit',
            'GL_ARB_draw_buffers',
            // Instanced arrays — core.
            'GL_ARB_instanced_arrays',
            'GL_ARB_draw_instanced',
            // VAO / VBO — core.
            'GL_ARB_vertex_array_object',
            'GL_ARB_vertex_buffer_object',
            // GLSL — we expose ES 300 shaders, so report the families.
            'GL_ARB_shader_objects',
            'GL_ARB_vertex_shader',
            'GL_ARB_fragment_shader',
            'GL_ARB_shading_language_100',
            // sRGB framebuffer — core.
            'GL_ARB_framebuffer_sRGB',
            'GL_EXT_framebuffer_sRGB',
        ]);
        gl['HasExtension'] = (name: LuaValue) => {
            const s = String(name ?? '');
            if (KNOWN_DESKTOP_EXTENSIONS.has(s)) return true;
            // Last resort: try the underlying WebGL extension registry.
            // ZK occasionally queries the WebGL-flavoured name directly
            // (e.g. `EXT_color_buffer_float`).
            try {
                return !!this.gl.getExtension(s);
            } catch {
                return false;
            }
        };

        // gl.GetString(name) — Spring exposes the desktop-GL `glGetString`
        // for vendor / renderer / version reporting. ZK's `lups.lua` uses
        // it at load time (line 120-121) to detect Nvidia / ATI / Intel /
        // Microsoft software-renderer paths via `:lower():find(...)`. If
        // it returns nil the chained `:lower()` crashes the whole include
        // and LUPS never boots.
        //
        // WebGL2 has the equivalent constants and `getParameter(name)`
        // returns the same strings (`WebGL Vendor`, `WebGL Renderer`,
        // `OpenGL ES Version`). UNMASKED_VENDOR/RENDERER (when the
        // WEBGL_debug_renderer_info extension is available) gives the
        // underlying GPU string. We prefer the unmasked names so ZK's
        // GPU-family heuristics actually match.
        gl['GetString'] = (name: LuaValue) => {
            const n = Number(name);
            const dbg = this.gl.getExtension('WEBGL_debug_renderer_info');
            switch (n) {
                case 0x1F00 /* GL_VENDOR */:
                    return (dbg && this.gl.getParameter(dbg.UNMASKED_VENDOR_WEBGL)) ||
                        this.gl.getParameter(this.gl.VENDOR) || 'WebGL2';
                case 0x1F01 /* GL_RENDERER */:
                    return (dbg && this.gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL)) ||
                        this.gl.getParameter(this.gl.RENDERER) || 'WebGL2';
                case 0x1F02 /* GL_VERSION */:
                    return this.gl.getParameter(this.gl.VERSION) || 'WebGL 2.0';
                case 0x8B8C /* GL_SHADING_LANGUAGE_VERSION */:
                    return this.gl.getParameter(this.gl.SHADING_LANGUAGE_VERSION) || 'OpenGL ES GLSL ES 3.00';
                default:
                    return '';
            }
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

        // gl.GetAtmosphere([param]) — fog + sky/sun/cloud colours from the
        // map's `atmosphere` table (`mapinfo.lua`). No arg / "pos" return the
        // light direction. Sourced from the per-map store (setAtmosphere), so
        // BAR's gui_options reads the real fog start/end at Initialize instead
        // of crashing on `nil <= nil` (PLAN-bar UI-2). Faithful to Recoil
        // LuaOpenGL::GetAtmosphere.
        gl['GetAtmosphere'] = (param?: LuaValue) => {
            const p = param == null ? null : String(param);
            return atmosphereReturn(this.atmosphere, ATMOSPHERE_LIGHT_DIR, p);
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

        // gl.GetVBO([target]) — returns a buffer-object wrapper. C3 (drift #9).
        // FIDELITY-STANDIN: the methods are all no-ops. A full VBO + instanced
        // draw implementation has NO reaching consumer on WebGL2 — every ZK
        // GetVBO user is a GL4 widget (cus_gl4 / *_gl4 / the instancevbotable
        // modules they pull in) that self-disables before any steady-state
        // instanced draw: gfx_commander_skins bails on `not Platform.glHaveGL4`,
        // and gui_attackrange_gl4 / gfx_paralyze_effect RemoveWidget when their
        // #version 420 shaders fail to compile (post-merge finding 2). Building
        // the buffer path now would be a mechanism with no driver; it is gated
        // on the Stage-5 GL4 substitution decisions. Until then we keep the
        // truthy stub (so `if vbo then` guards pass) but make the no-op LOUD —
        // a one-time warn per the no-silent-GL-failures principle — so if a
        // non-GL4 consumer ever appears it surfaces instead of silently
        // dropping uploads.
        let warnedGetVBO = false;
        gl['GetVBO'] = (_target?: LuaValue) => {
            if (!warnedGetVBO) {
                warnedGetVBO = true;
                console.warn(
                    '[gl.GetVBO] FIDELITY-STANDIN: returning a no-op buffer stub. ' +
                    'VBO-based instancing is unimplemented (Stage C3 / gated on the ' +
                    'GL4 substitution decisions). All current ZK callers are GL4 ' +
                    'widgets that self-disable; uploads/draws via this VBO are dropped.',
                );
            }
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

    /** Faithful port of Recoil's `gl.DrawGroundCircle` (LuaOpenGL.cpp →
     *  glSurfaceCircleLua): `resolution` line segments forming a closed loop
     *  of radius `r` centred on (px, pz), each vertex lifted to the real
     *  terrain height so the ring hugs the ground. Drawn untextured in the
     *  current immediate-mode colour (Recoil reads GL_CURRENT_COLOR).
     *
     *  The 8-arg ballistic variant (px,py,pz,r,divs,slope,gravity,weaponDefID)
     *  draws a *weapon-range* ring whose radius bends with terrain slope and
     *  projectile gravity (glBallisticCircleLua). That needs the weapon def's
     *  ballistic params, which this bridge doesn't carry — FIDELITY-STANDIN:
     *  we fall back to the plain surface circle at the nominal radius and warn
     *  once, so the overlay is visibly present (not silently dropped) but its
     *  radius won't track slope. */
    private drawGroundCircle(args: LuaValue[]): void {
        const px = Number(args[0] ?? 0);
        const py = Number(args[1] ?? 0);
        const pz = Number(args[2] ?? 0);
        const r = Number(args[3] ?? 0);
        const divs = Math.max(3, Math.floor(Number(args[4] ?? 24)));

        if (args.length >= 6 && typeof args[5] === 'number' && !this.warnedBallisticCircle) {
            console.warn(
                '[gl.DrawGroundCircle] FIDELITY-STANDIN: ballistic (slope/gravity) '
                + 'variant not implemented — drawing a flat-radius surface ring '
                + 'instead (radius will not track terrain slope).',
            );
            this.warnedBallisticCircle = true;
        }

        const verts = groundCircleVertices(px, py, pz, r, divs, this.groundSampler);
        const GL_LINE_LOOP = 2;
        this.imm.setTextured(false, null);
        this.imm.beginEnd(GL_LINE_LOOP, () => {
            for (let i = 0; i < verts.length; i += 3) {
                this.imm.vertex(verts[i], verts[i + 1], verts[i + 2]);
            }
        });
    }

    private vertexGL(args: LuaValue[]): void {
        // GW4-c6-2: Spring's gl.Vertex accepts (x,y) for 2D screen drawing or
        // (x,y,z) for world-space DrawWorld geometry. z defaults to 0.
        this.imm.vertex(Number(args[0] ?? 0), Number(args[1] ?? 0), Number(args[2] ?? 0));
    }

    private texCoordGL(args: LuaValue[]): void {
        this.imm.texCoord(Number(args[0] ?? 0), Number(args[1] ?? 0));
    }

    private loadMatrix(args: LuaValue[]): void {
        // GW4-c6-2: Spring's gl.LoadMatrix(name) loads a named engine matrix into
        // the active stack. The world-space pass loads "projection"/"view" so
        // widgets draw in world space. These come straight from the Babylon
        // camera (already correct RH/scene coords) so the legacy flip is NOT
        // applied — unlike a widget-supplied 16-float matrix.
        if (typeof args[0] === 'string') {
            const name = args[0];
            let mat: Float32Array | null = null;
            if (name === 'projection') mat = this.projectionMatrix;
            else if (name === 'view' || name === 'modelview' || name === 'camera') mat = this.viewMatrix;
            if (mat) this.imm.loadMatrix(mat);
            return;
        }
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
        // Record into the active display list (if any) so a cached replay
        // reproduces Chili's client-area clipping — PLAN-perf N2. Applying it
        // live too is harmless during recording (no draw flushes there) and
        // keeps GL state coherent for any interleaved live geometry.
        if (x === false || x === null || x === undefined) {
            if (this.imm.isRecording()) this.imm.recordScissor(false);
            gl.disable(gl.SCISSOR_TEST);
            return;
        }
        const nx = Number(x), ny = Number(y), nw = Number(w), nh = Number(h);
        if (this.imm.isRecording()) this.imm.recordScissor(true, nx, ny, nw, nh);
        gl.enable(gl.SCISSOR_TEST);
        gl.scissor(nx, ny, nw, nh);
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

    private warnedPointSize = false;
    /** One-time latch for WebGL2-unsupported fixed-function gl.* standins. */
    private warnedUnsupportedGl = new Set<string>();
    private defaultFont: Record<string, LuaValue> | null = null;

    /** Emit a one-time FIDELITY-STANDIN warning for a gl.* function that has
     *  no WebGL2 equivalent and is implemented as a no-op. Keeps the worker's
     *  silent gl-fallback metatable from hiding the gap (no-silent-GL-failures
     *  principle): the function is *present* (so it doesn't fall through) but
     *  loudly announces the substitution exactly once. */
    private warnStandin(name: string, why: string): void {
        if (this.warnedUnsupportedGl.has(name)) return;
        this.warnedUnsupportedGl.add(name);
        console.warn(`[gl.${name}] FIDELITY-STANDIN: ${why}`);
    }

    /** Lazily build + cache the engine default font (FreeSansBold) used by
     *  the freestanding gl.Text / gl.GetTextWidth. Glyphs rasterise into one
     *  atlas at a base size; Print's size arg scales the quads, so a single
     *  font object serves every requested size. */
    private getDefaultFont(): Record<string, LuaValue> | null {
        if (!this.defaultFont) {
            try {
                this.defaultFont = createLuaFontObject(
                    this.gl, this.imm, 'FreeSansBold.otf', 32, 0, 0);
            } catch (e) {
                console.warn('[gl.Text] default font init failed:', e);
                return null;
            }
        }
        return this.defaultFont;
    }

    private culling(arg: LuaValue): void {
        const gl = this.gl;
        if (typeof arg === 'boolean') {
            if (arg) gl.enable(gl.CULL_FACE); else gl.disable(gl.CULL_FACE);
        } else if (typeof arg === 'number') {
            // gl.Culling(GL_FRONT|GL_BACK|GL_FRONT_AND_BACK) — enable + set face.
            gl.enable(gl.CULL_FACE);
            gl.cullFace(arg);
        }
    }

    private polygonOffset(a: LuaValue, b?: LuaValue): void {
        const gl = this.gl;
        // Two-arg form sets the factor/units; one-arg boolean toggles.
        if (b !== undefined) {
            gl.enable(gl.POLYGON_OFFSET_FILL);
            gl.polygonOffset(Number(a), Number(b));
        } else if (a) {
            gl.enable(gl.POLYGON_OFFSET_FILL);
        } else {
            gl.disable(gl.POLYGON_OFFSET_FILL);
        }
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
            // Engine-provided named textures ($info:los, $info:radar, $shadow,
            // $heightmap, …) are backed by C++ subsystems (the info-texture
            // handler, the shadow map). We don't implement the info-texture
            // subsystem, so TextureInfo can't report a real size. Returning
            // null here makes a widget that hard-depends on it (e.g.
            // gui_infolos: `gl.TextureInfo("$info:los").xsize`) crash in
            // Initialize and get removed by the handler error guard — that's
            // the intended degrade, but make the gap LOUD per the
            // no-silent-GL-failures principle rather than a bare nil.
            if (handleOrPath.startsWith('$')) {
                this.warnStandin(`TextureInfo(${handleOrPath})`,
                    'engine named texture is not backed (no info-texture ' +
                    'subsystem on WebGL2); returning nil. Widgets depending on ' +
                    'it self-remove (Stage-5 / info-texture gated).');
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

    /**
     * Include resolver for `#include "path"` directives in shader
     * source. Defaults to "no resolver" (returns undefined for every
     * lookup) so the translator's built-in `ENGINE_SNIPPETS` still
     * resolve but VFS-relative paths fail loudly. The worker host wires
     * this to its VFS once asset prefetch is complete.
     */
    private shaderIncludeResolver: (path: string) => string | undefined = () => undefined;

    /**
     * Program registry: identical translated source (vertex + fragment,
     * separated by `\0`) collapses onto a single WebGLProgram. Each
     * gl.CreateShader handle still gets its own uniforms map, so the
     * widget-level call site sees independent uniform state, but the
     * underlying GL program is shared. Refcounted so gl.DeleteShader
     * works correctly when one handle disposes.
     */
    private programRegistry = new Map<string, { program: WebGLProgram; refs: number }>();

    /**
     * Wire the `#include` resolver. Pass the worker's VFS lookup so
     * shader source can `#include "lups/shaders/ribbons.glsl"` and
     * pull from the preloaded ZK content tree. Built-in engine snippets
     * (ENGINE_SNIPPETS in glsl-translator.ts, e.g. `engine/csm.glsl`)
     * always take precedence over the VFS resolver.
     */
    setShaderIncludeResolver(fn: (path: string) => string | undefined): void {
        this.shaderIncludeResolver = fn;
    }

    // ============================================================
    // Shader management
    // ============================================================

    /**
     * Translate Spring's `#version 150 compatibility` GLSL into something
     * WebGL2 (GLSL ES 300) accepts. Implementation lives in the standalone
     * `glsl-translator.ts` module so the rewrite rules and `#include`
     * resolver can be reused by ModelMaterials / weapon-FX code paths
     * outside the Lua bridge.
     *
     * Side effects: stamps `lastShaderLog` and `expectedShaderReject` so
     * `createShader`'s log formatter can downgrade by-design rejections
     * (legacy `gl_Vertex`, `#version 400+`). Diagnostics emitted by the
     * translator are surfaced verbatim to keep their source-line refs.
     */
    private translateGLSL(src: string, stage: 'vertex' | 'fragment'): string {
        const result = translateAndInclude(src, stage, {
            lookup: this.shaderIncludeResolver,
            // Legacy GL2 shim unlocks LUPS particle classes whose vertex
            // shaders use fixed-function state (gl_ModelViewMatrix,
            // gl_TexCoord[], gl_FrontColor, etc.). Translator gates the
            // rewrite on the presence of that state so chili widgets
            // that only touch gl_Vertex still fall through to their
            // software draw path. PLAN-weapon-fx Z1.
            legacyGL2Shim: true,
        });
        if (!result.ok) {
            this.expectedShaderReject = result.expectedReject;
            this.lastShaderLog = formatShaderDiagnostics(stage, result.diagnostics);
        }
        return result.source;
    }

    private createShader(opts: LuaValue): LuaShaderHandle | null {
        if (!opts || typeof opts !== 'object' || Array.isArray(opts)) {
            this.lastShaderLog = 'CreateShader: options must be a table';
            return null;
        }
        const rec = opts as Record<string, LuaValue>;
        let vsSrc: string = typeof rec['vertex'] === 'string' ? rec['vertex'] as string : '';
        let fsSrc: string = typeof rec['fragment'] === 'string' ? rec['fragment'] as string : '';
        // Spring's gl.CreateShader treats either stage as optional —
        // missing ones default to fixed-function passthroughs. ZK LUPS
        // `distortionFBO` and `UnitPieceLight` both ship fragment-only
        // shaders that rely on this. We synthesize Spring's documented
        // passthrough so the legacy-shim translator can re-emit it as
        // valid GLSL ES 300 alongside the user's stage.
        const haveVs = vsSrc.length > 0;
        const haveFs = fsSrc.length > 0;
        if (!haveVs && !haveFs) {
            this.lastShaderLog = 'CreateShader: missing vertex/fragment source';
            return null;
        }
        if (!haveVs) {
            // Fixed-function passthrough VS: projects gl_Vertex and
            // forwards gl_MultiTexCoord0 + gl_Color through the legacy
            // varying slots the FS reads as gl_TexCoord[0] and gl_Color.
            //
            // A fragment-only shader expects the *engine's* default unit VS
            // to supply its custom varyings (`cameraDir`, `normalv`,
            // `vertexWorldPos`, …). Our passthrough can't reproduce those,
            // but every `varying` the FS reads must still have a matching
            // VS output or the program fails to link ("FRAGMENT varying X
            // does not match any VERTEX varying"). So we declare each and
            // emit a zero — the shader links and runs (degenerate where it
            // needed real per-vertex data, but these fragment-only shaders
            // are already a fallback path with no authored VS).
            vsSrc = synthesizePassthroughVS(fsSrc);
        }
        if (!haveFs) {
            // Fixed-function passthrough FS: textured + per-vertex tint.
            fsSrc = '#version 120\nuniform sampler2D tex0;\nvoid main() {\n' +
                '    gl_FragColor = texture2D(tex0, gl_TexCoord[0].st) * gl_Color;\n' +
                '}\n';
        }
        const gl = this.gl;
        // Reset state for this compile pass.
        //
        // - `expectedShaderReject` — translateGLSL sets it when it
        //   returns an `#error` sentinel for legacy attributes we
        //   deliberately don't translate.
        // - `lastShaderLog` — Spring's gl.GetShaderLog returns the log
        //   of the **most recent** CreateShader call only. ZK LUPS
        //   classes check `string.len(gl.GetShaderLog()) > 0` after a
        //   successful compile and bail if the log is non-empty
        //   (ShieldJitter pattern). Without this reset a successful
        //   compile inherits the previous failure's log, killing
        //   classes whose shaders are fine. Set immediately so any
        //   intermediate `return null` paths (missing options, etc.)
        //   still leave a coherent log.
        this.expectedShaderReject = false;
        this.lastShaderLog = '';
        const reportShaderFailure = (msg: string) => {
            if (this.expectedShaderReject) {
                console.debug('[gl.CreateShader]', msg);
            } else {
                console.warn('[gl.CreateShader]', msg);
            }
        };

        // Translate before compile so we can hash the *translated* source
        // for the program registry. ZK ships several widgets that compile
        // the same shader source from multiple call sites — sharing the
        // GL program avoids the link-time hit on every CreateShader call.
        const vsTranslated = this.translateGLSL(vsSrc, 'vertex');
        const fsTranslated = this.translateGLSL(fsSrc, 'fragment');
        const programKey = hashSource(vsTranslated + '\0' + fsTranslated);

        // Registry hit: reuse the program. The handle is still fresh
        // (independent uniforms cache, independent refcount slot) so
        // widget-level state stays isolated.
        const cached = this.programRegistry.get(programKey);
        let program: WebGLProgram;
        if (cached) {
            cached.refs++;
            program = cached.program;
        } else {
            const vs = gl.createShader(gl.VERTEX_SHADER)!;
            gl.shaderSource(vs, vsTranslated);
            gl.compileShader(vs);
            if (!gl.getShaderParameter(vs, gl.COMPILE_STATUS)) {
                this.lastShaderLog = 'VS: ' + (gl.getShaderInfoLog(vs) ?? '');
                gl.deleteShader(vs);
                reportShaderFailure(this.lastShaderLog);
                return null;
            }
            const fs = gl.createShader(gl.FRAGMENT_SHADER)!;
            gl.shaderSource(fs, fsTranslated);
            gl.compileShader(fs);
            if (!gl.getShaderParameter(fs, gl.COMPILE_STATUS)) {
                this.lastShaderLog = 'FS: ' + (gl.getShaderInfoLog(fs) ?? '');
                gl.deleteShader(vs);
                gl.deleteShader(fs);
                reportShaderFailure(this.lastShaderLog);
                return null;
            }
            const newProgram = gl.createProgram()!;
            gl.attachShader(newProgram, vs);
            gl.attachShader(newProgram, fs);
            gl.linkProgram(newProgram);
            if (!gl.getProgramParameter(newProgram, gl.LINK_STATUS)) {
                this.lastShaderLog = 'LINK: ' + (gl.getProgramInfoLog(newProgram) ?? '');
                gl.deleteProgram(newProgram);
                gl.deleteShader(vs);
                gl.deleteShader(fs);
                reportShaderFailure(this.lastShaderLog);
                return null;
            }
            gl.deleteShader(vs);
            gl.deleteShader(fs);
            program = newProgram;
            this.programRegistry.set(programKey, { program, refs: 1 });
        }

        const handle: LuaShaderHandle = markOpaque({
            __type: 'shader',
            program,
            uniforms: new Map(),
            programKey,
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
            // Revert the immediate-mode renderer to its built-in program so
            // subsequent gl.BeginEnd / gl.CallList draws use fixed-function.
            this.imm.setShaderOverride(null);
            return;
        }
        const h = handle as LuaShaderHandle;
        if (h.__type !== 'shader') return;
        this.gl.useProgram(h.program);
        this.currentShader = h;
        // Route immediate-mode geometry (gl.BeginEnd / gl.CallList) through this
        // program too — Spring applies the bound shader to immediate draws, and
        // ZK world widgets (Map Edge Extension's mirror shader, …) depend on it.
        this.imm.setShaderOverride(h.program);
    }

    private deleteShader(handle: LuaValue): void {
        if (!handle || typeof handle !== 'object' || Array.isArray(handle)) return;
        const h = handle as unknown as LuaShaderHandle;
        if (h.__type !== 'shader') return;
        if (h.programKey) {
            const entry = this.programRegistry.get(h.programKey);
            if (entry) {
                entry.refs--;
                if (entry.refs <= 0) {
                    this.gl.deleteProgram(entry.program);
                    this.programRegistry.delete(h.programKey);
                }
                return;
            }
        }
        // Untracked handle (e.g. test fixture) — delete directly.
        this.gl.deleteProgram(h.program);
    }

    private getUniformLocation(shader: LuaShaderHandle, name: string): WebGLUniformLocation | null {
        if (shader.uniforms.has(name)) return shader.uniforms.get(name) ?? null;
        const loc = this.gl.getUniformLocation(shader.program, name);
        if (loc) shader.uniforms.set(name, loc);
        return loc;
    }

    /** Global registry backing gl.GetUniformLocation. The integer location id
     *  handed to Lua indexes this array; the stored WebGLUniformLocation
     *  already encodes its program, so gl.Uniform*(loc:number, …) resolves
     *  without needing to know which shader the id came from (the widget binds
     *  the matching program via gl.UseShader before setting, exactly as GL
     *  requires). */
    private uniformLocations: (WebGLUniformLocation | null)[] = [];

    /** gl.GetUniformLocation(shader, name) → stable integer id (or -1). */
    private getUniformLocId(shaderArg: LuaValue, nameArg: LuaValue): number {
        const shader = shaderArg as LuaShaderHandle | null;
        if (!shader || shader.__type !== 'shader') return -1;
        const name = String(nameArg ?? '');
        if (!shader.locIds) shader.locIds = new Map<string, number>();
        return internUniformLocation(
            shader.locIds, this.uniformLocations, name,
            () => this.getUniformLocation(shader, name),
        );
    }

    /** Resolve a uniform first-arg that is either a name (string → look up on
     *  the active shader) or a cached location id (number → the global
     *  registry). Returns null when there's no active shader / unknown loc. */
    private resolveUniformLoc(nameOrId: LuaValue): WebGLUniformLocation | null {
        if (typeof nameOrId === 'number') {
            return resolveRegisteredLocation(this.uniformLocations, nameOrId);
        }
        if (!this.currentShader) return null;
        return this.getUniformLocation(this.currentShader, String(nameOrId));
    }

    private setUniform(name: LuaValue, args: LuaValue[]): void {
        const loc = this.resolveUniformLoc(name);
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
        const loc = this.resolveUniformLoc(name);
        if (!loc) return;
        const gl = this.gl;
        if (args.length === 1) gl.uniform1i(loc, Number(args[0]));
        else if (args.length === 2) gl.uniform2i(loc, Number(args[0]), Number(args[1]));
        else if (args.length === 3) gl.uniform3i(loc, Number(args[0]), Number(args[1]), Number(args[2]));
        else if (args.length >= 4) gl.uniform4i(loc, Number(args[0]), Number(args[1]), Number(args[2]), Number(args[3]));
    }

    /** Cached camera matrices fed into UniformMatrix("view"/"projection") and
     *  the world-space gl.LoadMatrix(name) path (GW4-c6-2). Column-major, taken
     *  straight from the Babylon camera (scene coords == server world coords,
     *  no flip — see the c6-2 coordinate analysis), so a world-space vertex at
     *  Spring (x,y,z) projects correctly when these are loaded as PROJECTION ×
     *  MODELVIEW. Refreshed each frame via setCameraMatrices (below). */
    viewMatrix: Float32Array | null = null;
    projectionMatrix: Float32Array | null = null;

    private setUniformMatrix(name: LuaValue, args: LuaValue[]): void {
        const loc = this.resolveUniformLoc(name);
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
        if (!arr) return;
        const loc = this.resolveUniformLoc(name);
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
     * C2 (drift #8): lazily build the 1×1 depth-compare stub for `$shadow`.
     * DEPTH_COMPONENT16, value 1.0 (far plane), compare mode REF_TO_TEXTURE
     * with LEQUAL — so `texture(sampler2DShadow, vec3(uv, ref))` resolves to
     * 1.0 ("fully lit") for any ref ≤ 1.0. Valid to bind to a sampler2DShadow
     * (unlike the colour whiteTex, which would raise INVALID_OPERATION at
     * draw now that the translator keeps the shadow sampler type — C1).
     */
    private getShadowStub(): WebGLTexture {
        if (this.shadowStubTex) return this.shadowStubTex;
        const gl = this.gl;
        const tex = gl.createTexture()!;
        gl.bindTexture(gl.TEXTURE_2D, tex);
        gl.texImage2D(
            gl.TEXTURE_2D, 0, gl.DEPTH_COMPONENT16, 1, 1, 0,
            gl.DEPTH_COMPONENT, gl.UNSIGNED_SHORT,
            new Uint16Array([0xffff]), // 1.0 in normalised 16-bit depth
        );
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_COMPARE_MODE, gl.COMPARE_REF_TO_TEXTURE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_COMPARE_FUNC, gl.LEQUAL);
        gl.bindTexture(gl.TEXTURE_2D, null);
        this.shadowStubTex = tex;
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
        return normaliseTexturePath(path);
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
            const baseUrl = isGameAssetPath(normalised.toLowerCase())
                ? this.gameBaseUrl : this.mapSourceUrl;
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
                    this.textureLoadGeneration++;
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
            this.textureLoadGeneration++;
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
                else if (s === '$shadow') {
                    // Prefer a real engine shadow map if one is ever wired;
                    // otherwise the compare-mode depth stub (C2). Never the
                    // colour whiteTex — that's INVALID_OPERATION against a
                    // sampler2DShadow now that C1 keeps the shadow type.
                    tex = this.engineTex.shadow ?? this.getShadowStub();
                    if (!this.engineTex.shadow && !this.warnedShadowStub) {
                        this.warnedShadowStub = true;
                        // FIDELITY-STANDIN — loud one-time gap notice per the
                        // no-silent-GL-failures principle.
                        console.warn(
                            '[gl.Texture] $shadow: no engine shadow map is wired to ' +
                            'authored shaders; binding a 1×1 compare-mode depth stub ' +
                            '(fully-lit). Shadows from these shaders are absent, not ' +
                            'wrong. Our scene shadows use the CSM sampler2DArray in ' +
                            'zk-model-material; a single Spring $shadow map is not rendered.',
                        );
                    }
                }
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

    /**
     * gl.RenderToTexture(tex, fn, ...args) — Spring renders into a texture
     * that was created with an attached FBO. Our gl.CreateTexture doesn't
     * pre-create FBOs, so we lazily create + cache one framebuffer per
     * texture handle (keyed via WeakMap) with the texture as COLOR_ATTACHMENT0.
     *
     * Mirrors LuaOpenGL::RenderToTexture: bind the FBO, set the viewport to
     * the texture size, load identity projection + modelview, run the
     * callback, then restore the previous framebuffer / viewport / matrices.
     * Extra args after the function are forwarded to it (ZK uses this:
     * `gl.RenderToTexture(sq, DrawTextureOnSquare, 0, 0, SIZE, ...)`).
     */
    private renderToTexture(texV: LuaValue, fnV: LuaValue, args: LuaValue[]): void {
        if (!texV || typeof texV !== 'object' || Array.isArray(texV)) return;
        const tex = texV as unknown as LuaTextureHandle;
        if (tex.__type !== 'texture') return;
        if (typeof fnV !== 'function') return;
        const gl = this.gl;

        let fbo = this.rttFBOs.get(tex);
        if (!fbo) {
            fbo = gl.createFramebuffer()!;
            gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
            gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0,
                gl.TEXTURE_2D, tex.tex, 0);
            const status = gl.checkFramebufferStatus(gl.FRAMEBUFFER);
            gl.bindFramebuffer(gl.FRAMEBUFFER, null);
            if (status !== gl.FRAMEBUFFER_COMPLETE) {
                console.warn(`[gl.RenderToTexture] incomplete FBO: 0x${status.toString(16)}`);
                gl.deleteFramebuffer(fbo);
                return;
            }
            this.rttFBOs.set(tex, fbo);
        }

        const savedFBO = gl.getParameter(gl.FRAMEBUFFER_BINDING) as WebGLFramebuffer | null;
        const savedViewport = gl.getParameter(gl.VIEWPORT) as Int32Array;
        const savedStack = this.imm.saveStackDepth();
        const MM_PROJECTION = 0x1701;
        const MM_MODELVIEW = 0x1700;

        gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
        gl.viewport(0, 0, tex.width, tex.height);
        // Spring loads identity proj + modelview for the duration (RTT
        // callbacks draw in NDC unless they set up their own matrices).
        this.imm.matrixMode(MM_PROJECTION);
        this.imm.loadIdentity();
        this.imm.matrixMode(MM_MODELVIEW);
        this.imm.loadIdentity();

        try {
            (fnV as (...a: LuaValue[]) => LuaValue | undefined)(...args);
        } catch (e) {
            console.warn('[gl.RenderToTexture] callback threw:', e);
        }

        this.imm.restoreStackDepth(savedStack);
        this.imm.matrixMode(MM_MODELVIEW);
        gl.bindFramebuffer(gl.FRAMEBUFFER, savedFBO);
        gl.viewport(savedViewport[0], savedViewport[1],
            savedViewport[2], savedViewport[3]);
    }

    /**
     * gl.CopyToTexture(tex, xoff, yoff, x, y, w, h [, target, level]) —
     * copyTexSubImage2D from the framebuffer currently bound as the read
     * source into `tex`. ZK's distortionFBO uses it to snapshot the screen
     * (`glCopyToTexture(screenCopyTex, 0, 0, vpx, vpy, vsx, vsy)`).
     */
    private copyToTexture(a: LuaValue[]): void {
        const texV = a[0];
        if (!texV || typeof texV !== 'object' || Array.isArray(texV)) return;
        const tex = texV as unknown as LuaTextureHandle;
        if (tex.__type !== 'texture') return;
        const gl = this.gl;
        const xoff = Number(a[1] ?? 0);
        const yoff = Number(a[2] ?? 0);
        const x = Number(a[3] ?? 0);
        const y = Number(a[4] ?? 0);
        const w = Number(a[5] ?? 0);
        const h = Number(a[6] ?? 0);
        if (w <= 0 || h <= 0) return;
        const level = Number(a[8] ?? 0);
        gl.bindTexture(gl.TEXTURE_2D, tex.tex);
        gl.copyTexSubImage2D(gl.TEXTURE_2D, level, xoff, yoff, x, y, w, h);
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
        // N3: this bound our own VAO + ARRAY_BUFFER mid-pass — tell the
        // immediate renderer so its next flush re-binds its VAO/buffer.
        this.imm.invalidateBindings();

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
                // N3: foreign VAO bound + unbound mid-pass — invalidate the
                // immediate renderer's VAO/buffer/program shadow.
                this.imm.invalidateBindings();
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

/**
 * Build a fixed-function passthrough vertex shader for a fragment-only
 * `gl.CreateShader` call. Beyond the legacy `gl_Position` / `gl_TexCoord`
 * / `gl_FrontColor` forwarding, it declares **every `varying` the FS
 * reads** and emits a zero for it, so the program links. (A varying the
 * VS outputs but the FS never reads is harmless; the failing direction is
 * an FS `in` with no VS `out`.) The legacy-shim translator rewrites
 * `varying`→`out` and lowers the fixed-function builtins to GLSL ES 300.
 */
function synthesizePassthroughVS(fsSrc: string): string {
    // Scalar/vector/matrix `varying TYPE NAME;` declarations. Array
    // varyings and `gl_*` builtins are handled by the legacy path, so a
    // simple type+name match covers the user varyings these shaders use.
    const re = /\bvarying\s+(float|vec[234]|mat[234])\s+(\w+)\s*;/g;
    const seen = new Set<string>();
    const decls: string[] = [];
    const assigns: string[] = [];
    let m: RegExpExecArray | null;
    while ((m = re.exec(fsSrc)) !== null) {
        const [, type, name] = m;
        if (seen.has(name)) continue;
        seen.add(name);
        decls.push(`varying ${type} ${name};`);
        assigns.push(`    ${name} = ${type}(0.0);`);
    }
    return '#version 120\n' +
        decls.join('\n') + (decls.length ? '\n' : '') +
        'void main() {\n' +
        '    gl_Position = ftransform();\n' +
        '    gl_TexCoord[0] = gl_MultiTexCoord0;\n' +
        '    gl_FrontColor = gl_Color;\n' +
        assigns.join('\n') + (assigns.length ? '\n' : '') +
        '}\n';
}

/** Render translator diagnostics as a single `lastShaderLog` string for
 *  gl.GetShaderLog. Errors first, then warnings; line refs included when
 *  the translator could pin them. */
function formatShaderDiagnostics(stage: 'vertex' | 'fragment', diags: GlslDiagnostic[]): string {
    if (diags.length === 0) return '';
    const ordered = [...diags].sort((a, b) => severityRank(a.severity) - severityRank(b.severity));
    const lines: string[] = [`[${stage}]`];
    for (const d of ordered) {
        const where = d.file && d.line ? `${d.file}:${d.line}` : (d.line ? `line ${d.line}` : '');
        const prefix = where ? `${d.severity} (${where}):` : `${d.severity}:`;
        lines.push(`  ${prefix} ${d.message}`);
    }
    return lines.join('\n');
}

function severityRank(s: 'error' | 'warning' | 'info'): number {
    return s === 'error' ? 0 : s === 'warning' ? 1 : 2;
}
