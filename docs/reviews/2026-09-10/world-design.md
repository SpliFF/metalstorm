# Review 2026-09-10 — lane 3 `world-design`

## STATUS
complete (wrapped early) — docs, manual §8/§12, C++ review comments, findings + patches all landed.
Not done: (1) no C++ patch applied — P1–P12 are uncompiled diffs needing a build session; (2) the proposed doctest cases live in `world-design-proposed-tests.md` as text, not in the test target; (3) no ARCHITECTURE.md hunk (merge hotspot — the manual and api.md link to `docs/world-layer.md` instead).

Branch `worktree-agent-a5f1defb3ff62c2a4` (cut from `main` `88d257bce2`, merged
to main's tip at start). Scope: logic review of `rts/Server/World*` and the
`/api/world/*` routes + sweeps in `rts/lobby_main.cpp` (read, not compiled);
`docs/world-layer.md` (new); `docs/api.md` + `docs/api-spec.yaml` world
sections; manual §8/§12 world bullets. No browser, no compile, per the brief.

## Findings (ranked)

Severity: **H** = wrong outcome in production play, **M** = latent
corruption / exploit / stuck state, **L** = hygiene. Status: PROPOSED = patch
below (uncompiled), DOC = documented as a known gap, FIXED = in this branch.

| # | Sev | Where | What is wrong | Status |
|---|---|---|---|---|
| F1 | **H** | `rts/Server/WorldStats.cpp:179` (`AttributeSettlement`) | `settlement.factions` is `war_outcome.winnerFactions` = **side keys** (`compact`/`union`, `WarStateSim.cpp:239`); `c.factionId` is a **world faction slug**. They never match in production, so every commander at a settled POI receives `authorityPerDefeat` (3), never `authorityPerVictory` (12). `tests/test_world_stats.cpp:243` passes faction ids as winners, which is why the suite is green. | PROPOSED P1 + comment |
| F2 | **H** | `rts/Server/WorldSeasons.cpp:285-294` (`ArchiveSeason`) | The digest buckets `settlementsWon` by the side keys in `factions`, and the economy totals by world faction id — one `world_season_digests` table, two id spaces; the archive route serves side keys as `factionId`. | PROPOSED P2 + comment |
| F3 | **M** | `rts/Server/WorldSeasons.cpp:363-368` (`Tick`) | Rollover = three separate transactions. A crash between `CloseSeason` and `InsertSeason` leaves no active season; the next `Tick` takes the `!current` branch and inserts season **1** again → `UNIQUE(world_id, season_number)` refuses it forever → the world has no season, wars are never stamped, `season_end` never fires. | PROPOSED P3 + comment |
| F4 | **M** (design) | `rts/lobby_main.cpp:8915-8936` | A war that ends with **no in-sim winner** (`season_end`, operator retire — no `war_outcome` row) settles the expedition as `annihilated`: 75 % destroyed, 25 % captured by the POI owner. The player did nothing wrong; the season boundary did it. | PROPOSED P4 |
| F5 | **M** | `rts/Server/WorldStaging.cpp:292-311` (`Commit`, join path) + `lobby_main.cpp:5371` | The join `UPDATE … WHERE state='staging'` never checks `sqlite3_changes()`. If the staging sweep (main thread) materialised the row between `OpenFor` and the UPDATE, zero rows change, the reload returns a `materialised` row, the route answers `ok/joined`, then opens a **new `committed` escrow row** that `MarkEngaged` already passed → force debited, never engaged, never settled, never refunded. Also: staging write and escrow open are not one transaction (an escrow failure only logs). | PROPOSED P5 + comment |
| F6 | **M** (exploit) | `rts/Server/WorldStaging.cpp:319-328` | `origin` is unverified: name the POI adjacent to the target (owned or not, existent or not) and the warning window is the 1-hour floor from anywhere. Pricing is single-edge: a 2-hop march gets the 12 h default, which can be *less* than the real 1-hop route (33 h Randtown→Driftreach). The MST seeder makes most pairs non-adjacent, so most windows are the default today. | PROPOSED P6 + comment |
| F7 | **M** | `rts/Server/WorldStaging.cpp:243-248` (`DueStagings`) | Lowering `stagingMaterialiseMaxAttempts` below a row's `attempts` skips it forever: it stays `staging` (POI shows `staging`), its escrow stays `committed`, its force stays debited. The test only asserts the skip. | PROPOSED P7 + comment |
| F8 | **M** | `rts/Server/WorldConquest.cpp:433-442` (`SettleWar`) | `ResolveClaim(won)` and `SetPoiOwner` are two transactions. If `SetPoiOwner` fails after the flip, the claim is `won`, a replay finds nothing open, and the POI never transfers. | PROPOSED P8 + comment |
| F9 | **M** (UX) | `rts/Server/WorldStaging.cpp:274-284` | A faction with an empty `side_key`, or attacking a POI owned by a faction on the **same** side, is refused only at materialisation (`lobby_main.cpp:6608,6662`) — after the whole window, five attempts (~50 s) and a `failed` alert to the defender who was warned for nothing. | PROPOSED P9 |
| F10 | **M** (design) | `WorldConquest.cpp:196-227`, `WorldFactions.cpp:560-593` | Account world authority has **no income**: 100 start, −50 found, −25 per claim (50 % back on loss). Two claims after founding and the purse is empty until a claim fails. The conquest rule goes quiet for any active player. Not a code bug — a missing rule; W13 in `world-layer.md` §18 adds `authority_income` from settlements mirroring the commander accrual. | DOC (manual §12, world-layer §17) |
| F11 | L | `rts/Server/WorldEconomy.cpp:252-254` | `balanceBefore` is read outside the tick's write transaction; a `war_spoils` row appended in between is decayed one tick late. Harmless at 1 %/day. | comment |
| F12 | L | `rts/Server/WorldDirector.cpp:116-157` (`WorldDefaults::ToJson`) | The three escrow rates (`escrowAnnihilatedCaptureFraction`, `escrowWithdrewThresholdFraction`, `escrowHeldSpoilsTreasury`) are not written into a new world's blob; operators tuning `config_json` will not see them. | PROPOSED P10 |
| F13 | L | `rts/lobby_main.cpp:5545-5550` | `claims/file` maps `insufficient_authority` to **400**; `factions/found` maps the same token to 403. `docs/api.md` said 403 for both. Docs now say 400 (the truth); the patch makes it 403. | docs FIXED, PROPOSED P11 |
| F14 | L | `rts/lobby_main.cpp:8920-8927` | The escrow `attackerWon` test hand-rolls `",list,".find(",key,")` while `SettlementNamesFaction` (which trims spaces) exists; fine today because `WarStateSim` joins with `","`, brittle if the joiner ever gains a space. | PROPOSED P4 (uses the helper) |
| F15 | L | `rts/Server/WorldStaging.cpp:289-291` | Two attacker factions **on the same side** gathering against one POI produce two rows and two wars on the same map (both field the same attacker side vs the same defender); `PoiForMap … LIMIT 1` then settles both at the POI. Legal by the header's "two rows" rule but odd; W15's `joint_staging` is the designed answer. | DOC |
| F16 | L | `rts/Server/WorldMapSeeder.cpp:19-28` (`MergeDefaults`) | `config.value("poiBudgetInitial", int)` throws `nlohmann::type_error` if an operator types the key as a string — at lobby **boot**, uncaught. Every other rules struct uses per-key `is_number()` guards. | PROPOSED P12 |
| F17 | L | `rts/Server/WorldSeasons.cpp:358` | `seasonLengthWorldMs <= 0` rolls a season over on **every** tick (every 60 s) — no "disabled" reading, unlike `claimExpiryWorldMs`. | PROPOSED P3 (guard) |
| F18 | L | `rts/Server/WorldConquest.cpp:196-227` | A claim can be filed by a faction with no `side_key` (can never win — 50 % lost on expiry) and on a POI with no battle map (no war can ever settle it). Refuse `no_side` / `no_battle_map` at filing. | PROPOSED P9 |
| F19 | L | `rts/Server/WorldEconomy.cpp:7`, `WorldSeasons.cpp:6` | `#include <map>` in `rts/` — the tree's own rule is `<unordered_map>` because `rts/Map/` can shadow the header (`SqliteThreading.h` says so explicitly). Compiles today; fragile under include-path changes. | note |
| F20 | L | `rts/lobby_main.cpp:5344-5345` | `transports`/`squads` are unbounded (`2147483647` accepted); with no holdings this is only a ledger oddity, but `EncodeWorldCommitModOption` hands the number to the battle gadget. Cap at `stagingMaxTransportsPerCommit` (16) / `stagingMaxSquadsPerCommit` (64) until W13. | PROPOSED P9 |

Things checked and found **correct** (worth recording so the next reviewer
does not re-derive them): pause-ledger merge + half-open window arithmetic
(overlap counted once, open interval ends "now", pre-epoch reads the epoch);
economy catch-up is closed-form and idempotent, cursor planted on first tick;
escrow exactly-once via state-guarded flips inside one transaction, replay
writes nothing; `Release`'s read/flip agreement check; conquest determinism
(earliest `filed_at_world_ms`, rowid tie-break), refunds clamped to
`[0, cost]`, expiry before resolution, defender's shield; the clock-frozen
pause propagates to expiry/staging/seasons/decay with no extra state; all
writes go through `SqliteWriteTransaction` (re-entrant, `BEGIN IMMEDIATE`);
route auth: every act requires a token, faction acts read membership never
the body, `pause` is admin-only, push subscribe validates key lengths, the
dispatcher's `SafeInvoke` turns JSON shape errors into 500 rather than a
crash; the SQL indexes serve every hot query (`idx_world_staging_open`,
`idx_world_escrow_room`, `idx_world_poi_claims_poi`, the UNIQUE award
index).

## Changes (this branch)

| Commit | What |
|---|---|
| `2076d023aa` | `docs/world-layer.md` (new, 400 lines): player loop, every rule + config key, state machines, sweeps, schema, honest gap list, W13–W18 proposals, ranked opportunities. `docs/api.md` §World layer reconciled with the handlers (POSTs honour `?world=`; 400 vs 403; complete error sets; response shapes for every GET + `/me`; SSE events). `docs/api-spec.yaml`: `components.parameters.worldQuery` on all 19 world ops; status codes and shapes corrected. |
| `2f747dd482` | `REVIEW 2026-09-10` comment markers at F1/F2/F3/F4/F5/F6/F7/F8/F11/F12 sites (comments only). Manual §8 (window clamps, escrow release/capture victor/spoils number, claim rules incl. "not tied to a commitment", economy numbers + cadence, pause scope, season stamps, the stat family with numbers) and §12 (six new gaps). |
| (this) | This report + `world-design-proposed-tests.md`. |

Gates: no C++ touched beyond comments (verified: the diff's only non-`//`
line is a replaced comment line); YAML validated with Ruby's parser (all 19
world operations carry the `worldQuery` ref). No client/Lua/Python code
touched, so no other gate applies.

