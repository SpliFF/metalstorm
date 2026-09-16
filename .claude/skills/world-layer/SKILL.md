---
name: world-layer
description: Drive the persistent world layer — the POI graph, factions, authority, conquest claims, force commitment and the staging windows that materialise into wars. Use when founding or joining a faction, filing a claim, committing force at a POI, or working out why a staging window did or did not become a room.
when_to_use: Use when the question is about the world BETWEEN battles — who owns a POI, what a claim costs, why a commit has not turned into a game yet, what a season archived. NOT for anything inside a running match (that is spring-debug / spring-test), and NOT for the AI that fights one (that is ai-player).
user-invocable: false
---

# The world layer

The persistent layer the lobby runs underneath the games: a graph of POIs,
factions that own them, authority that pays for acts, and force commitments
that mature into actual wars. It runs whether or not anyone is playing —
`WorldDirector::SeedDefaultWorld` runs at **lobby boot** (`rts/lobby_main.cpp`),
so there is no flag to turn it on and no seeding step to remember. A lobby that
has ever started has a world.

**The loop, and it is only two halves:**

- **Read** with `world_status` / `world_pois` — the clock, the season, who owns
  what, which windows are open.
- **Write** with `world_commit` — commit force at a POI. That is the only verb
  that starts a battle.

Everything else is bookkeeping around those two: `world_factions` to have a
faction at all, `world_claims` to be able to *keep* what you take,
`world_commit_cancel` to back out, `world_notifications` to be told when a
window matured.

## The five things that surprise people

- **A war is not created when you commit — it is created when the window
  ENDS.** `world_commit` opens (or joins) a staging window; the lobby's sweep
  materialises it later. The default window is **12 world-hours**, and the
  world clock runs at **24:1** (`time_ratio_num` on the `worlds` row), so that
  is **30 real minutes** of waiting before a room exists. Nothing is broken.
  See [staging and materialisation](staging-and-materialisation.md).

- **Taking the map is not taking the POI.** Ownership only ever changes through
  a filed, paid claim that wins (`world_claims {action:'file'}`, 25 authority).
  Winning a war with no claim on file changes the war's outcome and not the map.

- **Committed force leaves your pool immediately**, into a `world_escrow` row.
  `world_commit_cancel` refunds it *before contact*; after the window closes the
  force is in a war and the answer is `cancelled:false` — which is a 200, not an
  error.

- **`world_status {detail:'stats'}` is a write.** It settles commander authority
  accrual on the way past. Idempotent, but do not reach for it as the innocent
  read in a tight poll — `detail:'clock'` (the default) is the innocent one.

- **The `room_id` columns in `world_staging` / `world_escrow` are LABELS**, not
  join keys. No `world_*` table is keyed by room, on purpose (hard boundary 1):
  a war's tables and the world's tables are separate universes that exchange
  ids and nothing else. Joining them in a `query_db` will look like it works
  until a room id is reused.

## Tools

All nine take an optional `world` (the `?world=` query id). **Omit it** — it
defaults to the lobby's primary world (the oldest active one), which is what
you want unless this lobby hosts several.

| Tool | What it does | When to use |
|------|-------------|-------------|
| `world_status` | The clock, season and config; `detail` = `clock` (default), `pois`, `stats`, `factions` or `all`. | First call, always. "Is the clock even running?" |
| `world_pois` | The POI graph — nodes with owner, `battleStatus`, open staging windows and war room id, plus edges. Filter with `poi`, `kind`, `battleStatus` (`quiet`/`staging`/`active`). | Finding somewhere to fight, and reading a window's `stagingId`. |
| `world_factions` | `action` = `list` (default, public — also prints the archetype catalogue), `me`, `found` (`name` + `archetype`), `join` (`factionId`), `leave`. | Getting an identity. Nothing else works without one. |
| `world_claims` | `action` = `list` (default), `file` (`poi`), `withdraw` (`claimId`). Filter a listing with `state`. | Claiming, and reading why a claim was refused. |
| `world_commit` | Commit force at a POI: `poi` (required), `transports`, `squads`, `origin`. | Starting a battle. The only verb that does. |
| `world_commit_cancel` | Refund a commitment before contact: `stagingId`. | Backing out of a window you opened. |
| `world_seasons` | The season index, or one season (`number`) plus its archived digests. | Post-season accounting. |
| `world_pause` | `action` = `pause` (default) / `resume`, with a `reason`. Admin. | Freezing the world CLOCK. |
| `world_notifications` | Listen on the chat SSE for `listenMs` (100–120000, default 10000) and return the world events that arrived. `kinds`, `includeOther`. | Watching for a window to mature without polling. |

