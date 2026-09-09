# 2026-09-10 review sweep — fifteen parallel lanes

Fifteen Fable agents reviewed the game design and code in parallel, each in
its own worktree with a disjoint file scope, under three user constraints:
**no browser sessions, no C++ compilation, no questions.** Every lane landed
on `main`; each lane's own report (findings ranked, what changed, proposed
uncompiled C++ patches, out-of-lane findings, assumptions, not-done list) is
the file named in the table. Most lanes wrapped early when the session usage
limit hit, so the "Not done" sections are the follow-up queue.

## Gates on the merged tree (verified on `main` after every merge)

| Gate | Baseline (before) | After |
|---|---|---|
| `client` tsc | clean | clean |
| `client` vitest | 3771 / 186 files | **3890 / 195 files** |
| Metalstorm UI suite | 88 / 6 files | **100 / 7 files** |
| `tools/debug-mcp` node --test | 217 | **248 / 0 fail** |
| strategos busted | 131 | **154** |
| `ai/lib` + `ai/garrison` busted | — | 63 + 1 |
| authority / objectives busted | 50 / 139 | **71** / 139 |
| touched gadget specs (transports 67, parley 26+18+8, guidance 32+15+57, caretaker 8, gameover 42, teams 34, tutorial 22, field-engineering 12, decay 8, ai_health 4) | mixed, one red | all green |

C++ was not built. The server-side defects each lane found are written up
as exact patches under "Proposed C++ patches (UNCOMPILED)" in the lane
reports and need one build session to apply and test.

## Lanes

| # | Lane | Report | Landed (headline) | Not done (headline) |
|---|---|---|---|---|
| 1 | world-map | [world-map.md](world-map.md) | Layered strategic canvas map: kind glyphs, colour-blind-safe faction palette, territory halos, transit cues, claim pennants, hover chip, `WorldMap` controller (pointer/pinch/keyboard, animated focus, collapsed legend, `on('select')`, `poi-selected` events). Fixed antimeridian edges drawn the long way, whole-world labelling on 4K, per-frame allocations. | Controller DOM tests; `world-preview` refresh. |
| 2 | world-screen | [world-screen.md](world-screen.md) | Drill-down World screen: quiet default (map, clock chip, faction chip, alerts badge) + ONE drawer (POI / faction / ledger / alerts); pure `world-staging`, `world-claims`, `world-ledger` modules; countdowns tick; stale-cache remount; read/prune notifications; inline confirmations. | Claims/ledger unit tests; `isAdmin` pause control needs a session role the lobby does not keep yet. |
| 3 | world-design | [world-design.md](world-design.md) · [proposed tests](world-design-proposed-tests.md) | `docs/world-layer.md` design-of-record incl. W13–W18 designs; api docs reconciled; 20 findings — commander victory attribution compares faction slugs to side keys (H), season digest mixes ids (H), non-atomic season rollover, staging/escrow orphan race, origin-edge pricing exploit; 12 uncompiled patches. | All patches P1–P12 (build session). |
| 4 | ai-core | [ai-core.md](ai-core.md) | Exact authority-cost mirror (was predicting a formula the charge site never applies), `threat.lua` threat/opportunity map, objective-aware scoring, posture floor (never strip the last held region), split-map reachability via BFS, withdraw reasoning, profile differentiation, deterministic iteration. | Scenario fixtures + spec, perf re-measure. |
| 5 | ai-actuation | [ai-actuation.md](ai-actuation.md) | Parley verbs REAL over the I1 funnel (propose / respond) with co-commander deference; tribute demands no longer auto-accepted; bounded response window; tick backoff + boot-retry gate; `ai.health` → `ai_health_<pid>_*` rulesParams; one standing red spec fixed. | Caretaker timed fuse; ROE/asset-lock consumers in the core. |
| 6 | ai-framework | [ai-framework.md](ai-framework.md) | `ai/lib/` reusable AI-player library (engine facade, picture, regions, authority preview, directives, rate-limited actuator, scheduler, reporter, fake engine for specs, vendored spec copies with a drift test); `ai/garrison/` second AI with three profiles; engine-surface census. | `tools/ai-eval`, `docs/ai-players.md`, garrison brain spec. |
| 7 | mcp-control | [mcp-control.md](mcp-control.md) | `end_game` on a hibernated room signalled pid 0 (own process group) — fixed; ended rooms no longer route to a port squatter; deadlines on every fetch; schema drift fixed; token redaction; `tools.js` catalogue; guidance wire encoder, SSE parser, fengari-tested Lua snippets; `world_*`/`ai_*`/`nl_command` stubs wired. | Handler bodies for the new tools, `self-check`, `docs/mcp-tools.md`. |
| 8 | skills | [skills.md](skills.md) | Drift fixed in all five skills (WebRTC/`/api/rtc/offer` gone, `/api/rooms/stream` SSE, `openBrowser:true`, tool args re-verified), reference material split out, stale BAR screenshot removed. | Five new skills (world-layer, ai-player, design-review, lua-gadget-test, client-gate), `.claude/agents/*`, `check-skills.sh`. |
| 9 | hud-drilldown | [hud-drilldown.md](hud-drilldown.md) | Tab no longer hijacked; Esc returns focus; enemy selections become `enemy-force`; duplicate objective titles qualified; hidden-readout per-frame writes guarded; authority pill drills into a ledger; AI chip (`ai-hud`) reads lane 5's health params; `ui/lib/focus.js` focus contract; two dead widgets deleted. | CSS token doc, ai-hud/ledger tests, town view. |
| 10 | nl-commands | [nl-commands.md](nl-commands.md) | Contract v2: `query.events`, patrol/screen execute from a sentence (were dead verbs), `withdraw` → nearest departure landmark, place-vs-force refusal, focus contract v2 with target elision from the drilled panel, six fixture boards. | Pre-LLM fast path, ≥60-case offline eval + baseline, instructions rewrite. |
| 11 | objectives-authority | [objectives-authority.md](objectives-authority.md) | Field-engineering gate is now CODE (AllowCommand + AllowUnitCreation, `building_family='support'` tier, `battle_production` modoption escape hatch); velocity metric rebuilt; overflow decay really 2 %/min; `econ_*` metrics published. | Seven designed objectives fixes (expiry-vs-completion, escrow destruction, generator cap double-decrement …), economy harness, two gameplay rules. |
| 12 | battle-flow | [battle-flow.md](battle-flow.md) | Transport arrival terrain-vs-kind validation (sea needs water, train needs rail), offshore sea unload radius, extracted-strength ledger (`ms_withdrawn_<team>_strength`), warlog `transport` events; 14 ranked findings. | The new `pelagic_expanse` showcase scenario pair (map-verified design in the report), the every-scenario dangling-reference spec. |
| 13 | units-assets | [units-assets.md](units-assets.md) | `tools/scripts/check_unit_defs.py` def/asset census (0 placeholder defs, 0 dead refs — the "6 families lack objectname" note was stale); ASSETS.md licence gate was inert (parser stopped at row 2) — data fixed; staticdefense HP re-based; measured clearances; two missing weapon-fx entries. | Forge builds (barricade split, trench, engineers_s3 rig), `sizes` corrections pinned by golden specs. |
| 14 | war-surfaces | [war-surfaces.md](war-surfaces.md) | Deploy `seed` contract (`deployIsEnterable`), Director phase read (`war.phase`), retired-scenario `playRefusal`, attach-mode fix, AI profile rules with descriptions, notice rail model, SSE restart rule. | DOM for cards/drawer/rail, settlement + scenario cards, precache stages. |
| 15 | onboarding | [onboarding.md](onboarding.md) | The tutorial did not exist (gadget disabled, scenario staged nothing, manual claimed otherwise): a data-driven Tutorial Director gadget with a 22-case headless spec. | `beats` tables for tutorial_01/02/03, `tutorial-guide.js` coach widget, `client/src/ui/help`, `docs/player-guide.md`. |

