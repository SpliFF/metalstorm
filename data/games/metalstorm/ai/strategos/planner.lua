-- planner.lua — goal slate → force allocation (PLAN-metalstorm-ai.md §3.2/§3.3).
-- PURE.  planner.plan(ctx) -> { directives... }.  No engine access.
--
-- This is the whole brain and, per the plan, "most of the plan and none of it
-- is blocked" — it takes a plain Picture + slate and returns a directive list,
-- fully testable headless (the busted specs in tests/ drive exactly this).
--
-- The pipeline, in order:
--   1. packages   — group the own-force ledger into assignable packages,
--                   splitting a garrison off the anchor region (posture floor)
--   2. governor    — economic gate: broke ⇒ postures only (§3.3)
--   3. score       — expectedValue × pSuccess × travel − cost + commitment (§3.2)
--   4. guidance    — binding co-commander overrides (interaction §6.2)
--   5. assign      — greedy over descending score, per-goal force floors (§3.3),
--                   reachability-gated (a package that cannot get there is not
--                   a candidate)
--   6. commit       — hysteresis: reassign only if newScore > current × 1.4;
--                   a commitment is recorded only for a directive that GOES OUT
--   7. emit        — directive list + intent report; rate-clamped (§8 E6)

local Graph  = require('graph')
local Threat = require('threat')

local Planner = {}

-- Guidance's funding rate cap is quoted per game-minute; the governor budgets
-- per strategic tick. GAME_SPEED 30 — the same 1800 game_authority.lua's
-- stipend and game_ai_guidance.lua's allowance drip use.
local FRAMES_PER_MINUTE = 1800

