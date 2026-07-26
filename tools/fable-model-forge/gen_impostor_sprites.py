"""gen_impostor_sprites — authored impostor sprite atlases for the
impostor-only infantry/civilian defs (PLAN-metalstorm-beta-units.md §2.1
task 4b: these units ship with NO 3D model — the sprite IS the asset).

Outputs, per unit (single frame for now — walk/idle flipbook rows are
fx-offload X2 territory, the server emits walk_frames=idle_frames=1):

  out/<stem>_impostor.png        256² RGBA — diffuse, alpha = cutout
  out/<stem>_impostor_team.png   256² greyscale — R = team-colour blend

Stems match LuaDefsSerializer.inl's convention (`<def name>_impostor.ktx2`
under the game's models/ dir): ms_soldiers_s1, ms_engineers_s1,
ms_civilians, ms_militia.

Style: fable_* family palette (paint.py's blue-grey armour + safety
yellow), flat 3-tone facet shading + dark outline — flat-shaded reads
better at billboard distances than detail texturing (beta-units §2).
Drawn 4× supersampled, LANCZOS-downscaled; the client alpha-tests at
~0.4 so the soft edge stays crisp.

Usage: python3 gen_impostor_sprites.py   (then encode_sprites.mjs)
"""
from __future__ import annotations
from PIL import Image, ImageDraw, ImageFilter

SS = 4              # supersample factor
SIZE = 256          # shipped sprite size
W = H = SIZE * SS   # working canvas

# ── fable palette (paint.py) ─────────────────────────────────────────────
ARMOR    = (97, 106, 115)
ARMOR_LT = (116, 126, 136)
ARMOR_DK = (72, 79, 87)
LOWER    = (63, 68, 75)
STEEL    = (74, 78, 84)
STEEL_DK = (44, 47, 52)
RUBBER   = (36, 38, 42)
GLASS    = (28, 44, 54)
GLASS_LT = (58, 96, 112)
YELLOW   = (198, 158, 44)
YELLOW_DK = (156, 122, 30)
OUTLINE  = (22, 24, 27)
SKIN     = (196, 158, 128)
SKIN_DK  = (162, 126, 98)
# civilian wardrobe (muted, deliberately off the military ramp)
CIV_COAT   = (146, 124, 96)
CIV_COAT_DK = (116, 96, 72)
CIV_SHIRT  = (170, 168, 158)
CIV_PANTS  = (76, 82, 94)
CIV_HAIR   = (58, 46, 38)

TEAM_ON = 255


def s(*pts):
    """Scale a flat (x, y, x, y, ...) list from 256-space to SS canvas."""
    return [p * SS for p in pts]


def poly(d: ImageDraw.ImageDraw, pts, fill, outline=OUTLINE, ow=2):
    d.polygon(s(*pts), fill=fill, outline=outline, width=ow * SS)


def facet(d: ImageDraw.ImageDraw, pts, fill):
    """Shading facet — no outline, drawn over a base polygon."""
    d.polygon(s(*pts), fill=fill)


class Sprite:
    """One sprite: a diffuse RGBA canvas + a parallel team-mask canvas.
    Mask polys are drawn explicitly (mask=...) so team colour lands only
    on the authored panels, per the engine's R8-mask convention."""

    def __init__(self):
        self.img = Image.new('RGBA', (W, H), (0, 0, 0, 0))
        self.msk = Image.new('L', (W, H), 0)
        self.d = ImageDraw.Draw(self.img)
        self.dm = ImageDraw.Draw(self.msk)

    def poly(self, pts, fill, outline=OUTLINE, ow=2, mask=False):
        poly(self.d, pts, fill, outline, ow)
        if mask:
            self.dm.polygon(s(*pts), fill=TEAM_ON)

    def facet(self, pts, fill, mask=False):
        facet(self.d, pts, fill)
        if mask:
            self.dm.polygon(s(*pts), fill=TEAM_ON)

    def ellipse(self, box, fill, outline=OUTLINE, ow=2, mask=False):
        b = s(*box)
        self.d.ellipse(b, fill=fill, outline=outline, width=ow * SS)
        if mask:
            self.dm.ellipse(b, fill=TEAM_ON)

    def save(self, stem: str, team_mask: bool):
        img = self.img.resize((SIZE, SIZE), Image.LANCZOS)
        img.save(f'out/{stem}_impostor.png')
        if team_mask:
            # Mask must vanish wherever the sprite is transparent.
            msk = self.msk.resize((SIZE, SIZE), Image.LANCZOS)
            alpha = img.split()[3].point(lambda a: 255 if a > 96 else 0)
            msk = Image.composite(msk, Image.new('L', (SIZE, SIZE), 0), alpha)
            Image.merge('RGB', (msk, msk, msk)).save(f'out/{stem}_impostor_team.png')
        print(f'[sprites] {stem}_impostor.png' + (' (+team)' if team_mask else ''))


# ── shared humanoid pieces (256-space coordinates, feet at y≈252) ───────


