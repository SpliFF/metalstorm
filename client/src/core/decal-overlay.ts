/**
 * DecalOverlay — persistent baked ground-decal system (PLAN-decals.md D7,
 * depth-field accumulation per PLAN-decal-vt.md V0, camera-centered clipmap
 * per PLAN-decal-vt.md V1).
 *
 * Two accumulation textures, both fed from one CPU-authoritative mark list:
 *   - COARSE: covers the whole map at low res (always resident); the fallback
 *     for everything outside / beyond the fine window and at far zoom.
 *   - FINE: a fixed-size texture covering a square WINDOW around the camera
 *     focus, so near-camera decals stay sharp (≈1 elmo/texel) regardless of map
 *     size. The window follows the camera and is re-baked when the camera pans
 *     past a threshold or zoom changes the window size. VRAM is bounded by the
 *     two textures (~71 MB), NOT by map area — this scales to arbitrarily large
 *     maps. The terrain plugin samples fine inside the window (feathered) and
 *     falls back to coarse outside / far away.
 *
 * Each scar / track event is a *mark* in WORLD space (centre + two half-axis
 * vectors in elmos). The blit replays marks into a target via thin instances; a
 * per-target world→clip uniform (origin + 1/extent) places each mark, so the
 * SAME mark list bakes correctly into both the full-map coarse texture and the
 * scrolling fine window. Off-target marks fall outside clip space and are
 * rejected by the rasteriser, so baking "all marks" into the fine window costs
 * ≈ the in-window subset.
 *
 * We store a *depression depth + albedo darkening* (NOT a baked normal, NOT
 * baked lighting). The terrain plugin derives the surface normal from the depth
 * field's GRADIENT and lights it live, so the sun re-shades the grooves for
 * free. Storing depth (a scalar that sums) is what lets overlapping marks
 * ACCUMULATE additively — overlapping craters deepen, traffic darkens — which a
 * signed 0.5-centered normal encoding could not do.
 *
 * Overlay channels, ADDITIVE blend, init/neutral = (0,0,0,0). Two pixel
 * formats, chosen once at construction (PLAN-decal-tracks §3):
 *   - Primary: R11F_G11F_B10F (float, colour-renderable + additive-blendable
 *     under WebGL2 `EXT_color_buffer_float`, same 32 bpp as the old RGBA8 —
 *     zero VRAM change) —
 *       R (11F) depression depth 0..1   (plugin: normal = gradient of raise-depth)
 *       G (11F) albedo darkening 0..1   (plugin: albedo tinted dirt-brown, capped)
 *       B (10F) raise 0..1              (displaced-soil berms/rims; additive like depth)
 *   - Fallback (extension unavailable — flagged loudly in the console, not
 *     silently): RGBA8 —
 *       R+A     depression depth, packed coarse(R)+residual(A) for a bit more
 *               than 8-bit precision (see `dDecSample` in decal-overlay-plugin.ts)
 *       G       albedo darkening, as above
 *       B       unused — no raise field; berms/rims don't render in this path.
 * Both formats saturate their depth/darkening range at 1.0 = the cap; that
 * bounds heavily-worked ground. Plugin surface height = raise − depth, so the
 * gradient normal derived from that signed field gives pit walls AND ridges.
 *
 * Continuous vehicle tracks (tread/wheel) do NOT go through the mark list: they
 * accumulate as per-unit polyline trails (decal-trails.ts) and bake as one
 * joint-free ribbon strip each, keyed on world arc length (PLAN-decal-tracks
 * §2). Scars and discrete prints (foot/claw) remain marks.
 *
 * Fade / "global reset": additive blending can't subtract over time, so fade
 * comes from a periodic age-scaled REBUILD — every REBUILD_INTERVAL_S each
 * target is cleared and the whole live mark list (a ring buffer of marks with
 * birth times) is re-stamped with a coverage scaled by age; fully-faded marks
 * are dropped. Between rebuilds new marks append onto the persistent textures.
 */

import {
    Scene,
    Mesh,
    VertexData,
    ShaderMaterial,
    RenderTargetTexture,
    Constants,
    Texture,
    Color4,
    FreeCamera,
    Vector2,
    Vector3,
} from '@babylonjs/core';
import type { ScarEvent, TrackSegmentEvent } from './decal-events.js';
import { TrailStore, tessellateTrail, writeRibbonIndices } from './decal-trails.js';

/** Capability shape {@link chooseOverlayFormat} needs — just the one flag,
 *  so it's testable with a plain object instead of a real engine. */
export interface OverlayFormatCaps {
    colorBufferFloat: boolean;
}

/** Result of the RTT pixel-format decision (PLAN-decal-tracks §3). */
export interface OverlayFormat {
    type: number;
    format: number;
    /** True when the format has a real B raise channel (float path); false in
     *  the RGBA8 fallback, where depth is packed R+A and there is no raise. */
    hasRaise: boolean;
}

/** Choose the overlay RTT pixel format: R11F_G11F_B10F (colour-renderable +
 *  additive-blendable under WebGL2 `EXT_color_buffer_float`) when available —
 *  same 32 bpp as the old RGBA8, now split R=depth/G=dark/B=raise instead of
 *  R=depth/G=dark/(B,A spare). Falls back to RGBA8 (depth packed R+A, no
 *  raise — §3) when the extension is missing; callers must flag that loudly,
 *  not silently, since it drops berms/rims entirely. */
export function chooseOverlayFormat(caps: OverlayFormatCaps): OverlayFormat {
    if (caps.colorBufferFloat) {
        return {
            type: Constants.TEXTURETYPE_UNSIGNED_INT_10F_11F_11F_REV,
            format: Constants.TEXTUREFORMAT_RGB,
            hasRaise: true,
        };
    }
    return {
        type: Constants.TEXTURETYPE_UNSIGNED_BYTE,
        format: Constants.TEXTUREFORMAT_RGBA,
        hasRaise: false,
    };
}

/** Fine-window texture dimension (square). The window covers `winElmos` of
 *  world, so texel = winElmos / FINE_DIM; the window size is chosen from zoom
 *  to keep near-camera texels ≈ the map atlas (~1 elmo). ~67 MB at RGBA8. */
const FINE_DIM = 4096;
/** Coarse full-map texture dimension (square). Always resident; the far-LOD
 *  fallback for huge maps (zoomed out, beyond the fine window). On small/medium
 *  maps the fine window covers the whole map so coarse is barely used; it still
 *  wants enough resolution that the feather edge and far-zoom fallback don't go
 *  blocky. ~16 MB at 2048² RGBA8. */
const COARSE_MAX_DIM = 2048;
const COARSE_MIN_DIM = 1024;

/** Candidate world sizes (elmos) the fine window may cover, smallest first.
 *  The window tracks ~2.5× the visible span and snaps to one of these steps so
 *  zooming only re-bakes when crossing a boundary (hysteresis). At FINE_DIM
 *  4096 these give 0.5 / 1 / 2 / 4 elmos-per-texel respectively. */
const WIN_STEPS = [2048, 4096, 8192, 16384];
/** How far the camera focus may drift from the window centre (as a fraction of
 *  winElmos) before the window re-centers + re-bakes. The window covers ~2.5×
 *  the view, leaving margin so the visible area stays inside between recenters
 *  without re-baking every frame during a pan. */
const RECENTER_FRAC = 0.12;

/** Mark kinds packed into the blit `params.x`. Scars are 0; tracks are
 *  `KIND_TRACK_BASE + category` so the fragment shader picks the per-type tread
 *  pattern without a new attribute. */
const KIND_SCAR = 0;

