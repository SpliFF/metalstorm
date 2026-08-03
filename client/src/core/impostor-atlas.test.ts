import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
    DEFAULT_ATLAS_LAYOUT,
    SINGLE_CELL_LAYOUT,
    PITCH_BIN_DEGREES,
    AZIMUTH_PHASE_COL0_BACK,
    AZIMUTH_PHASE_COL0_FRONT,
    DEFAULT_AZIMUTH_PHASE,
    normalizeAtlasLayout,
    atlasCellCount,
    atlasRowCount,
    quantizeYawBin,
    pitchBinCentres,
    selectPitchRow,
    atlasCellIndex,
    selectAtlasCell,
    atlasCellUv,
    cardTiltsWithPitch,
    type AtlasLayout,
} from './impostor-atlas.js';

// PLAN-metalstorm-impostors.md "Atlas format (v2)". The baker and the runtime
// must agree on this grid or you get a silent wrong-frame bug, so the
// convention is pinned here: columns = camera azimuth relative to the
// instance's forward axis, rows = camera elevation, frames stack downward.

const deg = (d: number): number => (d * Math.PI) / 180;

describe('normalizeAtlasLayout', () => {
    // Normalising always RESOLVES the azimuth phase, so a consumer never has to
    // repeat the defaulting rule (and can't forget to).
    const backAnchored = { azimuthPhase: AZIMUTH_PHASE_COL0_BACK };

    it('defaults a missing/garbage layout to a single cell (legacy atlas)', () => {
        expect(normalizeAtlasLayout(null)).toEqual({ ...SINGLE_CELL_LAYOUT, ...backAnchored });
        expect(normalizeAtlasLayout({ yawBins: 0, pitchBins: -3 }))
            .toEqual({ ...SINGLE_CELL_LAYOUT, ...backAnchored });
        expect(normalizeAtlasLayout({ yawBins: NaN }))
            .toEqual({ ...SINGLE_CELL_LAYOUT, ...backAnchored });
    });

    it('floors fractional bin counts', () => {
        expect(normalizeAtlasLayout({ yawBins: 8.9, pitchBins: 3.2, frames: 1 }))
            .toEqual({ yawBins: 8, pitchBins: 3, frames: 1, ...backAnchored });
    });
});

describe('atlas geometry', () => {
    it('counts cells and rows for the v2 default', () => {
        expect(atlasCellCount(DEFAULT_ATLAS_LAYOUT)).toBe(24);
        expect(atlasRowCount(DEFAULT_ATLAS_LAYOUT)).toBe(3);
    });

    it('stacks flipbook frames as further row groups', () => {
        const layout = { yawBins: 8, pitchBins: 3, frames: 4 };
        expect(atlasRowCount(layout)).toBe(12);
        expect(atlasCellCount(layout)).toBe(96);
    });
});

describe('quantizeYawBin', () => {
    it('matches quantizeHeading for the 8-bin case', () => {
        expect(quantizeYawBin(0, 8)).toBe(0);
        expect(quantizeYawBin(Math.PI / 4, 8)).toBe(1);
        expect(quantizeYawBin(Math.PI, 8)).toBe(4);
        expect(quantizeYawBin(-Math.PI / 4, 8)).toBe(7);
        expect(quantizeYawBin(2 * Math.PI + 0.001, 8)).toBe(0);
    });

    it('rounds to the nearest bin rather than flooring', () => {
        expect(quantizeYawBin(Math.PI / 8 + 0.01, 8)).toBe(1);
        expect(quantizeYawBin(Math.PI / 8 - 0.01, 8)).toBe(0);
    });

    it('collapses to bin 0 for a single-column atlas', () => {
        expect(quantizeYawBin(3.1, 1)).toBe(0);
    });

    it('generalises to other grid widths', () => {
        expect(quantizeYawBin(Math.PI / 2, 4)).toBe(1);
        expect(quantizeYawBin(deg(30), 16)).toBe(1);
    });
});

