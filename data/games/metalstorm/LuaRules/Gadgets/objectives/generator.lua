-- objectives/generator.lua — systemic objective generation (PLAN-metalstorm-objectives.md §3.2).
-- Plain library module (NOT a gadget — this subfolder is invisible to the
-- non-recursive gadget scanner, same convention as civilians/). Included by
-- game_objectives.lua, which owns the periodic call + supplies a `world`
-- facade over Spring/GG so this file stays busted-testable with a fake world
-- (§9 "systemic dedup ... liveness rule fires on a starved team").
--
-- Each rule is `{ key, cooldown, cap, scan }`: `scan(world, state)` returns a
-- list of `{ dedupKey, build }` candidate instances found this tick; `build`
-- returns either a plain GG.Objectives.Create def, or `{ linkedPair = true,
-- escort = def, kill = def }` for the paired escort+kill rule (E4). The
-- generator is idempotent per world-state key —
-- `state.systemicActive[dedupKey]` tracks the live objective id for that
-- key, so re-triggering while one is active is a no-op; game_objectives.lua
-- calls `generator.clearActive` when the objective it tagged with that key
-- resolves.
local generator = {}

-- ============================================================
-- §10.6 — THE REWARD DERIVATION (one derivation, no authored magnitudes)
--
-- Every systemic reward used to be a literal (30, 40, 50, 60, 75, 90, 120)
-- with nothing tying it to what an order costs. §10.6 has always said they
-- should come from `LuaRules/Configs/authority_cost.lua`'s median directive
-- cost instead. They now do, and nothing here is picked by hand:
--
--   REWARD_UNIT = ceil(base_k × median_directive_basis × medianRegionMod
--                      × order_class.directive)
--
--     * `base_k`, `median_directive_basis` and `order_class.directive` come
--       straight out of the cost spec. `median_directive_basis` is the
--       corpus-measured median roster basis of a group-scoped directive (see
--       its comment there) — the thing game_authority.lua actually charges on.
--     * `medianRegionMod` = sqrt(region_mod_min × region_mod_max), the
--       GEOMETRIC centre of the authored region band. The band is
--       multiplicative (0.5 friendly ↔ 2.0 enemy), so its centre is the
--       geometric mean — which is exactly 1.0, neutral ground. An arithmetic
--       mean would silently price every objective as if wars were fought in
--       enemy territory.
--     * The shape is `authority/formula.lua`'s, deliberately: a reward is
--       priced by the same arithmetic as the order it is meant to fund. It is
--       spelled out rather than required so this file stays a plain library
--       with no load-order dependency on the authority plugin.
--
-- Each rule then states its reward as a COUNT OF MEDIAN DIRECTIVES — "this
-- objective funds N typical orders" — in `DIRECTIVES` below. Those counts are
-- ORDINAL: they are the design's existing ranking of the rules against each
-- other (infra cheapest, extraction dearest), carried over unchanged from the
-- literals they replace. The MAGNITUDE is entirely REWARD_UNIT's. Move
-- `median_directive_basis` or the directive class modifier and every reward in
-- the game moves with it; that is the whole point of the change.
--
-- Acceptance is `node tools/economy-validation.js`, not any number in here.
-- ============================================================

--- The cost spec, from the engine when there is one and from the file system
--- when there is not (busted, and `authority/economy_sim.lua`). The candidate
--- list covers every cwd a spec runs this module from: `Gadgets/objectives`
--- and `Gadgets/authority` are two deep, `Gadgets` is one.
local function loadCostSpec()
    if VFS and VFS.Include then
        local ok, spec = pcall(VFS.Include, 'LuaRules/Configs/authority_cost.lua')
        if ok and type(spec) == 'table' then return spec end
    end
    for _, p in ipairs({ '../../Configs/authority_cost.lua',
                         '../Configs/authority_cost.lua' }) do
        local ok, spec = pcall(dofile, p)
        if ok and type(spec) == 'table' then return spec end
    end
    -- No spec reachable (a spec that stubs neither VFS nor the cwd). Falling
    -- back to the shipped constants keeps this module loadable; it is the one
    -- place a literal survives, and it is a mirror, not a choice.
    return { base_k = 1.0, median_directive_basis = 4,
             order_class = { directive = 1.0 },
             region_mod_min = 0.5, region_mod_max = 2.0 }
