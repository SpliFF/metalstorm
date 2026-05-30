/**
 * DecalOverlay — persistent baked ground-decal system (PLAN-decals.md D7).
 *
 * Replaces the per-frame instanced decal quads with a single map-sized
 * accumulation texture. Each scar / track event is blitted **once** into the
 * overlay and then forgotten; the terrain samples the overlay every frame
 * through a Babylon material plugin. Per-frame cost is ~free and the mark
 * count is unbounded.
 *
 * We bake the *normal perturbation + albedo disturbance*, NOT baked lighting,
 * so the terrain lights the perturbed normal live — sun movement re-shades
 * the grooves for free while marks stay one-time blits.
 *
 * Overlay channels (RGBA8):
 *   R,G  tangent-space normal offset, 0.5 = flat   (terrain perturbs N by this)
 *   B    albedo disturbance / darkening 0..1        (terrain darkens albedo)
 *   A    spare (unused; accumulates coverage)
 * Init/neutral = (0.5, 0.5, 0, 0).
 *
 * Marks blit with alpha-over by coverage: recent mark wins on overlap, no
 * additive drift, saturates gracefully. A slow global decay pass lerps the
 * whole overlay back toward neutral over minutes.
 *
 * Accumulation mechanics: a single persistent RenderTargetTexture whose
 * per-frame clear is suppressed (no-op onClearObservable). A blit mesh holds
 * *this frame's* new marks as thin instances; after the RTT renders them the
 * instance count is reset to 0, so prior content persists untouched.
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
    Vector3,
} from '@babylonjs/core';
import type { ScarEvent, TrackSegmentEvent } from './decal-events.js';

/** Target overlay resolution; density is chosen so typical maps land near
 *  this and it's clamped here for huge maps. Crater detail (rim wobble, ejecta
 *  rays, floor roughness) needs the texels — at 2048² over a 17 k-elmo map a
 *  scar was only ~75 px across and read blocky.
 *
 *  TEMPORARY: raised 4096→8192 to halve the elmos/texel on very large maps
 *  (sharper tracks/scars) until the camera-clipmap lands — see
 *  PLAN-decal-vt.md. Cost: the overlay RTT is ~256 MB at 8192² RGBA8 (vs
 *  ~67 MB at 4096²), allocated regardless of how much of the map has decals.
 *  The clipmap replaces this with a ~71 MB bounded cache. */
const OVERLAY_MAX_DIM = 8192;
/** Don't go below this even for tiny maps (keeps marks from being chunky). */
const OVERLAY_MIN_DIM = 512;

/** Mark kinds packed into the blit `params.x`. Scars are 0; the neutral
 *  fill/decay quad is -1; tracks are `KIND_TRACK_BASE + category` so the
 *  fragment shader picks the per-type tread pattern without a new attribute. */
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
 *  periodically the overlay is cleared and every live mark re-stamped with an
 *  alpha scaled by its age, so old marks fade out and evicted ones vanish.
 *
 *  This is the foundation the V1 clipmap re-bake builds on. The accumulation /
 *  depth-field model (overlapping craters deepen, capped) is a separate later
 *  V0 step; this step keeps the existing alpha-over compositing. */
const MARK_CAP = 8192;          // ring buffer size; oldest evicted past this
const REBUILD_INTERVAL_S = 1.0; // how often fade is re-applied (rebuild cadence)
const FADE_HOLD_S = 45;         // marks stay full-strength this long
const FADE_OUT_S = 45;          // then fade linearly to 0 over this long
const FADE_END_S = FADE_HOLD_S + FADE_OUT_S; // mark fully gone (evicted) after

/** Private render layer for the blit mesh. The main scene camera's default
 *  mask (0x0FFFFFFF) excludes this bit, so the full-screen blit quad renders
 *  ONLY into the overlay RTT (via its own camera) and never paints over the
 *  main view. */
const BLIT_LAYER = 0x20000000;

// Blit vertex shader. Camera-independent: the per-instance matrix places the
// unit quad directly in overlay UV space [0,1]; we map that to clip space.
const BLIT_VERT = /* glsl */ `
precision highp float;
attribute vec3 position;   // unit quad, x,y in [-0.5, 0.5], z = 0
attribute vec2 uv;          // [0,1] local
attribute vec4 world0;
attribute vec4 world1;
attribute vec4 world2;
attribute vec4 world3;
attribute vec4 params;      // x=kind y=disturbance z=normalStrength w=treadFreq
attribute float fade;       // per-instance fade 0..1 (age-scaled on rebuild; 1 fresh)
varying vec2 vLocalUv;
varying vec4 vParams;
varying float vFade;
// World-XZ unit directions of the quad's local axes. The overlay maps 1:1 to
// world XZ, so the instance matrix's X/Y columns ARE the across/along world
// directions. Tracks bake their tread relief in this WORLD frame so a rotated
// (travel-aligned) quad still lights correctly — otherwise the local-frame
// normal written into the world-space RG channels would be mis-oriented.
varying vec2 vAcross;       // world-XZ dir of local +X (across the track)
varying vec2 vAlong;        // world-XZ dir of local +Y (along travel)
void main() {
    mat4 m = mat4(world0, world1, world2, world3);
    vec4 p = m * vec4(position, 1.0);   // p.xy in overlay UV space [0,1]
    vLocalUv = uv;
    vParams = params;
    vFade = fade;
    vAcross = normalize(vec2(world0.x, world0.y) + vec2(1e-6, 0.0));
    vAlong  = normalize(vec2(world1.x, world1.y) + vec2(0.0, 1e-6));
    gl_Position = vec4(p.xy * 2.0 - 1.0, 0.0, 1.0);
}
`;

