# war-surfaces — review 2026-09-10 (lane 14)

## STATUS

complete (wrapped early) — coordinator wrap-up directive received mid-lane.
Pure-module fixes and models landed with tests (commit `7058708333`); the
DOM wiring in `lobby-ui.ts`, the templates/CSS and the settlement/scenario
card models were NOT started. See "Not done".

## Findings (ranked)

1. **Deploy's `seed` outcome is mishandled — FIXED (model) / PROPOSED (call site).**
   `rts/lobby_main.cpp:6870-6910`: since demand-driven seeding the `seed`
   answer carries `room_id` + `reservation`; `lobby-ui.ts:1725-1735` still
   opens the Create Game form and never joins the war the server just built.
   `war-browser.ts` now has `deployIsEnterable` + `formatDeploy` for the
   seeded / seed-failed / unheld-seat / rejoin-fell-through readings.
   Call-site hunk to apply: replace the `outcome === 'join' || 'return'`
   branch with `if (deployIsEnterable(d)) this.joinRoom(d.room_id)`; open the
   form only on `seed` with no `room_id`.
2. **The war browser never sees the Director's phase — PROPOSED C++ + client FIXED.**
   `roomToJson` (`lobby_main.cpp:3701-3860`) publishes `warresume` state
   only; `/api/wars/deploy` skips `archived` wars, so the browser lists wars
   Deploy refuses. Client reads an optional `war.phase`
   (`seeding|open|active|winding_down|resolving|archived`): badge, status
   sentence, `warAcceptsJoiners`, `primaryAction` (Watch-only when over),
   `filterWars` hides archived behind `includeArchived` (kept in My wars),
   `sortMyWars` ranks archived last, `archivedCount` for the reveal chip.
3. **`?play=<retired>` stages a retired war — FIXED (helper) / PROPOSED (main.ts).**
   `/api/rooms/direct` deliberately skips the retired check
   (`lobby_main.cpp:4637-4647`); `play-boot.ts` gains `playRefusal`. Hunk for
   `client/src/main.ts:2284`: `const refusal = playRefusal(scenario, params.scenarioId); if (refusal) throw new Error(refusal);`.
4. **Attach mode parked a suppressed lobby on a blank page — FIXED.**
   `isAttachableRoom` accepted any non-Ended room; a finished room is
   recycled to Filling (1) with no server, so `?play&room=` attached to it
   and nothing ever fired `onGameStart`. Now Loading/Active only.
5. **AI seat with unknown profile / unknown AI id — FIXED (model) / call site PROPOSED.**
   `lobby-ui.ts:190,3403-3409`: hard-coded `STRATEGOS_PROFILES`; a slot whose
   `profile` is not in the table renders `<select>` option 0 ("(default)");
   an `ai_id` the game does not ship renders as a normal row (D19's one-army
   room). `game-picker.ts`: `aiProfilesFor`, `aiProfileOptions` (trailing
   "(unknown profile)" entry, mirrors `renderSideOptions`), `describeAISlot`,
   `STRATEGOS_PROFILE_FALLBACK` with roles + one-line descriptions read from
   `roles.lua`/`profiles/*.lua`. Hunk: replace the `STRATEGOS_PROFILES.map`
   with `aiProfileOptions(aiProfilesFor(slot.aiId, this.availableAIs), slot.profile)`
   (option `title` = tooltip) and add a `.ai-desc` line from `describeAISlot`.
6. **SSE stall: a CLOSED EventSource never reconnects — FIXED (rule) / call site PROPOSED.**
   `lobby-ui.ts:671` `es.onerror` is a no-op; `EventSource` retries only from
   CONNECTING. `war-notice.ts`: `shouldRestartRoomStream(readyState)` +
   `roomStreamRetryDelayMs(attempt)`. Hunk: in `onerror`, if
   `shouldRestartRoomStream(es.readyState)` schedule
   `this.stopPolling(); this.startPolling()` after the delay; keep the timer
   in a field cleared by `stopPolling()`; reset attempt on the first `rooms`.
7. **"One toast, newest wins" loses notices — FIXED (model).** A deploy
   hibernates every war at once; a 3-war player saw one toast. Notice rail
   state in `war-notice.ts` (`pushRailNotice` etc., grouped per war, folded
   repeats, mark-read, cap 12). DOM rendering not done.
8. **Card is a paragraph, not a summary (drill-down directive) — models FIXED.**
   `warCardModel` / `warDrawerModel` + `WORLD_FOCUS_EVENT` contract. Templates
   (`war-entry.html` → card + drawer), CSS and `renderWarList` hunk not done.
