/**
 * GLSL translator — converts Spring's authored GLSL (150 / 330 desktop
 * core profile) into GLSL ES 3.00 that WebGL2 will accept.
 *
 * Lives separate from `lua-gl-bridge.ts` so the rules can be unit-tested
 * and reused by ModelMaterials / weapon-FX code paths that compile
 * shaders outside the Lua bridge.
 *
 * Capabilities:
 *   - `translateGLSL(src, stage)`   — version + qualifier + int→float
 *                                     rewrites. Pure function. Returns
 *                                     diagnostics with source-line refs.
 *   - `resolveIncludes(src, opts)`  — `#include "path"` resolver with
 *                                     cycle detection and `#line`
 *                                     preservation.
 *   - `hashSource(src)`             — FNV-1a 64-bit hash, used by the
 *                                     bridge's program registry to share
 *                                     identical-source programs.
 *   - `ENGINE_SNIPPETS`             — built-in includes shipped with the
 *                                     module (currently `engine/csm.glsl`,
 *                                     the reusable CSM shadow sampler
 *                                     from PLAN-lighting.md L4).
 *
 * GL4-only features are rejected loudly with a source-line diagnostic.
 * Legacy fixed-function inputs (`gl_Vertex`, `gl_ModelViewMatrix`, etc.)
 * are handled two ways:
 *   - With `legacyGL2Shim: true`, the translator rewrites them to
 *     user-named attributes/uniforms/varyings (`_legVertex`,
 *     `_legModelViewMatrix`, ...) bound to the immediate-mode renderer's
 *     attribute slots (0 = position, 1 = color, 2 = texcoord0). LUPS
 *     particle classes need this to make `gl.CreateShader` succeed.
 *   - Without the flag, `gl_Vertex` triggers an `expectedReject` and the
 *     caller falls back to its software draw path. Chili widgets like
 *     `gui_chili_minimap`'s fadeShader rely on this: they check
 *     `if shader == nil` and skip the shader pass.
 */

export type GlslStage = 'vertex' | 'fragment';

export type DiagnosticSeverity = 'error' | 'warning' | 'info';

export interface GlslDiagnostic {
    severity: DiagnosticSeverity;
    /** 1-based line number in the *input* source, when known. */
    line?: number;
    file?: string;
    message: string;
}

export interface TranslateOptions {
    /** Permit rewrites for GLSL 1.10 fixed-function builtins (`gl_Vertex`,
     *  `gl_ModelViewMatrix`, `gl_TexCoord[]`, `gl_FrontColor`,
     *  `gl_MultiTexCoord0..7`, etc.) to user-named ins/uniforms/varyings.
     *  Required for ZK LUPS particle classes whose vertex shaders use
     *  the fixed-function pipeline. Defaults to enabled. The translator
     *  still only shims sources that touch fixed-function state beyond
     *  bare `gl_Vertex` — chili widgets that only sample `gl_Vertex`
     *  keep the legacy-reject behaviour so they fall back to their
     *  software draw path. Set explicitly to `false` to force the
     *  reject in all cases (test isolation, etc.). */
    legacyGL2Shim?: boolean;
}

export interface TranslateResult {
    /** The translated source. Set even on rejection so the caller can
     *  push an `#error` sentinel through `compileShader` if it wants
     *  the GL info-log path. */
    source: string;
    /** False when translation produced an `#error` sentinel. */
    ok: boolean;
    /** True iff the rejection is by-design (legacy `gl_Vertex`, GL4
     *  fallback). The bridge downgrades console reporting in that
     *  case so widgets that probe-and-fallback don't spam warnings. */
    expectedReject: boolean;
    /** Source-locator-aware errors and warnings. */
    diagnostics: GlslDiagnostic[];
}

export interface IncludeResolveOptions {
    /** Synchronous lookup: include path → contents, or undefined. */
    lookup: (path: string) => string | undefined;
    /** Origin of the top-level source, used in diagnostics + cycle
     *  detection. Defaults to `'<input>'`. */
    entry?: string;
    /** Maximum include depth before bailing. Default 16. */
    maxDepth?: number;
    /** Built-in snippets that take precedence over `lookup`. Defaults
     *  to `ENGINE_SNIPPETS`. Pass `{}` to disable. */
    builtins?: Record<string, string>;
}

