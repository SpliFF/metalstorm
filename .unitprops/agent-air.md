# agent-air — fighters.lua, bombers.lua, fable_fighter.lua, fable_bomber.lua

All four files edited, luac -p clean. Engine facts below were verified in the
main checkout's `rts/Sim/Units/UnitDef.cpp` / `rts/Sim/MoveTypes/*`.

## Engine facts that drove the changes (this fork)

1. **`acceleration` is IGNORED for strafing fighters/bombers.** UnitDef.cpp
   line ~623 re-reads `maxAcc` (default 0.065) for any
   IsFighterAirUnit/IsBomberAirUnit. Every air def in these files was setting
   `acceleration` values that never applied. Fixed to explicit `maxacc`/`maxdec`
   (BAR anchors: fighter 0.18/0.075, bomber 0.0575/0.05).
2. **`cruisealtitude`/`cruisealt` → wantedHeight; default 0.** The squad
   classes (fighters/bombers) set NO cruise altitude at all → deck-hugging.
   Added per scale (fighters 110–160, bombers 140–300).
3. **Bomber classification is weapon slot 1 only** (`HasBomberWeapon(0)`:
   AircraftBomb/torpedo projectile). `ms_bombers_s4` led with
   MS_MISSILE_CRUISE_S2 → engine classified it a FIGHTER (wrong strafe height,
   undoubled turn radius). Reordered: bomb first, cruise second, flak third.
4. **`cantbetransported` defaults TRUE for canfly units**
   (`GetBool("cantBeTransported", !RequireMoveDef())`) — no key needed;
   commented instead of set.
5. **`turnradius` default is 500 (doubled to 1000 for bombers)** — BAR uses 64
   for fighters. Set 60–70 fighters, 90–150 bombers.
6. **`airsightdistance` default is only 1.5×sight** — BAR air uses 950–1100.
   Set explicitly on every scale.
7. `maxaileron/maxelevator/maxrudder/maxbank/maxpitch` ARE parsed by this fork;
   engine defaults are close to BAR's values, so left at defaults.

## Per-file changes

### fighters.lua
- Speed curve inverted: builder slowed fighters up-scale (s4 was 148 e/s);
  fighters now 270 / 288 / 318 / 210 e/s (s1–s4). BAR: T1 fig 289, T2 358.
- s1 interceptors gained MS_MISSILE_AA_S1 (an MG-only "interceptor" had no
  credible AA weapon).
- All AA missile entries got `onlytargetcategory = 'AIR'`.
- s4 is now a hoverattack GUNSHIP (BAR Brawler pattern): holds station, steers
  by turnrate (700). Hovering air is not IsFighterAirUnit, so its
  `acceleration` applies normally.
- s4 maxdamage trimmed 4000 → 3200 (warship-grade for a single airframe).
- baseSight 450 → 550; collide=false everywhere; cruisealt + maxacc/maxdec +
  turnradius + airsightdistance per scale.

### bombers.lua
- Speeds overridden: 195 / 186 / 168 / 225 e/s (builder's s4 was 107 e/s;
  strategic jets are fast — BRIEF anchor ~230).
- s4 loadout reordered (bomb first — classification, see fact 3).
- All bombs + cruise missiles: `onlytargetcategory = 'LAND SHIP SUB'` (covers
  every surface category in this game; buildings are LAND).
- s4 maxdamage trimmed 6400 → 4500 (was 57% of the super-heavy tank's HP).
- baseSight 450 → 500; collide=false, cruisealt 140/160/200/300, maxacc/maxdec,
  turnradius, airsightdistance per scale.

### fable_fighter.lua
- acceleration 0.9 (dead key) → maxacc 0.18 / maxdec 0.075; maxvelocity
  9.0 → 9.6 (matches ms_fighters_s2, which wears this model); cruisealt
  180 → 150; turnradius 64; airsightdistance 950; AA missile
  onlytargetcategory='AIR'.

### fable_bomber.lua
- acceleration 0.5 (dead key) → maxacc 0.058 / maxdec 0.05; maxvelocity
  6.5 → 6.2 (matches ms_bombers_s2); cruisealt 200 → 160; turnradius 100;
  airsightdistance 800; bomb onlytargetcategory='LAND SHIP SUB'.

## Proposals (for the weapons/gamedata owner — NOT edited by me)

1. **AA gating on GROUND AA users.** MS_MISSILE_AA / MS_FLAK are referenced by
   soldiers, mechs, tanks s4, ships, staticdefense, fable_train, fable_carrier,
   fable_battleship. MS_FLAK and MS_MISSILE_AA defs set `toairweapon = true`
   (air-only at the weapon-def level) so those are safe, but whichever agent
   owns those files may want `onlytargetcategory = 'AIR'` on the unit weapon
   entries too for consistency.
2. **Fighter guns vs air.** MS_MG/MS_AC are plain Cannons (statistical) with no
   air capability flag. If live testing shows fighter autocannons never engage
   air, propose an air-capable gun variant in weapons.lua:
   ```lua
   -- Fighter nose gun — air-to-air cannon pass.
   defs.MS_AC_AIR_S1 = {
       name = 'Fighter Autocannon', weapontype = 'Cannon',
       weaponvelocity = 900, turret = false, accuracy = 140,
       areaofeffect = 12, range = 420, reloadtime = 1.0,
       damage = { default = 150 }, soundstart = 'ac_fire',
       toairweapon = true, burnblow = true,
       customparams = { resolution = 'statistical',
                        min_volley_damage = 10, skip_fire_strength = 0 },
   }
   ```
   (Not referenced anywhere yet — fighters keep the existing families for now.)
3. **Bomb AoE audit belongs to weapons owner**: MS_BOMB_S1 aoe 120 at dmg 400
   is large relative to MS_HOWITZER_S1 (aoe 110, dmg 420, reload 6s). Suggest
   S1 aoe → 80.
4. **Sounds**: weapon sounds exist (bomb_release, missile_launch, ac_fire,
   flak_fire, mg_volley — all referenced by the families used here). Unit-level
   sounds (engine loop, select/ok) have no assets — gap noted, nothing
   referenced.
5. **Animation**: fable_fighter/fable_bomber carry `gear_pieces` customparams
   for a future Hide()-when-airborne script; there is no scripts/ pipeline yet.
   Squad fighters/bombers imply no per-piece animation — nothing undoable.
