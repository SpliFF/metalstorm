/**
 * impostor-atlas.ts — the runtime half of the impostor sprite-atlas layout
 * convention (PLAN-metalstorm-impostors.md "Atlas format (v2)"). The baker half
 * is `tools/fable-model-forge/impostor_convention.py`; the two are kept in step
 * by a cross-check test that reads the constants out of that file.
 *
 * Baker/runtime disagreement here is a silent wrong-frame bug, and it has
 * already happened once: two independently-written, each-internally-consistent
 * implementations disagreed by 180 degrees about what column 0 was, while both
 * rendered "correct" pixels for their own baker. The fix (user decision
 * 2026-08-03, option (b)) is that an atlas DECLARES its own arc and phase in
 * metadata and the runtime reads what it is told, rather than either side
 * assuming a global convention:
 *
 *   - Grid = `yawBins` columns x (`pitchBins` * `frames`) rows.
 *   - Columns = camera AZIMUTH relative to the instance's own facing, i.e. the
 *     runtime's `atan2(toCamX, toCamZ) - heading`. Which view column 0 holds is
 *     the atlas's `azimuthPhase` — see it below, and mind that the zero point
 *     is the BACK, not the front.
 *   - Rows, top->bottom within a frame group = camera ELEVATION above the
 *     instance's horizon, at the atlas's own `pitchDegrees`.
 *   - Flipbook frames extend downward as further row groups:
 *     `row = frame * pitchBins + pitchRow`.
 *   - Legacy single-view atlases are just `{yawBins: 1, pitchBins: 1,
 *     frames: 1}` — cell 0, full-texture UVs, i.e. exactly today's behaviour.
 *
 * Everything in this module is pure (no Babylon) so it is unit-testable and
 * usable from both the unit/squad impostor path and the map-feature LOD path.
 */

/** Atlas grid description. Carried by the def / atlas manifest. */
export interface AtlasLayout {
    /** Columns — camera azimuth bins around the instance. */
    yawBins: number;
    /** Rows per animation frame — camera elevation bins. */
    pitchBins: number;
    /** Animation frames (row groups). 1 = static. */
    frames: number;
    /** Elevation (degrees above the horizon) each pitch row was baked at.
     *  Bakers emit their own arc — the `vegetation` convention uses 18/42/68
     *  where the `infantry_v2` sheets use 15/45/80 — so the runtime must read
     *  the baker's numbers rather than assume. Absent = the defaults below. */
    pitchDegrees?: readonly number[];
    /**
     * Relative yaw (RADIANS) that column 0 was baked at — i.e. the atlas's
     * azimuth phase. Absent = {@link DEFAULT_AZIMUTH_PHASE}.
     *
     * Relative yaw is `viewYaw - heading`, and its zero point is easy to get
     * backwards, so: placing a `-Z`-forward model at heading `h` sends its
     * forward to world `(-sin h, ., -cos h)`, which makes the camera direction
     * at relative yaw 0 exactly `-forward`. So
     *
     *   - relative yaw 0   = camera directly BEHIND, showing the instance's BACK
     *   - relative yaw PI  = camera directly IN FRONT, showing its FRONT
     *
     * and hence {@link AZIMUTH_PHASE_COL0_BACK} = 0 (the default, and what
     * every atlas baked by `bake_impostors.py`'s `vegetation` convention uses)
     * versus {@link AZIMUTH_PHASE_COL0_FRONT} = PI (the `infantry_v2` sheets).
     * Column `c` sits at relative yaw `azimuthPhase + c*2PI/yawBins`.
     */
    azimuthPhase?: number;
}

/** Phase whose column 0 is the instance's BACK view. The DEFAULT: an atlas that
 *  declares no phase is read this way, so existing atlases are unaffected. */
export const AZIMUTH_PHASE_COL0_BACK = 0;

/** Phase whose column 0 is the instance's FRONT view. */
export const AZIMUTH_PHASE_COL0_FRONT = Math.PI;

/** Applied when an atlas declares no `azimuthPhase`. */
export const DEFAULT_AZIMUTH_PHASE = AZIMUTH_PHASE_COL0_BACK;

/** Raw layout as it arrives from an atlas sidecar / manifest / def JSON. The
 *  wire spells the phase in DEGREES (`azimuthPhaseDegrees`) while this module
 *  works in radians, so the unit is named on the wire rather than left to a
 *  convention that could silently invert. */
export type RawAtlasLayout = Partial<AtlasLayout> & {
    /** Baker/manifest spelling of {@link AtlasLayout.azimuthPhase}, in degrees. */
    azimuthPhaseDegrees?: number;
    /** Legacy manifest spelling of {@link AtlasLayout.pitchDegrees}. */
    pitches?: readonly number[];
};

/** v2 default: 8 azimuth x 3 elevation, single frame. */
export const DEFAULT_ATLAS_LAYOUT: AtlasLayout = { yawBins: 8, pitchBins: 3, frames: 1 };