def legs(sp: Sprite, pants=LOWER, pants_dk=None, boot=RUBBER):
    pants_dk = pants_dk or tuple(max(0, c - 14) for c in pants)
    # left leg (viewer left), slightly forward
    sp.poly((104, 158, 124, 158, 122, 216, 104, 216), pants)
    sp.facet((114, 158, 124, 158, 122, 216, 114, 216), pants_dk)
    # right leg
    sp.poly((132, 158, 152, 158, 152, 216, 134, 216), pants)
    sp.facet((143, 158, 152, 158, 152, 216, 143, 216), pants_dk)
    # boots
    sp.poly((100, 216, 124, 216, 126, 244, 96, 244), boot)
    sp.poly((132, 216, 154, 216, 158, 244, 130, 244), boot)


def torso(sp: Sprite, base, dk, lt, hip=None):
    hip = hip or dk
    # hip band
    sp.poly((102, 146, 154, 146, 152, 162, 104, 162), hip)
    # chest trapezoid, shoulders wider than hips
    sp.poly((94, 88, 162, 88, 154, 150, 102, 150), base)
    sp.facet((94, 88, 112, 88, 106, 150, 102, 150), lt)      # lit left facet
    sp.facet((144, 88, 162, 88, 154, 150, 140, 150), dk)     # shaded right


def arms(sp: Sprite, sleeve, sleeve_dk, hand=SKIN):
    # left arm hangs slightly out
    sp.poly((84, 92, 100, 90, 96, 148, 84, 148), sleeve)
    sp.facet((84, 122, 96, 122, 96, 148, 84, 148), sleeve_dk)
    sp.poly((84, 148, 96, 148, 95, 162, 85, 162), hand, ow=1)
    # right arm
    sp.poly((156, 92, 172, 94, 172, 148, 160, 148), sleeve)
    sp.facet((160, 122, 172, 122, 172, 148, 160, 148), sleeve_dk)
    sp.poly((160, 148, 172, 148, 171, 162, 161, 162), hand, ow=1)


def head(sp: Sprite, y=58):
    sp.ellipse((114, y - 18, 142, y + 12), SKIN, ow=1)
    sp.facet((132, y - 12, 140, y - 4, 140, y + 6, 132, y + 8), SKIN_DK)


# ── soldiers — armoured rifle trooper ───────────────────────────────────


def paint_soldier() -> Sprite:
    sp = Sprite()
    legs(sp, pants=LOWER)
    # knee plates
    sp.poly((104, 186, 124, 186, 122, 200, 106, 200), ARMOR_DK, ow=1)
    sp.poly((133, 186, 152, 186, 152, 200, 135, 200), ARMOR_DK, ow=1)
    torso(sp, ARMOR, ARMOR_DK, ARMOR_LT, hip=STEEL_DK)
    arms(sp, ARMOR, ARMOR_DK, hand=STEEL_DK)  # gloved
    # chest plate (team panel) + abdomen vents
    sp.poly((108, 96, 148, 96, 144, 128, 112, 128), ARMOR_LT, mask=True)
    sp.facet((112, 100, 144, 100, 143, 106, 113, 106), ARMOR)
    sp.poly((114, 132, 142, 132, 141, 142, 115, 142), STEEL, ow=1)
    # shoulder pauldrons (team panels)
    sp.poly((80, 84, 104, 82, 104, 100, 82, 102), ARMOR_LT, mask=True)
    sp.poly((152, 82, 176, 84, 174, 102, 152, 100), ARMOR_LT, mask=True)
    # helmet: angular dome + visor slit
    sp.poly((110, 30, 146, 30, 152, 52, 148, 64, 108, 64, 104, 52), ARMOR)
    sp.facet((110, 30, 126, 30, 122, 64, 108, 64, 104, 52), ARMOR_LT)
    sp.poly((112, 48, 144, 48, 142, 58, 114, 58), GLASS, ow=1)
    sp.facet((114, 49, 130, 49, 128, 53, 114, 53), GLASS_LT)
    # helmet crest stripe (team)
    sp.poly((124, 30, 132, 30, 132, 44, 124, 44), ARMOR_LT, ow=1, mask=True)
    # neck seal
    sp.poly((120, 64, 136, 64, 136, 90, 120, 90), STEEL_DK, ow=1)
    # rifle held across the chest, muzzle up-left
    sp.poly((88, 76, 98, 70, 168, 140, 158, 148), STEEL_DK)
    sp.poly((84, 60, 94, 56, 100, 74, 90, 78), STEEL)          # muzzle/barrel tip
    sp.poly((126, 118, 142, 112, 150, 138, 136, 144), STEEL)   # receiver
    sp.poly((132, 140, 144, 136, 142, 158, 132, 158), STEEL_DK, ow=1)  # magazine
    return sp


# ── engineers — hi-vis field engineer ───────────────────────────────────


