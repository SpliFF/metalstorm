# Unit Scripts

Per-unit-type Lua scripts that drive animation, piece transforms, and
weapon firing behaviour. They run on the **synced** simulation thread
in `spring-server`, despite looking mostly like animation code.

This document covers what unit scripts are, the callins the engine
invokes, the primitives a script body uses, how they interact with the
projectile launch pipeline, and the architectural quirks specific to
this headless-server fork.

---

## Table of Contents

- [TL;DR](#tldr)
- [What a Unit Script Is](#what-a-unit-script-is)
- [Where They Run](#where-they-run)
- [Lifecycle](#lifecycle)
  - [Discovery and Preload](#discovery-and-preload)
  - [Per-Unit Instantiation](#per-unit-instantiation)
  - [COB vs Lua](#cob-vs-lua)
- [Callin Reference](#callin-reference)
  - [Lifecycle Callins](#lifecycle-callins)
  - [Movement Callins](#movement-callins)
  - [Transport Callins](#transport-callins)
  - [Build Callins](#build-callins)
  - [Weapon Callins](#weapon-callins)
  - [Animation-Completion Callins](#animation-completion-callins)
- [Script Primitives](#script-primitives)
  - [Animation Primitives](#animation-primitives)
  - [Piece Inspection](#piece-inspection)
  - [Special Effects](#special-effects)
  - [Coroutine Helpers](#coroutine-helpers)
- [Piece Transforms and the Firing Pipeline](#piece-transforms-and-the-firing-pipeline)
- [Headless-Server Specifics](#headless-server-specifics)
- [Cold-Start Cost](#cold-start-cost)
- [Worked Example: `turretimpulse.lua`](#worked-example-turretimpulselua)
- [Synced / Unsynced / Engine / Game Summary](#synced--unsynced--engine--game-summary)
- [Future Work](#future-work)
- [Source References](#source-references)

---

## TL;DR

| Question                  | Answer                                                                                                                                                                         |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Synced or unsynced?       | **Synced.** Runs in the synced Lua handle on the sim thread.                                                                                                                   |
| Engine or game?           | **Engine-hosted, game-provided.** The Lua VM and C++ glue live in the engine; the script files ship with the game.                                                             |
| Gameplay or visuals?      | **Both, intertwined.** Most of the code is animation, but the resulting piece transforms feed weapon emit positions, aim rays, and target priority — so animation IS gameplay. |
| Runs on client?           | **No.** The client receives piece transforms over the wire and applies them to the rendered mesh. The script itself never executes browser-side.                               |
| Per-instance or per-type? | One Lua chunk per unit _type_, with one instance state per _unit_ (kept in the script's Lua tables, keyed by unitID).                                                          |

---

## What a Unit Script Is

A unit script is a Lua source file under `data/games/<gameId>/scripts/`
(for example, `data/games/zk/scripts/turretimpulse.lua`). The game's
`UnitDef.scriptName` field names which file to use for a given unit
type; the engine loads it the first time a unit of that type appears.

The script defines a set of **callins** — functions the engine invokes
at fixed points in the unit's lifecycle. Inside those callins the
script:

1. Moves, turns, or spins the unit's model **pieces** to play
   animations (walk cycles, turret rotation, muzzle recoil).
2. Returns piece IDs that tell the engine where to spawn projectiles,
   where to dock transported units, where build-nano effects emit
   from, and so on.
3. Returns booleans that gate firing (`AimWeapon`, `BlockShot`) or
   bias target selection (`TargetWeight`).
4. Plays sound/explosion FX at specific pieces (`EmitSfx`, `Explode`).

The same Lua chunk handles all instances of one unit type. Per-unit
state lives in script tables keyed by `unitID`.

---

## Where They Run

Server-side, on the sim thread, inside the **synced Lua handle**.

[`rts/Sim/Units/Scripts/LuaUnitScript.cpp`](../rts/Sim/Units/Scripts/LuaUnitScript.cpp)
includes [`Lua/LuaHandleSynced.h`](../rts/Lua/LuaHandleSynced.h) and
registers all of its callouts (`Move`, `Turn`, `Spin`, `EmitSfx`, etc.)
into the synced VM. Each `CUnit` instance owns a `CUnitScript*`
([`rts/Sim/Units/Unit.h`](../rts/Sim/Units/Unit.h)) that the engine
calls from sim-tick code paths in
[`rts/Sim/Weapons/Weapon.cpp`](../rts/Sim/Weapons/Weapon.cpp),
[`rts/Sim/Units/Unit.cpp`](../rts/Sim/Units/Unit.cpp), and the
projectile system.

Because they're synced, unit scripts have access to the full synced
API (`Spring.SetUnitRulesParam`, `Spring.GiveOrderToUnit`,
`Spring.SetUnitHealth`, etc.) and can mutate sim state. They are not
sandboxed away from gameplay; the engine relies on their return values
to drive hard sim decisions.

The browser client never runs unit scripts. It receives streamed piece
transforms as part of entity state (see
[`docs/client-events.md`](client-events.md) and the entity-renderer's
`pieceOverrides` handling) and applies them to the rendered mesh.

---

## Lifecycle

### Discovery and Preload

Unit scripts are loaded by a LuaRules gadget, not by the engine
directly. In ZK this is
[`data/games/zk/LuaRules/Gadgets/unit_script.lua`](../data/games/zk/LuaRules/Gadgets/unit_script.lua),
which:

1. Scans `scripts/*.lua` files in the game VFS.
2. Iterates every entry in the `UnitDefs` global.
3. For each def, resolves `unitDef.scriptName` (or its `.cob → .lua`
   fallback) to a file path.
4. Calls `Spring.UnitScript.CreateScript(unitDefID, callinTable)` to
   bind the script to that unit type, then issues fake `UnitCreated`
   events for any units that already exist (so `/luarules reload`
   works mid-game).

This is the **eager preload** path responsible for the long
`Loading unit script: scripts/<name>.lua` chain visible during ZK
game-start. In a fresh ZK launch the gadget loads ~188 scripts before
the first sim frame ticks. See [Cold-Start Cost](#cold-start-cost).

### Per-Unit Instantiation

When a `CUnit` is constructed, the engine calls
[`CUnitScriptFactory::CreateScript(unit, unitDef)`](../rts/Sim/Units/Scripts/UnitScriptFactory.cpp):

- If a Lua script was registered for this `unitDefID` via the call
  above, instantiate a `CLuaUnitScript` ([`rts/Sim/Units/Scripts/LuaUnitScript.cpp:1084`](../rts/Sim/Units/Scripts/LuaUnitScript.cpp#L1084)).
- Otherwise attempt to load the unit's `.cob` file (legacy bytecode).
- If neither exists, fall back to `CNullUnitScript` — a singleton
  whose callins all return no-op defaults.

The script's `Create()` callin runs immediately on construction.
Subsequent callins fire as the unit's state changes throughout its
life.

### COB vs Lua

This codebase keeps both runtimes:

- **COB** (`rts/Sim/Units/Scripts/Cob*.cpp`) — Spring's original
  bespoke bytecode format. A unit's `.cob` file is parsed once into a
  shared `CCobFile`; each instance gets a `CCobInstance` with its own
  thread state. Effectively unused by modern games but still load-bearing
  for the few units in older content that ship `.cob` files only.
- **Lua** (`rts/Sim/Units/Scripts/LuaUnitScript.cpp`) — the modern
  path. ZK, Beyond All Reason, and every game written this decade use
  Lua scripts exclusively.

The two are interchangeable from the engine's point of view —
`CUnitScript` is a virtual base class and both `CCobInstance` and
`CLuaUnitScript` derive from it. The callin set is identical.

---

## Callin Reference

The canonical list is the `LUAFN_*` enum in
[`rts/Sim/Units/Scripts/LuaScriptNames.h`](../rts/Sim/Units/Scripts/LuaScriptNames.h)
with name strings in
[`rts/Sim/Units/Scripts/LuaScriptNames.cpp`](../rts/Sim/Units/Scripts/LuaScriptNames.cpp).
A script implements any subset it cares about; missing callins are
no-ops. The `HasFunction(LUAFN_X)` test on the engine side skips the
Lua-call overhead when a callin is absent.

### Lifecycle Callins

| Callin                                                 | Args    | Returns                             | Triggered by                                                                                                                                                                         |
| ------------------------------------------------------ | ------- | ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `Create()`                                             | —       | nil                                 | unit construction (called from `CLuaUnitScript` ctor)                                                                                                                                |
| `Destroy()`                                            | —       | nil                                 | unit destruction (before script teardown)                                                                                                                                            |
| `Killed(recentDamage, maxHealth)`                      | numbers | `delayedWreckLevel` (number) or nil | unit health hits 0; **return value gates death-anim duration** — engine delays wreck spawn until the script signals completion via `Spring.UnitScript.SetDeathScriptFinished(level)` |
| `HitByWeapon(hitDir_x, hitDir_z, weaponDefID, damage)` | numbers | optional `newDamage` (number)       | weapon impact on this unit; return value can **mutate the damage applied** before armour calculations                                                                                |

### Movement Callins

| Callin                           | Args    | Returns | Triggered by                                                              |
| -------------------------------- | ------- | ------- | ------------------------------------------------------------------------- |
| `StartMoving(reversing)`         | bool    | nil     | `CMobility` transitions from idle to moving                               |
| `StopMoving()`                   | —       | nil     | `CMobility` transitions back to idle                                      |
| `StartSkidding(vx, vy, vz)`      | numbers | nil     | physics throws the unit into a skid (collision, ground push)              |
| `StopSkidding()`                 | —       | nil     | skid velocity drops below threshold                                       |
| `ChangeHeading(deltaHeading)`    | number  | nil     | unit's heading slewed by `delta`                                          |
| `MoveRate(curMoveRate)`          | number  | nil     | walk-cycle speed selector — typically swaps between walk/run animations   |
| `Activate()` / `Deactivate()`    | —       | nil     | unit's active state toggles (factories opening, radars spinning up, etc.) |
| `WindChanged(heading, strength)` | numbers | nil     | wind generators rotate to face the wind                                   |
| `ExtractionRateChanged(newRate)` | number  | nil     | metal extractors update visible spinner speed                             |
| `RockUnit(rockDir_x, rockDir_z)` | numbers | nil     | recoil/flinch from being shot                                             |
| `Falling()` / `Landed()`         | —       | nil     | aircraft / dropped-unit ground transitions                                |
| `setSFXoccupy(curTerrainType)`   | number  | nil     | special-FX occupancy slot (water spray on amphibs, dust on land vehicles) |

### Transport Callins

| Callin                                | Args            | Returns         | Triggered by                                                                           |
| ------------------------------------- | --------------- | --------------- | -------------------------------------------------------------------------------------- |
| `BeginTransport(passengerID)`         | unitID          | nil             | transport begins pickup approach                                                       |
| `QueryTransport(passengerID)`         | unitID          | piece (number)  | **returns the docking piece** for this passenger                                       |
| `TransportPickup(passengerID)`        | unitID          | nil             | passenger attached                                                                     |
| `StartUnload()`                       | —               | nil             | unload sequence begins                                                                 |
| `EndTransport()`                      | —               | nil             | unload completes                                                                       |
| `TransportDrop(passengerID, x, y, z)` | unitID + floats | nil             | passenger detaches at world position                                                   |
| `QueryLandingPads()`                  | —               | table of pieces | **returns landing-pad pieces** the air-traffic-control gadget can dispatch aircraft to |

### Build Callins

| Callin                                                                          | Args        | Returns        | Triggered by                                                        |
| ------------------------------------------------------------------------------- | ----------- | -------------- | ------------------------------------------------------------------- |
| `StartBuilding(h_heading, p_pitch)` _(BUILDER)_ / `StartBuilding()` _(FACTORY)_ | numbers / — | nil            | construction begins                                                 |
| `StopBuilding()`                                                                | —           | nil            | construction ends or pauses                                         |
| `QueryNanoPiece()`                                                              | —           | piece (number) | **returns the piece nano-beams emit from** for build/repair effects |
| `QueryBuildInfo()`                                                              | —           | piece (number) | **returns the piece a factory-built unit appears at**               |

### Weapon Callins

These are the heavy-hitting gameplay-affecting callins.

| Callin                                                 | Args              | Returns                                                                                                        | Triggered by                                                                                                                                               |
| ------------------------------------------------------ | ----------------- | -------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `QueryWeapon(weaponNum)`                               | int               | piece (number)                                                                                                 | engine asks **where projectiles spawn from**; result feeds `CWeapon::muzzlePiece` ([`rts/Sim/Weapons/Weapon.cpp:243`](../rts/Sim/Weapons/Weapon.cpp#L243)) |
| `AimFromWeapon(weaponNum)`                             | int               | piece (number)                                                                                                 | engine asks **where the aim ray starts**; result feeds `CWeapon::aimFromPiece` ([`rts/Sim/Weapons/Weapon.cpp:246`](../rts/Sim/Weapons/Weapon.cpp#L246))    |
| `AimWeapon(weaponNum, heading - owner heading, pitch)` | int, two numbers  | nil (signals completion via `Spring.UnitScript.SetSignalMask` or returns `true` directly in the COB-style API) | engine asks **"is the weapon aimed yet?"**; script returns/yields when aim is good. Until then **firing is blocked**.                                      |
| `AimShield(weaponNum)`                                 | int               | nil                                                                                                            | shield emitters orient defensively                                                                                                                         |
| `FireWeapon(weaponNum)`                                | int               | nil                                                                                                            | fires recoil animation immediately after the projectile leaves                                                                                             |
| `EndBurst(weaponNum)`                                  | int               | nil                                                                                                            | end of a burst-fire sequence                                                                                                                               |
| `Shot(weaponNum)`                                      | int               | nil                                                                                                            | fired for every shot in a burst (FireWeapon fires once per burst-trigger)                                                                                  |
| `BlockShot(weaponNum, targetUnitID, haveUserTarget)`   | int, unitID, bool | bool                                                                                                           | **return true to veto the shot** even when aim is good (used for friendly-fire avoidance, ammo gating)                                                     |
| `TargetWeight(weaponNum, targetUnitID)`                | int, unitID       | number                                                                                                         | **bias on target priority** (>1 prefers, <1 deprioritises)                                                                                                 |

### Animation-Completion Callins

When a script calls `WaitForMove(piece, axis)` or `WaitForTurn(piece,
axis)`, the engine wakes the coroutine via these callins. They are
also routable to user-defined handlers via `Spring.UnitScript.SetSignalMask`.

| Callin                      | Args | Returns |
| --------------------------- | ---- | ------- |
| `MoveFinished(piece, axis)` | ints | nil     |
| `TurnFinished(piece, axis)` | ints | nil     |
| `ScaleFinished(piece)`      | int  | nil     |

---

## Script Primitives

The functions a unit-script body calls are registered into the synced
VM by
[`CLuaUnitScript::PushEntries`](../rts/Sim/Units/Scripts/LuaUnitScript.cpp#L967).
They sit in the global `Spring.UnitScript` namespace, but most scripts
import the common ones into local aliases at the top of the file.

### Animation Primitives

| Function                                                                    | Signature                                          | Effect                                                                                            |
| --------------------------------------------------------------------------- | -------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| `Move(piece, axis, dest, speed)`                                            | (int, int, number, number?)                        | translate the piece along `axis` toward `dest`; if `speed` is given, animate over time, else snap |
| `Turn(piece, axis, angle, speed)`                                           | (int, int, number, number?)                        | rotate the piece around `axis` to `angle` (radians); animated when `speed` given                  |
| `Spin(piece, axis, speed, accel)`                                           | (int, int, number, number?)                        | continuous spin; `accel` ramps the spin rate up                                                   |
| `StopSpin(piece, axis, decel)`                                              | (int, int, number?)                                | stop a continuous spin                                                                            |
| `SetPieceVisibility(piece, visible)`                                        | (int, bool)                                        | hide/show piece (and its descendants in render output)                                            |
| `IsInMove(piece, axis)` / `IsInTurn(piece, axis)` / `IsInSpin(piece, axis)` | bools                                              | poll animation state                                                                              |
| `WaitForMove(piece, axis)` / `WaitForTurn(piece, axis)`                     | yields the coroutine until the animation completes |

`axis` is `x_axis`, `y_axis`, or `z_axis` (1, 2, 3 in Spring's
convention). Most scripts define these as locals at the top of the
file.

### Piece Inspection

| Function                     | Returns        | Notes                                                                                      |
| ---------------------------- | -------------- | ------------------------------------------------------------------------------------------ |
| `GetPieceTranslation(piece)` | float3         | current animated translation relative to parent                                            |
| `GetPieceRotation(piece)`    | float3 (Euler) | current animated rotation                                                                  |
| `GetPiecePosDir(piece)`      | (pos, dir)     | piece world position and forward axis — used to query where a muzzle is currently pointing |

The C++ side reads from these same matrices via `LocalModelPiece`
([`rts/Sim/Units/Scripts/LocalModelPieceStub.h`](../rts/Sim/Units/Scripts/LocalModelPieceStub.h))
to compute projectile spawn vectors. See
[Piece Transforms and the Firing Pipeline](#piece-transforms-and-the-firing-pipeline).

### Special Effects

| Function                                                       | Signature             | Effect                                                                                                                |
| -------------------------------------------------------------- | --------------------- | --------------------------------------------------------------------------------------------------------------------- |
| `EmitSfx(piece, sfxID)`                                        | (int, int)            | emit a Custom Explosion Generator (CEG) effect at the piece — used for muzzle flashes, exhaust trails, build sparkles |
| `Explode(piece, flags)`                                        | (int, int)            | detach piece on death and apply explosion physics (`SHATTER`, `EXPLODE_ON_HIT`, etc.)                                 |
| `ShowFlare(piece)`                                             | int                   | trigger a weapon-flare effect at the piece                                                                            |
| `AttachUnit(piece, transporteeID)` / `DropUnit(transporteeID)` | transport pickup/drop |
| `SetDeathScriptFinished(wreckLevel)`                           | int                   | signal end-of-death-animation; engine spawns the wreck and removes the unit                                           |

### Coroutine Helpers

Unit scripts are coroutine-heavy. The engine runs animation loops as
Lua coroutines (one per active animation thread per unit), which is
why ZK's `armcom.lua` defines named signals (`SIG_WALK`, `SIG_LASER`,
`SIG_DGUN`) — they're masks into the coroutine signal table.

| Function                                          | Effect                                                                                            |
| ------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| `Spring.UnitScript.StartThread(func, ...)`        | spawn a new coroutine                                                                             |
| `Spring.UnitScript.SetSignalMask(mask)`           | tag the current coroutine; subsequent `Signal(mask)` calls kill matching threads                  |
| `Spring.UnitScript.Signal(mask)`                  | kill all threads with overlapping signal masks                                                    |
| `Spring.UnitScript.Sleep(ms)`                     | yield the current thread for `ms` milliseconds                                                    |
| `Spring.UnitScript.CallAsUnit(unitID, func, ...)` | run a function with `activeScript` bound to a different unit's script (used by transport gadgets) |

---

## Piece Transforms and the Firing Pipeline

The headline insight: **animation IS gameplay** in Spring, because the
piece transforms a script computes are exactly what the weapon system
reads to spawn projectiles.

The pipeline, per shot:

1. Sim tick advances any in-flight `Move`/`Turn`/`Spin` animations →
   updates `LocalModelPiece::pos` and `rot`.
2. `CWeapon::UpdateWeaponPieces` calls `script->QueryWeapon(n)` and
   `script->AimFromWeapon(n)` once per weapon (cached for the unit's
   lifetime) — getting the muzzle and aim-origin piece IDs.
3. `CWeapon::UpdateWeaponVectors` calls
   `script->GetEmitDirPos(muzzlePiece, &relPos, &dir)`
   ([`rts/Sim/Weapons/Weapon.cpp:289`](../rts/Sim/Weapons/Weapon.cpp#L289)).
   `GetEmitDirPos` walks the piece's parent chain
   ([`LocalModelPieceStub.h:135-144`](../rts/Sim/Units/Scripts/LocalModelPieceStub.h#L135-L144))
   to compute the world-space transform, then derives the launch
   vector as `(matrix * float3(0,0,-1)) - origin` — local `-Z` is the
   glTF-native forward axis under this codebase's RH coordinate
   convention.
4. Engine fires `script->AimWeapon(n, heading, pitch)`; the script's
   coroutine `Turn`s the turret toward the target, `WaitForTurn`s
   until aimed, and signals completion. **The weapon cannot fire
   until this returns.**
5. When `BlockShot` returns false (no veto), `TargetWeight` resolves
   the target choice, the projectile spawns at `relPos` with direction
   `dir`, and `FireWeapon(n)` runs to play recoil.

So if a script's `Turn(turret, y_axis, target_heading, TURN_SPEED)`
coroutine is mid-animation when the engine computes the emit vector,
the projectile spawns at the partial-rotation muzzle position. The
animation directly determines where the shell appears in the world.

---

## Headless-Server Specifics

This codebase strips the renderer from the sim. There's no full
`S3DModel` with vertex buffers — only the minimal stubs in
[`rts/Sim/Units/Scripts/LocalModelPieceStub.h`](../rts/Sim/Units/Scripts/LocalModelPieceStub.h)
that carry just the data the sim reads: piece tree, names, offsets,
collision bounds.

Piece transforms are populated from the `SPRINGRTS_geometry`
extension that `tools/modelimporter` embeds in every `<model>.gltf`
during content preprocessing — same source-of-truth as the client's
mesh data, just stripped to what the sim needs.

The classic failure mode (see memory note
`project_zk_combat_blocker.md`):
[`LocalModelPiece::GetModelSpaceMatrix()`](../rts/Sim/Units/Scripts/LocalModelPieceStub.h#L114)
must walk the parent chain to compose the piece's world transform.
An earlier stub that returned just `CMatrix44f()` (identity) left
every piece at the unit origin, so weapons fired straight up from the
unit centre instead of from the barrel tip. The current stub composes
`T(pos) * R_yxz(rot.x, rot.y, -rot.z)` per level and recurses into
the parent — necessary for `QueryWeapon` + `GetEmitDirPos` to return
correct vectors.

There's also a defensive fallback in
[`rts/Sim/Projectiles/WeaponProjectiles/WeaponProjectile.cpp:155-175`](../rts/Sim/Projectiles/WeaponProjectiles/WeaponProjectile.cpp#L155-L175):
if a hit-scan beam computes `evTargetPos - evPos < 1.0`, fall back to
unit-centre coordinates rather than emitting a zero-length beam. This
protects the client renderer when a gadget skips piece-transform
updates entirely. The fix is to make the script's animations run, not
to extend the fallback.

---

## Cold-Start Cost

ZK's `unit_script.lua` gadget loads every script eagerly during game
start. In the current build this fills the log ring with ~188
`Loading unit script: scripts/<name>.lua` NOTICE lines and parses
each file before the first sim frame.

Per-script work:

- `VFS.LoadFile(filename)` → IO + lex/parse via the synced Lua VM
- `loadstring(source)()` → executes the file's top-level code
- Gadget wraps the returned callin table and binds it via
  `Spring.UnitScript.CreateScript(unitDefID, callins)`

Wall-clock cost on a warm machine is in the low hundreds of ms per
ZK launch, but it's sequential and runs before the sim tick begins,
which is why `get_game_state` times out from the test harness mid-load.

Mitigations to consider (not done today):

- **Lazy load per type at first spawn.** Nothing in the script
  semantics requires preloading — `Spring.UnitScript.CreateScript`
  can be called from a `gadget:UnitCreated` handler the first time a
  given `unitDefID` appears. Pushes the cost out of the critical path
  and amortises it over the first few minutes of play.
- **Precompile to bytecode at game-import time.** `string.dump` of a
  loaded chunk is safe to round-trip _within the same Lua build_. The
  server runs Lua 5.4 throughout, so bytecode caching works fine for
  the synced VM. Saves the parser work but not the file IO or the
  binding step. See [`docs/unit_scripts.md`](unit_scripts.md) (this
  file) and the bake discussion in
  [`AGENTS.md`](../AGENTS.md) §"Resolved Design Decisions" for the
  same idea applied to def caches.
- **Skip scripts for types that won't appear in this game.** ZK loads
  scripts for every `UnitDefs[i]` regardless of whether the room's
  modOptions, factory restrictions, or AI build-orders will ever
  instantiate that type. A static analyser could prune unreachable
  types, but lazy-load is the simpler win.

---

## Worked Example: `turretimpulse.lua`

ZK's impulse-tower script
([`data/games/zk/scripts/turretimpulse.lua`](../data/games/zk/scripts/turretimpulse.lua))
is a compact, representative example. Reading it top to bottom:

```lua
include "constants.lua"
local WOBBLE_DIST = 2
local WOBBLE_SPEED = 2
local TURRET_AIM_SPEED = math.rad(300)
```

Imports shared constants (axis IDs, common animation speeds) and
declares per-type animation tuning.

```lua
local gp = piece('gp')
local base = piece('base')
local turret = piece('turret')
local ring = piece('ring')
local center = piece('center')
local firepoint = piece('firepoint')
local crystals = {piece('crystal1', 'crystal2', 'crystal3', 'crystal4')}
```

Resolves piece names (from the model's piece tree) to integer IDs
once at load time.

```lua
local function WobbleTurret()
    while true do
        Move(turret, y_axis, WOBBLE_DIST, WOBBLE_SPEED)
        WaitForMove(turret, y_axis)
        Move(turret, y_axis, -WOBBLE_DIST, WOBBLE_SPEED)
        WaitForMove(turret, y_axis)
    end
end
```

An idle-animation coroutine. Bobs the turret up and down forever
until killed by a signal mask.

The callin table (later in the file, conventionally returned at
end-of-script) wires `AimWeapon`, `FireWeapon`, `QueryWeapon`,
`AimFromWeapon`, `Create`, `Killed` etc. to local functions:

```lua
function script.AimWeapon(weaponNum, heading, pitch)
    Signal(SIG_AIM)
    SetSignalMask(SIG_AIM)
    Turn(turret, y_axis, heading, TURRET_AIM_SPEED)
    Turn(center, x_axis, -pitch, TURRET_AIM_SPEED)
    WaitForTurn(turret, y_axis)
    WaitForTurn(center, x_axis)
    return true  -- "aim is good, you may fire"
end

function script.QueryWeapon(weaponNum) return firepoint end
function script.AimFromWeapon(weaponNum) return firepoint end

function script.FireWeapon(weaponNum)
    EmitSfx(firepoint, 1024 + 0)  -- muzzle flash CEG
end
```

The crucial line is `return true` from `AimWeapon` — that's the
signal to the engine that the turret has finished tracking and the
weapon may fire this tick. Without it, `CWeapon::CanFire` rejects the
firing attempt and the shot is deferred until next aim cycle.

`QueryWeapon` and `AimFromWeapon` returning `firepoint` mean
`GetEmitDirPos` will look up the firepoint piece's current world-space
transform — which the `Turn` calls above have just updated — and use
its local `-Z` axis as the shell's initial direction. So when the
turret has tracked to bearing 45°, the shell launches from the
firepoint piece at bearing 45°, regardless of the rest of the model
sitting still.

---

## Synced / Unsynced / Engine / Game Summary

| Axis                      | Answer                                                                                                                                                                                                                                                                                                                                                                                                              |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Synced or unsynced?       | **Synced.** Synced Lua handle on the sim thread. Has full synced API access.                                                                                                                                                                                                                                                                                                                                        |
| Engine or game?           | **Engine-hosted, game-provided.** Lua VM, C++ glue, and callin dispatch are in [`rts/Sim/Units/Scripts/`](../rts/Sim/Units/Scripts/); script source files ship in [`data/games/<gameId>/scripts/`](../data/games/zk/scripts/).                                                                                                                                                                                      |
| Gameplay or visual?       | **Both.** Surface looks visual (`Move`, `Turn`, `Spin`). But the resulting piece transforms drive `QueryWeapon`/`GetEmitDirPos` (projectile launch), `AimWeapon` (firing gate), `BlockShot` (firing veto), `TargetWeight` (target priority), `Killed` (death duration), and several builder/transport piece queries. Animation **is** gameplay because the piece tree is the shared data structure between the two. |
| Runs on the client?       | **No.** Client receives piece transforms in entity state. The script itself executes only on the server.                                                                                                                                                                                                                                                                                                            |
| One per unit or per type? | **One Lua chunk per unit type.** Per-instance state lives in script tables keyed by `unitID`.                                                                                                                                                                                                                                                                                                                       |
| Loaded eagerly or lazily? | **Eagerly** by the game's `unit_script.lua` gadget at game start. Could be made lazy without changing semantics.                                                                                                                                                                                                                                                                                                    |

---

## Future Work

Architectural directions worth considering:

1. **Lazy per-type load** (low effort, real wall-time win at game
   start). Replace ZK's `unit_script.lua` eager loop with on-demand
   loading from `gadget:UnitCreated`.

2. **Bytecode cache for scripts** (medium effort, modest win). Same
   pattern as the def cache: `string.dump` each script at
   game-import, write `data/games/<gameId>/cache/scripts/<sha>.luac`,
   load with `loadstring(data, "b")` at game start. Server uses
   Lua 5.4 throughout, so version skew isn't an issue here.

3. **Split synced sim from cosmetic animation** (high effort,
   contentious). Promote only the gameplay-affecting callins
   (`AimWeapon`, `QueryWeapon`, `GetEmitDirPos`, `BlockShot`,
   `TargetWeight`, `Killed`, `Query*`) to a tiny synced script; run
   body animations (idle wobbles, walk cycles, death animations) on
   the client only. This is the largest possible refactor in this
   area because most existing scripts mix both concerns within one
   coroutine — splitting them requires per-game porting work.

4. **Mirror the script body to the client for animation prediction**
   (medium effort, latency win). Ship the script source to the client
   as part of the def bundle; run the same `Move`/`Turn`/`Spin`
   primitives client-side against a local mirror of `LocalModelPiece`,
   reconciled against authoritative server piece transforms each
   tick. Smooths out interpolation gaps at the cost of running the
   animation twice. Requires the script to be deterministic and
   side-effect-free, which most are.

---

## Source References

| Topic                             | File                                                                                                                                                       |
| --------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Callin enum + name table          | [`rts/Sim/Units/Scripts/LuaScriptNames.h`](../rts/Sim/Units/Scripts/LuaScriptNames.h), [`LuaScriptNames.cpp`](../rts/Sim/Units/Scripts/LuaScriptNames.cpp) |
| Lua-side script host              | [`rts/Sim/Units/Scripts/LuaUnitScript.cpp`](../rts/Sim/Units/Scripts/LuaUnitScript.cpp), [`LuaUnitScript.h`](../rts/Sim/Units/Scripts/LuaUnitScript.h)     |
| Script factory                    | [`rts/Sim/Units/Scripts/UnitScriptFactory.cpp`](../rts/Sim/Units/Scripts/UnitScriptFactory.cpp)                                                            |
| Headless piece stubs              | [`rts/Sim/Units/Scripts/LocalModelPieceStub.h`](../rts/Sim/Units/Scripts/LocalModelPieceStub.h)                                                            |
| Null-script singleton             | [`rts/Sim/Units/Scripts/NullUnitScript.h`](../rts/Sim/Units/Scripts/NullUnitScript.h)                                                                      |
| Base script interface             | [`rts/Sim/Units/Scripts/UnitScript.h`](../rts/Sim/Units/Scripts/UnitScript.h), [`UnitScript.cpp`](../rts/Sim/Units/Scripts/UnitScript.cpp)                 |
| COB (legacy bytecode) runtime     | [`rts/Sim/Units/Scripts/Cob*.cpp`](../rts/Sim/Units/Scripts/)                                                                                              |
| Engine consumers (firing)         | [`rts/Sim/Weapons/Weapon.cpp`](../rts/Sim/Weapons/Weapon.cpp) §`UpdateWeaponPieces`, `UpdateWeaponVectors`, `CanFire`                                      |
| Game-side script loader (ZK)      | [`data/games/zk/LuaRules/Gadgets/unit_script.lua`](../data/games/zk/LuaRules/Gadgets/unit_script.lua)                                                      |
| Example unit script               | [`data/games/zk/scripts/turretimpulse.lua`](../data/games/zk/scripts/turretimpulse.lua), [`armcom.lua`](../data/games/zk/scripts/armcom.lua)               |
| Headless-fallback projectile path | [`rts/Sim/Projectiles/WeaponProjectiles/WeaponProjectile.cpp:155-175`](../rts/Sim/Projectiles/WeaponProjectiles/WeaponProjectile.cpp#L155-L175)            |