/** Single-cell atlas — what a legacy front-view-only sprite sheet is. */
export const SINGLE_CELL_LAYOUT: AtlasLayout = { yawBins: 1, pitchBins: 1, frames: 1 };

/**
 * LEGACY FALLBACK arc for a 3-row atlas that declares no `pitchDegrees`.
 *
 * This is NOT "the" convention — different atlases ship different arcs, which is
 * why `pitchDegrees` travels with each one. It happens to match `infantry_v2`
 * (15/45/80) and NOT the `vegetation` bake (18/42/68), so a multi-row atlas that
 * loses its declared arc in transit will silently select rows against the wrong
 * elevations. Kept only so undeclared atlases keep behaving exactly as they do
 * today; every baker emits the arc, and a multi-row atlas should always declare.
 */
export const PITCH_BIN_DEGREES: readonly number[] = [15, 45, 80];

/** Normalise a possibly-partial layout from JSON/def data. */
export function normalizeAtlasLayout(raw: RawAtlasLayout | null | undefined): AtlasLayout {
    const clamp = (v: unknown, fallback: number): number => {
        const n = typeof v === 'number' && Number.isFinite(v) ? Math.floor(v) : fallback;
        return n >= 1 ? n : 1;
    };
    const pitchBins = clamp(raw?.pitchBins, 1);
    // `pitches` is the older manifest spelling of the same field; accept both so
    // a sidecar written by the baker (`pitchDegrees`) can't silently lose its arc
    // and fall back to a DIFFERENT one than the atlas was baked on.
    const pitches = raw?.pitchDegrees ?? raw?.pitches;
    const usable = Array.isArray(pitches)
        && pitches.length === pitchBins
        && pitches.every((p) => typeof p === 'number' && Number.isFinite(p));
    return {
        yawBins: clamp(raw?.yawBins, 1),
        pitchBins,
        frames: clamp(raw?.frames, 1),
        azimuthPhase: normalizeAzimuthPhase(raw),
        ...(usable ? { pitchDegrees: [...(pitches as readonly number[])] } : {}),
    };
}

/** Resolve the azimuth phase in radians, preferring the wire's explicit
 *  `azimuthPhaseDegrees`, then a radian `azimuthPhase`, then the default.
 *  Wrapped into [0, 2PI) so a negative or over-turn declaration still lands on
 *  the same column. */
function normalizeAzimuthPhase(raw: RawAtlasLayout | null | undefined): number {
    const deg = raw?.azimuthPhaseDegrees;
    const rad = typeof deg === 'number' && Number.isFinite(deg)
        ? (deg * Math.PI) / 180
        : (typeof raw?.azimuthPhase === 'number' && Number.isFinite(raw.azimuthPhase)
            ? raw.azimuthPhase
            : DEFAULT_AZIMUTH_PHASE);
    const wrapped = rad % (2 * Math.PI);
    return wrapped < 0 ? wrapped + 2 * Math.PI : wrapped;
}

/** Total cells in the atlas. */
export function atlasCellCount(layout: AtlasLayout): number {
    return layout.yawBins * layout.pitchBins * layout.frames;
}

/** Rows in the atlas image (all frame groups stacked). */
export function atlasRowCount(layout: AtlasLayout): number {
    return layout.pitchBins * layout.frames;
}

/**
 * Does this atlas hold more than one view? A multi-cell sheet needs the
 * per-instance UV remap (and, because that remap cannot reach Babylon's shadow
 * depth shader, must be kept out of the shadow caster list — see
 * `impostor-uv-plugin.ts`). A 1x1x1 legacy sheet needs neither.
 */
export function isDirectionalAtlas(layout: AtlasLayout): boolean {
    return atlasCellCount(layout) > 1;
}

/**
 * Does an impostor card for this atlas TILT with the camera pitch (a full
 * screen-aligned/spherical billboard), or stay upright and only yaw?
 *
 * The answer is a property of the ATLAS, not a global convention — which is
 * why it lives here beside the layout rather than being hardcoded per
 * renderer (PLAN-metalstorm-impostors.md §Card orientation, amended):
 *
 *  - `pitchBins > 1` — the sheet was baked from several camera ELEVATIONS, so
 *    a steep camera has a real top-down row to show. The card must tilt to
 *    face the camera, or that row is painted onto a quad which is nearly
 *    edge-on to the viewer and reads as a dark smudge.
 *  - `pitchBins === 1` — the sheet is a single horizon-level view. Tilting it
 *    flat under a steep camera shows that FRONT view lying on the ground, i.e.
 *    a unit that appears to have fallen over. An upright, yaw-only card is
 *    correct here; the foreshortening is the honest cost of having no
 *    elevation rows to select from.
 *
 * So a single-row atlas keeps the upright convention and automatically starts
 * tilting the moment it is re-baked with elevation rows — no renderer change.
 */
export function cardTiltsWithPitch(layout: AtlasLayout): boolean {
    return layout.pitchBins > 1;
}

