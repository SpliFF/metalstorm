# nl-commands — deep review 2026-09-10 (lane 10)

## STATUS

complete — slice 1 (2026-09-10, contract v2) and slice 2 (2026-09-17, the
not-done queue) both landed green. See "Still not done" for what remains, and
why each item is out of this lane's reach rather than merely unfinished.

## Landed 2026-09-17 (slice 2)

- **`nl-fast-path.ts`** — the deterministic pre-LLM claim, tried before
  `callProxy` in `runUtterance`. Closed verb-synonym grammar, EXACT-only name
  matching (never a prefix, never a fuzzy score), a dry-resolve gate that drops
  the claim on any clarify or refusal, and a stand-aside when a question is
  already on screen. A declined sentence goes to the model exactly as before, so
  a bug here costs latency and never a moved army. Absorption on the corpus:
  **19/176 = 10.8%**, across four rules (`verb-name` 8, `verb-elided` 7,
  `withdraw-departure` 3, `verb-name-to-name` 1).
- **60 new golden fixtures** on the contract-v2 boards — `contract-v2.json` (24),
  `focus-elision.json` (22), `injection.json` (14). Corpus is now 176.
- **New local patterns** — `query.events` ("what's happening [at X|there]") and
  the deictic camera ("go there", "show me that"), so the offline path produces
  both.
- **The offline eval that gates** — `nl-offline-eval.test.ts` +
  `offline-baseline.json`, scored by the model arm's own `score.mjs`. No fetch,
  no key, no clock. Baseline: **94/176 exact (53.4%), mean field agreement
  0.829, offline coverage 0.659**. CLI replay via `run-eval.mjs --fake
  offline-parser`; `tools/nl-eval/package.json` with `npm run nl-eval`.
- **`nl-instructions.md` rewritten against contract v2**, scored before the swap
  by `score-instructions.mjs`: **37.3% → 85.1% coverage, 38/85 → 85/85 features,
  nothing lost, nothing stale**. Prompt 41039 → 49845 bytes.