export interface IncludeResult {
    source: string;
    ok: boolean;
    diagnostics: GlslDiagnostic[];
    /** Files actually included, in resolve order. Useful for cache keys
     *  and for the per-program shader registry. */
    included: string[];
}

// ── Built-in snippets ───────────────────────────────────────────────────

/**
 * Reusable CSM shadow sampler matching the binding contract from
 * PLAN-lighting.md L4 (entity-renderer.ts line 316-387). Any custom
 * fragment shader that #includes this can call `sampleCsmShadow(worldPos,
 * viewZ)` and get back 0.0 (in shadow) or 1.0 (lit) matching the unit
 * shader's directional sun contribution.
 *
 * Bindings the caller must supply:
 *   uniform highp sampler2DArray csmShadowMap;   // bound from scene-lighting
 *   uniform mat4 csmMatrices[4];                 // refreshed per draw
 *   uniform vec4 csmSplits;                      // x/y/z = cascade far-Z; w = absolute max
 *
 * The snippet declares those uniforms itself when included, so the
 * caller only has to feed values via the existing
 * `onBindObservable.add(refreshCsmUniforms)` path. If the host shader
 * already declares any of them, the duplicates collapse at link time
 * (same type, same name) — GLSL ES allows redundant uniform
 * declarations in the same translation unit.
 */
const CSM_SHADOW_SNIPPET = `// engine/csm.glsl — reusable CSM shadow sampler. Matches
// entity-renderer.ts's directional sun contract.

uniform highp sampler2DArray csmShadowMap;
uniform mat4  csmMatrices[4];
uniform vec4  csmSplits;

float sampleCsmShadow(vec3 worldPos, float viewZ) {
    int cascade = 3;
    if      (viewZ < csmSplits.x) cascade = 0;
    else if (viewZ < csmSplits.y) cascade = 1;
    else if (viewZ < csmSplits.z) cascade = 2;
    else if (viewZ >= csmSplits.w) return 1.0;

    vec4 lp = csmMatrices[cascade] * vec4(worldPos, 1.0);
    vec3 ndc = lp.xyz / lp.w;
    vec3 uv  = ndc * 0.5 + 0.5;
    if (uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0) return 1.0;
    if (uv.z < 0.0 || uv.z > 1.0) return 1.0;

    float bias    = 0.0015;
    float occluder = texture(csmShadowMap, vec3(uv.xy, float(cascade))).r;
    return (uv.z - bias) > occluder ? 0.0 : 1.0;
}
`;

export const ENGINE_SNIPPETS: Record<string, string> = Object.freeze({
    'engine/csm.glsl': CSM_SHADOW_SNIPPET,
    // Compatibility alias: PLAN-lighting.md L4 refers to the snippet
    // as `ShadowFragSnippet.glsl`. Either path resolves to the same
    // body so callers can use whichever name reads better.
    'ShadowFragSnippet.glsl': CSM_SHADOW_SNIPPET,
}) as Record<string, string>;

// ── Hashing ─────────────────────────────────────────────────────────────

/**
 * FNV-1a 64-bit hash, returned as 16-char lowercase hex. Used as the
 * key for the bridge's program registry — identical translated source
 * (vertex + fragment, separated by `\0`) collapses onto one program.
 *
 * 64-bit because the registry holds long-lived programs across the
 * lifetime of a game session; 32-bit FNV's collision rate at ~10⁴
 * shaders is too close for comfort.
 */
