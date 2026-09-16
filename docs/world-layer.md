# The world layer — design of record

_Last updated: 2026-09-10 (review sweep, lane `world-design`). This document
describes the persistent world **as a player experiences it and as it is
implemented on `main`** (PLAN-worldsim W1–W12, conquest, seasons, offline
notifications). Where a rule has a number, the number and its config key are
given. Where the code and the design disagree, the disagreement is listed in
§13 (not yet implemented) or in the review report
`docs/reviews/2026-09-10/world-design.md` (defects). Sources: `rts/Server/World*.{h,cpp}`,
the `/api/world/*` routes and sweeps in `rts/lobby_main.cpp`, `tests/test_world_*.cpp`.
Design sources (main checkout only, gitignored): PLAN-worldsim.md,
PLAN-metalstorm-worldbuilding.md, PLAN-metalstorm-transports.md §7,
PLAN-metalstorm-wars.md §6–7, PLAN-lobby.md §8._

---

## 1. What the world layer is

The world layer is the persistent strategic metagame above battles. It is
**lobby-side SQLite plus arithmetic plus three low-frequency sweeps** — never
a live simulation, never a thread that ticks, never a reader of sim state.

Three hard boundaries define it (violating any is a defect, not a choice):

1. **A "war" is one battle in one room.** Every `war*` table is keyed by
   `room_id`; every `world_*` table is keyed by `world_id` and **never** by
   `room_id`. Where a world row carries a `room_id` (`world_staging`,
   `world_escrow`, `world_force_ledger`, `world_settlement_ledger`) it is a
   *label* — rooms are reused, so it is never a join key back into a war table.
2. **The world never touches sim state.** Force enters a battle only as
   transport arrivals (`world_commit` modoption → `game_transports.lua`) and
   the battle reports back only through the war machinery the lobby already
   reads (`war_outcome`).
3. **Battles get field engineering only.** Base building and the economy live
   here. A battle factory that builds nothing is intended.

And one discipline: **numbers are data** (pillar 7). Every rate below is a key
in `worlds.config_json`, seeded from `WorldDefaults` (`WorldDirector.h`) and
resolved *per key* with a fallback — a world seeded before a key existed keeps
the rule, it does not silently lose it. The config reference is §15.

## 2. The player loop

```
found / join a faction ──► read the map ──► stage an attack ──► force in escrow
        ▲                                                             │
        │                                                             ▼
   seasons roll ◄── economy accrues ◄── claim resolves ◄── war materialises & ends
```

