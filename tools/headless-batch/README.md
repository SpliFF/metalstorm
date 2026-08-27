# headless-batch

Batch driver + determinism pair-run for `spring-server --headless-run`
(PLAN-headless.md tasks 3-4). No external dependencies — plain Node ESM,
`node:child_process`/`node:fs` only. Full usage docs:
[docs/debugging-tools.md](../../docs/debugging-tools.md#headless-run-mode).

- `batch.mjs` — expand a parameter matrix (profiles x maps x seeds, or any
  other axes) against a config template, spawn one `spring-server
  --headless-run` per combination, collate every dump into one JSONL file.
- `determinism-pair-run.mjs` — run one config twice, diff the two stats
  dumps' `stateHash` sequences. Wired into
  `.github/workflows/headless-determinism.yml` and `make
  test-headless-determinism`.
- `determinism-gate.sh` — the ONE entry point CI should call
  (`make determinism-gate`): pair-run + replay-verify over both the
  PaperTanks fixture and `fixtures/metalstorm-determinism.json`
  (crossing_standoff, strategos both sides). Every arm gates on the
  engine's verdict line AND a zero exit code — T2-b (the CWeaponDefHandler
  static-destruction abort that used to make exit 134 a success) is fixed
  in `rts/Sim/Weapons/WeaponDefHandler.cpp`, so a non-zero exit from a
  completed run is a real defect again.
- `growth-report.mjs` — fit `base + slope×days` to every PLAN-long-uptime §1
  growth surface in a soak ladder's dumps and rule each slope against a
  declared budget. Exits non-zero on an unexplained positive slope.
- `lib/matrix.mjs` — pure cartesian-product + config-patching core, unit
  tested by `test/matrix.test.mjs` (`node test/matrix.test.mjs` or `npm
  test`).
- `lib/growth-fit.mjs` — pure OLS fit + slope ruling behind `growth-report`,
  unit tested by `test/growth-fit.test.mjs`.
- `lib/run-paths.mjs` — where an arm's config/dump/db/log live, and the list
  `batch.mjs` clears before an arm starts. **A re-run into an existing
  `--out-dir` must not inherit the previous run's SQLite file** — `db_bytes` is
  sampled as the size of `main + -wal + -shm`, so a stale database starts the
  series mid-sawtooth — **nor its dump**, which is read back after the arm
  exits and would otherwise be reported as this arm's result. Unit tested by
  `test/run-paths.test.mjs`.
- `ai-veto-loop-run.mjs` — the AI guidance veto loop, closed on a live sim
  (`make test-ai-veto-loop`, PLAN-ai-synced-write task 5): the strategos
  publishes its planner goal ids into synced state, a real human on its team
  vetoes one over the real wire, and the planner must drop that goal while
  still working. Unlike every other arm here it needs a *seated* client
  (`--player`), and therefore `client/`'s WebTransport addon.
- `lib/ai-veto-checks.mjs` — pure verdict for that arm, unit tested by
  `test/ai-veto-checks.test.mjs`. Two of its rules exist because the arm
  passed without them: an AI that stopped issuing directives satisfies "it
  stopped issuing the vetoed one", and the published intent list is a rolling
  window whose entries age out on their own, so only the HEAD of a later
  sample is evidence of a fresh charge.
- `fixtures/` — example templates/matrices, including the CI fixture
  (`papertanks-determinism.json`) and `ai-veto-loop.json`, which is
  deliberately **paced** (`x8`) rather than uncapped: its arm interleaves two
  client sessions and HTTP polls with the sim.
