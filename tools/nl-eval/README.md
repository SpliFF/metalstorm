# tools/nl-eval — the prompt eval harness

`PLAN-metalstorm-command-language.md` §8, milestone **M7**.

**It is excluded from CI, and that is deliberate.** It needs a real API key and
spends real money on every run. Nothing under `client/` or `tests/` calls the
Claude API — `npx vitest run` and `spring-tests` are hermetic, and must stay
that way. This directory is the one place a live call is allowed to live, and
you have to run it on purpose.

The one exception is `score.mjs`, which is pure (no fs, no network, no clock)
and *is* covered by the ordinary suite via `score.test.mjs`. That split is the
whole design: the scoring is the part most likely to be quietly wrong in a way
that flatters the prompt, so it is tested for free, while the part that spends
money stays opt-in.

## Running it

```sh
export SPRING_NL_API_KEY=sk-ant-...        # or ANTHROPIC_API_KEY
node tools/nl-eval/run-eval.mjs
```

With no key it exits 0 after printing why — so a stray invocation from a script
is a no-op rather than a failure, and a CI job that picks this up by accident
does not go red for the wrong reason.

```sh
node tools/nl-eval/run-eval.mjs --dry-run            # build everything, call nothing
node tools/nl-eval/run-eval.mjs --only commands      # one fixture file
node tools/nl-eval/run-eval.mjs --model claude-haiku-4-5 --effort low
node tools/nl-eval/run-eval.mjs --save-baseline      # freeze today's numbers
node tools/nl-eval/run-eval.mjs --baseline build/nl-eval/baseline.json
```

| Flag | Default | What it does |
|---|---|---|
| `--model` / `SPRING_NL_MODEL` | `claude-opus-5` | Same env var and same default as `NlProxy.cpp`, so a sweep measures what production ships |
| `--effort` / `SPRING_NL_EFFORT` | `low` | `low`\|`medium`\|`high`\|`xhigh`\|`max` |
| `--concurrency` | `4` | In-flight calls. Raise for wall-clock, but see the caveat below |
| `--repeat` | `1` | Run the whole set N times — the way to measure run-to-run flap before setting a gate tolerance |
| `--only <substr>` | all | Restrict to fixture files whose name contains `<substr>` |
| `--baseline <path>` | off | Regression gate. Exit 2 if any category lost fixtures |
| `--tolerance <n>` | `0` | Per-category slack, in fixtures |
| `--save-baseline` | off | Also write `build/nl-eval/baseline.json` |
| `--verbose` | off | With `--dry-run`, print the first request body |

Every run writes `build/nl-eval/report-<timestamp>.json` and
`build/nl-eval/latest.json` — the full per-fixture detail, including which
field paths disagreed. `build/` is gitignored; these are artefacts, not state.

## What it reports

- **Pass rate per category** — one category per fixture file, because that is
  already how the fixtures are grouped by behaviour. An overall rate hides the
  case that matters: a prompt change that trades six working camera verbs for
  six newly-working queries leaves the total flat.
- **Mean field agreement** — how *much* of each envelope was right, so a
  one-slot miss reads differently from a collapse.
- **Latency p50/p95**, over successful calls only. A failed call is excluded
  on purpose: a 401 comes back in 300 ms and would drag the p50 down, which is
  the exact number the model decision turns on.
- **Tokens and spend** for the run, at list price, including the cache
  read/write split — the whole reason §3 puts the schema behind a cache
  breakpoint is that reads are 0.1× input and writes 1.25×, and the run should
  show whether that is actually happening rather than assume it.

⚠️ **Concurrency skews both numbers.** Parallel requests with the same prefix
all pay the cache write, because an entry is only readable once the first
response has started streaming. And p50 under load is not p50 for one player.
For the number that decides the model, run `--concurrency 1`.

## Scoring rules

`say` is ignored (§8: it is prose, and prose does not diff usefully). So are
the other two prose fields — `clarify.question`, and a refusal's `reason`. A
refusal therefore scores on its `kind` alone: whether the model refused is
correctness, why it worded it that way is copy.

Everything else is compared exactly, with two deliberate exceptions:

- `priority: "normal"` and `when: {"type":"now"}` are treated as absent,
  because the schema says in as many words that they mean the same as omitting
  the field.
- `clarify.options` is compared as a set — the client renders them as chips and
  the resolver matches by name, so a different order is the same menu.

Action **order** is significant. §1 says actions run in order and a failed step
ends the remainder, so a reordered pair is a different plan.

## Not built, and why

- **The Batches API.** It would halve the cost of a scored run, but a batch has
  no meaningful per-request latency, and the p50/p95 is the number M7 exists to
  produce. Worth adding as a separate `--batch` mode for pure prompt-regression
  runs once there is a nightly job to spend money on; adding it now would just
  be a second code path with no consumer.
- **A debug route serving the proxy's own prompt.** No longer needed for
  correctness — see below — and it would mean deciding whether such a route
  ships under `SPRING_PROD`.

## The prompt is the same document on both sides

This harness used to carry a JS paraphrase of the rules of engagement, which
lived as C++ string literals in `NlProxy.cpp`. M5 rewrote those literals and
the paraphrase did not follow, so by M7 the two prompts were **4 KB apart** —
every number this harness produced was about a prompt production does not send.

The prose now lives in `data/games/metalstorm/ui/nl-instructions.md`, next to
the schema and the class vocabulary the proxy already loads, and both programs
read those bytes (design pillar 5 — one vocabulary, many consumers).

Verify it, don't assume it. Both sides print an FNV-1a of the assembled prompt:

```sh
node tools/nl-eval/run-eval.mjs --dry-run | grep 'system prompt'
./build/<preset>/spring-tests -tc="the prompt built from the SHIPPED*" -s | grep fnv1a
# 41039 bytes, fnv1a=d22eb3a91b064e3f — on both
```

If they differ, diff the documents rather than guessing:
`--dump-prompt <path>` on this side, `SPRING_NL_DUMP_PROMPT=<path>` on that one.