--- Deterministic iteration: sorted keys of a hash table. `pairs` order over
-- string keys differs between processes (Lua seeds its string hash), and the
-- RNG tie-break is drawn in iteration order, so anything that feeds the
-- candidate list must be walked in a fixed order.
local function sortedKeys(t)
    local keys = {}
    for k in pairs(t or {}) do keys[#keys + 1] = k end
    table.sort(keys, function(a, b) return tostring(a) < tostring(b) end)
    return keys
end

--=============================================================================
-- 1. Force packages.  An org-group is a package; unassigned squads are
-- grouped into proposed packages. One package per populated ledger region
-- (the shape the assigner consumes is real), plus the POSTURE FLOOR: the
-- bucket standing in the anchor region (threat.lua anchorRegion — the
-- departure zone, else our only owned region) is split into a mobile package
-- and a `holdOnly` garrison that may only DEFEND that region. "Never strip
-- your last held region of force" is therefore structural: the garrison is
-- not a candidate for anything that leaves.
--=============================================================================
local function moveKindOf(bucket, config)
    local byClass = bucket.byClass
    if type(byClass) ~= 'table' or next(byClass) == nil then return nil end
    local total, armour = 0, 0
    for class, v in pairs(byClass) do
        total = total + (v or 0)
        if (config.ARMOUR_CLASSES or {})[class] then armour = armour + (v or 0) end
    end
    if total <= 0 then return nil end
    if armour / total > (config.ARMOUR_SHARE or 0.5) then return 'armour' end
    return 'ground'
end

local function makePackage(id, regionKey, bucket, share, config, holdOnly)
    local strength = (bucket.strength or 0) * share
    local idle
    -- NOT `(bucket.idle ~= nil) and bucket.idle or true`: with idle == false
    -- that expression is `true` (the and/or footgun), which made every busy
    -- package idle and the co-commander etiquette gate inert.
    if bucket.idle == nil then idle = true else idle = bucket.idle end
    return {
        id       = id,
        region   = regionKey,
        strength = strength,
        -- Absolute hitpoints (picture.lua's `health`), carried ONLY so the
        -- actuator can state a demand cap in the engine's own scale —
        -- `strength` is a head count and the engine's is hitpoints (D68).
        -- Never scored on: every weight here is calibrated against `strength`.
        health   = (bucket.health or 0) * share,
        -- Σ authority_cost_base when the Picture supplies it (group-scoped
        -- charge basis); the head count stands in otherwise (s1 base == 1).
        baseSum  = (bucket.baseSum or bucket.strength or 0) * share,
        groups   = bucket.groups or {},
        locked   = bucket.locked or false,  -- guidance asset_locks or explicit
        idle     = idle,
        holdOnly = holdOnly or false,
        moveKind = moveKindOf(bucket, config),
    }
end

local function buildPackages(picture, role, profile, threat, config)
    local packages = {}
    local ledger = picture.ledger or {}
    local anchor = threat and threat.anchor
    local garrison = profile.garrisonFraction
    if garrison == nil then garrison = config.GARRISON_FRACTION or 0 end
    for _, regionKey in ipairs(sortedKeys(ledger)) do
        local bucket = ledger[regionKey]
        if (bucket.strength or 0) > 0 then
            if regionKey == anchor and garrison > 0 and garrison < 1 then
                packages[#packages + 1] = makePackage('pkg:' .. regionKey, regionKey,
                    bucket, 1 - garrison, config, false)
                packages[#packages + 1] = makePackage('pkg:' .. regionKey .. ':garrison',
                    regionKey, bucket, garrison, config, true)
            else
                packages[#packages + 1] = makePackage('pkg:' .. regionKey, regionKey,
                    bucket, 1, config, false)
            end
        end
    end
    return packages
end

--=============================================================================
-- 2. Budget governor (§3.3).  Broke ⇒ only DEFEND postures (always
-- affordable). Makes tempo follow the economy with zero special-casing.
--=============================================================================
local function governor(picture, config, role)
    local econ = picture.economy or {}
    -- Co-commander never draws the team fallback (plan §5): own pool only.
    local pool = (econ.ownPool or 0)
               + (role.teamAuthorityFallback and (econ.teamPool or 0) or 0)
    local reserve = math.ceil(pool * config.RESERVE_FRACTION)   -- keep 25% back
    local budget  = math.max(0, pool - reserve)                 -- spendable/tick
    -- Guidance funding rate cap (interaction §6.2) clamps the governor spend.
    -- The cap is authority per game-MINUTE — that is what the panel's control
    -- means and what game_ai_guidance.lua's allowance drip pays out — but this
    -- budget is per strategic TICK, so it must be prorated. Left unscaled (as
    -- it was) a cap of 40 permitted 40 per tick = ~480/min at the LOD-0 cadence
    -- of 150 frames, twelve times the income it authorises, so the "cap" barely
    -- bound anything. role.tickFrames is the role's live cadence, so a
    -- coarser-LOD AI thinking less often correctly gets a proportionally larger
    -- per-tick slice of the same per-minute allowance.
    if econ.fundingRateCap then
        local tickFrames = role.tickFrames or config.STRATEGIC_TICK_FRAMES or 150
        local perTick = econ.fundingRateCap * (tickFrames / FRAMES_PER_MINUTE)
        budget = math.min(budget, perTick)
    end
    return {
        pool         = pool,
        reserve      = reserve,
        budget       = budget,
        posturesOnly = budget <= 0,        -- broke ⇒ only always-affordable DEFEND
        costScale    = econ.costScale or 1.0,
    }
end

--=============================================================================
-- 3. Scoring (§3.2).  Every term is a plain function of the Picture.
--=============================================================================

--- Stance bias (guidance §6.2, BINDING). A human sets one of three stances on
-- the guidance store (game_ai_guidance.lua STANCES); it re-weights the whole
-- goal slate by kind. `defensive` leans the co-commander into holding ground
-- and discounts pushing out; `aggressive` does the reverse; `balanced` (and any
-- unset/unknown stance) is neutral — no entry, ×1. This is the coarse "how hard
-- should you press" dial that sits above the per-goal delegation weights.
local STANCE_BIAS = {
    defensive  = { DEFEND = 1.5, SCOUT = 1.0, EXPAND = 0.55, BUILD = 1.1, OBJECTIVE = 0.9,
                   ATTACK = 0.4, DENY = 0.4, RESERVE = 1.0 },
    aggressive = { DEFEND = 0.8, SCOUT = 1.1, EXPAND = 1.45, BUILD = 1.0, OBJECTIVE = 1.25,
                   ATTACK = 1.5, DENY = 1.5, RESERVE = 1.0 },
}

--- Allocation rank (endtoend Q-E1 / D47 — "what makes the prize contestable?",
-- answer A: the AI must want the prize).
--
-- A `victory = true` objective is not worth its reward, it is worth the war,
-- and no reward number is allowed to say so. On `crossing_standoff` the
-- terminal control pays 300 against side controls that pay 110, so the planner
-- priced the whole war at 2.7 side objectives — and since `score` is
-- `value·pSuccess − cost` with cost scaling in package strength, an army-scale
-- assault on defended ground scores BELOW a cheap posture whatever the reward
-- is. Fire 23 measured the consequence: two independent wars, 14 player
-- directives against 0, both ended on the identical frame, because neither AI
-- ever went for the centre and the hold clock decided it.
--
-- So the terminal objective does not compete on score at all — it is allocated
-- FIRST, taking the best package available, and everything else is scored
-- against what is left. A magnitude weight would have been the same fix tuned
-- to today's strength scale and silently broken by the next one. Whether the
-- attack is *viable* stays a judgement, and stays in `goalFloor`.
--
-- WITHDRAW sits above even that: a side that has decided to leave leaves with
-- everything (the goal is multi-package), and the prize is no longer the war.
local function allocationRank(goal)
    if goal.kind == 'WITHDRAW' then return 2 end
    if goal.meta and goal.meta.victory then return 1 end
    return 0
end

--- expectedValue: objective reward | region value, scaled by profile weights
-- (aggression multiplies enemy-owned region value; §3.4), guidance paint, and
-- the guidance stance. Region-derived values are lifted onto the authority
-- scale (§3.2 "× strategic weights"); objective goals already carry an
-- authority reward and are not, and WITHDRAW's value is already scaled.
local function expectedValue(goal, picture, profile, guidance, config)
    local v = goal.value or 0
    if goal.kind ~= 'OBJECTIVE' and goal.kind ~= 'WITHDRAW' and goal.kind ~= 'DENY' then
        v = v * (config.STRATEGIC_VALUE_SCALE or 1)
    end
    local r = goal.region and (picture.regions or {})[goal.region]
    if r and r.owner and r.owner ~= -1 and r.owner ~= profile._teamId
       and goal.kind ~= 'WITHDRAW' then
        v = v * (profile.aggression or 1.0)          -- want enemy ground more
    end
    if goal.region and guidance.regionPaint[goal.region] == 'priority' then
        v = v * 2.0                                    -- guidance §6.2 (binding)
    end
    local bias = STANCE_BIAS[guidance.stance]          -- guidance stance (binding)
    if bias then v = v * (bias[goal.kind] or 1.0) end
    return v
end

--- pSuccess: Lanchester-square proxy of the package against the THREAT MAP's
-- estimate at the goal (enemy in the region plus half of every neighbour's —
-- an assault next to a large enemy stack is not a walk-over just because the
-- target square is empty). With nothing known there, a cautious-but-usable
-- prior so a blind AI neither charges nor freezes; DEFEND of our own ground
-- and WITHDRAW are trusted moves.
local function pSuccess(pkg, goal, threat, profile)
    if goal.kind == 'WITHDRAW' then return 1.0 end
    local ownPower = pkg and pkg.strength or 0
    local p = Threat.pSuccessAt(threat, goal.region, ownPower)
    if p ~= nil then return p end
    -- No known defender. EXPAND/SCOUT into the unknown is a profile call
    -- (caution lowers the prior). Defended-region assaults need real intel.
    return goal.kind == 'DEFEND' and 0.9 or (0.65 * (profile.confidence or 1.0))
end

--- Source weighting (co-commander delegation-first, §5 / interaction §6.2).
-- Multipliers are the delegation engine: humans steer the AI through these.
local function sourceWeight(goal, role, guidance, profile)
    local w = 1.0
    if role.delegationFirst then
        if guidance.delegated[goal.id] then w = w * 5.0        -- "Assign to AI"
        elseif goal.source == 'bounty' then w = w * 3.0         -- staked bounty
        elseif goal.meta and goal.meta.suggested then w = w * 2.0 -- soft hint
        end
    end
    if goal.source == 'bounty' then
        w = w * (profile.opportunism or 1.0)                    -- profile bias
    end
    return w
end

--- Region-ownership bucket for the cost formula's regionMod (friendly/
-- neutral/enemy). GOAL-dependent only (never `pkg`). The directive charge
-- pins regionMod to 1.0 today (config.lua header), so this is carried for
-- the report and for the day the charge grows a real one.
local function regionKind(goal, picture)
    local r = goal.region and (picture.regions or {})[goal.region]
    if r then
        if r.owner == picture.economy._teamId then return 'friendly' end
        if r.owner and r.owner ~= -1 then return 'enemy' end
    end
    return 'neutral'
end

--- The pSuccess floor this profile plays at. A profile's `pSuccessFloor`
-- REPLACES the config default; it used to be max()ed with it, so the shipped
-- profiles' 0.0/0.10/0.15 never changed a decision.
local function floorFor(profile, config)
    if profile.pSuccessFloor ~= nil then return profile.pSuccessFloor end
    return config.PSUCCESS_FLOOR or 0.6
end

--- Per-goal pSuccess floor (§3.3 "don't trickle: mass or skip"). Returns nil
-- for a goal that is exempt from the floor entirely.
--
-- DEFEND is exempt — defending your own valuable ground is always worth it —
-- and so is the terminal objective when WE are the ones holding it, for the
-- same reason with the war riding on it. WITHDRAW is exempt: it is not a fight.
--
-- Contesting a prize an ENEMY holds gets a LOWERED floor rather than an
-- exemption (Q-E1/D47). Refusing to attack without a 60 % edge is right for a
-- side objective and fatal for the one that ends the war: the alternative to a
-- 45 % attack is not "no fight", it is a certain loss on the hold clock. So the
-- floor drops to VICTORY_PSUCCESS_FLOOR and decays from there to zero as the
-- holder's clock runs out. It deliberately overrides a cautious profile's own
-- floor via min() — this is the one goal caution may not sit out.
local function goalFloor(goal, floor, config)
    if goal.kind == 'DEFEND' or goal.kind == 'WITHDRAW' then return nil end
    local vic = goal.meta and goal.meta.victory and goal.meta.victoryState
    if not vic then return floor end
    if vic.mine then return nil end
    local vf = (config.VICTORY_PSUCCESS_FLOOR or 0.35) * (1 - (vic.progress or 0))
    return math.min(floor, vf)
end

local function authorityCost(goal, pkg, kind, gov, config)
    if goal.kind == 'DEFEND' then
        return config.predictPostureCost(pkg, kind, gov.costScale)
    end
    return config.predictDirectiveCost(pkg, kind, goal.echelon, gov.costScale)
end

--=============================================================================
-- 3b. Travel + reachability (§2: adjacency IS strategic distance).
--
-- Hop distances are computed ONCE per (goal region, movement kind) per plan
-- and looked up per package. A package whose region cannot reach the goal
-- under its movement kind (split reachability — armour realms separated by a
-- ridge only infantry climbs) is NOT a candidate: before this the penalty was
-- a stub returning 0 and the planner would send an armour package at ground
-- it could never enter, every tick, forever. A package with no graph position
-- ('_all' / 'wilds') is neither penalised nor excluded — its distance is
-- unknown, not infinite.
--=============================================================================
local function travelTable(ctx)
    local cache = {}
    local regions = ctx.picture.regions or {}
    local config = ctx.config
    return function(goalRegion, kind)
        if not goalRegion or not regions[goalRegion] then return nil end
        local k = kind or '*'
        local byKind = cache[goalRegion]
        if not byKind then byKind = {}; cache[goalRegion] = byKind end
        local dist = byKind[k]
        if not dist then
            local passable = Graph.passableFor(kind, config)
            if passable and not passable(nil, goalRegion, regions) then
                dist = {}                               -- goal ground itself is closed to this kind
            else
                dist = Graph.hops(regions, { [goalRegion] = true }, passable)
            end
            byKind[k] = dist
        end
        return dist
    end
end

--- hops from pkg to goal, or nil = unreachable. 0 when either side has no
-- graph position.
local function hopsFor(hopsTable, goal, pkg, regions)
    if not goal.region or not regions[goal.region] then return 0 end
    if not pkg.region or not regions[pkg.region] then return 0 end
    local dist = hopsTable(goal.region, pkg.moveKind)
    if not dist then return 0 end
    return dist[pkg.region]
end

--=============================================================================
-- 4. Guidance gate (interaction §6.2) — BINDING, applied before scoring so
-- forbidden goals never even compete.
--=============================================================================
--- Returns `excluded, reason` — the reason so the caller can report a HUMAN's
--- veto separately from an authored paint rule.
---
--- Why the reason is reported at all: "the AI stopped pursuing the vetoed goal"
--- is not observable from outside. The top-ranked goal rotates tick to tick as
--- expansion progresses, so a planner that ignored the veto entirely produces
--- much the same intent lines — measured 2026-08-14, with this function's veto
--- clause commented out the live loop gate (`make test-ai-veto-loop`) still
--- passed. The only thing that separates the two worlds is whether the veto was
--- consulted, and only the planner can say so. It must be reported as a
--- BY-PRODUCT of the exclusion, never recomputed beside it: a report derived
--- from the veto list independently would keep naming the goal for a planner
--- that no longer acted on it, which is the same gate being inert with extra
--- confidence.
local function guidanceExcludes(goal, guidance)
    if goal.region and guidance.regionPaint[goal.region] == 'forbidden' then
        return true, 'paint'                         -- hard exclusion
    end
    if guidance.veto[goal.id] then return true, 'veto' end   -- vetoed this tick window
    return false
end

--=============================================================================
-- 5+6. Greedy assignment with force floors + commitment hysteresis (§3.3).
--
-- PERF (§10 task 7 — measured at the §6 50-region/500-squad fixture: this
-- loop is goals×packages and was the dominant strategic-tick cost, ~65% of
-- the tick, mostly two things the profile indicted:
--   1. `expectedValue`/`sourceWeight`/the region-kind lookup are functions of
--      GOAL alone — they never read `pkg` — but were being recomputed once
--      per (goal, pkg) pair. Hoisted out to once per goal.
--   2. Every candidate pair allocated its own hash table (`pairs_[#pairs_+1]
--      = {goal=..., pkg=..., ...}`), ~goals×packages allocations/tick (the
--      dominant source of the measured per-tick GC churn). Replaced with
--      parallel arrays sorted by an index permutation; only the handful of
--      WINNING assignments (≤ #goals) get a real table, in `emit`'s shape.
-- Same scores, same tie-breaks, same greedy order as before — this is a
-- constant-factor rewrite, not a behaviour change (planner_spec.lua's
-- fixture-level assertions are the regression guard).
--=============================================================================
local function assign(goals, packages, ctx)
    local picture, profile, role = ctx.picture, ctx.profile, ctx.role
    local config, gov, rng = ctx.config, ctx.gov, ctx.rng
    local commitments = ctx.commitments
    local threat = ctx.threat
    local guidance = picture.guidance
    local regions = picture.regions or {}
    local hopsTable = travelTable(ctx)
    local perHop = config.TRAVEL_PENALTY_PER_HOP or 0
    local hopFrames = config.HOP_TRAVEL_FRAMES or 0
    local frame = picture.frame or 0

    -- Parallel candidate arrays (index i <-> one (goal, pkg) pair). RESERVE
    -- is NOT a competitor — it is the sink for force no real goal claimed
    -- (§3.1), so it is excluded here and swept up after assignment.
    -- (Otherwise, since scores are cost-dominated and often negative, cheap
    -- RESERVE could out-rank a costly real objective and steal its package.)
    local cGoal, cPkg, cScore, cPs, cCost, cTie = {}, {}, {}, {}, {}, {}
    local cRank, cMass, cHops = {}, {}, {}   -- allocation tier + package mass + hops
    local n = 0
    local vetoed = {}             -- goals a human's veto removed, this tick

    for _, goal in ipairs(goals) do
        local excluded, why = guidanceExcludes(goal, guidance)
        if excluded and why == 'veto' and goal.kind ~= 'RESERVE' then
            vetoed[#vetoed + 1] = goal.id
        end
        if not excluded and goal.kind ~= 'RESERVE' then
            -- Package-independent terms: once per goal, not once per pair.
            local ev = expectedValue(goal, picture, profile, guidance, config)
            local sw = sourceWeight(goal, role, guidance, profile)
            local kind = regionKind(goal, picture)
            local rank = allocationRank(goal)
            local c = commitments[goal.id]
            local remaining = goal.meta and goal.meta.remaining

            for _, pkg in ipairs(packages) do
                local locked = pkg.locked or guidance.assetLocks[pkg.id]
                -- Co-commander etiquette: only assign idle/unassigned force,
                -- and never a locked group (§5.1 / §6.2 lock beats idle).
                local touchable = (not locked) and (not role.idleOnly or pkg.idle)
                -- Posture floor: a garrison package only DEFENDs its own ground.
                if touchable and pkg.holdOnly then
                    touchable = goal.kind == 'DEFEND' and goal.region == pkg.region
                end
                local hops = touchable and hopsFor(hopsTable, goal, pkg, regions) or nil
                -- Unreachable ⇒ not a candidate. Expiring and out of reach in
                -- time ⇒ not a candidate either (a package that arrives after
                -- the bell trickled for nothing).
                if hops ~= nil and remaining ~= nil and hopFrames > 0
                   and hops * hopFrames > remaining then
                    hops = nil
                end
                if touchable and hops ~= nil then
                    local ps = pSuccess(pkg, goal, threat, profile)
                    local cost = authorityCost(goal, pkg, kind, gov, config)
                    local travel = 1 / (1 + perHop * hops)
                    -- commitment bonus: sticky if this pkg already serves goal.
                    local bonus = 0
                    if c and c.packageId == pkg.id then
                        local age = frame - (c.sinceFrame or frame)
                        bonus = math.max(0, 1 - age / config.COMMITMENT_DECAY_FRAMES)
                    end
                    n = n + 1
                    cGoal[n], cPkg[n] = goal, pkg
                    cRank[n], cMass[n], cHops[n] = rank, pkg.strength or 0, hops
                    cScore[n] = ev * ps * sw * travel - cost + bonus
                    cPs[n], cCost[n] = ps, cost
                    -- Tie-break assigned up front (§10): calling rng.random()
                    -- inside the sort comparator would violate the strict
                    -- weak ordering table.sort requires (non-deterministic
                    -- across calls for the same pair).
                    cTie[n] = rng.random()
                end
            end
        end
    end

    -- Allocation tier first (the terminal objective picks its package before
    -- anything else competes — see allocationRank), then descending score, then
    -- the deterministic pre-assigned tie-break.
    local order = {}
    for i = 1, n do order[i] = i end
    table.sort(order, function(i, j)
        if cRank[i] ~= cRank[j] then return cRank[i] > cRank[j] end
        -- Inside the terminal-objective tier MASS picks the package, not score.
        -- Score would pick the CHEAPEST one for the most important goal in the
        -- war: cost scales with package strength and pSuccess is a flat prior
        -- until the prize is actually defended, so `value·p − cost` is maximised
        -- by the smallest force that can be sent. That is not a hypothetical —
        -- it is what the live AI did (fire 24): 3 units dispatched at the war
        -- while 14 sat on a rear DEFEND posture, every tick, until the fragment
        -- died. §3.3's "mass or skip" applied to the one goal that decides it.
        if cRank[i] >= 1 and cMass[i] ~= cMass[j] then return cMass[i] > cMass[j] end
        if cScore[i] == cScore[j] then
            if cHops[i] ~= cHops[j] then return cHops[i] < cHops[j] end
            return cTie[i] < cTie[j]
        end
        return cScore[i] > cScore[j]
    end)

    local usedPkg, usedGoal, assignments = {}, {}, {}
    local floor = floorFor(profile, config)
    for _, idx in ipairs(order) do
        local goal, pkg = cGoal[idx], cPkg[idx]
        local gid, pid = goal.id, pkg.id
        if not usedPkg[pid] and not usedGoal[gid] then
            -- Force floor (§3.3): don't trickle into a losing fight. DEFEND
            -- and the terminal objective bend it — see goalFloor.
            local gFloor = goalFloor(goal, floor, config)
            if gFloor == nil or cPs[idx] >= gFloor then
                -- Hysteresis: replacing an existing commitment needs to clear
                -- the reassign bar (§3.3) — prevents thrash.
                --
                -- The terminal objective is exempt (fire 24). A package is
                -- identified by the REGION its units are standing in, so an
                -- army that marches out of its home region is re-bucketed into
                -- a new package id and the goal's commitment stays pinned to
                -- whatever rump was left behind — and the ×1.4 bar then makes
                -- that pinning permanent, because the score of the big package
                -- is comparable to, not 1.4× better than, the small one's.
                -- Measured live: the war's goal held `pkg:home` (3 stragglers)
                -- for every tick of the march while `pkg:iron_bend` (14 units)
                -- took a rear DEFEND posture. Thrash is not the risk it would
                -- be for a normal goal: within this tier the sort is by MASS,
                -- so the choice is stable as long as the biggest force is.
                local existing = commitments[gid]
                local barOK = true
                if existing and existing.packageId ~= pid and cRank[idx] == 0 then
                    barOK = cScore[idx] > (existing.score or 0) * config.REASSIGN_BAR
                end
                if barOK then
                    usedPkg[pid] = true
                    -- A multi-package goal (WITHDRAW) takes every package.
                    if not (goal.meta and goal.meta.multi) then usedGoal[gid] = true end
                    assignments[#assignments + 1] = {
                        goal = goal, pkg = pkg, score = cScore[idx],
                        ps = cPs[idx], cost = cCost[idx], hops = cHops[idx],
                    }
                end
            end
        end
    end
    return assignments, usedPkg, vetoed
end

--=============================================================================
-- 7. Emit — turn assignments into a directive list the actuator executes,
-- rate-clamped (§8 E6) and paired with an intent report (interaction §6.3).
--=============================================================================
local function emit(assignments, packages, usedPkg, ctx)
    local gov, config = ctx.gov, ctx.config
    local directives, intent = {}, {}
    local perGroupCount = {}
    local emitted = {}
    local spent = 0

    -- Assignments arrive highest-score-first, so budget is spent on the best
    -- goals; DEFEND postures are the always-affordable emergency floor and are
    -- exempt from the budget (plan §8 E2 — DEFEND stays affordable when broke).
    -- WITHDRAW is exempt too: a side that must leave is not asked to afford it.
    for _, a in ipairs(assignments) do
        local pid = a.pkg.id
        perGroupCount[pid] = (perGroupCount[pid] or 0) + 1
        if perGroupCount[pid] <= config.DIRECTIVE_RATE_CLAMP then     -- §8 E6
            local isPosture = a.goal.kind == 'DEFEND'
            local exempt = isPosture or a.goal.kind == 'WITHDRAW'
            local afford = exempt or (spent + a.cost) <= gov.budget
            if afford then
                if not exempt then spent = spent + a.cost end
                directives[#directives + 1] = {
                    type      = isPosture and 'posture' or 'directive',
                    echelon   = a.goal.echelon,
                    directive = a.goal.directive,
                    groupId   = pid,
                    region    = a.goal.region,
                    goalId    = a.goal.id,
                    predictedCost = a.cost,
                    hops      = a.hops,
                    -- Committed force size (the assigned package's aggregate
                    -- strength) → the directive's requestedStrength demand cap
                    -- in the actuator, so one directive can't drain the whole
                    -- idle pool (plan §3.2 demand model).
                    strength  = a.pkg.strength,
                    -- The SAME package expressed in the engine's scale
                    -- (absolute hitpoints). The demand cap is stated from this
                    -- one; `strength` stays the number the AI reasons and
                    -- narrates in (D68).
                    healthStrength = a.pkg.health or 0,
                }
                -- Honest spend: a posture is an area-scoped Defend directive
                -- and is charged like one (config.lua header); the intent
                -- line used to say 0.
                intent[#intent + 1] = {
                    goal = a.goal.id, group = pid, region = a.goal.region,
                    spend = a.cost, kind = a.goal.kind,
                }
                emitted[#emitted + 1] = a
            end
        end
    end

    -- Uncommitted surplus → RESERVE (§3.1): packages no goal claimed hold at
    -- the weighted centroid of owned regions. In the skeleton that "hold" is a
    -- no-op (zero-cost, thrash-free) surfaced as an intent line for legibility;
    -- placing them on a real rally point waits on region geometry (AI1).
    local reserved, garrison = {}, {}
    for _, pkg in ipairs(packages) do
        if pkg.holdOnly then garrison[#garrison + 1] = pkg.id end
        if not usedPkg[pkg.id] then
            reserved[#reserved + 1] = pkg.id
            intent[#intent + 1] = { goal = 'reserve', group = pkg.id, spend = 0,
                                    kind = pkg.holdOnly and 'GARRISON' or 'RESERVE' }
        end
    end

    return {
        directives = directives, intent = intent, reserved = reserved,
        garrison = garrison,
        posturesOnly = gov.posturesOnly, reserve = gov.reserve,
        budget = gov.budget, spent = spent,
        -- What `assign` actually excluded on a human's veto — its own record,
        -- not a recomputation (see guidanceExcludes' header).
        vetoed = ctx._vetoed or {},
    }, emitted
end

--=============================================================================
-- Commitment decay — drop stale commitments so freed goals can reassign (§3.3
-- / §8 E1: dead-goal cleanup happens naturally as the slate omits them).
--=============================================================================
local function decayCommitments(commitments, frame, slate, config)
    local live = {}
    for _, g in ipairs(slate) do live[g.id] = true end
    for gid, c in pairs(commitments) do
        local age = frame - (c.sinceFrame or frame)
        if (not live[gid]) or age > config.COMMITMENT_DECAY_FRAMES * 2 then
            commitments[gid] = nil          -- goal gone or commitment too old
        end
    end
end

--- Record commitments for the directives that actually WENT OUT. An
-- assignment the budget then refused used to be committed anyway, so the next
-- tick's hysteresis defended a directive nobody had issued. A commitment that
-- keeps its package keeps its original `sinceFrame` (the bonus decays from
-- the first tick it was issued, not the latest).
local function commitEmitted(commitments, emitted, frame)
    for _, a in ipairs(emitted) do
        local gid, pid = a.goal.id, a.pkg.id
        local prev = commitments[gid]
        if a.goal.meta and a.goal.meta.multi then
            -- keep the strongest package as the record for a multi goal
            if not prev or (a.pkg.strength or 0) > (prev.strength or 0) then
                commitments[gid] = { packageId = pid, sinceFrame = frame, score = a.score,
                                     strength = a.pkg.strength }
            end
        elseif prev and prev.packageId == pid then
            prev.score = a.score
        else
            commitments[gid] = { packageId = pid, sinceFrame = frame, score = a.score }
        end
    end
end

--=============================================================================
-- Entry point.
--=============================================================================
function Planner.plan(ctx)
    local picture = ctx.picture
    local config  = ctx.config
    local profile = ctx.profile

    -- Thread the team id where the scoring helpers can see it (avoids passing
    -- it through every call). Set on the two tables that already travel.
    profile._teamId = ctx.role.teamId
    picture.economy = picture.economy or {}
    picture.economy._teamId = ctx.role.teamId
    picture.guidance = picture.guidance or {
        regionPaint = {}, assetLocks = {}, delegated = {}, veto = {},
    }
    picture.guidance.regionPaint = picture.guidance.regionPaint or {}
    picture.guidance.assetLocks  = picture.guidance.assetLocks or {}
    picture.guidance.delegated   = picture.guidance.delegated or {}
    picture.guidance.veto        = picture.guidance.veto or {}

    -- The threat map the slate already built for this Picture (or build it).
    local threat = ctx.threat or picture.threat
    if not threat then
        threat = Threat.build(picture, ctx.role, config)
        picture.threat = threat
    end
    ctx.threat = threat

    decayCommitments(ctx.commitments, picture.frame, ctx.slate, config)

    local packages = buildPackages(picture, ctx.role, profile, threat, config)
    local gov = governor(picture, config, ctx.role)
    ctx.gov = gov

    local assignments, usedPkg, vetoed = assign(ctx.slate, packages, ctx)
    -- Carried on ctx rather than through emit's signature: emit already takes
    -- four arguments and this is a report, not an input to the emission.
    ctx._vetoed = vetoed
    local plan, emitted = emit(assignments, packages, usedPkg, ctx)
    commitEmitted(ctx.commitments, emitted, picture.frame)
    plan.withdrawing = false
    for _, d in ipairs(plan.directives) do
        if d.goalId == 'withdraw' then plan.withdrawing = true end
    end
    plan.threat = { own = threat.totals.own, enemy = threat.totals.enemy,
                    ratio = threat.ratio, anchor = threat.anchor }
    return plan
end

--=============================================================================
-- Proposal/demand evaluation (PLAN-metalstorm-interaction.md §6.2 "AI
-- proposal evaluation: expected value of terms vs alternatives ... weighted
-- by the trust ledger and, for demands, by credibility"). PURE — takes the
-- Picture + profile/role, returns a plain decision list; the caller
-- (main.lua) applies it via Actuators:respondProposal (an unimplemented runtime
-- verb — no longer an engine ask, see actuators.lua:173). No
-- Spring/GG/AI access here, same discipline as Planner.plan.
--=============================================================================
local TRUST_VALUE_WEIGHT       = 5    -- authority-equivalent value per trust point
local CEASEFIRE_BASE_VALUE     = 30   -- ceasefires save future order-cost/losses
local DEMAND_CREDIBILITY_FLOOR = 0.55 -- comply when we'd likely lose the fight anyway
local DOMINANT_RATIO           = 2.0  -- "clearly winning / clearly losing" on the map
local TRIBUTE_POOL_FRACTION    = 0.25 -- of the team pool, when buying peace
local MIN_TRIBUTE              = 20   -- below this an offer is an insult, not a bribe
local PEACE_DURATION_FRAMES    = 5400 -- 3 min: long enough to re-form, short enough to mean it
local BLEEDING_HEALTH          = 0.65 -- mean unit health ratio below which we are hurt

--- Total own force vs total KNOWN enemy force, map-wide.
--
-- Prefers the threat map the planner already built this tick; falls back to
-- summing the ledger against decayed intel, because a parley poll can happen
-- BETWEEN strategic ticks (main.lua's PARLEY_POLL_FRAMES) and there is no
-- threat map then. Enemy strength is confidence-weighted: we negotiate from
-- what we know, not from what we fear.
local function relativeStrength(picture)
    local t = picture.threat
    if t and t.totals and ((t.totals.own or 0) + (t.totals.enemy or 0)) > 0 then
        return t.totals.own or 0, t.totals.enemy or 0
    end
    local ours, theirs = 0, 0
    for _, b in pairs(picture.ledger or {}) do ours = ours + (b.strength or 0) end
    for _, m in pairs(picture.intel or {}) do
        theirs = theirs + (m.strength or 0) * (m.confidence or 1)
    end
    return ours, theirs
end

local function regionStrength(picture, region, mine)
    if not region then return 0 end
    if mine then
        local bucket = (picture.ledger or {})[region]
        return bucket and bucket.strength or 0
    end
    local mem = (picture.intel or {})[region]
    return mem and (mem.strength or 0) * (mem.confidence or 1) or 0
end

--- Lanchester-square credibility proxy — the SAME shape as pSuccess above
-- (§6.2 "reuses the pSuccess machinery unchanged"), applied to a demand's
-- named region instead of a goal/package pair. No visible enemy presence
-- there at all reads as "not credible" (0), same honest-blindness stance as
-- pSuccess's own "no known defender" branch.
local function credibility(picture, region)
    local theirs = regionStrength(picture, region, false)
    local ours = regionStrength(picture, region, true)
    if theirs <= 0 then return 0 end
    local denom = theirs * theirs + ours * ours
    if denom <= 0 then return 0 end
    return (theirs * theirs) / denom
end

local function evaluateOne(p, picture, profile)
    local trust = (picture.parley.trust or {})[p.fromTeam] or 0

    if p.kind == 'intel' then
        return 'accept'   -- free information, no downside (§1 table)
    end

    -- 'pact' is the tutorial director's umbrella word rather than a kind the
    -- gadget issues, but it reaches the board from hand-written scenarios and
    -- it plainly means "stop shooting" — price it as a ceasefire instead of
    -- letting it fall off the end into "unrecognised kind → reject".
    if p.kind == 'ceasefire' or p.kind == 'safe_passage' or p.kind == 'pact' then
        -- Relative strength first, trust second (ai-actuation, lane 4 ask):
        -- standing down is cheap when you are losing and expensive when you
        -- are winning, and no amount of goodwill makes it otherwise. Both
        -- gates need a KNOWN enemy: with an empty intel memory we are blind,
        -- not dominant, and fall through to the trust/aggression valuation.
        local ours, theirs = relativeStrength(picture)
        if theirs > 0 and ours >= theirs * DOMINANT_RATIO then
            return 'reject'   -- we are winning: a pause only lets them re-form
        end
        if theirs > 0 and ours * DOMINANT_RATIO <= theirs then
            return 'accept'   -- we are losing: any pause is profit
        end
        local value = CEASEFIRE_BASE_VALUE + trust * TRUST_VALUE_WEIGHT
                     - (profile.aggression or 1.0) * 20   -- aggressive profiles discount standing down
        return (value >= 0) and 'accept' or 'reject'
    end

    if p.kind == 'tribute' then
        local t = p.terms or {}
        if (t.payer or 'from') == 'from' then return 'accept' end   -- they pay us — pure upside
        -- We'd be the payer: only worth it with healthy trust (buying real
        -- peace) relative to the amount asked.
        local budget = trust * TRUST_VALUE_WEIGHT
        local amount = t.amount or 0
        if amount <= budget then return 'accept' end
        -- Too dear as asked — but a rejection is not free either: it starts
        -- the gadget's 2 min per-counterparty cooldown, so the next word on
        -- the subject is theirs. COUNTER at what we can actually pay (the
        -- lesser of what the trust is worth and a quarter of the pool), and
        -- only slam the door when even that is nothing.
        local pool = math.floor(((picture.economy or {}).teamPool or 0) * TRIBUTE_POOL_FRACTION)
        local affordable = math.floor(math.min(budget, pool))
        if affordable >= MIN_TRIBUTE and affordable < amount then
            return 'counter', { kind = 'tribute', terms = {
                payer = t.payer, amount = affordable,
                duration = t.duration, perMinute = t.perMinute,
            } }
        end
        return 'reject'
    end

    if p.kind == 'joint_objective' then
        return (trust >= 0) and 'accept' or 'reject'
    end

    if p.kind == 'demand' then
        local t = p.terms or {}
        local region = t.regionKey or (t.innerTerms and t.innerTerms.regionKey)
        return (credibility(picture, region) >= DEMAND_CREDIBILITY_FLOOR) and 'accept' or 'reject'
    end

    return 'reject'   -- unrecognised kind: never silently accept an unknown pact
end

--- Which teams does THIS tick's plan mean to take ground from? Read off the
-- plan's own intent lines (planner output, §3.1) rather than guessed at: an
-- ATTACK or DENY line names a region, and the picture names that region's
-- owner. "Currently fighting" in the profile sense is not "we are at war on
-- paper" — it is "our own orders this tick are pointed at them", which is the
-- only claim a pure core can make honestly.
-- No plan (an older caller, or a tick whose plan never got built) → an empty
-- set, i.e. we are not attacking anyone, which is the permissive reading. The
-- profile handler is the one place that matters and it is only ever consulted
-- from main.lua's handleParley, which does hand the plan over.
function Planner.attackIntentTeams(picture, plan, teamId)
    local out = {}
    local regions = picture and picture.regions or {}
    for _, line in ipairs((plan or {}).intent or {}) do
        if line.kind == 'ATTACK' or line.kind == 'DENY' then
            local r = line.region and regions[line.region]
            local owner = r and r.owner
            if owner and owner ~= -1 and owner ~= teamId then out[owner] = true end
        end
    end
    return out
end

--- Evaluate every pending (offered/countered) proposal addressed to our own
-- team. Returns { {id=, decision='accept'|'reject'|'counter', extra=?}, ... }
-- — main.lua feeds each straight into
-- Actuators:respondProposal(id, decision, extra); `extra` is
-- { kind?, terms? } for a counter and nil otherwise.
--
-- A PROFILE may override the valuation: `profile.evaluateProposal(p, ctx)`
-- (ai-eval, the recon_01 Diplomacy Mission). It returns a decision + optional
-- extra to speak for this proposal, or nil to say nothing and fall through to
-- the shared valuation below — so a profile states only the cases it has an
-- opinion about. `ctx` is { picture, profile, role, plan, teamId, attacking }
-- where `attacking[team]` is true iff this tick's plan points at that team.
-- The hook is pure (no actuator, no engine): main.lua still owns the
-- answered/deferred ledger and the actuator still owns the authority to speak.
function Planner.evaluateProposals(picture, profile, role, plan)
    local teamId = role and role.teamId
    local out = {}
    local ctx = nil
    if type(profile.evaluateProposal) == 'function' then
        ctx = { picture = picture, profile = profile, role = role, plan = plan,
                teamId = teamId,
                attacking = Planner.attackIntentTeams(picture, plan, teamId) }
    end
    for _, p in ipairs((picture.parley or {}).proposals or {}) do
        if p.toTeam == teamId and (p.state == 'offered' or p.state == 'countered') then
            local decision, extra
            if ctx then
                -- A faulty handler must not swallow the whole board — and a
                -- board left unanswered is how a proposal expires. The pure
                -- core has no logger, so the fault is not narrated here; the
                -- proposal simply falls through to the shared valuation and
                -- still gets an answer inside the gadget's 60 s window.
                local ok, d, e = pcall(profile.evaluateProposal, p, ctx)
                if ok then decision, extra = d, e end
            end
            if decision == nil then decision, extra = evaluateOne(p, picture, profile) end
            out[#out + 1] = { id = p.id, decision = decision, extra = extra }
        end
    end
    return out
end

--=============================================================================
-- Origination (ai-actuation lane-4 ask). main.lua's handleParley has called
-- this hook since the parley verbs landed; until now the function did not
-- exist and the AI could only ever ANSWER. An AI that never opens its mouth
-- cannot buy itself out of a losing war.
--
-- Deliberately narrow. Two situations, one proposal at a time, and only ever
-- to a team we can see on the map or have already talked to:
--   * losing badly  → tribute-for-peace (we pay), out of a quarter of the pool
--   * both bleeding at rough parity → ceasefire
-- Everything else is silence. The actuator's deference rule (a co-commander
-- never binds its humans), its one-per-tick limit, and the gadget's own fee /
-- live-cap / cooldown all still apply on top.
--=============================================================================

--- Teams we could plausibly address: whoever owns ground next to ours, plus
-- anyone already on our parley board. Both are public, fog-honest reads —
-- there is no "list every team" capability and we do not invent one.
local function counterparties(picture, teamId)
    local seen = {}
    local regions = picture.regions or {}
    local mine = {}
    for key, r in pairs(regions) do
        if r.owner == teamId then mine[key] = true end
    end
    for key in pairs(mine) do
        for _, nkey in ipairs((regions[key] and regions[key].neighbors) or {}) do
            local owner = regions[nkey] and regions[nkey].owner
            if owner and owner ~= -1 and owner ~= teamId then
                seen[owner] = (seen[owner] or 0) + 1
            end
        end
    end
    for other in pairs((picture.parley or {}).trust or {}) do
        seen[other] = seen[other] or 0
    end
    return seen
end

--- Is anything already pending between us and `other`? Opening a second
-- conversation while the first is unanswered is how an AI burns its four
-- live-proposal slots and its counterparty's patience.
local function pendingWith(picture, teamId, other)
    for _, p in ipairs((picture.parley or {}).proposals or {}) do
        if (p.state == 'offered' or p.state == 'countered')
                and ((p.fromTeam == teamId and p.toTeam == other)
                  or (p.fromTeam == other and p.toTeam == teamId)) then
            return true
        end
    end
    return false
end

--- Mean health ratio of our force: `strength` is Σ (0-1 health ratios) and
-- `count` the head count, so their quotient is how hurt we are. No count
-- published (older picture shape) → unknown, and unknown is not "bleeding".
local function bleeding(picture)
    local strength, count = 0, 0
    for _, b in pairs(picture.ledger or {}) do
        strength = strength + (b.strength or 0)
        count = count + (b.count or 0)
    end
    if count == 0 then return false end
    return (strength / count) < BLEEDING_HEALTH
end

function Planner.originateProposals(picture, profile, role)
    local out = {}
    local teamId = role and role.teamId
    if teamId == nil then return out end

    local ours, theirs = relativeStrength(picture)
    if theirs <= 0 then return out end          -- we know of no enemy: nothing to negotiate

    -- The counterparty with the most ground against ours; ties broken by team
    -- id so two runs of the same Picture propose to the same team.
    local best, bestScore = nil, -1
    local cands = counterparties(picture, teamId)
    local keys = {}
    for other in pairs(cands) do keys[#keys + 1] = other end
    table.sort(keys)
    for _, other in ipairs(keys) do
        if cands[other] > bestScore then best, bestScore = other, cands[other] end
    end
    if best == nil or pendingWith(picture, teamId, best) then return out end

    local aggression = profile.aggression or 1.0

    if ours * DOMINANT_RATIO <= theirs then
        -- Losing badly: buy time with money, which is the one thing a losing
        -- side still has. Paying is the point — `payer = 'from'` is US.
        local amount = math.floor(((picture.economy or {}).teamPool or 0) * TRIBUTE_POOL_FRACTION)
        if amount >= MIN_TRIBUTE then
            out[#out + 1] = { kind = 'tribute', toTeam = best,
                              terms = { payer = 'from', amount = amount,
                                        duration = PEACE_DURATION_FRAMES } }
        end
        return out
    end

    -- Rough parity and we are hurt: a ceasefire costs both sides nothing they
    -- were going to win anyway. An aggressive profile would rather bleed.
    if aggression < 1.5 and bleeding(picture)
            and ours < theirs * DOMINANT_RATIO and theirs < ours * DOMINANT_RATIO then
        out[#out + 1] = { kind = 'ceasefire', toTeam = best,
                          terms = { duration = PEACE_DURATION_FRAMES } }
    end
    return out
end

return Planner