/** Procedural track-pattern categories. The wire `trackTypeId` indexes the
 *  sorted distinct trackType-name table (built identically on the server and
 *  client); each name maps to one of these patterns. ZK's authored set:
 *  stdtank → TREAD, motorbike → WHEEL, comtrack/crossfoot → FOOT,
 *  chicken* → CLAW. */
const TRACK_TREAD = 0; // tank tread: two continuous ruts + cross-rungs
const TRACK_WHEEL = 1; // wheeled / bike: single narrow continuous rut
const TRACK_FOOT = 2;  // bipedal footprints: discrete alternating feet
const TRACK_CLAW = 3;  // chicken / spider: discrete 3-toe claw splay
/** kind value for a track = KIND_TRACK_BASE + category (so 1..4, never 0). */
const KIND_TRACK_BASE = 1;

/** Map a (lowercased) trackType name to a procedural pattern category.
 *  Keyword-based so unfamiliar games still classify sensibly. */
function classifyTrackType(name: string): number {
    const n = name.toLowerCase();
    if (n.includes('chicken') || n.includes('claw') || n.includes('pointy')) return TRACK_CLAW;
    if (n.includes('foot') || n.includes('com')) return TRACK_FOOT;
    if (n.includes('bike') || n.includes('wheel')) return TRACK_WHEEL;
    return TRACK_TREAD; // tank/tread and anything unrecognised
}

/** Build the sorted distinct lowercased trackType-name table from the unit
 *  defs' `trackType` fields — its index is exactly the wire `trackTypeId` the
 *  server assigns (ServerTrackEmitter sorts the same distinct set the same
 *  way; lowercased-ASCII byte order == JS default string sort). Pass the
 *  result to {@link DecalOverlay.setTrackTypes}. */
export function buildTrackTypeNames(rawTrackTypes: (string | undefined)[]): string[] {
    const set = new Set<string>();
    for (const t of rawTrackTypes) {
        if (t && t.length) set.add(t.toLowerCase());
    }
    return [...set].sort();
}

/** PLAN-decal-vt.md Phase V0 — fade via age-scaled rebuild from a CPU mark
 *  list (the correct "global reset", replacing the disabled running-decay pass
 *  that over-erased). Each mark is held in a ring buffer with its birth time;
 *  periodically each target is cleared and every live mark re-stamped with an
 *  alpha scaled by its age, so old marks fade out and evicted ones vanish. */
const MARK_CAP = 32768;         // ring buffer size; oldest evicted past this
                                // (raised for the ~10 min retention below)
const FADE_REBUILD_S = 3.0;     // how often fade is re-applied when idle (no new
                                // marks). Slow fade → a 3 s cadence is smooth.
const MARK_REBUILD_S = 0.12;    // when new marks arrive, re-bake within this long
                                // (debounce). The overlay is ALWAYS the exact
                                // composite of the mark list — there is no
                                // additive "append" path, so a fresh mark shows
                                // at its true value with no dark over-stamp flash.
const FADE_HOLD_S = 300;        // marks stay full-strength this long (5 min)
const FADE_OUT_S = 300;         // then fade linearly to 0 over this long (5 min)
const FADE_END_S = FADE_HOLD_S + FADE_OUT_S; // fully gone (evicted) at ~10 min

/** Private render layer for the blit mesh. The main scene camera's default
 *  mask (0x0FFFFFFF) excludes this bit, so the full-screen blit quad renders
 *  ONLY into the overlay RTTs (via their own camera) and never paints over the
 *  main view. */
const BLIT_LAYER = 0x20000000;

// Blit vertex shader. The instance matrix places the unit quad in WORLD XZ
// (centre + half-axis columns, in elmos); a per-target uniform maps world XZ to
// that target's UV → clip space. The SAME instance buffer bakes into both the
// coarse full-map texture and the scrolling fine window — only the uniform
// differs — so the mark list is target-independent.
const BLIT_VERT = /* glsl */ `
precision highp float;
attribute vec3 position;    // unit quad, x,y in [-0.5, 0.5], z = 0
attribute vec2 uv;          // [0,1] local
attribute vec4 world0;      // instance matrix col0 = across half-axis (world XZ)
attribute vec4 world1;      // col1 = along half-axis (world XZ)
attribute vec4 world2;
attribute vec4 world3;      // col3 = world centre (X, Z)
attribute vec4 params;      // x=kind y=darkAmp z=depthAmp w=treadFreq/seed
attribute float fade;       // per-instance fade 0..1 (age-scaled on rebuild, 1 fresh)
uniform vec2 uOrigin;       // world XZ of this target's min corner
uniform vec2 uInvExtent;    // 1 / (world extent covered by this target)
varying vec2 vLocalUv;
varying vec4 vParams;
varying float vFade;
void main() {
    mat4 m = mat4(world0, world1, world2, world3);
    vec4 p = m * vec4(position, 1.0);   // p.xy = world X, Z
    vec2 tuv = (p.xy - uOrigin) * uInvExtent;  // target UV [0,1]
    vLocalUv = uv;
    vParams = params;
    vFade = fade;
    gl_Position = vec4(tuv * 2.0 - 1.0, 0.0, 1.0);
}
`;

/** Scar rim raise, as a fraction of the crater's depthAmp (PLAN-decal-tracks
 *  §9 task 3d — deferred from fire 1 until the raise channel existed). A
 *  ratio, not an independent amp, since depthAmp is the only per-scar knob
 *  wired through today (always 0.5 — see addScar). */
const SCAR_RIM_RATIO = 0.45;

