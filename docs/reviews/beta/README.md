# pres-verify — browser verification pass

Screenshots and defects for every presentation/UI lane, captured against a live
stack (`spring-lobby` :8011, vite :8012). Two fires: the first did the
2026-09-10 sweep's queue item 9 (screenshot plans for world-map/world-screen/
hud-drilldown/war-surfaces); the second (this one) is the first pair of eyes
on pres-fx, pres-atmos, pres-ui-ds, pres-audio and pres-decals after they
landed on `main`.

## Defect table

| Lane | Screenshot | Defect | Severity |
|---|---|---|---|
| pres-fx | `pres-fx/f001-frame825.jpg` .. `f007-frame855.jpg` (weapon-showcase SAM-vs-fighter sequence) | `gfx.nativeFx` client setting does not exist anywhere in `client-settings.ts` or `game-processor.ts` (grepped clean) — only an internal `globalThis.__nativeFx` bench-count hook exists. PLAN-beta.md's own acceptance criterion ("`gfx.nativeFx=false` must restore the old path") cannot be tested because there is no toggle at all; the old combat-fx/projectile-renderer fallback path may be unreachable in production. | HIGH |
| pres-audio | n/a (log/grep evidence, no screenshot) | `AudioManager.setReverbPreset()` (`client/src/core/audio.ts:610`) is never called from anywhere in `client/src` — grepped every non-test file. Its own doc-comment at `audio.ts:216` claims "Map-load wiring calls `setReverbPreset(name)`…" but no such call site exists in `game-processor.ts`/`map-lighting.ts`/`connection.ts`. Reverb preset genuinely never fires on map load. | HIGH |
| pres-atmos / hud-drilldown | `hud-drilldown/00-rest.png`, `pres-atmos/01-low-angle-crossing-standoff.png` | `crossing_standoff` (map `scorched_crossing_v2.4`) renders a large, hard-edged **black wedge** across a big fraction of the screen — a straight diagonal cutoff, not a natural shadow. Reproduced in two independent captures (different fires, different camera angles). Not reproduced on `meridian_basin` (see `03-meridian-basin-medium.png` / `02-meridian-basin-high.png`, both clean). Looks like a CSM/shadow-frustum or fog-density edge case specific to this map's geometry/lighting — needs the pres-atmos or lighting owner, not a quick fix. | HIGH |
| pres-atmos | `pres-atmos/00-fitmap-crossing-standoff.png` | `window.test.cameraFitMap()` is broken: renders a single flat solid-colour frame (a dark-blue map-silhouette shape with UI bleeding through) instead of an actual top-down view. Reproduced independently this fire against `meridian_basin` (identical solid-fill symptom) before switching to `capture_subject({area})` as the workaround. Blocks any screenshot automation that relies on it. | MEDIUM |
| pres-audio | n/a (code read, `gamedata/sounds.lua:16-26`) | `_far` distance-swap dispatch (silence-to-quiet-far-clip past 900 elmos) is not wired — **already self-documented as an open TOOLING GAP by pres-audio's own handoff comment**, naming the exact fix location (`client/src/core/sound-events.ts`, a file pres-audio doesn't own). Re-confirmed still true on `main`; not a new finding, just verified honest. | MEDIUM (known) |
| pres-ui-ds | `world-map/02-intro-role.png` | Intro slide 3/3 ("Your Role") shows a flat empty dark rectangle where the role/faction image goes — PLAN-beta.md says this should be a gradient placeholder until L-IMAGEGEN delivers real art; it reads as a broken/missing image, not a placeholder. | LOW |
| pres-fx | `bench/weapon-fx` un-tested this fire | The exact scenario the orchestrator named, `?scenario=weapon-fx`, is a single shooter-vs-target pair (not a mixed roster). Used `?scenario=weapon-showcase` instead — it tours mechs/tanks/artillery/SAM/aircraft/bombers in one run, which is what "mixed roster" actually needs. No orange-cube fallback seen in any archetype; muzzle/impact effects render as soft glow shapes (native FX pass confirmed live via console: `[gp] native FX pass up`). "Dust before fire" not rigorously confirmed frame-by-frame. | INFO (substitution, not a defect) |
| pres-atmos | n/a | `dune_reach` / `frost_reach` (named in the old brief) do not exist among shipped maps. Used `meridian_basin` (per this fire's explicit instruction) plus the already-committed `crossing_standoff` shots from the prior fire as the second map. | INFO |

## Not done this fire (stated plainly)

- **pres-fx XL900 perf number** (`profile` render p95 ≤ 8.5 ms on Medium): NOT reproduced. `manifests/xl900_fill.json` only boots `meridian_basin` with a bare 2-player/1-AI roster — the actual 900-unit population from PLAN-perf.md's M19 tranche table has no committed spawn script anywhere in the repo (grepped for `perRow`, `xl900`, `grid-helper` — nothing). Reconstructing it by hand means ~12 `spawn_unit` calls building ~10,600 members, which is exactly the kind of memory/GPU load this machine crashed under earlier this session (see RESUME NOTE). Skipped as a resource-risk call, not an oversight. `browser_test.perfDump()` **does** exist and works (verified) — a future fire with headroom should use it against a real XL900 population.
- **pres-decals figure-8 test** (ribbon trails / float RTT / pattern shader, tasks 1-4): not started — ran out of session budget after the above. `give_order` waypoint driving (the noted TOOLING GAP workaround) was not attempted.
- **pres-atmos water Fresnel/foam close-up**: inconclusive. Every visible water body on `meridian_basin` from an admin/spectator camera sat under fog-of-war "never explored" shading (a crosshatch dither + blue desaturation, present identically at Medium and High, so it's FOW rendering, not a quality-preset artifact) — couldn't get a clean, LOS-lit shot of water in the time available. `water-surface.ts`'s own log line (`water plane: procedural scroll-bump + Fresnel + shore foam`) confirms it's wired, just not visually confirmed here.
- **hud-drilldown screenshot plan items 2-5** (ledger open, enemy-force chip, squad drill actions, Battle▾ tab focus): only item 1 (rest state) has a shot. Plan lives at `docs/reviews/2026-09-10/hud-drilldown.md` §Screenshot plan.

## Fixed this fire (≤10 lines, already committed)

- `client/src/lobby/world-map.ts`: collapsed a bidirectional world-graph edge seeded as one row per direction (was doubling every POI's transit list and the map's drawn lines). Test added in `world-map.test.ts`.
- `client/src/lobby/world-screen.css`: `.world-tab` buttons get `appearance:none` + a `:focus-visible` ring (native button chrome leaking through, no keyboard focus cue).

## check_unit_defs.py (main, this fire)

`0 FAIL, 41 WARN` — no failures. Warnings are the pre-existing categories (footprint-vs-model-extent, member-clearance interpenetration risk, one uncarried weapon def, 30 unreferenced shipped models, and 22 ASSETS.md duplicate-line notes for already-covered `_far`/close pairs). Nothing new; not re-litigated here.

## Screenshots

- `world-map/00`–`10` — welcome → login → intro (3 slides) → hub → world open → POI click → a real bug found (doubled edges) and its fix verified.
- `world-screen/00`–`03` — ledger tabs, a keyboard-focus bug found (`.world-tab` native chrome) and its fix verified.
- `hud-drilldown/00`–`01` — rest-state HUD (authority bar, objectives, mentor card, canvas). Plan items 2-5 not done (see above).
- `war-surfaces/00` — smoke-check only; per `docs/reviews/2026-09-10/war-surfaces.md` the DOM/CSS work for this lane was never started, so there was nothing new to screenshot.
- `pres-atmos/00`–`01` — `crossing_standoff`, from the prior fire; `01` is the black-wedge defect above. `02`–`03` — `meridian_basin` High/Medium, this fire: sky dome + desaturated-horizon fog confirmed clean on both presets.
- `pres-fx/f000`–`f007` — `weapon-showcase` SAM-vs-fighter engagement, 8-frame sequence: native FX visible (soft glow muzzle/impact), no orange-cube fallback.

## TOOLING GAP

- `window.test.cameraFitMap()` renders a broken solid-colour frame (see defect table). Workaround used: `capture_subject`/`capture_sequence` with an explicit `area`.
- No committed script reproduces PLAN-perf.md's XL900 (900-unit) population — `browser_test.perfDump()` is the right tool once one exists, but nothing builds the roster today.
