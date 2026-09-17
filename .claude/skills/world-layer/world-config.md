# World tunables, and how to change one

Reference for the **world-layer** skill. Every value below is a world's
ship-with default, defined in `rts/Server/WorldDirector.h` and stored per world
in `worlds.config_json`. The world's own row is the authority the moment it
exists — the header is only what a *new* world starts with.

## There is no admin route for these

`world_pause` is the only world-level admin verb that ships. Changing a rate
means editing the row:

```bash
# 1. STOP THE LOBBY FIRST. The lobby's SQLite is built THREADSAFE=2 and it
#    holds the connection; a concurrent writer is how you corrupt it.
sqlite3 <the lobby --db path> \
  "UPDATE worlds SET config_json = json_set(config_json,
     '\$.stagingWindowDefaultWorldMs', 3600000) WHERE world_id = '<id>';"
# 2. Start the lobby. Confirm with world_status (detail:'all').
```

Read the current values without any of that: `world_status {detail:'all'}`
prints the resolved config.

## Authority — what acts cost and what pays for them

| Key | Default | Means |
|-----|---------|-------|
| `startingAuthority` | 100 | credited to an account the first time a world sees it |
| `foundFactionAuthority` | 100 | authority you must HOLD to found |
| `foundFactionCost` | 50 | what founding SPENDS |
| `claimPoiCost` | 25 | charged to the filing account per claim |
| `claimRefundFraction` | 0.5 | returned on any non-won resolution |
| `claimExpiryWorldMs` | 30 world-days | unresolved claims expire; ≤ 0 disables |
| `authorityPerVictory` | 12 | |
| `authorityPerDefeat` | 3 | |
| `authorityDecayPerWorldDay` | 0.01 | gentle decay, applied per world day |
| `authorityFloor` | 1 | decay never takes you below this |
| `commanderGrantAuthority` | 50 | the starter commander grant |

There is **no authority income** yet. `startingAuthority` is what makes the
founding gate reachable at all, so an account that has spent down cannot
currently earn its way back except through victories.

## Staging

| Key | Default | Means |
|-----|---------|-------|
| `stagingWindowDefaultWorldMs` | 12 world-h | the window when there is no transit to price |
| `stagingWindowPerTransitMs` | 1 | multiplier on the origin→target transit |
| `stagingWindowMinWorldMs` | 1 world-h | clamp floor |
| `stagingWindowMaxWorldMs` | 72 world-h | clamp ceiling |
| `stagingMaterialiseMaxAttempts` | 5 | retries before the sweep gives up |

## Escrow

| Key | Default |
|-----|---------|
| `escrowAnnihilatedCaptureFraction` | 0.25 |
| `escrowWithdrewThresholdFraction` | 0.50 |
| `escrowHeldSpoilsTreasury` | 25 |

## Economy and seasons

| Key | Default | Means |
|-----|---------|-------|
| `poiIncomePerWorldDay` | 2.0 | treasury income per owned POI per world day |
| `treasuryDecayPerWorldDay` | 0.01 | |
| `treasuryFloor` | 0.0 | |
| `seasonLengthWorldMs` | 14 world-days | a narrative/archival unit, not a balance lever |

Season digests (settlements won, POI income, decay, treasury at rollover) are
written **at rollover**. An active season answers `world_seasons {number:N}`
with a 200 and an empty `digests` array — that is not an error and not an empty
season, it is a season that has not been archived yet. A `factionId` of null in
a digest row is the unclaimed bucket.

## Capacity and rank

| Key | Default | Means |
|-----|---------|-------|
| `capacityBase` | 20.0 | |
| `capacityPerCommanderAuthority` | 0.10 | |
| `capacityRechargeHours` | 24.0 | **REAL hours, not world hours** |
| `capacityRechargeFraction` | 1.0 | |
| `rankPerCommander` | 10.0 | |
| `rankPerCommanderAuthority` | 1.0 | |
| `rankPerPoiHeld` | 25.0 | |
| `rankPerArtifact` | 50.0 | |

`capacityRechargeHours` being real hours is deliberate and is the one unit
inconsistency in the table: the ceiling exists to protect the player's day, so
an admin world pause must not widen anybody's budget.

## The clock

The clock is columns on the `worlds` row rather than keys in `config_json`, so
that a corrupt tunables blob can never move it: `epoch_real_ms`,
`epoch_world_ms`, `time_ratio_num` (24), `time_ratio_den` (1). Every
`*WorldMs` value above is in **world** milliseconds; divide by 24 for real time.