/**
 * Quantize an angle (radians) to the nearest of `bins` evenly-spaced azimuth
 * columns. Generalises `quantizeHeading()` (impostor-renderer.ts, bins = 8) to
 * any grid width; negative and >2pi inputs wrap.
 */
export function quantizeYawBin(radians: number, bins: number): number {
    if (bins <= 1) return 0;
    const step = (2 * Math.PI) / bins;
    let n = radians % (2 * Math.PI);
    if (n < 0) n += 2 * Math.PI;
    return Math.floor((n + step / 2) / step) % bins;
}

/** Elevation bin centres (degrees) for a given row count. The baker's own arc
 *  wins when it is known; otherwise the canonical 3-bin case uses the authored
 *  15/45/80 split and any other count is spread evenly across 0..90 so a
 *  re-baked atlas with more rows still resolves sensibly. */
export function pitchBinCentres(pitchBins: number, baked?: readonly number[]): number[] {
    if (baked && baked.length === pitchBins) return [...baked];
    if (pitchBins <= 1) return [45];
    if (pitchBins === PITCH_BIN_DEGREES.length) return PITCH_BIN_DEGREES.slice();
    const out: number[] = [];
    for (let i = 0; i < pitchBins; i++) out.push(((i + 0.5) * 90) / pitchBins);
    return out;
}

/**
 * Pick the elevation row for a camera pitch (radians above the instance's
 * horizon; negative = camera below, clamped to the lowest row).
 */
export function selectPitchRow(
    pitchRadians: number, pitchBins: number, baked?: readonly number[],
): number {
    if (pitchBins <= 1) return 0;
    const deg = Math.min(90, Math.max(0, (pitchRadians * 180) / Math.PI));
    const centres = pitchBinCentres(pitchBins, baked);
    let best = 0;
    let bestDist = Infinity;
    for (let i = 0; i < centres.length; i++) {
        const d = Math.abs(deg - centres[i]);
        if (d < bestDist) { bestDist = d; best = i; }
    }
    return best;
}

/** Flatten (column, pitch row, frame) into the single cell index the GPU
 *  attribute carries. */
export function atlasCellIndex(col: number, pitchRow: number, frame: number, layout: AtlasLayout): number {
    const c = Math.min(layout.yawBins - 1, Math.max(0, col | 0));
    const r = Math.min(layout.pitchBins - 1, Math.max(0, pitchRow | 0));
    const f = Math.min(layout.frames - 1, Math.max(0, frame | 0));
    return (f * layout.pitchBins + r) * layout.yawBins + c;
}

/**
 * Choose the atlas cell for one instance given the vector from the instance to
 * the camera (world space, Babylon RH: heading 0 = +Z) and the instance's own
 * heading.
 *
 * The column comes from the relative yaw `viewYaw - heading`, offset by the
 * atlas's own {@link AtlasLayout.azimuthPhase} — so column 0 shows whatever view
 * that atlas baked there. With the default phase of 0 that is the instance's
 * BACK (relative yaw 0 puts the camera directly behind it); a `PI`-phase sheet
 * such as `infantry_v2` has its FRONT view in column 0 instead. The phase is
 * read from the atlas rather than assumed, because two bakers already ship
 * disagreeing by exactly this 180 degrees.
 */
export function selectAtlasCell(
    toCamX: number, toCamY: number, toCamZ: number,
    heading: number, layout: AtlasLayout, frame = 0,
): number {
    if (layout.yawBins <= 1 && layout.pitchBins <= 1 && layout.frames <= 1) return 0;
    const viewYaw = Math.atan2(toCamX, toCamZ);
    const phase = layout.azimuthPhase ?? DEFAULT_AZIMUTH_PHASE;
    const col = quantizeYawBin(viewYaw - heading - phase, layout.yawBins);
    const flat = Math.sqrt(toCamX * toCamX + toCamZ * toCamZ);
    // Straight overhead (flat ~ 0) reads as the highest elevation row.
    const pitch = flat < 1e-4 ? Math.PI / 2 : Math.atan2(toCamY, flat);
    const row = selectPitchRow(pitch, layout.pitchBins, layout.pitchDegrees);
    return atlasCellIndex(col, row, frame, layout);
}

/** UV sub-rect for a cell: multiply the quad's 0..1 UV by (su, sv) then add
 *  (ou, ov). `topDown` = row 0 is the TOP row of the image (the baker's
 *  convention); set false if a source atlas is stored bottom-up. */
export function atlasCellUv(
    cellIndex: number, layout: AtlasLayout, topDown = true,
): { su: number; sv: number; ou: number; ov: number } {
    const cols = Math.max(1, layout.yawBins);
    const rows = Math.max(1, atlasRowCount(layout));
    const idx = Math.min(cols * rows - 1, Math.max(0, cellIndex | 0));
    const col = idx % cols;
    const row = Math.floor(idx / cols) % rows;
    const su = 1 / cols;
    const sv = 1 / rows;
    return {
        su, sv,
        ou: col * su,
        ov: topDown ? 1 - (row + 1) * sv : row * sv,
    };
}