def paint_engineer() -> Sprite:
    sp = Sprite()
    legs(sp, pants=LOWER)
    torso(sp, ARMOR, ARMOR_DK, ARMOR_LT, hip=STEEL_DK)
    # back tank peeking over the right shoulder
    sp.poly((150, 66, 170, 66, 170, 92, 150, 92), STEEL, ow=1)
    arms(sp, ARMOR, ARMOR_DK, hand=STEEL_DK)
    # hi-vis vest: two yellow front panels + belt
    sp.poly((104, 92, 126, 92, 122, 140, 106, 140), YELLOW)
    sp.poly((130, 92, 152, 92, 150, 140, 134, 140), YELLOW)
    sp.facet((104, 92, 126, 92, 125, 104, 105, 104), YELLOW_DK)
    sp.facet((130, 92, 152, 92, 151, 104, 131, 104), YELLOW_DK)
    sp.poly((102, 142, 154, 142, 152, 154, 104, 154), RUBBER, ow=1)  # tool belt
    sp.poly((110, 144, 122, 144, 122, 156, 110, 156), STEEL, ow=1)   # pouch
    sp.poly((134, 144, 146, 144, 146, 156, 134, 156), STEEL, ow=1)   # pouch
    # chest stripe between the panels (team)
    sp.poly((124, 96, 132, 96, 132, 140, 124, 140), ARMOR_LT, ow=1, mask=True)
    # shoulder caps (team)
    sp.poly((80, 82, 104, 80, 104, 100, 82, 102), ARMOR_LT, ow=1, mask=True)
    sp.poly((152, 80, 176, 82, 174, 102, 152, 100), ARMOR_LT, ow=1, mask=True)
    # head + hard hat with brim
    head(sp, y=60)
    sp.poly((106, 40, 150, 40, 150, 50, 106, 50), YELLOW)            # brim
    sp.poly((112, 22, 144, 22, 148, 42, 108, 42), YELLOW)            # dome
    sp.facet((112, 22, 126, 22, 122, 42, 108, 42), tuple(min(255, c + 24) for c in YELLOW))
    # goggles resting on the brim
    sp.poly((114, 50, 142, 50, 141, 57, 115, 57), GLASS, ow=1)
    # heavy wrench in the right hand
    sp.poly((166, 118, 176, 118, 176, 170, 166, 170), STEEL)
    sp.poly((160, 108, 182, 108, 182, 122, 160, 122), STEEL_DK)
    return sp


# ── civilians — unarmed pedestrian ──────────────────────────────────────


def paint_civilian() -> Sprite:
    sp = Sprite()
    legs(sp, pants=CIV_PANTS, boot=STEEL_DK)
    # coat body (longer than the military torso, softer taper)
    sp.poly((100, 92, 156, 92, 152, 168, 104, 168), CIV_COAT)
    sp.facet((100, 92, 116, 92, 110, 168, 104, 168), tuple(min(255, c + 18) for c in CIV_COAT))
    sp.facet((142, 92, 156, 92, 152, 168, 146, 168), CIV_COAT_DK)
    # open collar showing the shirt
    sp.poly((120, 92, 136, 92, 134, 120, 122, 120), CIV_SHIRT, ow=1)
    # sleeves + bare hands
    sp.poly((88, 94, 102, 92, 98, 150, 88, 150), CIV_COAT)
    sp.facet((88, 128, 98, 128, 98, 150, 88, 150), CIV_COAT_DK)
    sp.poly((88, 150, 98, 150, 97, 164, 89, 164), SKIN, ow=1)
    sp.poly((154, 92, 168, 94, 168, 150, 158, 150), CIV_COAT)
    sp.facet((158, 128, 168, 128, 168, 150, 158, 150), CIV_COAT_DK)
    sp.poly((158, 150, 168, 150, 167, 164, 159, 164), SKIN, ow=1)
    # head with hair
    head(sp, y=62)
    sp.poly((112, 38, 144, 38, 146, 54, 138, 50, 118, 50, 110, 54), CIV_HAIR, ow=1)
    return sp


# ── militia — armed civilian volunteer ──────────────────────────────────


def paint_militia() -> Sprite:
    sp = paint_civilian()
    # chest rig strap
    sp.poly((104, 96, 116, 96, 148, 160, 136, 160), RUBBER, ow=1)
    # team armband on the left sleeve
    sp.poly((88, 112, 100, 110, 100, 124, 88, 126), ARMOR_LT, ow=1, mask=True)
    # slung rifle, stock down-right
    sp.poly((94, 78, 104, 72, 166, 146, 156, 152), STEEL_DK)
    sp.poly((90, 64, 100, 60, 105, 74, 96, 79), STEEL)
    sp.poly((128, 122, 142, 116, 148, 138, 136, 143), STEEL)
    # knit cap with a team band
    sp.poly((110, 36, 146, 36, 148, 52, 108, 52), CIV_HAIR)
    sp.poly((108, 48, 148, 48, 148, 56, 108, 56), ARMOR_LT, ow=1, mask=True)
    return sp


SPRITES = {
    'ms_soldiers_s1':  (paint_soldier,  True),
    'ms_engineers_s1': (paint_engineer, True),
    'ms_civilians':    (paint_civilian, False),   # neutral — no team panels
    'ms_militia':      (paint_militia,  True),
}

if __name__ == '__main__':
    import os
    os.makedirs('out', exist_ok=True)
    for stem, (painter, team) in SPRITES.items():
        painter().save(stem, team)