## Cross-lane wiring done by the coordinator after the merges

- `lobby-ui.ts`: `world-poi` and `world-season` SSE listeners (lane 2's
  out-of-lane §1–2), room-stream reconnect after a CLOSED `EventSource`
  (lane 14 finding 6), seeded-deploy joins the built war (lane 14 finding 1).
- `main.ts`: `?play=<retired>` is refused at URL parse (lane 14 finding 3).
- `ai/lib/vendor/authority_cost.lua` re-copied after lane 11's edit (drift spec).
- Strategos README status paragraph; ARCHITECTURE.md rows for `ai/lib`,
  `ai/garrison`, `docs/world-layer.md`.

## Remaining (ordered by value)

1. **Build session for the uncompiled C++ patches** — world-design P1–P12
   first (victory attribution, digest ids, atomic rollover, escrow orphan,
   pricing exploit), then ai-actuation P1–P3 (`AI.issueCommand` bypasses
   authority; `idleOnly` hardcoded false for AI), mcp/nl proxy asks.
2. World screen `isAdmin` + the two optional cleanups (empty `#world-panel`
   shell in `browser.html`, superseded `.world-*` CSS block).
3. Onboarding: tutorial beats + coach widget + help drawer + player guide.
4. Battle-flow: the `pelagic_expanse` scenario pair + the all-scenarios
   reference spec.
5. MCP handler bodies for `world_*` / `ai_*` / `nl_command`; then the five
   new skills and agent definitions against them.
6. `tools/ai-eval` + `docs/ai-players.md`; garrison brain spec.
7. Forge builds from the units-assets queue.
8. Objectives fixes + economy harness (lane 11 "Not done").
9. Browser verification pass for every UI lane (screenshot plans are in the
   world-map, world-screen, hud-drilldown, war-surfaces reports).