end

--- The derivation itself. Exported so the harness and the specs read the one
--- number this file computed rather than recomputing a second copy of it.
function generator.rewardUnit(spec)
    spec = spec or loadCostSpec()
    local classMod = (spec.order_class and spec.order_class.directive) or 1.0
    local regionMod = math.sqrt((spec.region_mod_min or 1.0) * (spec.region_mod_max or 1.0))
    return math.ceil((spec.base_k or 1.0) * (spec.median_directive_basis or 1)
                     * regionMod * classMod)
end

local REWARD_UNIT = generator.rewardUnit()
generator.REWARD_UNIT = REWARD_UNIT

--- How many median directives each rule's objective funds — the design's own
--- ranking of the rules, and the ONLY per-rule input to a reward. Read by the
--- specs so an expectation is stated in directives too.
local DIRECTIVES = {
    infra     = 3,    -- repair one damaged building
    district  = 4,    -- hold a civilian district through a raid
    control   = 5,    -- take a region (× its own regionValue multiplier)
    escort    = 6,    -- see a convoy home, or kill it
    liveness  = 8,    -- the dead-game backstop, worth more than the rule it apes
    arrival   = 9,    -- land a wave alive, or shoot it down
    extract   = 12,   -- get a transport off the map — the dearest decision
    chainBase = 5,    -- a chain whose parent's reward is unknown
}
generator.DIRECTIVES = DIRECTIVES

--- reward(n) — n median directives, in authority.
local function reward(n) return n * REWARD_UNIT end

