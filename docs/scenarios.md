# Scenario files — the war template format

A **scenario** is one Lua file that declares a whole war: the staged world, the
armies, the civilian population, the AI slates, the objectives, and the one
condition that ends it. `data/games/<gameId>/scenarios/<id>.lua`.

Start with the tooling, not the format: `validate_scenario` (MCP, offline) tells
you what is wrong with a file without booting anything, and every rule id it can
emit is tabulated in [§11](#11-validation-rule-reference). The rest of this
document is what it is checking, and why.

---

## 1. What a scenario is, and who reads it

Three different consumers read the same file with three different parsers, and
the differences are the source of nearly every scenario bug:

| Consumer | How it reads the file | What a bad file does |
|---|---|---|
| **Lobby discovery** (`rts/Server/ScenarioDiscovery.cpp`) | A **bare `lua_State`** — `luaL_openlibs` and nothing else. No `VFS`, no `Spring.*`, no `GG`. Run once at lobby start over the whole directory. | **Silently absent** from the Create Game picker. One `SLOG` warning nobody reads. See [§2](#2-the-bare-parser-rule). |
| **Sim loader** (`LuaRules/Gadgets/game_scenario.lua`) | `VFS.Include` inside the synced gadget at `GameStart`, with `UnitDefs`/`FeatureDefs`/`GG.Regions` available; then `validate()`. | `error()`s the whole finding list at once — the game does not start. |
| **Generator** (`tools/mapgen/scenariogen.py`) | Emits, does not read. Its output is stored in the scenario DB and *materialised* to `scenarios/gen_*.lua`. | — |

`gen_*.lua` files are **caches, not sources**. `ScenarioDb` owns that namespace:
`SyncToDisk`'s orphan sweep deletes any `gen_*.lua` no DB row claims, and a
resync rewrites the ones it does. Never hand-edit them and never write one —
to change a generated war, regenerate it with different knobs or a different
seed (`generate_scenario`).

---

## 2. The bare-parser rule

**The file must be a pure Lua table literal.** At file scope: no `VFS`, no
`Spring.*`, no `GG`, no `require`, no reading globals the sim provides.
Comments, local functions and arithmetic are fine — anything that only needs
stock Lua is fine. What is not fine is *touching the sim*.

The failure mode is what makes this the #1 trap: the file still loads perfectly
under `?direct=` and headless (both read the VFS fresh, inside the sim, where
those globals exist). It just **vanishes from the lobby's list**, so the picker
does not offer it and `launch_scenario` cannot resolve it — while every other
launch path keeps working. That asymmetry reads as a lobby bug for a long time.

```lua
-- WRONG: loads in-game, invisible in the lobby forever
local mapSize = Spring.GetGameRulesParam('map_size')
return { version = 1, units = { { def = 'ms_tanks_s1', x = mapSize / 2 } } }
```

Check with `validate_scenario` — rule `bare-parse`, which reports the Lua error
verbatim.

---

## 3. Launching a scenario

Three paths, and **the manifest one has a trap**:

**a. Direct manifest** (`POST /api/rooms/direct`, needs `--dev-direct-start`) —
`scenario` must be **top-level**:

```jsonc
{ "map": "scorched_crossing_v2.4", "game": "metalstorm",
  "scenario": "crossing_standoff",          // ← TOP LEVEL. Required.
  "modoptions": { } }
```

A `modoptions.scenario` entry **alone is silently overwritten by the map's
default scenario**: the room applies the manifest's modoptions first, then runs
the same `applyRoomScenario`/`chooseScenario` default-resolution the Create Game
dialog uses (`rts/lobby_main.cpp`). The room's final choice comes back in the
response `modoptions`, so a mismatch is visible there — check it.

**Headless configs take the same top-level key** (`rts/Server/HeadlessRun.cpp`
folds it onto the `scenario` modoption), so one manifest boots the same war both
ways — add a `headless` block to the file above and it runs headless unchanged.
Within a headless config the top-level `scenario` **wins over** any
`modOptions.scenario` in the same file, and an explicit `--modoption scenario=`
on the command line still beats both. `"scenario": ""` means *explicitly no
scenario* everywhere, as distinct from omitting the key (map default).

**b. `launch_scenario` (MCP)** — one call from nothing to a running war; builds
the manifest for you, so the trap above is not yours to remember. See
[debugging-tools.md](debugging-tools.md).

**c. The lobby picker** — the Create Game dialog, from the discovery list.
Remember the list is a **startup snapshot**: a new or edited file is invisible
until `POST /api/admin/scenarios/resync` or a lobby restart. `write_scenario`
does that resync for you and then *confirms* the scenario is offered.

---

## 4. Schema reference

Top level (`version` is the only required key; everything else has a sane
absent-state):

| Key | Type | Read by | Notes |
|---|---|---|---|
| `version` | number | sim | Must be `1`. Anything else is a hard load error. |
| `name` | string | lobby | Display name; defaults to the file stem. |
| `tutorial` | boolean | lobby | Offered separately, never auto-selected as a map default. |
| `retired` | boolean | lobby | Loadable, but not offered in room lists. |
| `ephemeral` | boolean | lobby/db | Throwaway war (does not hibernate). Authored files normally omit it. |
| `briefing` | table | lobby/client | Splash content: `{title, subtitle, story, tips[], image, parTimeSec}`. See [§4.8](#48-briefing). |
| `world` | table | sim | `{ map, regions[], features[] }`. |
| `sides` | array | lobby | Room slots. See [§7](#7-teams-sides-and-the-gaia-landmines). |
| `units` | array | sim | The staged armies and set dressing. |
| `civilians` | table | sim | `{ units[] }` — ambient population. |
| `towns` | array | sim | Named settlements. |
| `objectives` | array | sim | Including the one terminal objective. |
| `ai` | array | sim | Per-team AI profile, slate and stipend. |
| `orders` | array | — | **Reserved and ignored** (warns). Use per-unit `orders`. |
| `convoys` | — | — | Not wired at the scenario level; convoy routes come from `mapdata/civilians.lua`. |

### 4.1 `world`

```lua
world = {
  map = 'scorched_crossing_v2.4',   -- the map this war is authored for
  regions = {                       -- pre-set ownership / naming
    { key = 'amber_row', team = 0 },
    { x = 4480, z = 4480, name = 'Raven Basin' },
  },
  features = { … },                 -- see 4.5
}
```

Each `regions[]` entry needs **either** `key` **or** both `x` and `z`
([§5](#5-region-keys)). `team` may be a number, or `'contested'`/`'neutral'`
for uncontrolled. Note `team = nil` on an entry that also has no `name` **clears
the region to uncontrolled** — it is not a no-op, so a later entry naming a
region an earlier one gave to a side would take it back off them.

### 4.2 `units`

```lua
{ def = 'ms_tanks_s2', team = 0, x = 1200, z = 800,
  facing  = 'south',        -- optional
  count   = 6,              -- optional: a square-ish grid centred on (x,z)
  spacing = 150,            -- optional: elmos between copies (default 150)
  name    = 'north_depot',  -- optional: publishes a landmark (§6)
  orders  = { { cmd = 'PATROL', params = { … } } } }
```

- `def` must name a real unit def. `list_unit_defs` (MCP) enumerates them.
- `team` is a number, or the literal string `` `'neutral'` `` (Gaia — see
  [§7](#7-teams-sides-and-the-gaia-landmines)). A **typo is rejected**, not
  skipped.
- `orders[].cmd` is a numeric command id or a `CMD.*` constant name
  (`'MOVE'`, `'FIGHT'`, `'PATROL'`, `'GUARD'`, …).
- Units are staged with `Spring.CreateUnit`, which **returns nil without
  logging** when the ground is already occupied. The war is then quietly
  smaller than the file. Space your placements.

### 4.3 `civilians`

`{ units = { { def, x, z, facing?, role?, town? } } }`. Spawned via
`GG.Civilians.Spawn` and marked neutral, so a passing army does not stop to
shoot them. `town` must name a `towns[]` key that this file declares — a
civilian pointing at an undeclared town gets no district, so the estate never
counts it and a protect objective over that district finds nobody.

### 4.4 `towns`

`{ key, hall = { def, x, z }, archetype? }`. `key` is the **region key** the
town sits in (one place, one name, one key) and must be unique. A misspelt
`hall.def` resolves to no unit and the town then negotiates exactly as if its
hall had been destroyed — which is why both are hard-validated.

### 4.5 `world.features`

```lua
{ def = 'ms_rail_bridge', x = 5200, z = 3100,
  facing = 'east',    -- or heading = <short>; north/east/south/west
  chain  = 4,         -- segment count, laid along the facing direction
  pitch  = 24,        -- optional; default = the def's customParams.chain_pitch
  y      = 0,         -- optional SPAWN height (see below)
  name   = 'ferry_crossing',
  team   = -1 }       -- default: Gaia
```

- **Chaining is centred on (x, z)** — a `chain = 4` bridge spans 96 m with its
  midpoint at your crossing point, because that is the point an author means.
- `chain > 1` on a def that declares no `chain_pitch` and with no `pitch` here
  is **rejected**: every segment would stack on one spot.
- **`y` is a spawn height, not a placement.** Gravity applies and the feature
  clamps to `max(groundHeight, pos.y)` within about a second. Wrecks and relics
  should pass no `y` at all. Bridges pass `y` *and* rely on `floating = true`
  in their def — that is what keeps a span level at the waterline.

### 4.6 `objectives`

```lua
{ type = 'control', scope = 'strategic', forTeam = nil,
  region = 'raven_basin', reward = 300,
  victory = true, notBefore = 3600, holdFrames = 5400,
  expiresAtFrame = nil }
```

The flat convenience fields `region` / `targetUnitID` / `duration` /
`holdFrames` / `notBefore` fold into the evaluator's `params` sub-table at stage
time (`region` becomes `params.regionKey`). See [§8](#8-victory-and-objectives).

**Chaining — `phases`.** An objective can be a sequence of beats: phase 2's
children are created only when every child of phase 1 completes. This is the
authoring surface for tutorials and multi-stage wars.

```lua
objectives = {
  { type = 'control', scope = 'strategic', forTeam = 0,
    reward = 200, bounty = 0,
    params = { regionKey = 'r1_1' },      -- the PARENT is a real objective too
    phases = {
      { { type = 'control', region = 'r1_1', reward = 40, holdFrames = 300 } },
      { { type = 'control', region = 'r2_1', reward = 80, holdFrames = 300 } },
    } },
}
```

- Children are authored in **exactly the same dialect** as top-level objectives
  — the flat fields fold for them too.
- The parent **is itself an objective of its declared type** and must validate:
  a `phases` parent with bad `params` is rejected outright and *the whole chain
  silently does not exist*. Give it valid params (its own predicate can be one
  it never satisfies, e.g. a huge `holdFrames`; its progress is its children's).
- A child that **fails or expires fails the entire chain**. There is no
  partial-phase recovery.
- Children inherit `forTeam` from the parent unless they set their own.
- **One level only.** A child carrying its own `phases` is a load error.
- Sibling fields: `bounty` (extra pot, default 0) and `phase` (a published
  label; the engine overwrites it on parents as phases advance).
- `parentId` / `linkedId` take **runtime objective ids** and exist for
  programmatic callers (a gadget re-staging through the same helpers). A
  scenario *file* cannot know an id that has not been minted yet — use `phases`.
  They are validated as numbers, and a child naming a non-`phases` parent is
  ignored rather than killing the objectives gadget.

Objectives whose targets are populated at frame 30 (`_populateTargetsFrom`)
carry all of the above too, but their children are minted at frame 30 with them
— a deferred chain can never reference a frame-0 objective.

### 4.7 `ai`

```lua
{ team = 1, profile = 'strategos',
  slate = { kinds = { 'garrison', 'raid' }, home = 'iron_bend',
            targets = { 'raven_basin' }, route = { … }, reach = 3000 },
  stipend = { amount = 250, periodSec = 60 } }
```

`slate.kinds` ⊆ `{garrison, raid, toll}` — the kinds the shipped AI plugin
actually implements. An unimplemented kind produces an AI that boots fine and
then silently never does anything, so it is a hard error.

### 4.8 `briefing`

Display-only splash content shown on the way into the war
(`?play=<id>`; suppress with `?skipBriefing=1`):

```lua
briefing = {
  title = 'Scorched Crossing', subtitle = 'Two armies, one basin',
  story = 'Long prose. Blank lines split paragraphs.',
  tips  = { 'Hold the basin, do not just touch it.' },
  image = 'scenarios/img/crossing_standoff.jpg',   -- relative, client-served
  parTimeSec = 900,
}
```

A briefing is only reported `present` — and only mounts a splash — when it
carries `story` or `tips`. An `image` that is absolute or contains `..` is
dropped by the lobby.

**Worked examples:** `data/games/metalstorm/scenarios/crossing_standoff.lua`
is the richest authored war (and its comments explain most of the decisions
below); `tests/fixtures/generated_scenario.lua` is the fullest generated shape.

---

## 5. Region keys

Two addressing modes, and which one a map uses is a property of the **map**:

- **Named graph** — the map ships `data/maps/<id>/mapdata/regions.lua`, and
  keys are its authored names (`'raven_basin'`). Keys are **map-specific**: a
  scenario written against another map's graph fails at load.
- **Grid** — the map ships no `regions.lua`, so `game_regions.lua` selects the
  2048-elmo grid provider and keys are `"col:row"` strings (`'2:2'`).
  `green_flat_x34_v3` and `skerry_reach` are deliberately in this class.

The live graph (`GG.Regions.Keys()`) is authoritative in-game. `validate_scenario`
checks against the on-disk `regions.lua` when there is one and reports mismatches
as **warnings** (the file can drift from a reprocessed map); on a grid map it
skips the check, because any `"col:row"` string is valid.

A `world.regions[]` entry with only `name` renames a region without touching its
ownership. A town takes its region's key as its own name.

---

## 6. Landmarks and naming

A `name` on a `units[]` or `world.features[]` entry publishes
`landmark_<name>_x` / `landmark_<name>_z` rules params, which is what makes
"defend the grain silo" resolvable by the command language.

Two rules, both hard:

1. **The name must not end in `_x` or `_z`.** The client's regex is
   `/^landmark_(.+)_(x|z)$/` with a greedy capture, so `depot_x` would split at
   the wrong underscore and parse as `depot` with a missing coordinate.
2. **Names are global across `units[]` and `world.features[]` together.** They
   are one key space: a site and a bridge both called `ferry` would overwrite
   each other and one landmark would simply vanish.

A named chained feature is a landmark at the **chain centre**, not at its first
segment.

---

## 7. Teams, sides and the Gaia landmines

`sides[]` is what the **lobby** reads to build room slots, one slot pool per
faction. The resolution rules (`ReadSides`):

- Entries are grouped by `faction`, in first-declaration order — the order you
  write is the order the lobby shows, and the first playable side is where the
  host is seated.
- A side's resolved `team` is **the lowest declared team the scenario actually
  stages `units` for**. A playable side with no staged team anywhere is a room
  slot that starts with an empty army — a hard error here, and a real incident
  (endtoend D19).
- A side is **NPC** when every team it declares is claimed by an `ai` entry.
  Data-driven: an NPC faction is one the file says is an NPC, not one that is
  named like one.
- The first `capacity` declaration on a side wins (a side is one slot pool
  however many teams it spans). A **negative capacity is a typo, not
  "unlimited"** — it is dropped. Use the string `'unlimited'`.
- A faction key containing `,` or `:` is **dropped from the room**: the
  `war_sides` modoption is split on both.

**Gaia.** `team = 'neutral'` on a `units[]` entry is the Gaia spelling, and it
is a *string* for a mechanical reason: Gaia's id is derived from the **room
roster** (`playerTeamCount`), so it is not knowable when the file is written. A
hard-coded number would put your neutral towns on whichever player team landed
on that index. A typo (`'nuetral'`) is rejected rather than skipped, because
skipping would silently drop every neutral thing in the war.

Gaia is its own ally team with **no allies**, which is this engine's definition
of *hostile*, not of *neutral*. Set dressing on Gaia must therefore not be able
to shoot: a Gaia-owned howitzer once destroyed one side's entire infantry
component before the two player armies ever met.

**Teams the launch did not seat.** A scenario may declare more teams than a
given room supplies. `units` and `ai` entries for a missing team are skipped
with a warning — but an **objective** scoped with `forTeam` to a missing team
used to be worse than useless: paying its reward called
`Spring.GetTeamRulesParam` on a team that does not exist, the "Bad teamID" error
propagated out of the Objectives gadget's callin, `gadgetHandler` **removed the
gadget**, and with the evaluator gone the victory objective could never
progress. It is now skipped with a warning. Open races (`forTeam = nil`) are
unaffected — which is why the victory objective itself should normally be one.

Number your teams consecutively from 0: gaps materialise empty teams.

---

## 8. Victory and objectives

**Exactly one objective should carry `victory = true`.**

- **Zero** is legal and the war plays fine — it just never ends on its own. The
  lobby lists it `NO-TERMINAL-CONDITION`, `DefaultForMap` never auto-selects it
  for its map, and `game_gameover` has nothing to end it on. Correct for
  tutorials, soaks and fixtures; `validate_scenario` warns (info for a
  `tutorial`), it does not error.
- **Two or more** is accepted by the lobby but breaks the generated-scenario
  contract, and whichever completes first ends the war. Warned.

For a `control` victory objective:

- `holdFrames` defaults to `DEFAULT_VICTORY_HOLD_FRAMES` (5400 = 3 min), not the
  900-frame tactical default. The question a terminal hold has to answer is
  "can an enemy who sees the region flip reach it before the hold completes" —
  30 s cannot be that on any map worth fighting over. (An unopposed three-unit
  patrol once won a war 45 s after arriving.)
- **`notBefore` is a floor, not a schedule**, and the hold clock is
  **restartable** — a contested region resets it. Size `notBefore` past the
  slowest staged class's approach time so "the war ended before the armies could
  meet" is unrepresentable rather than merely unlikely.

---

## 9. Coordinates and placement

Positions are in **elmos**; the map's extent is in `data/maps/<id>/mapinfo.lua`.
Y is never authored for units (ground height is sampled); for features see
[§4.5](#45-worldfeatures).

Two things offline validation cannot see, and one it can:

- **Occupied ground** — `CreateUnit`/`CreateFeature` refuse silently. Only a
  boot-and-count catches this.
- **Blocked yardmaps** — a unit spawned inside one is trapped.
- **Graph-level passability** — `validate_scenario {passability: true}` runs
  `tools/mapgen/regions_from_map.py <mapDir> --verify`, which proves the map's
  regions are mutually reachable for the reference movement class. `--verify`
  **is read-only** (it implies `--dry-run`). It does *not* prove your specific
  placements are reachable or unoccupied.

---

## 10. The authoring loop

```
list_unit_defs                     # real def names (and list_scenarios for prior art)
   ↓
write the file  (or start from generate_scenario output)
   ↓
validate_scenario {luaSource: …}   # offline, no stack needed — repeat until 0 errors
   ↓
write_scenario  {scenarioId, luaSource}    # validates again, writes, resyncs, confirms offered:true
   ↓
launch_scenario {scenarioId}       # or ?direct= / ?play=
   ↓
list_units / get_game_state        # observe, then iterate
```

Two habits worth keeping: pass `luaSource` to `validate_scenario` **before**
writing anything (it is the same rule set, so nothing is a surprise later), and
believe `offered: false` when `write_scenario` reports it — that is the lobby
telling you it declined the file.

To change a **generated** war, re-run `generate_scenario` with different knobs
or a different seed. Editing `gen_*.lua` is undone by the next resync.

---

## 11. Validation rule reference

Every rule `validate_scenario` can emit. "Mirrors" names the parser whose
behaviour the rule reproduces.

| Rule | Severity | Mirrors | Fires when |
|---|---|---|---|
| `bare-parse` | error | lobby `LoadOne` | The file does not load, or does not return a table, in a bare `lua_State`. Ends the run — nothing else is reachable. |
| `not-found` | error | — | No such scenario file. |
| `version` | error | sim loader | `version ~= 1`. |
| `victory-count` | warning / info | lobby `HasVictoryObjective` | Zero `victory = true` (info for a `tutorial`), or more than one. |
| `side-unstaged` | error | lobby `ReadSides` | A playable side resolves to a team with no staged `units` (endtoend D19). |
| `side-ignored` | warning | lobby `ReadSides` | A `sides[]` entry lacking a string `faction` or numeric `team` — the lobby skips it, so the side gets no slot. |
| `side-capacity` | warning | lobby `ReadSides` | Negative or non-numeric `capacity` (dropped, *not* "unlimited"). |
| `faction-key` | error | lobby `EncodeWarSides` | A faction key containing `,` or `:` — the side is dropped from the room. |
| `unknown-unitdef` | error | sim `validate` | `units[].def`, `towns[].hall.def` or `civilians.units[].def` names no baked unit def. |
| `unknown-featuredef` | error | sim `validate` | `world.features[].def` names no baked feature def. |
| `unknown-cmd` | error | sim `resolveCmd` | An order's `cmd` is neither a number nor a `CMD.*` constant name. |
| `unit-team` | error | sim `validate` | `team` is a string other than `'neutral'`. |
| `landmark-name` | error | sim `landmarkNameProblem` | A `name` that is not a non-empty string, or ends in `_x`/`_z`. |
| `landmark-collision` | error | sim `validate` | The same landmark name twice across `units[]` + `world.features[]`. |
| `town-key` | error | sim `validate` | Missing/duplicate town `key`, non-numeric `x`, or a malformed `hall`. |
| `orphan-civilian-town` | error | sim `validate` | A civilian's `town` names no declared town. |
| `region-entry` | error | sim `validate` | A `world.regions[]` entry with neither `key` nor `x`+`z`. |
| `feature-coords` | error | sim `validate` | A feature with non-numeric `x`/`z`. |
| `feature-facing` | error | sim `featureHeading` | A `facing` that is neither a cardinal name nor a number. |
| `feature-chain` | error | sim `validate` | `chain` not a positive integer, or `chain > 1` with no `pitch` and no `customParams.chain_pitch` on the def. |
| `ai-team` / `ai-profile` / `ai-stipend` | error | sim `validate` | Non-numeric `team`, non-string `profile`, `stipend` with no numeric `amount`. |
| `ai-slate` | error | sim `validate` | `slate` not a table, an unimplemented `kinds` entry, or an empty `kinds`. |
| `ai-region` | warning | sim `validate` (live graph) | A slate region key the map's **on-disk** graph does not declare. The live graph is authoritative, so this is advisory. |
| `objective-phases` | error | sim `validate` | `phases` is not a non-empty array of non-empty arrays of typed child tables, or a child declares its own `phases` (one level only). A mis-shaped chain is *skipped*, so the parent silently becomes an ordinary objective. |
| `objective-chain-id` | error | sim `validate` | `parentId`/`linkedId`/`phase` is not a number. They take runtime ids a file cannot know — author chains with `phases`. |
| `standing-orders-noop` | warning | sim loader | A non-empty top-level `orders` block — ignored entirely. |
| `ephemeral` | info | — | `ephemeral = true` on what looks like an authored file. |
| `gen-prefix` | warning | `ScenarioDb::ValidateId` | The id starts `gen_`, which the DB owns and its sweep deletes. |
| `world-map` | error / warning | — | `map` not a string (error), or no `data/maps/<map>/` on this machine (warning). |
| `passability` | info / error / skipped | `regions_from_map.py --verify` | Only with `{passability: true}`. |
| `defs-cache-missing` | **skipped** | — | No baked def cache, so **every** unknown-def check was skipped. Run a game once to bake. |
| `region-graph-missing` | **skipped** | — | No on-disk region graph, so slate keys were not checked. |

`skipped` means **not checked** — never "checked and fine". A run whose only
non-`info` findings are `skipped` has proved less than it looks.

---

## See also

- [debugging-tools.md](debugging-tools.md) — `validate_scenario`,
  `write_scenario`, `list_scenarios`, `generate_scenario`, `launch_scenario`.
- [api.md](api.md) — `GET /api/games/{gameId}/scenarios`,
  `POST /api/rooms/direct`, the admin scenario routes.
- [javascript.md](javascript.md) — `?play=`, `?skipBriefing=`, the splash.