// Blit fragment shader. Outputs the mark's encoded normal offset + disturbance
// with alpha = coverage (alpha-over blend into the persistent overlay).
const BLIT_FRAG = /* glsl */ `
precision highp float;
varying vec2 vLocalUv;
varying vec4 vParams;       // x=kind y=disturbance z=normalStrength w=seed/treadFreq
varying float vFade;        // per-instance age fade 0..1 (scales coverage)
varying vec2 vAcross;       // world-XZ dir across the track (tracks only)
varying vec2 vAlong;        // world-XZ dir along travel (tracks only)

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

// Radial crater height profile (arbitrary units): a depressed bowl floor that
// rises to a RAISED RIM LIP, whose height + width vary by angle so the rim
// isn't a uniform ring. Sampled at r±dr to get the slope → normal tilt.
// One jagged rim ring: a gaussian ridge whose height is a low-freq swell times
// sharp high-freq ridged peaks, and whose width jitters per angle, so it reads
// as broken chunks rather than a smooth tube.
float rimRing(float rr, float ang, float ringR, float seed,
              float hfreq, float wfreq, float hscale) {
    // Mostly-uniform height (keeps the ring round) modulated by sharp,
    // high-frequency ridged peaks (keeps it jagged, not a smooth tube).
    float swell  = 0.65 + 0.35 * fbm(vec2(ang * 5.0 + seed, 3.0));
    float ridged = 1.0 - abs(2.0 * fbm(vec2(ang * hfreq + seed * 5.0, 7.0)) - 1.0);
    float h = swell * (0.3 + 1.0 * ridged * ridged) * hscale;
    float w = 0.035 + 0.05 * fbm(vec2(ang * wfreq + seed * 7.0, 9.0));
    float t = (rr - ringR) / w;
    return h * exp(-t * t);
}

// Tank-tread height field over the track quad. across,along in [0,1].
// Two depressed ruts (left + right tread) with cross-rung corrugation. The
// freq arg controls rung spacing along travel. Returns a NEGATIVE-ish height
// (ruts are gouged into the ground); used for finite-difference normals.
float trackH(float across, float along, float freq) {
    // two ruts centred at 0.30 / 0.70 across the width
    float rutL = exp(-pow((across - 0.30) / 0.13, 2.0));
    float rutR = exp(-pow((across - 0.70) / 0.13, 2.0));
    float ruts = clamp(rutL + rutR, 0.0, 1.0);
    // tread rungs running across each rut
    float rung = 0.5 + 0.5 * sin(along * freq * 6.2831853);
    return -ruts * (0.65 + 0.35 * rung);
}

// Pressed-in oval depression: NEGATIVE height inside the oval, 0 outside.
// r = (across-radius, along-radius) in local quad uv. Used for the discrete
// footprint / claw shapes (union by min(), since deepest = most negative).
float ovalH(vec2 p, vec2 c, vec2 r) {
    vec2 d = (p - c) / r;
    return -clamp(1.0 - dot(d, d), 0.0, 1.0);
}
// Bipedal footprint pair: a fore-left + an aft-right oval. Abutting stamps
// (one per trackDecalWidth of travel) tile these into an alternating trail.
float feetH(vec2 p) {
    return min(ovalH(p, vec2(0.37, 0.32), vec2(0.12, 0.20)),
               ovalH(p, vec2(0.63, 0.72), vec2(0.12, 0.20)));
}
// Chicken / spider claw: three thin toes splayed forward.
float clawH(vec2 p) {
    float a = ovalH(p, vec2(0.34, 0.40), vec2(0.05, 0.17));
    float b = ovalH(p, vec2(0.50, 0.50), vec2(0.05, 0.17));
    float c = ovalH(p, vec2(0.66, 0.40), vec2(0.05, 0.17));
    return min(min(a, b), c);
}
// Single narrow wheel/bike rut down the centre (continuous along travel).
float wheelH(float across) {
    float d = (across - 0.5) / 0.08;
    return -clamp(1.0 - d * d, 0.0, 1.0);
}

float craterH(float rr, float ang, float seed, float rimR) {
    // FLAT shallow floor that stays level across the interior, then rises
    // SHARPLY close to the rim (sharp inner wall, not a gentle dish).
    float bowl = -0.10 * (1.0 - smoothstep(rimR * 0.78, rimR, rr));
    bowl += 0.05 * (fbm(vec2(ang * 3.0 + seed, rr * 9.0)) - 0.5);
    // OUTER rim ring (the main raised lip) + a lower INNER ring tucked right up
    // against the peak so the crater's inner edge is sharp.
    float outer = rimRing(rr, ang, rimR,        seed,       20.0, 9.0,  1.0);
    float inner = rimRing(rr, ang, rimR * 0.91, seed * 2.3, 27.0, 13.0, 0.5);
    return bowl + outer + inner;
}

void main() {
    float kind = vParams.x;
    float disturb = vParams.y;
    float nStrength = vParams.z;

    // Neutral-fill path (full-overlay init / decay) signalled by negative kind.
    // MUST be checked FIRST: the init quad is map-sized and would otherwise
    // fall through the scar branch below, whose radial discard clips it to a
    // central disc — leaving the rest of the overlay at its uninitialised
    // (0,0,0,0). The terrain plugin decodes those zero texels as a maximal
    // normal offset + full disturbance mask, painting one giant crater over the
    // whole map. Filling neutral here first keeps untouched ground clean.
    if (kind < -0.5) {
        gl_FragColor = vec4(0.5, 0.5, 0.0, vParams.w); // w carries decay alpha
        return;
    }

    vec2 noff = vec2(0.0);
    float cov;

    if (kind < 0.5) {
        // SCAR: a round impact crater — depressed bowl, raised rim lip with
        // random height, plus burnt ejecta rays radiating past the rim.
        // Lighting runs after this in the terrain shader, so the sun shades
        // the baked relief live.
        vec2 c = vLocalUv - 0.5;
        float dist = length(c);
        float r = dist * 2.0;                 // 0 centre .. 1 mid-edge
        float ang = atan(c.y, c.x);
        float seed = vParams.w;               // per-scar random seed
        vec2 rad = c / max(dist, 1e-4);       // outward radial unit vector

        // Rim radius: kept ROUND (small amplitude) but with HIGH-FREQUENCY
        // crenellation — many small jags around a circle, not big lobes.
        float rimR = 0.45
            + 0.028 * (fbm(vec2(ang * 6.0 + seed * 3.0, seed)) - 0.5)
            + 0.020 * (fbm(vec2(ang * 14.0 + seed, 2.0)) - 0.5)
            + 0.012 * sin(ang * 23.0 + seed);

        // --- RELIEF: shallow bowl + double jagged rim (drives the normal) ---
        float dr = 0.012;
        float slope = (craterH(r + dr, ang, seed, rimR)
                     - craterH(r - dr, ang, seed, rimR)) / (2.0 * dr);
        noff = -rad * clamp(slope, -4.0, 4.0) * 0.25 * nStrength;

        // --- EJECTA BLANKET: broken, rubble-strewn ground OUTSIDE the rim that
        // fades into undisturbed terrain. Baking outward broken-ground bumps
        // here gives the annulus real relief, so the terrain plugin churns +
        // rubbles it; the gentle taper also softens the rim→ground join so the
        // crater base isn't a hard edge. ---
        float ebBand = smoothstep(rimR * 0.85, rimR * 1.12, r)
                     * (1.0 - smoothstep(rimR * 1.12, rimR * 1.95, r));
        float ebN = fbm(vec2(ang * 28.0 + seed * 2.0, r * 10.0 + seed));
        noff += rad * (ebN - 0.5) * 1.1 * nStrength * ebBand;
        float covBlanket = ebBand * (0.30 + 0.5 * ebN);

        // --- SCORCH: soot-blast decal pattern (darkening channel) ---
        // Irregular interior scorch — kept LIGHT (the floor isn't a black pit);
        // the darker soot is carried by the streaks layered over the top.
        float core = (1.0 - smoothstep(0.0, rimR * 1.05, r));
        core *= 0.30 + 0.4 * fbm(vec2(ang * 4.0 + seed, r * 5.0));
        // Radial soot streaks in TWO populations — sparse-thick + dense-thin —
        // each with its own per-streak length, width and alpha, so spacing,
        // reach and weight all vary (no two rays alike).
        float thickSel = smoothstep(0.46, 0.85, fbm(vec2(ang * 24.0 + seed * 7.0, seed)));
        float thinSel  = smoothstep(0.54, 0.92, fbm(vec2(ang * 60.0 + seed * 3.0, seed * 2.0)));
        float lenThick = rimR * (1.5 + 1.5 * fbm(vec2(ang * 24.0 + seed, 4.0)));
        float lenThin  = rimR * (1.15 + 1.1 * fbm(vec2(ang * 60.0 + seed, 9.0)));
        float streaks = thickSel * (1.0 - smoothstep(rimR * 0.28, lenThick, r))
                                 * (0.7 + 0.3 * fbm(vec2(ang * 24.0 + seed * 5.0, 7.0)))
                      + thinSel  * (1.0 - smoothstep(rimR * 0.42, lenThin,  r)) * 0.7;
        streaks = clamp(streaks, 0.0, 1.0);
        // Particulate spatter flung outward.
        float spatter = smoothstep(0.72, 0.93, fbm(vLocalUv * 46.0 + seed * 3.0))
                      * (1.0 - smoothstep(rimR * 0.7, rimR * 2.4, r));
        // Streaks read at full strength (they're the signature soot rays).
        float scorch = max(core, max(streaks, spatter * 0.7));

        // Coverage = scorch ∪ relief body ∪ ejecta blanket (so the rim/floor
        // normal and the outer broken ground all blit, and the edge tapers).
        float covBody = 1.0 - smoothstep(rimR * 0.92, rimR * 1.30, r);
        cov = max(max(scorch, covBody * 0.7), covBlanket);
        if (cov < 0.02) discard;

        disturb = disturb * clamp(scorch, 0.0, 1.0);
        // Faint scorch on the blanket so the plugin's mask (B) treats it as
        // disturbed ground (→ churn + rubble) without darkening it heavily.
        disturb = max(disturb, covBlanket * 0.4);
    } else {
        // TRACK: pattern chosen by category encoded in the kind value
        //   1 = tread, 2 = wheel, 3 = footprint, 4 = claw.
        // local uv.x = across width, uv.y = along travel. Relief is built in
        // the WORLD frame (vAcross/vAlong) so a travel-rotated quad lights
        // correctly. Tread/wheel are continuous (full-width coverage);
        // footprint/claw are DISCRETE (coverage only where the shape is, so
        // the gaps don't blit and they read as individual prints).
        float cat    = kind - 1.0;
        float along  = vLocalUv.y;
        float across = vLocalUv.x;
        float freq   = vParams.w;            // rung frequency along travel (tread)

        // Feather the quad edges. Across (uv.x) is always feathered so the
        // strip/print sides fade. The along (uv.y) ends are feathered ONLY for
        // the discrete prints (foot/claw); continuous strips (tread/wheel) are
        // elongated segment quads that overlap end-to-end, so feathering their
        // ends would punch a dim seam at every joint.
        float acrossEdge = smoothstep(0.0, 0.08, across) * smoothstep(1.0, 0.92, across);
        float alongEdge  = smoothstep(0.0, 0.04, along)  * smoothstep(1.0, 0.96, along);

        float e = 0.02;
        vec2 nLocal = vec2(0.0);

        if (cat < 0.5) {
            // TREAD: two gouged ruts with cross-rungs.
            float hax = trackH(across + e, along, freq) - trackH(across - e, along, freq);
            float hal = trackH(across, along + e, freq) - trackH(across, along - e, freq);
            nLocal = -vec2(hax, hal) / (2.0 * e);
            float rutL = exp(-pow((across - 0.30) / 0.13, 2.0));
            float rutR = exp(-pow((across - 0.70) / 0.13, 2.0));
            float ruts = clamp(rutL + rutR, 0.0, 1.0);
            float rung = 0.7 + 0.3 * sin(along * freq * 6.2831853);
            // Capped low (≤0.45) so it stays a soft groove, not a black gouge,
            // and below the plugin's scorch threshold so no crater rubble.
            disturb = clamp(disturb * (0.5 + 0.8 * ruts) * rung, 0.0, 0.45);
            // Coverage follows the ruts (transparent in the gap between them),
            // NOT the full quad width. A crossing tread then only overwrites
            // where its OWN ruts fall — its gap no longer wipes the track it
            // crosses, so crossing treads interleave into a grid instead of
            // erasing each other.
            cov = acrossEdge * smoothstep(0.18, 0.45, ruts);
        } else if (cat < 1.5) {
            // WHEEL / bike: a single narrow continuous rut down the centre.
            float hax = wheelH(across + e) - wheelH(across - e);
            nLocal = -vec2(hax, 0.0) / (2.0 * e);
            float line = -wheelH(across);               // 0..1 depth
            disturb = clamp(disturb * (0.4 + 1.0 * line), 0.0, 0.45);
            cov = acrossEdge * smoothstep(0.05, 0.30, line);  // clear outside the line
        } else if (cat < 2.5) {
            // FOOTPRINT: two discrete oval feet (fore-left / aft-right).
            float hx = feetH(vec2(across + e, along)) - feetH(vec2(across - e, along));
            float hy = feetH(vec2(across, along + e)) - feetH(vec2(across, along - e));
            nLocal = -vec2(hx, hy) / (2.0 * e);
            float feet = -feetH(vec2(across, along));   // 0..1 depth
            disturb = clamp(disturb * (0.3 + 1.5 * feet), 0.0, 0.95);
            cov = acrossEdge * alongEdge * smoothstep(0.05, 0.30, feet);  // discrete
        } else {
            // CLAW: chicken / spider three-toe splay, discrete per stamp.
            float hx = clawH(vec2(across + e, along)) - clawH(vec2(across - e, along));
            float hy = clawH(vec2(across, along + e)) - clawH(vec2(across, along - e));
            nLocal = -vec2(hx, hy) / (2.0 * e);
            float claw = -clawH(vec2(across, along));
            disturb = clamp(disturb * (0.3 + 1.5 * claw), 0.0, 0.95);
            cov = acrossEdge * alongEdge * smoothstep(0.05, 0.30, claw);  // discrete
        }

        // map the local slope into world XZ via the quad's world axes
        vec2 nWorld = vAcross * nLocal.x + vAlong * nLocal.y;
        noff = clamp(nWorld, -1.0, 1.0) * nStrength;
    }

    // Age fade scales coverage (the alpha-over weight): a faded mark blends
    // less into the overlay on each rebuild, so it recovers toward neutral.
    cov *= vFade;
    if (cov < 0.02) discard;
    vec3 enc = vec3(0.5 + clamp(noff, -1.0, 1.0) * 0.5, disturb);
    gl_FragColor = vec4(enc, cov);
}
`;

