# world-screen lane — review report (2026-09-10)

## STATUS
in-progress: screen rewrite written; running tsc, rewriting world-staging.test.ts, then pure-module tests.

## Findings (ranked)

1. **HIGH — `world-poi` (ownership change) SSE events never reach the client.** `WorldNotificationSseEvent` (rts/Server/WorldNotifications.cpp:21-30) sends `PoiOwnershipChanged` under the event name `world-poi` with `kind:"ownership"`; `parseWorldStagingEvent` rejected the kind and `lobby-ui.ts:2064` only subscribes to `world-staging`. Parser FIXED (accepts `ownership`, carries `claimId`); the one-line subscriber is out of lane (see Out-of-lane §1).
2. **HIGH — `world-season` broadcast (lobby_main.cpp:9181, on `/api/rooms/stream`) has no client listener.** `parseWorldSeasonEvent` added; subscriber proposal in Out-of-lane §2.
3. **MED — POI graph was fetched only on `open()` and after a commit; the served `remainingWorldMs` countdowns never moved.** FIXED: graph refetched on the 30 s resync beat and every countdown span ticked per second from the locally-ticked world clock (`remainingAfter`, pause-aware — a paused world shows a frozen countdown, which is the truth).
4. **MED — `remount()` called `open()` on EVERY room-list SSE tick, re-fetching `/api/world`, `/api/world/pois` and `/api/world/me` each time.** FIXED: `refreshIfStale()` re-fetches only caches older than `CLOCK_RESYNC_MS`.
5. **MED — race: `refresh()` and `refreshStats()` ran concurrently on open and the POI panel branched on `stats.rank.factionId`; if stats landed second the panel kept "Join a faction to commit force" until reselect.** FIXED: `refreshStats()` re-renders every panel.
6. **MED — no sequence guard on clock/graph/me fetches; a late reply could revert a pause→resume flip.** FIXED: `worldSeq`/`graphSeq`/`meSeq`.
7. **MED — the `deps.post` comment said `lobbyPost` "answers null on a non-200"; it actually returns `resp.json()` for ANY status (lobby-ui.ts:625-635) and throws on a non-JSON body.** The refusal body `{ok:false,error}` was handled by luck. FIXED: `act()` normalises both paths; comment corrected.
8. **MED — no session-state distinction: a 401 from `/api/world/me` rendered as "Join a faction".** FIXED: `session: none|loading|anon|ok`; loading states rendered.
9. **MED — notifications were capped at 20 but never read/pruned and always on-screen.** FIXED: read flags, `markRead`, `pruneNotices` (24 h TTL for read), `clearRead`; alerts badge + drawer.
10. **MED — the pause ledger was invisible: no admin pause control, no explanation of what a pause freezes.** FIXED: `isAdmin` dep gates a Pause/Resume button (`/api/world/pause`), clock chip tooltip explains the freeze; the wiring in lobby-ui is Out-of-lane §3.
11. **LOW — `season` fold on `/api/world` (W12) ignored.** FIXED: season in the clock chip, seasons tab, faction "season standing".
12. **LOW — passive re-renders rebuilt the staging form under a field being typed in (every refresh reset the inputs to 1).** FIXED: passive renders defer while a drawer field has focus; the commit draft is carried across the confirm re-render.
13. **LOW — no confirmation on any paid/irreversible act (commit, claim, withdraw, leave).** FIXED: two-step inline confirm with cost shown.
14. **LOW — `esc()` lacks `'` escaping but attributes are double-quoted throughout.** WONTFIX (no exposure).

## Changes

