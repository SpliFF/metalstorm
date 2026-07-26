/**
 * impostor-atlas — the runtime (TS) mirror of the ONE shared v2 directional
 * impostor atlas layout, `tools/fable-model-forge/impostor_convention.py`
 * (PLAN-metalstorm-impostors.md §"Atlas format (v2)" / M3).
 *
 * Convention drift between the baker (Python) and the runtime (here) —
 * column-0 meaning, clockwise vs CCW, pitch-from-horizon vs zenith — is the
 * top correctness risk the plan calls out. Both sides derive the SAME
 * numbers; `impostor-atlas.test.ts` reads impostor_convention.py and asserts
 * these constants agree, and the same test cross-checks the column math
 * against the actual heading→world-facing transform used to place the 3D
 * models (RotationYawPitchRoll), so a sprite frame always shows the face a
 * real model would show at that heading.
 *
 * ── The runtime column formula (derived, tested) ─────────────────────────
 * A member/model at wire heading `h` (radians) is placed with
 * `RotationYawPitchRoll(h, pitch, roll)` (entity-renderer.ts, squad-render-
 * backend.ts). Empirically that maps the model's forward axis (−Z in the
 * meshlib/SPRINGRTS_geometry frame — see impostor_convention.py) to the
 * world direction `(−sin h, 0, −cos h)`. The baker renders column `c` for a
 * camera whose unit→camera direction, in the MODEL frame, is
 * `(−sin θ, 0, −cos θ)` with `θ = c·360/yawBins`. Rotating that model-frame
 * direction by the heading gives the world unit→camera direction
 * `(−sin(θ+h), 0, −cos(θ+h))`. With `viewYaw = atan2(V.x, V.z)` (V =
 * unit→camera), solving gives:
 *
 *     θ = viewYaw − heading − π          (mod 2π)
 *
 * which yields col0 = front, col2 = the unit's right, col4 = back, col6 =
 * left — exactly the baker's column anchors.
 */

// ── Shared constants (MUST equal impostor_convention.py) ──────────────────

export const YAW_BINS = 8;
export const PITCH_BINS = 3;
export const FRAMES = 1;
export const CELL_PX = 256;
/** Camera elevation (degrees above the unit's horizon) for each pitch row,
 *  top→bottom. Row 0 = shallow (a near-level camera), last row = steep (a
 *  top-down RTS camera reads the lower rows). */
export const PITCH_DEGREES = [15.0, 45.0, 80.0];

/** Per-atlas grid. Defaults (1/1/1) describe a legacy single-frame atlas or a
 *  non-metalstorm game — those keep the whole-quad UV mapping and never
 *  directional-select. */
export interface AtlasGrid {
    yawBins: number;
    pitchBins: number;
    frames: number;
}

export const DEFAULT_GRID: AtlasGrid = { yawBins: 1, pitchBins: 1, frames: 1 };

/** True when this grid actually has more than one view cell (i.e. the v2
 *  directional path applies). A 1×1×1 grid is a plain single sprite. */
export function isDirectional(g: AtlasGrid): boolean {
    return g.yawBins * g.pitchBins * g.frames > 1;
}

/** Total atlas rows (frames stack downward: row = frame·pitchBins + pitch). */
export function atlasRows(g: AtlasGrid): number {
    return g.pitchBins * g.frames;
}

// ── Frame selection (pure — heading-relative, per instance, per frame) ────

/**
 * Yaw column for a camera looking at a unit of the given world facing.
 * `viewYaw = atan2(V.x, V.z)`, V = unit→camera (Babylon RH). `heading` is the
 * wire heading in radians (the same value fed to RotationYawPitchRoll). See
 * the module header for the `θ = viewYaw − heading − π` derivation.
 */
export function selectColumn(viewYaw: number, heading: number, yawBins: number): number {
    if (yawBins <= 1) return 0;
    const step = (2 * Math.PI) / yawBins;
    let a = (viewYaw - heading - Math.PI) % (2 * Math.PI);
    if (a < 0) a += 2 * Math.PI;
    return Math.floor((a + step / 2) / step) % yawBins;
}

/**
 * Pitch row for a camera elevation `pitchRad` above the unit's horizon
 * (`atan2(V.y, |V.xz|)`, ≥0 = camera above). Picks the nearest of the
 * convention's PITCH_DEGREES for the standard 3-bin atlas; for any other bin
 * count it splits [0°,90°] into evenly spaced bin centres. Clamped to a valid
 * row so a below-horizon or straight-down camera never indexes out of range.
 */
export function selectPitchRow(pitchRad: number, pitchBins: number): number {
    if (pitchBins <= 1) return 0;
    const deg = Math.max(0, Math.min(90, (pitchRad * 180) / Math.PI));
    const table = pitchBins === PITCH_DEGREES.length
        ? PITCH_DEGREES
        : Array.from({ length: pitchBins }, (_, i) => (90 * (i + 0.5)) / pitchBins);
    let best = 0;
    let bestErr = Infinity;
    for (let i = 0; i < table.length; i++) {
        const err = Math.abs(deg - table[i]);
        if (err < bestErr) { bestErr = err; best = i; }
    }
    return best;
}

/**
 * Pack (column, pitch row, frame) into the single per-instance float attribute
 * the UV-select material plugin reads. Atlas rows stack as
 * `row = frame·pitchBins + pitch`, and the packed index is `row·yawBins + col`
 * (so the shader recovers `col = mod(idx, yawBins)`, `row = floor(idx/yawBins)`).
 */
export function packCellIndex(col: number, pitchRow: number, frame: number, g: AtlasGrid): number {
    const row = frame * g.pitchBins + pitchRow;
    return row * g.yawBins + col;
}

/**
 * Convenience: full per-instance frame select from a unit's pose + the camera.
 * `V` = unit→camera (world). Returns the packed cell index.
 */
export function selectCellIndex(
    vx: number, vy: number, vz: number, heading: number, g: AtlasGrid, frame = 0,
): number {
    const viewYaw = Math.atan2(vx, vz);
    const col = selectColumn(viewYaw, heading, g.yawBins);
    const dxz = Math.hypot(vx, vz);
    const pitch = Math.atan2(vy, dxz);
    const row = selectPitchRow(pitch, g.pitchBins);
    return packCellIndex(col, row, frame, g);
}

/**
 * The normalized UV rectangle of one cell, top-origin (matching
 * impostor_convention.cell_origin, which measures rows from the top). The
 * material plugin computes the same rect in the vertex shader; this pure
 * function exists so unit tests can assert the per-cell mapping. `row` is the
 * atlas row (`frame·pitchBins + pitch`), not the pitch bin.
 */
export interface UvRect { u0: number; v0: number; du: number; dv: number; }
export function cellUvRect(col: number, row: number, g: AtlasGrid): UvRect {
    const rows = atlasRows(g);
    const du = 1 / g.yawBins;
    const dv = 1 / rows;
    return { u0: col * du, v0: row * dv, du, dv };
}
