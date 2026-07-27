/**
 * impostor-atlas.ts — the ONE place the impostor sprite-atlas layout
 * convention lives (PLAN-metalstorm-impostors.md "Atlas format (v2)").
 *
 * Both the baker and the runtime must agree on this or you get a silent
 * wrong-frame bug, so the convention is stated once, here, and imported
 * everywhere else:
 *
 *   - Grid = `yawBins` columns x (`pitchBins` * `frames`) rows.
 *   - Columns = camera AZIMUTH relative to the instance's own forward axis,
 *     clockwise. Column 0 = dead-front view, column `yawBins/4` = viewed from
 *     the instance's right, column `yawBins/2` = back.
 *   - Rows, top->bottom within a frame group = camera ELEVATION above the
 *     instance's horizon. The 3-bin default is 15 deg / 45 deg / 80 deg.
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
     *  Bakers emit their own arc — `bake_impostors.py` uses 18/42/68 where the
     *  §2.1 hand-authored sheets used 15/45/80 — so the runtime must read the
     *  baker's numbers rather than assume. Absent = the defaults below. */
    pitchDegrees?: readonly number[];
}

/** v2 default: 8 azimuth x 3 elevation, single frame. */
export const DEFAULT_ATLAS_LAYOUT: AtlasLayout = { yawBins: 8, pitchBins: 3, frames: 1 };

/** Single-cell atlas — what a legacy front-view-only sprite sheet is. */
export const SINGLE_CELL_LAYOUT: AtlasLayout = { yawBins: 1, pitchBins: 1, frames: 1 };

/** Elevation (degrees above the instance horizon) each pitch row was baked at,
 *  for the canonical 3-bin layout. */
export const PITCH_BIN_DEGREES: readonly number[] = [15, 45, 80];

/** Normalise a possibly-partial layout from JSON/def data. */
export function normalizeAtlasLayout(raw: Partial<AtlasLayout> | null | undefined): AtlasLayout {
    const clamp = (v: unknown, fallback: number): number => {
        const n = typeof v === 'number' && Number.isFinite(v) ? Math.floor(v) : fallback;
        return n >= 1 ? n : 1;
    };
    const pitchBins = clamp(raw?.pitchBins, 1);
    const pitches = raw?.pitchDegrees;
    const usable = Array.isArray(pitches)
        && pitches.length === pitchBins
        && pitches.every((p) => typeof p === 'number' && Number.isFinite(p));
    return {
        yawBins: clamp(raw?.yawBins, 1),
        pitchBins,
        frames: clamp(raw?.frames, 1),
        ...(usable ? { pitchDegrees: [...(pitches as readonly number[])] } : {}),
    };
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
 */
export function selectAtlasCell(
    toCamX: number, toCamY: number, toCamZ: number,
    heading: number, layout: AtlasLayout, frame = 0,
): number {
    if (layout.yawBins <= 1 && layout.pitchBins <= 1 && layout.frames <= 1) return 0;
    const viewYaw = Math.atan2(toCamX, toCamZ);
    const col = quantizeYawBin(viewYaw - heading, layout.yawBins);
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
