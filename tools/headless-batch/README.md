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
- `lib/matrix.mjs` — pure cartesian-product + config-patching core, unit
  tested by `test/matrix.test.mjs` (`node test/matrix.test.mjs` or `npm
  test`).
- `fixtures/` — example templates/matrices, including the CI fixture
  (`papertanks-determinism.json`).
