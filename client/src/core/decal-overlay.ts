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
 *  this and it's clamped here for huge maps (~67 MB at 4096² RGBA8). Crater
 *  detail (rim wobble, ejecta rays, floor roughness) needs the texels — at
 *  2048² over a 17 k-elmo map a scar was only ~75 px across and read blocky. */
const OVERLAY_MAX_DIM = 4096;
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

/** Seconds between global decay passes, and how much each fades toward
 *  neutral. ~28 s to substantially fade a mark (matches the old scar feel). */
const DECAY_INTERVAL_S = 4;
const DECAY_ALPHA = 0.06;

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
varying vec2 vLocalUv;
varying vec4 vParams;
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

        // soft feathered quad edge — keeps abutting stamps seamless.
        float edge = smoothstep(0.0, 0.08, across) * smoothstep(1.0, 0.92, across)
                   * smoothstep(0.0, 0.04, along)  * smoothstep(1.0, 0.96, along);

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
            float rung = 0.55 + 0.45 * sin(along * freq * 6.2831853);
            disturb = clamp(disturb * (0.45 + 1.25 * ruts) * (0.7 + 0.3 * rung), 0.0, 0.95);
            cov = edge;
        } else if (cat < 1.5) {
            // WHEEL / bike: a single narrow continuous rut down the centre.
            float hax = wheelH(across + e) - wheelH(across - e);
            nLocal = -vec2(hax, 0.0) / (2.0 * e);
            float line = -wheelH(across);               // 0..1 depth
            disturb = clamp(disturb * (0.3 + 1.4 * line), 0.0, 0.95);
            cov = edge * smoothstep(0.05, 0.30, line);  // clear outside the line
        } else if (cat < 2.5) {
            // FOOTPRINT: two discrete oval feet (fore-left / aft-right).
            float hx = feetH(vec2(across + e, along)) - feetH(vec2(across - e, along));
            float hy = feetH(vec2(across, along + e)) - feetH(vec2(across, along - e));
            nLocal = -vec2(hx, hy) / (2.0 * e);
            float feet = -feetH(vec2(across, along));   // 0..1 depth
            disturb = clamp(disturb * (0.3 + 1.5 * feet), 0.0, 0.95);
            cov = edge * smoothstep(0.05, 0.30, feet);  // discrete — gaps stay clean
        } else {
            // CLAW: chicken / spider three-toe splay, discrete per stamp.
            float hx = clawH(vec2(across + e, along)) - clawH(vec2(across - e, along));
            float hy = clawH(vec2(across, along + e)) - clawH(vec2(across, along - e));
            nLocal = -vec2(hx, hy) / (2.0 * e);
            float claw = -clawH(vec2(across, along));
            disturb = clamp(disturb * (0.3 + 1.5 * claw), 0.0, 0.95);
            cov = edge * smoothstep(0.05, 0.30, claw);
        }

        // map the local slope into world XZ via the quad's world axes
        vec2 nWorld = vAcross * nLocal.x + vAlong * nLocal.y;
        noff = clamp(nWorld, -1.0, 1.0) * nStrength;
    }

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
    /** world extent in elmos; world XZ → UV is (x/worldW, z/worldH). */
    private worldW = 1;
    private worldH = 1;
    private decayAccum = 0;
    /** Global fade pass — off until the over-eager-decay bug is reworked. */
    decayEnabled = false;
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
        // Suppress the per-frame clear so the overlay accumulates.
        this.rtt.onClearObservable.add(() => { /* no clear — persistent */ });

        this.blitMat = new ShaderMaterial(
            'decalBlit', scene,
            { vertexSource: BLIT_VERT, fragmentSource: BLIT_FRAG },
            {
                attributes: ['position', 'uv', 'world0', 'world1', 'world2', 'world3', 'params'],
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

        // Frame 0: a full-overlay neutral fill so the (un-cleared) texture
        // starts at (0.5,0.5,0,0) everywhere.
        this.pending.push({
            cu: 0.5, cv: 0.5, hu: 0.5, hv: 0.5, rot: 0,
            kind: -1, disturb: 0, nStrength: 0, treadFreq: 1.0,
        });
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

    /** Per-frame tick: drives the slow global decay. The RTT itself renders
     *  via Babylon's customRenderTargets pump. */
    tick(dtSeconds: number): void {
        if (this.disposed) return;
        // Decay disabled by default pending tuning: in-browser the full-overlay
        // alpha-over neutral pass empirically erased marks within seconds even
        // though the 4 s interval measured correct — likely the RTT re-applying
        // the queued decay mark more than once per interval. Permanent marks
        // (which the user accepted as an option) until the decay is reworked
        // (candidate: a wall-clock-gated, much gentler pass, or a compute-style
        // multiply that's frequency-independent).
        if (!this.decayEnabled) return;
        this.decayAccum += dtSeconds;
        if (this.decayAccum >= DECAY_INTERVAL_S) {
            this.decayAccum = 0;
            // Full-overlay neutral fill at low alpha → lerps toward neutral.
            this.pending.push({
                cu: 0.5, cv: 0.5, hu: 0.5, hv: 0.5, rot: 0,
                kind: -1, disturb: 0, nStrength: 0, treadFreq: DECAY_ALPHA,
            });
        }
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
        this.pending.push({
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
        // Square stamp, half-size = w/2 in each axis (UV-scaled per axis).
        const hu = (w * 0.5) / this.worldW;
        const hv = (w * 0.5) / this.worldH;
        // Heading about the overlay plane so the quad's local +Y axis aligns
        // with the XZ travel vector. The blit matrix maps local +Y to world
        // (-sin rot, cos rot) in (X,Z); solving for travel (dirX, dirZ) gives
        // rot = atan2(-dirX, dirZ). (Using atan2(dirX, dirZ) reflects the
        // along-axis across Z — correct for axis-aligned travel but ~90° off on
        // diagonals, which is why the tread didn't match direction.)
        const rot = Math.atan2(-ev.dirX, ev.dirZ);
        const cat = this.trackCategories[ev.trackTypeId] ?? TRACK_TREAD;
        this.pending.push({
            cu: ev.x / this.worldW,
            cv: ev.z / this.worldH,
            hu, hv, rot,
            // kind carries the pattern category (1=tread, 2=wheel, 3=foot,
            // 4=claw) so the shader picks the right mark for the unit type.
            kind: KIND_TRACK_BASE + cat,
            // Strong, clearly-visible mark: heavy albedo darkening in the ruts /
            // prints (shader scales this up by shape presence) + pronounced
            // relief.
            disturb: 0.7,
            nStrength: 1.4,
            treadFreq: 4.0,
        });
    }

    /** Build the thin-instance buffers for the pending marks and enable the
     *  blit mesh for this RTT render. */
    private uploadPending(): void {
        const n = this.pending.length;
        if (n === 0) { this.blitMesh.thinInstanceCount = 0; return; }

        const matrices = new Float32Array(n * 16);
        const params = new Float32Array(n * 4);
        for (let i = 0; i < n; i++) {
            const m = this.pending[i];
            // 2D transform in UV space: rotate+scale the unit quad, translate
            // to (cu,cv). Column-major mat4 (Babylon thin-instance layout).
            const c = Math.cos(m.rot), s = Math.sin(m.rot);
            const o = i * 16;
            // columns: X axis, Y axis, Z, translation
            matrices[o + 0] =  c * m.hu * 2; matrices[o + 1] =  s * m.hu * 2; matrices[o + 2] = 0; matrices[o + 3] = 0;
            matrices[o + 4] = -s * m.hv * 2; matrices[o + 5] =  c * m.hv * 2; matrices[o + 6] = 0; matrices[o + 7] = 0;
            matrices[o + 8] = 0;             matrices[o + 9] = 0;             matrices[o + 10] = 1; matrices[o + 11] = 0;
            matrices[o + 12] = m.cu;         matrices[o + 13] = m.cv;         matrices[o + 14] = 0; matrices[o + 15] = 1;

            params[i * 4 + 0] = m.kind;
            params[i * 4 + 1] = m.disturb;
            params[i * 4 + 2] = m.nStrength;
            params[i * 4 + 3] = m.treadFreq;
        }
        this.blitMesh.thinInstanceSetBuffer('matrix', matrices, 16, true);
        this.blitMesh.thinInstanceSetBuffer('params', params, 4, true);
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