## Proposed C++ patches (UNCOMPILED — needs a build session)

All diffs are against this branch's tree. They are independent; land P1–P5
first (they fix wrong outcomes), P6–P9 next (exploit/stuck-state), P10–P12
last (hygiene). Doctest cases for each are in
`docs/reviews/2026-09-10/world-design-proposed-tests.md`.

### P1 — victory attribution compares side keys to side keys (F1)

```diff
--- a/rts/Server/WorldStats.h
+++ b/rts/Server/WorldStats.h
@@ struct WorldAuthorityAttribution
+/// (faction id → side key) pairs, so `AttributeSettlement` can compare a
+/// commander's WORLD faction against the SIDE keys a settlement names.
+struct WorldFactionSideKey { std::string factionId; std::string sideKey; };
 std::vector<WorldAuthorityAttribution> AttributeSettlement(
     const WorldSettlementRecord& settlement,
     const std::vector<WorldCommanderRecord>& commandersAtPoi,
+    const std::vector<WorldFactionSideKey>& factionSides,
     const WorldStatRules& rules);
--- a/rts/Server/WorldStats.cpp
+++ b/rts/Server/WorldStats.cpp
@@ std::vector<WorldAuthorityAttribution> AttributeSettlement(
-    const WorldStatRules& rules) {
+    const std::vector<WorldFactionSideKey>& factionSides,
+    const WorldStatRules& rules) {
     std::vector<WorldAuthorityAttribution> out;
+    auto sideOf = [&](const std::string& factionId) -> std::string {
+        for (const auto& fs : factionSides)
+            if (fs.factionId == factionId) return fs.sideKey;
+        return {};
+    };
     for (const auto& c : commandersAtPoi) {
         ...
-        const bool won = SettlementNamesFaction(settlement.factions, c.factionId);
+        const std::string side = sideOf(c.factionId);
+        const bool won = !side.empty() &&
+                         SettlementNamesFaction(settlement.factions, side);
@@ int WorldStats::AccrueFromSettlements(
     const auto commanders = CommandersFor(db, worldId);
     if (commanders.empty()) return 0;
+    std::vector<WorldFactionSideKey> sides;
+    for (const auto& f : WorldFactions::ListFor(db, worldId))
+        sides.push_back({f.factionId, f.sideKey});
     ...
-        for (const auto& award : AttributeSettlement(s, commanders, rules)) {
+        for (const auto& award : AttributeSettlement(s, commanders, sides, rules)) {
```
Test fixture change: `tests/test_world_stats.cpp` `Settle()` must pass side
keys (`"compact"`) as winners and the `Found()` helper must bind a side key;
the existing "victory awards 12" case then fails before the patch and passes
after — that is the regression test.