interface PendingMark {
    /** centre in overlay UV [0,1] */
    cu: number;
    cv: number;
    /** half-size in overlay UV */
    hu: number;
    hv: number;
    /** rotation about the overlay plane (radians) */
    rot: number;
    kind: number;
    disturb: number;
    nStrength: number;
    treadFreq: number;
    /** Optional explicit UV-space half-axis vectors for the quad's local +X
     *  (across) and +Y (along). When present, uploadPending builds the
     *  instance matrix from these instead of (rot, hu, hv) — used by the
     *  connected track segments so an elongated quad maps correctly to world
     *  XZ even on non-square maps (rotating in anisotropic UV space would
     *  shear it). */
    ax?: { u: number; v: number };
    ay?: { u: number; v: number };
    /** Per-instance fade 0..1 (coverage multiplier). Undefined = 1 (fresh). Set
     *  by the rebuild from the mark's age; fresh appends leave it 1. */
    fade?: number;
}

/** A mark retained in the ring buffer so the overlay can be rebuilt from it
 *  (age-scaled) for fade — see MARK_CAP / FADE_* and rebuildFromMarks(). It is
 *  exactly the blit's PendingMark plus the birth timestamp. */
interface StoredMark extends PendingMark {
    birth: number; // value of this.elapsed (seconds) when laid
}

