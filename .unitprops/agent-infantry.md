# agent-infantry — soldiers / irregulars / engineers / recon_vehicles

## Changes made

### units/soldiers.lua
- `baseSpeed` 1.8 → 1.4 (54 → 42 e/s at s1; scaling down per scale to ~29 e/s).
  Old value had rifle sections outrunning scout cars. s4 exo suit overridden to
  1.2 (36 e/s — powered suit strides faster than the marching curve).
- Per-member HP fixed (maxdamage is aggregate):
  - s1: 400 → 960 (25 → 60 HP/member × 16)
  - s2: kept 800 (100/member × 8 — already sane)
  - s3: 1600 → 1000 (400 → 250/member × 4, armoured weapon crews)
  - s4: 3200 → 2400 (single exo suit ≈ light tank, not an MBT)
- Footprints capped at 2/2/3/3 (builder curve gave 2/3/4/5). Anything over 3
  fails the landing ship's `transportsize = 3` (engine attach check is
  footprint vs transportsize; game_transports.lua only WARNS when cargo is
  refused). All four scales now load; masses 90/180/360/720 fit `transportmass
  2400` (4 × s4 = 2880 slightly over — 3 exos + change per ship, acceptable).
- Turnrate overrides s3 = 700, s4 = 600 (growth curve gave 450/318; infantry
  turn on the spot).
- `transportbyenemy = false` on every scale.
- Weapons verified to exist in weapons/weapons.lua: MS_MG_S1/S2, MS_AC_S1/S2,
  MS_MORTAR_S1, MS_MISSILE_AA_S1 — all present, family+scale fit the roles
  (s4 gets AA-capable MS_MISSILE_AA_S1). No changes.
- Impostor customparams untouched.

### units/irregulars.lua (ms_technical)
- maxdamage 320 → 480: still thin-skinned by design, but 320 died to ~1.5
  cycles of the lightest autocannon. BAR T1 scout car anchor is ~600 hp.
- sightdistance 420 → 480 (a raider should see a little past its own gun;
  MS_AC_TECHNICAL range is 320-ish family territory).
- `transportbyenemy = false`. Footprint 2×3 fits the landing ship.
- speed 3.4 (102 e/s) kept — right for the role.

### units/engineers.lua
- **Builder keys were missing entirely**: the class had `workertime` only.
  `workertime` does nothing without `builder = true`, and assist reach needs
  `builddistance`. Added per scale via a `crew()` helper:
  `builder = true, canrepair = true, canassist = true`, workertime kept at
  50/120/300/800, builddistance 120/140/180/240 (static field workshop
  reference: workertime 80, builddistance 300).
- **No `canreclaim`, deliberately**: LuaRules/Gadgets/squad.lua AllowCommand
  forbids CMD_RECLAIM/RESURRECT/CAPTURE and gates REPAIR to build-assist
  (buildProgress < 1). Engineers are pure build-assist/field-works crews —
  matches the field-engineering-only ruling. **No buildoptions** — engineers
  assist what sites/factories stage; nothing in LuaRules reads mobile-builder
  buildoptions (grep-verified: no workertime/builddistance/buildoptions
  consumers in LuaRules; the engine consumes them directly).
- `baseSpeed` 1.8 → 1.4 (same walking-pace fix as soldiers).
- s1 maxdamage 300 → 480 (60/member × 8).
- s3/s4 re-typed as vehicles (their own descriptions say "rig pair" / "vast
  crawler"): per-scale override `movementclass = 'VEH'` / `'HEAVY'` and
  `category = 'LAND MOBILE VEHICLE'`. An INFANTRY-movedef crawler climbed 45°
  slopes and crushed nothing. s4 also `cantbetransported = true` (footprint 5
  exceeds every carrier's transportsize anyway).
- Class category 'LAND MOBILE' → 'LAND MOBILE INFANTRY' (s1/s2), consistent
  with soldiers.
- Footprints 2/2/3/5. s1/s2/s3 fit the landing ship.
- `transportbyenemy = false` on all scales. Impostor params untouched.

### units/recon_vehicles.lua
- Only `transportbyenemy = false` added to both defs. Everything else already
  matches the brief: scout buggy 4.2 e/f = 126 e/s, 240 hp (fragile), sight
  700 + radar 1200; obs balloon sight 1600 + radar 2200, 300 hp, slow.
- Both deliberately unarmed per the file's authored rationale ("they buy sight
  and radar, not damage") — see proposal 2 for the tension with the brief.

## Proposals (not edited — outside my files or contested)

1. **INFANTRY movedef is speedmodclass 2 (Hover)** — gamedata/moveinfo.tdf's
   own header flags it as mis-declared (PLAN-maps.md 2o "B for infantry
   later"). Not mine to touch; noting that all infantry speed numbers above
   were ballparked assuming ground-ish behaviour.
2. **Scout buggy light weapon (brief conflict).** The brief asks recon
   vehicles for "light weapons"; the file's authored design is explicitly
   unarmed. If armed is wanted: `weapons = { [1] = { name = 'MS_MG_S1' } }`,
   `canattack = true` on ms_scout_buggy. Caveat: MS_MG_S1 is `statistical`
   (spawns no projectile) and the model has a sensor dish, not a gun — no
   cosmetic aim, same trap weapons.lua documents for the technical. If armed,
   either accept that or add a ballistic `MS_MG_BUGGY` one-off (owner:
   weapons.lua agent).
3. **Recon radar at higher scales**: recon_vehicles are M1 one-offs, not a
   4-scale class, and both already carry radardistance (1200 / 2200). If a
   4-scale recon class is ever built, radardistance belongs in its per-scale
   overrides; no change needed elsewhere today. Note units/radar.lua remains
   the static sensor class.
4. **Unit sounds**: none of my four files reference unit sounds; sounds/ has
   weapon sounds only. Gap noted per brief §5 — no missing-file references
   introduced.
5. **No weapon defines onlytargetcategory/badtargetcategory anywhere** —
   AA weapons rely on `toairweapon` alone. Fine engine-side, but if target
   categories are ever adopted, soldiers/engineers now carry a consistent
   INFANTRY token (and engineer s3/s4 VEHICLE).
6. **transportmass vs 4 × s4 exo (2880 > 2400)**: if a full lift of four exo
   suits should fit the landing ship, raise its transportmass to ~3000
   (owner: transports.lua agent). Three fit today.

All four files parse clean (`luac -p`).