### P2 — the season digest names world factions (F2)

```diff
--- a/rts/Server/WorldSeasons.cpp
+++ b/rts/Server/WorldSeasons.cpp
@@ void ArchiveSeason(
-    for (const auto& s : WorldDirector::SettlementsFor(db, closing.worldId)) {
-        if (s.settlementId <= closing.settlementCursorStart) continue;
-        const auto winners = SplitFactions(s.factions);
-        if (winners.empty()) { buckets[""].settlementsWon += 1; continue; }
-        for (const auto& f : winners) buckets[f].settlementsWon += 1;
-    }
+    // Per WORLD faction: a settlement is "won" by every faction on the
+    // winning side that had force engaged or a claim resolved `won` by it.
+    // Side keys go to a separate `side:<key>` bucket so the archive still
+    // says which side took the field.
+    std::unordered_map<std::string, std::string> sideOf;
+    for (const auto& f : WorldFactions::ListFor(db, closing.worldId))
+        sideOf[f.factionId] = f.sideKey;
+    for (const auto& s : WorldDirector::SettlementsFor(db, closing.worldId)) {
+        if (s.settlementId <= closing.settlementCursorStart) continue;
+        const auto winners = SplitFactions(s.factions);
+        if (winners.empty()) { buckets[""].settlementsWon += 1; continue; }
+        for (const auto& side : winners) buckets["side:" + side].settlementsWon += 1;
+        for (const auto& c : WorldConquest::ClaimsFor(db, closing.worldId))
+            if (c.settlementId == s.settlementId && c.state == WorldClaimState::Won)
+                buckets[c.factionId].settlementsWon += 1;
+        for (const auto& [fid, side] : sideOf)
+            if (!side.empty() && SettlementNamesFaction(s.factions, side) &&
+                WorldEscrow::EngagedOrSettledForRoom(db, s.roomId, fid))  // new helper: any escrow row of `fid` with room_id = s.roomId
+                buckets[fid].settlementsWon += 1;
+    }
```
(`WorldEscrow::EngagedOrSettledForRoom` is a one-statement `SELECT 1 FROM
world_escrow WHERE room_id=? AND faction_id=? AND state IN ('engaged','settled')`
— a label read on a world table, not a war-table join.) Update
`test_world_seasons.cpp:232` to found factions with side keys and settle with
side keys; add the `side:` bucket assertion.

