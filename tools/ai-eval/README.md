# tools/ai-eval — a headless scoreboard for AI players

Runs every AI plugin against every fixture and reports what **the engine would
have done with its commands**: how many directives survived the drain, what
they cost in authority, how fast the AI answered what happened to it, and
whether it ever reached for a verb the design law forbids.

```sh
make test-ai-eval                     # the gate: scorer unit tests + the matrix
node tools/ai-eval/run-eval.mjs --verbose
node tools/ai-eval/run-eval.mjs --only garrison --fixture contact-reaction
node tools/ai-eval/run-eval.mjs --save-baseline     # after a deliberate change
```

Hermetic: no server, no build, no network — one `lua` process per
(AI, fixture) cell. That is why it can be a gate and not a nightly. The only
prerequisites are `lua` and `node`.

## The pieces

| file | what it is |
|---|---|
| `driver.lua` | Runs ONE AI against ONE fixture and prints the run as JSON. Imitates the runtime: reads the plugin's own `ai.config.lua`/`.json` manifest, gives it a plugin-rooted `require`, calls the global `onUpdate(frame)` every 10 frames, drains after each call. |
| `score.mjs` | **Pure.** Run → metrics → graded checks; and a matrix → baseline verdict. No fs, no spawn, no clock. |
| `score.test.mjs` | The scorer's own suite (`node --test`). A gate that cannot fail is not a gate. |
| `run-eval.mjs` | Spawns the matrix, prints the table, writes `build/ai-eval/latest.json`, applies the baseline gate. |
| `fixtures/*.json` | The situations. `fixtures/world/` holds the shared region graph + power table. |
| `baseline.json` | Committed. What the AIs did last time anyone looked. |

**The seam is `ai/lib/testing/fake_engine.lua`** — the same double the `ai/lib`
and `garrison` suites assert against. It reproduces the sim-thread drain
(`StateStreamer::ApplyAICommands`): same-batch group-token resolution, the §8
E6 one-directive-per-256-elmo-cell clamp, the real `AllowDirectiveCreate`
charge through `lib/authority`, and the 16-per-batch LuaMsg budget. So a
directive counted here is a directive the sim would have *created*, and
"spent" is what it would have *charged* — not a tally of what the AI wished
for.

**One process per cell** because an AI plugin's entry point is a set of
globals (`onUpdate`), exactly as the real VM loads it. Two plugins in one Lua
state would share `onUpdate`; one plugin run twice would carry its cross-tick
memory into the next fixture.

## Writing a fixture

```jsonc
{
    "id": "contact-reaction",
    "why": "why this situation is worth measuring — required, and read by the suite",
    "frames": 1800,
    "pool": 60,                              // starting authority_player_<n>
    "regions": "tools/ai-eval/fixtures/world/three-region.json",   // or an inline table
    "power":   "tools/ai-eval/fixtures/world/power.json",
    "params":  [ { "scope": "game", "key": "region_north_ridge_team", "value": 0 } ],
    "initial": { "own": [ /* AIStateSnapshot unit shape: health is a 0-1 RATIO */ ] },
    "timeline": [
        { "frame": 600,
          "event": { "kind": "contact", "region": "central_basin", "id": "column-seen" },
          "enemies": [ /* ... */ ] }
    ],
    "expect":     [ { "check": "noViolations" } ],          // every AI
    "expectByAi": { "garrison": [ /* ... */ ], "null": [ { "check": "maxDirectives", "value": 0 } ] }
}
```

A `params` entry may carry `"los": "private"` to model a game rulesParam the
snapshot's PUBLIC mask withholds (2026-09-16) — the AI must not see it.

**Checks:** `booted`, `noViolations`, `noErrors`, `maxSpend`, `minSpend`,
`minDirectives`, `maxDirectives`, `hasDirectiveType{type,region?}`,
`hasDirectiveTypeAfter{type,frame,region?}`, `noDirectiveType{type}`,
`reactionWithin{frames}`, `noReaction`, `withdrawsThrough{x,z}`,
`sendsMessage{cmd}`. An unknown name **fails** — a fixture that asserts
nothing because of a typo is worse than one that asserts nothing on purpose.

**Reaction latency** is frames from an event to the first directive anchored in
or next to the region the event happened in. A withdrawal answers an overrun by
pointing *away* from it, so an event may name the types that answer it
wherever they land: `"answeredBy": ["Withdraw", "Fallback", "DefendFront"]`.

**The no-op control.** `content/engine/ai/null` is in the matrix and every
fixture must pin it to zero directives (`score.test.mjs` enforces this). If the
AI that does nothing ever "reacts", the fixture is the signal and every number
in the table is worthless.

## The gate

`run-eval.mjs` exits **0** ok · **1** a fixture expectation failed · **2** a
regression against `baseline.json` · **3** the harness could not run.

A regression is something that got **worse**, never merely something that
changed — an AI that issues a different but equally good plan must not redden
the gate, or the gate gets disabled and then nothing is measured at all:

* a cell in the baseline that is absent now (a fixture or AI silently dropped
  out of the matrix — the classic way an eval goes quiet);
* a check that passed and now fails;
* a new violation or a new raised tick, ever, tolerance or not;
* authority spend above baseline × (1 + tolerance), default 10 %;
* a worst-case reaction slower by more than one 10-frame callin interval, or an
  event that was answered and now is not.

Re-baseline (`--save-baseline`) only when the change was the point, and say so
in the commit.

## What the first run found

Written down because it is the argument for the harness existing:

1. **A dormant garrison took 310 frames to react to being overrun.** Its LOD
   backoff had stretched the strategic period to 600 frames, and the runtime
   dispatches no contact callin to wake it (F4) — so escalation could only be
   *noticed* on a tick that was already a minute away. Fixed by
   `lib/scheduler`'s alert path plus a cheap per-callin poll in
   `garrison/main.lua`; both are spec'd, and the fixture now gates it.
2. **The latency metric itself was wrong** for withdrawals (it scored a
   garrison that withdrew on the same frame as 450 frames late). Hence
   `answeredBy`.
3. **Strategos ignores the objective board and never withdraws.** In
   `outmatched-withdrawal` it keeps assaulting a region the enemy holds while
   six heavies sit on its own ground; in `objective-next-door` it pursues its
   own expansion goal and never looks at the published objective. Neither is
   fixed here — they are strategos-lane findings, recorded as its current
   behaviour in the baseline rather than encoded as expectations, so that lane
   can improve them without fighting a gate that pins mediocrity in place.
