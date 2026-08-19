# agent-naval — ships.lua / subs.lua / fable_battleship.lua (2026-08-20)

Anchors: BAR naval per-member (speed in elmos/s; ours is elmos/frame ×30).
armpt 780hp/93 · armdecade 970/105 · armroy(DD) 3700/67/turn300/sonar375 ·
armcrus(CA) 5600/60/turn270 · armbats(BB) 9800/58/turn180 · armepoch 50000/54/
radar1530 · armsub 840/66/sonar400/waterline45 · armsubk 2350/81/sonar525 ·
armserp 3550/45/sonar400.

Engine facts verified: `sonarDistance`/`radarDistance`/`waterline` are real
UnitDef keys (rts/Sim/Units/UnitDef.cpp:413,464-465); `canSubmerge` is
**aircraft-only** (`… && canfly`, UnitDef.cpp:498) — sub submergence is
waterline + movedef; MoveDefHandler.cpp:235 reads `subMarine` from the movedef.
moveinfo.tdf already has minwaterdepth (SHIP=12, SUB=20) and speedmodclass=3
for both — no per-def fix needed for staying in navigable water.

## Changes — ships.lua

All 4 scales: per-scale speed/turn/accel/brake overrides (builder curve gave
patrol boats destroyer speed and battleships car acceleration).
- s1 patrol flotilla: maxvelocity 3.0 (90 e/s ≈ armpt), turn 540, accel/brake 0.15.
- s2 destroyer pair: maxdamage 5000→7500 (2×armroy), vel 2.2, turn 300,
  **sonardistance 450** — it carries MS_DEPTHCHARGE_S1 and previously had no
  sonar, so its ASW rack could never acquire a submerged target.
- s3 cruiser: vel 2.0, turn 250, radardistance 1000, sonardistance 500,
  description "Heavy cruiser" (was blank).
- s4 battleship: maxdamage 20000→24000, vel 1.8, turn 160, radar 1400,
  sonar 600. Weapons unchanged (all referenced defs exist in weapons.lua).

## Changes — subs.lua

All 4 scales: sonardistance (500/600/750/900), waterline (10/12/14/14 — kept
under SUB minwaterdepth=20 so shallow lanes never ground a boat), sight
overridden DOWN to 350/400/450/500 (periscope, not crow's nest), slower
accel/brake, sub-appropriate turnrates (500/420/400/250).
- s1: maxdamage 1600→2800 (4 boats ≈ 700 each; was half a BAR T1 sub).
- s2: description "Attack sub pair" (was blank), vel 1.8.
- s3 hunter-killer: **squad forced to 2** — description says "pair" but the
  builder formula round(4/4) collapsed it to 1; maxdamage 6800 (2×3400 ≈
  serpent); vel 2.2 — the FAST scale (BAR sub-killer outruns its T1).
- s4 leviathan: maxdamage 12800→14000, vel 1.2, turn 250.

## Changes — fable_battleship.lua

Aligned with ms_ships_s4: maxdamage 22000→24000, mass 6000→12000, vel 1.6→1.8,
turn 180→160, accel 0.05→0.045. Added radardistance 1400 (the model has a
spinning mast radar) + sonardistance 600.

## PROPOSALS (shared files I don't own)

1. **gamedata/moveinfo.tdf — SUB class should be a submarine.** Without
   `subMarine=1` the SUB movedef paths like a surface ship. Exact edit
   (CLASS4 block):
   ```
   [CLASS4]
   {
       name=SUB;
       footprintx=3;
       footprintz=3;
       minwaterdepth=20;
       crushstrength=100;
       speedmodclass=3;
       subMarine=1;
   }
   ```
2. **weapons/weapons.lua — sub-launched cruise missile.** ms_subs_s4
   references MS_MISSILE_CRUISE_S2, which is not a waterweapon: a submerged
   launcher may never fire (flagged in subs.lua comment; shallow waterline 14
   is the interim mitigation). Proposed def:
   ```lua
   -- Sub-launched strategic missile — breaches, then cruises.
   defs.MS_MISSILE_CRUISE_SUB = {
       name = 'Sub-launched Cruise Missile', weapontype = 'MissileLauncher',
       weaponvelocity = 500, tracks = true, turnrate = 6000,
       areaofeffect = 160, soundstart = 'cruise_launch', cruisealt = 300,
       range = 3200, reloadtime = 45.0, damage = { default = 3600 },
       waterweapon = true, fireSubmerged = true,
       customparams = { resolution = 'ballistic' },
   }
   ```
   (Verify the engine's exact submerged-fire key — BAR uses `waterweapon`
   plus firing from a `waterline`d unit; if `fireSubmerged` isn't parsed,
   `waterweapon = true` alone should suffice.) I will not switch subs.lua to
   it until it lands.
3. **Target-category gaps (notes only, engine-wide).** No metalstorm weapon
   sets `onlytargetcategory`/`badtargetcategory`. Consequences for naval:
   torpedoes/depth charges can be ordered at land targets (waterweapon
   should gate them in practice), and ship railguns/howitzers can target
   SUBs they cannot hit. When the categories agent standardises tokens,
   naval wants: torpedoes/depth charges `onlytargetcategory = 'SHIP SUB'`
   (or NOTAIR+water), surface guns `badtargetcategory = 'SUB'`,
   flak/AA already carry `toairweapon`.
4. **Sounds:** no unit-level sounds referenced (gamedata/sounds.lua has
   weapon sounds only — torpedo_launch/depthcharge_drop/cruise_launch exist).
   Gap, not a defect: no select/activate/underattack unit sounds for naval.
5. **Category tokens:** roster uses SHIP/SUB (not the brief's "SEA") —
   consistent across ships.lua, subs.lua, transports.lua (sea transport),
   fable_carrier.lua, fable_battleship.lua. No typos found; left as-is.
6. **Animation:** fable_battleship's turret chains + spinning radar are
   model-piece driven (fine). ms_ships_s1–s3 / ms_subs_* have generic
   objectnames; nothing in their defs implies animation the pipeline can't do.

All three files pass `luac -p`.
