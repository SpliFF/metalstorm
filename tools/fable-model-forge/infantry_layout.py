"""infantry_layout — shared flat-swatch atlas + dims for the four low-poly
metalstorm infantry models (soldier, engineer, civilian, militia).

M1 of PLAN-metalstorm-impostors.md: real close-range 3D bodies for the squad
fan-out (past impostorDistance the baked impostor sprite — M2, baked FROM
these models — takes over). ONE shared 512² *flat-swatch* atlas feeds all
four: a low-poly humanoid needs only solid per-region colours, and the
flat-shaded engine lighting supplies the facet shading that the 2D impostor
had to paint by hand (that is the whole reason a 3D body reads better up
close). Team colour rides the R8 mask on the military torso + helmet
swatches; civilians carry no mask (gaia).

Convention (meshlib): forward -Z, up +Y, left +X, feet at Y=0, 1 u = 1 m.
Height ≈ 1.8 m (art/STYLE.md class-scale: soldiers/engineers s1 = 1.8 m,
civilian person = 1.8 m). Tri budget ≤ 800 (STYLE.md §2 / plan §"3D infantry").

Family-atlas + single-generator idiom follows the shipped civilian kit
(`civkit_layout.py` / `gen_civkit.py`), NOT the one-file-per-unit mech
pattern — infantry are a tight family sharing one body plan, so an atlas
partition is the sanctioned choice (DESIGN-MODEL-BUILDING.md §11/§27). See
the lane note for why this and the .gltf/.bin (not .glb/.meta.lua) export
match the engine contract.
"""
import meshlib
meshlib.ATLAS = 512
from meshlib import Zone

ATLAS = 512
CELL = 56          # painted solid swatch, padded inside a 64-px grid cell
GRID = 64          # 8×8 grid of swatches on the 512² atlas

# ── palette (sRGB) — fable family (paint.py) + impostor-sprite wardrobe ───
ARMOR     = (97, 106, 115)
ARMOR_DK  = (72, 79, 87)
LEG       = (63, 68, 75)
STEEL     = (74, 78, 84)
STEEL_DK  = (44, 47, 52)
RUBBER    = (36, 38, 42)
GLASS     = (28, 44, 54)
YELLOW    = (198, 158, 44)
SKIN      = (196, 158, 128)
GLOVE     = (48, 51, 56)
TEAMGREY  = (168, 172, 176)   # diffuse beneath a full team mask
CIV_COAT  = (146, 124, 96)
CIV_SHIRT = (170, 168, 158)
CIV_PANTS = (76, 82, 94)
CIV_HAIR  = (58, 46, 38)
CIV_BOOT  = (44, 47, 52)

# ── swatch registry: paint_infantry.py fills each cell from this list ─────
SWATCHES = []      # dicts: rect, dif, ao, rough, metal, team, emis
_next = [0]


def _cell(idx):
    col, row = idx % 8, idx // 8
    x0 = col * GRID + (GRID - CELL) // 2
    y0 = row * GRID + (GRID - CELL) // 2
    return (x0, y0, x0 + CELL, y0 + CELL)


def SW(dif, ao=232, rough=170, metal=28, team=False, emis=None):
    """Allocate a flat swatch cell; return a Zone that maps any face into
    it. The cell is solid so the world-window/axes are irrelevant."""
    idx = _next[0]
    _next[0] += 1
    if idx >= 64:
        raise RuntimeError('infantry atlas full (>64 swatches)')
    rect = _cell(idx)
    SWATCHES.append(dict(rect=rect, dif=dif, ao=ao, rough=rough,
                         metal=metal, team=team, emis=emis))
    return Zone(rect, ('x', 'y'), ((-1.0, 1.0), (1.0, -1.0)))


# shared / mechanical
Z_SKIN    = SW(SKIN,     rough=190, metal=0)
Z_GLOVE   = SW(GLOVE,    rough=150, metal=60)
Z_STEEL   = SW(STEEL,    rough=128, metal=195)
Z_STEELD  = SW(STEEL_DK, rough=140, metal=170)
Z_RUBBER  = SW(RUBBER,   rough=205, metal=10)
Z_GLASS   = SW(GLASS,    rough=60,  metal=0,  emis=(38, 68, 88))
Z_YELLOW  = SW(YELLOW,   rough=150, metal=30)
# military
Z_ARMOR   = SW(ARMOR,    rough=168, metal=28)
Z_ARMORD  = SW(ARMOR_DK, rough=168, metal=28)
Z_LEG     = SW(LEG,      rough=175, metal=24)
Z_TORSO_T = SW(TEAMGREY, rough=160, metal=40, team=True)   # team torso plate
Z_HELM_T  = SW(TEAMGREY, rough=150, metal=60, team=True)   # team helmet
Z_BAND_T  = SW(TEAMGREY, rough=170, metal=30, team=True)   # team band/armband
# civilian wardrobe
Z_COAT    = SW(CIV_COAT,  rough=200, metal=8)
Z_SHIRT   = SW(CIV_SHIRT, rough=200, metal=6)
Z_PANTS   = SW(CIV_PANTS, rough=190, metal=10)
Z_HAIR    = SW(CIV_HAIR,  rough=210, metal=6)
Z_CIVBOOT = SW(CIV_BOOT,  rough=200, metal=20)

# ── shared humanoid joints (world metres, feet at Y=0) ───────────────────
HIP_X   = 0.11          # half-stance width at the hips
HIP_Y   = 0.92
KNEE    = (0.115, 0.50, 0.02)   # (x, y, z) for the LEFT leg; +z-forward lean
ANKLE   = (0.12, 0.13, 0.05)
FOOT_C  = (0.12, 0.06, -0.05)   # foot box centre (toe points -Z forward)
FOOT_SZ = (0.15, 0.12, 0.32)

PELVIS_C  = (0.0, 0.98, 0.0)
PELVIS_SZ = (0.30, 0.20, 0.20)

# torso octagon rings (waist → chest → shoulders), (y, half_x, half_z)
TORSO_RINGS = [(1.05, 0.15, 0.11), (1.28, 0.19, 0.13), (1.46, 0.23, 0.12)]

NECK_C  = (0.0, 1.54, 0.0)
NECK_SZ = (0.10, 0.09, 0.10)
HEAD_C  = (0.0, 1.65, 0.005)
HEAD_SZ = (0.17, 0.20, 0.185)

SHOULDER = 0.205        # |x| of the shoulder joint
SHO_Y    = 1.44

# arm joints for the two pose modes (LEFT arm; right = mirror X)
ARM_SIDES = {'elbow': (0.225, 1.16, 0.02), 'hand': (0.215, 0.98, 0.06)}
ARM_GRIP  = {'elbow': (0.20, 1.20, 0.04),  'hand': (0.10, 1.19, -0.18)}
ARM_R0, ARM_R1 = 0.062, 0.05
LEG_R0, LEG_R1, LEG_R2 = 0.095, 0.075, 0.06   # hip, knee, ankle radii
