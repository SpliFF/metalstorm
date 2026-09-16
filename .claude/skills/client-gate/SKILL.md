---
name: client-gate
description: Run the TypeScript client and Node tooling gates — tsc, the client vitest suite, the native-UI suite, the debug-MCP and headless-batch suites. Use before committing any change under client/, tools/debug-mcp/, tools/headless-batch/ or the native UI tree.
when_to_use: Use when the question is "is the client green?" and to get the exact invocations, which are not guessable (absolute --config paths, npm ci in a fresh tree). NOT for Lua suites (that is lua-gadget-test) and NOT for anything that needs a running game (that is spring-test).
user-invocable: false
---

# The client + tooling gates

Five suites. Run the ones your change touches; run all five before a commit
that touches more than one tree.

**Baselines verified 2026-09-17** in a fresh clone at `fc5278b466`.

| Gate | Command (from the repo root) | Green |
|------|------------------------------|-------|
| Types | `cd client && npx tsc --noEmit` | exit 0, no output |
| Client suite | `cd client && npx vitest run` | 208 files / 4257 tests |
| Native-UI suite | see below — **absolute paths required** | 7 files / 100 tests |
| Debug MCP | `cd tools/debug-mcp && node --test` | 313 tests, 0 fail, 7 skipped |
| Headless batch | `cd tools/headless-batch && npm test` | 0 fail |

## Never pipe a gate

```bash
cd client && npx tsc --noEmit > /tmp/tsc.out 2>&1; echo "EXIT=$?"
```

`npx tsc --noEmit | tail -5; echo $?` reports **tail's** exit status, which is
0 whatever tsc did. Redirect to a file, read `$?` immediately, then look at the
file. The same applies to every row in the table: a gate whose result you read
through a pipe is a gate you did not run.

## The native-UI suite needs absolute paths

The JS tree under `data/games/metalstorm/ui/` has its own vitest root, and the
relative form **dies** with `UNRESOLVED_ENTRY` (the config path gets resolved
twice against different bases — the header comment in `ui/vitest.config.js`
still advertises the broken relative form; ignore it):

```bash
R="$(pwd)/data/games/metalstorm/ui"
cd client && npx vitest run --config "$R/vitest.config.js" --root "$R"
```

## Two things that make a fresh tree look broken

- **`npm ci` has not run.** A fresh clone or worktree fails
  `tools/debug-mcp && node --test` with four opaque `testCodeFailure` rows
  whose real cause is `ERR_MODULE_NOT_FOUND: Cannot find package 'fengari'`.
  Run `npm ci` in `tools/debug-mcp` (and in `client/`) first. The failure does
  not name the missing install anywhere in the summary.
- **7 skipped tests in the debug-MCP suite are correct.** They skip *loudly*,
  naming what is absent: `no baked def cache at
  data/games/metalstorm/cache/defs/*` and `no region graph at
  data/maps/<map>/mapdata/regions.lua`. Both are generated artefacts, not
  tracked files. Bake them by running a game once (`launch_scenario`, or
  `smoke.sh --start`), or symlink them from a main checkout. **7 skipped is
  green; 0 failures is the gate.** A skip is never a pass — it is "not
  checked" — so if your change is in that area, bake the cache and re-run.

## Benchmarks are not a gate

Three exist and they are outside both `tsc` and the suite:

```bash
cd client && npx vitest bench --run src/core/member-spacing.bench.ts
#                                  src/core/squad-flush.bench.ts
#                                  src/core/turn-slew.bench.ts
```

Run them when you are changing what they measure. Do not add them to a
pre-commit path.

## On a loaded box

Check `sysctl vm.swapusage` before concluding a suite hangs. When the box is
swapping, treat a backgrounded run's completion as the wake-up and grep the
output file for your own sentinel rather than watching for it — a suite that
takes 40 s unloaded can take minutes, and killing it halfway teaches you
nothing.

## What this skill does NOT cover

- **Lua gadget and AI suites** — the **lua-gadget-test** skill. They are busted,
  not vitest, and the cwd rules are entirely different.
- **The C++ build and its tests** — `make test-cpp`; see **run-springrts-web**.
- **Anything needing a running client or server** — **spring-test** /
  **spring-debug**. Every gate here is offline.
- **Browser-level verification** (does it actually render?) — a green
  `tsc`+vitest says nothing about it: **game-browser-test**.