`world_factions {action:'me'}` has a side effect worth knowing: it **grants the
starter commander** the first time the account clears the founding threshold.
It is the gate check and the grant in one call.

## Founding, and what it costs

A fresh account is credited `startingAuthority` = **100** world authority the
first time a world sees it. Founding needs `foundFactionAuthority` = **100**
*held* and spends `foundFactionCost` = **50**. Those are two separate levers on
purpose ("you must be this senior" and "this is what it costs"), so do not
assume clearing the gate means you can afford to found twice — you cannot.

```
world_factions {action:'me'}                     # authority, membership, gate
world_factions {action:'list'}                   # the archetype catalogue
world_factions {action:'found', name:'…', archetype:'…'}
```

Joining adopts the faction's battle side when the account has none. When the
account and the faction both have a side and they differ, the join is refused
with `side_mismatch` rather than quietly reseating you.

## Committing force

```
world_pois {battleStatus:'quiet'}                # somewhere to go
world_claims {action:'file', poi:'…'}            # 25 authority — do this FIRST
world_commit {poi:'…', transports:2, squads:3}   # opens or joins a window
world_notifications {listenMs:120000}            # wait to be told
```

Your faction comes from your membership and never from the body — there is no
field to commit on someone else's behalf. The refusals are specific and worth
reading rather than retrying: `already_held` (it is yours), `same_side` /
`no_side` (side keys), `no_battle_map` (the POI has no map to fight on),
`window_closed` (the window ended between your read and your write — re-read
`world_pois`, do not retry blind).

**File the claim before the commit.** A claim filed after the war materialises
does not attach to it, and the war then decides nothing about ownership.

## Watching a window mature

`world_notifications` is the honest way — there is no REST route for these
events, so the tool trades your token for a chat stream ticket and reads the
stream for you. Three event kinds arrive: `world-staging`
(opened / materialised / cancelled / failed), `world-poi` (ownership changed)
and `world-season`.

Two traps in one sentence each. **A late commit that joins an already-open
window fires nothing** — silence is not evidence your commit failed. And events
are addressed only to the attacking and defending factions' members and to
accounts with a commander at the POI, so **you see nothing about a war you have
no stake in**.

When you would rather look than listen, the state is in the database:

```sql
SELECT poi_id, state, room_id, attempts, last_error, ends_at_world_ms
  FROM world_staging WHERE state != 'resolved' ORDER BY ends_at_world_ms;
SELECT room_id, state, scenario FROM wars ORDER BY rowid DESC LIMIT 5;
```

`attempts` and `last_error` are where a materialisation that keeps failing says
so; it gives up after 5 tries. The lobby also logs one line per success —
`world staging N at POI 'x' materialised as room R` — findable with
`search_logs {query:'materialised'}`.

## What this skill does NOT cover

- **Anything inside a running war.** Once a room exists it is an ordinary game:
  `probe_game`, `get_logs`, `end_game` — the **spring-debug** skill. Ending a
  war's room is `end_game`, never a world tool.
- **The AI that fights it** — the **ai-player** skill.
- **Pausing a battle.** `world_pause` freezes the world CLOCK only; running
  battles keep ticking. Use `pause_sim` / `set_sim_speed` for a war.
- **Tuning the numbers.** There is no admin route for the staging window or the
  rates; they live in `worlds.config_json`. Changing one means stopping the
  lobby first — see [the config reference](world-config.md), which also lists
  every rate and its shipped default.

## Details in the next file over

- [staging-and-materialisation.md](staging-and-materialisation.md) — the window
  lifecycle, the sweep, escrow states, and how to read a stuck commitment.
- [world-config.md](world-config.md) — every tunable, its default, and the
  stop-the-lobby procedure for changing one.
- The 19 HTTP routes behind these tools are in `docs/api.md` (§World layer);
  reach for them through `api_request` only when a tool has no verb for what
  you need. `/api/world/seasons/latest` is **not** a route — the segment is
  digits only and anything else answers 404 `no_such_season`.
