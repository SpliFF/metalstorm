"""impostor_convention — the ONE shared definition of the directional impostor
atlas layout (PLAN-metalstorm-impostors.md §"Atlas format (v2)").

Convention drift between the baker and the runtime — what column 0 means,
clockwise vs CCW, elevation measured from the horizon vs the zenith — is the top
correctness risk the plan calls out, and it has already bitten once: two
independently-written, each-internally-consistent implementations disagreed by
180 degrees on column 0 while both rendered "correct" pixels for their own
baker (see the plan's ⚠ STATE CORRECTION 2026-08-03). So both sides derive from
this module: the baker (`bake_impostors.py`) imports it, and the runtime
(`client/src/core/impostor-atlas.ts`) mirrors it with a cross-check test that
reads the constants back out of this file.

── Why a Convention object rather than module constants ───────────────────

The layout is NOT one global set of numbers. Different atlases are legitimately
baked on different arcs, and two such sets already ship:

    VEGETATION  — 8 x 3 @ 128px, elevations 18/42/68, column 0 = BACK
    INFANTRY_V2 — 8 x 3 @ 256px, elevations 15/45/80, column 0 = FRONT

Forcing one global phase would mean re-baking one of them for nothing. Instead
each atlas DECLARES its own azimuth phase and elevation arc in the metadata
sidecar, and the runtime reads what it is told (user decision 2026-08-03,
option (b)). What is shared — and what this module fixes — is the *formulas*:
how a (column, row) pair maps to a camera direction, and how rows are stacked.

── Grid ──────────────────────────────────────────────────────────────────
  yaw_bins   columns — camera AZIMUTH around the instance.
  pitch_bins rows per animation frame — camera ELEVATION above the instance's
             horizon (0 = level with it, 90 = straight down).
  frames     animation row-groups; 1 = static. Flipbook frames extend
             DOWNWARD as further row groups so adding them never moves an
             existing pitch row:

                 row = frame * pitch_bins + pitch_row

  Cell (col, row) atlas origin (top-left, px) = (col * cell, row * cell).
  Atlas size = yaw_bins*cell  x  frames*pitch_bins*cell.

── Model frame (meshlib / SPRINGRTS_geometry) ─────────────────────────────
  forward = -Z, up = +Y.

── Azimuth phase: what column 0 shows ─────────────────────────────────────
  Columns are indexed by the RELATIVE YAW between the camera and the
  instance's facing — the runtime's `atan2(toCamX, toCamZ) - heading`. The
  crucial, easy-to-get-backwards fact (verified against Babylon's actual
  placement transform, and pinned by a unit test on the runtime side):

      relative yaw 0   =>  camera is directly BEHIND the instance, seeing its
                           BACK. Placing a -Z-forward model at heading h sends
                           its forward to world (-sin h, ., -cos h), so the
                           camera direction at relative yaw 0 is exactly
                           -forward.
      relative yaw 180 =>  camera is directly IN FRONT, seeing its FRONT.

  `azimuth_phase_deg` is the relative yaw that column 0 was baked at, so:

      azimuth_phase_deg = 0    =>  column 0 = BACK view   (VEGETATION)
      azimuth_phase_deg = 180  =>  column 0 = FRONT view  (INFANTRY_V2)

  and column c sits at relative yaw `azimuth_phase_deg + c*360/yaw_bins`.
  Phase 0 is the DEFAULT so an atlas that declares nothing keeps rendering
  exactly as it does today.
"""
from __future__ import annotations

import math
from dataclasses import dataclass, field

#: Relative yaw (degrees) at which column 0 shows the instance's BACK.
#: This is the default — an atlas declaring no phase is read this way.
PHASE_COL0_BACK = 0.0
#: Relative yaw (degrees) at which column 0 shows the instance's FRONT.
PHASE_COL0_FRONT = 180.0


