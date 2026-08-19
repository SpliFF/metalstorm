# agent-logistics — civilians.lua, civvehicles.lua, logistics.lua, fable_train.lua

Reviewed 2026-08-20. All four files pass `luac -p`.

## Changes made

1. **civvehicles.lua — ms_civbus**: added `canload = 1`, `loadingradius = 100`,
   `releaseheld = true`, and `customparams.is_transport = '1'`. It carried
   `transportcapacity=4, transportsize=1` but no `canload`, so it could never
   actually load its extraction payload; and PLAN-metalstorm-transports.md
   §3.6/§7.9 says every carrier must carry the single `is_transport = '1'` key.
2. **fable_train.lua — all four units (common block)**: added
   `cantbetransported = true`. A coupled car is MoveCtrl-slaved by
   `game_train.lua`; a transport scooping one out of a consist would corrupt
   the gadget's consist list. Mass does not protect them: `transports.lua`
   ground carrier has `transportmass = 2400` ≥ the engine's mass 2400 and all
   car masses (1700–1900).
3. **logistics.lua — ms_courier_car**: `maxvelocity` 4.6 → 4.0. A courier
   truck was the fastest ground unit in the game, outrunning the dedicated
   recon scout (4.2, recon_vehicles.lua). Still the fastest logistics unit.

## Verified sane (no change)

- **Civilians** (`ms_civilians`): `canattack=false`, no weapons, HP 200
  aggregate over squad_size 12 (~17/member vs soldiers' 25/member), speed
  1.4 e/f (42 e/s) below soldiers' 1.8 — a walking pace. Impostor
  customparams untouched per brief. Militia's `MS_MG_S1` exists in
  weapons/weapons.lua.
- **Civ vehicles**: unarmed (`canattack=false`), fragile (350–400 HP vs BAR
  scout-car ~600), moderate speed 2.8–3.0 e/f (84–90 e/s), `VEH` moveclass.
- **Logistics**: supply truck / fuel tanker 2.4–2.6 e/f, HP 380–520, soft-
  skinned truck ballpark; expedition rig `radardistance 1400` sits just under
  the dedicated s1 radar (1500, radar.lua) — correct ordering.
  `authority_cost_base` monotone (1,1,1,2).
- **Trains**: all four referenced weapons exist (`MS_RAILGUN_S2`,
  `MS_FLAK_S1` — has `toairweapon`, `MS_HOWITZER_S2`, `MS_MG_S1`).
  `turnrate 40–50` + `turninplace = false` + `turninplacespeedlimit 0.5`
  gives non-car-like turning. Engine 2.4 e/f > cars 1.8 is fine: coupled cars
  are MoveCtrl-slaved so only the leader's speed matters. Troop car cap 4 /
  size 1 and cargo cap 2 / size 2 match the archived train plan's T5 retune
  and §7.7's tier-sized slots; both cars carry `is_transport='1'`,
  `isfireplatform`, `releaseheld`. Masses (1700–2400) are appropriately the
  heaviest mobiles in the roster.

## Notes / things the movement system can't express (no fix possible here)

- **There are no rails.** `movementclass = 'VEH'` means trains drive raw
  terrain with the tank speed-mod curve; the "rail" is the breadcrumb gadget,
  not the move system. "Fast on its rails" is only expressible via the
  optional roads/moveSpeeds layer (which defaults to 1.0 — memory:
  roads-are-optional-speed-layer), so a train on-road vs off-road is the same
  speed unless the map publishes road speeds for the tank class.
- Engine footprint 3×9 (cars 3×7) is a blocking footprint only; pathing uses
  the VEH moveclass 2×2 footprint, so a long train paths like a jeep. Known
  limitation of Recoil movedefs (no per-unit path footprint).
- Plan table's design-time cargo-car maxvel 1.9 vs shipped 1.8: irrelevant
  while slaved; left at 1.8 (uniform across cars).
- Troop car's second cupola is a flame projector visually but binds
  `MS_MG_S1` — already flagged in-file via `flame_visual`; still no flame
  family in weapons.lua.

## PROPOSALS (for the weapons/gamedata owner — not edited by me)

1. **Civilian auto-target protection.** No weapon in weapons.lua sets
   `onlytargetcategory`/`badtargetcategory`, so every military weapon
   auto-targets `CIVILIAN` units exactly like military ones. The category
   token exists and is consistently applied (`LAND MOBILE CIVILIAN` on all 4
   civ defs). Proposal — add to each `family()` base (or the shared builder):

   ```lua
   badtargetcategory = 'CIVILIAN',
   ```

   This keeps civilians attackable on explicit order but deprioritises them
   for auto-fire, which the ROE/collateral open question (PLAN-metalstorm.md
   §10, authority penalty) will need anyway. AA families (`MS_MISSILE_AA`,
   `MS_FLAK`) don't need it (`toairweapon`), harmless if applied uniformly.
2. **Flame weapon family** (`MS_FLAME_S1`): short range ~250, statistical,
   high dmg vs infantry — would let `fable_train_troop.customparams
   .flame_visual` and any future flame units rebind. Low priority.
3. **Enemy pickup of civilians**: considered `transportbyenemy = false` on
   civilians/militia, but Gaia allegiance vs player teams means it could
   block legitimate player-side extraction; left unset deliberately. If
   kidnap-by-enemy becomes a griefing vector, revisit with the transports
   owner.