### P3 — atomic rollover + never re-open season 1 (F3, F17)

```diff
--- a/rts/Server/WorldSeasons.cpp
+++ b/rts/Server/WorldSeasons.cpp
@@ WorldSeasons::TickResult WorldSeasons::Tick(
+    if (rules.seasonLengthWorldMs <= 0) return result;  // seasons disabled, like claimExpiryWorldMs
     const auto current = CurrentSeason(db, worldId);
     if (!current) {
-        InsertSeason(db, worldId, /*seasonNumber=*/1, nowWorldMs, 0, nowRealMs);
+        // A world may have ENDED seasons but no active one (a crash between
+        // CloseSeason and InsertSeason on an older build): continue the
+        // numbering rather than colliding with season 1.
+        int next = 1;
+        for (const auto& s : SeasonsFor(db, worldId)) next = std::max(next, s.seasonNumber + 1);
+        InsertSeason(db, worldId, next, nowWorldMs, MaxSettlementId(db, worldId), nowRealMs);
         return result;
     }
     ...
-    ArchiveSeason(db, *current, nowWorldMs, nowRealMs);
-    CloseSeason(db, worldId, current->seasonNumber, nowWorldMs);
-    const int64_t cursorForNext = MaxSettlementId(db, worldId);
-    const int nextSeasonNumber = current->seasonNumber + 1;
-    InsertSeason(db, worldId, nextSeasonNumber, nowWorldMs, cursorForNext, nowRealMs);
+    const int nextSeasonNumber = current->seasonNumber + 1;
+    const bool committed = SqliteWriteTransaction(db, "WorldSeasonRollover", [&] {
+        ArchiveSeason(db, *current, nowWorldMs, nowRealMs);   // re-entrant: joins this txn
+        if (!CloseSeason(db, worldId, current->seasonNumber, nowWorldMs)) return SQLITE_ERROR;
+        if (!InsertSeason(db, worldId, nextSeasonNumber, nowWorldMs,
+                          MaxSettlementId(db, worldId), nowRealMs)) return SQLITE_ERROR;
+        return SQLITE_OK;
+    });
+    if (!committed) return result;
```
(`InsertDigest` returning false inside `ArchiveSeason` should also propagate
— change `ArchiveSeason` to return `bool` and fail the transaction.)

