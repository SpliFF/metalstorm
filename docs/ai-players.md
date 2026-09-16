# Writing an AI player

For the developer writing the **third** AI. Two exist: `ai/strategos` (a full
strategic commander) and `ai/garrison` (a defender/NPC built on `ai/lib`). This
document is what they had to learn the hard way — the engine surface an AI
actually gets, the laws it must obey, and the library and harness that mean you
do not start from an empty `main.lua`.

Ground truth for everything below is `rts/Server/AI/` (`AIScriptContext.cpp`
registers the surface, `AIRuntimePool.cpp` ticks it, `AIStateSnapshot.cpp`
builds what it sees, `StateStreamer.cpp::ApplyAICommands` applies what it
says). Where this doc and that code disagree, the code is right and this doc is
a bug.

---

## 1. The shape of an AI

An AI player is a **folder of Lua** under a game's `ai/` directory:

```
data/games/metalstorm/ai/<id>/
    ai.config.lua       the discovery manifest (or ai.config.json)
    main.lua            the entry buffer — defines the global onUpdate
    <anything>.lua      your modules, loaded with require()
    profiles/<name>.lua optional personalities
    tests/*_spec.lua    busted specs (they never load the engine)
```

The **folder name is the id** — what `--ai garrison:1` and the lobby's Add-AI
dropdown use. Discovery (`AIDiscovery.cpp`) scans `content/engine/ai/` first,
then `<game>/ai/`; a game plugin **shadows** an engine one of the same id. A
folder with neither `ai.config.lua` nor `ai.config.json` is not an AI and is
skipped with a log line (which is why `ai/lib/` logs one at every boot —
harmless, and P3 below removes it).

```lua
-- ai.config.lua
return {
    name        = "Metalstorm Garrison",       -- the lobby label
    entry       = "main.lua",                  -- the ONE buffer the VM loads
    description = "...",                       -- shown in the dropdown
    version     = "0.1.0",
    author      = "metalstorm",
    profiles    = { "sentinel", "skittish" },  -- declared; not yet read (P8)
}
```

Entries in a game's `luaai.lua` registry are **labels only** — they have no
runtime. The folder is the AI.

### Seating one

| how | what it looks like |
|---|---|
| CLI | `spring-server --ai <id>:<team>[:<startPos>[:<profile>]]`, repeatable |
| headless manifest | `aiSlots: [{ aiId, team, startPos, profile }]` (`tools/headless-batch/fixtures/*.json`) |
| lobby | Add AI → `room_ai_slots` → the room launcher emits `--ai` |
| mid-game | `Spring.SpawnAIPlayer(team, id)` (`game_ai_caretaker.lua`, e.g. when a human drops) |

**Every AI slot is a real `CPlayer`** with `isAI` set — not a team-level
special case. It gets its own authority pool, `authority_player_<playerID>`,
minted by `PlayerAdded`, and its directives are attributed to it exactly like a
human commander's. That is the design law in one sentence: *an AI plays by the
player rules, pays the player prices, and sees the player's fog.*

The `--ai` fourth field (profile) travels: `server_main.cpp` publishes it as
the modoption `ai_profile_player<playerID>`, and `game_teams.lua` republishes
it as the team rulesParam `ai_profile_<playerID>` (ALLIED_LOS). A scenario's
`ai` section publishes `ai_profile` plus the `ai_slate_*` keys. Read it with
`lib/picture.lua`'s `Picture.profileHint(playerId)`, which checks the per-player
key first and falls back to the team-wide one.

---

## 2. The one callin

```lua
function onUpdate(frame)   -- every 10 sim frames (AIRuntimePool::tickInterval)
end
```

That is the whole callin surface. Specifically:

