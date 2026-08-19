# agent-transports — summary + proposals (2026-08-20)

Files owned: `units/transports.lua`, `units/fable_airship.lua`,
`units/fable_carrier.lua`. Design source: PLAN-metalstorm-transports.md
(§3.6, §3.8, §7.7, §7.9, §7.11). All three files luac-clean.

## Engine arithmetic used throughout

Measured ground truth from the airship header (Unit.cpp:2684): a passenger
costs **footprintx** capacity slots and needs **footprintx <= transportsize**.
Builder footprints: s1=2, s2=3, s3=4, s4=5 (base 2 + s−1). So §7.7's
"capacity in scale tiers" translates to engine slots as tier t → t+1 slots.

## Changes

### fable_airship.lua (FT-2 Pelican)
- `maxdamage` 3500 → **1200** — the §7.9 comparator: ≥30 s under one
  ms_soldiers_s1 squad (MS_MG_S1 ≈ 50 dps raw → 24 s, over 30 s with
  statistical accuracy falloff at cruise altitude), ~10 s under MS_FLAK_S2
  (120 dps), 15 s under MS_FLAK_S1. 3500 survived dedicated flak for 44 s,
  which voids the HVT premise. (BAR air transports: Atlas 500 hp,
  Hercules ~3000 — 1200 for a heavy lifter is in family.)
- `maxvelocity` 2.0 → **3.6** (108 e/s) — it was slower than its own cargo
  (tanks 2.6). Still far below BAR lift transports (150–240 e/s); it reads
  as a dirigible, not a Valkyrie.
- `transportmass` 1200 → **2200** — one ms_tanks_s2 (the MBT the cradles are
  sized for) masses 1000; 1200 was one squad's margin.
- Added `isfireplatform = true` (§7.9: fire platform, not gunship;
  `canattack=false` kept), `cantbetransported = true`,
  `transportbyenemy = false`.
- KEPT `transportcapacity=4, transportsize=3`: exactly implements §7.7's
  "capacity-2 Pelican = two s1 squads or one s2" in engine units, and caps
  items at 2 = the two link empties. (The model-header's "two MBTs" reading
  loses to the plan.)

### transports.lua (ms_landing_ship)
- `maxdamage` 1800 → **2600** — above a patrol-boat squad member (ships s1
  2500/4), well below the destroyer (7500): killable HVT, not a warship.
- `transportcapacity` 4 → **8**, `transportsize` 3 → **4** — a vehicle well
  deck that cannot take an s3 tank (footprint 4) is a rowboat; old 4/3 fit
  only two s1 squads. New fit: four s1, or two s3 tanks, or one s3 + two s1,
  or two s2 + one s1 — max 4 items, matching the four `link*` empties.
- `transportmass` 2400 → **4200** (two ms_tanks_s3 = 2×2000).
- Added `isfireplatform = true` (§7.9: beach fire-support hull),
  `cantbetransported = true`, `transportbyenemy = false`.

### fable_carrier.lua (FCV-8 Bastion)
- Added `cantbetransported = true`, `transportbyenemy = false`.
- Deliberately **no `isairbase`** and **no `is_transport`/`canload`**, with a
  def comment: native isairbase needs a unit-script QueryLandingPad and
  Metalstorm is script-less (PLAN-bulk-spawn-crash §2); pad service stays the
  game-Lua `pad_count`/`pad_pieces` pattern the header specifies. It operates
  aircraft, it does not swallow cargo, so §3.6's is_transport (lift-carrier
  HVT key) does not apply. Ballparks left as-is: 26000 hp / speed 42 e/s is
  sane s4-flagship territory (ZK Reef ~20k+); weapons MS_FLAK_S2 +
  MS_MISSILE_AA_S2 both exist in weapons.lua.

## Cross-checks on other agents' files (read-only, no edits)

- `civvehicles.lua` ms_civbus and `fable_train.lua` troop/cargo cars already
  carry `is_transport='1'` (another agent's pass) — §7.9's "all six carrier
  defs" is now satisfied minus nothing I can see.
- Cargo fit vs my transports: s1 (fp 2) and s2 (fp 3) fit the airship; s3
  (fp 4) fits only the landing ship; **no transport can lift s4 (fp 5)**.

## Proposals (not applied — other owners' files)

1. **_builder.lua (builder owner): `transportbyenemy = false` on every
   generated def.** Cargo-side key; without it an enemy Pelican/landing ship
   can abduct friendly squads. Snippet, in the def table next to `canfly`:
   `transportbyenemy = false,`
   Also `cantbetransported = true` whenever `spec.canmove == false` —
   the engine will otherwise let a transport pick up a bunker.
2. **s4 extraction gap (design flag for the coordinator):** §3.4 makes
   withdrawal the only exit and §7.7 wants heavy hard to extract, but s4
   (footprint 5) is *impossible* to extract with every current carrier
   (train troop car size 1, cargo car 2, bus 1, Pelican 3, landing ship 4).
   Either bless "s4 never withdraws" in the plan or a future heavy-lift
   (train flatcar `transportsize=5` is the cheapest candidate).
3. **fable_train.lua (train owner):** troop car `transportsize=1` /
   cargo car `2` are below the footprints of their stated cargo (squads fp 2,
   light vehicles fp 2–3). The train gadget attaches via `GG.Train`/
   Spring.UnitAttach so the CTransportCAI gate may never run, but any future
   stock LOAD order at those defs will refuse. Suggest troop car
   `transportsize=2`, cargo car `3`.
4. **Comparator discrepancy for T8:** §7.9 names "a single
   ms_staticdefense_s2 flak drum", but staticdefense s2 mounts **MS_FLAK_S1**
   (80 dps → 15 s vs my 1200 hp); MS_FLAK_S2 (120 dps → 10 s) only appears on
   s3/s4. Either reading is inside/near the 8–12 s target band; verify live
   in T8 and trim `maxdamage` (1000 would give 12.5 s vs FLAK_S1) if the
   s2-battery reading is the binding one.
5. **Airship roster promotion (plan T3)** left undone on purpose:
   `ms_class='fable_showcase'` keeps it out of `_builder`'s roster; promotion
   is a lane task (real ms_class + scenario naming), not a numbers review.
6. **Sea lane still unverified:** plan T7 (navigable-water audit) never ran;
   the landing ship's numbers are ready but whether any shipped map floats a
   route is open (§7.11).