// Blit fragment shader. Outputs depression depth (R) + darkening (G) always;
// raise (B) only when the RTT format has a real float B channel (PLAN-
// decal-tracks §3) — the RGBA8 fallback packs depth across R (coarse byte) +
// A (sub-LSB residual) instead, and has no raise field at all.
function buildBlitFrag(hasRaise: boolean): string {
    return /* glsl */ `
precision highp float;
varying vec2 vLocalUv;
varying vec4 vParams;       // x=kind y=darkAmp z=depthAmp w=treadFreq/seed
varying float vFade;        // per-instance age fade 0..1 (scales coverage)

// --- cheap value-noise FBM for procedural crater detail ---
float hash21(vec2 p) {
    p = fract(p * vec2(127.1, 311.7));
    p += dot(p, p + 34.5);
    return fract(p.x * p.y);
}
float vnoise(vec2 p) {
    vec2 i = floor(p), f = fract(p);
    f = f * f * (3.0 - 2.0 * f);
    float a = hash21(i);
    float b = hash21(i + vec2(1.0, 0.0));
    float c = hash21(i + vec2(0.0, 1.0));
    float d = hash21(i + vec2(1.0, 1.0));
    return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
}
float fbm(vec2 p) {
    float v = 0.0, a = 0.5;
    for (int i = 0; i < 4; i++) { v += a * vnoise(p); p *= 2.03; a *= 0.5; }
    return v;
}

// Pressed-in oval depression: 1 inside the oval, 0 outside (we return a 0..1
// mask, sign is handled by the caller). r = (across-radius, along-radius) in
// local quad uv. Used for the discrete footprint / claw shapes.
float ovalMask(vec2 p, vec2 c, vec2 r) {
    vec2 d = (p - c) / r;
    return clamp(1.0 - dot(d, d), 0.0, 1.0);
}
// Bipedal footprint pair: a fore-left + an aft-right oval.
float feetMask(vec2 p) {
    return max(ovalMask(p, vec2(0.37, 0.32), vec2(0.12, 0.20)),
               ovalMask(p, vec2(0.63, 0.72), vec2(0.12, 0.20)));
}
// Chicken / spider claw: three thin toes splayed forward.
float clawMask(vec2 p) {
    float a = ovalMask(p, vec2(0.34, 0.40), vec2(0.05, 0.17));
    float b = ovalMask(p, vec2(0.50, 0.50), vec2(0.05, 0.17));
    float c = ovalMask(p, vec2(0.66, 0.40), vec2(0.05, 0.17));
    return max(max(a, b), c);
}

void main() {
    float kind = vParams.x;
    float darkAmp = vParams.y;    // darkening amplitude (additive → G)
    float depthAmp = vParams.z;   // depression amplitude (additive → R)

    // Depth-field accumulation model (PLAN-decal-vt.md V0): the blit outputs a
    // depression depth (R) + darkening (G), both ADDITIVE, so overlapping marks
    // deepen/darken and saturate at the cap (1.0). The terrain plugin derives
    // the surface normal from the depth field's gradient and synthesises the
    // crater rim — nothing is baked as a signed normal here (a signed encoding
    // can't accumulate additively).
    float depth = 0.0;  // depression magnitude → R
    float dark = 0.0;   // darkening → G
    float raise = 0.0;  // raised rim/berm → B (PLAN-decal-tracks §3/§9 task 3)

    if (kind < 0.5) {
        // SCAR crater: a depression bowl (R) + scorch soot (G) + a raised rim
        // (B) of displaced soil right at the crater edge. The plugin derives
        // the surface normal from raise-minus-depth's gradient, so the pit
        // wall AND the rim ridge both come out of one signed field.
        vec2 c = vLocalUv - 0.5;
        float dist = length(c);
        float r = dist * 2.0;                 // 0 centre .. 1 edge
        float ang = atan(c.y, c.x);
        float seed = vParams.w;               // per-scar random seed

        // Crater edge radius: round with small high-freq crenellation.
        float rimR = 0.45
            + 0.028 * (fbm(vec2(ang * 6.0 + seed * 3.0, seed)) - 0.5)
            + 0.020 * (fbm(vec2(ang * 14.0 + seed, 2.0)) - 0.5)
            + 0.012 * sin(ang * 23.0 + seed);

        // Depression: ~flat floor rising to 0 at the rim, slight floor noise so
        // the bowl isn't glassy.
        float bowl = 1.0 - smoothstep(rimR * 0.55, rimR, r);
        bowl *= 0.85 + 0.30 * (fbm(vec2(ang * 3.0 + seed, r * 9.0)) - 0.5);
        depth = clamp(bowl, 0.0, 1.0) * depthAmp;

        // Scorch soot (darkening): interior core + radial streaks + spatter.
        float core = (1.0 - smoothstep(0.0, rimR * 1.05, r));
        core *= 0.30 + 0.4 * fbm(vec2(ang * 4.0 + seed, r * 5.0));
        float thickSel = smoothstep(0.46, 0.85, fbm(vec2(ang * 24.0 + seed * 7.0, seed)));
        float thinSel  = smoothstep(0.54, 0.92, fbm(vec2(ang * 60.0 + seed * 3.0, seed * 2.0)));
        float lenThick = rimR * (1.5 + 1.5 * fbm(vec2(ang * 24.0 + seed, 4.0)));
        float lenThin  = rimR * (1.15 + 1.1 * fbm(vec2(ang * 60.0 + seed, 9.0)));
        float streaks = thickSel * (1.0 - smoothstep(rimR * 0.28, lenThick, r))
                                 * (0.7 + 0.3 * fbm(vec2(ang * 24.0 + seed * 5.0, 7.0)))
                      + thinSel  * (1.0 - smoothstep(rimR * 0.42, lenThin,  r)) * 0.7;
        streaks = clamp(streaks, 0.0, 1.0);
        float spatter = smoothstep(0.72, 0.93, fbm(vLocalUv * 46.0 + seed * 3.0))
                      * (1.0 - smoothstep(rimR * 0.7, rimR * 2.4, r));
        float scorch = clamp(max(core, max(streaks, spatter * 0.7)), 0.0, 1.0);
        dark = scorch * darkAmp;

        // Raised rim: a ring of displaced soil right at the crater edge,
        // lower and thinner than the bowl is deep. Derived from depthAmp (the
        // only per-scar amp wired through today) via a fixed ratio rather
        // than an independent attribute.
        float rim = smoothstep(rimR * 0.80, rimR * 0.98, r)
                  * (1.0 - smoothstep(rimR * 0.98, rimR * 1.32, r));
        rim *= 0.6 + 0.4 * fbm(vec2(ang * 10.0 + seed * 2.0, r * 6.0));
        raise = clamp(rim, 0.0, 1.0) * depthAmp * ${SCAR_RIM_RATIO};

        if (depth < 0.004 && dark < 0.004 && raise < 0.004) discard;
    } else {
        // TRACK: depression + darkening by category encoded in the kind value
        //   1 = tread, 2 = wheel, 3 = footprint, 4 = claw.
        // A single 0..1 shape mask drives both channels. local uv.x = across
        // width, uv.y = along travel. Tread/wheel are continuous, footprint/claw
        // are DISCRETE (the mask is ~0 between prints, so additive adds nothing
        // there and they read as individual marks).
        float cat    = kind - 1.0;
        float along  = vLocalUv.y;
        float across = vLocalUv.x;
        float freq   = vParams.w;            // rung frequency along travel (tread)

        // Feather across always, feather the along ends only for discrete prints
        // (continuous strips overlap end-to-end, so an end feather would seam).
        float acrossEdge = smoothstep(0.0, 0.08, across) * smoothstep(1.0, 0.92, across);
        float alongEdge  = smoothstep(0.0, 0.04, along)  * smoothstep(1.0, 0.96, along);

        float shape = 0.0;
        if (cat < 0.5) {
            // TWO THIN wheel ruts (one per wheel) with a transparent gap
            // between, so crossing tracks interleave rather than erase. The
            // ruts are narrow (≈ wheel width, not the full track band) and sit
            // at 0.27 / 0.73 across — the spacing between the wheels. Only a
            // faint rung ripple (mostly a smooth line, not a tank-tread ladder).
            float rutL = exp(-pow((across - 0.27) / 0.05, 2.0));
            float rutR = exp(-pow((across - 0.73) / 0.05, 2.0));
            float ruts = clamp(rutL + rutR, 0.0, 1.0);
            float rung = 0.88 + 0.12 * sin(along * freq * 6.2831853);
            shape = acrossEdge * smoothstep(0.10, 0.40, ruts) * rung;
        } else if (cat < 1.5) {
            // WHEEL / bike: a single narrow central rut.
            float d = (across - 0.5) / 0.08;
            float line = clamp(1.0 - d * d, 0.0, 1.0);
            shape = acrossEdge * smoothstep(0.05, 0.30, line);
        } else if (cat < 2.5) {
            // FOOTPRINT: two discrete oval feet.
            shape = acrossEdge * alongEdge * smoothstep(0.05, 0.30, feetMask(vec2(across, along)));
        } else {
            // CLAW: discrete three-toe splay.
            shape = acrossEdge * alongEdge * smoothstep(0.05, 0.30, clawMask(vec2(across, along)));
        }
        depth = shape * depthAmp;
        dark  = shape * darkAmp;
        if (depth < 0.004 && dark < 0.004) discard;
    }

    // Age fade scales the additive contribution, the rebuild re-stamps marks
    // age-scaled so old marks contribute less and recover toward neutral.
    depth *= vFade;
    dark  *= vFade;
    raise *= vFade;
    // Additive (ALPHA_ONEONE): every channel saturates at 1.0 = cap.
    ${hasRaise
        ? '    gl_FragColor = vec4(depth, dark, raise, 0.0); // R=depth G=dark B=raise'
        : `    // §3 fallback (no EXT_color_buffer_float): pack depth across R
    // (coarse byte) + A (sub-LSB residual) for a bit more than 8-bit
    // precision; no raise channel in RGBA8 — berms/rims don't render here.
    float packHi = floor(depth * 255.0) / 255.0;
    float packLo = depth - packHi;
    gl_FragColor = vec4(packHi, dark, 0.0, packLo);`}
}
`;
}