### P4 — a no-winner ending voids the escrow instead of annihilating it (F4, F14)

```diff
--- a/rts/Server/WorldEscrow.h
+++ b/rts/Server/WorldEscrow.h
-enum class WorldEscrowOutcome : uint8_t { Held, Withdrew, Routed, Annihilated };
+/// `Voided`: the war ended without an in-sim verdict (season_end, operator
+/// retire) — full return, no spoils, no capture. Not a §7.5 outcome; the
+/// battle never priced anybody.
+enum class WorldEscrowOutcome : uint8_t { Held, Withdrew, Routed, Annihilated, Voided };
--- a/rts/Server/WorldEscrow.cpp
+++ b/rts/Server/WorldEscrow.cpp
@@ const char* WorldEscrowOutcomeToString
+        case WorldEscrowOutcome::Voided:      return "voided";
@@ WorldEscrowPayout PayoutFor(
+        case WorldEscrowOutcome::Voided:
+            p.returnTransports = transports;
+            p.returnSquads     = squads;
+            break;
--- a/rts/lobby_main.cpp
+++ b/rts/lobby_main.cpp
@@ (escrow settlement block, ~8915)
-            bool attackerWon = false;
-            if (outcomeRow && !outcomeRow->winnerFactions.empty()) {
-              const auto att = WorldFactions::Load(...);
-              if (att && !att->sideKey.empty()) {
-                const std::string list = "," + outcomeRow->winnerFactions + ",";
-                attackerWon = list.find("," + att->sideKey + ",") != std::string::npos;
-              }
-            }
             WorldEscrowSettleFacts facts;
-            facts.outcome = ClassifyEscrowOutcome(attackerWon, 0, staging->squads, escrowRules);
-            if (!attackerWon) { ... victorFactionId = owner ... }
+            const bool verdict = outcomeRow && !outcomeRow->winnerFactions.empty();
+            if (!verdict) {
+              facts.outcome = WorldEscrowOutcome::Voided;   // nobody fought this out
+            } else {
+              const auto att = WorldFactions::Load(mapDb, staging->worldId, staging->attackerFactionId);
+              const bool attackerWon = att && !att->sideKey.empty() &&
+                  SettlementNamesFaction(outcomeRow->winnerFactions, att->sideKey);
+              facts.outcome = ClassifyEscrowOutcome(attackerWon, 0, staging->squads, escrowRules);
+              if (!attackerWon)
+                if (const auto defPoi = WorldDirector::LoadPoi(mapDb, staging->worldId, staging->poiId))
+                  facts.victorFactionId = defPoi->ownerFactionId;
+            }
```

### P5 — the join commit is atomic and cannot join a closed window (F5)

