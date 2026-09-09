# hud-drilldown — lane 9 review, 2026-09-10

## STATUS

complete (wrapped early) — coordinator cut-off. Code committed in `c1c7ab5042`; see Not done.

Branch: `worktree-agent-a37cb0bfadc5315df` (cut from main `88d257bce2`, merged main tip before starting).

Baseline gates before any edit: tsc clean · client vitest 3770 passed / 1 skipped (186 files) · ui suite 88/88.

## Where this lane stood before the review

The drill-down HUD is NOT greenfield: U0–U4 of the battle-clarity lane landed a
complete framework (`client/src/ui/native-ui/DESIGN-DRILLDOWN.md`): focus model,
`createDrilldown` primitive, camera travel (`cameraSnapToGround`, ground-anchored),
squad chips (story 1), objective chips + world rings (story 2), the ONE `Battle ▾`
access point with Statistics/Reports/Events/Objectives/Diplomacy tabs (story 3),
and NL bound to `focusModel.nlFocus()` (story 4). Both rails and the bottom are
empty at rest. This review therefore audited that framework against the directive
and the producing gadgets, fixed what was wrong, and built the pieces the brief
names that were still open (authority drill, AI chip, focus port for game-dir
widgets, `enemy-force` kind, squad actions beyond Halt/Follow, duplicate titles).

## Findings (ranked)

