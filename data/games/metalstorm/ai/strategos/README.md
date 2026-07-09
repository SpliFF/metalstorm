# Metalstorm Strategos — strategic AI (skeleton)

Army-level goal selection and force allocation for Metalstorm. **Strategic, not
tactical**: it chooses goals and allocates force over the region graph, and
commands only through *macro directives* — never per-squad orders. One brain,
three deployment roles (full side / co-commander / NPC). It is a virtual
player: fog-limited, rate-limited, and it *pays authority* for every directive
like a human.

Design source of truth: [`PLAN-metalstorm-ai.md`](../../../../../PLAN-metalstorm-ai.md).
Runtime it targets: [`PLAN-ai.md`](../../../../../PLAN-ai.md).

> **Status: structural skeleton.** Every module, data shape, and control-flow
> path is in place; the heavy *computations* are stubbed with `TODO`s keyed to
> the engine ask that unblocks each one. The pure decision core (slate +
> planner + config + roles + profiles) is complete enough to test headless
> today — see `tests/`.

## Module map

```
ai/strategos/
  ai.config.lua     discovery manifest (name → lobby "Add AI"; entry = main.lua)
  main.lua          runtime entry: global callins, tick scheduling, LOD gate,
                    role/profile resolution, cross-tick memory, the pipeline
  config.lua        constants + authority-cost formula MIRROR + seedable RNG   [PURE]
  picture.lua       reads mirrors → the Picture (regions, board, ledger, intel,
                    economy, guidance, parley); feature-detects the AI surface
  slate.lua         Picture → candidate goals (explicit + implicit)            [PURE]
  planner.lua       goals + Picture → directive list (score, assign, govern)   [PURE]
  actuators.lua     the ONLY writer: directive/posture/build/bounty/chat verbs
                    + the standing-order fallback; structurally has no squad cmd
  roles.lua         full_side / co_commander / npc policy tables               [PURE]
  profiles/         default · aggressive · caretaker · npc_raider (weights)    [PURE]
  tests/            busted specs driving the pure core against fixture Pictures
```

## Data flow (one strategic tick, 0.2 Hz)

```
main.onUpdate(frame)
   └─ every role.tickFrames:
        picture.refresh()   read mirrors + decay intel      → Picture   (picture.lua)
        slate.build()       explicit + implicit goals         → Goals     (slate.lua,  PURE)
        planner.plan()      score · assign · govern · commit  → Directives(planner.lua, PURE)
        actuators.apply()   emit verbs (or fallback) + intent             (actuators.lua)
```

Reads live in `picture`, decisions live in `slate`/`planner` (pure), writes
live in `actuators`. That separation is what lets the whole brain be tested
without an engine (`Planner.plan(fixture)` is a pure function), and is why the
plan calls the planner "most of the plan and none of it is blocked."

## The strategic floor (design law)

The command floor is the macro directive. `actuators.lua` has **no
`moveSquad`/`attackTarget` function** — the planner *cannot* micro because no
verb exists. This is structural, not disciplinary. Two payoffs: the AI plays
the same game humans do (strategy over CPS), and its cost profile is tiny (a
few directives/minute at 0.2 Hz).

## Engine asks (what unblocks each stub)

The AI runtime is real but incomplete (`rts/Server/AI/*`, ARCHITECTURE.md Phase
4 ⏳). The current VM exposes only `AI.getOwnUnits / getVisibleEnemies /
issueCommand / getFrame / getMapSize`, opens only `base/table/string/math/utf8`,
and loads a single entry buffer. Each ask below flips a feature-detect from
stub to live with no rewrite:

| Ask | What | Unblocks |
|---|---|---|
| **AI0-boot** | AI plugins boot reliably (existing Phase-4 repair) | everything |
| **AI0-loader** | a plugin-scoped `require`/module loader in the AI VM (or bundle-at-discovery) | `main.lua` wiring the multi-file layout (pure modules already test headless) |
| **AI1** | `AI.getRulesParam(scope, key)` | the whole Picture: regions, board, pools, guidance, parley |
| **AI2** | org-group / directive / posture verbs on the command interface | the real actuator; standing-order fallback until then |
| **AI3** | AI slots get playerIDs + pools + `PlayerAdded` flow | authority integration (likely already true via virtual-player design — verify) |
| **AI-team** | `AI.getTeamId()` / squad views / `AI.getLODLevel()` | friendly-vs-enemy scoring, squad-accurate ledger, LOD cadence |
| **I1** | AI-side `SendLuaRulesMsg`-equivalent (`AI.sendGameMessage`) | parley responses + the intent-report blob (interaction §6) |
| **I2** | team-private rulesParam visibility survives streaming | guidance-store privacy (co-commander orders hidden from enemies) |

Until AI1, the Picture is mostly empty and the planner correctly does almost
nothing (a blind AI holds position) — safe by construction.

## Integration risks worth a human decision

1. **Discovery layout.** `AIDiscovery` scans `<game>/ai/<plugin>/` and loads
   one entry file. This plugin lives at `ai/strategos/` to match that
   convention exactly (the plan's flat `ai/main.lua` layout would not be
   discovered). If you prefer the plan's literal paths, the discovery scan or
   the plan needs reconciling — flagged, not assumed.
2. **No module loader.** `main.lua` uses `require`. The AI VM has no `require`
   yet (AI0-loader). The pure modules are still fully testable with busted; the
   *runtime* won't boot until the loader lands. Recommended fix: register a
   `require` that resolves against the plugin folder, or concatenate the
   plugin's files at discovery into one buffer.
3. **Per-slot profile/difficulty.** The runtime passes no per-slot config into
   the VM. `main.resolveProfile()` currently defaults; wire it to a rulesParam
   hint set by a gadget from the `per-slot profile` modoption (plan §10.6) once
   AI1 lands.
4. **Authority-cost mirror drift.** `config.authorityCost` hand-copies
   `LuaRules/Configs/authority_cost.lua`. The shared JSON export (authority ask
   A3) should replace the copy; `version` guards drift meanwhile.

## Testing

The pure core is designed for `busted`:

```
busted tests/            # from data/games/metalstorm/ai/strategos/
```

`tests/planner_spec.lua` builds fixture Pictures by hand (bypassing the
engine-coupled `picture.lua`) and asserts decisions: broke AI turtles to
postures, a threatened valuable region draws DEFEND, RESERVE always present,
commitment hysteresis resists thrash, force floors skip undersized packages.
This is the plan's §11 test surface; expand it as the stubs fill in.
```
