# Metalstorm — Game Manual

_Last updated: 2026-08-29. This manual documents the game as **implemented** on `main`. Where the design intent and the shipped code differ, the difference is called out in §12 (Known gaps) rather than papered over. Source references point into `data/games/metalstorm/` (game Lua/JS) and `rts/Server/` (world layer C++)._

> **Metalstorm** — _Team-based large-scale strategy. Objectives over micro; authority over APM. The team owns the army._ (`modinfo.lua`)

## 0. Glossary — the words the game uses to players

Player-facing text uses these five words. The code still says `war` and `room` in many places; those are identifiers, not vocabulary.

| Word | Meaning | In the code |
|---|---|---|
| **World** | The one persistent game on the mega map. Where you land after login; every Mission is a drill-down from it. | the world layer, `world_*` tables, `/api/world/*` |
| **Mission** | A bounded task on one map in one room. **Not always a battle:** a reconnaissance survey, an escort, or a parley are Missions too. Entered as Support (join a larger Faction Mission), Solo (your own, small roster), Tutorial, or Broadcast (a delayed replay). | a "war" / "room"; the `wars` table, `/api/wars/*`, `war_outcome` |
| **Faction** | Your organisation in the World. A Mission's sides are which Faction each team fights for. | world factions (four archetypes) ↔ battle sides Compact / Union via `side_key` |
| **Standing** | The one number your account earns by playing: +10 per Mission, +5 per credited objective, +15 per mentor endorsement. Gates what you may command and see. | `users.standing`, `rank_<player>` in the sim |
| **Tier** | Standing, in five named bands: Recruit (0–19), Regular (20–59), Veteran (60–149), Officer (150–399), Commander (400+). | `Standing::TierFor`, per-player `tier` option |

## 1. The shape of the game

Metalstorm is two games joined by a hard seam:

- **The world layer** — a persistent strategic metagame played on a shared world map of points of interest (POIs). Factions hold ground, accrue treasury, stage attacks, and file conquest claims. It runs on a **world clock** (default 24:1 — one world day per real hour) and plays out over days and weeks. This is where bases, production, and the economy live.
- **Battles ("wars")** — real-time squad-tactics engagements fought in the browser. A war is one battle in one room on one map. Battles have **no base building and no production economy** — force enters a battle only as **transport arrivals** and leaves only as **departures**. In-battle construction is **field engineering only**: trenches, barricades, watchtowers, build-assist repair.

The seam is enforced structurally: the world layer never touches sim state, no `world_*` database table is keyed by `room_id`, and the battle reports back to the world only through a single settlement record (`war_outcome`).

There is **one resource: authority.** In battle it is earned by completing objectives and spent issuing orders. In the world it gates faction actions (founding, claims, commitments). There is no metal, no energy (`modinfo.lua` sets `resourceEconomy = false`).

## 2. Factions and teams

**Battle sides** (`gamedata/sidedata.lua`): two — **The Meridian Compact** and **The Foundry Union**. They are names and lore only; there is zero mechanical differentiation. Both start with `ms_engineers_s1`.

