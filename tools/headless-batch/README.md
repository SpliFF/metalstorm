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
- `fixtures/` — example templates/matrices, including the CI fixture
  (`papertanks-determinism.json`).