| Step | What the player does | Routes | Rules |
|---|---|---|---|
| **Found / join** | Found a faction (archetype, name, colour, optional seat POI) or join one. | `POST /api/world/factions/found`, `/join`, `/leave`; `GET /api/world/factions`; `POST /api/world/me` | §4 |
| **Read the map** | The World screen: an equirectangular Earth with POIs, transit edges, owners' colours, battle markers, gathering forces, the world clock and the active season. | `GET /api/world`, `GET /api/world/pois`, `GET /api/world/stats`, `GET /api/world/claims` | §3, §6 |
| **Stage** | Commit ≥1 transport carrying ≥1 squad at a POI the faction does not hold. A staging window opens, sized by transit time. Late commits join the window. Cancel before contact. | `POST /api/world/staging/commit`, `/cancel` | §7 |
| **Escrow** | The committed force leaves the faction's pool the moment it is committed. | (side effect of commit) | §8 |
| **War** | At window end the lobby creates a war on the POI's battle map through the normal war-creation path; the force rides in as `world_commit`. Play the battle from the war browser. | war routes (`docs/api.md` §Wars) | §9 |
| **Claim** | File a paid claim on the POI before the war ends; at war end the earliest open winning-side claim takes the POI (defender's shield applies). | `POST /api/world/claims/file`, `/withdraw`; `GET /api/world/claims` | §10 |
| **Economy** | Held POIs pay treasury per world-day; treasury decays; escrow settles materiel and spoils. | `GET /api/world/stats` (`economy`) | §11 |
| **Seasons** | Every 14 world-days the season rolls: digests archived, wars born in the old season end on `season_end`. | `GET /api/world/seasons`, `/seasons/{n}` | §12 |
| **Notifications** | Staging opened/materialised/cancelled/failed and POI ownership changes reach the two factions and the garrison — lobby SSE, Discord, Web Push. | `GET /api/world/push/key`, `POST /api/world/push/subscribe`, `/unsubscribe` | §13 |

Every route is documented (shapes, status codes) in `docs/api.md` §World layer.

## 3. The world clock

The clock is **not a process**. It is a pure function
`worldMs = epochWorldMs + ((now − epochRealMs − pausedRealMs) × ratioNum) / ratioDen`
evaluated by `ReadWorldClock` (`WorldClock.h`) over the `worlds` row and the
`world_pause_ledger` rows. Two lobbies, or a lobby and a client, agree because
they evaluate the same function over the same rows.

| Rule | Value | Where |
|---|---|---|
| Ratio | **24 : 1** — one world day per real hour | `worlds.time_ratio_num/den` (columns, never the blob) |
| Epoch | the world's founding instant; world time 0 | `worlds.epoch_real_ms`, `epoch_world_ms` |
| Pause | an open `world_pause_ledger` row (`ended_at_ms = 0`); overlapping rows are merged, counted once | `POST /api/world/pause` (admin) |
| Before the epoch | reads exactly `epochWorldMs`; never runs backwards | `ReadWorldClock` |
| Corrupt ratio | `den ≤ 0` → 1; `num < 0` → 0 (slow world, never a crash) | `SafeRatioNum/Den` |
| Display | days are 1-based ("Day 1" on founding); `"Day 12, 07:31"` | `WorldCalendarFromMs`, `FormatWorldCalendar` |

**What a pause freezes, for free:** economy accrual (§11), claim expiry (§10),
staging windows (§7), season rollover (§12) and commander authority decay
(§5) are all priced against `worldMs`, so none of them need to know pause is a
state. **What a pause does not freeze:** running battles (their orchestration
is a stub — see §14) and the Capacity recharge, which is deliberately on
**real** hours (a pause must not widen anyone's order budget).

## 4. Factions, membership, and the side-key seam

A **world faction** is a player-founded organisation inside one world. It is
**not** `users.faction_id` — that column is the battle **side key** (a
`gamedata/sidedata.lua` name: `compact` | `union`), permanent from sign-up.

| Rule | Value | Config key |
|---|---|---|
| Starting world authority (per account, per world, credited on first contact) | 100 | `startingAuthority` |
| Authority a player must HOLD to found | 100 | `foundFactionAuthority` |
| What founding SPENDS | 50 | `foundFactionCost` |
| Name length (characters; control chars refused; must slugify to something) | 3–32 | `factionNameMinLen`, `factionNameMaxLen` |
| Faction id | slug of the name (`"House  Verendi!"` → `house-verendi`), unique per world | — |
| Membership | one faction per account per world (**schema fact**: `PRIMARY KEY (world_id, account_id)`) | — |
| Archetypes | `order`, `dynasty`, `resistance`, `anarchic` — a 10-parameter sheet (diplomacy … archaeology on a 0.25/0.5/0.75 scale), a naming register and a governance model, **copied** into the faction's `config_json` at founding | `WorldFactionArchetypes()` |
| Colour | `#rrggbb` or the archetype's | — |
| Seat POI | optional; must be unowned; becomes the faction's first holding (the **only** ownership writer besides conquest) | — |
| Last member leaves | the faction goes `dormant`, never deleted (POIs, ledgers and settlements still name it); a join revives it | — |

**The seam (`ReconcileSideKey`):** a faction's `side_key` is the founder's
account side at founding. Joining adopts the faction's side if the account has
none, is a no-op if they agree, and is **refused** (409 `side_mismatch`) if
both are set and differ. `users.faction_id` is never overwritten by the world
layer and never cleared on leave. A faction with an empty `side_key` can exist
but can neither field a battle side nor win a claim.

## 5. The three stats (W8)

| Stat | Scope | Storage | Rule |
|---|---|---|---|
| **Authority** (commander) | per **commander** row (`world_commanders`) | stored value + `authority_at_world_ms`; **decay applied on read** | accrues from settlements at the commander's POI (+12 victory / +3 defeat, `authorityPerVictory/Defeat`), idempotent per settlement row (`world_authority_events` UNIQUE on `(world, commander, source, source_key)`); decays 1 %/world-day (`authorityDecayPerWorldDay`, `pow`-shaped, continuous) to a floor of 1 (`authorityFloor`) |
| **World authority** (account) | per **account** per world (`world_authority.authority`) | a column, adjusted in place, never below 0 | the founding gate and the claim purse. **It has no income** (§13) |
| **Capacity** (player) | per account (`world_authority.capacity_spent`, `capacity_recharged_at`) | normalised on read | ceiling = 20 + 0.10 × Σ(held commanders' authority) (`capacityBase`, `capacityPerCommanderAuthority`); recharges 100 % every 24 **real** hours (`capacityRechargeHours`, `capacityRechargeFraction`). **Nothing spends it yet** |
| **Rank** (player per faction) | derived, **never stored** (`world_faction_members.rank` is legacy) | `ComputeRank` on read | 10 per held commander + 1 × its authority + 25 per POI the faction holds **and** the player garrisons + 1 × money (faction treasury ÷ members) + 50 per artifact + 1/resource + 2/unit (`rankPer*`); loaned commanders count for **neither** party |

The **starter commander** is granted lazily by `POST /api/world/me` once the
account holds ≥ 50 world authority (`commanderGrantAuthority`), once per
account (a dead commander is not replaced this way), stationed at the first
POI its faction holds, at the authority floor.

## 6. The POI graph

`world_pois` are points on Earth (lat/lon) with an optional battle map
(`map_id`); `world_poi_edges` are transit links weighted in **world ms**.

| Rule | Value | Config key |
|---|---|---|
| POI budget | 8 initially, +0.5 per real day of world age, +0.25 per registered player, capped at 64 | `poiBudgetInitial`, `poiPerWorldAgeDay`, `poiPerRegisteredPlayer`, `poiBudgetMax` |
| Registry ("Randtown" register) | `randtown` (meridian_basin), `driftreach` (skerry_reach), `cinderfall` (sundered_arc), then world-only `osprey_fen`, `verge_hollow` | `WorldMapSeeder::Registry()` |
| Edge weight | great-circle km × 60 000 world-ms/km (1 world minute per km) | `transitWorldMsPerKm` |
| Topology | a **minimum spanning tree** over great-circle distance (traversable, not complete), re-run additively on every boot | `SeedFromRegistry` |
| Ownership | `owner_faction_id` TEXT, dangling ids render as unowned (geography survives a dissolved faction) | `WorldDirector::SetPoiOwner` |

`GET /api/world/pois` merges onto each POI: `battleStatus`
(`quiet | staging | active`, from live wars on the POI's map — `WorldWarLinkage.h`),
`warRoomId`, the open `staging[]` rows (upgrade-only: a quiet POI with a
gathering force shows `staging`; an `active` POI stays active), and a
top-level `factions` map of id → `{name, colour, archetype, state}`.

## 7. Staging (W10)

A battle exists as a **world event before it starts**. Committing force opens
(or joins) a `world_staging` row whose window is the attacker's transit time —
"the attacker's world-days in transit are the defender's real hours of
warning".

### 7.1 Rules

| Rule | Value | Config key |
|---|---|---|
| Instigation (§7.1) | ≥1 transport **and** ≥1 squad, at a POI the faction does not own; the defender needs no transport | `StagingInstigationError` |
| Refused at commit | `no_transport`, `no_squads`, `already_held`, `no_poi`, `no_battle_map` (a world-only POI cannot host a battle), `no_faction` | — |
| Window | `transit × 1.0`, clamped to **[1 world hour, 72 world hours]**; **12 world hours** when no edge prices it | `stagingWindowPerTransitMs`, `stagingWindowMinWorldMs`, `stagingWindowMaxWorldMs`, `stagingWindowDefaultWorldMs` |
| Transit pricing | the cheapest **single edge** from the named `origin`, else from any POI the faction holds, to the target (directed edges one way only) | `CheapestTransitTo` |
| Late commit (§7.2) | the same faction committing at the same POI while its window is open **joins** it: counts add, **the window does not move** (extending it would let an attacker hold a defender in permanent staging) | `Commit` |
| Two attackers | two factions gathering against one POI are two rows (and two wars) | — |
| Cancel | any member of the committing faction, while the row is `staging`; refunds the escrow | `POST /api/world/staging/cancel` |
| Materialisation | the staging sweep (every ~10 s) drains rows whose window has closed; up to **5 attempts**, then `failed` and the escrow is released | `stagingMaterialiseMaxAttempts` |

### 7.2 State machine

```
            commit (fresh)                 window end + war created
 ──────────────────────────► staging ─────────────────────────────► materialised
                               │  ▲
              late commit ─────┘  │ (counts added, window unchanged)
                               │
          cancel (member) ─────┼──────────────────────────────────► cancelled
                               │
   5 failed materialise attempts ─────────────────────────────────► failed
```

Only `staging` is open; the three terminals are kept apart because "this
became a battle", "we called it off" and "no battle could be made" are
different facts a player is owed.

### 7.3 How the war is made (`materialiseStaging`, `lobby_main.cpp`)

The theatre is **given**, not chosen: the POI's `map_id`. The attacker side is
the faction's `side_key`; the defender side is the owner faction's `side_key`,
or — for an unowned POI — the first *other* side the chosen scenario declares.
The scenario must be authored on that map, terminal, not tutorial/retired, and
field both sides. The war is seeded through the one room-creation path
(`PlanWarSeed → BuildWarBootManifest → runDirectStart`), named
`"<POI name> · staging <id>"`, stamped with the current season id, and given
`modoptions.world_commit = "<sideKey>:<transports>:<squads>:<stagingId>"`
(plus `world_staging_id`) for `game_transports.lua` to schedule the arrivals.
Failures are written to the row (`last_error`, `attempts`), never dropped.

## 8. Escrow (transports §7.3 / §7.5)

Force committed to a battle is **escrowed** — unavailable to the world — from
commit until settlement. The world counts force as `transports` and `squads`
(per-asset identity is a later milestone).

### 8.1 State machine (one row per commitment)

```
   Commit ─────────► committed ──MarkEngaged──► engaged ──Settle──► settled
                         │      (window closed,           (war archived;
                         │       war exists)               payout rows, once)
                Release  │
   (cancel, or terminal  ▼
    staging failure)  released  (refund rows)
```

Every transition is an `UPDATE … WHERE state='<from>'`; the guard **is** the
idempotence. A replayed sweep or a lobby restarted mid-archive flips nothing
and writes nothing.

### 8.2 The ledger

`world_force_ledger` is append-only; a faction's standing force is `SUM` over
its rows (`ForceBalanceFor`). Sources:

| source | sign | when |
|---|---|---|
| `escrow_commit` | − | at commit (this commit's counts, not the window's total) |
| `escrow_release` | + | cancel / terminal staging failure (per commitment row) |
| `settlement_return` | + | survivors come home |
| `settlement_capture` | + (to the **victor**) | the captured share of an annihilated/routed remainder |

**Negative balances are legal today** — nothing seeds opening holdings and
nothing refuses a commit (§13, and W13 below).

### 8.3 Outcomes and payout

| outcome | classification (`ClassifyEscrowOutcome`) | return to owner | capture to victor | treasury |
|---|---|---|---|---|
| `held` | attacker's side is among `war_outcome.winnerFactions` | all | none | **+25** `war_spoils` to the attacker (`escrowHeldSpoilsTreasury`) |
| `withdrew` | lost, ≥50 % of committed units departed by transport (`escrowWithdrewThresholdFraction`) | floor(fraction × counts) | none | none |
| `routed` | lost, some departed but <50 % | floor(fraction × counts) | 25 % of the remainder | none |
| `annihilated` | lost, no recorded departure — **every loss today** (withdrawal counts are not durable across the seam yet) | none | **25 %** of the commitment (`escrowAnnihilatedCaptureFraction`), floored | none |

The victor for capture is **whoever owns the POI when the war ends**; an
unowned POI names no victor and the captured share is destroyed. Settlement
runs **before** conquest in the same sweep pass (capture-then-claim), so a
claim that transfers the POI in the same pass never captures its own
attacker's materiel.

## 9. War end: the settlement chokepoint

On the sweep pass that archives a war (`AdvanceWarLifecycle` reports
`archived` exactly once), `lobby_main.cpp` does, in order:

1. **Escrow settlement** — for every staging with `engaged` escrow against the
   room: classify, price, flip to `settled` (§8).
2. **Settlement ledger** — resolve room → map → POI (`PoiForMap`; a map with
   no POI settles nowhere) and append one `world_settlement_ledger` row
   (`outcome` = the war terminal reason, `factions` = the sim's
   `winnerFactions`, i.e. **side keys**).
3. **Conquest** — apply the claim rule to that settlement row (§10) and
   publish a `PoiOwnershipChanged` notification if the POI changed hands.

Commander authority accrual from settlements is **lazy** (on `GET
/api/world/stats` and `POST /api/world/me`), idempotent per settlement row.

## 10. Conquest — the explicit claim act (USER-DECIDED 2026-08-27)

`winnerFactions` names a **side**, and many world factions share one side, so
a war's outcome alone cannot say which faction takes the ground. Hence:

> Ownership transfers at war end **only** to a winning-side faction that had
> filed an explicit claim on that POI before the war ended. With no valid
> claim the current owner keeps the POI.

| Rule | Value | Config key |
|---|---|---|
| 1. Filing costs the filing **account** world authority; the charge is recorded on the row | **25** | `claimPoiCost` |
| Refused at filing | `already_owner` (rule 4 already protects the owner), `already_claimed` (one open claim per faction per POI), `no_poi`, `no_faction`, `insufficient_authority` | — |
| 2. A war with no in-sim winner (operator retire, `season_end`) resolves nothing | — | — |
| 3. Every open claim whose faction's side is **not** named in the winners resolves `lost`, refunding a fraction of its recorded cost | **50 %** | `claimRefundFraction` (one knob for lost/expired/withdrawn — three knobs would invite withdraw-before-losing arbitrage) |
| 4. **Defender's shield**: if the POI's owner is on the winning side the POI does not change hands; the owner's own leftover claim resolves `won`; other winning-side claims stay open | — | — |
| 5. Otherwise the **earliest** open winning-side claim wins: min `filed_at_world_ms`, ties by `claim_id` (file order) — deterministic across replays. Its cost is never refunded | — | `SelectWinningClaim` |
| 6. Winning-side claims that lost the tie stay open, queued for the next war there | — | — |
| 7. Expiry after **30 world days** (paused world: frozen), refunded at the same fraction; withdrawal by any member of the claiming faction, same refund | 30 × 24 h world | `claimExpiryWorldMs` (≤0 disables) |

### 10.1 Claim state machine

```
                  file (paid) ─────► open
                                      │  war at POI, side not named ──► lost      (refund 50 %)
                                      │  earliest winning claim ───────► won       (POI transfers; no refund)
                                      │  owner-on-winning-side's own ─► won       (no transfer)
                                      │  30 world days pass ──────────► expired   (refund 50 %)
                                      │  member withdraws ────────────► withdrawn (refund 50 %)
```

Expiry is swept every ~30 s with the economy tick and again inside every
settlement (so a lapsed claim can never win the war that ended after it lapsed).

## 11. The economy (W9)

| Rule | Value | Config key |
|---|---|---|
| Income | **+2 treasury per world-day per POI owned**, one `poi_income` row per faction-POI pair per tick | `poiIncomePerWorldDay` |
| Decay | **1 % of treasury per world-day**, `pow`-shaped and continuous (the answer does not depend on tick frequency), on the balance as of the start of the period; never below the floor, never raising a balance already below it | `treasuryDecayPerWorldDay`, `treasuryFloor` (0) |
| Spoils | +25 `war_spoils` on a `held` settlement (§8) | `escrowHeldSpoilsTreasury` |
| Storage | `world_economy_events` is append-only; **there is no balance column** — treasury = `SUM(delta)` | — |
| Cursor | `world_economy_cursor.last_tick_world_ms`, one row per world; the **first** tick only plants it (no windfall for a world's pre-W9 history); every later tick prices exactly the gap since the cursor in one closed-form step (downtime catch-up, idempotent) | — |
| Pause | `elapsed ≤ 0` → nothing written, cursor unchanged | — |
| Cadence | every ~30 s of lobby uptime (300 iterations at 10 Hz), all worlds | `worldEconomyTick` in `lobby_main.cpp` |

**There is no sink.** Nothing spends treasury today: claims and founding
charge the *account's* world authority, not the faction's money (§13).

## 12. Seasons (W12 + phase 3)

| Rule | Value | Config key |
|---|---|---|
| Length | **14 world days** | `seasonLengthWorldMs` |
| First tick | opens season 1 anchored at the current `worldMs` (never backdated) | — |
| Rollover | when `worldMs − startedWorldMs ≥ length`: archive a digest, close the season, open the next (numbered +1) with a settlement cursor = max settlement rowid | `WorldSeasons::Tick`, every ~60 s |
| Digest | per faction: `settlementsWon` (settlement rows since the season's cursor whose `factions` name it), `poiIncomeTotal`, `decayTotal` (economy events with `world_ms` in the season), `treasuryAtRollover` (a snapshot); one faction-less bucket for settlements with no winner | `world_season_digests` |
| Wars | every war is stamped `wars.season_id = "<world>/season-<n>"` at materialisation; the lifecycle sweep ends a war whose season is no longer current with `season_end` (no in-sim winner: claims stay open, escrow settles as a loss — see the report) | `WorldSeasonIdFor`, `WarTermination.h` |
| Event | `world-season` SSE broadcast `{worldId, endedSeason, newSeason, headline}` | — |

A rollover **touches no balance and no ownership**: it is a read over the two
ledgers, filed away.

## 13. Notifications (W11 + phase 3)

| Event kind | SSE event | Fired from | Recipients |
|---|---|---|---|
| `opened` | `world-staging` | a **fresh** commit (a join is not a new alert) | attacker faction members ∪ defender faction members ∪ accounts with an active commander at the POI (`WorldNotificationRecipients`, deduplicated) |
| `materialised` | `world-staging` | the staging sweep | same |
| `cancelled` | `world-staging` | the cancel route | same |
| `failed` | `world-staging` | the **terminal** materialise failure only | same |
| `ownership` | `world-poi` | the conquest settlement | new owner ∪ previous owner ∪ garrison |

Wire shape (`WorldNotificationToJson`): `{world, poi, poiName, kind,
attackerFaction, defenderFaction, stagingId, claimId, worldMs, headline}`.

Delivery is via `WorldNotificationBus` with two sinks subscribed at lobby
start: the lobby's identified chat SSE channel (lobby browsers only — in-game
clients have no room SSE), and the **offline channels**
(`WorldOfflineChannels`): a per-world Discord webhook and Web Push
(RFC 8291/8292, VAPID). Both default **off**, configured under
`config_json.notifications.{discord,webPush}` (`enabled`, `webhookUrl` /
`vapidPublicKey`, `vapidPrivateKey`, `subject`, `ttlSeconds` 3600,
`jwtTtlSeconds` 43200, `events` filter — empty = all kinds). Outbound POSTs go
through a bounded (256) single-worker queue that **drops** rather than blocks
the lobby loop; the worker touches no database handle.

## 14. The sweeps and the threading rule

| Sweep | Cadence (10 Hz loop) | Does |
|---|---|---|
| War lifecycle | every pass | advances wars; on `archived`: escrow settle → settlement row → conquest |
| Economy + claim expiry | every 300 passes (~30 s) | `WorldEconomy::Tick`, `WorldConquest::ExpireClaims` per world |
| Staging | every 100 passes (~10 s) | `DueStagings` → `materialiseStaging` → `MarkMaterialised` + `MarkEngaged`, or `MarkAttemptFailed` (+ `Release` on the terminal attempt) |
| Seasons | every 600 passes (~60 s) | `WorldSeasons::Tick` → `world-season` broadcast |

HTTP routes run on the NetworkServer thread; the sweeps run on `main()`'s
loop; both share the one `mapDb` handle (macOS SQLite is THREADSAFE=2 — the
process forces serialized mode at start). **Every write goes through
`SqliteWriteTransaction`** (`BEGIN IMMEDIATE`, re-entrant per thread, busy
retry) so a route and a sweep cannot interleave inside one transaction. Reads
outside a transaction can still race a sweep's write — the review report lists
the one place that matters (the join-commit vs. materialisation race).

**What is stubbed on purpose:** the admin pause freezes the world clock only;
pausing every running game server ("both clocks stop together") is not
orchestrated. `operatorRetire` is never set (no GM verb yet).

## 15. Schema (all keyed by `world_id`; migrations are ADDITIVE only)

| Table | Owner | Rows |
|---|---|---|
| `worlds` | WorldDirector | one per world: clock columns + `config_json` |
| `world_pois`, `world_poi_edges` | WorldDirector / WorldMapSeeder | the graph; `owner_faction_id` (W7 ALTER) |
| `world_pause_ledger` | WorldDirector | pause intervals; `(world_id, started_at_ms)` PK |
| `world_settlement_ledger` | WorldDirector | one row per archived war at a POI (W6) |
| `world_factions`, `world_faction_members`, `world_authority` | WorldFactions | factions, the sole membership authority, per-account authority/capacity |
| `world_commanders`, `world_authority_events` | WorldStats | commander rows; award ledger (UNIQUE idempotence index) |
| `world_economy_events`, `world_economy_cursor` | WorldEconomy | the treasury ledger + per-world tick cursor |
| `world_staging` | WorldStaging | gathering battles |
| `world_escrow`, `world_force_ledger` | WorldEscrow | commitments + the force ledger |
| `world_poi_claims` | WorldConquest | claims |
| `world_seasons`, `world_season_digests` | WorldSeasons | seasons + archived digests |
| `world_push_subscriptions` | WebPushSubscriptions | browser push endpoints |

## 16. Config key reference (`worlds.config_json`, ship-with values)

| Family | Keys (default) |
|---|---|
| POI budget / seeding | `poiBudgetInitial` 8, `poiBudgetMax` 64, `poiPerWorldAgeDay` 0.5, `poiPerRegisteredPlayer` 0.25, `transitWorldMsPerKm` 60000 |
| Founding | `startingAuthority` 100, `foundFactionAuthority` 100, `foundFactionCost` 50, `factionNameMinLen` 3, `factionNameMaxLen` 32 |
| Stats | `authorityPerVictory` 12, `authorityPerDefeat` 3, `authorityDecayPerWorldDay` 0.01, `authorityFloor` 1, `commanderGrantAuthority` 50, `capacityBase` 20, `capacityPerCommanderAuthority` 0.10, `capacityRechargeHours` 24 (real), `capacityRechargeFraction` 1.0, `rankPerCommander` 10, `rankPerCommanderAuthority` 1, `rankPerPoiHeld` 25, `rankPerArtifact` 50, `rankPerMoney` 1, `rankPerResource` 1, `rankPerUnit` 2 |
| Economy | `poiIncomePerWorldDay` 2, `treasuryDecayPerWorldDay` 0.01, `treasuryFloor` 0 |
| Staging | `stagingWindowDefaultWorldMs` 43 200 000 (12 h), `stagingWindowPerTransitMs` 1.0, `stagingWindowMinWorldMs` 3 600 000 (1 h), `stagingWindowMaxWorldMs` 259 200 000 (72 h), `stagingMaterialiseMaxAttempts` 5 |
| Escrow | `escrowAnnihilatedCaptureFraction` 0.25, `escrowWithdrewThresholdFraction` 0.5, `escrowHeldSpoilsTreasury` 25 |
| Conquest | `claimPoiCost` 25, `claimRefundFraction` 0.5, `claimExpiryWorldMs` 2 592 000 000 (30 world days) |
| Seasons | `seasonLengthWorldMs` 1 209 600 000 (14 world days) |
| Notifications | `notifications.discord.{enabled,webhookUrl,events}`, `notifications.webPush.{enabled,vapidPublicKey,vapidPrivateKey,subject,ttlSeconds,jwtTtlSeconds,events}` |

The escrow keys are **not** written by `WorldDefaults::ToJson()` (they default
in `WorldEscrowRules` only) — an operator tuning a world blob will not find
them there. Listed in the report as a low finding.

## 17. What is NOT implemented (honest list, 2026-09-10)

- **World holdings are not seeded.** No faction has an opening force; the
  force ledger goes negative on the first commit and no route refuses a
  commit the faction cannot afford. `transports`/`squads` in a commit are
  unbounded integers.
- **Account world authority has no income.** Starting 100, founding −50,
  each claim −25 (50 % back if it fails). A player who founds and files two
  claims is at 0 forever unless a claim loses/expires. Commander authority
  accrues, account authority does not.
- **Treasury has no sink**, and Capacity is never spent — both are displays.
- **Withdrawal counts do not cross the seam**: every losing expedition
  settles `annihilated`; `withdrew`/`routed` are classified and tested but
  unreachable. `in_transit_home` (§7.3's third state) does not exist.
- **A no-winner ending (`season_end`, operator retire) settles escrow as a
  loss** with capture to the POI owner — a design gap, not a rule (report F4).
- **Transit pricing is single-edge**: a two-hop march is priced at the 12 h
  default, not the path sum; `origin` is not verified as a POI the faction
  holds (report F6).
- **Garrisons are commanders only.** A defended POI has no defender *force*
  in the world ledger; the battle's defender is whatever the scenario fields.
- **Governance** (Capture 25) is a string on the row; nothing votes.
  Rank is computed but weighs nothing.
- **Parley/diplomacy** exists only inside a battle (`game_parley.lua`);
  there is no world-level pact, tribute or non-aggression object.
- **Artifacts** are a rank weight multiplying zero. **Defection** and
  **faction collapse** do not exist (a dormant faction keeps its POIs
  forever). **Multi-world**: the schema is multi-world, the routes default to
  the primary world, and there is no policy on identity across worlds.
- **Pause does not pause battles**; `operatorRetire` is never raised.
- **Diversion of an inbound wave** (transports §7.2's one live control) has
  no route.

---

## 18. Proposed next milestones W13–W18

Each proposal is scoped to be implementable by a later lane without
re-deriving. All numbers are **config keys with defaults** (pillar 7). All new
tables are keyed by `world_id`; none by `room_id`. UI touchpoints follow the
drill-down directive (2026-08-29): summary affordances on the POI/faction
panels the World screen already has, click to drill, no always-on tables.

### W13 — World holdings seeding + force ledger integrity

**Goal.** A faction owns a finite force; commitments are affordable or
refused; the ledger can never go negative by accident.

**Rules.**
- `world_force_ledger` gains rows from two new sources: `seed_founding`
  (a founding grant: `holdingsFoundingTransports` 4, `holdingsFoundingSquads`
  12) and `holdings_income` (per POI held, per world-day: `holdingsSquadsPerPoiPerWorldDay`
  0.5, `holdingsTransportsPerPoiPerWorldDay` 0.125 — accrued by the economy
  tick with the same cursor, fractional amounts carried in a per-faction
  remainder column `world_holdings_remainder` so integer rows are appended
  only when a whole unit is earned).
- `WorldStaging::Commit` (and the route) refuses a commit whose counts exceed
  `ForceBalanceFor` with 409 `insufficient_force` `{have:{transports,squads},
  need:{...}}`. The check and the escrow debit run **inside one
  `SqliteWriteTransaction`** with the staging INSERT/UPDATE (closes report F5).
- Migration for existing worlds: a one-shot `seed_migration` row per faction
  that lifts a negative balance to zero, so no faction starts a season in debt
  it never chose (`holdingsMigrationFloorToZero` true).
- A cap: `holdingsMaxTransports` 64 / `holdingsMaxSquads` 256 per faction —
  income stops at the cap (a stockpile nobody defends is still finite).

**Tables/routes.** No new table; two new ledger sources and one remainder
table `world_holdings_remainder(world_id, faction_id, transports REAL,
squads REAL)`. `GET /api/world/stats` `economy.factions[]` gains
`force:{transports,squads}`; `POST /api/world/me` gains
`membership.force`. `GET /api/world/factions/{id}/ledger` (new, public):
the force + economy ledgers, newest first, paged.

**UI (drill-down).** The POI panel's commit control shows "you have N/M"
inline and disables past the balance; the faction summary chip shows the
force total; clicking it drills into the ledger route.

**Tests.** Commit refused at balance; commit exactly at balance succeeds and
the balance reads 0; migration row lifts a −3 balance to 0 exactly once;
income remainder carries across two ticks (0.5 + 0.5 = one squad row on the
second tick, none on the first); cap stops income; join-commit and escrow
open are one transaction (a failing escrow insert leaves no staging change).

**Risks.** Existing worlds' negative balances; the remainder column is the
first non-ledger world number (keep it explicitly *not* a balance).

### W14 — Garrisons: the defender's force

**Goal.** A held POI is defended by force the faction stationed there, not by
whatever the scenario fields; holding ground costs something.

**Rules.**
- `world_garrisons(world_id, poi_id, faction_id, squads INTEGER, updated_at)`
  — one row per faction per POI. A faction moves squads between its own POIs
  (`POST /api/world/garrison/move {from, to, squads}`) paying the edge transit
  (arrival lands after `transit × stagingWindowPerTransitMs` world-ms via a
  `world_garrison_moves` row the staging sweep completes); the force is
  escrowed in transit (`escrow_commit` source `garrison_move`).
- Materialisation passes the garrison to the battle as a second modoption
  `world_garrison = "<sideKey>:<squads>:<poiId>"`; `game_transports.lua`
  fields it as the home side's starting force (not an arrival — a defender
  "arrives by already being there", transports §7.1).
- At settlement: `held` by the defender → garrison unchanged minus battle
  losses when the loss conduit lands (until then unchanged); attacker `held`
  → the garrison is `annihilated` (25 % captured by the attacker's faction,
  the rest destroyed) and the POI's new owner's surviving expedition becomes
  its garrison (`settlement_return` lands in `world_garrisons` at that POI
  instead of the pool — transports §7.5 "survivors garrison in place").
- An **ungarrisoned held POI** materialises with the scenario's default
  defender as today (so the 2 a.m. defence still exists), but the claim rule
  gains an input: `claimUngarrisonedDiscount` 0.5 — filing against an
  ungarrisoned POI costs half (weakly held ground is cheap to contest).
- Rank's "POI held and garrisoned" term reads `world_garrisons` instead of
  commander presence when a faction has any garrison rows (commanders stay
  the fallback).

**UI.** POI panel: a garrison chip ("12 squads · 2 commanders"); drill to a
move sheet listing the faction's other POIs with transit times. Map: a thin
ring proportional to garrison size (summary affordance, no numbers until
hover).

**Tests.** Move debits origin and credits destination only after transit;
pause freezes the move; attacker win moves survivors into the garrison and
empties the old one; defender win leaves the garrison; a garrisoned POI
prices a claim at full cost, an ungarrisoned one at half; the modoption is
encoded exactly.

**Risks.** Two forces in one battle now come from the world (arrivals +
garrison) — the battle-side gadget must not double-field; the "survivors
garrison in place" rule needs the loss conduit to be honest.

### W15 — World diplomacy between factions (reusing parley concepts)

**Goal.** Factions can bind themselves *softly* to each other on the world
clock: non-aggression, tribute, joint staging. Reuses `game_parley.lua`'s
vocabulary (`ceasefire | tribute | safe_passage | joint_objective | demand |
intel`, a trust ledger, duration-based pacts) at world scale — but **no
alliance-grade capability** (PLAN-metalstorm-wars §6: no shared vision,
control or win). Rank-weighted acceptance is the governance hook.

**Rules.**
- `world_pacts(world_id, pact_id, kind, proposer_faction_id,
  counterparty_faction_id, state, terms_json, proposed_at_world_ms,
  starts_at_world_ms, ends_at_world_ms, resolved_at)`; `state ∈ proposed |
  active | expired | broken | declined | withdrawn`. Kinds v1:
  - `non_aggression` — for `durationWorldMs` (default 7 world days) a commit
    by either party at a POI the other holds is refused 409 `pact_forbids`;
    a party may **break** it (`POST /api/world/pacts/break`) which is a
    world event (`world-pact` SSE), records a trust hit
    (`world_trust(world_id, a, b, trust REAL)` decays like the battle
    ledger, `trustBreakPenalty` −50, `trustDecayPerWorldDay` 0.02 toward 0)
    and refunds nothing.
  - `tribute` — payer's treasury → payee's treasury, `amountPerWorldDay` for
    `durationWorldMs`, applied by the economy tick as paired
    `tribute_out`/`tribute_in` economy events; a payer whose treasury
    cannot cover a day breaks the pact automatically (the first treasury
    sink). Combined with non-aggression it is protection money — the
    Anarchic "toll" template.
  - `joint_staging` — for one named POI and window: the counterparty may
    **join** the proposer's open staging row (today only the same faction
    may). Escrow rows stay per faction; the war fields one side; spoils and
    capture split by committed share (`FlooredShare` per row, already the
    ledger's granularity). A winning claim still needs its own claim row —
    joint staging does not share the ground.
- Acceptance is a faction act: the counterparty's member whose Rank share
  ≥ `pactAcceptRankShare` (0.5 of the faction's `rankTotal`) accepts
  outright; otherwise the acceptance is a **vote** row
  (`world_votes(world_id, vote_id, subject_kind, subject_id, faction_id,
  opens_at_world_ms, closes_at_world_ms)` + `world_vote_ballots`), closed by
  the seasons sweep cadence, passing on > 50 % of `rankTotal` cast — the
  first use of Capture 25's governance, with the governance model string
  selecting the threshold (`hierarchical` 0.34 / `council` 0.5 / `consensus`
  0.67 / `minimal` 0.5).
- Proposals cost the proposer's account `pactProposeCost` 10 world
  authority (comms are never free — Capture 13).

**Routes.** `GET /api/world/pacts` (public), `POST /api/world/pacts/propose
{kind, counterparty, terms}`, `/accept {pactId}`, `/decline`, `/withdraw`,
`/break`; `GET /api/world/votes`, `POST /api/world/votes/cast {voteId, choice}`.

**UI.** The faction panel gains a "Relations" summary line (n pacts, trust
arrows); drill to a pact list; a proposal sheet reuses the battle parley
dialogue's shape; pact events are toasts on the existing `world-*` channel.
The map paints a dashed link between allied-by-pact factions' seats only
when a pact is selected (nothing always-on).

**Tests.** Non-aggression refuses the commit both ways and only for the
window; break records trust and fires the event; tribute moves treasury by
the tick and auto-breaks on an empty purse; joint staging escrows per
faction and splits capture by share; the rank-share acceptance shortcut vs.
the vote path; pause freezes pact clocks; a pact can never confer shared
vision/control (there is no field for it — assert the schema).

**Risks.** Vote closing is another sweep; rank changes mid-vote (snapshot
`rankTotal` at open); the alliance line must stay soft — reviewers should
reject any term that would seat two factions on one battle side by pact
alone (joint staging fields the same *side*, which both factions already are).

### W16 — Artifacts

**Goal.** Physical, placed, generated objects that grant faction-wide
parameter bonuses and give a POI a reason to be fought over (Capture 14).

**Rules.**
- `world_artifacts(world_id, artifact_id, name, poi_id, holder_faction_id,
  state, params_json, discovered_at_world_ms, created_at)`, `state ∈ hidden |
  revealed | held | in_transit`. Generated at POI seeding with probability
  `artifactPerPoiChance` 0.25 (never on a world-only POI): `{parameter,
  magnitude ∈ [0.05, 0.25], scope: faction, name}` from a relic register
  ("the Meridian Coil").
- **Reveal** is an Archaeology check on the world clock: a faction holding
  the POI reveals a hidden artifact after `artifactRevealWorldMs ×
  (1 − archaeology)` world-ms of continuous ownership (archaeology from the
  faction sheet, 0.25–0.75 → 0.75×–0.25× the base 5 world days).
- **Possession** follows POI ownership by default (a held artifact moves
  with a conquest transfer) *unless* the holder evacuates it: `POST
  /api/world/artifacts/move {artifactId, to}` puts it `in_transit` on the
  garrison-move path (W14), capturable if the origin falls before departure.
- **Effect**: `WorldFactionParameters` are read through a new
  `EffectiveParameters(faction)` that adds held artifacts' magnitudes
  (clamped to 1.0). Consumers today: `archaeology` (reveal speed), `finance`
  (`poiIncomePerWorldDay × (1 + finance − 0.5)`), `diplomacy` (W15
  `pactAcceptRankShare` × (1 − diplomacy/2)). Rank: `rankPerArtifact` 50 is
  already wired.
- Season digest gains `artifactsHeld`.

**Routes.** `GET /api/world/artifacts` (public: revealed and held only —
hidden ones are not served), `POST /api/world/artifacts/move`.

**UI.** A POI with a revealed artifact shows a relic glyph; the POI panel
lists it with its bonus; drill to the faction's effective parameter sheet
(the first place parameters become visible at all).

**Tests.** Generation respects the chance and never lands on a world-only
POI; reveal time scales with archaeology; conquest moves possession;
evacuation in transit is captured if the origin falls first; effective
parameters clamp; hidden artifacts are absent from the public route.

**Risks.** Parameters finally *do* something — the first balance surface;
keep every consumer a config multiplier with a 0-default so a world can
switch effects off per key.

### W17 — Defection and faction collapse

**Goal.** Captures 18/19: a player leaving takes what is under their direct
command, proportional to a split-ratio contest of authority; a faction with
nobody in it dissolves rather than owning ground forever.

**Rules.**
- **Defection** = leaving a faction while holding commanders. On
  `POST /api/world/factions/leave {defectTo?}` (or a later join), for each
  POI where the leaver has an active commander: the share of that POI's
  garrison (W14) that leaves =
  `Σ(leaver's commanders' authority at POI) / (Σ leavers + Σ loyal commanders' authority at POI)`,
  scaled by `defectionShareScale` 1.0, floored per squad; those squads and
  the leaver's commanders move to the new faction's garrison at the same POI
  (state `contested` if the POI stays with the old faction — a garrison of
  two factions at one POI is a **staging trigger**: the world opens a
  staging row for the defector's new faction with a `1 world hour` window,
  no transport needed, `origin = poi`). Commanders keep their authority;
  the leaver's Rank resets (per-faction, derived — for free).
- **Group defection** (Capture 19 stacking): a W15 pact kind
  `joint_defection` between members (not factions) lets several leavers
  stack their authority in one contest, resolved when the last signatory
  leaves within `defectionPactWindowWorldMs` 1 world day.
- **Loyalty counter-pull**: the old faction's `loyalty` parameter multiplies
  the loyal side's sum by `(1 + loyalty − 0.5)`.
- **Collapse**: a faction that has been `dormant` for
  `factionCollapseAfterWorldMs` 30 world days, *or* holds no POI and has no
  members, collapses: POIs become unowned, its garrison at each POI becomes
  a neutral `civilian` garrison row (fielded by the scenario's default
  defender), its treasury is forfeited (one `collapse` economy event),
  open claims and stagings are withdrawn/cancelled with refunds, and the
  row is marked `collapsed` (kept: settlements and ledgers still name it).
  A `world-faction` SSE event announces it. Members can re-found under the
  same name after collapse (`name_taken` no longer applies to a collapsed
  slug: the new faction gets `<slug>-2`).

**Routes.** `leave` gains `defectTo`; `GET /api/world/factions` reports
`collapsedAt`; `GET /api/world/factions/{id}/history` (settlements, claims,
pacts, collapse).

**UI.** Leaving with commanders shows a confirmation sheet with the computed
split ("8 of 20 squads at Randtown will follow you"); a collapsed faction's
POIs revert to the unowned colour with a short-lived "fell" marker.

**Tests.** The split formula at 0/50/100 % loyalist authority; loyalty
counter-pull; group pact stacking; contested garrison opens a staging row
with a 1 h window and no escrow debit; collapse after dormancy on the world
clock (pause freezes it); collapse refunds claims/stagings exactly once;
re-founding after collapse.

**Risks.** Defection is the largest social-abuse surface (alt accounts
joining to defect); gate `defectTo` on account age (`defectionMinAccountAgeDays`
7) and on the leaver having been a member ≥ `defectionMinMembershipWorldMs`
3 world days.

### W18 — Multi-world policy (G5)

**Goal.** Decide, once, what a "world" is to a player and to the operator, so
the schema's multi-world shape stops being an accident.

**Rules (proposal — one sentence each, revisable by the user).**
- **One primary world per lobby, many archived.** `worlds.state ∈ active |
  archived | frozen`; exactly one `active` world serves the World screen;
  `?world=` on the routes selects an archived/frozen world **read-only**
  (every POST refuses a non-active world with 409 `world_not_active`).
- **A season count ends a world, not the calendar**: `worldSeasonsMax` 0
  (unlimited) or N → after season N the world is `frozen` (no ticks, no
  commits, all reads served), a successor is founded with a new epoch, and
  players carry over **account world authority × `worldCarryoverFraction`
  0.25** and nothing else (factions re-found; the Randtown register reseeds).
- **Identity is per world**: `world_authority`, membership, commanders are
  already per world; the account is global. A player may be in a faction in
  every world they can see, but only one world is active at a time.
- **Operator routes** (admin): `POST /api/world/admin/found {worldId, name,
  ratio?, config?}`, `/freeze`, `/archive`, `/activate` — all through
  `WorldDirector::Upsert` (epoch set once), all audited to the lobby log.
- The world picker is a lobby-side list (`GET /api/worlds`, public).

**UI.** A single "Worlds" chip on the World screen header (current world
name + season); drill to the list; archived worlds open the same screen in a
read-only tint.

**Tests.** A POST against a frozen world is refused; a frozen world's clock
still reads and never moves (a permanent pause row is written at freeze);
carry-over credits authority once; `PrimaryWorldId` answers the one active
world; seeding a second world never rewrites the first's epoch.

**Risks.** `PrimaryWorldId` today is "oldest active" — if two worlds are
`active` the choice is silent; W18 makes it a refused state at `activate`.

---

## 19. Ranked opportunities for gameplay (this review's judgement)

1. **Holdings + garrisons (W13, W14)** — the loop has no scarcity: force is
   free, ground is undefended. Everything else is decoration until this
   lands.
2. **Account authority income** (a W13 sub-item): without it the claim purse
   empties after two claims and the conquest rule goes silent.
3. **Fix victory attribution and the season digest** (report F1/F2): today
   commander authority never rewards a win in production and the digest
   cannot name a faction — the stat family is not telling the truth.
4. **Diplomacy (W15)** — the first player-to-player world verb; tribute is
   also the first treasury sink.
5. **Season end = expedition annihilated** (report F4) — a punishment the
   player did not choose; cheap to fix, high trust value.
6. **Diversion of an inbound wave** (transports §7.2) — the between-battles
   activity Capture 30 asks for; small (one route, one staging edit).
7. **Artifacts (W16)** — parameters become real.
8. **Defection/collapse (W17)** — the emergent-politics layer; needs W14.
9. **Multi-world (W18)** — a policy sentence, mostly.
