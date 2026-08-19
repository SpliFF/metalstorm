# Unit properties review — shared brief

You are one of 10 agents reviewing Metalstorm unit definitions for sane ballpark
values. The 3D models are being worked on elsewhere — DO NOT touch models,
textures, or objectname overrides. Your subject is the *numbers and behaviour*:
health, speed, turn/accel, sight/radar/sonar intel, weapons assignment, movedefs,
transport behaviour, sounds, animation hooks, footprints, categories.

## Ground rules (read carefully)

- WORKTREE: `/Users/shannon/WarriorHut/Projects/springrts-web-unitprops`.
  Game root: `<WT>/data/games/metalstorm`. Edit ONLY here, and ONLY the files
  assigned to you in your prompt. Other agents share this worktree in parallel.
- **NO git commands of any kind.** Leave your edits uncommitted in the working
  tree. The coordinator commits.
- **Do NOT edit** `units/_builder.lua`, `weapons/weapons.lua`, or `gamedata/*`
  unless your prompt explicitly assigns them to you (one agent owns those).
  If you want a new/changed weapon def, a new move class, a builder-curve
  change, or a new sound key: write it as a concrete PROPOSAL (exact lua
  snippet) in your notes file — do not edit the shared file.
- Notes file: write a summary of what you changed + all proposals to
  `<WT>/.unitprops/agent-<yourname>.md`. This file is yours alone.
- Keep files valid Lua. After editing, syntax-check each file you touched:
  `luac -p <file> 2>&1 || lua -e "loadfile('<file>')"` (VFS.Include isn't
  available standalone — a parse check is enough).

## The 4-scale system

Every class ships 4 scales via `units/_builder.lua` (read it first):
s1 light/swarm (big squad) → s4 super-heavy (squad_size 1). The SQUAD is the
sim atom: `maxdamage` is AGGREGATE squad HP, `squad_size` is a client fan-out
hint. Rough BA/BAR/ZK equivalence for ballparking:
  s1 ≈ T1 cheap raider/scout tier
  s2 ≈ T1 line / early T2
  s3 ≈ T2 heavy
  s4 ≈ T3 / experimental / flagship
Per-scale values go in `scales = { [s] = { ... } }`; free-form unitdef keys go
in `scales[s].override = { ... }`. Prefer per-scale overrides over changing
class-wide bases when only some scales are off.

## Reference games (read-only, in the MAIN checkout — do not edit)

- BAR unitdefs: `/Users/shannon/WarriorHut/Projects/springrts-web/content/games/bar/units/`
  (grouped ArmVehicles/CorAircraft/etc.)
- Zero-K unitdefs: `/Users/shannon/WarriorHut/Projects/springrts-web/content/games/zk/units/`
Compare per-member values: a Metalstorm squad's per-member HP ≈ maxdamage / squad_size.
Units: maxvelocity is elmos/frame (×30 = elmos/s). BAR's `speed` key is elmos/s.
Typical anchors: BAR T1 MBT ~ speed 62–75 e/s, hp 2500–3000; T1 scout car ~ speed 100+,
hp ~600; T2 heavy tank ~ speed 45–55, hp 6000–9000; strategic bomber speed ~230 e/s.

## Design docs (main checkout)

PLAN-metalstorm.md §5 (scales) and §6 (weapons); PLAN-metalstorm-transports.md
for transport behaviour. NOTE: `PLAN-*.md` files may fail with the Read tool —
page them with `awk 'NR>=A && NR<=B' file` from Bash instead.
Key constraints from the design:
- Battles are FIELD ENGINEERING only: no base-building economy in-battle.
  There are no metal/energy costs on defs — `authority_cost_base` (customparam)
  is the order-cost knob; keep it monotone in scale/power.
- Immobile units (canmove=false) MUST have maxvelocity 0 (engine SIGSEGV otherwise).
- movementclass names come from `gamedata/moveinfo.tdf` (INFANTRY, VEH, HEAVY,
  HOVER, SHIP, SUB — check the file). Aircraft have no movementclass and set canfly.
- Weapon defs live in `weapons/weapons.lua`, families × scales (MS_MG_S1,
  MS_AC_S3, ...). Check a weapon exists before referencing it; if the right one
  doesn't exist, propose it in notes and reference it anyway ONLY if your notes
  clearly flag the dependency.

## What "review" means per unit/scale

1. HP/mass/speed/turn/accel/sight in the right ballpark for type+tier (vs BA/ZK).
   The builder's generic growth curve (×2 per scale) is a stub — override where
   it produces nonsense (e.g. super-heavies with scout turn rates, transports
   with warship HP).
2. Weapons: right family + scale for the role; loadout count sane; AA units get
   AA-capable weapons; note `onlytargetcategory`/`badtargetcategory` gaps.
3. Intel: sightdistance sane; radar/sonar/jammer (radardistance etc.) where the
   role demands (radar.lua, recon, command, ships).
4. Transport behaviour: `transportcapacity`, `transportsize`, `transportmass`,
   `cantbetransported`, `transportbyenemy=false`; loadable units need sane
   `transportsize`-vs-capacity fit (a transport should carry its intended cargo).
5. Sounds: `gamedata/sounds.lua` + `sounds/` hold the available assets
   (weapon sounds exist; unit sounds are nearly empty — note gaps rather than
   referencing missing files).
6. Animations: there is no `scripts/` dir; animation is model-piece driven
   client-side. Note (don't fix) any unit whose def implies animation the
   pipeline can't do. Multi-turret s4 units use the "cosmetic sub-parts" pattern.
7. Category strings: consistent tokens (LAND/AIR/SEA/SUB, MOBILE/STATIC, plus
   type tokens) — flag inconsistencies in notes; fix obvious typos.

Comment non-obvious choices briefly in the lua (match existing comment style —
the files are heavily commented with rationale).