// --- Ribbon path (PLAN-decal-tracks §2) ------------------------------------
// Continuous tracks (tread/wheel) are ONE triangle strip per unit trail instead
// of a chain of overlapping quads: no interior joints to double-stamp (Q1), a
// spline-smooth centreline (Q2), and a world-space arc-length pattern parameter
// that never resets at a joint (Q3). Geometry comes from decal-trails.ts; this
// material is the same additive depth/darkening blit, driven by per-VERTEX
// attributes rather than per-instance quad params.
const RIBBON_VERT = /* glsl */ `
precision highp float;
attribute vec3 position;    // x = world X, y = world Z (elmos), z unused
attribute vec4 ribbon;      // x=across -1..1  y=arc length s (elmos)  z=fade  w=kind
attribute vec3 ribbon2;     // x=width (elmos) y=darkAmp z=depthAmp
uniform vec2 uOrigin;
uniform vec2 uInvExtent;
varying vec4 vRibbon;
varying vec3 vRibbon2;
void main() {
    vec2 tuv = (position.xy - uOrigin) * uInvExtent;
    vRibbon = ribbon;
    vRibbon2 = ribbon2;
    gl_Position = vec4(tuv * 2.0 - 1.0, 0.0, 1.0);
}
`;

/** Ribbon berm/rim raise, as a fraction of the ribbon's depthAmp — mirrors
 *  {@link SCAR_RIM_RATIO}. §4's lug-grid/berm pattern rewrite (task 4) will
 *  replace this with proper artist-tunable content; task 3 just needs the
 *  raise channel genuinely written so the plugin's gradient normal has a
 *  ridge to derive. */
const RIBBON_RAISE_RATIO = 0.5;

function buildRibbonFrag(hasRaise: boolean): string {
    return /* glsl */ `
precision highp float;
varying vec4 vRibbon;       // x=across -1..1  y=s  z=fade  w=kind
varying vec3 vRibbon2;      // x=width y=darkAmp z=depthAmp

void main() {
    float across = vRibbon.x;
    float s      = vRibbon.y;
    float fade   = vRibbon.z;
    float kind   = vRibbon.w;
    float width  = max(1.0, vRibbon2.x);

    // Side feather so the band edge isn't a hard line.
    float edge = 1.0 - smoothstep(0.84, 1.0, abs(across));

    float shape;
    float berm;
    if (kind < 1.5) {
        // TREAD: two ruts at the real gauge, with a rung ripple whose pitch is
        // WORLD-constant (elmos), so rungs keep their spacing and phase through
        // joints and turns — the whole point of keying on s.
        float rutL = exp(-pow((across + 0.46) / 0.10, 2.0));
        float rutR = exp(-pow((across - 0.46) / 0.10, 2.0));
        float ruts = clamp(rutL + rutR, 0.0, 1.0);
        float pitch = max(6.0, width * 0.5);      // elmos between rungs
        float rung = 0.88 + 0.12 * sin(s / pitch * 6.2831853);
        shape = edge * smoothstep(0.10, 0.40, ruts) * rung;
        // Berm ridges along both outer edges + a low centre ridge between the
        // ruts (§4's "classic ladder imprint with pushed-up edges" — the full
        // lug-grid detail is task 4; this is the raise channel's initial content).
        float outerL = exp(-pow((across + 0.86) / 0.10, 2.0));
        float outerR = exp(-pow((across - 0.86) / 0.10, 2.0));
        float centre = exp(-pow(across / 0.14, 2.0)) * 0.5;
        berm = edge * clamp(outerL + outerR + centre, 0.0, 1.0) * rung;
    } else {
        // WHEEL / bike: one narrow central rut, side berms flanking it.
        float d = across / 0.16;
        shape = edge * smoothstep(0.05, 0.30, clamp(1.0 - d * d, 0.0, 1.0));
        float sideL = exp(-pow((across + 0.34) / 0.09, 2.0));
        float sideR = exp(-pow((across - 0.34) / 0.09, 2.0));
        berm = edge * clamp(sideL + sideR, 0.0, 1.0);
    }

    float depth = shape * vRibbon2.z * fade;
    float dark  = shape * vRibbon2.y * fade;
    float raise = berm * vRibbon2.z * ${RIBBON_RAISE_RATIO} * fade;
    if (depth < 0.004 && dark < 0.004 && raise < 0.004) discard;
    ${hasRaise
        ? '    gl_FragColor = vec4(depth, dark, raise, 0.0); // R=depth G=dark B=raise'
        : `    // §3 fallback: pack depth across R (coarse byte) + A (residual);
    // no raise channel in RGBA8 (see buildBlitFrag for the same scheme).
    float packHi = floor(depth * 255.0) / 255.0;
    float packLo = depth - packHi;
    gl_FragColor = vec4(packHi, dark, 0.0, packLo);`}
}
`;
}

/** Per-pass amplitudes for a ribbon (PLAN-decal-tracks §9 task 3c re-tune).
 *  Fire 1 kept these at the old chained-quad values deliberately, to isolate
 *  the Q1 structural fix (no more joint double-stamp) from any amp change —
 *  see the lane notes' note 2. That fix alone makes a trail read slightly
 *  lighter than before (the old joints summed depth twice; the ribbon never
 *  does), so re-tuned up ~20-25% here to land back near the old visual
 *  density minus the joint-artifact spikes. Also now safe to tune freely at
 *  all: float storage (§3) means these small per-pass increments no longer
 *  quantise into visible 8-bit "shelf" steps once the gradient normal
 *  differentiates them (Q5) — unlike the RGBA8 fallback, which still bands.
 *  Unverified against a live render this fire (no live-server mutex held). */
const RIBBON_DARK_AMP = 0.22;
const RIBBON_DEPTH_AMP = 0.075;
/** Floats per ribbon vertex: position(3) + ribbon(4) + ribbon2(3). */
const RIBBON_POS = 3, RIBBON_A = 4, RIBBON_B = 3;

interface PendingMark {
    /** world centre (elmos) */
    cx: number;
    cz: number;
    /** world-space half-axis of the quad's local +X (across), elmos */
    axx: number;
    axz: number;
    /** world-space half-axis of the quad's local +Y (along), elmos */
    azx: number;
    azz: number;
    kind: number;
    /** Darkening amplitude added to G (additive; capped at 1.0 in-texture). */
    darkAmp: number;
    /** Depression depth amplitude added to R (additive; capped at 1.0). */
    depthAmp: number;
    treadFreq: number;
    /** Per-instance fade 0..1 (coverage multiplier). Undefined = 1 (fresh). Set
     *  by the rebuild from the mark's age; fresh appends leave it 1. */
    fade?: number;
}

/** A mark retained in the ring buffer so the overlay can be rebuilt from it
 *  (age-scaled) for fade — see MARK_CAP / FADE_* and getRebuildBatch(). It is
 *  exactly the blit's PendingMark plus the birth timestamp. */
interface StoredMark extends PendingMark {
    birth: number; // value of this.elapsed (seconds) when laid
}

