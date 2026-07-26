"""impostor_convention — the ONE shared definition of the v2 directional
impostor atlas layout (PLAN-metalstorm-impostors.md §"Atlas format (v2)").

Convention drift between the baker and the runtime (column-0 meaning,
clockwise vs CCW, pitch-from-horizon vs zenith) is the top correctness risk
the plan calls out, so both sides MUST derive from this single source. The
baker (`bake_impostors.py`) imports these constants directly; the runtime
(M3, `client/src/core/impostor-atlas.ts`) mirrors them and a cross-check
test asserts the two agree. If you change a number here, change it there.

── Grid ──────────────────────────────────────────────────────────────────
  YAW_BINS   = 8 columns   (camera azimuth around the unit)
  PITCH_BINS = 3 rows      (camera elevation above the unit's horizon)
  FRAMES     = 1           (walk/idle flipbook rows are fx-offload X2 —
                            reserved as *extra* row-groups, never a break)
  CELL       = 256 px      per view
  Atlas size = YAW_BINS*CELL  ×  FRAMES*PITCH_BINS*CELL   (2048 × 768 today)

  Cell (col, row) atlas origin (top-left, px), row = frame*PITCH_BINS+pitch:
      x0 = col * CELL
      y0 = (frame * PITCH_BINS + pitch) * CELL
  So the shader indexes rows as `frame*pitchBins + pitch` and X2 flipbook
  frames extend downward without moving the existing pitch rows.

── Model frame (meshlib / SPRINGRTS_geometry) ─────────────────────────────
  forward = −Z, up = +Y, unit "left" = +X  (so unit "right" = −X).

── Columns (yaw) ──────────────────────────────────────────────────────────
  Column c shows the model as seen by a camera placed at horizontal azimuth
  θ = c * 360/YAW_BINS, measured so the camera *position direction*
  (unit → camera, horizontal part) is:

      camAzimuthDir(θ) = ( −sin θ, 0, −cos θ )

      c0  θ=0    → (0,0,−1)  camera on −Z  → sees the model FRONT   (−Z face)
      c2  θ=90   → (−1,0,0)  camera on −X  → sees the model RIGHT   (−X face)
      c4  θ=180  → (0,0,+1)  camera on +Z  → sees the model BACK    (+Z face)
      c6  θ=270  → (+1,0,0)  camera on +X  → sees the model LEFT    (+X face)

  This matches the plan's anchors (col0 = dead-front, col2 = unit's right,
  col4 = back). The runtime picks the column from the *relative* yaw between
  the camera and the unit's facing (quantize8(viewYaw − heading)); the
  world↔model transform (incl. any Babylon +Z/−Z heading flip) is the
  runtime's job and is tested there — this module fixes only the model-frame
  meaning of each column, which the baker renders.

── Rows (pitch) ───────────────────────────────────────────────────────────
  Row r = camera elevation PITCH_DEGREES[r] degrees ABOVE the unit's horizon
  (0° = level with the unit, 90° = straight down). Top row = shallow, bottom
  row = steep, so a steep RTS camera reads the lower rows.
"""
from __future__ import annotations
import math

YAW_BINS = 8
PITCH_BINS = 3
FRAMES = 1
CELL = 256

# Camera elevation (degrees above the unit's horizon) for each pitch row.
PITCH_DEGREES = [15.0, 45.0, 80.0]
assert len(PITCH_DEGREES) == PITCH_BINS

ATLAS_W = YAW_BINS * CELL
ATLAS_H = FRAMES * PITCH_BINS * CELL


def cell_origin(col: int, pitch: int, frame: int = 0) -> tuple[int, int]:
    """Top-left atlas pixel of the (col, pitch, frame) view cell."""
    return col * CELL, (frame * PITCH_BINS + pitch) * CELL


def cam_dir(col: int, pitch: int) -> tuple[float, float, float]:
    """Unit → camera direction (unit length) in the MODEL frame for a cell:
    horizontal azimuth from the column, elevation from the pitch row."""
    theta = math.radians(col * 360.0 / YAW_BINS)
    elev = math.radians(PITCH_DEGREES[pitch])
    ce = math.cos(elev)
    return (-math.sin(theta) * ce, math.sin(elev), -math.cos(theta) * ce)


def metadata() -> dict:
    """Atlas metadata written beside each baked atlas (out/<stem>_impostor.json)
    and — in M3 — carried onto the def JSON via LuaDefsSerializer.inl. Defaults
    (yaw=pitch=frames=1) let old single-frame atlases and non-metalstorm games
    keep working, so this only appears for the baked v2 sets."""
    return {
        "yaw_bins": YAW_BINS,
        "pitch_bins": PITCH_BINS,
        "frames": FRAMES,
        "cell_px": CELL,
        "pitch_degrees": PITCH_DEGREES,
        "row_order": "frame*pitch_bins + pitch",
        "forward_axis": "-Z",
        "cam_azimuth_dir": "(-sin(theta), 0, -cos(theta)), theta = col*360/yaw_bins",
        "column_anchors": {"0": "front (-Z)", "2": "right (-X)",
                           "4": "back (+Z)", "6": "left (+X)"},
    }