9. War reconnect token is stored without its `expires_in`
   (`auth-tokens.ts:252-275`), so `gameAuthToken` presents a 7-day token
   forever — out of lane, see below.

## Changes (commit `7058708333`)

`client/src/lobby/{war-browser,war-notice,game-picker,play-boot,map-list-status}.ts`
plus new tests `war-browser.review.test.ts`, `war-notice.rail.test.ts`,
`game-picker.profiles.test.ts`, `play-boot.refusal.test.ts`. Gate: `tsc` exit 0;
`vitest run src/lobby` 26 files / 539 passed (full-suite baseline before edits:
186 files / 3770 passed, 1 skipped).

## Proposed C++ patches (UNCOMPILED — needs a build session)

- `rts/lobby_main.cpp` `roomToJson`, inside the `PersistentWar` block after
  `wj["state"]`: `if (const auto dr = WarDirector::Load(mapDb, room->id)) { wj["phase"] = WarStateToString(dr->state); if (!dr->poiId.empty()) wj["poi_id"] = dr->poiId; }`
  (field name per the `wars` row; adjust to the real member).
- Same block, when `haveLive`: `wj["next_arrival_sec"]` from the digest's next
  transport arrival frame (needs `WarSummary` to carry it — sim side is
  `game_transports`' schedule via the rulesParam the digest already scrapes).
- `wj["stakes"] = { "escrow": [WorldEscrow rows for room_id → {faction,transports,squads,state}], "claims": [open claims on the war's POI → {faction,state}] }`.
- `GET /api/wars/<room_id>/outcome` (or `war.outcome` on an archived row):
  `WarOutcomeRecord` + per-side escrow settlement (`held|withdrew|routed|annihilated`,
  returned/captured materiel, spoils) + POI owner before/after — the settlement
  card's input.
- `/api/ai/<game>`: add `profiles: [{id,label,role,description}]` read from a
  `profiles` table in `ai.config.lua` (lane 4/6 owns the manifest).
- `/api/games/<id>/scenarios`: add `objectives: [{kind,name,victory}]`,
  `transports: [kinds]`, `expected_length_sec` for the scenario cards.

## Custom-event contract for the world lanes

`window.dispatchEvent(new CustomEvent('springrts:world-focus', { cancelable: true, detail: { roomId, mapId, poiId } }))`
— `poiId` is `''` until the lobby publishes `war.poi_id`; a listener resolves
the POI by `warRoomId` on its graph, calls `WorldScreen.selectPoi(id)` +
`open()`, and `preventDefault()`. The dispatcher falls back to
`worldScreen.open()` when nobody prevents it. Constant + `worldFocusDetail(row)`
in `war-browser.ts`.

## Out-of-lane findings

- `client/src/lobby/auth-tokens.ts:252-275` — store `expires_in` beside the
  war token (`warTokenKey(roomId)+'-expires'`) and have `gameAuthToken` skip an
  expired one (login/auth lane).
- `client/src/main.ts:2284` — apply `playRefusal` (see finding 3).
- `docs/api.md` Wars section quotes `"outcome":"join_war"`; the server emits
  `join|return|seed|no_faction` (`WarDeploy.h:151`). Doc fix.

## Assumptions

- `phase`, `poi_id`, `next_arrival_sec`, `stakes` are optional and absent on
  every lobby today; every reader treats absence as unknown, never as open.
- Archived wars stay visible in "My wars" (the player's own record).
- Tutorials remain allowed through `?play=`.

## Not done

- `lobby-ui.ts` hunks for findings 1, 5, 6 and the card/drawer/rail rendering.
- Templates/CSS: `war-entry.html` card + drawer, notice rail, scenario cards.
- Settlement card + season digest formatting (`war-digest.ts`).
- Scenario card model (`scenario-picker.ts`) with retired reveal.
- Join/precache progress stages (`play-boot.ts` model + room.html).
- `docs/lobby-war-surfaces.md` (event contract is documented above instead).

## Next milestones

1. Land the three `lobby-ui.ts` hunks (deploy join, AI profile options, SSE restart) — each is under 15 lines against tested functions.
2. Publish `war.phase` + `poi_id` from `roomToJson`; then flip the archived reveal on.
3. Card + drawer templates over `warCardModel`/`warDrawerModel`; wire `springrts:world-focus` with the world-screen lane.
4. Notice rail DOM over the rail state; let the staging toast feed it.
5. `GET /api/wars/<id>/outcome` + settlement card; season-digest drill.
6. Precache progress stages on the room screen instead of the bare Loading badge.
