# Metalstorm Strategos — strategic AI (skeleton)

Army-level goal selection and force allocation for Metalstorm. **Strategic, not
tactical**: it chooses goals and allocates force over the region graph, and
commands only through *macro directives* — never per-squad orders. One brain,
three deployment roles (full side / co-commander / NPC). It is a virtual
player: fog-limited, rate-limited, and it *pays authority* for every directive
like a human.

Design source of truth: [`PLAN-metalstorm-ai.md`](../../../../../PLAN-metalstorm-ai.md).
Runtime it targets: [`PLAN-ai.md`](../../../../../PLAN-ai.md).

> **Status: reads live, decisions are pure and tested, writes are stubbed.**
> The Picture builder (`picture.lua`) now reads real rulesParams + the AI4
> file API end-to-end (regions, board, economy, force ledger/intel, power
> table); the pure decision core (slate + planner + config + roles +
> profiles) is complete and tested headless — see `tests/`. What's left:
> `actuators.lua`'s real verbs wait on AI2, and a few data gaps (bounty
> visibility, cost-scale mirror, radar blips, composition counters) are
> documented at their call sites, not guessed at.

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
4 ⏳). The VM exposes reads (`AI.getOwnUnits / getVisibleEnemies / getFrame /
getMapSize / getTeamId / getRulesParam / getMapData / getDefExport`) and the
AI2 directive-shaped writes (`AI.createGroup / issueDirective / setPosture`); it
opens only `base/table/string/math/utf8`. Each ask below flips a feature-detect
from stub to live with no rewrite:

| Ask | What | Unblocks | Status |
|---|---|---|---|
| **AI0-boot** | AI plugins boot reliably (existing Phase-4 repair) | everything | ✅ 2026-07-20 — fixed by AI0-loader (missing `require` was the boot failure) |
| **AI0-loader** | a plugin-scoped `require`/module loader in the AI VM (or bundle-at-discovery) | `main.lua` wiring the multi-file layout (pure modules already test headless) | ✅ 2026-07-20 — `AIScriptContext::l_require`, sandboxed; `tests/test_ai_runtime.cpp` boots this plugin |
| **AI1** | `AI.getRulesParam(scope, key)` | the whole Picture: regions, board, pools, guidance, parley | ✅ 2026-07-20 — snapshot carries game+team params; `caps().rulesParam` now true |
| **AI4** | `AI.getMapData` / `AI.getDefExport` (sandboxed file reads) | region graph geometry + the expected-DPS power table | ✅ 2026-07-27 — same files the client fetches; see `rts/Server/AI/AIScriptContext.cpp` |
| **AI2** | org-group / directive / posture verbs on the command interface | the real actuator (standing-order fallback DELETED) | ✅ 2026-07-27 — `AI.createGroup / issueDirective / setPosture`; drained on the sim thread through the SAME `OrgGroupManager`/`DirectiveManager` + `AllowDirectiveCreate` charge path as a human's wire message (`StateStreamer::TickAI`). Directive-shaped only — no per-squad verb (strategic floor). §8 E6 rate clamp (≤1/group/tick) enforced in the drain unconditionally |
| **AI3** | AI slots get playerIDs + pools + `PlayerAdded` flow | authority integration (likely already true via virtual-player design — verify) | ⚠ verified FALSE — AI = team only, no playerID; leader is the host player. **DECIDED 2026-07-26: virtual playerID + pool per AI slot** (authority lane) — until it lands, `picture.economy.ownPool` honestly reads 0 |
| **AI-team** | `AI.getTeamId()` / squad views / `AI.getLODLevel()` | friendly-vs-enemy scoring, squad-accurate ledger, LOD cadence | ◑ partial — `AI.getTeamId()` landed 2026-07-20; squad views + `getLODLevel` still pending |
| **I1** | AI-side `SendLuaRulesMsg`-equivalent (`AI.sendGameMessage`) | parley responses + the intent-report blob (interaction §6) | pending |
| **I2** | team-private rulesParam visibility survives streaming | guidance-store privacy (co-commander orders hidden from enemies) | pending |

AI0-loader + AI1 + AI4 landed: the plugin **boots in the engine VM**, reads
rulesParams, and reads the region-graph/power-table JSON exports. The Picture
builder (plan task 3) is now wired end-to-end against real data: regions
(geometry + live owner/contested), board (objectives), economy (team pool),
`Picture.regionOf` (lookup-grid + point-in-polygon, mirrors
`ui/lib/regions.js`), and byClass force bucketing off the power table. Three
data gaps remain, each documented at its call site rather than guessed at:
bounty-vs-natural-reward is unpublished (`readBoard` in `picture.lua`), the
`authority_cost_scale` modoption has no rulesParam mirror (`readEconomy`), and
there is no radar-blip or idle-factory surface on the AI VM yet
(`updateIntel` / `slate.lua`'s `compositionGap`).

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

`tests/picture_spec.lua` mocks `_G.AI` (the same feature-detected surface
`AIScriptContext.cpp` exposes) and drives `Picture.refresh`/`Picture.regionOf`
directly, against `tests/fixtures/regions.json` (a real, small "graph"-shaped
export in the same format `MapProcessor.cpp` produces): region geometry +
owner/contested overlay, objective high-water-mark gap skipping, economy pool
reads, the lookup-grid/point-in-polygon region resolver, and intel decay.

This is the plan's §11 test surface; expand it as the remaining stubs
(AI2 actuator verbs, AI3 own-pool, `compositionGap`) fill in.
```
