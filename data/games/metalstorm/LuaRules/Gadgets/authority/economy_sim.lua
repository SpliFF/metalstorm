-- authority/economy_sim.lua — the economy validation harness
-- (PLAN-metalstorm-economy.md §4, PLAN-economy-grid.md task 3).
--
-- WHY THIS IS PURE LUA AND NOT A HEADLESS GRID
--
-- The previous harness was a matrix of headless server runs scored by
-- `tools/economy-validation.js`. PLAN-economy-grid.md's autopsy (B1–B7, all
-- re-verified 2026-09-17) found every layer of it broken, and two of the
-- findings are the reason this file exists rather than a repair:
--
--   * **B6 — the acceptance script passed vacuously.** The velocity EMA, pool
--     ratio and dead-frame counters live in a Lua-local inside metrics.lua;
--     `StatsDump` is a fixed 15-field C++ struct with no Lua hook. The script
--     read `run.data.economy.teams`, a key the engine has never written, so
--     every criterion iterated an empty table and returned true. The grid
--     would have gone green on a dump from a different game.
--   * **B7d — the seed axis was one sample.** `gsRNG.SetSeed(18655, true)` is
--     hard-coded, so four seeds produced four byte-identical runs and
--     "≥ 90 % of runs pass" was a statistic over n=1.
--
-- Both are properties of measuring the economy from OUTSIDE the sim. The
-- economy is arithmetic — a cost formula, an escrow ledger, rate EMAs, a
-- generator's caps and cooldowns — and none of it needs a map, a unit, a
-- pathfinder or a C++ server to exercise. So this harness drives the REAL
-- modules directly:
--
--   * `authority/formula.lua`  — the order-cost formula, unmodified
--   * `authority/metrics.lua`  — the rate EMAs, through the coarse-sampler
--                                `frames` argument F1 added for exactly this
--   * `authority/escrow.lua`   — the stake ledger, including war-end settle
--   * `objectives/generator.lua` — the real rules, caps, cooldowns, rewards
--                                and `DENSITY` multipliers, run against a
--                                scripted world the way generator_spec does
--   * `LuaRules/Configs/authority_cost.lua` — the real constants
--
-- Nothing here re-implements any of that. When a constant moves, this harness
-- reports the new number; when a rule changes shape, this harness fails to
-- build and says so, which is the honest outcome. The only invented things are
-- the PLAYER MODEL (how fast a team spends) and the OUTCOME SCRIPT (how often
-- an objective is completed rather than allowed to expire) — the two things
-- that genuinely cannot be derived from the code, and they are parameters.
--
-- Determinism is a property of this file, not a hope: the only randomness is
-- the LCG below, seeded per cell, so a cell's numbers are reproducible on any
-- machine and a seed axis is a real axis.
--
-- WHAT IT DOES NOT MEASURE. This is the economy in isolation. It says nothing
-- about whether units reach the objectives, whether the AI spends the way the
-- player model says, or whether a map's regions generate the contest the
-- control rule keys on. Those are properties of a live match and a live match
-- is still the only place to see them — the harness narrows the search, it
-- does not replace playtesting.
--
-- Run it: `lua authority/economy_sim.lua` (from LuaRules/Gadgets) prints the
-- grid as TSV; `tools/economy-validation.js` is the thin band-checking runner.

local M = {}

local FRAMES_PER_SECOND = 30
local FRAMES_PER_MINUTE = FRAMES_PER_SECOND * 60