export class DecalOverlay {
    private scene: Scene;
    private rtt: RenderTargetTexture;
    private rttCamera: FreeCamera;
    private blitMesh: Mesh;
    private blitMat: ShaderMaterial;
    private pending: PendingMark[] = [];
    /** Per-`trackTypeId` procedural pattern category (index == wire
     *  trackTypeId). Empty until {@link setTrackTypes} is called; an unknown
     *  id then falls back to TREAD. */
    private trackCategories: number[] = [];
    /** Last track-segment world position per unit, for connecting consecutive
     *  continuous (tread/wheel) segments into one elongated quad instead of
     *  isolated square stamps (which gap + jag on turns / at speed). */
    private lastTrackPos = new Map<number, { x: number; z: number }>();
    /** world extent in elmos; world XZ → UV is (x/worldW, z/worldH). */
    private worldW = 1;
    private worldH = 1;
    /** Wall-clock seconds since construction (advanced by tick); marks store
     *  their birth time against this so the rebuild can age-fade them. */
    private elapsed = 0;
    /** Ring buffer of every live mark, for the age-scaled rebuild (fade). */
    private marks: StoredMark[] = [];
    private sinceRebuild = 0;
    /** Set when the next RTT render should clear-then-restamp the whole mark
     *  list (a fade rebuild) instead of appending only new marks. */
    private rebuildQueued = false;
    /** Set true for exactly one RTT render so the onClear handler actually
     *  clears (frame 0 init + each fade rebuild); otherwise the overlay is
     *  persistent and only appends. */
    private clearNextRender = true;
    /** Master switch for the fade rebuild. On = the global reset runs. */
    fadeEnabled = true;
    private disposed = false;

