# tools/nl-eval — the prompt eval harness

`PLAN-metalstorm-command-language.md` §8, milestone **M7**.

**It is excluded from CI, and that is deliberate.** It needs a real API key and
spends real money on every run. Nothing under `client/` or `tests/` calls the
Claude API — `npx vitest run` and `spring-tests` are hermetic, and must stay
that way. This directory is the one place a live call is allowed to live, and
you have to run it on purpose.

The exceptions are the pure parts — `score.mjs`, `score-instructions.mjs` and
the offline replay — which touch no network and are covered by the ordinary
suite. That split is the whole design: the scoring is the part most likely to be
quietly wrong in a way that flatters the prompt, so it is tested for free, while
the part that spends money stays opt-in.

(Until 2026-09-17 this paragraph was a claim rather than a fact: `score.test.mjs`
existed but was in no vitest project, and the client suite's `src/**` include
never reached it. There is now an `nl-eval` project in `client/vite.config.ts`,
so `npx vitest run` from `client/` really does cover it. A suite in no gate is
not a gate.)

## The two arms

The model arm (below) can report but can never gate: it needs a key and spends
money, and §8 forbids an API call in CI. So there is a second, **offline** arm
that gates:

```sh
cd client && npx vitest run src/ui/native-ui/nl-offline-eval.test.ts   # the gate
node tools/nl-eval/run-eval.mjs --fake offline-parser                  # the same numbers, as a report
```

It runs every golden fixture through the client's OWN producers — the
deterministic fast path (`nl-fast-path.ts`) first, then the offline parser — and
scores the envelopes with the same `scoreEnvelope` the model arm uses. No fetch,
no key, no clock, no randomness: the same numbers on every machine, every run.
`offline-baseline.json` is committed beside this file and the suite fails on any
category that loses ground.

The CLI form is a REPLAY, not a second implementation: `nl-offline-eval.test.ts`
under `NL_OFFLINE_BASELINE=write` emits `offline-recording.json`, and
`--fake offline-parser` scores that. Recomputing the envelopes in JS would mean
a paraphrase of two TypeScript modules, and this directory has already learned
once what a paraphrase costs (see "The prompt is the same document on both
sides", below).

Three numbers, reported separately because they move independently:

- **pass rate per category** — how much of the corpus the client understands
  with the proxy switched off.
- **fast-path absorption** — the fraction claimed before the model is asked. A
  LATENCY number, never a quality one: a rise is only good news if the pass rate
  held.
- **offline coverage** — the fraction that produced something other than a
  refusal.

## The prompt, scored offline

```sh
node tools/nl-eval/instructions-eval.mjs                          # score the shipped document
node tools/nl-eval/instructions-eval.mjs --candidate draft.md     # compare a rewrite, exit 3 if it is not better
node tools/nl-eval/instructions-eval.mjs --save-baseline
```

This measures **coverage**: for every construct the corpus and the shipped
schema require, does `nl-instructions.md` name it, and does it show it in an
example? It does not measure what the model does with the document — wording,
ordering and emphasis are all invisible to it, and judging those is the
LLM-judged arm's job. It is worth having because the failure it catches is the
one that actually happened twice: the prompt drifting behind the contract.

`instructions-baseline.json` is committed, and `score-instructions.test.mjs`
fails if the shipped document stops teaching something the baseline says it
teaches.


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
| `--fake offline-parser` | off | Replay the recorded OFFLINE arm instead of calling the API. No key, no spend, deterministic |

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
# 49845 bytes, fnv1a=d2ef8c916a5cdee8 — on both
```

(The 2026-09-17 contract-v2 rewrite of `nl-instructions.md` moved this from
41039 / `d22eb3a91b064e3f`. The C++ side reads the same file, so it follows
automatically — the number above has NOT been verified against a build in this
session; it is the JS side's, and a build session should confirm the two agree.)

If they differ, diff the documents rather than guessing:
`--dump-prompt <path>` on this side, `SPRING_NL_DUMP_PROMPT=<path>` on that one.
