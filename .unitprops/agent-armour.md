# agent-armour — tanks.lua / fable_tank.lua / fable_heavy.lua / wz_baseline.lua

Reviewed 2026-08-20 against BAR vehicle anchors (per-member HP = maxdamage /
squad_size; maxvelocity ×30 = e/s):
flash 730hp/101e/s/turn544 · stumpy 1800/75/340 · bull 4650/62/365 ·
goliath 7800/39/176 · korgoth (T3) 149000/37.

## Changes made

### units/tanks.lua (the 4-scale roster class)
The builder's generic ×2 curve produced paper-thin members and scout-agile
heavies. All four scales now carry explicit numbers:

| scale | squad | maxdamage (per-member) | e/s | turn | sight | mass | was |
|---|---|---|---|---|---|---|---|
| s1 tankette pack | 8 | 2400 (300) | 93 | 900 | 450 | 500 | 1400 (175), 78 e/s |
| s2 MBT troop | 4 | 7200 (1800 ≈ stumpy) | 75 | 380 | 480 | 1600 | 2800 (700), turn 636 |
| s3 heavy platoon | 2 | 13000 (6500 ≈ bull–goliath) | 45 | 200 | 560 | 3600 | 5600 (2800), turn 450 |
| s4 dreadnought | 1 | 30000 (T3 band) | 33 | 140 | 700 | 9000 | 11200, turn 318, 43 e/s |

- s1 also gets raider accel/brake (0.35/0.3); s3/s4 get heavy accel/brake.
- Transport keys: `transportbyenemy = false` on all scales;
  `cantbetransported = true` on s4 (nothing lifts a dreadnought).
- Weapons kept as-was — every referenced def exists in weapons/weapons.lua
  (MS_AC_S1, MS_AC_S3, MS_RAILGUN_S2/S4, MS_MG_S2, MS_HOWITZER_S2,
  MS_FLAK_S2). Loadouts are role-sane: AC line guns s1/s2, railgun+coax s3,
  rail/howitzer/flak flagship fit s4. FLAK_S2 is `toairweapon`, so the s4's
  AA mount is genuinely AA-capable; no onlytargetcategory gap.
- movementclass fit: s1/s2 VEH (fp 2/3), s3/s4 HEAVY (fp 4/5). Kept.

### units/fable_tank.lua (showcase single MBT)
- turnrate 680 → 420 (was scout-car agility on an MBT; stumpy is 340).
- `transportbyenemy = false`. HP 2000 / 69 e/s / sight 470 kept — already in
  the stumpy ballpark. Applies to all 5 dressed variants (they copy the base).

### units/fable_heavy.lua (showcase single super-heavy)
Same hull ms_tanks_s4 ships, so the standalone def now tracks the roster
flagship: maxdamage 9000 → 24000 (a shade under s4's 30000 — two weapons vs
three), mass 2800 → 9000, speed 1.4 → 1.2 e/f, accel 0.10 → 0.07, turnrate
320 → 160, sight 520 → 650, `cantbetransported = true`,
`transportbyenemy = false`. The old numbers read as a T2 heavy.

### units/wz_baseline.lua (harness baselines)
Not roster duplicates — ms_tanks_s1/s3 borrow the wz MODELS but define their
own defs; the standalone wz defs only need to sit in the same ballpark:
- wz_tank: 1600 → 1800 hp, turnrate 700 → 400 (now matches fable_tank /
  ms_tanks_s2 members). `transportbyenemy = false`.
- wz_wheeled: stats already sane (flash anchor); category 'LAND MOBILE' →
  'LAND MOBILE VEHICLE' (type-token convention); `transportbyenemy = false`.
- wz_cyborg: stats sane (ZK glaive band); category → 'LAND MOBILE INFANTRY';
  `transportbyenemy = false`.
- wz_building: untouched — matches the buildings_*.lua convention
  (canmove=false, no maxvelocity key, engine defaults it to 0).

All four files pass `luac -p`.

## Proposals (files owned by other agents)

1. **transports.lua — landing ship mass budget.** `ms_landing_ship` has
   `transportcapacity 4, transportsize 3, transportmass 2400`. With the
   rebalanced masses it can carry one MBT troop (1600) + one tankette pack
   (500) and nothing more; a heavy platoon (3600) can never board. If the
   design intends heavies to make beach landings, raise `transportmass` to
   ~6000 (heavy platoon + escort) — capacity/size already fit (s3 footprint
   4 ≤ 2×transportsize). If heavies are deliberately sea-lift-only via a
   bigger future hull, no change needed.
2. **fable_airship.lua — `transportmass = 1200`** now carries only the
   tankette pack (500) among armour; the MBT troop (1600) just misses. If
   air-lifting an MBT troop is intended, bump to 1800. (Not my file; flag
   only.)
3. **weapons.lua — no change requested.** MS_MG_S2 as the s3 coax is
   statistical (no projectile) — fine for a squad abstraction, and s3 uses
   the wz_tank model with no coax piece anyway.

## Notes / flagged gaps (no fix)

- **Unit sounds**: none of my defs reference select/ok/death sounds —
  gamedata/sounds.lua has weapon sounds only. Roster-wide gap, not per-file.
- **Animation**: tanks s4 (fable_heavy model) has 3 weapons but 2 turret
  pieces — weapon [3] (flak) fires from unit centre with no cosmetic aim;
  already commented in tanks.lua, matches the "cosmetic sub-parts" pattern.
- **Footprint vs movedef**: s4 unit footprint 5 vs HEAVY movedef footprint 4
  — pathing uses the movedef, so the unit blocks slightly wider than it
  paths. Harmless at stub quality; a MOVEDEF-owner could add a HEAVY6 class
  if super-heavies ever clip fences.
- **Mass semantics on squads**: maxdamage is aggregate but `mass` has no
  documented aggregate-vs-member convention; I kept masses aggregate
  (matching HP) so transportmass budgets stay coherent. If crush resistance
  is ever computed from mass, an 8-member tankette squad at 500 aggregate
  reads as one 500-mass object — worth a design note in PLAN-metalstorm §5.