-- ============================================================
-- Module loading
--
-- Resolved relative to the caller's package.path so the same file works from
-- `Gadgets/` (the plugin root the gadget specs use) and from `authority/`
-- (the root its own specs use). The gadget itself reaches these through
-- VFS.Include; there is no VFS here, and inventing one would be a second
-- loader to keep in step.
-- ============================================================
-- Both plugin roots on the path: `Gadgets/` (where the gadget specs run) and
-- `Gadgets/authority/` (where this file's own spec runs), so `objectives.
-- generator` resolves from either without the caller having to know.
package.path = './?.lua;../?.lua;' .. package.path

local function tryRequire(...)
    for _, name in ipairs({ ... }) do
        local ok, mod = pcall(require, name)
        if ok then return mod end
    end
    error('economy_sim: could not load any of ' .. table.concat({ ... }, ', ')
          .. ' — run from LuaRules/Gadgets or LuaRules/Gadgets/authority')
end

local Formula   = tryRequire('formula', 'authority.formula')
local Metrics   = tryRequire('metrics', 'authority.metrics')
local Escrow    = tryRequire('escrow', 'authority.escrow')
local Generator = tryRequire('objectives.generator', 'generator')

-- Re-exported so a caller (the spec, a tuning session) can read the real rule
-- table and DENSITY multipliers through the harness rather than guessing at a
-- second require path.
M.Generator = Generator
M.Formula, M.Metrics, M.Escrow = Formula, Metrics, Escrow

--- The real cost spec. A plain `return {...}` table, so `dofile` reads it with
--- no engine in the room. Tried at both roots for the same reason as above.
local function loadCostSpec(path)
    local candidates = path and { path } or {
        '../Configs/authority_cost.lua',        -- from Gadgets/
        '../../Configs/authority_cost.lua',     -- from Gadgets/authority/
    }
    for _, p in ipairs(candidates) do
        local ok, spec = pcall(dofile, p)
        if ok and type(spec) == 'table' then return spec end
    end
    error('economy_sim: could not load LuaRules/Configs/authority_cost.lua')
end

-- ============================================================
-- Deterministic PRNG
--
-- `math.random` is not it: the seed is global state, Lua 5.1 and 5.4 disagree
-- about the generator, and B7d is precisely the failure mode of a seed axis
-- that does not actually vary anything. A 12-line LCG is reproducible across
-- interpreters and across machines, which is the entire requirement.
-- ============================================================
local function newRng(seed)
    local state = (seed or 1) % 2147483647
    if state <= 0 then state = state + 2147483646 end
    return function()
        state = (state * 16807) % 2147483647
        return (state - 1) / 2147483646
    end
end

-- ============================================================
-- The scripted world
--
-- One fake world per objective type, shaped so exactly that type's generator
-- rule fires and the others stay quiet. This is the same fake-world technique
-- objectives/tests/generator_spec.lua uses; the point is that the generator
-- under test is the real one, with its real caps and cooldowns.
--
-- `completableObjectiveCount` is the load-bearing quiet-keeper: the liveness
-- backstop fires for any team with an empty board for two ticks, and left at
-- zero it would flood every cell with control objectives that belong to a
-- different rule. Cells report their own live count, so liveness fires when
-- and only when the board really has emptied — which is the backstop doing
-- its job, and worth seeing in the numbers.
-- ============================================================

local TYPES = { 'control', 'protect', 'escort', 'kill', 'extract', 'infra', 'mixed' }

--- Per-type world scripting. Called before each generator tick to supply that
--- type's rule with fresh input. Forward-declared because `kill` delegates to
--- `escort` — they are two halves of one rule — and a table constructor cannot
--- see the local it is being assigned to.
local WORLD_SCRIPT
WORLD_SCRIPT = {
    -- A pool of regions cycling through contested; the control rule debounces
    -- on two eval ticks, which the steady list satisfies.
    control = function(world, sim)
        world.contestedRegions = function() return { 'r1', 'r2', 'r3', 'r4' } end
        world.regionValue = function() return 1 end
    end,
    -- Civilian districts under threat -> protect.
    protect = function(world, sim)
        local out = {}
        for i = 1, 4 do
            out[i] = { districtId = 'd' .. i, districtTeam = sim.teams[1 + (i % #sim.teams)],
                       unitIDs = { 1000 + i } }
        end
        world.civilianDistrictsUnderThreat = function() return out end
    end,
    -- A convoy every few ticks -> escort+kill linked pair. This is the cell
    -- that exercises F13's shared-key accounting, so the pair is resolved
    -- through BOTH halves the way the registry really does it.
    escort = function(world, sim)
        world.newConvoys = function()
            if sim.tick % 4 ~= 0 then return {} end
            sim.convoySeq = sim.convoySeq + 1
            -- Alternate the benefactor. A rule that always pays the same team
            -- is a property of the SCRIPT, not of the rule, and it shows up in
            -- the grid as a starved team's velocity pinned at the cap — a
            -- reading about this file rather than about the economy.
            local benefactor = sim.teams[1 + (sim.convoySeq % #sim.teams)]
            return { { id = 'c' .. sim.convoySeq, benefactorTeam = benefactor,
                       unitIDs = { 2000 + sim.convoySeq },
                       destArea = { x = 0, z = 0, r = 50 } } }
        end
    end,
    -- The kill half of the same pair — same rule, scored from the kill side so
    -- the type appears in the grid on its own terms.
    kill = function(world, sim) WORLD_SCRIPT.escort(world, sim) end,
    -- Inbound arrivals -> the transport rule's escort+kill pair; `extract` is
    -- the outbound standing objective from the same rule.
    extract = function(world, sim)
        world.extractableTransports = function()
            local out = {}
            for i, team in ipairs(sim.teams) do
                out[i] = { team = team, transportUnitIDs = { 3000 + i },
                           extractArea = { x = 0, z = 0, r = 100 } }
            end
            return out
        end
    end,
    -- Every rule at once — a real war, where a team's income is the SUM of
    -- what all six rules produce rather than one rule's output. The per-type
    -- rows answer "what does this rule contribute"; this row is the only one
    -- that answers "does the economy sustain a war", and it is the row to read
    -- first when a band fails.
    mixed = function(world, sim)
        for _, t in ipairs(TYPES) do
            if t ~= 'mixed' and t ~= 'kill' then WORLD_SCRIPT[t](world, sim) end
        end
    end,
    -- A building taking damage between ticks -> infra.
    infra = function(world, sim)
        world.infraBuildings = function()
            local out = {}
            for i = 1, 4 do
                -- Ratchet down so every tick is an edge; clamp so it stays a
                -- building rather than becoming a crater.
                sim.infraHealth[i] = (sim.infraHealth[i] or 1.0) - 0.05
                if sim.infraHealth[i] < 0.2 then sim.infraHealth[i] = 1.0 end
                out[i] = { unitID = 4000 + i, healthFrac = sim.infraHealth[i],
                           ownerTeam = sim.teams[1 + (i % #sim.teams)] }
            end
            return out
        end
    end,
}

local function emptyList() return {} end

local function newScriptedWorld(sim, objectiveType, density)
    local world
    world = {
        frame = 0, tick = 0,
        contestedRegions = emptyList,
        regionValue = function() return 0 end,
        civilianDistrictsUnderThreat = emptyList,
        newConvoys = emptyList,
        infraBuildings = emptyList,
        inFlightArrivals = emptyList,
        extractableTransports = emptyList,
        teams = function() return sim.teams end,
        completableObjectiveCount = function(team)
            return sim.liveCountByTeam[team] or 0
        end,
        nearestNeutralOrContestedRegion = function() return 'r_backstop' end,
        -- A small ring of regions with an ownership split, so the two 2026-09-10
        -- gameplay rules are in the measurement rather than dark: the chain
        -- rule walks `regionNeighbors` from a region just taken, and the
        -- comeback valve reads `ownedRegionCount`. The split is deliberately
        -- uneven — a perfectly level board leaves the valve at x1.0 and the
        -- grid would report on a lever that never engaged.
        regionNeighbors = function(key) return sim.regionRing[key] or {} end,
        regionOwner = function(key) return sim.regionOwner[key] end,
        ownedRegionCount = function(team)
            local n = 0
            for _, owner in pairs(sim.regionOwner) do
                if owner == team then n = n + 1 end
            end
            return n
        end,
        modOptions = function() return { objective_density = density } end,
        create = function(def) return sim:onCreated(def) end,
        createLinkedPair = function(escortDef, killDef)
            -- The registry's CreateLinkedPair books TWO objectives against one
            -- systemicKey and returns one handle. Both halves are live, both
            -- can pay out, and both report back on resolve — which is exactly
            -- the accounting F13 was about, so the harness models it that way.
            local id = sim:onCreated(escortDef)
            sim:onCreated(killDef, id)
            return id
        end,
    }
    return world
end

-- ============================================================
-- The simulation
-- ============================================================

-- ============================================================
-- The player model
--
-- The ONE part of this harness that is authored rather than derived, because
-- nothing in the repo records how fast a commander issues orders or which
-- classes they reach for. It is stated here as a table rather than buried in a
-- constant so that disagreeing with it is a code review, not an archaeology
-- expedition.
--
-- The shape follows the design's own anti-CPS intent (authority_cost.lua's
-- order_class comment: "macro directives amortise, micro orders don't") and
-- the 2026-08-19 ruling that battle play is directive-driven: mostly
-- directives over squads, posture changes as the cheap filler, standing orders
-- occasionally, and a thin tail of per-unit micro. `share` sums to 1.
-- ============================================================
local ORDER_MIX = {
    { class = 'directive', share = 0.35, perSquad = true, squads = 2 },
    { class = 'posture',   share = 0.30 },
    { class = 'standing',  share = 0.15, perSquad = true, squads = 1 },
    { class = 'group_op',  share = 0.10, perSquad = true, squads = 1 },
    { class = 'micro',     share = 0.10 },
}

local Sim = {}
Sim.__index = Sim

local DEFAULTS = {
    teams = 2,
    playersPerTeam = 2,
    durationMinutes = 40,
    evalPeriod = 90,              -- game_objectives.lua's EVAL_PERIOD
    density = 'normal',
    seed = 1,
    -- Player model (§4) — see ORDER_MIX. `squadBaseCost` is the cost BASIS a
    -- directive is priced against: game_authority.lua charges a group-scoped
    -- directive on Σ authority_cost_base over the group's roster (:612-684),
    -- and the shipped corpus authors that customparam as SCALE (1 or 2, per
    -- the wars appendix), not as strength — so a ten-unit squad of scale-1/2
    -- units is a basis of about 15, and a single unit is about 2.
    squadBaseCost = 15,
    unitBaseCost = 2,
    ordersPerMinutePerPlayer = 6,
    -- Outcome script: how often a systemic objective is actually completed.
    completionRate = 0.6,
    -- How long an objective takes to resolve, in eval ticks.
    resolveTicks = 12,
    -- Fraction of completions that carry a player stake (a bounty on top).
    stakeRate = 0.15,
    stakeAmount = 40,
    startingPool = 500,
    joinGrant = 100,
}

function M.newSim(opts)
    opts = opts or {}
    local cfg = {}
    for k, v in pairs(DEFAULTS) do cfg[k] = v end
    for k, v in pairs(opts) do cfg[k] = v end

    local costSpec = opts.costSpec or loadCostSpec(opts.costSpecPath)
    local sim = setmetatable({
        cfg = cfg,
        costSpec = costSpec,
        econ = costSpec.economy or {},
        rng = newRng(cfg.seed),
        metrics = Metrics.newState(),
        escrow = Escrow.newState(),
        genState = Generator.newState(),
        teams = {},
        pools = {},               -- team -> authority
        mintTotal = {}, burnTotal = {},
        liveCountByTeam = {},
        live = {},                -- objective handle -> record
        nextHandle = 1,
        tick = 0, frame = 0,
        convoySeq = 0,
        infraHealth = {},
        regionRing = {}, regionOwner = {},
        firstBrokeFrame = nil,
        created = 0, completed = 0, expired = 0,
        decayBurned = 0,
    }, Sim)

    -- An eight-region ring, split 5/3 in the first team's favour: enough of a
    -- gap that the valve engages (and is visible in the grid) without pinning
    -- it at its cap.
    local RING = { 'r1', 'r2', 'r3', 'r4', 'r5', 'r6', 'r7', 'r8' }
    for i, key in ipairs(RING) do
        sim.regionRing[key] = { RING[i % #RING + 1], RING[(i - 2) % #RING + 1] }
        sim.regionOwner[key] = (i <= 5) and 0 or 1
    end

    for t = 1, cfg.teams do
        local team = t - 1
        sim.teams[t] = team
        sim.pools[team] = cfg.startingPool + cfg.joinGrant * cfg.playersPerTeam
        sim.mintTotal[team] = 0
        sim.burnTotal[team] = 0
        sim.liveCountByTeam[team] = 0
    end
    return sim
end

--- The cheapest order a team can issue — the dead-time floor (§2): a posture
--- toggle on one unit in friendly territory.
function Sim:cheapestOrderCost()
    return Formula.cost(self.costSpec.base_k, self.cfg.unitBaseCost,
                        self.costSpec.region_mod_min,
                        self.costSpec.order_class.posture, 1.0)
end

--- A representative army command, used for the pool ratio (§2): a directive
--- over four squads in neutral territory.
function Sim:typicalArmyCost()
    return Formula.cost(self.costSpec.base_k, self.cfg.squadBaseCost * 4,
                        1.0, self.costSpec.order_class.directive, 1.0)
end

function Sim:onCreated(def, linkedTo)
    local handle = self.nextHandle
    self.nextHandle = handle + 1
    self.created = self.created + 1

    local team = def.forTeam
    if team == nil then
        -- An unscoped half (the kill side of a race) pays whoever wins it.
        team = self.teams[1 + (handle % #self.teams)]
    end

    local rec = {
        handle = handle, team = team, reward = def.reward or 0,
        objType = def.type, params = def.params,
        systemicKey = def.systemicKey, systemicRule = def.systemicRule,
        resolveAtTick = self.tick + self.cfg.resolveTicks,
        completes = self.rng() < self.cfg.completionRate,
        linkedTo = linkedTo,
    }
    self.live[handle] = rec
    self.liveCountByTeam[team] = (self.liveCountByTeam[team] or 0) + 1

    -- A share of objectives carry a player stake on top of the reward. The
    -- escrow is the REAL ledger, so the float it reports at war end is the
    -- real settle path's answer, not a counter this file keeps.
    if self.rng() < self.cfg.stakeRate then
        local playerID = team * 10
        if self:spend(team, self.cfg.stakeAmount) then
            Escrow.add(self.escrow, handle, playerID, team, self.cfg.stakeAmount)
            rec.staked = self.cfg.stakeAmount
        end
    end
    return handle
end

--- Debit `amount` from a team's pool. Returns false (and spends nothing) when
--- the team cannot afford it — a refusal, which is what the sim charges the
--- dead-time counter for.
function Sim:spend(team, amount)
    if amount <= 0 then return true end
    if (self.pools[team] or 0) < amount then return false end
    self.pools[team] = self.pools[team] - amount
    self.burnTotal[team] = self.burnTotal[team] + amount
    self.burnThisTick[team] = (self.burnThisTick[team] or 0) + amount
    return true
end

function Sim:mint(team, amount)
    if amount <= 0 then return end
    self.pools[team] = (self.pools[team] or 0) + amount
    self.mintTotal[team] = self.mintTotal[team] + amount
    self.mintThisTick[team] = (self.mintThisTick[team] or 0) + amount
end

--- Resolve one objective: award or expire, settle its escrow through the real
--- ledger, and report to the generator so its cap frees up.
function Sim:resolve(rec, outcome)
    if not self.live[rec.handle] then return end
    self.live[rec.handle] = nil
    self.liveCountByTeam[rec.team] = math.max(0, (self.liveCountByTeam[rec.team] or 1) - 1)

    if outcome == 'complete' then
        self.completed = self.completed + 1
        self:mint(rec.team, rec.reward + Escrow.total(self.escrow, rec.handle))
        Escrow.settle(self.escrow, rec.handle, 'complete')
        -- Gameplay rule (a): a completed control chains into the next region.
        -- The registry calls this from resolveObjective; the harness has to
        -- too, or the chain rule is dark in every cell.
        Generator.onCompleted(self.genState, {
            type = rec.objType, completedBy = rec.team,
            reward = rec.reward, params = rec.params,
        })
        -- Taking a region is what moves the valve, so the sim has to model the
        -- flip as well as pay for it — otherwise the ownership split is frozen
        -- and the comeback multiplier never changes over a whole war.
        local key = rec.params and rec.params.regionKey
        if key and self.regionOwner[key] ~= nil then self.regionOwner[key] = rec.team end
    else
        self.expired = self.expired + 1
        -- Every staker is "active" in this model (nobody disconnects), so an
        -- ordinary expiry refunds player-ward; the amount lands back in the
        -- team pool either way here, since the sim keeps one pool per team.
        for _, r in ipairs(Escrow.settle(self.escrow, rec.handle, outcome,
                                          function() return true end)) do
            self:mint(rec.team, r.amount)
        end
    end

    if rec.systemicKey then
        Generator.onResolved(self.genState, rec.systemicRule, rec.systemicKey)
    end
    -- Mutual resolve: the other half of a linked pair is mooted out, and
    -- reports in against the SAME systemicKey (F13).
    for handle, other in pairs(self.live) do
        if other.linkedTo == rec.handle or (rec.linkedTo and handle == rec.linkedTo) then
            self:resolve(other, 'expired')
        end
    end
end

--- One eval tick: generate, spend, resolve, decay, sample.
function Sim:step(world, objectiveType, density)
    local period = self.cfg.evalPeriod
    self.tick = self.tick + 1
    self.frame = self.frame + period
    world.frame, world.tick = self.frame, self.tick

    self.mintThisTick, self.burnThisTick = {}, {}

    WORLD_SCRIPT[objectiveType](world, self)
    Generator.tick(world, self.genState)

    -- Spend: each player issues orders at the modelled rate, drawn from
    -- ORDER_MIX and priced by the REAL formula with a region modifier drawn
    -- across the authored range. Refused orders (the team cannot afford one)
    -- are simply not issued, which is what the dead-time counter is counting.
    local ordersPerTeamPerTick =
        self.cfg.ordersPerMinutePerPlayer * self.cfg.playersPerTeam * period / FRAMES_PER_MINUTE
    for _, team in ipairs(self.teams) do
        local whole = math.floor(ordersPerTeamPerTick)
        if self.rng() < (ordersPerTeamPerTick - whole) then whole = whole + 1 end
        for _ = 1, whole do
            local pick, acc = self.rng(), 0
            local entry = ORDER_MIX[#ORDER_MIX]
            for _, e in ipairs(ORDER_MIX) do
                acc = acc + e.share
                if pick <= acc then entry = e; break end
            end
            local basis = entry.perSquad and self.cfg.squadBaseCost or self.cfg.unitBaseCost
            if entry.squads then basis = basis * entry.squads end
            local regionMod = self.costSpec.region_mod_min
                + self.rng() * (self.costSpec.region_mod_max - self.costSpec.region_mod_min)
            local cost = Formula.cost(self.costSpec.base_k, basis, regionMod,
                                       self.costSpec.order_class[entry.class], 1.0)
            self:spend(team, cost)
        end
    end

    -- Resolve anything due.
    local due = {}
    for _, rec in pairs(self.live) do
        if self.tick >= rec.resolveAtTick then due[#due + 1] = rec end
    end
    table.sort(due, function(a, b) return a.handle < b.handle end)
    for _, rec in ipairs(due) do
        self:resolve(rec, rec.completes and 'complete' or 'expired')
    end

    -- Lever 1: the soft ceiling with overflow decay, at the rate
    -- game_authority.lua derives (pct/100 × period/1800 per sweep).
    local ceiling = (self.econ.soft_ceiling_C_base or math.huge) * self.cfg.playersPerTeam
    local decayPeriod = self.econ.overflow_decay_period or 900
    if self.frame % decayPeriod < period then
        local fraction = (self.econ.overflow_decay_pct or 0) / 100 * decayPeriod / FRAMES_PER_MINUTE
        for _, team in ipairs(self.teams) do
            local excess = (self.pools[team] or 0) - ceiling
            if excess > 0 then
                local burned = math.floor(excess * fraction)
                self.pools[team] = self.pools[team] - burned
                self.decayBurned = self.decayBurned + burned
            end
        end
    end

    -- Sample the REAL metrics module with the coarse-sampler `frames`
    -- argument. Dead time is charged per frame of the period the team spent
    -- unable to afford its cheapest order.
    local cheapest = self:cheapestOrderCost()
    for _, team in ipairs(self.teams) do
        Metrics.updateVelocity(self.metrics, team,
                               self.mintThisTick[team] or 0,
                               self.burnThisTick[team] or 0, period)
        if (self.pools[team] or 0) < cheapest then
            for _ = 1, period do
                Metrics.recordDeadFrame(self.metrics, team, self.pools[team], cheapest)
            end
            self.firstBrokeFrame = self.firstBrokeFrame or self.frame
        end
    end
end

--- Run one cell to completion and return its row.
function M.runCell(objectiveType, density, opts)
    opts = opts or {}
    opts.density = density
    local sim = M.newSim(opts)
    local world = newScriptedWorld(sim, objectiveType, density)

    local totalFrames = sim.cfg.durationMinutes * FRAMES_PER_MINUTE
    while sim.frame < totalFrames do
        sim:step(world, objectiveType, density)
    end

    -- War end: every still-live objective sweeps with its stakes routed
    -- team-ward (wars §7). The float afterwards must be zero — anything left
    -- is authority the ledger is still holding for a war that is over.
    for handle, rec in pairs(sim.live) do
        for _, r in ipairs(Escrow.settle(sim.escrow, handle, Escrow.WAR_END)) do
            sim:mint(r.team, r.amount)
        end
        sim.live[handle] = nil
        sim.expired = sim.expired + 1
    end

    local escrowFloat = 0
    for _, e in pairs(sim.escrow) do escrowFloat = escrowFloat + (e.total or 0) end

    local velocity, mintRate, burnRate, poolTotal, deadMinutes = 0, 0, 0, 0, 0
    for _, team in ipairs(sim.teams) do
        velocity = velocity + Metrics.velocity(sim.metrics, team)
        local m, b = Metrics.rates(sim.metrics, team)
        mintRate, burnRate = mintRate + m, burnRate + b
        poolTotal = poolTotal + (sim.pools[team] or 0)
        deadMinutes = deadMinutes + Metrics.deadTimeMinutes(sim.metrics, team)
    end
    local n = #sim.teams

    return {
        type = objectiveType,
        density = density,
        seed = sim.cfg.seed,
        velocity = velocity / n,
        mintRate = mintRate / n,
        burnRate = burnRate / n,
        poolRatio = Metrics.poolRatio(poolTotal / n, sim:typicalArmyCost()),
        escrowFloat = escrowFloat,
        -- Minutes into the war before any team first could not afford its
        -- cheapest order. `durationMinutes` (i.e. "never") when it never
        -- happened — the band is a floor, so "never" must read as a pass.
        timeToBrokeMinutes = sim.firstBrokeFrame
            and (sim.firstBrokeFrame / FRAMES_PER_MINUTE) or sim.cfg.durationMinutes,
        deadMinutes = deadMinutes / n,
        created = sim.created,
        completed = sim.completed,
        expired = sim.expired,
        decayBurned = sim.decayBurned,
    }
end

--- The acceptance bands (PLAN-economy-grid.md task 3).
---
--- Two of the four are **sustainability** bands and apply to the `mixed` cells
--- only. Time-to-broke and pool ratio ask "can a team fund a war", and a war
--- is funded by all six generator rules at once — asking a single-rule cell
--- whether it alone keeps a team solvent is a question with a known answer
--- ("no") that no rule was designed to pass. Scoring it anyway buries the real
--- signal under seventeen identical failures, which is how a gate stops being
--- read. Velocity and escrow float are per-rule properties (is this rule's
--- mint/burn balanced, does its escrow settle to nothing) and are checked
--- everywhere.
M.BANDS = {
    velocity = { 0.6, 1.5 },
    escrowFloatMax = 0,
    timeToBrokeMinutesMin = 10,
    poolRatioMax = 8,
}

--- Which cells the sustainability bands apply to.
M.SUSTAIN_TYPE = 'mixed'

function M.checkRow(row, bands)
    bands = bands or M.BANDS
    local failures = {}
    if row.velocity < bands.velocity[1] or row.velocity > bands.velocity[2] then
        failures[#failures + 1] = string.format('velocity %.3f outside [%.2f, %.2f]',
            row.velocity, bands.velocity[1], bands.velocity[2])
    end
    if row.escrowFloat > bands.escrowFloatMax then
        failures[#failures + 1] = string.format('escrow float %d at war end (must be %d)',
            row.escrowFloat, bands.escrowFloatMax)
    end
    -- `type` absent (a hand-built row in a spec) is scored on every band: a
    -- caller checking a literal wants every band, not a silent exemption.
    if row.type == nil or row.type == M.SUSTAIN_TYPE then
        if row.timeToBrokeMinutes < bands.timeToBrokeMinutesMin then
            failures[#failures + 1] = string.format('time-to-broke %.1f min < %d',
                row.timeToBrokeMinutes, bands.timeToBrokeMinutesMin)
        end
        if row.poolRatio > bands.poolRatioMax then
            failures[#failures + 1] = string.format('pool ratio %.2f > %d',
                row.poolRatio, bands.poolRatioMax)
        end
    end
    return #failures == 0, failures
end

M.TYPES = TYPES

--- The whole grid: six objective types × three densities, in a fixed order so
--- two runs of the harness produce diffable output.
function M.runGrid(opts)
    opts = opts or {}
    local densities = opts.densities or { 'sparse', 'normal', 'dense' }
    local rows = {}
    for _, objectiveType in ipairs(TYPES) do
        for _, density in ipairs(densities) do
            local cellOpts = {}
            for k, v in pairs(opts) do cellOpts[k] = v end
            cellOpts.densities = nil
            rows[#rows + 1] = M.runCell(objectiveType, density, cellOpts)
        end
    end
    return rows
end

-- ============================================================
-- CLI: `lua authority/economy_sim.lua [seed]` prints the grid as TSV, one row
-- per cell, plus a PASS/FAIL line per row. tools/economy-validation.js parses
-- this; a human can read it directly.
-- ============================================================
local COLUMNS = {
    'type', 'density', 'seed', 'velocity', 'mintRate', 'burnRate', 'poolRatio',
    'escrowFloat', 'timeToBrokeMinutes', 'deadMinutes',
    'created', 'completed', 'expired', 'decayBurned', 'verdict', 'failures',
}

function M.formatTSV(rows)
    local out = { table.concat(COLUMNS, '\t') }
    for _, row in ipairs(rows) do
        local ok, failures = M.checkRow(row)
        local cells = {}
        for i, col in ipairs(COLUMNS) do
            if col == 'verdict' then
                cells[i] = ok and 'PASS' or 'FAIL'
            elseif col == 'failures' then
                cells[i] = table.concat(failures, '; ')
            else
                local v = row[col]
                cells[i] = (type(v) == 'number' and v ~= math.floor(v))
                    and string.format('%.4f', v) or tostring(v)
            end
        end
        out[#out + 1] = table.concat(cells, '\t')
    end
    return table.concat(out, '\n')
end

-- Direct invocation is detected from `arg[0]` (the script Lua was handed),
-- not from `...`: when this file is required, `...` is the module name, and
-- when it is run WITH arguments `...` is the first argument — a string either
-- way, and the two are indistinguishable. `arg[0]` is this file only when Lua
-- was pointed at it; under busted it is busted's own path.
local invokedDirectly = (type(arg) == 'table' and type(arg[0]) == 'string'
                         and arg[0]:match('economy_sim%.lua$') ~= nil)
if invokedDirectly then
    local seed = tonumber(arg[1]) or 1
    print(M.formatTSV(M.runGrid({ seed = seed })))
end

return M
