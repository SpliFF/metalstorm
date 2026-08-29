/**
 * capture-subject — the framing and verdict math behind `test.captureSubject()`
 * and the `capture_subject` MCP tool (PLAN-test-automation, V1).
 *
 * WHY THIS EXISTS. Every hand-rolled "show me this unit" sequence has made the
 * same three mistakes, and they are all mistakes of *arithmetic done by guess*:
 *
 *   1. **Height/zoom guessed against unknown bounds.** `focus(id, {height:800})`
 *      frames a 65 m submarine and a 4 m rifleman identically, so one shot is
 *      an empty field of ground and the other is a texture close-up. The fix is
 *      not a better constant — it is to derive the distance from the subject's
 *      OWN bounding sphere, which the renderer already knows
 *      (`getEntityBounds`). `frameDistance()` in orbit-rig.ts does that; this
 *      module only decides the *angle* and the *fill fraction* to feed it.
 *
 *   2. **The camera call and the capture call were separate round trips.** Each
 *      one is seconds over the MCP relay, and the sim does not wait: a guided
 *      playthrough on 2026-08-29 advanced 1,000+ frames between "look here" and
 *      "take the shot", losing a whole engagement between two images. Nothing
 *      in this file fixes that — the *composite* does (one relay call) — but
 *      the retry policy here has to live inside that one call too, which is
 *      why `retryFraming()` is a pure function of the attempt index rather
 *      than a caller-driven loop.
 *
 *   3. **A black frame was returned as a deliverable.** Fog of war, night
 *      lighting and a camera inside terrain all produce a valid PNG of
 *      nothing. `luminanceVerdict()` turns that into a *diagnosis*, and
 *      `diagnose()` names the candidate causes in the order they are actually
 *      worth checking.
 *
 * Pure and Babylon-free on purpose: every rule below is unit-tested without a
 * renderer (capture-subject.test.ts).
 */

import { mergeSpheres, type Sphere } from './orbit-rig.js';

/**
 * Named viewpoints.
 *
 * Yaw follows the OrbitRig convention — degrees around +Y, measured from +X
 * toward +Z — and the presets are named for a unit at **heading 0, which faces
 * −Z** (docs/coordinate-system.md: `+X` right, `+Y` up, `−Z` forward). So
 * "front" puts the camera on the −Z side, at yaw −90°.
 *
 * These are WORLD-relative, not unit-relative: a unit that has turned shows a
 * different face under the same preset. That is deliberate — the alternative
 * is reading a live heading that the sim is free to change between the read
 * and the shot, which is the exact class of race this primitive exists to
 * remove. Pass `yawDeg` explicitly when the unit's own facing matters.
 */
export type CaptureAngle = 'three-quarter' | 'front' | 'rear' | 'side' | 'top' | 'low';

export interface Framing {
    /** Degrees around +Y from +X toward +Z (OrbitRig convention). */
    yawDeg: number;
    /** Degrees above the horizontal. OrbitRig clamps to 5–85. */
    pitchDeg: number;
    /** Fraction of the shorter viewport axis the subject sphere should fill. */
    fill: number;
}

export const CAPTURE_ANGLES: Record<CaptureAngle, Framing> = {
    // The default. Front-right-high: reads silhouette, length and height at
    // once, and keeps enough ground in frame to judge scale against terrain.
    'three-quarter': { yawDeg: -45, pitchDeg: 30, fill: 0.70 },
    front:           { yawDeg: -90, pitchDeg: 12, fill: 0.75 },
    rear:            { yawDeg:  90, pitchDeg: 12, fill: 0.75 },
    side:            { yawDeg:   0, pitchDeg: 12, fill: 0.75 },
    // Pitch is clamped at 85 by the rig; 85 IS "top" as far as it is concerned.
    top:             { yawDeg: -90, pitchDeg: 85, fill: 0.80 },
    // Near-horizon, deliberately loose: the shot for judging a model against
    // the terrain it stands on (the world-scale A/B), where filling the frame
    // with the subject destroys the very reference you are checking.
    low:             { yawDeg: -45, pitchDeg:  8, fill: 0.45 },
};

export const DEFAULT_CAPTURE_ANGLE: CaptureAngle = 'three-quarter';

/**
 * Fill clamp. The OrbitRig clamps camera distance to 1.2×–10× the subject
 * radius, so a fill below ~0.24 (at the default 0.8 rad vertical FOV) asks for
 * a distance the rig will silently refuse. Clamping here means the framing we
 * REPORT is the framing that was applied.
 */
export const FILL_MIN = 0.25;
export const FILL_MAX = 0.95;

/** Mean luminance (0–255) at or below which a frame is called black. */
export const DEFAULT_LUMINANCE_FLOOR = 8;
/** max−min luminance below which a frame is called featureless. */
export const DEFAULT_CONTRAST_FLOOR = 6;