describe('selectPitchRow', () => {
    it('uses the authored 15/45/80 split for the canonical 3-row atlas', () => {
        expect(pitchBinCentres(3)).toEqual([...PITCH_BIN_DEGREES]);
        expect(selectPitchRow(deg(10), 3)).toBe(0);
        expect(selectPitchRow(deg(40), 3)).toBe(1);
        expect(selectPitchRow(deg(85), 3)).toBe(2);
    });

    it('clamps a camera below the horizon to the lowest row', () => {
        expect(selectPitchRow(deg(-40), 3)).toBe(0);
    });

    it('clamps a straight-overhead camera to the top row', () => {
        expect(selectPitchRow(deg(120), 3)).toBe(2);
    });

    it('collapses to row 0 for a single-row atlas', () => {
        expect(selectPitchRow(deg(80), 1)).toBe(0);
    });

    it('spreads evenly for non-canonical row counts', () => {
        expect(pitchBinCentres(2)).toEqual([22.5, 67.5]);
        expect(selectPitchRow(deg(10), 2)).toBe(0);
        expect(selectPitchRow(deg(80), 2)).toBe(1);
    });

    it("prefers the baker's own arc when the sidecar reports one", () => {
        // bake_impostors.py bakes 18/42/68, not the hand-authored 15/45/80.
        const baked = [18, 42, 68];
        expect(pitchBinCentres(3, baked)).toEqual(baked);
        // 55deg is nearer 45 than 80 either way, but 75deg flips: nearest of
        // {15,45,80} is 80 (row 2), nearest of {18,42,68} is 68 (row 2) —
        // 56deg is the discriminating case (row 1 vs row 2).
        expect(selectPitchRow(deg(56), 3)).toBe(1);
        expect(selectPitchRow(deg(56), 3, baked)).toBe(2);
    });

    it('carries the baked arc through normalizeAtlasLayout and cell select', () => {
        const layout = normalizeAtlasLayout({ yawBins: 8, pitchBins: 3, frames: 1, pitchDegrees: [18, 42, 68] });
        expect(layout.pitchDegrees).toEqual([18, 42, 68]);
        // Camera 56deg up, dead in front: row 2 under the baked arc.
        const d = 100;
        const cell = selectAtlasCell(0, d * Math.tan(deg(56)), d, 0, layout);
        expect(Math.floor(cell / 8)).toBe(2);
    });

    it('ignores a pitchDegrees array that does not match the row count', () => {
        expect(normalizeAtlasLayout({ yawBins: 8, pitchBins: 3, frames: 1, pitchDegrees: [10, 20] })
            .pitchDegrees).toBeUndefined();
    });
});

describe('atlasCellIndex', () => {
    it('lays cells out row-major with frames stacked below', () => {
        const layout = { yawBins: 8, pitchBins: 3, frames: 2 };
        expect(atlasCellIndex(0, 0, 0, layout)).toBe(0);
        expect(atlasCellIndex(3, 0, 0, layout)).toBe(3);
        expect(atlasCellIndex(0, 1, 0, layout)).toBe(8);
        expect(atlasCellIndex(0, 0, 1, layout)).toBe(24);
        expect(atlasCellIndex(7, 2, 1, layout)).toBe(47);
    });

    it('clamps out-of-range inputs instead of producing a wild index', () => {
        expect(atlasCellIndex(99, 99, 99, DEFAULT_ATLAS_LAYOUT)).toBe(23);
        expect(atlasCellIndex(-5, -5, -5, DEFAULT_ATLAS_LAYOUT)).toBe(0);
    });
});