* **There is no `onInit`.** Boot lazily on the first update (both existing AIs
  do; look at `garrison/main.lua`'s `booted` flag).
* **`onUnitCreated` / `onUnitDestroyed` / `onRelease` are never dispatched.**
  `AIScriptContext::WantsEvent` accepts only `GameFrame` and `HandleEvent` is a
  no-op. Both shipping AIs define the stubs; they are documentation, not
  behaviour. (Finding F4; proposal P5.)
* **It runs synchronously on the sim thread.** `AIRuntimePool::Tick` builds
  your snapshot and calls you inline — "Phase 6 will move this to worker
  threads" has not happened. Your `onUpdate` cost *is* server cost. Budget
  **≤ 2 ms per tick** and self-throttle (§7).
* Your `onUpdate` is `pcall`ed. A raising tick is logged and the AI keeps
  going — which means **a crashing AI looks alive and does nothing**. Report
  your own errors (`lib/reporter.lua` does).

---

## 3. The engine surface

Everything lives on the global `AI` table. This is the complete census as of
2026-09-17.

### Reads

| verb | args → returns | notes |
|---|---|---|
| `getFrame()` | → frame | the snapshot's frame |
| `getMapSize()` | → w, h | elmos |
| `getTeamId()` / `getPlayerId()` | → int | playerId `-1` = unattributed (test AIs) |
| `getRulesParam(scope, key)` | `'game'`\|`'team'`, key → number\|string\|nil | see fog, below |
| `getMapData(name)` | flat leaf name → decoded JSON table | `regions.json`; nil when unconfigured; **raises** on `..` or a path separator |
| `getDefExport(name)` | flat leaf name → decoded JSON table | `power.json` = `defs[defId] = {name,dps,hp,class?,scale?}` |
| `getOwnUnits()` | → `[{id,defId,x,y,z,health,hasCommands}]` | **`health` is a 0-1 RATIO**, not hitpoints |
| `getVisibleEnemies()` | → `[{id,defId,x,z,health}]` | LOS only; no `y` |
| `getRadarBlips()` | → `[{id,x,z}]` | radar only: a position, no type, no health |
| `log(msg)` | → nil | NOTICE level, the AI's own log section |
| `nowMs()` | → monotonic ms | for self-timing your tick |
| `require(name)` | plugin-scoped module loader | dotted → path; no `..`, no absolute paths; caches by name |

### Writes

| verb | args → returns | cost |
|---|---|---|
| `createGroup(unitIds, echelon?)` | → **NEGATIVE token** handle | free; resolves within the same drain batch |
| `issueDirective(handle, spec)` | spec → true | **charged** (§5) |
| `setPosture(handle, json)` | → true | free; needs a REAL group (handle ≠ 0) |
| `sendMessage(str)` | → bool | free; ≤ 2048 B, ≤ 16 per batch |

`spec` is `{ type, priority, shape, params, requestedStrength,
expiresInFrames, idleOnly, within = {x,z,radius} }` — numeric enums mirroring
`rts/Server/OrgGroups.h`. Use `lib/directives.lua` rather than hand-building
them; it holds the enums, the geometry and the two traps below.

* **`expiresInFrames = 0` means IMMORTAL.** A plan re-stated every tick then
  accumulates one live directive per goal per tick, forever. Every directive
  should be mortal; `lib/directives` defaults to 450 frames.
* **`requestedStrength` is in absolute HITPOINTS**, while `unit.health` is a
  ratio. Multiply by the def's hp (`power.json`) before it crosses into a
  demand cap. Getting this wrong makes a demand that can never be satisfied.
* **`idleOnly` defaults to `false`** (since 2026-09-16): an AI directive
  preempts busy units, exactly like a human commander's order (D56). Set it
  `true` only if your AI is deliberately deferent — e.g. a co-commander
  sharing a team with humans who are mid-manoeuvre.

### The sandbox

The VM opens `base`, `table`, `string`, `math`, `utf8` — and nothing else. No
`io`, no `os`, no `package`, **no JSON library**, no `VFS`. `require` resolves
only under your own plugin folder.

---

## 4. Fog: what an AI is allowed to know

An AI cheats by accident, not by malice. The snapshot is built per team and
masked:

* **`getVisibleEnemies`** — full detail, LOS only.
* **`getRadarBlips`** — position only. No def id, no health, no team. A blip is
  a rumour; treat it as low-confidence presence (`lib/picture.lua` gives it
  0.35 confidence and retracts it next tick if it is not re-seen).
* **`getRulesParam('team', …)`** — **your own team only**. Another team's
  params are not in your snapshot at all; there is no verb that could read
  them.
* **`getRulesParam('game', …)`** — since 2026-09-16, only entries published
  with `RULESPARAMLOS_PUBLIC` cross the side boundary (`AIStateSnapshot.cpp`,
  finding F11). A game param that is not public reads as `nil` to you even
  though the sim has a value for it. Do not infer from absence.
* **Never read a player viewport, an input, or another side's anything.** The
  LOD tier in `lib/scheduler.lua` is derived from *region-graph hops to seen
  enemies* rather than from who is looking at what, precisely because the
  latter would be a cheating channel.

Gaps you will notice: there is no `getAlliedUnits`, no LOD level, no
composition counters, no factory/idle state (proposals P5/P6).

---

## 5. Authority: an AI pays like a player

Every directive create goes through the **same** `AllowDirectiveCreate` charge
callin a human's does (`game_authority.lua::ChargeDirective`), reached from the
AI drain. There is no discount and no separate budget.

```
cost = ceil(base_k × base × regionMod × classMod × costScale)
```

* **area-scoped** directive (`handle = 0`, the only shape most AIs ever issue):
  `base = 1`, class `standing` → **flat 2 at scale 1, regardless of force
  size**;
* **group-scoped** (a real group handle): `base = Σ authority_cost_base` over
  the group's LIVE roster, class `directive`;
* `regionMod` is **pinned to 1.0** for directives;
* `createGroup`, `setPosture` and `sendMessage` have **no charge callin at all**
  on the AI drain today.

Do not re-derive this arithmetic. `lib/authority.lua` is the preview: it
prefers the `authority_cost.json` export when one exists and otherwise uses
byte-identical vendored copies of the synced spec, pinned by
`lib/tests/vendor_drift_spec.lua`. A hand-copied cost table is how
`ai/strategos/config.lua` came to price a 14-unit package at 7 or 14 while the
sim charged it 2 (finding F1).

Other things the drain does to you (all mirrored by `lib/actuator.lua`, so you
feel them locally instead of silently losing commands):

* **E6 rate clamp** — at most one directive per group, or per 256-elmo area
  cell, per drain batch. A second one is *dropped*, not queued.
* **Authority veto** — a directive you cannot afford is dropped, exactly as the
  wire handler replies 402 to a human.
* **LuaMsg budget** — 16 messages per batch, 2048 bytes each.

---

## 6. The law: no unit puppetry

**An AI commands through directives, like a commander — never through per-unit
orders.** This is not a style preference; it is the reason authority means
anything. A per-unit path bypasses the charge every directive pays.

Since 2026-09-16 it is structural rather than conventional: `AI.issueCommand`
is **not registered in the production VM at all**
(`AIScriptContext::exposeIssueCommandForTests` is set only by the C++ test
harness, which uses the verb as a readback channel). Directives are the only
actuation path there is.

Build on `lib/actuator.lua` and the floor is structural for you too: it has no
`command`, `unit`, `move` or `attack` method, so an AI that wants to micro has
no verb to reach for. `lib/testing/fake_engine.lua` still registers the verb
deliberately — so that any reach for it lands in `fe.violations` and fails a
spec, instead of merely erroring.

---

## 7. LOD etiquette

You are on the sim thread. Budget **≤ 2 ms per tick** and throttle yourself.

`lib/scheduler.lua` is the throttle: one *strategic* tick per 150 frames at
full alert, stretching ×4 and ×12 (to 1 800 frames) as contact recedes,
measured in region-graph hops. Escalation is immediate; de-escalation waits a
dwell per tier, so a brief sighting does not flip you between tiers.

**The backoff trap, and the fix.** Because escalation is only *observed* on a
strategic tick, an AI that has stretched to a 1 800-frame period cannot notice
it is being overrun for up to a minute — and there is no contact callin to wake
it (F4). `tools/ai-eval` measured exactly that: a dormant garrison took 310
frames to begin withdrawing. So `Scheduler:due(frame, alert)` takes an
**alert** — something you spotted with a cheap poll on an ordinary `onUpdate`
(a jump in `#getVisibleEnemies()` is the usual one) — which forces an early
strategic tick, rate-limited by `minGap` so an alert storm cannot turn you into
a per-frame thinker. `garrison/main.lua` shows the whole pattern in nine lines.

---

## 8. `ai/lib` — do not start from scratch

`data/games/metalstorm/ai/lib/` is engine-agnostic, feature-detecting and
covered by 69 specs. Reach it with a **tracked relative symlink** in your
plugin folder (`ln -s ../lib lib`): the VM's `require` is plugin-scoped and
rejects `..`, but it checks the *name*, not the resolved path, so a symlink
works (F3; P3 fixes it properly).

| module | what it is |
|---|---|
| `engine.lua` | The ONE place that touches the `AI` table for reads. Every verb is feature-detected and `pcall`ed: absent surface degrades to nil/empty, never to an error. No writes live here. |
| `picture.lua` | Everything you know, rebuilt each strategic tick from player-visible data: regions, objective board, economy, per-region ledger (strength/health/idle/by-class), decaying intel, per-region threat. One plain table — hand-build one in a spec. |
| `regions.lua` | The region graph: point-in-polygon, centroid anchors, BFS hops, ownership overlay, nearest map edge. Mirrors `ui/lib/regions.js`. |
| `authority.lua` | The cost preview — the sim's own formula (§5). |
| `directives.lua` | Enums + builders. Mortal by default; area/behaviour shaped only. |
| `actuator.lua` | **The only writer.** Rate-limited (E6 mirror), charged against your tick budget, contained (`pcall` everything), observable (`:stats()`). No unit verb (§6). |
| `scheduler.lua` | Strategic tick + contact LOD + the alert path (§7). |
| `reporter.lua` | Health lines to `AI.log`, plus an `ai.health` wire message. A headless AI has no HUD; this is how you find out what it did. |
| `testing/fake_engine.lua` | The AI VM double, including the drain (token resolution, E6 clamp, real charge, LuaMsg budget, violations, LOS-masked game params). |
| `vendor/` | Byte-identical copies of synced specs, pinned by a drift spec. Re-copy after editing an original. |

The shape that works, from `garrison/main.lua`:

```
onUpdate → cheap poll → scheduler:due(frame, alert)?
              → picture:refresh(frame)      -- engine reads, all of them
              → brain.decide(picture, ...)  -- PURE: no engine, no side effects
              → actuator:directive(spec)    -- the only writes
              → scheduler:observe(); reporter:tick()
```

Keep the deciding pure. That is what lets `garrison/tests/brain_spec.lua` state
30 doctrine cases against hand-built Pictures with no engine at all, and what
lets `tools/ai-eval` score the same brain over a timeline.

---

## 9. Testing an AI

Three levels, cheapest first. All three are hermetic — no server, no build.

```sh
make test-ai-lua      # busted: ai/lib, garrison, strategos
make test-ai-eval     # the scoreboard: every AI × every fixture
```

1. **Pure specs** (`busted tests/` from your plugin root — cwd is the module
   root, exactly as in the runtime). Your decision core takes a Picture and
   returns orders; assert on the orders.
2. **Wiring specs against the fake engine.** Install
   `lib/testing/fake_engine.lua` as `_G.AI`, `dofile('main.lua')`, step frames,
   and assert on what the **drain accepted** — `fe:directives()`, `fe.spent`,
   `fe.refused`, `fe.violations`, `fe.errors`. Every unit test can pass while
   three defects meet each other on the way out to the engine; this is the
   level that catches that.
3. **`tools/ai-eval`** — your AI against recorded/synthetic fixtures, scored on
   directives that survived the drain, authority actually charged, reaction
   latency to declared events, and floor violations; gated against a committed
   baseline. Add your AI to `AI_DIRS` in `run-eval.mjs` and it is in the matrix.
   See `tools/ai-eval/README.md` for the fixture and check vocabulary.

For a live sim, `spring-server --headless-run` with `aiSlots` seats AIs in a
real game, and `make test-ai-veto-loop` closes the AI → human → AI guidance
loop over the real wire.

---

## 10. Known gaps and proposals

Numbering is stable and referenced from code comments.

| id | what | status |
|---|---|---|
| F1 | strategos' hand-copied cost mirror disagrees with the sim | open (lane 4); `lib/authority` is the fix for new AIs |
| F3 | no shared library root — `require` cannot cross plugins | worked around with a tracked symlink; see P3 |
| F4 | event callins documented but never dispatched | open; see P5 |
| **P1** | **unregister `AI.issueCommand` outside the test harness** | **LANDED 2026-09-16** — directives are now the only actuation path |
| — | directive specs honour `idleOnly` | LANDED 2026-09-16 (ai-actuation F5) |
| — | game rulesParams LOS-masked to PUBLIC in the snapshot | LANDED 2026-09-16 (F11) |
| P2 | bake an `authority_cost.json` export so the preview needs no vendored copy | proposed (authority ask A3); `lib/authority` already prefers it |
| P3 | a second `require` search root at `<gamePath>/ai/lib` | proposed (small) |
| P4 | a gadget that republishes `ai.health` as `ai_health_<player>_*` | proposed |
| P5 | fog-filtered event callins (unit destroyed, enemy spotted) | proposed — would remove the poll in §7 |
| P6 | expose what the snapshot already carries: `getAlliedUnits`, `isMoving`, `maxHealth`, LOD level | proposed |
| P7 | publish departure zones as `ms_departure_<team>_{x,z,r}` team params | proposed; `lib/picture` reads them already and falls back to the nearest map edge |
| P8 | generic profile dropdown in the lobby (it is hard-coded to strategos) | proposed; `ai.config.lua` already declares `profiles` |

---

## 11. Checklist for your third AI

- [ ] `ai.config.lua` with `name`, `entry`, `description`, `version`, `author`.
- [ ] `ln -s ../lib lib` (tracked), and `require` your modules through it.
- [ ] Boot lazily inside `onUpdate`; there is no init callin.
- [ ] Decide in a pure module; read only through `lib/engine`; write only
      through `lib/actuator`.
- [ ] Every directive mortal; `requestedStrength` in hitpoints.
- [ ] Throttle with `lib/scheduler`, and give it an alert poll.
- [ ] Never call a per-unit verb. It is not there any more, but your code
      should not want it.
- [ ] Specs for the core, a fake-engine spec for the wiring, a fixture in
      `tools/ai-eval` — and your AI added to that matrix, with the no-op
      control still scoring zero.