export function clampFill(fill: number): number {
    if (!Number.isFinite(fill)) return CAPTURE_ANGLES[DEFAULT_CAPTURE_ANGLE].fill;
    return Math.max(FILL_MIN, Math.min(FILL_MAX, fill));
}

/**
 * Merge a named preset with explicit per-axis overrides. Any of yaw/pitch/fill
 * may be given on its own — `{angle:'top', yawDeg: 0}` is a legal top-down
 * from a different bearing.
 */
export function resolveFraming(spec: {
    angle?: CaptureAngle; yawDeg?: number; pitchDeg?: number; fill?: number;
} = {}): Framing & { angle: CaptureAngle } {
    const angle = spec.angle && CAPTURE_ANGLES[spec.angle]
        ? spec.angle : DEFAULT_CAPTURE_ANGLE;
    const base = CAPTURE_ANGLES[angle];
    return {
        angle,
        yawDeg: Number.isFinite(spec.yawDeg) ? spec.yawDeg as number : base.yawDeg,
        pitchDeg: Number.isFinite(spec.pitchDeg) ? spec.pitchDeg as number : base.pitchDeg,
        fill: clampFill(Number.isFinite(spec.fill) ? spec.fill as number : base.fill),
    };
}

/**
 * Escalation ladder for a frame that came back black.
 *
 * Attempt 0 is what the caller asked for. The retries pull the camera back and
 * tilt it down, in that order, because the two mechanical causes of a black
 * frame — camera inside terrain/geometry, and camera under the water plane —
 * are both cured by going up and out, while the two *state* causes (fog of
 * war, night) are not curable from here at all and are named in `diagnose()`.
 */
export function retryFraming(base: Framing, attempt: number): Framing {
    if (attempt <= 0) return { ...base, fill: clampFill(base.fill) };
    if (attempt === 1) {
        return {
            yawDeg: base.yawDeg,
            pitchDeg: Math.max(45, base.pitchDeg),
            fill: clampFill(Math.min(base.fill, 0.5)),
        };
    }
    return { yawDeg: base.yawDeg, pitchDeg: 80, fill: FILL_MIN };
}

export interface LuminanceStats { min: number; max: number; mean: number }

export interface LuminanceVerdict {
    /** The image is (near) black — never hand this back as a deliverable. */
    black: boolean;
    /** Not black, but flat: one colour, no subject. Worth flagging, not fatal. */
    flat: boolean;
    mean: number;
    contrast: number;
    /** Human sentence, or null when the frame looks like a picture of something. */
    reason: string | null;
}

/**
 * Classify one capture's luminance. `stats` comes from `captureFrame({stats:true})`,
 * which computes it worker-side over the DOWNSAMPLED pixels — so this is cheap
 * and needs no image decode.
 */
export function luminanceVerdict(
    stats: LuminanceStats | undefined,
    opts: { luminanceFloor?: number; contrastFloor?: number } = {},
): LuminanceVerdict {
    const floor = opts.luminanceFloor ?? DEFAULT_LUMINANCE_FLOOR;
    const cFloor = opts.contrastFloor ?? DEFAULT_CONTRAST_FLOOR;
    if (!stats) {
        // No stats requested/available: we cannot judge, and saying "fine" would
        // be the same silent-black failure in a different coat.
        return { black: false, flat: false, mean: NaN, contrast: NaN,
                 reason: 'no luminance stats — frame not checked' };
    }
    const contrast = stats.max - stats.min;
    const black = stats.mean <= floor;
    const flat = !black && contrast <= cFloor;
    let reason: string | null = null;
    if (black) {
        reason = `near-black frame (mean luminance ${stats.mean.toFixed(1)} ≤ floor ${floor})`;
    } else if (flat) {
        reason = `featureless frame (luminance range ${contrast.toFixed(1)} ≤ ${cFloor}`
            + `, mean ${stats.mean.toFixed(1)}) — the camera is probably looking at`
            + ' empty sky or a single flat surface';
    }
    return { black, flat, mean: stats.mean, contrast, reason };
}

export interface AttemptRecord {
    framing: Framing;
    stats?: LuminanceStats;
    verdict: LuminanceVerdict;
}

/**
 * The one sentence a caller should read when the image is not usable — or null
 * when it is. Causes are listed in the order they are worth checking: the two
 * we could not have fixed from inside the browser come first, because the
 * retries already exhausted the two we could.
 */
export function diagnose(
    attempts: readonly AttemptRecord[],
    ctx: { revealed?: boolean; underwater?: boolean } = {},
): string | null {
    if (attempts.length === 0) return 'no capture attempts were made';
    const last = attempts[attempts.length - 1];
    if (!last.verdict.black) return last.verdict.flat ? last.verdict.reason : null;

    const causes: string[] = [];
    if (!ctx.revealed) {
        causes.push('fog of war (the subject is outside your LOS — re-run with'
            + ' reveal:true, or set_los enable:true)');
    }
    causes.push('night / sun below the horizon (test.sun({elevationDeg:45}))');
    if (ctx.underwater) {
        causes.push('the subject sits below the water plane and the camera is'
            + ' looking through it');
    }
    causes.push('the subject never rendered (model still loading, or the entity'
        + ' is not streamed to this client)');
    return `every one of ${attempts.length} framing attempt(s) returned a `
        + `${last.verdict.black ? 'near-black' : 'blank'} frame `
        + `(mean luminance ${last.verdict.mean.toFixed(1)}). Candidate causes, `
        + `most likely first: ${causes.join('; ')}.`;
}