-- Density (modoption objective_density) scales cap and cooldown per rule, and
-- sets the per-team CONCURRENCY CEILING (see `fire`).
--
-- RATE CAPS, NOT TASTE. `capMul` keeps its original meaning (how many of one
-- rule's objectives may be live at once). `cooldownMul` and `teamCap` are the
-- economy's governor and were swept with `node tools/economy-validation.js`
-- over 16 seeds; these are the values that hold every `mixed` cell inside the
-- bands, not a preference:
--
--   * `teamCap` is 9 at every density. It is not flat by choice — 8 starves
--     the early war and 10 ends it at a pool ratio of 18, on either side of a
--     cliff about one objective wide.
--   * `sparse`'s `capMul` had to come up from 0.5 to 1.0. At 0.5 a rule is
--     held to two concurrent objectives, and the harness's single-rule sparse
--     cells show the two cheapest rules (infra, district) then cannot fund a
--     team's order rate at all — velocity 1.6–1.8 against a 1.5 ceiling, on
--     every seed. Shortening the cooldown does not touch it; the per-rule cap
--     is the binder. Those cells were passing before this change only because
--     the authored rewards were about 2.5× what the derivation gives.
--   * `dense` shares `normal`'s cooldown. Anything faster mints past the pool
--     band, so what "dense" buys is a different MIX (twice as many of any one
--     rule live at once), not more income.
--
-- What the density knob now IS, stated plainly because the numbers no longer
-- support the old story: once the per-team ceiling binds, TOTAL VOLUME IS
-- FLAT — every density runs about 970–1000 systemic objectives over a
-- 40-minute 2v2, and shortening a cooldown redistributes slots between rules
-- rather than adding any. `objective_density` selects the MIX and the tempo of
-- re-arming; it is not, and after this change cannot be, an income knob. See
-- `authority/economy_sim.lua`'s header for the measured grid.
local DENSITY = {
    sparse = { capMul = 1.0, cooldownMul = 0.90, teamCap = 9 },
    normal = { capMul = 1.0, cooldownMul = 0.75, teamCap = 9 },
    dense  = { capMul = 2.0, cooldownMul = 0.75, teamCap = 9 },
}

function generator.newState()
    return {
        systemicActive = {},    -- dedupKey -> objective id (bookkeeping only)
        cooldownUntil = {},     -- dedupKey -> frame
        ruleCounts = {},        -- rule key -> count of currently-active objectives from that rule
        contestedSince = {},    -- regionKey -> tick first seen contested (control rule debounce)
        seenConvoys = {},       -- convoy id -> true (edge-trigger "convoy created")
        seenArrivals = {},      -- arrival id -> true (edge-trigger "a wave is on the map")
        seenInfraHealth = {},   -- infra unitID -> last-seen health fraction (edge-trigger damage)
        starvedSince = {},      -- team -> tick first seen with zero completable objectives
        chainQueue = {},        -- pending follow-ups from completed controls (chain rule)
        teamCounts = {},        -- team -> live systemic objectives ON THAT TEAM'S BOARD
        systemicTeams = {},     -- dedupKey -> the teams it was counted against
    }
end

--- Called by game_objectives.lua when a systemic objective COMPLETES (never
--- for failed/expired). Feeds the chain rule below; everything else ignores it.
---
--- Queued rather than acted on directly because resolution happens mid-walk of
--- the active list: creating an objective from inside `resolveObjective` would
--- mutate `activeList` under an iteration that a snapshot was taken precisely
--- to protect. The next generator tick is milliseconds away and is where every
--- other rule creates from.
function generator.onCompleted(state, objective)
    if not objective or objective.type ~= 'control' then return end
    local team = objective.completedBy or objective.forTeam
    local key = objective.params and objective.params.regionKey
    if not team or not key then return end
    state.chainQueue[#state.chainQueue + 1] =
        { team = team, fromKey = key, reward = objective.reward or 0 }
end

--- Called by game_objectives.lua whenever the objective tagged with
--- `dedupKey` (o.systemicKey) leaves the active state, so the rule can fire
--- again for the same world-state key.
function generator.clearActive(state, dedupKey)
    if not dedupKey then return end
    state.systemicActive[dedupKey] = nil
end

--- Called alongside clearActive to keep ruleCounts accurate (cap enforcement
--- counts CURRENTLY-active systemic objectives per rule, not lifetime total).
---
--- F13: idempotent per dedupKey. A linked pair (E4 — the escort+kill race) is
--- TWO objectives sharing ONE systemicKey and one `ruleCounts` increment, and
--- resolving either half mutually resolves the other — so both halves call in
--- here and the cap fell by 2 per pair. Over a war that drives the rule's
--- count negative-by-clamp to 0 and lifts its cap entirely. The live-entry
--- lookup is the natural guard: the first call clears it, the second finds
--- nothing to release and does nothing.
function generator.onResolved(state, ruleKey, dedupKey)
    if dedupKey and state.systemicActive[dedupKey] == nil then return end
    generator.clearActive(state, dedupKey)
    if ruleKey and state.ruleCounts[ruleKey] then
        state.ruleCounts[ruleKey] = math.max(0, state.ruleCounts[ruleKey] - 1)
    end
    -- The concurrency ceiling frees on exactly the same guarded path as the
    -- per-rule cap, so a linked pair releases one slot, not two (F13).
    local teams = dedupKey and state.systemicTeams[dedupKey]
    if teams then
        for _, team in ipairs(teams) do
            state.teamCounts[team] = math.max(0, (state.teamCounts[team] or 1) - 1)
        end
        state.systemicTeams[dedupKey] = nil
    end
end

--- Exported so the economy harness (authority/economy_sim.lua) sweeps the REAL
--- density multipliers rather than a second copy of them that can drift.
generator.DENSITY = DENSITY

local function densityFor(mo)
    return DENSITY[mo] or DENSITY.normal
end

--- Scale a def's reward by its team's comeback multiplier, in place. Handles
--- the linked-pair shape: the escort half is team-scoped and scales, the kill
--- half is the open race against it and does not.
local function applyComeback(world, def)
    local function scaleOne(d)
        if not d or not d.forTeam or not d.reward or d.reward <= 0 then return end
        local scale = generator.comebackScale(world, d.forTeam)
        if scale > 1 then d.reward = math.floor(d.reward * scale) end
    end
    if def.linkedPair then
        scaleOne(def.escort)
        scaleOne(def.kill)
    else
        scaleOne(def)
    end
end

--- Which boards an objective lands on, for the concurrency ceiling. A
--- team-scoped objective is one team's work; an OPEN RACE is on everybody's
--- board and is counted against every team, because that is who it can pay.
--- A linked pair is counted once, against the scoped half's team — the pair is
--- one offer with two ways to answer it.
local function boardsFor(world, def)
    local scoped = def.linkedPair and (def.escort and def.escort.forTeam) or def.forTeam
    if scoped ~= nil then return { scoped } end
    return world.teams and world.teams() or {}
end

local function fire(state, world, density, rule, dedupKey, build)
    if state.systemicActive[dedupKey] then return end   -- already live, no-op (idempotent)
    if world.frame < (state.cooldownUntil[dedupKey] or 0) then return end

    local cap = math.max(1, math.floor(rule.cap * density.capMul))
    local count = state.ruleCounts[rule.key] or 0
    if count >= cap then return end

    local def = build()

    -- ── The concurrency ceiling (the second §10.6 lever) ──────────────────
    --
    -- The per-rule caps above bound each rule in isolation and every one of
    -- them passes the economy harness alone. Run all seven together and the
    -- board mints two to fifty times what a team can spend, because nothing
    -- was ever bounding the TOTAL. This is that bound: at most `teamCap` live
    -- systemic objectives on any one team's board.
    --
    -- Its value is not a balance opinion, it is what
    -- `node tools/economy-validation.js` accepts — the mixed cells' velocity
    -- and pool ratio are a near-linear function of it, and 9/9/10 is where all
    -- three densities sit inside the bands. Density still shapes WHICH
    -- objectives appear and how fast they refresh (capMul/cooldownMul); the
    -- ceiling is what keeps the economy solvent while it does.
    --
    -- The liveness backstop is exempt by construction: a team is only starved
    -- when its board is empty, and a ceiling that could refuse the rule whose
    -- whole job is to unstarve it would be a deadlock, not a cap.
    if not rule.exemptTeamCap then
        local boards = boardsFor(world, def)
        for _, team in ipairs(boards) do
            if (state.teamCounts[team] or 0) >= density.teamCap then return end
        end
    end

    -- The comeback valve scales TEAM-SCOPED systemic rewards only. Applied
    -- here rather than in each rule's `build` so a seventh rule cannot quietly
    -- opt out of it, and so an open race (`forTeam` nil) is skipped by
    -- construction rather than by every rule author remembering to.
    applyComeback(world, def)

    def.systemicKey, def.systemicRule = dedupKey, rule.key

    local id
    if def.linkedPair then
        def.escort.systemicKey, def.escort.systemicRule = dedupKey, rule.key
        def.kill.systemicKey, def.kill.systemicRule = dedupKey, rule.key
        id = world.createLinkedPair(def.escort, def.kill)
    else
        id = world.create(def)
    end
    if not id then return end   -- Create validated params and rejected (E1) — do not book it

    state.systemicActive[dedupKey] = id
    state.ruleCounts[rule.key] = count + 1
    state.cooldownUntil[dedupKey] = world.frame + math.floor(rule.cooldown * density.cooldownMul)

    -- Booked AFTER a successful create, and booked even for an exempt rule:
    -- liveness objectives are not refused by the ceiling but they do occupy
    -- the board, so the rules that are capped must see them.
    local boards = boardsFor(world, def)
    if #boards > 0 then
        state.systemicTeams[dedupKey] = boards
        for _, team in ipairs(boards) do
            state.teamCounts[team] = (state.teamCounts[team] or 0) + 1
        end
    end
end

-- ============================================================
-- Rule: contested region -> control objective, open race.
-- ============================================================
local CONTESTED_DEBOUNCE_TICKS = 2   -- "contested >= 2 eval ticks" (§3.2 table)
local CONTROL_HOLD_FRAMES = 900      -- 30s hold to complete (tunable)

local controlRule = {
    key = 'control', cooldown = 1800, cap = 6,
    scan = function(world, state)
        local out = {}
        local stillContested = {}
        for _, key in ipairs(world.contestedRegions()) do
            stillContested[key] = true
            state.contestedSince[key] = state.contestedSince[key] or world.tick
            if (world.tick - state.contestedSince[key]) >= (CONTESTED_DEBOUNCE_TICKS - 1) then
                out[#out + 1] = {
                    dedupKey = 'control:' .. key,
                    build = function()
                        return {
                            type = 'control', scope = 'strategic', source = 'systemic',
                            reward = reward(DIRECTIVES.control) * (1 + (world.regionValue(key) or 0)),
                            params = { regionKey = key, holdFrames = CONTROL_HOLD_FRAMES },
                        }
                    end,
                }
            end
        end
        for key in pairs(state.contestedSince) do
            if not stillContested[key] then state.contestedSince[key] = nil end
        end
        return out
    end,
}

-- ============================================================
-- Rule: civilian district under enemy threat -> protect (owner team).
-- Depends on GG.Civilians population data (civilians/spawn.lua seeding is
-- still a stub as of this writing — this rule is correct and ready, but
-- produces nothing until civilians actually populate districts; tracked in
-- the civilians backlog, not this plan).
-- ============================================================
local DISTRICT_PROTECT_FRAMES = 1800   -- 60s window

local districtRule = {
    key = 'district', cooldown = 1800, cap = 4,
    scan = function(world, state)
        local out = {}
        for _, threat in ipairs(world.civilianDistrictsUnderThreat()) do
            out[#out + 1] = {
                dedupKey = 'district:' .. threat.districtId,
                build = function()
                    return {
                        type = 'protect', scope = 'tactical', source = 'systemic',
                        forTeam = threat.districtTeam,
                        reward = reward(DIRECTIVES.district),
                        expiresAtFrame = world.frame + DISTRICT_PROTECT_FRAMES,
                        params = { targetUnitIDs = threat.unitIDs },
                    }
                end,
            }
        end
        return out
    end,
}

-- ============================================================
-- Rule: convoy scheduled -> escort (benefactor team) + kill race (others),
-- created as a linked pair (E4). Same civilians-stub caveat as districtRule.
-- ============================================================
local escortRule = {
    key = 'escort', cooldown = 900, cap = 4,
    scan = function(world, state)
        local out = {}
        for _, convoy in ipairs(world.newConvoys()) do
            if not state.seenConvoys[convoy.id] then
                state.seenConvoys[convoy.id] = true
                out[#out + 1] = {
                    dedupKey = 'convoy:' .. convoy.id,
                    build = function()
                        return {
                            linkedPair = true,
                            escort = {
                                type = 'escort', scope = 'tactical', source = 'systemic',
                                forTeam = convoy.benefactorTeam, reward = reward(DIRECTIVES.escort),
                                params = { payloadUnitIDs = convoy.unitIDs, destArea = convoy.destArea },
                            },
                            kill = {
                                type = 'kill', scope = 'tactical', source = 'systemic',
                                reward = reward(DIRECTIVES.escort),
                                params = { targetUnitID = convoy.unitIDs[1] },
                            },
                        }
                    end,
                }
            end
        end
        return out
    end,
}

-- ============================================================
-- Rule: infra building damaged and undefended by an objective -> infra
-- (owner, timed). Detected by edge-triggering on a health drop between
-- ticks (periodic-scan cadence, no dedicated UnitDamaged callin needed).
-- ============================================================
local INFRA_HOLD_FRAMES = 1800

local infraRule = {
    key = 'infra', cooldown = 1800, cap = 4,
    scan = function(world, state)
        local out = {}
        local stillTracked = {}
        for _, b in ipairs(world.infraBuildings()) do
            stillTracked[b.unitID] = true
            local prevFrac = state.seenInfraHealth[b.unitID]
            state.seenInfraHealth[b.unitID] = b.healthFrac
            if prevFrac and b.healthFrac < prevFrac and b.healthFrac < 1.0 then
                out[#out + 1] = {
                    dedupKey = 'infra:' .. b.unitID,
                    build = function()
                        return {
                            type = 'infra', scope = 'tactical', source = 'systemic',
                            forTeam = b.ownerTeam, reward = reward(DIRECTIVES.infra),
                            expiresAtFrame = world.frame + INFRA_HOLD_FRAMES,
                            params = { buildingUnitIDs = { b.unitID } },
                        }
                    end,
                }
            end
        end
        for id in pairs(state.seenInfraHealth) do
            if not stillTracked[id] then state.seenInfraHealth[id] = nil end
        end
        return out
    end,
}

-- ============================================================
-- Rule: TRANSPORTS — the universal generator floor
-- (PLAN-metalstorm-objectives.md §10.5, PLAN-metalstorm-transports.md §7.1).
--
-- WHY THIS IS THE FLOOR. Every other rule above waits on content that most
-- maps do not have: controlRule needs `mapdata/regions.lua` (6 of 13 shipped
-- maps), escortRule needs civilian convoy routes (1 of 13, and that map is
-- retired), districtRule needs planned townships, infraRule needs an
-- `objective_infra` tag no def in the game carries. So on a typical map the
-- systemic generator produced nothing but the liveness backstop's forced
-- control objective.
--
-- Transports are different in kind: a battle OPENS when a faction commits a
-- transport to a POI (transports §7.1), so a battle with no transport in it
-- is not a battle. This rule therefore works on every map, with no map
-- content whatsoever, and it generates objectives about the thing the ruling
-- of 2026-08-19 made the battle's whole in/out economy.
--
-- Two shapes, both from §10.5's sentence ("secure a landing zone, defend an
-- arrival point, escort a departing transport"):
--
--   ARRIVAL (a linked pair, exactly escortRule's E4 shape). A wave is on the
--   map and still carrying: its owner is told to get it down alive (inbound
--   escort on the drop zone), everyone else is told to kill it. That single
--   pair is "secure a landing zone" and "defend an arrival point" from the
--   two sides it actually has, and it is what makes the HVT premise (§3.6)
--   real rather than aspirational — without a kill objective naming the
--   carrier, no AI ever prioritises one.
--
--   EXTRACT (per team). A side with a live carrier and a departure zone is
--   told to get a transport out. This one is standing rather than episodic:
--   it is live for as long as the side can still leave, which is the point —
--   withdrawal is the decision the world layer prices (§7.5's payout table),
--   and a decision nobody is ever told they can make is not a decision.
--
-- Reward magnitudes are the neighbouring rules' scale (30-160). §10.6 wants
-- all of these derived from `authority_cost.lua`'s median directive cost
-- instead of authored as literals; that is a separate, still-open task and
-- this rule will convert with the rest rather than inventing a third scheme.
-- ============================================================
local ARRIVAL_DROP_RADIUS = 500     -- the "landed safely" circle around dropZone

local transportRule = {
    key = 'transport', cooldown = 900, cap = 6,
    scan = function(world, state)
        local out = {}

        local live = {}
        for _, a in ipairs(world.inFlightArrivals()) do
            live[a.arrivalID] = true
            if not state.seenArrivals[a.arrivalID] then
                state.seenArrivals[a.arrivalID] = true
                out[#out + 1] = {
                    dedupKey = 'transport:arrival:' .. a.arrivalID,
                    build = function()
                        return {
                            linkedPair = true,
                            escort = {
                                type = 'escort', scope = 'tactical', source = 'systemic',
                                forTeam = a.team, reward = reward(DIRECTIVES.arrival),
                                params = {
                                    transportUnitIDs = { a.transportID },
                                    direction = 'inbound',
                                    extractArea = { x = a.dropZone.x, z = a.dropZone.z,
                                                    r = ARRIVAL_DROP_RADIUS },
                                },
                            },
                            kill = {
                                type = 'kill', scope = 'tactical', source = 'systemic',
                                reward = reward(DIRECTIVES.arrival),
                                params = { targetUnitID = a.transportID },
                            },
                        }
                    end,
                }
            end
        end
        -- An arrival that has unloaded (or died) leaves the in-flight list;
        -- forget it so the table cannot grow for the length of a long war.
        -- Re-firing is impossible anyway: an arrival id is unique per wave and
        -- a wave enters the map once.
        for id in pairs(state.seenArrivals) do
            if not live[id] then state.seenArrivals[id] = nil end
        end

        for _, t in ipairs(world.extractableTransports()) do
            out[#out + 1] = {
                dedupKey = 'transport:extract:' .. t.team,
                build = function()
                    return {
                        type = 'escort', scope = 'strategic', source = 'systemic',
                        forTeam = t.team, reward = reward(DIRECTIVES.extract),
                        params = {
                            transportUnitIDs = t.transportUnitIDs,
                            direction = 'outbound',
                            extractArea = t.extractArea,
                        },
                    }
                end,
            }
        end

        return out
    end,
}


-- ============================================================
-- The comeback valve (gameplay rule (b), 2026-09-10 review task 4).
--
-- The problem it solves: objectives are the only primary authority income, so
-- a side that loses ground loses INCOME, which buys fewer orders, which loses
-- more ground. The economy has a positive feedback loop running straight down,
-- and nothing in it pushes back. That is the shape of match that is decided
-- twenty minutes before it ends and dull for both sides.
--
-- The valve is deliberately small and deliberately not a handout. It does two
-- things for a team that is behind on territory:
--
--   * scales TEAM-SCOPED systemic rewards by (1 + deficit), capped at x1.5 —
--     the same objective pays more to the side that needs it. Open-race
--     objectives (no `forTeam`) are untouched: there is no "behind team" to
--     price them for, and scaling a race would pay the leader extra for
--     winning one.
--   * drops the liveness backstop's starvation threshold from two ticks to
--     one, so a losing side gets a fresh objective on the board in half the
--     time rather than sitting with nothing to earn from.
--
-- What it explicitly does NOT do: mint authority directly, reduce the leader's
-- rewards, or change what anything costs. A team still has to go and complete
-- the objective. The valve makes the attempt worth more, not automatic.
--
-- `deficit` is measured in owned REGIONS rather than pools, because pools are
-- the thing being corrected and a valve keyed on its own output oscillates.
-- Region count is the upstream cause and moves slowly.
-- ============================================================
local COMEBACK_MAX = 1.5             -- hard cap on the multiplier

--- Deficit in [0, 0.5]: how far behind the leader this team is, as a share of
--- the whole map. Capped at 0.5 so `1 + deficit` cannot exceed COMEBACK_MAX
--- even if the multiplier's clamp were ever removed.
local function deficitOf(world, team)
    if not world.ownedRegionCount then return 0 end
    local mine, best, total = 0, 0, 0
    for _, t in ipairs(world.teams()) do
        local n = world.ownedRegionCount(t) or 0
        total = total + n
        if t == team then mine = n end
        if n > best then best = n end
    end
    if total <= 0 then return 0 end
    local gap = (best - mine) / total
    return math.max(0, math.min(0.5, gap))
end

--- The reward multiplier for one team this tick, and the number published as
--- `objective_comeback_<team>`.
function generator.comebackScale(world, team)
    return math.min(COMEBACK_MAX, 1 + deficitOf(world, team))
end

-- ============================================================
-- Liveness guarantee: a team with zero completable active objectives for 2
-- ticks gets a forced control objective on the nearest neutral/contested
-- region — the economy's dead-game backstop.
-- ============================================================
local LIVENESS_STARVED_TICKS = 2

local livenessRule = {
    key = 'liveness', cooldown = 900, cap = 8, exemptTeamCap = true,
    scan = function(world, state)
        local out = {}
        local stillStarved = {}
        for _, team in ipairs(world.teams()) do
            if world.completableObjectiveCount(team) > 0 then
                state.starvedSince[team] = nil
            else
                stillStarved[team] = true
                state.starvedSince[team] = state.starvedSince[team] or world.tick
                -- The valve's second half: a team that is behind waits one
                -- tick for the backstop, not two. Half the dead air at exactly
                -- the moment dead air compounds.
                local threshold = (generator.comebackScale(world, team) > 1)
                    and 1 or LIVENESS_STARVED_TICKS
                if (world.tick - state.starvedSince[team]) >= (threshold - 1) then
                    local key = world.nearestNeutralOrContestedRegion(team)
                    if key then
                        out[#out + 1] = {
                            dedupKey = 'liveness:' .. team,
                            build = function()
                                return {
                                    type = 'control', scope = 'strategic', source = 'systemic',
                                    forTeam = team, reward = reward(DIRECTIVES.liveness),
                                    params = { regionKey = key, holdFrames = CONTROL_HOLD_FRAMES },
                                }
                            end,
                        }
                    end
                end
            end
        end
        for team in pairs(state.starvedSince) do
            if not stillStarved[team] then state.starvedSince[team] = nil end
        end
        return out
    end,
}


-- ============================================================
-- Rule: a completed `control` chains into the next region (gameplay rule (a),
-- 2026-09-10 review task 4).
--
-- The problem it solves: systemic control objectives are independent events.
-- Taking a region pays once and then the board goes quiet until some other
-- region happens to become contested, so a side that has just won a fight has
-- nothing to do with the momentum it built — and the generator's other rules
-- are all reactive (something is contested, something is damaged, a convoy
-- appeared). Nothing rewards pressing an advantage.
--
-- The chain is the one PROACTIVE rule: finish a control and the board
-- immediately offers the adjacent region you do not own, at +25 % and on a
-- three-minute clock. It is an offer, not a requirement — declining it costs
-- nothing, and the short expiry is what keeps a declined chain from silting up
-- the board.
--
-- Scoped to the completing team (`forTeam`), not an open race: the point is to
-- extend one side's push. An open race here would hand the loser of the fight
-- a paid objective on the ground they just lost.
--
-- Deduped per TARGET region (`chain:<region>`), so two teams completing
-- controls that share a neighbour do not both get an objective on it, and a
-- team completing several controls around one region chains once.
-- ============================================================
-- +25 % on the parent objective's reward — but never more than +25 % over
-- what a plain control on the TARGET region would have paid.
--
-- The clamp is not decoration. Without it the rule is a geometric series: a
-- chained control is itself a `control`, so completing it feeds
-- `generator.onCompleted` again and the next chain is +25 % on the +25 %. The
-- economy harness found it — in a 40-minute `mixed` normal cell the chain
-- rule's largest live reward reached 187 against a control's 40, and the late
-- half of every war was one rule inflating against itself. Momentum was meant
-- to be a bonus on a region, not compound interest on a streak.
local CHAIN_REWARD_BONUS = 1.25
local CHAIN_EXPIRY_FRAMES = 5400     -- 3 min at 30 Hz — press on now, or don't
local CHAIN_FALLBACK_REWARD = reward(DIRECTIVES.chainBase)   -- parent reward unknown/zero (a scripted parent)

local chainRule = {
    key = 'chain', cooldown = 1800, cap = 4,
    scan = function(world, state)
        local out = {}
        local queue = state.chainQueue
        state.chainQueue = {}
        for _, entry in ipairs(queue) do
            for _, key in ipairs(world.regionNeighbors(entry.fromKey)) do
                -- "a region it does not own" — a neighbour already held is not
                -- a push, and a control objective on it would complete on the
                -- tick it was created.
                if world.regionOwner(key) ~= entry.team then
                    local base = (entry.reward > 0) and entry.reward or CHAIN_FALLBACK_REWARD
                    local ceiling = reward(DIRECTIVES.control)
                        * (1 + (world.regionValue(key) or 0))
                    base = math.min(base, ceiling)
                    out[#out + 1] = {
                        dedupKey = 'chain:' .. key,
                        build = function()
                            return {
                                type = 'control', scope = 'strategic', source = 'systemic',
                                forTeam = entry.team,
                                reward = math.floor(base * CHAIN_REWARD_BONUS),
                                expiresAtFrame = world.frame + CHAIN_EXPIRY_FRAMES,
                                params = { regionKey = key, holdFrames = CONTROL_HOLD_FRAMES },
                            }
                        end,
                    }
                    break   -- one chain per completed control, not one per neighbour
                end
            end
        end
        return out
    end,
}

-- transportRule sits before livenessRule deliberately: it is the floor, and
-- the liveness backstop should be the LAST thing that fires (§10.5).
generator.rules = { controlRule, districtRule, escortRule, infraRule,
                    transportRule, chainRule, livenessRule }

--- Periodic scan; posts objectives through `world.create` /
--- `world.createLinkedPair`. `world.tick` is a monotonic eval-tick counter
--- (not the frame number), so debounce windows ("contested >= 2 eval
--- ticks") count ticks, not frames.
---
--- Never runs against a scripted scenario: a tutorial/solo Mission's whole
--- point is its own authored beat list (scenarios/tutorial_01.lua), and this
--- generator posting a `control`/`liveness`/... objective into it doubles the
--- board the scripted beats were meant to own alone. Read the same field
--- game_scenario/game_tutorial do (`GG.Scenario.data.tutorial`), through the
--- world facade so this stays fake-testable.
function generator.tick(world, state)
    local scn = world.scenario and world.scenario()
    if scn and (scn.tutorial or scn.solo) then return end

    local mo = world.modOptions and world.modOptions() or {}
    local density = densityFor(mo.objective_density)

    for _, rule in ipairs(generator.rules) do
        for _, candidate in ipairs(rule.scan(world, state)) do
            fire(state, world, density, rule, candidate.dedupKey, candidate.build)
        end
    end
end

return generator