    constructor(scene: Scene, worldWidthElmos: number, worldHeightElmos: number) {
        this.scene = scene;
        this.worldW = Math.max(1, worldWidthElmos);
        this.worldH = Math.max(1, worldHeightElmos);

        // Pick a square overlay sized to the larger map axis, clamped.
        const dim = Math.min(
            OVERLAY_MAX_DIM,
            Math.max(OVERLAY_MIN_DIM, ceilPow2(Math.max(this.worldW, this.worldH) / 4)),
        );

        this.rtt = new RenderTargetTexture(
            'decalOverlay', dim, scene,
            {
                generateMipMaps: false,
                type: Constants.TEXTURETYPE_UNSIGNED_BYTE,
                format: Constants.TEXTUREFORMAT_RGBA,
                samplingMode: Texture.BILINEAR_SAMPLINGMODE,
            },
        );
        this.rtt.wrapU = Texture.CLAMP_ADDRESSMODE;
        this.rtt.wrapV = Texture.CLAMP_ADDRESSMODE;
        // Neutral overlay value: (0.5,0.5,0,0) = flat normal, no disturbance.
        this.rtt.clearColor = new Color4(0.5, 0.5, 0.0, 0.0);
        // The overlay is normally persistent (append-only, no per-frame clear).
        // It clears ONLY on the frames flagged by clearNextRender — frame 0
        // (init to neutral) and each fade rebuild (clear, then re-stamp the
        // whole mark list age-scaled). uploadPending sets the flag + queues
        // marks; this handler consumes it.
        this.rtt.onClearObservable.add(() => {
            if (!this.clearNextRender) return; // persistent: skip the clear
            this.clearNextRender = false;
            this.scene.getEngine().clear(this.rtt.clearColor, true, true, true);
        });

        this.blitMat = new ShaderMaterial(
            'decalBlit', scene,
            { vertexSource: BLIT_VERT, fragmentSource: BLIT_FRAG },
            {
                attributes: ['position', 'uv', 'world0', 'world1', 'world2', 'world3', 'params', 'fade'],
                uniforms: [],
                needAlphaBlending: true,
            },
        );
        this.blitMat.backFaceCulling = false;
        this.blitMat.alphaMode = Constants.ALPHA_COMBINE; // src.a over dst

        this.blitMesh = buildUnitQuadXY(scene, 'decalBlitQuad');
        this.blitMesh.material = this.blitMat;
        this.blitMesh.isPickable = false;
        this.blitMesh.alwaysSelectAsActiveMesh = true; // never frustum-cull
        // Private layer so the main camera never renders this full-screen quad
        // — only the RTT (via rttCamera below) does.
        this.blitMesh.layerMask = BLIT_LAYER;

        // Dedicated camera the RTT renders with: its layerMask matches the blit
        // mesh so the RTT draws it, while the main camera (default mask) skips
        // it. Its transform is irrelevant — the blit shader outputs clip space
        // directly. Not added to scene.activeCamera(s), so it never hits screen.
        this.rttCamera = new FreeCamera('decalRttCam', Vector3.Zero(), scene);
        this.rttCamera.layerMask = BLIT_LAYER;
        // Stay enabled for the whole session — Babylon decides the RTT's
        // active-mesh list before onBeforeRender fires, so toggling enabled
        // per-frame would exclude the mesh from the render it's meant for.
        // We gate drawing purely via thinInstanceCount (0 = no-op draw).
        this.blitMesh.thinInstanceCount = 0;

        this.rtt.renderList = [this.blitMesh];
        this.rtt.activeCamera = this.rttCamera;
        // Upload this frame's pending marks just before the RTT draws them,
        // then clear the count right after so they're applied exactly once
        // (the marks persist in the un-cleared overlay).
        this.rtt.onBeforeRenderObservable.add(() => this.uploadPending());
        this.rtt.onAfterRenderObservable.add(() => {
            this.blitMesh.thinInstanceCount = 0;
        });
        scene.customRenderTargets.push(this.rtt);
        // Frame 0 clears to the neutral clearColor (clearNextRender starts true),
        // so the overlay begins flat everywhere — no neutral-fill quad needed.
    }

