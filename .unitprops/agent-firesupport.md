# agent-firesupport — artillery / staticdefense / radar / command_vehicles

All four files syntax-checked with `luac -p` (OK). No models/objectnames touched.

## Anchors used

- BAR arty ladder: armart 620hp / 54 e-s / turn 394 / r710; armmart 1070/60/270/r820;
  armmerl 1220/33/520/r1300; armbrtha (bertha) 4450hp / r4650 / sight 273.
- BAR radar: armrad radar 2100 sight 680 hp 180; armarad 3500/1000/500;
  armseer (radar vehicle) 2300/900/980hp/57 e-s.
- Metalstorm envelope is ~0.7x BAR's (max weapon range 3200 vs bertha 4650),
  and HP runs ~0.25x (tank s2 member 700 vs BAR MBT 2500-3000), so I tuned for
  INTERNAL consistency against tanks.lua/recon_vehicles.lua, using BAR ratios.

## Changes made

### artillery.lua
- `baseTurn = 500` (was builder default 900 — a tank number). Gives 500/354/250/177,
  matching BAR arty's 270-520 band. Poor turn per role.
- `baseSight = 380` (was 450): sight 380/460/540/620, SHORT of weapon range at every
  scale — spotter/radar-reliant like BAR arty (armart sight 364 vs r710).
- Per-scale sluggish `acceleration`/`brakerate` (0.14/0.15 down to 0.08/0.10 at s4;
  builder default was 0.25/0.2 for all).
- s4 `maxvelocity = 0.7` (21 e/s): the Continental Gun crawls (curve default was 0.77).
- HP left alone: per-member HP is already exactly 0.5x the same-scale tank member
  (87/350/1400/5600 vs 175/700/2800/11200) — "fragile" already holds.
- Weapons left alone. Range check vs same-scale direct fire (all PASS):
  s1 MORTAR_S2 r750 > AC_S1 380 / MG_S2 380; s2 HOWITZER_S1 r1100 > AC_S3 520 /
  RAILGUN_S2 750; s3 HOWITZER_S2 r1500 > RAILGUN_S3 900; s4 HOWITZER_S4 r3200 >
  RAILGUN_S4 1200. Note s1 deliberately uses the HEAVY mortar (S2, r750) — the
  light mortar (r600) would only TIE the light railgun's 600.

### staticdefense.lua
- Verified the immobile invariant: `canmove = false` and NO scale sets `maxvelocity`,
  so _builder.lua line 41 hard-forces `maxvelocity = 0`. Added a comment warning
  future editors not to add a per-scale maxvelocity key (engine SIGSEGV otherwise).
- HP raised to ~2x the same-scale tank SQUAD (was ~1.4x): maxdamage
  2800/5600/11000/22000 (was 2000/4000/8000/16000). BAR's LLT is ~3x a T1 tank;
  forts trade mobility for staying power.
- s3 `sightdistance = 950` (was 610): its RAILGUN_S3 has r900 — it could not see
  its own max range. s4 `sightdistance = 1050` (was 690); its r3200 gun remains
  spotter-fed by design (bertha pattern).
- Weapons unchanged: all turret=true families (correct for emplacements); s2-s4
  carry FLAK for AA cover; s1 gun nests have none (fine — light tier).

### radar.lua
- Kept the radardistance ladder 1500/2600/4200/7000: s1 = 0.71x BAR T1 (2100) and
  s2 = 0.74x BAR adv (3500), which matches the game's ~0.7x range envelope; s3/s4
  extend the curve as theatre assets. Sonar s3 2000 / s4 3500 kept.
- `sightdistance` overridden UP to 600/750/900/1100 (builder default was
  450/530/610/690): sensor stations see further than line units (BAR radar sight
  680 vs ~400 for units).
- HP halved to 300/600/1200/2400 (was 600/1200/2400/4800): soft intel targets,
  raid magnets (BAR radar is 180hp vs 2500 MBT — proportionally far softer still).

### command_vehicles.lua (ms_command_s2)
- `maxdamage` 900 → 1600: tanky-ish single high-value unit, between a tank-squad
  member (700) and an s3 heavy member (2800). At 900 a lone tank member nearly
  matched the mobile HQ.
- `maxvelocity` 2.2 → 1.7 (66 → 51 e/s): it outran the MBTs it should follow;
  BAR radar vehicles run 48-57 e/s.
- Intel kept: sight 900 / radar 1800 — above the scout buggy (700/1200), below the
  s2 sensor building (750/2600). Weapon kept: MS_MG_S2 pintle, self-defence only.
- AI customparams check: strategos reads `ms_class` (present: 'command') and prices
  hp via power.json; game_authority reads `authority_cost_base` (present: '2').
  `squad_size = '1'` present. No gaps.

## Proposals (NOT edited — shared files)

1. **weapons.lua — MS_MORTAR_S1 range**: currently 600, exactly tying MS_RAILGUN_S1
   (600), which is why artillery s1 skips it for MORTAR_S2. If the light mortar is
   ever meant to be usable on a scale-1 indirect unit, bump it:
   `{ name = 'Mortar', range = 680, reloadtime = 4.0, dmg = 180 }`.
   CAVEAT: soldiers.lua s-something carries MS_MORTAR_S1 as a secondary — check
   with the infantry agent before changing; 600→680 only helps foot mortars.
2. **weapons.lua — MS_HOWITZER_S3 ("Naval Battery", r1900)**: referenced only by
   ships.lua and fable_battleship.lua — correctly naval. Artillery s3 deliberately
   stays on S2 (r1500 ≈ BAR merl's 1300 tier). No change needed, intent confirmed.
3. **Jammer variant (radardistancejam)**: no jammer exists in the roster. Proposal —
   a `ms_jammer` field unit or an s2 radar sibling with
   `override = { radardistancejam = 1200, radardistance = 0 }` (BAR T1 jammer ~450
   jam at BAR scale; 1200 here would mirror our 0.7x radar scaling of BAR's adv
   jammer). Needs a roster decision, so notes-only.
4. **Sounds**: none of my four classes set unit sounds (select/ok/death); the
   sounds/ tree has weapon sounds only. Gap noted per brief §5 — no missing-file
   references added.
5. **Animation note (brief §6)**: radar s1-s4 and the command vehicle imply
   rotating dish/antenna animation; command vehicle already documents its
   model-piece `idle` clip (dish sweep). Radar buildings have no models yet
   (builder blue stand-ins) — nothing to fix.
6. **Category**: staticdefense/radar use 'LAND BUILDING' (consistent with the other
   building files). The brief's STATIC token is not in use anywhere in the game —
   flagging the convention mismatch rather than inventing a new token unilaterally.