/** Per-target bake state. Coarse covers the whole map (static origin); fine is
 *  the camera-tracking window (origin/extent move; re-baked on recenter). */
interface TargetState {
    rtt: RenderTargetTexture;
    /** world XZ of the target's min corner */
    originX: number;
    originZ: number;
    /** world extent covered (elmos) — coarse: (worldW, worldH); fine: square */
    extentX: number;
    extentZ: number;
    /** queued full clear-then-restamp (fade rebuild, or fine recenter) */
    rebuild: boolean;
    /** consumed by the RTT onClear: clear to neutral for exactly one render */
    clearNext: boolean;
}

/** Live fine-window state the terrain plugin reads each frame to decide where
 *  to sample fine vs coarse. Shared by reference with the plugin so no per-frame
 *  uniform plumbing is needed through DecalOverlay. */
export interface FineWindowState {
    originX: number;
    originZ: number;
    /** square window extent (elmos); 0 when disabled */
    extent: number;
    /** 1 = fine window valid, 0 = use coarse only (far zoom / window ≥ map) */
    enabled: number;
    /** 1 = overlay RTTs are float R11F_G11F_B10F with a real B raise channel;
     *  0 = RGBA8 fallback (§3) — no raise, depth packed R+A. Set once at
     *  construction (never changes); the plugin reads it to gate raise
     *  sampling and the R+A depth reconstruction. */
    hasRaise: number;
}

export class DecalOverlay {
    private scene: Scene;
    private coarse: TargetState;
    private fine: TargetState;
    private coarseDim: number;
    private rttCamera: FreeCamera;
    private blitMesh: Mesh;
    private blitMat: ShaderMaterial;
    /** Set when a new mark was laid since the last re-bake — tick() then
     *  schedules a (debounced) re-bake. Replaces the old additive append path. */
    private dirty = false;
    /** Per-`trackTypeId` procedural pattern category (index == wire
     *  trackTypeId). Empty until {@link setTrackTypes} is called; an unknown
     *  id then falls back to TREAD. */
    private trackCategories: number[] = [];
    /** Continuous (tread/wheel) tracks as per-unit polyline trails, baked as
     *  ribbons instead of chained quads (PLAN-decal-tracks §2). */
    private trailStore = new TrailStore();
    private ribbonMesh: Mesh;
    private ribbonMat: ShaderMaterial;
    /** Persistent ribbon geometry buffers (grown on demand, never per frame). */
    private ribbonVerts = new Float32Array(0);
    private ribbonAttrA = new Float32Array(0);
    private ribbonAttrB = new Float32Array(0);
    private ribbonIdx = new Uint32Array(0);
    /** Built once per frame (both targets share it), like frameRebuildBatch. */
    private frameRibbonBuilt = false;
    private ribbonIndexCount = 0;
    /** world extent in elmos. */
    private worldW = 1;
    private worldH = 1;
    /** Wall-clock seconds since construction (advanced by tick); marks store
     *  their birth time against this so the rebuild can age-fade them. */
    private elapsed = 0;
    /** Ring buffer of every live mark, for the age-scaled rebuild (fade). */
    private marks: StoredMark[] = [];
    private sinceRebuild = 0;
    /** Memoised age-scaled batch for the current frame (built once even when
     *  both targets rebuild the same frame); reset after the fine target draws. */
    private frameRebuildBatch: PendingMark[] | null = null;
    /** Master switch for the fade rebuild. On = the global reset runs. */
    fadeEnabled = true;
    private disposed = false;
    /** Reusable uniform vectors (avoid per-frame allocation in onBeforeRender). */
    private uOrigin = new Vector2(0, 0);
    private uInvExtent = new Vector2(1, 1);
    /** Shared with the terrain plugin (by reference) — updated each tick. */
    readonly fineState: FineWindowState = { originX: 0, originZ: 0, extent: 0, enabled: 0, hasRaise: 0 };
    /** RTT pixel format decided once at construction (PLAN-decal-tracks §3). */
    private formatChoice: OverlayFormat;

    constructor(scene: Scene, worldWidthElmos: number, worldHeightElmos: number) {
        this.scene = scene;
        this.worldW = Math.max(1, worldWidthElmos);
        this.worldH = Math.max(1, worldHeightElmos);

        const caps = scene.getEngine().getCaps();
        this.formatChoice = chooseOverlayFormat({ colorBufferFloat: !!caps.colorBufferFloat });
        this.fineState.hasRaise = this.formatChoice.hasRaise ? 1 : 0;
        if (!this.formatChoice.hasRaise) {
            // Loud, not silent (§3): this path drops the raise channel
            // entirely (no berms, no scar rims) and depth precision is
            // reduced to an 8-bit-coarse + residual pack instead of a real
            // float channel.
            console.warn(
                '[decals] EXT_color_buffer_float unavailable — falling back to the RGBA8 ' +
                'decal overlay (PLAN-decal-tracks §3): no raise channel (no berms/scar rims), ' +
                'reduced depth precision. A WebGL2 driver with float colour-buffer rendering ' +
                'restores full decal quality.',
            );
        }

        // Coarse: whole map at low res. Density ~ map/16, clamped — it's only
        // the far/outside-window fallback, so it can be coarse.
        this.coarseDim = Math.min(
            COARSE_MAX_DIM,
            Math.max(COARSE_MIN_DIM, ceilPow2(Math.max(this.worldW, this.worldH) / 8)),
        );

        this.coarse = this.makeTarget('decalCoarse', this.coarseDim, 0, 0, this.worldW, this.worldH);
        // Fine starts disabled (extent 0); updateWindow sizes + centres it on
        // the first tick that supplies a camera focus.
        this.fine = this.makeTarget('decalFine', FINE_DIM, 0, 0, WIN_STEPS[0], WIN_STEPS[0]);

        this.blitMat = new ShaderMaterial(
            'decalBlit', scene,
            { vertexSource: BLIT_VERT, fragmentSource: buildBlitFrag(this.formatChoice.hasRaise) },
            {
                attributes: ['position', 'uv', 'world0', 'world1', 'world2', 'world3', 'params', 'fade'],
                uniforms: ['uOrigin', 'uInvExtent'],
                needAlphaBlending: true,
            },
        );
        this.blitMat.backFaceCulling = false;
        // Additive: R += depth, G += darkening. Overlapping marks sum (deepen /
        // darken) and saturate at 1.0 = the cap. Fade comes from the age-scaled
        // rebuild (additive can't subtract over time), not this blend.
        this.blitMat.alphaMode = Constants.ALPHA_ONEONE;

        this.ribbonMat = new ShaderMaterial(
            'decalRibbon', scene,
            { vertexSource: RIBBON_VERT, fragmentSource: buildRibbonFrag(this.formatChoice.hasRaise) },
            {
                attributes: ['position', 'ribbon', 'ribbon2'],
                uniforms: ['uOrigin', 'uInvExtent'],
                needAlphaBlending: true,
            },
        );
        this.ribbonMat.backFaceCulling = false;
        this.ribbonMat.alphaMode = Constants.ALPHA_ONEONE;
        this.ribbonMesh = new Mesh('decalRibbonStrip', scene);
        this.ribbonMesh.material = this.ribbonMat;
        this.ribbonMesh.isPickable = false;
        this.ribbonMesh.alwaysSelectAsActiveMesh = true;
        this.ribbonMesh.layerMask = BLIT_LAYER;
        this.ribbonMesh.isVisible = false;

        this.blitMesh = buildUnitQuadXY(scene, 'decalBlitQuad');
        this.blitMesh.material = this.blitMat;
        this.blitMesh.isPickable = false;
        this.blitMesh.alwaysSelectAsActiveMesh = true; // never frustum-cull
        this.blitMesh.layerMask = BLIT_LAYER;
        this.blitMesh.thinInstanceCount = 0;

        // One camera for both RTTs (the blit shader outputs clip space directly,
        // so the camera transform is irrelevant — only its layerMask matters).
        this.rttCamera = new FreeCamera('decalRttCam', Vector3.Zero(), scene);
        this.rttCamera.layerMask = BLIT_LAYER;

        // Coarse renders FIRST, fine SECOND (array order). Each re-bakes (or
        // skips) the shared mesh in its own onBeforeRender; since renders are
        // sequential, the shared mesh/material is reused per target. The fine
        // (last) target releases the per-frame rebuild batch in onAfterRender.
        this.attachTargetRender(this.coarse, false);
        this.attachTargetRender(this.fine, true);
        scene.customRenderTargets.push(this.coarse.rtt);
        scene.customRenderTargets.push(this.fine.rtt);
    }