```diff
--- a/rts/Server/WorldStaging.cpp
+++ b/rts/Server/WorldStaging.cpp
@@ WorldStagingCommitResult WorldStaging::Commit(
-    for (const auto& open : OpenFor(db, req.worldId)) {
-        if (open.poiId != req.poiId || open.attackerFactionId != req.attackerFactionId) continue;
-        ... UPDATE ...
-        const bool ok = sqlite3_step(stmt) == SQLITE_DONE;
-        sqlite3_finalize(stmt);
-        if (!ok) { res.error = "db_error"; return res; }
-        const auto reloaded = Load(db, open.stagingId);
+    // One transaction for "find the open window, add to it, reload": inside
+    // BEGIN IMMEDIATE the sweep cannot materialise the row between the read
+    // and the UPDATE, and `changes()==0` is then a genuine "closed under us".
+    std::optional<WorldStagingRecord> joinedRow;
+    std::string joinError;
+    const bool joinTxn = SqliteWriteTransaction(db, "WorldStagingJoin", [&] {
+        for (const auto& open : OpenFor(db, req.worldId)) {
+            if (open.poiId != req.poiId || open.attackerFactionId != req.attackerFactionId) continue;
+            ... prepare/bind the same UPDATE ...
+            const bool ok = sqlite3_step(stmt) == SQLITE_DONE;
+            const int changed = ok ? sqlite3_changes(db) : 0;
+            sqlite3_finalize(stmt);
+            if (!ok) { joinError = "db_error"; return SQLITE_ERROR; }
+            if (changed == 0) { joinError = "window_closed"; return SQLITE_ABORT; }
+            joinedRow = Load(db, open.stagingId);
+            return joinedRow ? SQLITE_OK : SQLITE_ERROR;
+        }
+        return SQLITE_ABORT;  // nothing to join — fall through to open a fresh row
+    });
+    if (!joinError.empty()) { res.error = joinError; return res; }
+    if (joinTxn && joinedRow) {
+        res.ok = true; res.joined = true; res.staging = *joinedRow; return res;
+    }
```
And in `lobby_main.cpp`'s commit route, wrap `WorldStaging::Commit` +
`WorldEscrow::Open` in one `SqliteWriteTransaction` (both are re-entrant)
returning `SQLITE_ERROR` from the body if `Open` fails, so a commitment never
stands without its debit; map `window_closed` → 409.

### P6 — verified origin + shortest-path transit (F6)

```diff
--- a/rts/Server/WorldStaging.cpp
+++ b/rts/Server/WorldStaging.cpp
@@ int64_t CheapestTransitTo(
-    ... single-edge scan ...
+    // Dijkstra from every `fromPois` source over the (directed-aware) edge
+    // list; the answer is the cheapest PATH, so a two-hop march is priced as
+    // two hops, never as "no edge → default".
+    std::unordered_map<std::string, std::vector<std::pair<std::string,int64_t>>> adj;
+    for (const auto& e : edges) {
+        if (e.transitWorldMs <= 0) continue;
+        adj[e.fromPoi].push_back({e.toPoi, e.transitWorldMs});
+        if (e.bidirectional) adj[e.toPoi].push_back({e.fromPoi, e.transitWorldMs});
+    }
+    using Item = std::pair<int64_t, std::string>;
+    std::priority_queue<Item, std::vector<Item>, std::greater<Item>> pq;
+    std::unordered_map<std::string, int64_t> best;
+    for (const auto& s : fromPois) { best[s] = 0; pq.push({0, s}); }
+    while (!pq.empty()) {
+        auto [d, u] = pq.top(); pq.pop();
+        if (d > best[u]) continue;
+        if (u == poiId) return d;
+        for (const auto& [v, w] : adj[u]) {
+            const int64_t nd = d + w;
+            auto it = best.find(v);
+            if (it == best.end() || nd < it->second) { best[v] = nd; pq.push({nd, v}); }
+        }
+    }
+    return 0;
@@ WorldStaging::Commit
     if (!req.originPoiId.empty()) {
-        origins.push_back(req.originPoiId);
+        const auto origin = WorldDirector::LoadPoi(db, req.worldId, req.originPoiId);
+        if (!origin || origin->ownerFactionId != req.attackerFactionId) {
+            res.error = "bad_origin";   // route: 400
+            return res;
+        }
+        origins.push_back(req.originPoiId);
```
(A source equal to the target returns 0 → default; keep that.)

### P7 — a retired-budget row fails and refunds (F7)

```diff
--- a/rts/lobby_main.cpp  (staging sweep, ~9081)
+++ b/rts/lobby_main.cpp
+        // Rows whose attempts already exceed a LOWERED budget: retire them
+        // explicitly (flip + refund) instead of leaving them open on the map.
+        for (const auto& row : WorldStaging::OpenFor(mapDb, w.worldId)) {
+          if (rules.materialiseMaxAttempts > 0 && row.attempts >= rules.materialiseMaxAttempts &&
+              row.endsAtWorldMs <= reading->worldMs) {
+            WorldStaging::MarkAttemptFailed(mapDb, row.stagingId, "retry budget lowered", rules, nowReal);
+            WorldEscrow::Release(mapDb, row.stagingId, "staging_failed", nowReal);
+            /* publish StagingFailed as the terminal branch below does */
+          }
+        }
```
(`MarkAttemptFailed` already flips to `failed` once `attempts >= max`.)