| # | Sev | Where | What | Status |
|---|---|---|---|---|
| 1 | HIGH | `global-surface.ts` keydown | `Tab` was consumed in the capture phase for the WHOLE document (except text fields). Tab is also the browser's focus-traversal key, and the loader deliberately makes every panel header a real `<button>` for keyboard players — so no keyboard user could ever traverse the HUD; Tab always toggled the Battle surface instead. | FIXED — Tab is taken only while focus is on the game (body/canvas); inside `#ui-root` it traverses. Surface now takes focus on open (active tab) and RETURNS it on close (`returnFocusTo`), with `role=dialog/tablist/tab/tabpanel` + `aria-selected`. |
| 2 | HIGH | `drilldown.ts` Esc | Esc collapsed the panel but left keyboard focus on `<body>` when the player had tabbed into the action row — the next Tab restarted from the top of the document. | FIXED — focus returns to the chip that opened the panel; `aria-controls` added. |
| 3 | HIGH | `focus-model.ts` / `focus-hud.ts` | A selection of ENEMY units resolved to a `unit` ref ("3 units") with a live **Halt** button — an order the sim refuses, on a chip that never said whose tanks they were. `enemy-force` was a declared kind with no producer and no rung-2 view (open debt since U0). | FIXED — `resolveSelectionSubjects` takes `isHostile` (fed from the LOS-honest census); hostile units become an `enemy-force` ref titled "Enemy 3 × line tanks · SPOTTED", rung 2 says "takes no orders from you", rung 3 is camera only. `refocusSelection()` re-resolves when the census lands (it arrives after the selection it describes). |
| 4 | HIGH | `hud.ts` `updateHUD` | Called from the render loop at frame rate; wrote `textContent` to three elements every frame — all of them `display:none`. Per-frame DOM mutation into invisible nodes. | FIXED — write-if-changed cache; `selectionReadout` exported for tests. |
| 5 | MED | `objective-hud.ts` | Duplicate-title defect open since U1 (three "Hold Raven Basin" chips in `crossing_standoff`; U2/U3/U4 each recorded it). | FIXED — `disambiguateTitles()` (pure, `objective-model.ts`) qualifies only colliding titles: `(victory)` > origin > `(⬡reward)` > `(#n)`; applied by BOTH the chip stack and the rung-4 board over the whole ranked list so a chip never renames itself when the tab opens. |
| 6 | MED | `authority-bar.js` | Rung-0 pill with NO drill: the ledger (where charges draw from, cost scale, recent awards/refusals) had no surface; toasts vanish after 4 s and the question "what did I just get paid for?" had no answer. DESIGN §7 listed this as unscheduled. | FIXED — pill is a `<button aria-expanded>`; click/Enter opens a rung-2 ledger built from the design system's `.nui-dd__*` classes; Esc closes + focus returns; records itself as surface `authority-ledger` via the new `ctx.focus` port. `nlAliases` added. |
| 7 | MED | manifest / loader | No AI summary affordance: the co-commander's state lived only in the Reports-tab panel (rung 4). | BUILT — `ai-hud.ts` builtin: feature-detected chip under the pill ("Strategos · BALANCED · Tasks 3 · Spend ⬡42"), rung 2 = stance/ROE/profile/health/doing/intents/reserved/delegated/funding, rung 3 = cycle stance (`guidance.stance`) + open the guidance panel. Health params read by name (see Assumptions). |
| 8 | MED | `focus-hud.ts` rung 3 | Only Halt and Follow. The brief asks for posture/hold/withdraw/delegate/add-to-group where a verb exists. | FIXED — added **Fall back to <nearest friendly region>** (`GroupDirective` Withdraw → point, disabled with reason on a partial selection / no known friendly region), **Reserve from AI / Release to AI** (`guidance.lock`, disabled when no AI guides the team), **Form a squad** (`OrgGroup` create with an auto callsign) for loose units. Posture deliberately NOT offered: `GroupPosture` JSON is stored/echoed by the server and read by nothing (no squad module, no gadget consumes `postureJson`) — a dead button. |
| 9 | MED | game-dir widgets | No way for a game-dir widget (fetched as a standalone ES module) to read the focus; `focus-model.ts` is bundled-only. | FIXED — `WidgetContext.focus` port (`get/subscribe/openSurface/closeSurface/isSurfaceOpen`) built over the singleton; `ui/lib/focus.js` is the pure read contract + helpers. |
| 10 | LOW | `focus-model.ts` | No hover in the focus (brief: "hovered item"). | FIXED — `hover/unhover/getHovered/subscribeHover` on a SEPARATE listener set (hover must not re-render every drilldown on every mouse pass); `nlFocus().hovered` added; drilldown chips report hover on mouseenter/leave and focus/blur. |
| 11 | LOW | `ui/widgets/command-composer.js` | A 34-line "Composer (stub)" that nothing mounts (the manifest's retired composer is `client/src/native-widgets/command-composer.js`). Dead file that a grep for the widget id finds first. | FIXED — deleted. |
| 12 | LOW | `ui/widgets/objectives-panel.js` + its test | Retired in U1, unmounted since; its bounty form has no wire verb (`objectives.createBounty` does not exist) and its outcome log is superseded by the Events tab. 389 lines of dead widget + 363 lines of test pinning dead behaviour. | FIXED — deleted both; `ui/lib/objectives.js` (pure wire mirror, own tests) kept. |
| 13 | LOW | `DESIGN-DRILLDOWN.md` §7 | Row says `#hud-selection` "still open; the per-game switch is the whole job". Stale: `hud.html` ships it `style="display:none"` and no code path shows it — same situation U3 found for `#hud-help`. | FIXED — row corrected. |
| 14 | INFO | rulesParam census | Every key the widgets read was checked against its producer: `authority_pool`, `authority_player_<pid>[_own_pool_only]` (team, ALLIED_LOS), `authority_event[_<slot>_{kind,amount,reason,player,team,seq}]`, `authority_cost_{scale,version}` (game); `guidance_<t>_{stance,roe,funding_rateCap,paint_keys,paint_<k>,lock_keys,delegated_keys,veto_keys,intent_count,intent_<i>_{goal,group,spend,goal_id},change,change_<s>_{field,value,player,seq}}` (team, default PRIVATE LOS); `parley_count`, `parley_<id>_<20 fields>`, `trust_<a>_<b>` (game); `score_<pid>_{earned,spent,objectives}` (game, 30 s cadence); `objective_count`, `objective_<id>_<18 fields>` (game); `region_<key>_{name,x,z,team,contested}`, `regions_rev` (game); `ai_profile_<pid>`, `team_active_humans`, `team_leader` (team). All names/shapes match. Note `guidance_*` is published WITHOUT a losAccess table ⇒ private to the owning team; the team wire filters per connection (`handleRulesParamUpdate` scope `team`), so allies do NOT see a co-commander's guidance — correct per engine ask I2. | no change |

## Changes

Commit `c1c7ab5042` (all gate-green): findings 1–13 above, plus:
- `ui/lib/focus.js` + test — the read contract for `ctx.focus` (`FocusView` shape documented in the file header: `primary/subjects/drilled/hovered/openSurfaces/selectionCount`, briefs are `{kind,label,place?}`, no ids/coords). Helpers: `primaryOf(view,{preferHover})` (drilled > hovered-if-opted > single subject > null), `placeOf`, `describeFocus`, `isFocusView`, `focusPortOf(ctx)`.
- **For lane 10**: `focusModel.nlFocus()` now also returns `hovered` (optional field, same brief shape). `nl-focus.ts`/`nl-context.ts` untouched.
- `native-ui.css`: styles for the ledger, AI chip, enemy chip edge (appended section).
- Full-run gates after the change: tsc clean; ui suite 100/100 (7 files, was 88/6); client suite 3771 passed + the 6 then-failing tests fixed and re-run green in the narrow gate (10 files / 172). Coordinator: please run the full client suite once at merge.

## Screenshot plan (for a later browser session; this lane could not screenshot)
1. `crossing_standoff`, player path, rest: expect top-left pill + (only if an AI seat) AI chip under it; top-centre objective chips with `Hold Raven Basin (victory)` / `(#1)` / `(#2)`; both rails empty.
2. Click the pill → ledger opens under it (Your pool / Team pool / Orders draw from / Cost scale / Recent); Esc closes and the pill keeps focus ring.
3. Select enemy tanks → chip reads `Enemy N × line tanks · SPOTTED`, red left edge; drill → "Side: enemy — takes no orders"; only Follow in the action row.
4. Select a named squad near a held region → drill → `Fall back to <Region>`, `Reserve from AI` (or disabled with tooltip reason when no AI); box-select loose units → `Form a squad`.
5. Click `Battle ▾` → focus lands on the active tab; Tab walks tabs (does NOT close); Esc closes and returns focus to the button.


## Proposed C++ patches (UNCOMPILED)

None.

## Out-of-lane findings
- `GroupPosture` (`rts/Server/OrgGroups.h:85`, `connection.ts:2099`): `postureJson` is stored and echoed but read by no gadget or squad module — a wire verb with no effect. Owner: battle-flow / squad lane. Until it has a consumer the HUD must not offer a posture control.
- `game_objectives.lua` still does not publish `holdFrames`/`notBefore` (U1 note) — lane 11; one-line PUBLISHED_FIELDS change would let chips say "2:10 of 3:00".
- Clicking a world objective ring still does not drill (no worker→main pick channel) — needs a `SelectionPort`-shaped op; owner unclear (client core).

## Assumptions / decisions made without asking

- **AI health param names** (lane 5 is adding them; nothing is published yet as of this branch): the chip reads `guidance_<team>_health` (0..1 ratio), `guidance_<team>_health_note` (short string), `guidance_<team>_activity` (one line). All three live in `HEALTH_KEYS` in `ai-hud.ts` — one place to rename if lane 5 chose differently. Absent params render as absent rows, never as "unknown".
- `FocusKind` gained `'ai'` (the chip needs a ref, and DESIGN §3's rule is "a kind exists only with a rung-2 view" — it has one). `lib/focus.js`'s `FOCUS_KINDS` mirrors it.
- The authority ledger is a widget-owned surface (`openSurfaces`), not a `drilled` ref: it is not one of the directive's selectable things, and making it a drill would close a squad's panel when the player checks their budget.
- `Tab` semantics changed for mouse users who click `Battle ▾`: focus now moves into the surface, so a following Tab traverses the tabs rather than closing it; Esc closes. Recorded in the screenshot plan.

## Not done (cut off)
- CSS token audit (task 4): tokens exist (`--nui-*` in `native-ui.css` header) and were reused, but no spacing/z-index/type scale was added and no separate token doc written.
- Tests not written for: `ai-hud.ts` (built, typechecks, mounts via manifest; no unit test), the new focus-hud actions (`squadNameFor`, `nearestFriendlyRegion`, Fall back/Reserve/Form a squad), the authority ledger drill itself (open/Esc/focus-return), and `WidgetContext.focus`.
- `town` kind still has no rung-2 view (towns are not selectable units; needs a producer).
- No `SelectionPort` (partial selection → "select whole squad" still disabled with reason).

## Next milestones
- Add the missing tests above (all happy-dom, same pattern as `drilldown-keyboard.test.ts`).
- When lane 5's health params land, confirm the names in `ai-hud.ts` `HEALTH_KEYS`.
- Token scale + docs (spacing 4/8/12, z-index ladder for menu/edge/toast/global, type xs/sm/md) replacing the magic numbers in `native-ui.css`.
- Clickable world markers (worker→main pick channel) — closes DESIGN §4's last half-truth.
- Publish `holdFrames`/`notBefore` (lane 11) and phrase the hold clock literally.