    private makeTarget(
        name: string, dim: number,
        originX: number, originZ: number, extentX: number, extentZ: number,
    ): TargetState {
        const rtt = new RenderTargetTexture(
            name, dim, this.scene,
            {
                generateMipMaps: false,
                type: this.formatChoice.type,
                format: this.formatChoice.format,
                samplingMode: Texture.BILINEAR_SAMPLINGMODE,
            },
        );
        rtt.wrapU = Texture.CLAMP_ADDRESSMODE;
        rtt.wrapV = Texture.CLAMP_ADDRESSMODE;
        // Neutral overlay value: (0,0,0,0) = no depression, no darkening
        // (the depth-field accumulation model — additive, so neutral is zero).
        rtt.clearColor = new Color4(0.0, 0.0, 0.0, 0.0);
        const t: TargetState = {
            rtt, originX, originZ, extentX, extentZ, rebuild: false, clearNext: true,
        };
        // The target is normally persistent (append-only, no per-frame clear).
        // It clears ONLY on flagged frames — frame 0 (init to neutral) and each
        // rebuild (fade, or fine recenter). prepareTarget sets clearNext.
        rtt.onClearObservable.add(() => {
            if (!t.clearNext) return; // persistent: skip the clear
            t.clearNext = false;
            this.scene.getEngine().clear(rtt.clearColor, true, true, true);
        });
        // NOTE: renderList is set in attachTargetRender, NOT here — makeTarget
        // runs before blitMesh exists, so assigning [this.blitMesh] here would
        // bake an [undefined] render list and the RTT would draw nothing.
        return t;
    }

    private attachTargetRender(t: TargetState, isLast: boolean): void {
        // Set the render list here (after blitMesh is constructed) — see the
        // note in makeTarget about the init-order trap.
        t.rtt.renderList = [this.blitMesh, this.ribbonMesh];
        t.rtt.activeCamera = this.rttCamera;
        t.rtt.onBeforeRenderObservable.add(() => this.prepareTarget(t));
        t.rtt.onAfterRenderObservable.add(() => {
            this.blitMesh.thinInstanceCount = 0;
            this.ribbonMesh.isVisible = false;
            // Both targets have consumed this frame's rebuild batch (if any).
            if (isLast) { this.frameRebuildBatch = null; this.frameRibbonBuilt = false; }
        });
    }

    /** The coarse full-map texture (far/outside-window fallback). */
    get coarseTexture(): RenderTargetTexture { return this.coarse.rtt; }
    /** The fine camera-window texture (sharp near-camera decals). */
    get fineTexture(): RenderTargetTexture { return this.fine.rtt; }
    /** 1 / coarse texture dimension (texel size for the gradient-normal taps). */
    get coarseTexel(): number { return 1 / this.coarseDim; }
    /** 1 / fine texture dimension. */
    get fineTexel(): number { return 1 / FINE_DIM; }
    /** True when the overlay RTTs are float R11F_G11F_B10F with a real raise
     *  channel; false in the RGBA8 fallback (§3 — no berms/scar rims). */
    get hasRaiseChannel(): boolean { return this.formatChoice.hasRaise; }

    /** Supply the sorted track-type-name table (index == wire trackTypeId;
     *  see {@link buildTrackTypeNames}). */
    setTrackTypes(names: string[]): void {
        this.trackCategories = names.map(classifyTrackType);
    }

    /** Per-frame tick: advance the clock, schedule the periodic fade rebuild,
     *  and track the camera window. `focusX/focusZ` = ground point under the
     *  camera (elmos); `camHeight` = camera height above that point (elmos),
     *  used to size the window. The RTTs render via Babylon's
     *  customRenderTargets pump. */
    tick(dtSeconds: number, focusX?: number, focusZ?: number, camHeight?: number): void {
        if (this.disposed) return;
        this.elapsed += dtSeconds;
        this.sinceRebuild += dtSeconds;
        this.trailStore.tick(dtSeconds);
        // Re-bake the whole overlay from the mark list either when new marks
        // arrived (debounced by MARK_REBUILD_S so a burst coalesces into one
        // re-bake) or periodically to advance the fade. Each re-bake is a clean
        // clear-then-composite, so the texture is exactly the live mark list —
        // no additive carry-over, no transient over-darkening.
        const dirtyReady = this.dirty && this.sinceRebuild >= MARK_REBUILD_S;
        const fadeReady = this.fadeEnabled && this.sinceRebuild >= FADE_REBUILD_S;
        if (dirtyReady || fadeReady) {
            this.sinceRebuild = 0;
            this.dirty = false;
            this.trailStore.retire();
            this.coarse.rebuild = true;
            this.fine.rebuild = true;
        }
        if (focusX !== undefined && focusZ !== undefined && camHeight !== undefined) {
            this.updateWindow(focusX, focusZ, camHeight);
        }
    }

    /** Size + re-centre the fine window from the camera.
     *
     *  Three regimes:
     *   - **covers-map**: the view (or the smallest covering step) spans the
     *     whole map → the fine window simply covers the map, map-centred, at
     *     FINE_DIM (a sharp full-map overlay; never recenters). This is the
     *     common case for small/medium maps and the old single-overlay's job.
     *   - **camera-tracking**: zoomed in enough that a sub-map window is sharper
     *     → a WIN_STEPS-sized window snapped to the texel grid, re-baked when the
     *     focus drifts past RECENTER_FRAC of the window (zoom hysteresis).
     *   - **disabled**: huge map zoomed so far out that even the largest window
     *     can't cover the view → coarse only. */
    private updateWindow(focusX: number, focusZ: number, camHeight: number): void {
        // Rough visible ground span ≈ 2× camera height (≈45° FOV). Window covers
        // ~2.5× that so there's pan margin before a recenter.
        const viewSpan = Math.max(1, camHeight) * 2.0;
        const want = viewSpan * 2.5;
        const mapMax = Math.max(this.worldW, this.worldH);
        const maxStep = WIN_STEPS[WIN_STEPS.length - 1];

        // Can't cover the view sharply (huge map, zoomed way out) → coarse only.
        if (want > maxStep && mapMax > maxStep) {
            if (this.fineState.enabled !== 0) this.fineState.enabled = 0;
            return;
        }

        let win: number;
        let coversMap: boolean;
        if (want >= mapMax) {
            // The needed window spans the map — just cover the map exactly
            // (unquantised: it never recenters, so hysteresis is moot, and an
            // exact fit maximises resolution: texel = mapMax / FINE_DIM).
            win = mapMax;
            coversMap = true;
        } else {
            win = WIN_STEPS.find(s => s >= want) ?? maxStep;
            coversMap = win >= mapMax;
            if (coversMap) win = mapMax;
        }

        let recenter = win !== this.fine.extentX || this.fineState.enabled === 0;
        if (coversMap) {
            // Centre the square window on the map (origin may be negative when
            // the map is non-square / smaller than the window — harmless; the
            // off-map margin just goes unused).
            if (recenter) {
                this.fine.originX = (this.worldW - win) * 0.5;
                this.fine.originZ = (this.worldH - win) * 0.5;
            }
        } else {
            const texel = win / FINE_DIM;
            const half = win * 0.5;
            const cx = this.fine.originX + this.fine.extentX * 0.5;
            const cz = this.fine.originZ + this.fine.extentZ * 0.5;
            const drift = Math.max(Math.abs(focusX - cx), Math.abs(focusZ - cz));
            if (drift > RECENTER_FRAC * win) recenter = true;
            if (recenter) {
                // Snap the origin to the texel grid so it doesn't shimmer sub-texel.
                this.fine.originX = Math.round((focusX - half) / texel) * texel;
                this.fine.originZ = Math.round((focusZ - half) / texel) * texel;
            }
        }

        if (recenter) {
            this.fine.extentX = win;
            this.fine.extentZ = win;
            this.fine.rebuild = true;
        }

        this.fineState.originX = this.fine.originX;
        this.fineState.originZ = this.fine.originZ;
        this.fineState.extent = win;
        this.fineState.enabled = 1;
    }