describe('selectAtlasCell', () => {
    // A forge model's forward axis is -Z, and placing it at heading h rotates it
    // about +Y, sending that forward to world (-sin h, ., -cos h). So a camera on
    // +Z is looking at the BACK of an instance at heading 0 — relative yaw 0 is
    // the back, not the front. `impostor-renderer.test.ts` pins that against
    // Babylon's real transform; these cases pin the resulting column choice.
    it('picks column 0 for a camera behind the instance (default phase)', () => {
        // Camera on +Z at 15deg elevation, instance at heading 0 => its back.
        const cell = selectAtlasCell(0, 26.79, 100, 0, DEFAULT_ATLAS_LAYOUT);
        expect(cell % 8).toBe(0);
        expect(Math.floor(cell / 8)).toBe(0);
    });

    it('picks the opposite column for a camera in front of the instance', () => {
        const cell = selectAtlasCell(0, 26.79, -100, 0, DEFAULT_ATLAS_LAYOUT);
        expect(cell % 8).toBe(4);
    });

    it('is relative to the instance heading, not the world axes', () => {
        // Camera due +Z, instance at heading 0 => back view, column 0.
        const cell = selectAtlasCell(0, 26.79, 100, 0, DEFAULT_ATLAS_LAYOUT);
        // Instance rotated 90deg: the camera now sees one of its sides.
        const turned = selectAtlasCell(0, 26.79, 100, Math.PI / 2, DEFAULT_ATLAS_LAYOUT);
        expect(cell % 8).toBe(0);
        expect(turned % 8).toBe(6);
    });

    it('climbs the pitch rows as the camera rises', () => {
        const low = selectAtlasCell(0, 26, 100, 0, DEFAULT_ATLAS_LAYOUT);
        const mid = selectAtlasCell(0, 100, 100, 0, DEFAULT_ATLAS_LAYOUT);
        const high = selectAtlasCell(0, 600, 100, 0, DEFAULT_ATLAS_LAYOUT);
        expect(Math.floor(low / 8)).toBe(0);
        expect(Math.floor(mid / 8)).toBe(1);
        expect(Math.floor(high / 8)).toBe(2);
    });

    it('reads a straight-overhead camera as the top pitch row', () => {
        expect(Math.floor(selectAtlasCell(0, 500, 0, 0, DEFAULT_ATLAS_LAYOUT) / 8)).toBe(2);
    });

    it('is always cell 0 for a legacy single-view atlas', () => {
        expect(selectAtlasCell(37, 91, -12, 1.3, SINGLE_CELL_LAYOUT)).toBe(0);
    });
});

describe('atlasCellUv', () => {
    it('is the whole texture for a single-cell atlas', () => {
        expect(atlasCellUv(0, SINGLE_CELL_LAYOUT)).toEqual({ su: 1, sv: 1, ou: 0, ov: 0 });
    });

    // The card's UVs are IMAGE space — v = 0 at the top edge, growing downward
    // (createImpostorCard, impostor-renderer.ts) — because that is where a KTX2
    // puts its top image row. So row 0 offsets to v = 0, with NO flip. Asserting
    // the bottom-up form here instead is exactly the bug that shipped: it
    // mirrored every sprite AND selected pitch row `pitchBins-1-row`.
    it('maps cell 0 to the TOP-LEFT of the image (baker convention)', () => {
        const uv = atlasCellUv(0, DEFAULT_ATLAS_LAYOUT);
        expect(uv.su).toBeCloseTo(1 / 8, 6);
        expect(uv.sv).toBeCloseTo(1 / 3, 6);
        expect(uv.ou).toBe(0);
        expect(uv.ov).toBeCloseTo(0, 6);
    });

    it('walks columns left to right and rows top to bottom', () => {
        expect(atlasCellUv(3, DEFAULT_ATLAS_LAYOUT).ou).toBeCloseTo(3 / 8, 6);
        expect(atlasCellUv(8, DEFAULT_ATLAS_LAYOUT).ov).toBeCloseTo(1 / 3, 6);
        expect(atlasCellUv(16, DEFAULT_ATLAS_LAYOUT).ov).toBeCloseTo(2 / 3, 6);
    });

    // Row order (which cell) and V direction (which way up the cell's pixels
    // are) are separate failures that can partially mask each other, so pin the
    // monotonic direction on its own: later rows must sit FURTHER DOWN the
    // image, i.e. at a strictly larger v offset.
    it('gives later pitch rows a strictly larger v offset', () => {
        const ovs = [0, 8, 16].map((c) => atlasCellUv(c, DEFAULT_ATLAS_LAYOUT).ov);
        expect(ovs[0]).toBeLessThan(ovs[1]);
        expect(ovs[1]).toBeLessThan(ovs[2]);
    });

    it('flips row order when the atlas is stored bottom-up', () => {
        expect(atlasCellUv(0, DEFAULT_ATLAS_LAYOUT, false).ov).toBeCloseTo(2 / 3, 6);
        expect(atlasCellUv(8, DEFAULT_ATLAS_LAYOUT, false).ov).toBeCloseTo(1 / 3, 6);
        expect(atlasCellUv(16, DEFAULT_ATLAS_LAYOUT, false).ov).toBeCloseTo(0, 6);
    });

    it('clamps an out-of-range cell into the grid', () => {
        expect(atlasCellUv(999, DEFAULT_ATLAS_LAYOUT)).toEqual(atlasCellUv(23, DEFAULT_ATLAS_LAYOUT));
    });
});