@dataclass(frozen=True)
class Convention:
    """One atlas's baked layout. Emitted into the metadata sidecar verbatim so
    the runtime never has to re-derive or guess any of it."""

    name: str
    yaw_bins: int = 8
    pitch_bins: int = 3
    frames: int = 1
    cell: int = 128
    #: Camera elevation (degrees ABOVE the instance's horizon) per pitch row,
    #: top row first. Must have `pitch_bins` entries.
    pitch_degrees: tuple[float, ...] = (18.0, 42.0, 68.0)
    #: Relative yaw (degrees) that column 0 was baked at. See module docstring.
    azimuth_phase_deg: float = PHASE_COL0_BACK

    def __post_init__(self) -> None:
        if len(self.pitch_degrees) != self.pitch_bins:
            raise ValueError(
                f'{self.name}: {len(self.pitch_degrees)} pitch_degrees for '
                f'{self.pitch_bins} pitch_bins — they must match')
        for n, v in (('yaw_bins', self.yaw_bins), ('pitch_bins', self.pitch_bins),
                     ('frames', self.frames), ('cell', self.cell)):
            if v < 1:
                raise ValueError(f'{self.name}: {n} must be >= 1, got {v}')

    @property
    def rows(self) -> int:
        """Rows in the atlas image (all frame groups stacked)."""
        return self.pitch_bins * self.frames

    @property
    def atlas_size(self) -> tuple[int, int]:
        return self.yaw_bins * self.cell, self.rows * self.cell

    def cell_origin(self, col: int, pitch: int, frame: int = 0) -> tuple[int, int]:
        """Top-left atlas pixel of the (col, pitch, frame) view cell."""
        return col * self.cell, (frame * self.pitch_bins + pitch) * self.cell

    def column_azimuth_deg(self, col: int) -> float:
        """Relative yaw (degrees) that column `col` is baked at."""
        return self.azimuth_phase_deg + col * 360.0 / self.yaw_bins

    def cam_dir(self, col: int, pitch: int) -> tuple[float, float, float]:
        """Unit-length instance -> camera direction in the MODEL frame for one
        cell: horizontal azimuth from the column (via the phase), elevation
        from the pitch row.

        Derived from the runtime's own column formula, which is what makes a
        declared phase sufficient and a re-bake unnecessary: the runtime picks
        the column from `relYaw - phase`, and relative yaw t corresponds to a
        camera direction of (sin t, ., cos t) — relYaw 0 giving +Z, i.e. the
        back of a -Z-forward model.
        """
        theta = math.radians(self.column_azimuth_deg(col))
        elev = math.radians(self.pitch_degrees[pitch])
        ce = math.cos(elev)
        return (math.sin(theta) * ce, math.sin(elev), math.cos(theta) * ce)

    def metadata(self) -> dict:
        """Layout fields for the `<stem>_impostor.json` sidecar. Field names
        match `AtlasLayout` in client/src/core/impostor-atlas.ts so the runtime
        consumes the manifest verbatim (`normalizeAtlasLayout`).

        Note the explicit `Degrees` suffixes: the sidecar carries DEGREES while
        the runtime works in RADIANS internally, so the unit is named on the
        wire rather than left to a convention that could silently invert."""
        return {
            'yawBins': self.yaw_bins,
            'pitchBins': self.pitch_bins,
            'frames': self.frames,
            'pitchDegrees': list(self.pitch_degrees),
            'azimuthPhaseDegrees': self.azimuth_phase_deg,
            'cell': self.cell,
            # Descriptive only — the runtime derives these from the fields
            # above; they are here so a human reading a sidecar can tell what
            # the sheet actually is without opening this file.
            'rowOrder': 'frame*pitchBins + pitchRow',
            'forwardAxis': '-Z',
            'column0': 'back' if self.azimuth_phase_deg % 360.0 == 0.0 else (
                'front' if self.azimuth_phase_deg % 360.0 == 180.0 else
                f'relative yaw {self.azimuth_phase_deg}deg'),
        }


#: main's `bake_impostors.py` arc — the DEFAULT. Used by the eleven map
#: vegetation atlases (`metalstorm-map` de7e164db5). Column 0 = back; trees are
#: near-radially symmetric so the phase is immaterial to them in practice.
VEGETATION = Convention(name='vegetation')

#: The four infantry sheets baked by this lane's M2 (tag
#: `impostors-M1-M5-unlanded`): a wider elevation arc and a FRONT-anchored
#: column 0. Declared rather than re-baked — that is the whole point of the
#: 2026-08-03 option-(b) decision.
INFANTRY_V2 = Convention(
    name='infantry_v2', cell=256,
    pitch_degrees=(15.0, 45.0, 80.0),
    azimuth_phase_deg=PHASE_COL0_FRONT,
)

CONVENTIONS: dict[str, Convention] = {c.name: c for c in (VEGETATION, INFANTRY_V2)}

#: What an atlas declaring no metadata at all is read as (legacy single view).
SINGLE_CELL = Convention(name='single_cell', yaw_bins=1, pitch_bins=1,
                         pitch_degrees=(45.0,))
