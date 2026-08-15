# tools/nl-eval — the prompt eval harness (skeleton)

`PLAN-metalstorm-command-language.md` §8, milestone **M7**. This is the M4
skeleton: it exists so the shape is settled and so nobody is tempted to put a
live API call in a unit test to get the same coverage.

**It is excluded from CI, and that is deliberate.** It needs a real API key and
spends real money on every run. Nothing under `client/` or `tests/` calls the
Claude API — `npx vitest run` and `spring-tests` are hermetic, and must stay
that way. This directory is the one place a live call is allowed to live, and
you have to run it on purpose.

## Running it

```sh
export SPRING_NL_API_KEY=sk-ant-...        # or ANTHROPIC_API_KEY
node tools/nl-eval/run-eval.mjs
```

With no key it exits 0 after printing why — so a stray invocation from a script
is a no-op rather than a failure, and a CI job that picks this up by accident
does not go red for the wrong reason.

## What it does today

Loads the golden fixtures (`client/src/ui/native-ui/nl-fixtures/*.json`), plays
each `utterance` + `context` through the **real** system prompt — assembled from
the same `nl-response.schema.json` and `class-vocabulary.json` the C++ proxy
loads, so a prompt change is measured rather than guessed at — and reports how
many came back parseable and schema-shaped.

## What M7 adds

- Field-level agreement scoring against each fixture's `expected` envelope,
  with `say` ignored (it is prose, and prose does not diff usefully).
- A regression gate: a prompt or vocabulary change must not lower the score.
- The Batches API for bulk cost — ~50 fixtures per run at 50% of list price.
- Latency and cost dashboards, and the model/effort sweep that decides whether
  the p50 justifies staying on `claude-opus-5` at `low` effort.