    /** Age → coverage multiplier: full strength until FADE_HOLD_S, then linear
     *  to 0 at FADE_END_S. Marks past FADE_END_S are dropped by the rebuild. */
    private fadeFor(age: number): number {
        if (age <= FADE_HOLD_S) return 1;
        if (age >= FADE_END_S) return 0;
        return 1 - (age - FADE_HOLD_S) / FADE_OUT_S;
    }

    /** Record a mark for the age-scaled rebuild, evicting the oldest past the
     *  ring-buffer cap. */
    private remember(m: PendingMark): void {
        this.marks.push({ ...m, birth: this.elapsed });
        if (this.marks.length > MARK_CAP) this.marks.shift();
    }

    /** Lay a mark: retain it in the ring buffer and flag the overlay dirty so
     *  the next tick re-bakes the composite (there is no separate append path —
     *  the texture is always exactly the composited mark list). */
    private emit(m: PendingMark): void {
        this.remember(m);
        this.dirty = true;
    }

    onSnapshot(scars: ScarEvent[], tracks: TrackSegmentEvent[] = []): void {
        for (const s of scars) this.addScar(s);
        for (const t of tracks) this.addTrack(t);
    }

    private addScar(ev: ScarEvent): void {
        // Pad the stamp beyond the crater radius so the rim lip + soot streaks
        // / spatter (which reach ~2.1× the rim in the shader) aren't clipped at
        // the quad edge. The shader places the lip at r≈0.44, so PAD≈2.2 keeps
        // the effective crater radius ≈ ev.radius and gives the blast room.
        const PAD = 2.2;
        const h = ev.radius * PAD; // square half-extent in WORLD elmos (isotropic)
        this.emit({
            cx: ev.x,
            cz: ev.z,
            // Axis-aligned square in world space (no rotation — pattern variety
            // comes from the per-scar `seed`, not quad rotation; the depth field
            // is a scalar so a rotated quad would gain nothing).
            axx: h, axz: 0,
            azx: 0, azz: h,
            kind: KIND_SCAR,
            // Per-scar darkening + depression amplitudes (additive into G/R).
            // ~0.5 each: one scar reads clearly, two overlapping reach the cap
            // (deeper/darker pit). Scar darkening is heavier than tracks.
            darkAmp: Math.min(0.6, (ev.alpha > 0 ? ev.alpha : 0.85) * 0.6),
            depthAmp: 0.5,
            treadFreq: Math.random() * 100, // per-scar seed for crater noise
        });
    }

    private addTrack(ev: TrackSegmentEvent): void {
        const w = ev.width > 0 ? ev.width : 24;
        const cat = this.trackCategories[ev.trackTypeId] ?? TRACK_TREAD;
        // kind carries the pattern category (1=tread, 2=wheel, 3=foot, 4=claw)
        // so the shader picks the right mark for the unit type.
        const kind = KIND_TRACK_BASE + cat;

        if (cat === TRACK_TREAD || cat === TRACK_WHEEL) {
            // CONTINUOUS tracks feed the unit's trail polyline; the bake draws
            // the whole trail as one ribbon (PLAN-decal-tracks §2), so there
            // are no per-segment quads and no joints to double-stamp.
            if (this.trailStore.append(ev.unitId, ev.x, ev.z, ev.trackTypeId, w)) {
                this.dirty = true;
            }
            return;
        }

        // DISCRETE prints (foot / claw): one square stamp per segment, oriented
        // along travel. The shapes tile across abutting stamps into a trail; we
        // want them individual, so no segment-connecting here.
        const halfW = w * 0.5;
        // Travel direction (along = local +Y); across ⟂ travel = (dirZ,-dirX).
        let tx = ev.dirX, tz = ev.dirZ;
        const dl = Math.hypot(tx, tz);
        if (dl > 1e-4) { tx /= dl; tz /= dl; } else { tx = 0; tz = 1; }
        this.emit({
            cx: ev.x,
            cz: ev.z,
            axx: tz * halfW, axz: -tx * halfW,
            azx: tx * halfW, azz: tz * halfW,
            kind,
            // Bot footprints / spider claws: ~vehicle-level darkening (not
            // darker), a touch more depression so the discrete prints stay
            // legible. Discrete marks rarely overlap, so they stay light.
            darkAmp: 0.18,
            depthAmp: 0.1,
            treadFreq: 4.0,
        });
    }

    /** Close a unit's trail when it dies (PLAN-decal-tracks §8 E2 / P-d): its
     *  ribbon stops growing and fades out, and a reused id starts fresh. */
    onEntityDestroy(unitId: number): void {
        this.trailStore.close(unitId);
    }

    /** Build (once per frame) the age-scaled batch of all live marks, pruning
     *  fully-faded ones from the ring buffer. Memoised so both targets rebuilding
     *  the same frame share it. */
    private getRebuildBatch(): PendingMark[] {
        if (this.frameRebuildBatch) return this.frameRebuildBatch;
        const live: StoredMark[] = [];
        const batch: PendingMark[] = [];
        for (const mk of this.marks) {
            const f = this.fadeFor(this.elapsed - mk.birth);
            if (f <= 0) continue; // expired → evicted by omission
            live.push(mk);
            batch.push({ ...mk, fade: f });
        }
        this.marks = live;
        this.frameRebuildBatch = batch;
        return batch;
    }

    /** Set the mesh's instance buffer + this target's world→clip uniform just
     *  before the target's RTT draws. When this target is flagged for re-bake,
     *  clear it and stamp the WHOLE live mark list (age-scaled, expired dropped)
     *  in one additive pass — the texture becomes exactly the composited list.
     *  Otherwise draw nothing: the target persists its last re-bake. */
    private prepareTarget(t: TargetState): void {
        if (t.rebuild) {
            t.rebuild = false;
            t.clearNext = true;          // onClear wipes to neutral first
            // Per-target world→clip transform (the only thing that differs
            // between the coarse full-map texture and the scrolling fine window).
            this.uOrigin.set(t.originX, t.originZ);
            this.uInvExtent.set(1 / t.extentX, 1 / t.extentZ);
            this.blitMat.setVector2('uOrigin', this.uOrigin);
            this.blitMat.setVector2('uInvExtent', this.uInvExtent);
            this.ribbonMat.setVector2('uOrigin', this.uOrigin);
            this.ribbonMat.setVector2('uInvExtent', this.uInvExtent);
            this.uploadBatch(this.getRebuildBatch());
            this.buildRibbons();
            this.ribbonMesh.isVisible = this.ribbonIndexCount > 0;
        } else {
            this.uploadBatch([]);        // nothing to draw — texture persists
            this.ribbonMesh.isVisible = false;
        }
    }