- **The small wiring** — the client sends `contract: NL_CONTRACT_VERSION`;
  `command-console.js` passes `battleMoments` so `events` answers live; the
  stale Sonnet price fixed; direct tests for `focusViewFrom`, elision and the
  `events` deictic; `tools/nl-eval` added to the vitest gate (its tests were in
  NO project — the README's claim that they rode along was false).

### What the eval found before it was committed

Five fast-path defects, all fixed, none of which a unit test written by the same
hand would have looked for:

1. the subject rule ignored `selectionGroupId`, widening an order aimed at the
   selection into a team-wide one on every board without a focus snapshot;
2. a claim echoed the player's capitalisation instead of the index's, so a
   fast-path envelope and the model's differed on a name they agreed about;
3. a subject pronoun ("pull THEM back") was read as no subject at all;
4. "defend Chimera Squad" was reinterpreted as an order TO Chimera with a target
   elided out of the open panel — the place-vs-force refusal turned into an
   order against somewhere the player never mentioned;
5. a bare-pronoun tail was stripped for every verb, so "attack them" with a
   parley proposal open elided to the proposal's PLACE instead of the
   counterparty's force.

That is the argument for the eval existing, stated as five bugs.

## Still not done

- **The four C++ patches** below are still UNCOMPILED proposals. This lane has
  no build session and `rts/Server/**` is read-only to it.
- **`game_transports.lua` does not publish its departure zones** (out-of-lane,
  lane 12). Until it does, `withdraw` with no destination refuses by name on a
  real map — the fixture boards are the only place the behaviour is exercised.
- **The LLM-judged arm.** `run-eval.mjs` still scores by field diff only. An
  arm that asks a model whether two differently-worded refusals mean the same
  thing would raise the ceiling on the prose fields the scorer ignores; it can
  never be the gate.
- **2 envelopes the offline parser builds that its own validator rejects** — a
  ref carrying a colon or a stray comma. The console turns that into a visible
  refusal at execution so no player is misled, but the producer should refuse by
  name instead of building it. Pinned as `offline.invalid` in the baseline so
  the number can only fall.
- **The fast path's known gaps**, each a decision rather than an oversight and
  each pinned by a test: a multi-word verb split by its object ("pull them
  back"), a subject before the verb, any priority or when-gate, every non-exact
  name. Widening them trades a round trip for a new way to be confidently wrong;
  the eval is where that trade gets argued.
- **`guidance.veto` is still unreachable from the model** (finding 9) — it needs
  goal NAMES in the context payload, which pillar 4's no-ids rule makes a design
  question rather than a patch.

## Focus contract for lane 9 (`lib/focus.js` `getFocus()`)

`nl-focus.ts focusViewFrom()` feature-detects `getFocus()` and accepts this shape (names only):
```
{ primary?: Brief|null, subjects: Brief[], drilled?: Brief|null,
  openSurfaces|surfaces: string[], selectionCount|selected: number,
  camera?: { place: string }, asked?: { question: string, options: string[] } }
Brief = { kind: 'squad'|'unit'|'town'|'enemy-force'|'objective'|'area'|'proposal'|'region'|
          'transport'|'civilian', label: string, place?: string, target?: string }
```
`place` must be a name the entity index holds (region/city/landmark/objective place);
`target` a second name the thing is ABOUT (a proposal's counterparty as an enemy-force name).

## Proposed C++ patches (UNCOMPILED — needs a build session)

1. `rts/Server/NlProxy.cpp Call()`: Opus 5 accepts `thinking: disabled` only at effort ≤ high
   and the API skill documents two failure modes for disabled thinking (tool call written as
   text; `<thinking>` tag leakage). Structured outputs constrain the shape here, but the safer
   request is adaptive thinking at low effort: replace `{"thinking", {{"type","disabled"}}}`
   with `{"thinking", {{"type","adaptive"}}}` and keep `effort: low`. Re-measure p50 (M7 bar
   1.5 s) before switching.
2. `NlProxy.cpp ParseRequest()`: `history` entries at odd indexes are replayed as ASSISTANT
   turns verbatim and are client-controlled. Cheap hardening: require each odd entry to parse
   as a JSON object with an `actions` array (`json::parse(..., false)`), else `400 bad-history`.
3. `NlProxy.cpp ParseRequest()`: read an optional integer `contract`; if present and
   `> kSupportedContract` (add `inline constexpr int kSupportedContract = 2;` in NlProxy.h)
   answer `400 {"error":"nl-contract"}`, so a newer client cannot be silently misparsed.
4. `rts/Server/OrgGroups.cpp SanitizeGroupName`: strips control bytes and caps at 32 bytes
   but allows `< > & = , %` — names the NL charset gate (`NAME_CHARSET` in nl-envelope.ts)
   can never address. Align: drop bytes outside `[A-Za-z0-9 _\-'.#/()]` there too.

Scope: `data/games/metalstorm/ui/{nl-instructions.md,nl-response.schema.json,class-vocabulary.json}`,
`tools/nl-eval/**`, `client/src/ui/native-ui/nl-*.ts` (+ `query-engine.ts`, the only
consumer of the `query` kind, and the `nl-fixtures/` world), `client/src/native-widgets/command-console.js`
(NL wiring only). C++ (`rts/Server/NlProxy.*`, `GameHttpRoutes.cpp`) read-only → proposals.

Baseline before edits: `client` tsc clean, vitest 186 files / 3770 passed, 1 skipped.

## Findings (ranked)

1. **HIGH — `patrol` and `screen` were dead verbs in the NL layer.** `TARGET_SHAPES_BY_VERB`
   accepts only `route` for both, a sentence cannot draw a polyline, and
   `nl-resolver.ts resolveTarget` refused every "patrol X" with "use the composer's map arm".
   2 of the 11 advertised verbs could never execute from voice/text. FIXED: a named place
   becomes a closed square ring route (`PATROL_RING_RADIUS`, `ringAround`) compiled through the
   existing `patrol:route`/`screen:route` cases; AI-subject orders use `getAcceptedTargetShapes`
   (D60) so "AI, patrol Osprey Fen" is an entity, not a refused route.
2. **HIGH — "what's happening" had no consumer.** The task brief's story-4 query over events
   had no query op; the HUD already records `BattleMoment`s (`uiStore.getBattleMoments()`).
   FIXED: `query.events { near? }` (contract v2) in envelope/validator/schema, answered by
   `QueryEngine.events` from an injected `battleMoments()` port (LOS-honest by construction —
   the moments are the client's own record), newest-first, ≤5 lines, "near X" filter.
3. **MEDIUM — a force named as a place refused with a lie.** "defend Chimera Squad" →
   "I don't know a place called 'Chimera Squad'" (the golden fixture in focus-deixis.json
   expects a by-name refusal; the offline path disagreed with the prompt). FIXED:
   `resolvePlace` retries the name as a force and refuses "is one of your forces, not a place".
4. **MEDIUM — `withdraw` with no destination refused instead of using the departure zone.**
   FIXED: `resolveTarget(verb, undefined, subject)` → `nearestDeparture(subjectPosition)` over
   landmarks matching `DEPARTURE_NAME` (/departure|extraction|exfil|evac/); refuses by name
   when the map marks none. The transport gadget does NOT publish its zone as a landmark yet —
   see Out-of-lane.
5. **MEDIUM — focus contract was `focus-model.ts`-shaped only.** Lane 9's `lib/focus.js`
   `getFocus()` could not be consumed. FIXED: `NLFocusSnapshot` + `focusViewFrom()`
   feature-detects `nlFocus()`, `getFocus()`, a snapshot, or the wire shape; v2 adds
   `camera.place`, `asked`, brief `target`, kinds `proposal|region|transport|civilian`.
6. **MEDIUM — no target elision.** "attack" with an objective open refused ("needs a place").
   FIXED in `bindFocusReferences`: verbs in `TARGET_ELISION_VERBS` take the drilled panel's
   `place` (binding `elided: true`, confirm-gated). `withdraw`/`escort` excluded on purpose.
7. **LOW — stale price table.** `tools/nl-eval/run-eval.mjs` priced `claude-sonnet-5` at
   $3/$15; current list price is $2/$10 (verified via the claude-api skill 2026-06-24 cache).
8. **LOW — `standing.onSight` and `group.create` are schema-advertised but always refused**
   (no wire slot / no member index). Kept (additive contract), documented in the instructions
   so the model refuses in its own words instead of emitting a field that fails downstream.
9. **LOW — `guidance.veto` is unreachable from the model**: `goalRef` must be a numeric AI
   goal id and the context payload carries no AI goals. Proposed: add `aiGoals: [{n, id}]`
   to `NLContext` once the ai-command panel's proposals are name-addressable (not done —
   would need an id in the payload, which pillar 4 forbids; needs goal NAMES from the AI).
10. **INFO — class census.** `ms_class` values in units/: the 24 vocabulary classes plus
    `fable_showcase` (11 fable_* art fixtures) and `wz_baseline`; both are deliberately
    excluded and pinned by `class-vocabulary.test.ts`. No missing player-facing noun.

## Changes

(slice 1) `nl-envelope.ts` (events op, `NL_CONTRACT_VERSION=2`), `nl-schema.ts` (events
variant, version in description, verb glossary), `nl-resolver.ts` (subject-aware
`resolveTarget`, ring routes, `resolvePlace`, `nearestDeparture`), `nl-executor.ts`,
`nl-interpretation.ts` (absent-target echo for withdraw), `query-engine.ts` (`events`,
`describeMoment`), `nl-focus.ts` (contract v2, elision, events deictic),
`nl-fixtures/fixture-world.ts` (`focus`, `moments` boards).

## Proposed C++ patches (UNCOMPILED — needs a build session)

(pending — see final section once written)

## Out-of-lane findings

- `data/games/metalstorm/LuaRules/Gadgets/game_transports.lua` (lane 12): `departureZones`
  (team → {x,z,radius}) is never published to the client. Proposal: on assignment, emit
  `Spring.SetGameRulesParam('landmark_departure_' .. teamID .. '_x', x)`, `_z`, and
  `_name = 'Departure Zone'` (ALLIED_LOS or team-scoped), so `parseLandmarksFromRulesParams`
  picks it up and `nearestDeparture` resolves. Until then "pull them back" refuses by name.

## Assumptions / decisions

- `query-engine.ts` treated as NL-lane code (it is the `query` kind's only consumer);
  edits are additive (one optional dep, one op).
- Schema version lives in `description` (guaranteed-supported keyword); `$id`/`$comment`
  avoided because structured outputs accepts a documented keyword subset.
- Target elision only from the DRILLED panel, never from the camera place or the selection.

## Next milestones

(pending)