- `client/src/lobby/world-staging.ts` (NEW, pure): staging rules parse (mirrors `WorldStagingRules::FromWorldConfig` keys), `stagingWindowFor` (verbatim clamp), `cheapestTransitTo` (direct edges only — the server does NOT route), `predictStagingWindow`, `stagingControlState`, `remainingAfter`, `cleanForceField`, `commitErrorText` (moved; re-exported from world-screen.ts).
- `client/src/lobby/world-claims.ts` (NEW, pure): `parseClaims`, `claimEligibility` (explicit-claim rule + defender's shield as "no button on your own POI"), `claimQueue` (server tie-break), `claimExpiresIn`, `claimErrorText`.
- `client/src/lobby/world-ledger.ts` (NEW, pure): parsers for `/api/world` season fold, `/api/world/seasons[/{n}]`, `/api/world/stats` (economy + rosters), `/api/world/factions`, `/api/world/me` membership; `factionErrorText`, `parsePauseAnswer`, `formatDigestLine`.
- `client/src/lobby/world-notifications.ts`: `ownership` + `season` kinds, `claimId`, read/prune/clear/unread, `formatAgo`, `parseWorldSeasonEvent`.
- `client/src/lobby/world-screen.ts`: rewritten around ONE drawer (`poi | faction | ledger | alerts`), quiet default (map + clock chip + faction chip + alerts badge), own markup (`WORLD_PANEL_HTML`) + own stylesheet injection, event surface (`on('select')`, `focus(poiId)`, `attachMap(map)` feature-detecting `on`/`focus`, `poi-selected` CustomEvent both ways). Public API kept: `probe/open/close/toggle/isOpen/remount/refresh/refreshStats/selectPoi/pushStagingNotice/destroy`.
- `client/src/lobby/world-screen.css` (NEW).

## API routes relied on

GET `/api/world` (clock, `season`, `config.stagingWindow*`), GET `/api/world/pois`, POST `/api/world/me`, GET `/api/world/claims`, POST `/api/world/claims/file` `{poi}`, POST `/api/world/claims/withdraw` `{claimId}`, POST `/api/world/staging/commit` `{poi,transports,squads}`, POST `/api/world/staging/cancel` `{stagingId}`, GET `/api/world/factions`, POST `/api/world/factions/found` `{name,archetype,colour?}`, POST `/api/world/factions/join` `{factionId}`, POST `/api/world/factions/leave`, GET `/api/world/stats`, GET `/api/world/seasons`, GET `/api/world/seasons/{n}`, POST `/api/world/pause` `{action}`.
SSE: `world-staging`, `world-poi` (chat stream), `world-season` (room stream).

## Proposed server additions (no C++ edits made)

- `GET /api/world/staging?state=all` — staging HISTORY (materialised/cancelled/failed rows with `roomId`); the ledger's Staging tab can only list open windows today.
- Fold `stagingRules` onto `GET /api/world` (or `/pois`) explicitly instead of the client reading the raw `config` keys.
- `GET /api/world/stats` is O(factions × members) and settles the ledger on read; a lighter `GET /api/world/factions/{id}` (roster + treasury + holdings) would let the faction panel avoid it.
- `/api/world/me` could carry `isAdmin` (or the lobby's role) so the pause control needs no separate wiring.

## Proposed C++ patches (UNCOMPILED)

(none — no server defect found that a client fix could not absorb)

## Out-of-lane

1. `client/src/lobby/lobby-ui.ts:2064` — add beside the `world-staging` listener:
   `es.addEventListener('world-poi', (e: MessageEvent) => { const ev = parseWorldStagingEvent(e.data); if (!ev) return; this.renderStagingNotice(ev); this.worldScreen?.pushStagingNotice(ev); });`
2. `client/src/lobby/lobby-ui.ts` `startPolling()` (room stream `es`, ~line 650) — add:
   `es.addEventListener('world-season', (e: MessageEvent) => { const ev = parseWorldSeasonEvent(e.data); if (!ev) return; this.renderStagingNotice(ev); this.worldScreen?.pushStagingNotice(ev); });` (import `parseWorldSeasonEvent` from `./world-notifications`).
3. `client/src/lobby/lobby-ui.ts:2500` `new WorldScreen({...})` — add `isAdmin: () => <session role === 'admin'>` (the lobby keeps no role field today; `auth-tokens.ts:71` carries `role?` on the token record — thread it through).
4. `client/src/ui/lobby/browser/browser.html:160-186` (lane war-surfaces): the W2 inner markup of `#world-panel` is now replaced by `WorldScreen.mount()`; it can be reduced to the empty shell `<div id="world-panel" class="world-panel" style="display:none"></div>`.
5. `client/src/ui/lobby/lobby.css:1143-1330` — the W2/W8/W11 `.world-*` block is superseded by `world-screen.css` (keep `.staging-notice`). Safe to delete after merge.
6. `client/src/lobby/world-preview.ts` (lane world-map): still works (it mounts browser.html then `open()`, which now replaces the inner markup); `#world-player` no longer exists — the screenshot shows the quiet default plus the POI drawer.

## Assumptions / decisions

- The server does not route marches across the POI graph (`CheapestTransitTo` is direct-edge only); the client mirrors that rather than "improving" it, so the predicted window equals the priced one.
- One drawer, one panel at a time (POI selection replaces whatever was open).
- Confirmations are inline two-step buttons, not `window.confirm` (testable, not blockable).
- `isAdmin` is a dep, defaulting to "not admin" — the pause control is never shown to a session the lobby cannot vouch for.
- Garrison summary = the player's OWN commanders at the POI (`/api/world/me`); the world serves no rival garrison.

## Next milestones

- Wire the three out-of-lane hooks (world-poi, world-season, isAdmin) in lobby-ui.
- Persist alerts across reloads (localStorage keyed by world+account) with the same prune rule.
- Staging history route + ledger Staging tab history.
- Faction panel: governance/voting (Capture 25) once the server has it; loan a commander from the garrison line.
- Offline channel opt-in UI (Web Push `pushManager.subscribe` → `/api/world/push/subscribe`) in the alerts drawer, gated on `/api/world/push/key.enabled`.
- Browser A/B screenshot of the new drawer via world-preview (deferred: no browser sessions this sweep).