    /** Tessellate every live trail into one shared triangle-strip mesh (once
     *  per frame, shared by both targets). Each station contributes two
     *  vertices at centre ± normal·halfWidth; consecutive stations form a quad
     *  from those SAME vertices, so a trail has no interior seam to double-add
     *  (Q1) and the pattern parameter `s` runs continuously along it (Q3). */
    private buildRibbons(): void {
        if (this.frameRibbonBuilt) return;
        this.frameRibbonBuilt = true;

        const fade = (birth: number) => this.trailStore.fadeAt(birth);
        const trails = this.trailStore.drawable();
        const strips: { stations: ReturnType<typeof tessellateTrail>; halfW: number; kind: number }[] = [];
        let stationCount = 0;
        for (const t of trails) {
            const st = tessellateTrail(t, fade);
            if (st.length < 2) continue;
            const cat = this.trackCategories[t.trackTypeId] ?? TRACK_TREAD;
            strips.push({ stations: st, halfW: t.width * 0.5, kind: KIND_TRACK_BASE + cat });
            stationCount += st.length;
        }

        const vertCount = stationCount * 2;
        const idxCount = (stationCount - strips.length) * 6; // (n-1) quads per strip
        this.ribbonIndexCount = Math.max(0, idxCount);
        if (vertCount === 0 || idxCount <= 0) {
            this.ribbonIndexCount = 0;
            return;
        }
        this.growRibbonBuffers(vertCount, idxCount);

        const pos = this.ribbonVerts, a = this.ribbonAttrA, b = this.ribbonAttrB, idx = this.ribbonIdx;
        let v = 0, ii = 0;
        for (const strip of strips) {
            const base = v;
            for (const p of strip.stations) {
                for (let side = 0; side < 2; side++) {
                    const across = side === 0 ? -1 : 1;
                    const o3 = v * RIBBON_POS, o4 = v * RIBBON_A, o2 = v * RIBBON_B;
                    pos[o3] = p.x + p.nx * strip.halfW * across;
                    pos[o3 + 1] = p.z + p.nz * strip.halfW * across;
                    pos[o3 + 2] = 0;
                    a[o4] = across; a[o4 + 1] = p.s; a[o4 + 2] = p.fade; a[o4 + 3] = strip.kind;
                    b[o2] = strip.halfW * 2; b[o2 + 1] = RIBBON_DARK_AMP; b[o2 + 2] = RIBBON_DEPTH_AMP;
                    v++;
                }
            }
            ii = writeRibbonIndices(strip.stations.length, base, idx, ii);
        }

        this.ribbonMesh.setVerticesData('position', pos.subarray(0, vertCount * RIBBON_POS), true, RIBBON_POS);
        this.ribbonMesh.setVerticesData('ribbon', a.subarray(0, vertCount * RIBBON_A), true, RIBBON_A);
        this.ribbonMesh.setVerticesData('ribbon2', b.subarray(0, vertCount * RIBBON_B), true, RIBBON_B);
        this.ribbonMesh.setIndices(idx.subarray(0, ii), vertCount, true);
    }

    /** Grow the persistent ribbon buffers to fit (never shrink — steady-state
     *  rebuilds then allocate nothing). */
    private growRibbonBuffers(verts: number, indices: number): void {
        if (this.ribbonVerts.length < verts * RIBBON_POS) {
            this.ribbonVerts = new Float32Array(verts * RIBBON_POS);
            this.ribbonAttrA = new Float32Array(verts * RIBBON_A);
            this.ribbonAttrB = new Float32Array(verts * RIBBON_B);
        }
        if (this.ribbonIdx.length < indices) this.ribbonIdx = new Uint32Array(indices);
    }

    /** Upload a batch of marks as thin instances of the unit quad. */
    private uploadBatch(batch: PendingMark[]): void {
        const n = batch.length;
        if (n === 0) { this.blitMesh.thinInstanceCount = 0; return; }

        const matrices = new Float32Array(n * 16);
        const params = new Float32Array(n * 4);
        const fades = new Float32Array(n);
        for (let i = 0; i < n; i++) {
            const m = batch[i];
            const o = i * 16;
            // Column-major mat4 (Babylon thin-instance layout). The unit quad
            // spans [-0.5,0.5], so a column of length L gives half-extent L/2 —
            // hence the ×2 on the world half-axes. col0=across, col1=along,
            // col3=world centre (X,Z). The vertex shader maps world XZ → target
            // UV via uOrigin/uInvExtent.
            matrices[o + 0] = m.axx * 2; matrices[o + 1] = m.axz * 2; matrices[o + 2] = 0; matrices[o + 3] = 0;
            matrices[o + 4] = m.azx * 2; matrices[o + 5] = m.azz * 2; matrices[o + 6] = 0; matrices[o + 7] = 0;
            matrices[o + 8] = 0;  matrices[o + 9] = 0;  matrices[o + 10] = 1; matrices[o + 11] = 0;
            matrices[o + 12] = m.cx; matrices[o + 13] = m.cz; matrices[o + 14] = 0; matrices[o + 15] = 1;

            params[i * 4 + 0] = m.kind;
            params[i * 4 + 1] = m.darkAmp;
            params[i * 4 + 2] = m.depthAmp;
            params[i * 4 + 3] = m.treadFreq;
            fades[i] = m.fade ?? 1;
        }
        this.blitMesh.thinInstanceSetBuffer('matrix', matrices, 16, true);
        this.blitMesh.thinInstanceSetBuffer('params', params, 4, true);
        this.blitMesh.thinInstanceSetBuffer('fade', fades, 1, true);
        this.blitMesh.thinInstanceCount = n;
    }

    dispose(): void {
        this.disposed = true;
        for (const t of [this.coarse, this.fine]) {
            const idx = this.scene.customRenderTargets.indexOf(t.rtt);
            if (idx >= 0) this.scene.customRenderTargets.splice(idx, 1);
            t.rtt.dispose();
        }
        this.blitMesh.dispose();
        this.blitMat.dispose();
        this.ribbonMesh.dispose();
        this.ribbonMat.dispose();
        this.rttCamera.dispose();
        this.marks = [];
        this.trailStore.clear();
    }
}

/** Unit quad in the XY plane, centred at origin, uv [0,1]. */
function buildUnitQuadXY(scene: Scene, name: string): Mesh {
    const mesh = new Mesh(name, scene);
    const positions = new Float32Array([
        -0.5, -0.5, 0,
         0.5, -0.5, 0,
         0.5,  0.5, 0,
        -0.5,  0.5, 0,
    ]);
    const uvs = new Float32Array([0, 0, 1, 0, 1, 1, 0, 1]);
    const indices = new Uint32Array([0, 1, 2, 0, 2, 3]);
    const vd = new VertexData();
    vd.positions = positions;
    vd.uvs = uvs;
    vd.indices = indices;
    vd.applyToMesh(mesh);
    return mesh;
}

function ceilPow2(v: number): number {
    let p = 1;
    while (p < v) p <<= 1;
    return p;
}