// §Card orientation: a card may only tilt with the camera pitch if its atlas
// actually holds elevation rows for the steep view to land on.
describe('card tilt rule', () => {
    it('tilts only when the atlas has more than one elevation row', () => {
        expect(cardTiltsWithPitch(DEFAULT_ATLAS_LAYOUT)).toBe(true);
        expect(cardTiltsWithPitch(SINGLE_CELL_LAYOUT)).toBe(false);
    });

    it('does not tilt a multi-column, single-row sheet', () => {
        // 8 yaw views but one horizon-level elevation: turning is correct,
        // tilting would lay that horizon view flat on the ground.
        expect(cardTiltsWithPitch({ yawBins: 8, pitchBins: 1, frames: 1 })).toBe(false);
    });

    it('ignores flipbook frames — only elevation rows license a tilt', () => {
        expect(cardTiltsWithPitch({ yawBins: 8, pitchBins: 1, frames: 4 })).toBe(false);
        expect(cardTiltsWithPitch({ yawBins: 8, pitchBins: 2, frames: 4 })).toBe(true);
    });
});

// ── Azimuth phase (user decision 2026-08-03, option (b)) ──────────────────
//
// Two bakers already ship disagreeing by exactly 180deg about which view sits in
// column 0, each self-consistent with its own runtime. Rather than re-baking
// either set, an atlas DECLARES its phase and the runtime reads it.
describe('azimuth phase', () => {
    const atPhase = (azimuthPhase: number): AtlasLayout =>
        ({ ...DEFAULT_ATLAS_LAYOUT, azimuthPhase });

    it('defaults to the back-anchored phase, i.e. today’s behaviour', () => {
        expect(DEFAULT_AZIMUTH_PHASE).toBe(AZIMUTH_PHASE_COL0_BACK);
        expect(AZIMUTH_PHASE_COL0_BACK).toBe(0);
        expect(AZIMUTH_PHASE_COL0_FRONT).toBeCloseTo(Math.PI, 12);
        // An undeclared atlas must select exactly what it selects today.
        expect(normalizeAtlasLayout({ yawBins: 8, pitchBins: 3, frames: 1 }).azimuthPhase)
            .toBe(AZIMUTH_PHASE_COL0_BACK);
    });

    it('puts the FRONT view in column 0 at a PI phase', () => {
        // Camera on -Z at 15deg elevation = in front of a heading-0 instance.
        const front = selectAtlasCell(0, 26.79, -100, 0, atPhase(AZIMUTH_PHASE_COL0_FRONT));
        expect(front % 8).toBe(0);
        // ...and its back moves to the opposite column.
        const back = selectAtlasCell(0, 26.79, 100, 0, atPhase(AZIMUTH_PHASE_COL0_FRONT));
        expect(back % 8).toBe(4);
    });

    it('offsets every column by the phase without disturbing the pitch row', () => {
        for (const [x, z] of [[0, 100], [100, 100], [100, 0], [0, -100], [-100, -100]]) {
            const base = selectAtlasCell(x, 26.79, z, 0, atPhase(AZIMUTH_PHASE_COL0_BACK));
            const shifted = selectAtlasCell(x, 26.79, z, 0, atPhase(AZIMUTH_PHASE_COL0_FRONT));
            expect(shifted % 8).toBe((base % 8 + 4) % 8);
            expect(Math.floor(shifted / 8)).toBe(Math.floor(base / 8));
        }
    });

    it('reads the phase in DEGREES off the wire and wraps out-of-range values', () => {
        expect(normalizeAtlasLayout({ pitchBins: 3, azimuthPhaseDegrees: 180 }).azimuthPhase)
            .toBeCloseTo(Math.PI, 12);
        // -180 and 540 are the same column as 180.
        expect(normalizeAtlasLayout({ azimuthPhaseDegrees: -180 }).azimuthPhase)
            .toBeCloseTo(Math.PI, 12);
        expect(normalizeAtlasLayout({ azimuthPhaseDegrees: 540 }).azimuthPhase)
            .toBeCloseTo(Math.PI, 12);
        // Garbage falls back to the default rather than producing NaN columns.
        expect(normalizeAtlasLayout({ azimuthPhaseDegrees: Number.NaN }).azimuthPhase)
            .toBe(DEFAULT_AZIMUTH_PHASE);
    });

    it('accepts the older `pitches` spelling so a declared arc is never lost', () => {
        // The baker writes `pitchDegrees`; an older manifest says `pitches`.
        // Dropping it would silently select rows against the WRONG elevations.
        expect(normalizeAtlasLayout({ pitchBins: 3, pitches: [18, 42, 68] }).pitchDegrees)
            .toEqual([18, 42, 68]);
        expect(normalizeAtlasLayout({
            pitchBins: 3, pitchDegrees: [15, 45, 80], pitches: [18, 42, 68],
        }).pitchDegrees).toEqual([15, 45, 80]);
    });
});


