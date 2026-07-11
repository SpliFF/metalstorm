# GM Operations Runbook

Game-Master operations for persistent games. When a bug or a griefer corrupts a
day of a weeks-long campaign, "restart the game" is not an answer — GMs repair
with a small, audited verb set from a browser dashboard. Design: **PLAN-gm-tools.md**.

## Who can do this

Every GM action requires the **`admin`** role (`users.role == 'admin'`). Grant it
with the lobby's one-shot CLI flag:

```
./spring-lobby --promote-admin <username>   # grants admin, then exits
```

Every admin action is written to the append-only `admin_audit` table
(`Database::LogAudit`) — **audit order is truth**. There is no update/delete verb
for the audit log.

## The dashboard

Served by the lobby at **`GET /admin`** (e.g. `http://<lobby-host>:8011/admin`).
It is a self-contained ops page — *not* a game client — with its own admin login.
It shows:

- **Fleet view** — every running game server with live sim-health: state, players
  online, sim-tick p95, frames-behind-wall-clock, entity count, sim FPS, uptime,
  db size. Alarm badges (`lag`, `db`, `crashed`) flag out-of-band rows. Sourced
  from the shared SQLite `game_servers` + `game_status` + `game_metrics` tables.
- **Per-game drill-down** (click a row) — the tick-p95 timeline, the audit trail
  for that game, a live `inspect` panel, and the verb buttons.
- **Ban list** — account ban/unban.

The dashboard talks to two planes:

- the **lobby** (same origin) for fleet/timeline data and account bans;
- each **game server directly** for the per-game verbs — the browser POSTs to
  `http://<host>:<gamePort>/api/gm/<verb>` with the same admin token. There is no
  lobby→game proxy (the lobby has no outbound HTTP client; lobby↔game
  coordination is shared-SQLite only). This is the same path the game client
  already uses to reach the game server's HTTP plane (e.g. `/api/wt/info`).

> **Production reachability:** admins must be able to reach the dynamic game-server
> ports (default range 9100–10100) over HTTP. Behind a reverse proxy, either
> expose those ports to the admin network or run the dashboard from a host that
> can reach them. (A lobby→game proxy is a possible future addition.)

## The verb set

All verbs are `POST`, `admin`-only (enforced at NetworkServer dispatch **and**
re-checked in each handler), and audited. Unlike `/api/exec`, they are **compiled
into production** — they are the prod GM surface — because each runs a bounded,
server-constructed action, never client-supplied code.

| Verb | Endpoint (game server) | Effect |
|---|---|---|
| **pause** / **resume** | `/api/gm/pause`, `/api/gm/resume` | freeze / unfreeze the sim (`gs->paused`) during investigation |
| **inspect** | `/api/gm/inspect` | read-only JSON state dump (frame, paused, speed, entities, teams, connected players) — scriptable triage |
| **broadcast** | `/api/gm/broadcast` `{message}` | a GM system message to every connected player (renders as a toast) — e.g. "rollback in 2 minutes" |
| **grant** | `/api/gm/grant` `{target:"team"\|"player", id, amount, reason}` | award authority via the game's `GG.Authority.Award`, tagged `admin_grant` (kept out of economy balance metrics). Game-defined — returns `501` if the game has no `GG.Authority` (Metalstorm-only). |
| **kick** | `/api/gm/kick` `{player}` | force-disconnect one player from the game (they can rejoin unless also banned) |
| **rollback** | `/api/gm/rollback` `{frame, reason}` | the flagship — restore the game to an earlier snapshot. **Reason is mandatory.** See below. |
| **checkpoint** | `/api/gm/checkpoint` | take a manual snapshot |
| **snapshots** | `/api/gm/snapshots` | list rollback targets |

Account-level verbs live on the **lobby**:

| Verb | Endpoint (lobby) | Effect |
|---|---|---|
| **ban** | `/api/admin/ban` `{username}` | set `is_banned`, **revoke all the user's sessions immediately**. Login + Basic-auth already refuse banned accounts. |
| **unban** | `/api/admin/unban` `{username}` | clear the flag |

> A currently in-game player who is banned keeps their live game connection until
> they disconnect (the game connection was authenticated once at connect and isn't
> re-checked per frame). To eject them **now**, `ban` them *and* `kick` them from
> the game.

## The workflow

The verbs compose into one repair flow (PLAN-gm-tools §1):

```
report → pause → inspect → rollback and/or grant → broadcast → resume
                                                    (audit trail already written)
```

1. A player reports grief/an exploit/a bug.
2. **pause** the game to freeze the situation.
3. **inspect** (and, when replay lands, pull the replay segment) to confirm.
4. **rollback** to before the damage, and/or **grant** compensation for a verified
   loss.
5. **broadcast** what happened ("rolled back 5 min after an exploit — sorry").
6. **resume**.

For a persistent griefer: **ban** (+ **kick** if they're in a game right now).

## Rollback semantics

`rollback <frame> <reason>` is deliberately careful:

1. The target `frame` must be a real snapshot (else `404`).
2. The **current** state is checkpointed **first** — this is both evidence and the
   undo point, so even a *mistaken* rollback is itself rollback-able (E1).
3. Only then is the target restored.
4. All connected clients full-reboot into the restored state.
5. Two audit rows are written: `gm_rollback_attempt` (before) and `gm_rollback`
   (after, with the pre-checkpoint frame + reason). Order is truth (E4).

> **Status (beta):** the snapshot/restore engine (`GameStateStore`) is owned by
> **PLAN-persistence** and is **not yet built**. Until it lands, `rollback`,
> `checkpoint`, and `hibernate` refuse cleanly (`503`/`501`, audited) rather than
> faking a restore — the dashboard surfaces "persistence layer not built". The
> verb's *sequencing* (pre-checkpoint → restore → full-boot → broadcast → audit)
> is implemented and unit-tested against the store seam today; wiring the real
> engine in is a single interface implementation.

## Transparency policy (E3)

**GM power is visible power.** This is a deliberate abuse deterrent:

- Every GM action is in the append-only `admin_audit` log.
- **Grants are shown in the game's event feed** — players *see* "GM granted team 2:
  500 (compensation: ref #123)". A compromised or abusive admin account can't move
  authority in secret; grants are tagged `admin_grant` and excluded from the
  economy's balance metrics so they can't distort them.
- **Rollbacks require a reason**, which is audited and surfaced to players.

There are intentionally **no** pact-voiding, unit-editing, or fog-lifting verbs —
GMs repair via rollback + grant + ban; they do not puppet the world. Anything
finer-grained goes through `exec` in **dev** environments only (compiled out of
production).

## Metrics & alarms

Each game server writes a `game_metrics` row on a wall-clock cadence (default 60s)
with sim-health fields, plus a final row on shutdown. Storage stays bounded across
weeks-long games: raw rows are kept for 7 days, then downsampled to one row per
hour (PLAN-gm-tools E5 / PLAN-long-uptime S8). Economy velocity/Gini and
long-uptime heap/id-space counters ride the row's `extra_json` and populate once
that (Stage-7) game Lua exists; today the fixed columns are the engine-sourced
metrics. Alarm badges on the fleet view flag lag (frames-behind > 60), oversized
db (> 1 GB), and crashed servers.
