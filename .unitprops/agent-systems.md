# agent-systems — shared system files review (2026-08-20)

Assigned: weapons/weapons.lua, gamedata/moveinfo.tdf, gamedata/sounds.lua,
gamedata/footprints.lua. All edited files pass `luac -p`.

## Changes made

### weapons/weapons.lua

1. **AA targeting — dead key replaced.** `toairweapon` has ZERO hits anywhere
   in the engine (`rts/`); it was a no-op on MS_MISSILE_AA and MS_FLAK. The
   engine's real mechanisms are:
   - weapondef `canattackground = false` (WeaponDef.cpp WEAPONTAG) — applied
     to both families (this is exactly BAR's armflak/corflak pattern);
   - per-unit-weapon `onlytargetcategory` parsed from the UNIT's weapons
     table (rts/Sim/Units/UnitDef.cpp:44, default 0xffffffff = anything).
     That half belongs to the units files — proposal below.
2. **MS_MISSILE_AA turnrate 18000 → 45000.** 18000 COB-units/s ≈ 1.7 rad/s —
   too slow to home on a 270 e/s fighter squad at close range. BAR AA missiles
   run ~40k–63k. `flighttime` deliberately left unset: 0 auto-computes ttl
   from range (MissileLauncher.cpp:65).
3. **MS_HOWITZER per-scale weaponvelocity (S2 500, S3 560, S4 750).** These
   are `resolution = 'ballistic'` — real projectiles. Max ballistic range is
   v²/g and no map sets gravity (engine default 130), so the family-wide 420
   capped physical reach at ~1357 elmos: S2 (1500), S3 (1900) and S4 (3200)
   could NEVER land a shell at declared range. New velocities give 1.2–1.35×
   margin. S1 (1100) keeps 420 (reach 1357).
4. **MS_MORTAR ranges 600/750 → 680/860** so artillery strictly outranges the
   same-scale direct-fire ceiling (MS_RAILGUN S1 600 / S2 750 — they used to
   tie exactly). Still well under same-scale howitzers (1100/1500). Velocity
   280 → 320 (cosmetic only — statistical volleys spawn no projectile).
5. **MS_MISSILE_CRUISE `cruisealt = 300` → `trajectoryHeight = 0.35`.**
   `cruisealt` is not a weapon key in this engine (cruiseAlt is a UNITDEF
   aircraft key, UnitDef.cpp:502) — the missiles were flying flat.
   trajectoryHeight (WeaponDef.cpp:114, Missile only) arcs them at ~35% of
   target distance, restoring the high-strike/interception profile.

Left alone on purpose: all damage/reload/AoE numbers (checked vs BAR
per-weapon norms — MG≈peewee emg tier, AC S2 220/1.6 ≈ T1 MBT gun, railgun
S4 3200/8 ≈ T3 gun, flak 120/1.5 vs corflak 497/0.53 is low per-shot but the
statistical model resolves whole volleys; see damage-model proposal below).
All ladders are monotone in range/damage/reload within every family.
All customparams (resolution, stat_*, min_volley_damage, skip_fire_strength)
preserved byte-identical. MS_AC_TECHNICAL's deliberate ballistic exception
untouched. Every `soundstart` key resolves to a SoundItem whose .webm exists
in sounds/weapons/ (11/11 verified against the directory).

### gamedata/moveinfo.tdf
No numeric changes; speedmodclass untouched per header. Reviewed vs BAR:
maxslope ladder 45/32/24 (bot > light veh > heavy — matches BAR ordering),
maxwaterdepth 12/20/30 monotone with hull size, SHIP/SUB minwaterdepth 12/20,
crushstrength 5/50/500 (+SHIP 200/SUB 100) — all in ballpark. Added a
review-record comment only.

### gamedata/sounds.lua
Commented out the `turret_servo` SoundItem: `sounds/units/turret_servo.webm`
DOES NOT EXIST (sounds/units/ holds only engine_run.webm). Only
effects/bindings.example.json references the key, so nothing live breaks.
Every other SoundItem's file verified present (weapons/ 11, impacts/ 4,
explosions/ 6, units/ 1).

### gamedata/footprints.lua
No structural changes. The four BUILDING profiles are consistent with their
defs' footprints at 16 elmos/footprint-square (tank_farm 16×8→256×128,
port_crane 8×4→128×64, rail_platform 6×12→96×192, pontoon_wharf 4×20→64×320)
— all four check out exactly. Added a NOTE: the three MOBILE profiles
(quad_walker_l, heavy_tracks, dreadnought) are referenced by NO unit.

## Proposals (units/*.lua and _builder.lua — NOT edited by me)