// ── Baker <-> runtime cross-check ─────────────────────────────────────────
//
// The top correctness risk the plan names. Rather than re-stating the baker's
// numbers here (which is how the two conventions drifted apart in the first
// place), this EXECUTES `impostor_convention.py` — the baker's own definition —
// and asserts that for every cell of every shipped convention, feeding the
// runtime the exact metadata the baker emits plus the exact camera direction it
// rendered that cell from recovers precisely that cell.
//
// That round-trip is what makes a DECLARED phase sufficient and a re-bake
// unnecessary (user decision 2026-08-03, option (b)).
//
// `impostor_convention.py` imports only `math` + `dataclasses` specifically so
// this can run without the forge's numpy/pillow venv.
describe('cross-check against impostor_convention.py', () => {
    interface PyProfile {
        meta: Record<string, unknown>;
        /** Instance -> camera direction per cell, indexed [row][col]. */
        camDirs: [number, number, number][][];
        /** Baker's top-left cell pixel, indexed [row][col]. */
        origins: [number, number][][];
        /** Atlas image size in pixels, (width, height). */
        size: [number, number];
    }

    const forgeDir = fileURLToPath(new URL('../../../tools/fable-model-forge/', import.meta.url));
    const dumped: Record<string, PyProfile> = JSON.parse(execFileSync('python3', ['-c', `
import json, impostor_convention as ic
out = {}
for name in ('VEGETATION', 'INFANTRY_V2'):
    c = getattr(ic, name)
    out[name] = {
        'meta': c.metadata(),
        'camDirs': [[list(c.cam_dir(col, row)) for col in range(c.yaw_bins)]
                    for row in range(c.pitch_bins)],
        'origins': [[list(c.cell_origin(col, row)) for col in range(c.yaw_bins)]
                    for row in range(c.pitch_bins)],
        'size': list(c.atlas_size),
    }
print(json.dumps(out))
`], { cwd: forgeDir, encoding: 'utf8' }));

    it('exports the two profiles this runtime knows about', () => {
        expect(Object.keys(dumped).sort()).toEqual(['INFANTRY_V2', 'VEGETATION']);
    });

    it('agrees on the phase anchors, and that undeclared means back-anchored', () => {
        expect(dumped.VEGETATION.meta.azimuthPhaseDegrees).toBe(0);
        expect(dumped.VEGETATION.meta.column0).toBe('back');
        expect(dumped.INFANTRY_V2.meta.azimuthPhaseDegrees).toBe(180);
        expect(dumped.INFANTRY_V2.meta.column0).toBe('front');
        // VEGETATION declares no phase at all in Python — it takes the dataclass
        // default — so this also pins "default == back == today's behaviour".
        expect(DEFAULT_AZIMUTH_PHASE).toBe(AZIMUTH_PHASE_COL0_BACK);
        expect(normalizeAtlasLayout(dumped.VEGETATION.meta).azimuthPhase)
            .toBe(AZIMUTH_PHASE_COL0_BACK);
        expect(normalizeAtlasLayout(dumped.INFANTRY_V2.meta).azimuthPhase)
            .toBeCloseTo(AZIMUTH_PHASE_COL0_FRONT, 12);
    });

    it('keeps the legacy TS pitch fallback matching an arc that really ships', () => {
        // PITCH_BIN_DEGREES is only a fallback for an atlas that lost its arc,
        // but it must be one of the arcs that actually exist, not a third one.
        const arcs = Object.values(dumped).map((p) => (p.meta.pitchDegrees as number[]).join());
        expect(arcs).toContain([...PITCH_BIN_DEGREES].join());
    });

    for (const name of ['VEGETATION', 'INFANTRY_V2']) {
        it(`round-trips every cell of ${name} through the emitted metadata`, () => {
            const { meta, camDirs } = dumped[name];
            // The runtime consumes the sidecar verbatim — no hand-translation.
            const layout = normalizeAtlasLayout(meta);
            expect(layout.pitchDegrees).toEqual(meta.pitchDegrees);
            expect(atlasCellCount(layout)).toBe(camDirs.length * camDirs[0].length);

            for (let row = 0; row < camDirs.length; row++) {
                for (let col = 0; col < camDirs[row].length; col++) {
                    const [x, y, z] = camDirs[row][col];
                    const want = atlasCellIndex(col, row, 0, layout);
                    // At heading 0 the model frame IS the world frame.
                    expect(selectAtlasCell(x, y, z, 0, layout)).toBe(want);
                    // Turning the instance and its camera together must not
                    // change which cell is chosen.
                    for (const h of [Math.PI / 2, -1.1, 2.7]) {
                        const rx = x * Math.cos(h) + z * Math.sin(h);
                        const rz = -x * Math.sin(h) + z * Math.cos(h);
                        expect(selectAtlasCell(rx, y, rz, h, layout)).toBe(want);
                    }
                }
            }
        });
    }

    // ── V orientation ────────────────────────────────────────────────────
    //
    // The cell round-trip above proves the runtime asks for the right cell
    // INDEX. It says nothing about where that index lands in the image — and
    // "upside-down units" (2026-08-03) was exactly that second failure: a
    // bottom-up `ov` both mirrored every sprite and sampled pitch row
    // `pitchBins-1-row`. This is the missing half: the UV rect the runtime
    // hands the GPU, converted back to pixels, must be the very rectangle the
    // baker wrote the view into.
    //
    // It works because BOTH sides are image space with v growing downward from
    // the top row: the baker's `cell_origin`, and the card's own UVs
    // (createImpostorCard builds them top-down, which is also where a KTX2 —
    // every atlas we ship — puts its top image row).
    for (const name of ['VEGETATION', 'INFANTRY_V2']) {
        it(`lands every ${name} cell on the baker's own pixel rect`, () => {
            const { meta, origins, size } = dumped[name];
            const layout = normalizeAtlasLayout(meta);
            const [wpx, hpx] = size;

            for (let row = 0; row < origins.length; row++) {
                for (let col = 0; col < origins[row].length; col++) {
                    const uv = atlasCellUv(atlasCellIndex(col, row, 0, layout), layout);
                    const [ox, oy] = origins[row][col];
                    expect(uv.ou * wpx).toBeCloseTo(ox, 6);
                    // The one that was inverted. Row 0 is the TOP image row, so
                    // it must sit at pixel y = 0, not at the bottom of the sheet.
                    expect(uv.ov * hpx).toBeCloseTo(oy, 6);
                    expect(uv.su * wpx).toBeCloseTo(meta.cell as number, 6);
                    expect(uv.sv * hpx).toBeCloseTo(meta.cell as number, 6);
                }
            }
            // Pin the direction outright, so a future "fix" that flips V and
            // renumbers rows to compensate still fails here.
            expect(atlasCellUv(atlasCellIndex(0, 0, 0, layout), layout).ov).toBe(0);
        });
    }

    it('would catch a phase disagreement — the bug that actually shipped', () => {
        // Sanity-check the check: reading an INFANTRY_V2 atlas as if it were
        // back-anchored (what main's runtime did before the phase existed) must
        // select the cell 180deg away, not the right one.
        const layout = normalizeAtlasLayout(dumped.INFANTRY_V2.meta);
        const asIfDefault: AtlasLayout = { ...layout, azimuthPhase: AZIMUTH_PHASE_COL0_BACK };
        const [x, y, z] = dumped.INFANTRY_V2.camDirs[0][0];
        expect(selectAtlasCell(x, y, z, 0, layout) % layout.yawBins).toBe(0);
        expect(selectAtlasCell(x, y, z, 0, asIfDefault) % layout.yawBins)
            .toBe(layout.yawBins / 2);
    });
});