### P8 — won-flip and ownership transfer in one transaction (F8)

```diff
--- a/rts/Server/WorldConquest.cpp
+++ b/rts/Server/WorldConquest.cpp
@@ WorldConquest::SettleWar
-    if (!ResolveClaim(db, *claim, WorldClaimState::Won, 0.0, settlement.settlementId, nowRealMs))
-        return r;
-    if (claim->factionId != poi->ownerFactionId) {
-        if (WorldDirector::SetPoiOwner(db, settlement.worldId, settlement.poiId, claim->factionId)) {
-            r.ownershipChanged = true; r.newOwnerFactionId = claim->factionId;
-        }
-    }
+    bool flipped = false;
+    const bool committed = SqliteWriteTransaction(db, "WorldConquestTransfer", [&] {
+        if (!ResolveClaim(db, *claim, WorldClaimState::Won, 0.0, settlement.settlementId, nowRealMs))
+            return SQLITE_ABORT;   // raced with a withdrawal — the withdrawal stands
+        flipped = true;
+        if (claim->factionId != poi->ownerFactionId &&
+            !WorldDirector::SetPoiOwner(db, settlement.worldId, settlement.poiId, claim->factionId))
+            return SQLITE_ERROR;   // roll the flip back with the failed transfer
+        return SQLITE_OK;
+    });
+    if (!committed || !flipped) return r;
+    if (claim->factionId != poi->ownerFactionId) { r.ownershipChanged = true; r.newOwnerFactionId = claim->factionId; }
```

### P9 — refuse at commit/filing what materialisation would refuse (F9, F18, F20)

```diff
--- a/rts/Server/WorldStaging.cpp  (Commit, after the faction load)
+    if (attacker->sideKey.empty()) { res.error = "no_side"; return res; }          // route: 409
+    if (!poi->ownerFactionId.empty())
+        if (const auto owner = WorldFactions::Load(db, req.worldId, poi->ownerFactionId))
+            if (owner->sideKey == attacker->sideKey) { res.error = "same_side"; return res; }  // route: 409
+    if (req.transports > rules.maxTransportsPerCommit || req.squads > rules.maxSquadsPerCommit) {
+        res.error = "too_much_force"; return res;                                   // route: 400
+    }
--- a/rts/Server/WorldStaging.h  (WorldStagingRules)
+    int maxTransportsPerCommit = 16;   // `stagingMaxTransportsPerCommit`
+    int maxSquadsPerCommit     = 64;   // `stagingMaxSquadsPerCommit`
--- a/rts/Server/WorldConquest.cpp  (FileClaim, after the faction load)
-    if (!WorldFactions::Load(db, req.worldId, req.factionId)) return Failure("no_faction");
+    const auto faction = WorldFactions::Load(db, req.worldId, req.factionId);
+    if (!faction) return Failure("no_faction");
+    if (faction->sideKey.empty()) return Failure("no_side");          // can never win
+    if (!poi->HasBattleMap()) return Failure("no_battle_map");        // can never be settled
```
(`WorldFactions::Load` is needed as a value in `Commit` too — it is currently
discarded.)

### P10 — escrow rates in `WorldDefaults` (F12)

```diff
--- a/rts/Server/WorldDirector.h  (WorldDefaults)
+    // ── Escrow (mirrored by WorldEscrowRules) ──
+    double escrowAnnihilatedCaptureFraction = 0.25;
+    double escrowWithdrewThresholdFraction  = 0.50;
+    double escrowHeldSpoilsTreasury         = 25.0;
--- a/rts/Server/WorldDirector.cpp  (ToJson)
+    j["escrowAnnihilatedCaptureFraction"] = escrowAnnihilatedCaptureFraction;
+    j["escrowWithdrewThresholdFraction"]  = escrowWithdrewThresholdFraction;
+    j["escrowHeldSpoilsTreasury"]         = escrowHeldSpoilsTreasury;
```

### P11 — `claims/file` answers 403 on `insufficient_authority` like `found` (F13)

```diff
--- a/rts/lobby_main.cpp  (~5545)
           const int status = result.error == "already_owner"          ? 409
                              : result.error == "already_claimed"      ? 409
+                             : result.error == "insufficient_authority" ? 403
                              : result.error == "no_poi"               ? 404
```
Then flip `docs/api.md` / `api-spec.yaml` back to 403 in the same commit.

