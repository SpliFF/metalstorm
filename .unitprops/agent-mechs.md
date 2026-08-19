# agent-mechs — units/mechs.lua, fable_mech.lua, fable_colossus.lua

## Calibration used

Per-member HP ≈ maxdamage / squad_size, compared against BAR bots at this
game's observed ~0.25× HP scale (tank s2 = 700/member vs BAR MBT 2500–3000;
tank s4 aggregate 11200). Anchors pulled from the BAR checkout:
Pawn 370 hp / 87 e/s / turn 1214; Warrior 1590 / 45 / 886; Thug 1100 / 45 /
1264; Zeus 2950 / 47 / 1214; Bantha 69k / 45.6 / 1214; Korgoth 149k / 37 / 437.

## Changes made

### units/mechs.lua
- **baseTurn 900 → 1200** (class-wide). Walkers turn on the spot; BAR bots
  run 885–1264 vs ~350–600 for tracked hulls. Curve now yields
  1200/849/600 per scale — every scale out-turns its tank peer.
- **category `LAND MOBILE` → `LAND MOBILE MECH`** — sibling classes carry a
  type token (TANK/ARTILLERY/VEHICLE/CIVILIAN); MECH was missing.
- **s1**: maxvelocity 2.0 → **2.8** (84 e/s ≈ Pawn — a "recon walker pack"
  at 60 e/s was slower than the s1 tankette), sightdistance → **550**
  (recon sees further than it shoots). Per-member HP stays 112 (≈ 0.25×Pawn).
- **s2**: numbers left on the curve (450/member, 51 e/s — Warrior-ish). Only
  transport keys added.
- **s3**: left on the curve (1800/member ×2, 42 e/s); transport keys added.
- **s4**: builder curve gave 7200 hp / 2400 mass / turn 318 for the SAME 15 m
  fable_colossus model the showcase def fields at 14000/3200 — and below tank
  s4's 11200 aggregate. Overrode: **maxdamage 14000, mass 3200,
  maxvelocity 1.3 (39 e/s), accel/brake 0.15, turnrate 420, sight 700**.
  Flagship-tier vs BAR Korgoth scaled to this game.
- **Transportability** (airship & landing ship both have transportsize 3,
  transportmass 1200/2400, capacity 4): s1 transportsize 1, s2 = 2,
  s3 = 3 (mass 1200 — exactly the airship cap, deliberately the heaviest
  liftable scale), s4 `cantbetransported = 1`. All mobile scales get
  `transportbyenemy = false`.
- Weapons audited, all referenced defs exist (MS_MG_S2, MS_AC_S2, MS_AC_S3,
  MS_MISSILE_AA_S2, MS_RAILGUN_S3, MS_FLAK_S2): loadouts unchanged — s1
  MG-only recon, s2 single autocannon line, s3 heavy AC + self-cover AA rack,
  s4 railgun + AC + flak screen is a sane flagship mix.

### units/fable_mech.lua (showcase single)
- category → `LAND MOBILE MECH`; turnrate 1000 → **1200** (walker);
  sightdistance 460 → **550** (it is a *recon* walker);
  added **transportsize 2, transportbyenemy = false**.
- HP 800 / speed 2.6 (78 e/s) left as-is: Pawn-class recon at game scale.

### units/fable_colossus.lua (showcase single)
- category → `LAND MOBILE MECH`; maxvelocity 1.9 → **1.5** (57 e/s let a
  15 m titan outrun the line mechs; Korgoth is 37, Bantha 45.6);
  turnrate 380 → **420**; sightdistance 560 → **700**;
  added **cantbetransported = 1** (3200 mass exceeds every carrier cap anyway).

All three files pass `luac -p` and `loadfile`.

## PROPOSALS (shared files — not edited)

### 1. New move class MECH (gamedata/moveinfo.tdf)
Walkers currently ride VEH/HEAVY = tank slot (speedmodclass 0): they read the
`tank` terrain moveSpeeds and the tank slope curve, so a mech has zero
all-terrain advantage — the class's whole selling point. Propose a KBot-slot
class (SpeedModClass Tank=0, KBot=1, Hover=2, Ship=3):

```
[CLASS5]
{
    name=MECH;
    footprintx=2;
    footprintz=2;
    maxwaterdepth=22;
    maxslope=40;        // steeper than VEH 32 / HEAVY 24 — the walker payoff
    crushstrength=100;
    speedmodclass=1;    // KBot slot: kbot terrain moveSpeeds + ground curve
}
```

Then mechs.lua s1–s3 + fable_mech switch `movementclass = 'MECH'`. s4 /
fable_colossus could stay HEAVY (footprint 4) or get a MECH_HEAVY twin
(footprint 4, maxslope 34, crushstrength 500, speedmodclass=1) if the s4
walker should also climb. Note the moveinfo.tdf header caveat: INFANTRY's
mis-declared Hover slot is a separate measured milestone — adding CLASS5
does not touch it.

### 2. AA weapons lack target-category gating (weapons/weapons.lua)
No weapon in the game sets `onlytargetcategory`/`badtargetcategory`.
MS_MISSILE_AA_* / MS_FLAK_* have `toairweapon = true` but nothing restricts
ground fire — mechs s3/s4 will happily volley their AA racks at tanks.
Propose class-wide on both families: `onlytargetcategory = 'AIR'` (category
tokens AIR/LAND/SHIP are already consistent across defs). Owner of
weapons.lua should decide whether flak keeps a dual-purpose ground mode.

### 3. Sound gaps (note only)
No unit select/ok/death sounds exist for mechs (gamedata/sounds.lua is
weapon-only). Walk-cycle footstep sounds would suit the class when unit
audio lands. No def references a missing file today.

### 4. Animation notes (no fix needed)
- mechs s1/s2 have no `objectname` override → blue stand-in geometry, no
  walk animation possible until models land (known: 6 families lack models).
- s3 fable_mech and s4 fable_colossus ship authored walk/idle/death clips;
  s4's third weapon (FLAK_S2) firing from unit centre with no aim piece is
  documented in-file as intentional.
- Def footprint 5×5 on the colossus vs HEAVY moveDef 4×4 is fine (the
  moveDef drives pathing); noted in-file.