export function hashSource(src: string): string {
    const FNV_OFFSET_HI = 0xcbf29ce4 | 0;
    const FNV_OFFSET_LO = 0x84222325 | 0;
    let hi = FNV_OFFSET_HI;
    let lo = FNV_OFFSET_LO;
    for (let i = 0; i < src.length; i++) {
        const c = src.charCodeAt(i);
        // XOR low half by the byte. JS chars are 16 bits but FNV by
        // convention bytes-the-string; for ASCII source this collapses
        // to the same result. Non-ASCII shader source is exotic enough
        // to ignore.
        lo = (lo ^ (c & 0xff)) >>> 0;
        // Multiply by FNV prime (1099511628211 = 0x100000001b3).
        // Decompose: hi * 2^32 + lo *= 1 * 2^40 + 0x1b3.
        //   prime_hi = 0x100, prime_lo = 0x000001b3
        const PRIME_HI = 0x100;
        const PRIME_LO = 0x000001b3;
        // 64x64 → 64 multiply, only keeping low 64 bits.
        const loLo = (lo & 0xffff) * (PRIME_LO & 0xffff);
        const loHi1 = (lo >>> 16) * (PRIME_LO & 0xffff);
        const loHi2 = (lo & 0xffff) * (PRIME_LO >>> 16);
        const loHi3 = (lo >>> 16) * (PRIME_LO >>> 16);
        const newLo = (loLo + ((loHi1 + loHi2) << 16)) >>> 0;
        let carry = Math.floor((loLo + ((loHi1 + loHi2) << 16)) / 0x100000000);
        carry += ((loHi1 + loHi2) >>> 16);
        carry += loHi3;
        carry += (lo >>> 0) * PRIME_HI;
        carry += (hi >>> 0) * (PRIME_LO >>> 0);
        // (hi * PRIME_HI) overflows beyond 64 bits — drop.
        hi = (carry | 0) >>> 0;
        lo = newLo;
    }
    return hi.toString(16).padStart(8, '0') + lo.toString(16).padStart(8, '0');
}

// ── Include resolver ───────────────────────────────────────────────────

/**
 * Pattern for a `#include "path"` directive. Anchored with `^` /
 * non-newline-trailing so a stray `#include` inside a string literal or
 * multi-line comment isn't picked up. **Do not reuse a single global
 * regex object across recursive expansions** — `lastIndex` is shared
 * state and the inner expansion resets it, leaking back to the outer
 * iteration and causing an infinite loop (and OOM). Compile a fresh
 * instance per `expand()` invocation, or use `String.matchAll`.
 */
const INCLUDE_RE_SOURCE = '^[ \\t]*#include[ \\t]+"([^"]+)"[ \\t]*\\r?$';

/**
 * Recursively expand `#include "path"` directives. Cycles raise an
 * error diagnostic and leave the offending line replaced with `#error`
 * so the GL info-log surfaces the issue. `#line N "file"` directives
 * bracket each substitution so compile errors in the expanded source
 * still report the include file + line.
 *
 * `#line` is emitted with `0 N` (cascade-style), where N is a small
 * integer assigned per included file. GLSL ES 3.00 accepts this form;
 * we also emit a trailing comment with the human-readable path for
 * diagnostics.
 */