### P1 — AA weapons need `onlytargetcategory = 'AIR'` on the unit weapon slot
`canattackground = false` stops ground attacks but auto-targeting priority is
still gated by category. Metalstorm air units all carry category 'AIR MOBILE',
so on every MS_FLAK_*/MS_MISSILE_AA_* weapon slot add the key, e.g.
(tanks.lua s4): `[3] = { name = 'MS_FLAK_S2', onlytargetcategory = 'AIR' }`.
Applies to: tanks s4 [3]; staticdefense s2 [2], s3 [2], s4 [2]; ships s2 [2],
s3 [2], s4 [3]; fable_battleship [4]; fable_carrier [1] and [2];
fable_train armoured [2]; soldiers s4 [2]; fighters s1?/s2 [2]/s3 [2]/s4 [2];
mechs s3 [2]. (Fighter guns should stay unrestricted — they strafe ground.)
Optionally mirror BAR with `badtargetcategory` on ground guns later.

### P2 — footprint profile attachments
`customparams.footprint_profile`: mechs s3 → 'quad_walker_l',
tanks s3 → 'heavy_tracks', mechs s4 / fable_colossus → 'dreadnought'
(hull sizes are in the right neighbourhood of those units' footprints; the
profiles were authored for exactly these archetypes per PLAN-metalstorm-flow §1).

### P3 — _builder.lua growth curves vs how BA/ZK actually tier
Current: HP/mass ×2 per scale, speed −15%/scale (linear), turn ÷√growth,
sight +80/scale, squad ÷2 per scale.
- **HP: ×2 aggregate per scale is too shallow.** BAR per-UNIT tiering is
  ~×2.5–3 per tier (flash 730 → stumpy 1800 → bull 4650 → goliath 7800+),
  and metalstorm's squad simultaneously HALVES member count per scale, so
  aggregate ×2 means per-member ×4 — but starting from a swarm baseline the
  s2/s3 members still land thin (the tanks.lua review had to override all
  four scales). Proposal: `maxdamage = baseHp * 2.5^(s-1)` with squad ÷2,
  giving per-member ×5 per scale — matches the tanks.lua hand-tuned anchors
  (300 → 1800 → 6500 per member) far better than ×2 does. Classes that
  already override every scale are unaffected.
- **Speed: linear −15% is fine at s2 but too gentle at s4.** BAR spread is
  flash 101 → stumpy 75 → bull 62 → goliath 39 e/s ≈ ×0.75/×0.83/×0.63
  stepwise. Proposal: multiplicative `baseSpeed * 0.8^(s-1)` (1 / 0.8 / 0.64
  / 0.51) instead of (1 / 0.85 / 0.70 / 0.55) — nearly identical at s2–s3
  but reads better as a rule and composes with per-class overrides.
  Low-priority; linear is not nonsense.
- **Turn ÷√growth is the clearest miss.** With growth ×2 it gives s4 = 0.35×
  base — the "super-heavies with scout turn rates" problem the brief calls
  out (900 → 636 → 450 → 318; BAR goes ~380 T1 MBT → ~130 goliath, a 0.34×
  over ONE size class, not three). Proposal: `turnrate = baseTurn / growth`
  (900/450/225/112) — matches the tanks.lua hand overrides (380 s2, 200 s3)
  almost exactly.
- **Acceleration/brakerate are scale-constant (0.25/0.2)** — heavies stop on
  a dime. Proposal: `0.25 * 0.7^(s-1)` and `0.2 * 0.7^(s-1)`.
- Sight +80/scale is fine (450→690 spans BAR T1 scout→T2 ranges).

### P4 — damage model note (weapons + builder joint)
Weapon damage is authored per-weapon in BAR ballpark, but a squad's
`maxdamage` is aggregate (per-member HP × squad_size). A 4-member MBT squad
firing ONE BAR-calibre volley vs 4×BAR HP gives mirror TTKs ~2× BAR's. If
squad fights feel spongy in playtests, the clean fix is a builder-side or
engine-side volley multiplier ~ squad_size (the statistical resolver already
scales volleys DOWN by attacker strength fraction — it just needs the full-
strength volley to represent all members' guns). Do NOT fix by inflating
weapondef damage: the same weapon def is shared by squads of different sizes
(MS_AC_S3 is carried by 4-tank squads, static towers, colossus...).

### P5 — sound gaps (assets, not defs)
sounds/units/ needs: turret_servo.webm (entry parked in sounds.lua),
plus there are still no selection/order/death unit voices at all — every
unit def relies on weapon/explosion audio only. Note, not a defect.