    /** The accumulation texture, for binding into the terrain plugin. */
    get texture(): RenderTargetTexture { return this.rtt; }

    /** Supply the sorted track-type-name table (index == wire trackTypeId;
     *  see {@link buildTrackTypeNames}). Each name is classified to a
     *  procedural pattern so a track segment renders as the right kind of mark
     *  (tank tread vs bot footprints vs spider claws). */
    setTrackTypes(names: string[]): void {
        this.trackCategories = names.map(classifyTrackType);
    }

    /** Per-frame tick: advances the clock and schedules the periodic fade
     *  rebuild. The RTT itself renders via Babylon's customRenderTargets pump. */
    tick(dtSeconds: number): void {
        if (this.disposed) return;
        this.elapsed += dtSeconds;
        if (!this.fadeEnabled) return;
        this.sinceRebuild += dtSeconds;
        if (this.sinceRebuild >= REBUILD_INTERVAL_S) {
            this.sinceRebuild = 0;
            this.rebuildQueued = true; // uploadPending performs it next render
        }
    }

    /** Age → coverage multiplier: full strength until FADE_HOLD_S, then linear
     *  to 0 at FADE_END_S. Marks past FADE_END_S are dropped by the rebuild. */
    private fadeFor(age: number): number {
        if (age <= FADE_HOLD_S) return 1;
        if (age >= FADE_END_S) return 0;
        return 1 - (age - FADE_HOLD_S) / FADE_OUT_S;
    }