### P12 — `MergeDefaults` cannot throw at boot (F16)

```diff
--- a/rts/Server/WorldMapSeeder.cpp
-    d.poiBudgetInitial = config.value("poiBudgetInitial", d.poiBudgetInitial);
+    auto num = [&](const char* k, double fb) {
+        const auto it = config.find(k);
+        return (it != config.end() && it->is_number()) ? it->get<double>() : fb;
+    };
+    d.poiBudgetInitial       = static_cast<int>(num("poiBudgetInitial", d.poiBudgetInitial));
+    d.poiBudgetMax           = static_cast<int>(num("poiBudgetMax", d.poiBudgetMax));
+    d.poiPerWorldAgeDay      = num("poiPerWorldAgeDay", d.poiPerWorldAgeDay);
+    d.poiPerRegisteredPlayer = num("poiPerRegisteredPlayer", d.poiPerRegisteredPlayer);
+    d.transitWorldMsPerKm    = num("transitWorldMsPerKm", d.transitWorldMsPerKm);
```

## Out-of-lane findings

- **war-surfaces / world-screen (lanes 14/2):** `client/src/lobby/world-notifications.ts:67` accepts only the four staging kinds; the `world-poi` event (`kind:"ownership"`) is a different SSE event name so it is not dropped by that parser, but nothing in the world screen listens for `world-poi` or `world-season` as far as a grep shows — ownership changes and season rollovers reach no toast. Suggest a second `addEventListener('world-poi', …)`/`('world-season', …)` in the screen wiring.
- **battle-flow (lane 12):** `game_transports.lua:971-1008` parses `world_commit` but the withdrawal counters (`ms_withdrawn_<team>_*`) are still rulesParams only; the world settles every loss as `annihilated` until they reach `war_outcome` (transports §7.3). One durable column pair on `war_outcome` (`withdrawnUnits`, `committedUnits` per side) would make `withdrew`/`routed` real with no world-side change (`ClassifyEscrowOutcome` already takes them).
- **objectives-authority (lane 11) / gm-tools:** `WarTerminationFacts::operatorRetire` is never set (`lobby_main.cpp:8875-8879`); a `/api/gm/retire-war` verb is the missing piece for the admin's escape hatch.
- **mcp-control (lane 7):** none of the `/api/world/*` routes are wrapped by a debug-mcp tool; `query_db` reaches the tables but a `world_status`/`world_commit` tool would let agents drive the loop without curl.

## Assumptions / decisions made without asking

1. Documented the shipped behaviour (400 on `claims/file` `insufficient_authority`) as the truth in `docs/api.md`/spec and proposed the code change to 403 — docs must describe what runs.
2. Treated `season_end` annihilating an expedition as a **design defect** (F4) rather than a rule, because transports §7.5's table prices battle outcomes and a season boundary is not one; the proposed `voided` outcome is additive.
3. W13–W18 numbers (holdings grants, garrison rates, pact durations, artifact chances, defection gates, carry-over fraction) are **defaults for a config key**, chosen to be small and revisable, not tuned.
4. Kept the manual edits to §8/§12 world bullets as instructed; the §1 sentence "one world day per real hour" is already correct and untouched.
5. Did not add `docs/world-layer.md` to `ARCHITECTURE.md` (merge hotspot); the manual §8/§12 and `docs/api.md` link to it. Coordinator may append one line under "World layer" if desired.
6. Removed the four untracked `node_modules` symlinks the setup recipe created outside `client/` (they showed in `git status`); `client/node_modules` is gitignored and kept.

## Suggested next milestones

1. **Build session for P1–P5** (wrong outcomes): side-key attribution, digest id spaces, atomic rollover, `voided` outcome, join-commit transaction — with the doctest cases in `world-design-proposed-tests.md`.
2. **W13 holdings + account authority income** (`world-layer.md` §18) — the loop has no scarcity and the claim purse empties; both are one lane.
3. **P6–P9** (exploit/stuck-state): verified origin + Dijkstra pricing, retired-budget rows, atomic transfer, commit-time refusals.
4. **W14 garrisons**, then **W15 diplomacy** (tribute is the first treasury sink).
5. **Wire `world-poi` / `world-season` toasts** in the World screen (lane 2) and the withdrawal conduit on `war_outcome` (lane 12) so `withdrew`/`routed` become reachable.
6. **W16–W18** per `world-layer.md` §18; W18 needs one user sentence on multi-world identity first.
