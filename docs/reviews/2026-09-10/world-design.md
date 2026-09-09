# Review 2026-09-10 — lane 3 `world-design`

## STATUS
in-progress: docs landed (world-layer.md, api.md, api-spec.yaml); next: manual §8/§12, C++ review comments, full findings + patches below.

Branch: `worktree-agent-a5f1defb3ff62c2a4`. Scope: world-layer logic review
(`rts/Server/World*`, `/api/world/*` routes + sweeps in `rts/lobby_main.cpp`),
`docs/world-layer.md` (new), `docs/api.md` + `docs/api-spec.yaml` world
sections, manual §8/§12. No C++ compiled, no browser, per the common brief.

## Findings

(filled in below as the review is written up — see the numbered F-items)

## Changes

- `docs/world-layer.md` — NEW design-of-record: player loop, every rule with
  numbers + config keys, state machines, API per step, boundaries, honest
  not-implemented list, W13–W18 proposals, ranked opportunities.
- `docs/api.md` §World layer — reconciled with the routes: POSTs honour
  `?world=`; `claims/file` answers **400** (not 403) on
  `insufficient_authority`; full error-code sets per route; response shapes
  for every GET and `/me`; the three SSE events.
- `docs/api-spec.yaml` — `components.parameters.worldQuery` added and
  referenced from all 19 world operations; status codes corrected/added;
  200 descriptions name the real shapes.

## Proposed C++ patches (UNCOMPILED — needs a build session)

(below)

## Out-of-lane findings

(below)

## Assumptions / decisions

(below)

## Suggested next milestones

See `docs/world-layer.md` §18 (W13–W18) and §19 (ranked).