    /** Record a mark for the age-scaled rebuild, evicting the oldest past the
     *  ring-buffer cap. The mark is a snapshot of the blit params (+ birth). */
    private remember(m: PendingMark): void {
        this.marks.push({ ...m, birth: this.elapsed });
        if (this.marks.length > MARK_CAP) this.marks.shift();
    }

    /** Lay a mark: blit it this frame (immediate) AND retain it for the
     *  age-scaled rebuild (fade). */
    private emit(m: PendingMark): void {
        this.pending.push(m);
        this.remember(m);
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
        const hu = (ev.radius * PAD) / this.worldW;
        const hv = (ev.radius * PAD) / this.worldH;
        this.emit({
            cu: ev.x / this.worldW,
            cv: ev.z / this.worldH,
            hu, hv,
            // MUST be 0: the bake computes the bowl/rim normal in the quad's
            // local frame and writes it into the overlay's world-space RG
            // channels. A rotated quad would rotate every crater's relief, so
            // each would be lit from a different apparent direction (the
            // "lighting doesn't match the sun" bug). Pattern variety comes from
            // the per-scar `seed` (below), not from quad rotation.
            rot: 0,
            kind: KIND_SCAR,
            disturb: Math.min(1, (ev.alpha > 0 ? ev.alpha : 0.85)),
            nStrength: 0.9,
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
            // CONTINUOUS tracks: connect this segment to the unit's previous
            // one into a single elongated quad (length = travel since the last
            // segment), so the strip stays unbroken on turns and at speed
            // instead of dropping isolated square stamps that gap + jag.
            const last = this.lastTrackPos.get(ev.unitId);
            this.lastTrackPos.set(ev.unitId, { x: ev.x, z: ev.z });
            if (last) {
                const dx = ev.x - last.x;
                const dz = ev.z - last.z;
                const len = Math.hypot(dx, dz);
                // Drop degenerate / implausibly long links (a long gap means the
                // unit was out of LOS, died + a new one reused the id, or
                // teleported — bridging it would draw one giant streak).
                if (len > 1e-3 && len < w * 8) {
                    const tx = dx / len, tz = dz / len;          // travel unit vec
                    // Overlap the joint slightly so consecutive segments meet
                    // seamlessly (the shader no longer feathers strip ends).
                    const halfLen = len * 0.5 + w * 0.15;
                    const halfW = w * 0.5;
                    // Build the quad's UV-space half-axes straight from the world
                    // across/along vectors (across ⟂ travel = (tz,-tx)); avoids
                    // the shear that rotating in anisotropic UV space causes for
                    // a long quad on a non-square map.
                    const ax = { u: (tz * halfW) / this.worldW, v: (-tx * halfW) / this.worldH };
                    const ay = { u: (tx * halfLen) / this.worldW, v: (tz * halfLen) / this.worldH };
                    this.emit({
                        cu: (last.x + ev.x) * 0.5 / this.worldW,
                        cv: (last.z + ev.z) * 0.5 / this.worldH,
                        hu: 0, hv: 0, rot: 0, ax, ay,
                        kind,
                        // Light + shallow: continuous tracks read as a subtle
                        // pressed groove, not a black gouge. Kept low so the
                        // terrain plugin's crater churn/rubble (gated on strong
                        // scorch/relief) never fires on them — that procedural
                        // detail is what made the tread blurry + the bike line
                        // look like diagonal hatching. Pressure (darkening +
                        // relief depth) per vehicle pass reduced by 2/3 (0.4→
                        // 0.13) so a single vehicle leaves a faint mark.
                        disturb: 0.13,
                        nStrength: 0.13,
                        // Rung frequency = rungs over this segment, chosen for a
                        // constant ~world spacing regardless of segment length.
                        treadFreq: Math.max(1, len / Math.max(6, w * 0.5)),
                    });
                }
            }
            return; // first sighting (no last pos) lays nothing; the next links
        }

        // DISCRETE prints (foot / claw): one square stamp per segment, oriented
        // along travel. The shapes tile across abutting stamps into a trail; we
        // want them individual, so no segment-connecting here.
        const hu = (w * 0.5) / this.worldW;
        const hv = (w * 0.5) / this.worldH;
        // Heading so the quad's local +Y axis aligns with the XZ travel vector.
        // The blit matrix maps local +Y to (-sin rot, cos rot) in (X,Z); solving
        // for travel (dirX, dirZ) gives rot = atan2(-dirX, dirZ).
        const rot = Math.atan2(-ev.dirX, ev.dirZ);
        this.emit({
            cu: ev.x / this.worldW,
            cv: ev.z / this.worldH,
            hu, hv, rot,
            kind,
            // Bot footprints / spider claws were far darker than the (now
            // faint) vehicle tracks — bring the darkening down to ~vehicle
            // level. A little more relief than vehicles so the discrete prints
            // stay legible, but gentle enough to drop the heavy crater rubble.
            disturb: 0.12,
            nStrength: 0.5,
            treadFreq: 4.0,
        });
    }

    /** Build the thin-instance buffers and enable the blit mesh for this RTT
     *  render. Two modes:
     *   - normal: stamp only `pending` (new marks) onto the persistent overlay.
     *   - rebuild (fadeQueued): clear the overlay and re-stamp the WHOLE live
     *     mark list, each age-scaled (fade) and expired ones dropped. */
    private uploadPending(): void {
        if (this.rebuildQueued) {
            this.rebuildQueued = false;
            this.clearNextRender = true; // the onClear handler wipes to neutral
            // Rebuild the batch from the live marks: drop the fully-faded,
            // age-scale the rest. Order is preserved (oldest first) so the
            // alpha-over layering matches the original lay order.
            const live: StoredMark[] = [];
            const batch: PendingMark[] = [];
            for (const mk of this.marks) {
                const f = this.fadeFor(this.elapsed - mk.birth);
                if (f <= 0) continue; // expired → evicted by omission
                live.push(mk);
                batch.push({ ...mk, fade: f });
            }
            this.marks = live;
            this.pending = batch;
        }

        const n = this.pending.length;
        if (n === 0) { this.blitMesh.thinInstanceCount = 0; return; }

        const matrices = new Float32Array(n * 16);
        const params = new Float32Array(n * 4);
        const fades = new Float32Array(n);
        for (let i = 0; i < n; i++) {
            const m = this.pending[i];
            const o = i * 16;
            // columns: X axis (across), Y axis (along), Z, translation.
            // Column-major mat4 (Babylon thin-instance layout). The unit quad
            // spans [-0.5,0.5], so a column of length L gives half-extent L/2 —
            // hence the ×2 on the half-axes below.
            let x0: number, x1: number, y0: number, y1: number;
            if (m.ax && m.ay) {
                // Explicit UV-space half-axes (connected track segments).
                x0 = m.ax.u * 2; x1 = m.ax.v * 2;
                y0 = m.ay.u * 2; y1 = m.ay.v * 2;
            } else {
                // 2D rotate+scale of the unit quad by (rot, hu, hv).
                const c = Math.cos(m.rot), s = Math.sin(m.rot);
                x0 =  c * m.hu * 2; x1 =  s * m.hu * 2;
                y0 = -s * m.hv * 2; y1 =  c * m.hv * 2;
            }
            matrices[o + 0] = x0; matrices[o + 1] = x1; matrices[o + 2] = 0; matrices[o + 3] = 0;
            matrices[o + 4] = y0; matrices[o + 5] = y1; matrices[o + 6] = 0; matrices[o + 7] = 0;
            matrices[o + 8] = 0;  matrices[o + 9] = 0;  matrices[o + 10] = 1; matrices[o + 11] = 0;
            matrices[o + 12] = m.cu; matrices[o + 13] = m.cv; matrices[o + 14] = 0; matrices[o + 15] = 1;

            params[i * 4 + 0] = m.kind;
            params[i * 4 + 1] = m.disturb;
            params[i * 4 + 2] = m.nStrength;
            params[i * 4 + 3] = m.treadFreq;
            fades[i] = m.fade ?? 1;
        }
        this.blitMesh.thinInstanceSetBuffer('matrix', matrices, 16, true);
        this.blitMesh.thinInstanceSetBuffer('params', params, 4, true);
        this.blitMesh.thinInstanceSetBuffer('fade', fades, 1, true);
        this.blitMesh.thinInstanceCount = n;
        this.pending = [];
    }

    dispose(): void {
        this.disposed = true;
        const idx = this.scene.customRenderTargets.indexOf(this.rtt);
        if (idx >= 0) this.scene.customRenderTargets.splice(idx, 1);
        this.rtt.dispose();
        this.blitMesh.dispose();
        this.blitMat.dispose();
        this.rttCamera.dispose();
        this.pending = [];
        this.marks = [];
        this.lastTrackPos.clear();
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

// Re-export so the unused Color4 import (kept for future glow channel work)
// doesn't trip noUnusedLocals.
export const _DECAL_OVERLAY_NEUTRAL = new Color4(0.5, 0.5, 0, 0);