export function resolveIncludes(src: string, opts: IncludeResolveOptions): IncludeResult {
    const lookup = opts.lookup;
    const entry = opts.entry ?? '<input>';
    const maxDepth = opts.maxDepth ?? 16;
    const builtins = opts.builtins ?? ENGINE_SNIPPETS;

    const diagnostics: GlslDiagnostic[] = [];
    const included: string[] = [];

    function expand(text: string, file: string, depth: number, stack: string[]): string {
        if (depth > maxDepth) {
            diagnostics.push({
                severity: 'error',
                file,
                message: `#include depth exceeded ${maxDepth} levels (cycle?)`,
            });
            return `#error include_depth_exceeded\n`;
        }
        // Fresh regex per call — recursion safety. See the note next to
        // INCLUDE_RE_SOURCE: a shared global regex's `lastIndex` is the
        // hot reason this loop ran away into OOM.
        const re = new RegExp(INCLUDE_RE_SOURCE, 'gm');
        let out = '';
        let cursor = 0;
        // Track line numbers in the *current* file so diagnostics can
        // refer to the original `#include` site.
        let lineAtCursor = 1;
        let m: RegExpExecArray | null;
        while ((m = re.exec(text)) !== null) {
            const includeStart = m.index;
            const path = m[1];
            // Emit text up to the `#include` line.
            const chunk = text.slice(cursor, includeStart);
            out += chunk;
            lineAtCursor += countLines(chunk);
            // Cycle check.
            if (stack.indexOf(path) >= 0) {
                diagnostics.push({
                    severity: 'error',
                    file,
                    line: lineAtCursor,
                    message: `#include "${path}" cycle (stack: ${stack.join(' → ')} → ${path})`,
                });
                out += `#error include_cycle_${path.replace(/[^a-zA-Z0-9_]/g, '_')}\n`;
            } else {
                const body = builtins[path] ?? lookup(path);
                if (body === undefined) {
                    diagnostics.push({
                        severity: 'error',
                        file,
                        line: lineAtCursor,
                        message: `#include "${path}" not found`,
                    });
                    out += `#error include_not_found_${path.replace(/[^a-zA-Z0-9_]/g, '_')}\n`;
                } else {
                    if (included.indexOf(path) < 0) included.push(path);
                    out += `// >>> ${path}\n`;
                    out += expand(body, path, depth + 1, stack.concat(path));
                    out += `// <<< ${path}\n`;
                }
            }
            // Account for the `#include` line itself.
            lineAtCursor += 1;
            // Advance past the matched line, including any trailing
            // newline so we don't double-count when blank.
            cursor = includeStart + m[0].length;
            if (text[cursor] === '\n') cursor += 1;
            else if (text[cursor] === '\r' && text[cursor + 1] === '\n') cursor += 2;
            // Keep the regex engine in sync with `cursor` so it scans
            // from where we actually are, not from where its previous
            // line-end matched. Without this, `re.lastIndex` can sit at
            // the byte right after `m[0]` while `cursor` skipped the
            // newline, causing the engine to re-anchor at the same
            // `#include` line forever.
            re.lastIndex = cursor;
        }
        out += text.slice(cursor);
        return out;
    }

    const expanded = expand(src, entry, 0, [entry]);
    return {
        source: expanded,
        ok: diagnostics.every(d => d.severity !== 'error'),
        diagnostics,
        included,
    };
}

function countLines(s: string): number {
    let n = 0;
    for (let i = 0; i < s.length; i++) {
        if (s.charCodeAt(i) === 10 /* \n */) n++;
    }
    return n;
}

// ── GL4 feature rejection ───────────────────────────────────────────────

/**
 * Patterns whose presence means the shader uses GL features WebGL2 / ES
 * 3.0 cannot deliver. Detected before any rewriting so the source-line
 * diagnostic points at the original `gl4` site, not a derived position.
 * Each entry is `[regex, name, hint]` — the hint is appended to the
 * diagnostic so the LUPS / weapon-fx caller knows why we bailed.
 */
