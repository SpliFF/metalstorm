# Lane 8 — skills / agents / claude-config review (2026-09-10)

## STATUS

in-progress: existing-skill drift fixed + splits committed; next = new skills (world-layer, ai-player, metalstorm-design-review, lua-gadget-test, client-gate), agents, claude-config + check-skills.sh.

Branch: `worktree-agent-a49f17a50f181a73a` (cut from main `88d257bce2`, merged main tip on start).

## Findings (ranked)

| # | Sev | Where | What | Status |
|---|-----|-------|------|--------|
| 1 | high | `.claude/skills/spring-test/SKILL.md` (default loop, "Getting a test game", recipe 1) | Contradicted spring-debug/run skills: told the reader `wait:'ticking'` "can never complete browserless" and to *navigate a browser by hand* to `browserUrl`; the canonical path is `launch_scenario({openBrowser:true})` (server.js has `openBrowser`/`browserHeadless`). | FIXED |
| 2 | high | `.claude/skills/game-browser-test/SKILL.md` frontmatter + "Network verification" flow | Named **WebRTC** and `POST /api/rtc/offer` — WebRTC was fully removed (GW7); the route does not exist in `docs/api.md` or `rts/lobby_main.cpp`. Also claimed `/api/rooms` polls every 2 s — the client uses the `/api/rooms/stream` SSE (`lobby-ui.ts:650`). | FIXED |
| 3 | med | `.claude/skills/run-springrts-web/SKILL.md` Gotchas | Claimed `data/games/*` is gitignored — `data/games/metalstorm` is **tracked** (1216 files); only `content/*` and `data/maps/*` are ignored (map assets are force-added). | FIXED |
| 4 | med | `.claude/skills/run-springrts-web/example-cuspbr-corcom.jpg` | A BAR-unit screenshot (`cuspbr`/`corcom`) shipped as "example of a working drive" — BAR/ZK archived 2026-08-02. | FIXED (deleted) |
| 5 | med | `.claude/skills/spring-debug/SKILL.md` tools table | `launch_scenario` row omitted `modoptions`, `skipBriefing`, `waitTimeoutMs`; `generate_scenario` omitted `works, harbour, shanty, coverage, player`; `restart_game` omitted `roomId`; def/cheat verbs (`set_los {enable}`, `get_unit_def {gameId,name|defId}`, …) were an "etc." with no args. | FIXED |
| 6 | med | `.claude/skills/forge/SKILL.md` | "Do NOT create venvs / npm ci" contradicts `tools/forge/README.md` (per-checkout `venv` + `npm ci` are gitignored and required once); `dist/batch-01..04` described as present but it is local-only/gitignored (absent in every worktree). | FIXED |
| 7 | low | `.claude/skills/run-springrts-web/smoke.sh` header | Pointed at a SKILL.md section "Run (agent path)" that no longer exists. | FIXED |
| 8 | low | skills at 306–401 lines each | Reference material (capture/camera, perf traps, lobby flow, window.test table) inflated four skills past the point of being read; split into sibling files with pointers. | FIXED |
| 9 | info | `~/.claude/skills/{task,work}` | Listed as owned but live in the USER dir, not the repo; not editable from this lane (outside the worktree). Reviewed — proposals below. | PROPOSED |
| 10 | info | `.gitignore:100` | `.claude/*` is ignored with only `!.claude/skills/` re-included, so `.claude/agents/` must be force-added. Reason recorded in the ignore comment: "share skills via repo, keep everything else untracked". | PROPOSED (`!.claude/agents/`) |

## Changes

- Split reference material out of the four big skills (line counts 327/401/268/306 → 180/226/225/261): `spring-debug/capture-and-camera.md`, `game-browser-test/{perf-measurement-traps,lobby-flow}.md`, `spring-test/window-test-reference.md`, `run-springrts-web/{hand-rolled-framing,lobby-flow-verify.js}.md`.
- spring-debug: def/cheat verb arg table, 62-tool census line + `check-skills.sh` pointer, `PENDING lane 7` placeholder, "Traps that outlive any one tool" (schema-hash/release binary, 120 s wakeups, `pgrep -f`, headless never checkpoints, `state>=4`, SQLite THREADSAFE=2).
- spring-test: canonical loop is `openBrowser:true`; recipe 1 uses `capture_subject`.

## Proposed C++ patches (UNCOMPILED)

None.

## Out-of-lane findings

- `data/games/metalstorm/LuaRules/Gadgets/tests/guidance_wire_spec.lua:212` — standing RED on main (`guidance.fund applies the rate cap and charges the one-shot amount`: expected 250, got 0). Reproduces standalone from `Gadgets/` (`busted tests/guidance_wire_spec.lua` → 56/1/0). Lane 5 (ai-actuation / guidance gadget).
- `LuaRules/Gadgets/tests/game_scenario_ai_spec.lua` @296/330/359/375 — 3 failures + 1 error from the game root: the **retired** `scenarios/meridian_basin.lua` names defs that no longer exist (`ms_scout_buggy`, `ms_supply_truck`, `fable_airship`, `ms_technical`, `ms_grain_silo`). Either retire the spec's meridian cases or re-point them at `crossing_standoff`. Lane 12 (battle-flow / scenarios).
- `tools/debug-mcp` `node --test` needs `data/games/metalstorm/cache/defs/` (baked) and `data/maps/green_flat_x34_v3` on disk — 7 failures in a fresh worktree (210/217), 217/217 with both symlinked from the main checkout. Lane 7 should either fixture the def cache or skip with a named reason.
- `data/games/metalstorm/ui/vitest.config.js` header advertises the relative `--config ../…` form that dies with `UNRESOLVED_ENTRY`; absolute paths are required. Lane 9.

## Assumptions / decisions

- `task`/`work` skills are user-level (`~/.claude/skills`), not repo files — not copied into the repo (a repo copy would shadow the user's and drift). Proposals only.
- `.claude/agents/*.md` force-added (`git add -f`) rather than editing `.gitignore` (not my lane).

## Next milestones

(filled at the end)