// ── Subject → bounding sphere ───────────────────────────────────────────

/** A rectangle of ground, in elmos. Corner order does not matter. */
export interface AreaSpec { x1: number; z1: number; x2: number; z2: number }

/** Minimum framing radius for a bare point with no bounds of its own. */
export const DEFAULT_POINT_RADIUS = 120;

/**
 * Sphere covering a ground rectangle. `y` is left to the caller to fill from
 * the heightmap (the harness does; a headless test does not have one).
 */
export function sphereFromArea(area: AreaSpec, y = 0): Sphere {
    const x = (area.x1 + area.x2) / 2;
    const z = (area.z1 + area.z2) / 2;
    const halfW = Math.abs(area.x2 - area.x1) / 2;
    const halfH = Math.abs(area.z2 - area.z1) / 2;
    return { x, y, z, radius: Math.max(1, Math.hypot(halfW, halfH)) };
}

/** Sphere for an explicit world position. `radius` defaults to a readable
 *  "a squad fits in this" ball rather than a point the rig would zoom into. */
export function sphereFromPosition(
    pos: { x: number; z: number; y?: number; radius?: number },
): Sphere {
    return {
        x: pos.x, y: pos.y ?? 0, z: pos.z,
        radius: Number.isFinite(pos.radius) && (pos.radius as number) > 0
            ? pos.radius as number : DEFAULT_POINT_RADIUS,
    };
}

/** Merge several unit spheres into the one the rig should frame. */
export function mergeSubjectSpheres(spheres: readonly Sphere[]): Sphere | null {
    return mergeSpheres(spheres);
}

/**
 * How wide the whole subject is, in metres, at the project's 8 elmos = 1 m
 * contract (PLAN-world-scale §2). Reported alongside every capture so a
 * scale regression is visible in the METADATA, not only by eyeballing the
 * picture — the world-scale A/B needs exactly this number.
 */
export const ELMOS_PER_METRE = 8;

export function metresAcross(sphere: Sphere): number {
    return (sphere.radius * 2) / ELMOS_PER_METRE;
}

// ── The composite's request / reply shapes ──────────────────────────────

/**
 * What to look at, and how. Exactly ONE subject selector is required:
 * `unitId` / `unitIds` (framed as one merged sphere), `def` (newest live
 * instance known to THIS client), `position`, or `area`.
 */
export interface CaptureSubjectSpec {
    unitId?: number;
    unitIds?: number[];
    def?: string;
    position?: { x: number; z: number; y?: number; radius?: number };
    area?: AreaSpec;

    angle?: CaptureAngle;
    yawDeg?: number;
    pitchDeg?: number;
    fill?: number;

    format?: 'png' | 'jpeg';
    quality?: number;
    maxDim?: number;

    /** How long to wait for a named unit/def to reach the renderer. */
    resolveTimeoutMs?: number;
    /** Live-render dwell after framing, before the shot, so newly-visible
     *  terrain and models get drawn. */
    settleMs?: number;
    /** Freeze the client render loop across the capture (default true). */
    holdRender?: boolean;
    /** Extra framings to try if the frame comes back black (default 2). */
    retries?: number;
    luminanceFloor?: number;
    contrastFloor?: number;
    /** Restore the pre-capture camera view afterwards (default true). */
    restore?: boolean;
    /** Caller states that LOS was already revealed — only affects the wording
     *  of a black-frame diagnosis. */
    revealed?: boolean;
}

export interface CaptureSubjectResult {
    /** image/png or image/jpeg data URL — the deliverable. */
    dataUrl: string;
    width: number;
    height: number;
    frameId: number;
    gameFrame: number;
    stats?: LuminanceStats;

    subject: {
        kind: 'unit' | 'units' | 'def' | 'position' | 'area';
        unitId: number | null;
        unitIds: number[];
        def: string | null;
        /** The sphere actually framed, as the rig latched it. */
        sphere: Sphere;
        metresAcross: number;
        /** true = real model, false = procedural fallback shape, null =
         *  still loading / not applicable. */
        hasModel: boolean | null;
    };
    framing: Framing & { angle: CaptureAngle; distance: number };
    attempts: AttemptRecord[];
    warnings: string[];
    /** Non-null means the image is a diagnosis, not a deliverable. */
    diagnosis: string | null;
    /** false when the frame is unusable (black) or the subject never resolved. */
    ok: boolean;
}