const GL4_FEATURES: ReadonlyArray<readonly [RegExp, string, string]> = [
    [/\bimageLoad\s*\(/, 'imageLoad', 'GLSL 4.20 image ops are not in GLSL ES 3.00 (WebGL2)'],
    [/\bimageStore\s*\(/, 'imageStore', 'GLSL 4.20 image ops are not in GLSL ES 3.00 (WebGL2)'],
    [/\bimageAtomic\w+\s*\(/, 'imageAtomic*', 'GLSL 4.20 image atomics are not in WebGL2'],
    [/\bsamplerCubeArray\b/, 'samplerCubeArray', 'requires GLSL ES 3.10+ (WebGL2 is ES 3.00)'],
    [/\bsamplerCubeArrayShadow\b/, 'samplerCubeArrayShadow', 'requires GLSL ES 3.10+ (WebGL2 is ES 3.00)'],
    [/\bgl_PrimitiveID\b/, 'gl_PrimitiveID', 'requires GLSL ES 3.20+ in fragment stage; geometry stage is unavailable in WebGL2'],
    [/^[ \t]*layout\s*\([^)]*\bstd430\b[^)]*\)\s*(?:readonly|writeonly|coherent|volatile|restrict|\s)*buffer\b/m, 'SSBO', 'shader-storage buffer objects need GLSL ES 3.10+ (WebGL2 is ES 3.00); use RGBA32F data textures instead'],
    [/^[ \t]*layout\s*\([^)]*\blocal_size_x\b/m, 'compute_shader', 'compute shaders are not in WebGL2'],
    [/\bbarrier\s*\(\s*\)/, 'barrier', 'shader barriers require GLSL ES 3.10+ (WebGL2 is ES 3.00)'],
    [/\bmemoryBarrier\w*\s*\(/, 'memoryBarrier', 'memory barriers require GLSL ES 3.10+ (WebGL2 is ES 3.00)'],
];

function findLine(src: string, regex: RegExp): number | undefined {
    // Local copy with .lastIndex 0; the global vs non-global state on
    // the input regex is the caller's problem.
    const re = new RegExp(regex.source, regex.flags.includes('g') ? regex.flags : regex.flags + 'g');
    const m = re.exec(src);
    if (!m) return undefined;
    let line = 1;
    for (let i = 0; i < m.index; i++) {
        if (src.charCodeAt(i) === 10) line++;
    }
    return line;
}

// ── Main translator ────────────────────────────────────────────────────

/**
 * Translate Spring-flavoured desktop GLSL to GLSL ES 3.00 for WebGL2.
 *
 * Returns a result whose `ok` flag indicates whether the source is
 * compilable. `expectedReject` is set when the input matched a
 * by-design rejection pattern (legacy `gl_Vertex`, `#version 400+`),
 * in which case the bridge downgrades console reporting.
 */
export function translateGLSL(src: string, stage: GlslStage, opts: TranslateOptions = {}): TranslateResult {
    const diagnostics: GlslDiagnostic[] = [];
    // Apply the shim only when the source touches fixed-function state
    // beyond bare `gl_Vertex` — fixed-function matrices, multi-texcoords,
    // legacy varyings, or `gl_TexCoord[]`. Chili widgets like
    // `gui_chili_minimap`'s fadeShader use *only* `gl_Vertex` and rely on
    // the rejection path to fall back to their software draw. LUPS
    // particle classes always need at least `gl_ModelViewMatrix` (their
    // shaders compose world transforms by hand), so this heuristic
    // separates the two cleanly. Caller can still set `legacyGL2Shim`
    // false to opt out completely.
    const shimAllowed = opts.legacyGL2Shim !== false;
    const needsShimForFixedFunc = /\bgl_(ModelViewMatrix|ProjectionMatrix|ModelViewProjectionMatrix|NormalMatrix|TexCoord|FrontColor|Color|MultiTexCoord[0-7])\b/.test(src);
    const enableLegacyShim = shimAllowed && needsShimForFixedFunc;

    // ── Hard rejections (do these first; they look at the ORIGINAL
    //    source so line numbers are correct). ────────────────────────────

    // Legacy `gl_Vertex` — see header comment: chili widgets use a nil
    // CreateShader result as a signal to fall back to the simple draw
    // path. When the source uses other fixed-function state too we
    // rewrite instead (LUPS pattern).
    if (!enableLegacyShim && /\bgl_Vertex\b/.test(src)) {
        diagnostics.push({
            severity: 'info',
            line: findLine(src, /\bgl_Vertex\b/),
            message: 'legacy gl_Vertex — falling back to immediate-mode draw path',
        });
        return {
            source: '#error legacy_gl_Vertex_unsupported',
            ok: false,
            expectedReject: true,
            diagnostics,
        };
    }

    // GL4 (#version 400+) — caller may have a non-gl4 variant.
    const versionMatch = src.match(/#version\s+(\d+)/);
    if (versionMatch && parseInt(versionMatch[1], 10) >= 400) {
        diagnostics.push({
            severity: 'info',
            line: findLine(src, /#version/),
            message: `#version ${versionMatch[1]} requires WebGL2-equivalent GL4 features that aren't available`,
        });
        return {
            source: `#error gl4_shader_unsupported_v${versionMatch[1]}`,
            ok: false,
            expectedReject: true,
            diagnostics,
        };
    }

    // GL4-only feature names. These are *loud* — the calling LUPS class
    // / weapon-fx caller needs to know which authored ZK content tripped
    // them so PLAN-weapon-fx Phase G1/G3/G4 can pick up the gap.
    for (const [re, name, hint] of GL4_FEATURES) {
        if (re.test(src)) {
            const line = findLine(src, re);
            diagnostics.push({
                severity: 'error',
                line,
                message: `unsupported GL4 feature '${name}': ${hint}`,
            });
            return {
                source: `#error gl4_feature_${name.replace(/[^a-zA-Z0-9_]/g, '_')}`,
                ok: false,
                expectedReject: false,
                diagnostics,
            };
        }
    }

    // ── Translation passes ─────────────────────────────────────────────

    const isLegacy = /\bvarying\b|\battribute\b|\bgl_FragColor\b|\btexture2D\b/.test(src);

    // Strip Spring's version directive entirely; we re-add ES 300 below.
    let s = src.replace(/#version\s+\d+\s*(compatibility|core)?\s*/g, '');
    // Strip `#extension` directives. They reference desktop-GL extensions
    // (GL_ARB_*) that either don't exist in ES or are already core in
    // ES 3.0. Ordering also matters — `#extension` must follow `#version`
    // but precede any non-preprocessor token, and our injected `precision`
    // qualifiers would push them out of order.
    s = s.replace(/^[ \t]*#extension\s+[^\n]*\n?/gm, '');

    const header = stage === 'vertex'
        ? '#version 300 es\nprecision highp float;\nprecision highp int;\n'
        : '#version 300 es\nprecision highp float;\nprecision highp int;\nprecision highp sampler2D;\nprecision highp sampler2DArray;\nprecision highp sampler2DShadow;\n';
    s = header + s;
    // GLSL ES 300 doesn't support `sampler2DShadow` without depth-compare
    // texture binding semantics that Spring widgets don't set up. Demote
    // to plain `sampler2D` — the CSM snippet uses sampler2DArray directly
    // and isn't affected.
    s = s.replace(/sampler2DShadow/g, 'sampler2D');

    // ── Legacy GLSL 1.10 → ES 300 rewrites ────────────────────────────
    if (isLegacy) {
        if (stage === 'vertex') {
            s = s.replace(/\battribute\b/g, 'in');
            s = s.replace(/\bvarying\b/g, 'out');
        } else {
            s = s.replace(/\bvarying\b/g, 'in');
            s = s.replace(/\btexture2D\b/g, 'texture');
            if (/\bgl_FragColor\b/.test(s)) {
                s = s.replace(/\bgl_FragColor\b/g, 'outFragColor');
                // Anchor after `precision highp int;` so the float
                // precision is in scope by the time we declare the
                // vec4 out (otherwise GLSL ES errors on missing
                // precision).
                s = s.replace(
                    /(precision\s+highp\s+int;\n)/,
                    '$1out vec4 outFragColor;\n',
                );
            }
        }
    }

    // ── Legacy GL2 fixed-function shim (opt-in via legacyGL2Shim) ─────
    //
    // ZK LUPS particle classes (SimpleParticles, RingParticles,
    // ShockWave, Ribbon, ...) use the GLSL 1.10 fixed-function pipeline:
    // `gl_Vertex`, `gl_Normal`, `gl_Color`, `gl_MultiTexCoord0..7`,
    // `gl_ModelViewMatrix`, `gl_ProjectionMatrix`,
    // `gl_ModelViewProjectionMatrix`, `gl_NormalMatrix`, `gl_TexCoord[]`,
    // `gl_FrontColor`, `gl_FragColor`. GLSL ES 300 reserves `gl_*`
    // identifiers and exposes only `gl_Position`, `gl_FragCoord`,
    // `gl_VertexID`, `gl_InstanceID`, `gl_PointSize`, `gl_PointCoord`.
    //
    // We rename each used builtin to a `_leg*` identifier, then inject
    // matching declarations after the precision header. Attribute slots
    // follow the immediate-mode renderer's VAO (0 = position, 1 = color,
    // 2 = texcoord0); other multi-texcoord units share slot 2 since the
    // bridge doesn't carry per-particle aux streams yet — those classes
    // will visually degrade until the bridge wires real per-particle
    // VBOs, but the shader compiles and the LUPS class registers.
    if (enableLegacyShim) {
        const decls: string[] = [];

        // Per-stage attributes / varyings.
        const usedVertex = /\bgl_Vertex\b/.test(s);
        const usedNormal = /\bgl_Normal\b/.test(s);
        const usedColorAttr = stage === 'vertex' && /\bgl_Color\b/.test(s);
        const usedFrontColor = /\bgl_FrontColor\b/.test(s);
        const usedFragColorRead = stage === 'fragment' && /\bgl_Color\b/.test(s);
        const usedTexCoord = /\bgl_TexCoord\s*\[/.test(s);

        // Fixed-function matrices — always uniforms.
        const usedMV = /\bgl_ModelViewMatrix\b/.test(s);
        const usedProj = /\bgl_ProjectionMatrix\b/.test(s);
        const usedMVP = /\bgl_ModelViewProjectionMatrix\b/.test(s);
        const usedNormalMatrix = /\bgl_NormalMatrix\b/.test(s);

        // gl_MultiTexCoord0..7.
        const usedMultiTex: boolean[] = new Array(8).fill(false);
        for (let i = 0; i < 8; i++) {
            if (new RegExp('\\bgl_MultiTexCoord' + i + '\\b').test(s)) {
                usedMultiTex[i] = true;
            }
        }

        // Apply identifier renames. Done in one pass over the source —
        // each replace is whole-word-anchored so they don't overlap.
        const rename = (re: RegExp, to: string) => { s = s.replace(re, to); };
        if (usedVertex) rename(/\bgl_Vertex\b/g, '_legVertex');
        if (usedNormal) rename(/\bgl_Normal\b/g, '_legNormal');
        if (usedColorAttr || usedFragColorRead) rename(/\bgl_Color\b/g, '_legColor');
        if (usedFrontColor) rename(/\bgl_FrontColor\b/g, '_legColor');
        if (usedTexCoord) rename(/\bgl_TexCoord\b/g, '_legTexCoord');
        if (usedMV) rename(/\bgl_ModelViewMatrix\b/g, '_legModelViewMatrix');
        if (usedProj) rename(/\bgl_ProjectionMatrix\b/g, '_legProjectionMatrix');
        if (usedMVP) rename(/\bgl_ModelViewProjectionMatrix\b/g, '_legModelViewProjectionMatrix');
        if (usedNormalMatrix) rename(/\bgl_NormalMatrix\b/g, '_legNormalMatrix');
        for (let i = 0; i < 8; i++) {
            if (usedMultiTex[i]) {
                rename(new RegExp('\\bgl_MultiTexCoord' + i + '\\b', 'g'), '_legMultiTexCoord' + i);
            }
        }

        // Build declaration block. Attribute slots match
        // ImmediateModeRenderer's VAO (lua-gl-immediate.ts).
        if (stage === 'vertex') {
            if (usedVertex) decls.push('layout(location = 0) in vec4 _legVertex;');
            if (usedColorAttr) decls.push('layout(location = 1) in vec4 _legColor;');
            if (usedMultiTex[0]) decls.push('layout(location = 2) in vec4 _legMultiTexCoord0;');
            // gl_Normal + gl_MultiTexCoord1..7 don't have a dedicated
            // immediate-mode stream. Declare without explicit location so
            // the linker assigns one; they'll read zero until the bridge
            // wires real per-particle attributes.
            if (usedNormal) decls.push('in vec3 _legNormal;');
            for (let i = 1; i < 8; i++) {
                if (usedMultiTex[i]) decls.push(`in vec4 _legMultiTexCoord${i};`);
            }
            if (usedTexCoord) decls.push('out vec4 _legTexCoord[8];');
            if (usedFrontColor) decls.push('out vec4 _legColor;');
        } else {
            // Fragment stage: legacy gl_Color reads the gl_FrontColor
            // varying. gl_TexCoord[] mirrors the vertex out.
            if (usedFragColorRead || usedFrontColor) decls.push('in vec4 _legColor;');
            if (usedTexCoord) decls.push('in vec4 _legTexCoord[8];');
        }

        if (usedMV) decls.push('uniform mat4 _legModelViewMatrix;');
        if (usedProj) decls.push('uniform mat4 _legProjectionMatrix;');
        if (usedMVP) decls.push('uniform mat4 _legModelViewProjectionMatrix;');
        if (usedNormalMatrix) decls.push('uniform mat3 _legNormalMatrix;');

        if (decls.length > 0) {
            // Inject the legacy declarations after the precision header
            // so the precision qualifiers are in scope. `outFragColor` is
            // already injected by the legacy block above; do the same
            // anchoring for consistency.
            s = s.replace(
                /(precision\s+highp\s+int;\n(?:precision[^;]+;\n)*)/,
                '$1' + decls.join('\n') + '\n',
            );
        }
    }

    // ── Int → float promotions ────────────────────────────────────────
    //
    // GLSL ES 300 is strict: you cannot assign an integer literal to a
    // float, multiply/divide an int by a float, or construct a float
    // array from mixed-type literals. Spring's 150-compat shaders do all
    // of these. We rewrite them:

    // 1. `const float NAME = -?INT;` → append `.0` to the literal.
    s = s.replace(
        /(\bconst\s+float\s+\w+\s*=\s*)(-?\d+)(\s*;)/g,
        '$1$2.0$3',
    );

    // 2. Integer literals inside `float[N](...)` array constructors.
    //    `float[NUM_LAYERS](1, 6.6, 8.4, ...)` must become
    //    `float[NUM_LAYERS](1.0, 6.6, 8.4, ...)`. The look-ahead
    //    `(?![\w.])` rejects any digit or dot that follows — critical
    //    because otherwise `\d+` would backtrack from `34` to `3`,
    //    then happily append `.0` and produce garbage `3.04.6` out of
    //    `34.6`.
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

    // 3. Bare int literal on LHS of arithmetic.
    s = s.replace(
        /(?<![\w.])(-?\d+)(?![\w.])(\s*[*/+\-])/g,
        '$1.0$2',
    );

    // 4. Bare int literal on RHS of arithmetic after an identifier,
    //    `)`, or member access.
    s = s.replace(
        /([A-Za-z_)](?:\.\w+)?\s*[*/+\-]\s*)(-?\d+)(?![\w.\]])/g,
        '$1$2.0',
    );

    // 4b. Bare int literal on RHS of comparison with a float-valued
    //    swizzle/member access. Plain-identifier comparisons may be
    //    against an int varying so we *require* `.member` on the LHS.
    s = s.replace(
        /([A-Za-z_)]\.\w+\s*(?:>=|<=|==|!=|>|<)\s*)(-?\d+)(?![\w.\]])/g,
        '$1$2.0',
    );

    // 4c. Assignment of bare int literal to a float variable. Apply
    //    per-line and skip integer-typed declarations and for-loop
    //    counters.
    s = s.split('\n').map(line => {
        if (/\b(int|uint|ivec[234]|uvec[234]|bvec[234])\b/.test(line)) return line;
        if (/\bfor\s*\(/.test(line)) return line;
        return line.replace(
            /(\b\w+\s*=\s*)(-?\d+)(\s*;)/g,
            '$1$2.0$3',
        );
    }).join('\n');

    // 5. `gl_InstanceID` used as a float operand.
    s = s.replace(
        /([*/+\-])\s*gl_InstanceID\b(?!\s*\])/g,
        '$1 float(gl_InstanceID)',
    );
    s = s.replace(
        /\bgl_InstanceID\s*([*/+\-])/g,
        'float(gl_InstanceID) $1',
    );

    return {
        source: s,
        ok: true,
        expectedReject: false,
        diagnostics,
    };
}

// ── Convenience: translate + include in one call ───────────────────────

export interface TranslateAndIncludeOptions extends IncludeResolveOptions, TranslateOptions {}

/**
 * Resolve includes first (so the input to translation is a single
 * concatenated source), then translate. Diagnostics from both passes
 * are merged. Returns `included` so callers can mix in include file
 * names when computing a program-registry cache key.
 */
export function translateAndInclude(
    src: string,
    stage: GlslStage,
    opts: TranslateAndIncludeOptions,
): TranslateResult & { included: string[] } {
    const inc = resolveIncludes(src, opts);
    if (!inc.ok) {
        return {
            source: inc.source,
            ok: false,
            expectedReject: false,
            diagnostics: inc.diagnostics,
            included: inc.included,
        };
    }
    const tx = translateGLSL(inc.source, stage, { legacyGL2Shim: opts.legacyGL2Shim });
    return {
        source: tx.source,
        ok: tx.ok,
        expectedReject: tx.expectedReject,
        diagnostics: inc.diagnostics.concat(tx.diagnostics),
        included: inc.included,
    };
}