**World factions** (`rts/Server/WorldFactions.h`): player-founded organisations in one of four archetypes — `order`, `dynasty`, `resistance`, `anarchic`. Founding costs world authority (default 50, threshold 100); membership is the sole authority for "which faction is this player in", and a faction's `side_key` is the only bridge to the battle layer's faction identity. (The four-archetype taxonomy is a different axis from the two battle sides — don't conflate them.)

**Teams own everything.** Units and orders belong to the team, never to the player. Any team player commands any team unit. Players drop in and out mid-game: a leaver's personal authority pool merges into the team pool and their objective participation redirects team-ward — no unit or order transfer exists anywhere in the code (`game_teams.lua` records this as a binding rule). `team_leader` is bookkeeping with no gameplay privilege.

### 2.1 Standing and mentorship

**Standing** is per account and only ever goes up (§0). Your **Tier** decides your command scope: a Recruit commands only the squads assigned to them (Support) or a capped Solo roster; a Regular may command any unassigned team squad and sees the scoreboard, event log and diplomacy; a Veteran may mentor, suggest objectives and post bounties; an Officer creates Missions and runs the AI-command panel. Command scope is **responsibility, not ownership**: the team still owns every unit, but an order on an assigned unit from a lower Tier than its responsible player is refused, and a superior's order on your unit is shown as "order from <callsign> (<tier>)" (`game_assignment.lua`).

**Mentorship** pairs a Recruit with a Veteran or better on the same side (one active mentorship per mentee; `POST /api/mentor/*`). The mentor may assign tasks and command the mentee's squads; the mentee's HUD filters chatter to their mentor and their own squads ("Show everything" lifts it). If no human takes a Recruit on within thirty seconds the HUD offers an **AI mentor** (the strategos `mentor` profile, suggest-only); declining is a real answer. A mentor endorsement pays the mentee +15 Standing, once per pair per day.

**First Missions.** Until Tier 1 the hub offers two ways in: **Solo** — `tutorial_01` (Basic Training) and `recon_01` (Survey, a Mission with no enemy that ends on a parley agreement), both with a capped roster and no World stake, but counting toward Standing — and **Support**, deploying into a running Faction Mission as a minor role.

## 3. Authority — the economy

`LuaRules/Gadgets/game_authority.lua` owns pools; `game_authority_charge.lua` bills an order only after every other gadget has had its veto (a vetoed order is never charged).

**Order cost** (`authority/formula.lua`, config `LuaRules/Configs/authority_cost.lua`):

```
cost = ceil(base_k × authority_cost_base × regionMod × orderClassMod × costScale)
```

- `authority_cost_base` defaults to the unit's scale number (a super-heavy order costs 4× a light one).
- Region modifier: **0.5 in friendly territory, 1.0 neutral, 2.0 in enemy territory** — fighting on your own ground is cheap.
- Order-class modifiers: directive 1.0, standing 1.2, **micro 2.0**, group-op 0.5, build 3.0, **posture 0.25**, bounty 1.0, proposal 0.5. The pricing IS the design: micro-management is taxed, postures and delegation are subsidised.
- `costScale` is the `authority_cost_scale` modoption (0 = free orders, for playtests).

**Income:** objectives are the only primary income (§4). Teams start with 500; each joining player gets a grant (`authority_join_grant`, default 100); an optional per-minute stipend exists as a playtest lever. Long-horizon controls: a team soft ceiling (6000 × player count) with 2%/min overflow decay.

**Escrow:** objective rewards and bounties are held in escrow until the objective resolves (`authority/escrow.lua`); outcomes are `complete | expired | failed | war_end`, and a war ending routes every refund team-ward.

## 4. Objectives and victory

Objectives are the game (`game_objectives.lua`, six types):

| Type | Rule |
|---|---|
| `control` | hold a region for `holdFrames`; an open race when no team is named |
| `kill` | destroy a named unit (participation radius 800) |
| `escort` | transport form (deliver units to an extract area) or convoy form (payload to a destination) |
| `protect` | keep ≥ quorum alive until expiry; **expiry = success**, quorum break = failure |
| `extract` | two-phase: secure, then evacuate |
| `infra` | timed survival, or an open-ended income building paying `rewardPerMinute` |

A **systemic generator** (`objectives/generator.lua`) keeps battles supplied: seven rules (control, district, escort, infra, transport, `chain`, and a `liveness` starvation guard) with per-rule cooldowns and caps, scaled by the `objective_density` modoption (sparse/normal/dense).

Two of those rules exist to shape how a match FEELS rather than to supply it (both landed 2026-09-17):

- **The chain.** Complete a `control` and the board immediately offers the adjacent region you do not own, scoped to your team, at **+25 %** reward and on a **3-minute** clock. Every other generator rule is reactive — something became contested, something took damage, a convoy appeared — so nothing rewarded pressing an advantage. The chain is an offer, not a requirement; declining it costs nothing and the short clock keeps a declined chain off the board.
- **The comeback valve.** Objectives are the only primary authority income, so losing ground loses income, which buys fewer orders, which loses more ground. For a team behind on **owned regions**, team-scoped systemic rewards scale by `1 + deficit` capped at **×1.5**, and the liveness backstop gives it a fresh objective after one eval tick instead of two. Open races are never scaled (there is no behind team to price them for), the leader's rewards are never cut, nothing costs less, and no authority is minted directly — a team still has to go and complete the objective. The multiplier is published publicly as `objective_comeback_<team>`, so it reads as a stated rule rather than as the game quietly helping someone.

**Victory** (`game_gameover.lua`): the engine's last-team-standing fallback is deliberately disabled for Metalstorm. A **scenario is a war template**, and it declares which objective is terminal via `victory = true`. Completing it drives `active → winding_down (10 s grace) → resolving → GameOver`, with winners collected **by faction** across all that faction's teams. A scenario with no victory objective never ends in-session — players leave by detaching, and the war persists (hibernation is a server property, not a war state). Unresolved objectives at war end settle per `objectives/warend.lua` (complete → paid; anything else → its terminal state with war-end escrow).

## 5. Units and squads

**110 unit defs** (`units/`, generated families via `units/_builder.lua`):

- **11 classes × 4 scales** — `ms_<class>_s1..s4` for tanks, mechs, soldiers, engineers, artillery, static defense, radar, fighters, bombers, ships, subs. Scale words: Light / Line / Heavy / Super-heavy. **Squad size shrinks as scale grows** (16 soldiers at s1 → a single 30 000 hp flagship at tank s4). `maxdamage` is aggregate squad strength, not per-member HP.
- **Buildings**: military (`ms_command_nexus`, foundry, garrison, airbase, shipyard), 10 support structures (command post, watchtower, barricades, supply dump, rail platform…), 6 civilian, 6 resource sites (metal pit, oil derrick, grain silo…).
- **Logistics & recon**: supply truck, fuel tanker, courier, expedition rig, scout buggy, observation balloon, `ms_landing_ship`, `ms_technical`, civilians and militia.
- **`fable_*` showcase set** (26 defs): display models including the four world-faction dressings and the land-train consists.
- (`wz_*` defs are model-harness comparison fixtures, not roster.)

**Weapons:** 32 defs, all kinetic/explosive — MGs, autocannons, railguns, howitzers, mortars, bombs, flak, AA and cruise missiles, torpedoes, depth charges. No lasers.

**The squad is the sim atom.** The server simulates squads, not troops; `squad_size` and `formation_*` are client fan-out hints. The client's **SoA squad engine** (`client/squads/`, `config.engine: 'soa'`) renders members with steering, formation, air/naval cohesion, LOD tiers (full/centroid/icon), and crowd-to-fluid dense-cell aggregation — all purely cosmetic. Squad strength is **monotonic non-increasing**: reclaim, resurrect, capture, and healing complete units are all vetoed (`squad.lua` `AllowCommand`); `REPAIR` is build-assist only. New strength only ever arrives as a new squad — via arrivals.

**Default start force** (scenario-less games, `game_start.lua`): command nexus, engineers s2, soldiers s1+s2, tanks s2, radar s1, scout buggy, supply truck.

## 6. Battles: regions, transports, field engineering

**Regions** (`game_regions.lua`): every battle map is partitioned (grid or map-authored graph). Regions carry control scores with hysteresis, evaluated every 5 s, published as rulesParams. Region ownership feeds the authority cost modifier and objective generation.

**Transports** (`game_transports.lua`) are the battle's entire in/out economy. A scenario's sides declare `expeditionary` forces, `departure` zones, and an `arrivals` schedule (`kind = train|air|sea`, ETA frame, entry point, drop zone, cargo). There is deliberately **no in-battle "call reinforcements" verb** — reinforcement is a world-layer commitment that materialises as a scheduled arrival. Withdrawing force through a departure zone is how value leaves a battle alive.

**Field engineering:** engineers carry no buildoptions; support structures (trenches-and-towers tier) are the only in-battle construction. Base production is the world layer's (ruling 2026-08-19; see §12 for the enforcement caveat).

**Civilians** (`game_civilians.lua`): a synced, Gaia-driven population — towns, estates, convoys, routines — deliberately in-sim so objectives can reason about it deterministically.

**Land trains** (`game_train.lua`): coupled consists with follow-the-leader kinematics, pure Lua.

**Parley** (`game_parley.lua`): synced diplomacy between teams — ceasefires, tribute, safe passage, joint objectives, demands, intel — with ROE order vetoes, damage-based breach detection, and a trust ledger. A pact grants **no** alliance-grade capability: no shared vision, no shared control, no shared victory.

## 7. The interaction model — drill-down and natural language

**Governing directive (2026-08-29): the UI stays out of the way until needed.** Summary affordances, then click to drill into context-specific information and actions (including camera travel); one access point for global battle data (statistics, reports, events, objectives, diplomacy); depth on demand, never by default.

**HUD** (`ui/metalstorm.ui.json`): the centre of the screen stays clear. An authority pill (top-left), the focus strip and objective chips, the command composer (bottom-centre), and one **Battle** button (top-right, Tab) behind which the scoreboard, event log, reports, objectives board and diplomacy live as tabs. Both rails are empty except during a first Mission, when the **mentor card** and the tutorial's **coach card** sit on the left. Panels reveal by Tier (`revealOn`): scoreboard, events and diplomacy from Regular, the AI-command panel from Officer. Every widget declares `nlAliases` so voice/text can address it.

**Natural-language commands** (`ui/nl-instructions.md` + `ui/nl-response.schema.json`): typed or spoken commands are interpreted **against the current focus** (selection, open panels) into a schema-constrained response — 7 action kinds (`command`, `guidance`, `camera`, `ui`, `query`, `group`, `refuse`), 11 verbs (attack, secure, defend, hold, patrol, screen, scout, escort, withdraw, reinforce, build), 24 unit-class nouns matching `customparams.ms_class` exactly, triggers (`now`, `under-attack`, `region-contested`, `objective-complete`, `strength-below`). Ambiguity produces clarify buttons, never a guess; refusal is first-class. The resolver/executor pipeline lives in `client/src/ui/native-ui/`.

**Macro orders** (server-side, `rts/Server/OrgGroups.h` + `StandingOrders.h`): players and the AI organise squads into **org groups** (Platoon echelon in v0) and issue **directives** — 15 types from DefendArea and PatrolRoute through Assault, Screen, SupplyRoute and DefendFront, over point/circle/polygon/polyline shapes. Directive conditions default to `idleOnly` ("idle" = literally an empty command queue); an empty `squadTypes` filter is a wildcard; a group-scoped directive draws only from its roster, an unscoped one only from unassigned squads — rostered squads obey their own chain of command.

## 8. The world layer, as a player experiences it

1. **Found or join a faction** (archetype, name, side key). `POST /api/world/factions/*`.
2. **Read the map** — the lobby's world screen is a 2D POI graph over an equirectangular Earth basemap, on the world clock.
3. **Stage an attack** — commit at least one transport carrying at least one squad to a POI your faction doesn't hold (`POST /api/world/staging/commit`; a world-only POI with no battle map is refused). The defender needs no transport. The staging window is the transit time of the cheapest single edge from your named origin (or any POI you hold) to the target — edge weights are 60 000 world-ms per km — clamped to **1–72 world hours**, or **12 world hours** when no edge prices it: **the attacker's world-days in transit are the defender's real hours of warning.** Late commits by the same faction join the open window without moving it; any member may cancel before contact. The window is drained every ~10 s; five failed materialisation attempts fail the staging and refund the escrow.
4. **Force goes into escrow** (`WorldEscrow`): `committed → engaged → settled` (or `released` on cancel/failure). Escrowed force is unavailable to the world; the battle consumes it via the `world_commit` modoption and reports back only through `war_outcome`. Outcomes per side: `held | withdrew | routed | annihilated` — an annihilated expedition transfers **a quarter of its materiel to whoever owns the POI at war end** (the comeback valve); holding pays **25 treasury** spoils. Today every losing expedition settles `annihilated` (withdrawal counts do not yet cross the seam), and so does one whose war ended without an in-sim winner (`season_end`) — see §12.
5. **The battle materialises as a war** — a room with `session_kind='persistent'` plus a `wars` row; state machine `seeding → open → active → winding_down → resolving → archived`. Deploy in from the war browser; reconnect tokens survive disconnects; idle wars hibernate and resume transparently.
6. **Claim ground.** Conquest is an **explicit claim act** (`WorldConquest`, decided 2026-08-27): POI ownership transfers at war end only to a winning-side faction that filed a claim on that POI **before the war ended** (filing costs 25 of the filer's *account* world authority; one open claim per faction per POI; the owner cannot claim its own ground). No valid claim → the owner keeps it. **The defender's shield:** if the current owner is on the winning side, the POI never changes hands and an allied claim cannot snipe it. Earliest open winning claim wins (ties by file order) and is never refunded; losing, expired and withdrawn claims refund 50%; claims expire after 30 world-days; a war with no in-sim winner resolves no claim. A claim is not tied to a commitment — a winning-side faction that fielded nothing can still take the ground if its claim is earliest.
7. **The economy accrues in absentia** — +2 treasury per world-day per POI held, minus 1% of treasury per world-day, priced every ~30 s; event-sourced, so it catches up in one closed-form step after any outage (a world's first tick only plants the cursor). Pausing the world (`world_pause_ledger`) freezes accrual, seasons, claim expiry, staging windows and commander-authority decay for free — but not the Capacity recharge (24 **real** hours) and not running battles. Nothing spends treasury yet.
8. **Seasons** roll every 14 world-days: a digest of settlements and economy per faction is archived and a new season opens — no balances or ownership are touched. Every war is stamped with the season it was born in and ends on `season_end` once that season is over. Digests are served at `GET /api/world/seasons[/{n}]`.
9. **Notifications**: staging opened/materialised/cancelled/failed and POI ownership changes reach attacker faction, defender faction, and garrisoned commanders — in-lobby via chat SSE, and offline via **Discord webhooks** and **Web Push (RFC 8291)**, both per-world opt-in.

Rank (`WorldStats`) is derived on read, never stored: 10 per held commander + its authority, **25 per POI your faction holds and you garrison**, your share of the treasury, and (wired, multiplying zero) artifacts, resources, units; loaned commanders count for neither party. Commander authority accrues +12 per victory / +3 per defeat at the commander's POI and decays 1% per world-day to a floor of 1. Account world authority starts at 100 (founding costs 50, a claim 25) and has no income yet. Commander action capacity (20 + 10% of held commander authority) recharges over 24 **real** hours — an admin pause can't widen anyone's budget — and nothing spends it yet. The full rulebook with config keys is [world-layer.md](world-layer.md).

## 9. Maps and scenarios

13 maps ship in `data/maps/`. Six carry a `metalstorm.reachability` declaration — all six declare `"split"`: their start positions sit in separate armour realms **on purpose**, making the crossing a transport problem, not a defect. The declaration is a bidirectional contract: `regions_from_map.py --verify` fails the map if reality stops matching it. `reachability_classes` scopes the claim (e.g. `meridian_basin` is split for armour but connected for infantry — infantry outclimbs armour, deliberately).

The current **showcase war is `crossing_standoff`** on `scorched_crossing_v2.4` (4×4 region grid, symmetric approach to a central prize). The old `meridian_basin` scenario is **retired** (`retired = true` — a real scenario field honoured by the picker): its armour can't cross the map, which is correct for the map and wrong for that scenario. Two solo Missions run on the same map, sequenced by `game_tutorial.lua` from a `beats` table in the scenario file and narrated by the coach card (`ui/widgets/tutorial-guide.js`): **`tutorial_01`** (Basic Training: select, drill in, move to Grey Flat, hold it, open the Battle menu, move to and hold Storm Sound — the hold is the victory objective) and **`recon_01`** (Survey: three scout cars visit three regions, then a parley proposal to the Union post; the victory objective is a `parley` agreement and nothing staged can shoot). Reached from the hub's First mission card or `?play=<id>`; `tutorial_02/03` do not exist.

Maps are produced by the **terragen** pipeline (`tools/mapgen` — erosion, rivers, biomes, optional road speed layers, vegetation; see [maps/generation.md](maps/generation.md)). World scale is **8 elmos = 1 m**, applied to models at import.

## 10. AI

**Strategos** (`ai/strategos/`) is one brain with three deployment roles — `full_side` (plays a side), `co_commander` (advises/assists a human team), `npc` — and five profiles (default, aggressive, caretaker, mentor, npc_raider). It runs at 0.2 Hz with distance/dwell LOD, sees only what a player sees (fog-limited, radar blips included), pays authority for every directive, and is rate-limited to one directive per group per tick in the C++ drain.

**Its strategic floor is structural:** the actuator set contains no `moveSquad`/`attackTarget` — the AI *cannot* micro because the verb doesn't exist. Humans steer it with **guidance** (`game_ai_guidance.lua`): stance, region paint (priority/forbidden), asset locks, objective delegation, funding, ROE, veto — the same `guidance` surface the NL layer exposes.

## 11. Match setup (modoptions)

`modoptions.lua`: `persistent` (default **true** — wars persist/hibernate), `authority_reward_scale`, `authority_cost_scale` (0 = free orders), `authority_join_grant`, `authority_team_stipend`, `objective_density` (sparse/normal/dense), `battle_production` (default off — lifts the field-engineering gate for playtests), `ai_caretaker`, `build_time_scale`.

## 12. Known gaps (design ≠ enforcement, honest edition)

- **Enforced** since 2026-09-10: `LuaRules/Configs/field_engineering.lua` + `game_authority.lua` veto factory production and non-support structures (`AllowCommand` on build orders, `AllowUnitCreation` backstop); modoption `battle_production` lifts it for playtests.
- **World holdings aren't seeded yet:** committing force a faction doesn't have is refused by nothing (the counts are unbounded integers); the escrow ledger opens negative until a world-holdings milestone lands. Held POIs have no defender *force* in the world — the battle's defender is whatever the scenario fields.
- **Account world authority has no income.** It starts at 100; founding spends 50 and each claim 25 (half back on a loss). Commander authority accrues from settlements; the account purse never does, so the claim rule goes quiet after a couple of filings. Treasury has no sink and Capacity is never spent — both are displays.
- **Commander victory attribution and the season digest compare a world faction id against a battle side key** (`war_outcome.winnerFactions` holds side keys), so in production a commander is only ever awarded the defeat rate and `settlementsWon` is bucketed by side, not faction. Patch proposed in the 2026-09-10 world-design review.
- **Every losing expedition settles `annihilated`** — withdrawal counts do not cross the seam yet, so `withdrew`/`routed` are unreachable — and a war that ends with no in-sim winner (`season_end`) settles the expedition as a loss too, handing a quarter of it to the POI owner.
- **Staging warning can be minimised**: the `origin` a committer names is not checked against what the faction holds, and transit is priced on a single edge (a two-hop march gets the 12-hour default). Attacker/defender same-side and side-less factions are discovered only at materialisation, after the whole window.
- **Pausing the world does not pause battles** (orchestration is a stub) and `operatorRetire` has no GM verb.
- **Parley/diplomacy, artifacts, defection, faction collapse and multi-world policy** are unbuilt; designs for W13–W18 are in [world-layer.md](world-layer.md) §18.
- **Reward normalisation is off** (`reward_normalisation_enabled = false`) and the economy validation grid is dead (see PLAN-economy-grid.md's autopsy).
- **Parley AI verbs are stubs** — strategos cannot yet propose or answer proposals; I2 (team-private rulesParam privacy through streaming) is pending.
- **In-game clients get no room SSE** — world/war notifications reach lobby browsers only; a 410-gone push endpoint is logged, not pruned.
- **No in-battle production also means the `build` order class (3.0×) is mostly latent** — it prices field engineering and world-layer flows.

## 13. Where to read more

- Architecture and subsystem reference: [ARCHITECTURE.md](../ARCHITECTURE.md)
- HTTP API (incl. `/api/world/*`): [api.md](api.md)
- Map generation: [maps/generation.md](maps/generation.md) · Scenario authoring: [scenarios.md](scenarios.md)
- Browser automation and debugging: [debugging.md](debugging.md), [javascript.md](javascript.md)
- Design plans: `PLAN-metalstorm*.md`, `PLAN-worldsim.md`, `PLAN-maps.md` (main checkout only; gitignored)
