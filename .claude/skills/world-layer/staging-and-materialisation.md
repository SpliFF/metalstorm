# Staging, escrow, and how a commitment becomes a war

Reference for the **world-layer** skill. Read the skill first; this is the
lifecycle in detail, for when a commitment is not doing what you expected.

## The lifecycle

```
world_commit  ──▶  world_staging row, state 'staging'
                   ends_at_world_ms = now + window
                   force moved into a world_escrow row (state: committed)
      │
      │  ... the lobby sweep runs every 30 s ...
      │
      ▼  when ends_at_world_ms has passed
DueStagings ──▶ materialiseStaging ──▶ room created
                   MarkMaterialised(stagingId, roomId)
                   WorldEscrow::MarkEngaged(stagingId, roomId)
                   log: world staging N at POI 'x' materialised as room R
                   SSE: world-staging / materialised
```

On failure the row takes `MarkAttemptFailed` instead: `attempts` increments,
`last_error` records why, and the sweep tries again next pass up to
`stagingMaterialiseMaxAttempts` (**5**) before giving up.

## Reading a commitment that is not moving

Ask, in this order:

1. **Has the window even ended?** `world_pois {poi:'…'}` prints the open
   windows with their `stagingId`. A window with time left is working
   correctly. 12 world-hours is 30 real minutes.
2. **Is the world clock running?** `world_status` — a paused world's clock does
   not advance, so `ends_at_world_ms` is never reached and nothing ever
   materialises. This is the single most common "staging is broken".
3. **Is it failing and retrying?** The `attempts` / `last_error` columns:

   ```sql
   SELECT poi_id, state, attempts, last_error, room_id, ends_at_world_ms
     FROM world_staging ORDER BY created_at DESC LIMIT 10;
   ```

   `no_battle_map` here means the POI has no map to fight on, and no number of
   retries will fix it.
4. **Did it already materialise and you missed it?** `state` is then the
   settled one and `room_id` is a real room — check it with `probe_game`.

## Escrow states

The committed force lives in `world_escrow` from the moment of the commit, not
from the moment the war starts. Four states matter:

| State | Means | Reached by |
|-------|-------|-----------|
| committed | force has left the faction pool, war not yet started | `world_commit` |
| engaged | the war exists and holds this force | `WorldEscrow::MarkEngaged` at materialisation |
| refunded | returned to the pool | `world_commit_cancel`, before contact only |
| voided | the war ended with no verdict | settlement |

`world_commit_cancel` after the window closes answers `cancelled:false` rather
than erroring, because by then the force is engaged and there is nothing to
refund. A commitment belonging to another faction is a 403
`not_your_commitment`.

The settlement rates (`escrowAnnihilatedCaptureFraction` = 0.25,
`escrowWithdrewThresholdFraction` = 0.50, `escrowHeldSpoilsTreasury` = 25) are
in [world-config.md](world-config.md).

## The window length is priced, not fixed

`stagingWindowDefaultWorldMs` is 12 world-hours, but the actual window is
transit-priced from the `origin` POI (`stagingWindowPerTransitMs`), then clamped
to `stagingWindowMinWorldMs` (1 world-hour) and `stagingWindowMaxWorldMs`
(72 world-hours). So committing from far away means waiting longer, and a
commitment with no `origin` takes the default.

Real-time conversion, always: divide world-hours by 24.

| Window | Real wait |
|--------|-----------|
| 1 world-h (the floor) | 2.5 min |
| 12 world-h (default) | 30 min |
| 72 world-h (the ceiling) | 3 h |

## Joining an open window

A second commit at a POI that already has an open window **joins** it rather
than opening a second one. Two consequences, both of which look like bugs:

- The window does not get longer. You inherit whatever is left of it, which may
  be seconds.
- **No notification fires.** The `world-staging` / opened event fired for the
  first commit; yours is silent. Confirm a late commit by reading
  `world_pois {poi:'…'}` and finding your force in the window, never by waiting
  for an event that is not coming.

## The room-id boundary

`world_staging.room_id` and `world_escrow.room_id` are labels written for human
readability. They are **not** foreign keys into `wars` and nothing enforces
them. The `war*` tables and the `world_*` tables are deliberately separate — the
world layer must survive a war's tables being pruned — so:

- Do not `JOIN world_staging ON wars.room_id`. Read one, then the other.
- Do not treat a `room_id` as unique over time. Rooms are recycled.
