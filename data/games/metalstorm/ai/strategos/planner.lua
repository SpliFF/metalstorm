-- planner.lua — goal slate → force allocation (PLAN-metalstorm-ai.md §3.2/§3.3).
-- PURE.  planner.plan(ctx) -> { directives... }.  No engine access.
--
-- This is the whole brain and, per the plan, "most of the plan and none of it
-- is blocked" — it takes a plain Picture + slate and returns a directive list,
-- fully testable headless (the busted specs in tests/ drive exactly this).
--
-- The pipeline, in order:
--   1. packages   — group the own-force ledger into assignable packages
--   2. governor    — economic gate: broke ⇒ postures only (§3.3)
--   3. score       — expectedValue × pSuccess − cost − travel + commitment (§3.2)
--   4. guidance    — binding co-commander overrides (interaction §6.2)
--   5. assign      — greedy over descending score, per-goal force floors (§3.3)
--   6. commit       — hysteresis: reassign only if newScore > current × 1.4
--   7. emit        — directive list + intent report; rate-clamped (§8 E6)

local Planner = {}

-- Guidance's funding rate cap is quoted per game-minute; the governor budgets
-- per strategic tick. GAME_SPEED 30 — the same 1800 game_authority.lua's
-- stipend and game_ai_guidance.lua's allowance drip use.
local FRAMES_PER_MINUTE = 1800

--=============================================================================
-- 1. Force packages.  An org-group is a package; unassigned squads are
-- grouped into proposed packages. STUB: one package per populated ledger
-- region (the shape the assigner consumes is real).
--=============================================================================
local function buildPackages(picture, role)
    local packages = {}
    for regionKey, bucket in pairs(picture.ledger or {}) do
        if (bucket.strength or 0) > 0 then
            packages[#packages + 1] = {
                id       = 'pkg:' .. regionKey,
                region   = regionKey,
                strength = bucket.strength,
                baseSum  = bucket.strength,   -- proxy for Σ authority_cost_base
                groups   = bucket.groups or {},
                locked   = bucket.locked or false,  -- guidance asset_locks or explicit
                -- idle state: co-commander etiquette (§5.1) — only assign idle force.
                -- Read from the ledger bucket if present, else default to true (unknown
                -- = treat as idle, safe conservative default). The real tracking comes
                -- from directive age (groups directed within last 3 min are NOT idle);
                -- that logic lives in picture.lua's force-ledger builder (AI1-blocked).
                idle     = (bucket.idle ~= nil) and bucket.idle or true,
            }
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
    defensive  = { DEFEND = 1.5, SCOUT = 1.0, EXPAND = 0.55, BUILD = 1.1, OBJECTIVE = 0.9,  RESERVE = 1.0 },
    aggressive = { DEFEND = 0.8, SCOUT = 1.1, EXPAND = 1.45, BUILD = 1.0, OBJECTIVE = 1.25, RESERVE = 1.0 },
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
local function allocationRank(goal)
    if goal.meta and goal.meta.victory then return 1 end
    return 0
end

--- expectedValue: objective reward | region value, scaled by profile weights
-- (aggression multiplies enemy-owned region value; §3.4), guidance paint, and
-- the guidance stance. Region-derived values are lifted onto the authority
-- scale (§3.2 "× strategic weights"); objective goals already carry an
-- authority reward and are not.
local function expectedValue(goal, picture, profile, guidance, config)
    local v = goal.value or 0
    if goal.kind ~= 'OBJECTIVE' then
        v = v * (config.STRATEGIC_VALUE_SCALE or 1)
    end
    local r = goal.region and (picture.regions or {})[goal.region]
    if r and r.owner and r.owner ~= -1 and r.owner ~= profile._teamId then
        v = v * (profile.aggression or 1.0)          -- want enemy ground more
    end
    if goal.region and guidance.regionPaint[goal.region] == 'priority' then
        v = v * 2.0                                    -- guidance §6.2 (binding)
    end
    local bias = STANCE_BIAS[guidance.stance]          -- guidance stance (binding)
    if bias then v = v * (bias[goal.kind] or 1.0) end
    return v
end

--- pSuccess: Lanchester-ish own power vs intel power from the expected-DPS
-- table. STUB math: with no intel/power, return a cautious-but-usable prior so
-- a blind AI neither charges nor freezes; real numbers slot in unchanged.
local function pSuccess(pkg, goal, picture, profile)
    local region = goal.region
    local enemy  = region and (picture.intel or {})[region]
    local ownPower = pkg and pkg.strength or 0
    if not enemy or (enemy.strength or 0) <= 0 then
        -- No known defender. EXPAND/SCOUT into the unknown is a profile call
        -- (caution lowers the prior). Defended-region assaults need real intel.
        return goal.kind == 'DEFEND' and 0.9 or (0.65 * (profile.confidence or 1.0))
    end
    -- Lanchester-square proxy: p ≈ own² / (own² + enemy²).
    local e = enemy.strength * (enemy.confidence or 1)
    local denom = ownPower * ownPower + e * e
    if denom <= 0 then return 0.5 end
    return (ownPower * ownPower) / denom
end

--- travelPenalty: region-graph hops between the package and the goal (§3.2).
-- STUB: graph BFS needs the region adjacency; returns 0 until populated.
local function travelPenalty(pkg, goal, picture, config)
    -- TODO: BFS hop count pkg.region → goal.region over region.neighbors,
    -- × config.TRAVEL_PENALTY_PER_HOP. Adjacency IS strategic distance (§2).
    return 0
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
-- neutral/enemy). GOAL-dependent only (never `pkg`) — hoisted to per-goal
-- in `assign` (task 7 perf pass) rather than recomputed once per package.
local function regionKind(goal, picture)
    local r = goal.region and (picture.regions or {})[goal.region]
    if r then
        if r.owner == picture.economy._teamId then return 'friendly' end
        if r.owner and r.owner ~= -1 then return 'enemy' end
    end
    return 'neutral'
end

--- Per-goal pSuccess floor (§3.3 "don't trickle: mass or skip"). Returns nil
-- for a goal that is exempt from the floor entirely.
--
-- DEFEND is exempt — defending your own valuable ground is always worth it —
-- and so is the terminal objective when WE are the ones holding it, for the
-- same reason with the war riding on it.
--
-- Contesting a prize an ENEMY holds gets a LOWERED floor rather than an
-- exemption (Q-E1/D47). Refusing to attack without a 60 % edge is right for a
-- side objective and fatal for the one that ends the war: the alternative to a
-- 45 % attack is not "no fight", it is a certain loss on the hold clock. So the
-- floor drops to VICTORY_PSUCCESS_FLOOR and decays from there to zero as the
-- holder's clock runs out. It deliberately overrides a cautious profile's own
-- floor via min() — this is the one goal caution may not sit out.
local function goalFloor(goal, floor, config)
    if goal.kind == 'DEFEND' then return nil end
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
-- 4. Guidance gate (interaction §6.2) — BINDING, applied before scoring so
-- forbidden goals never even compete.
--=============================================================================
local function guidanceExcludes(goal, guidance)
    if goal.region and guidance.regionPaint[goal.region] == 'forbidden' then
        return true                                  -- hard exclusion
    end
    if guidance.veto[goal.id] then return true end   -- vetoed this tick window
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
    local guidance = picture.guidance

    -- Parallel candidate arrays (index i <-> one (goal, pkg) pair). RESERVE
    -- is NOT a competitor — it is the sink for force no real goal claimed
    -- (§3.1), so it is excluded here and swept up after assignment.
    -- (Otherwise, since scores are cost-dominated and often negative, cheap
    -- RESERVE could out-rank a costly real objective and steal its package.)
    local cGoal, cPkg, cScore, cPs, cCost, cTie = {}, {}, {}, {}, {}, {}
    local cRank, cMass = {}, {}   -- allocation tier + package mass (terminal tier)
    local n = 0

    for _, goal in ipairs(goals) do
        if not guidanceExcludes(goal, guidance) and goal.kind ~= 'RESERVE' then
            -- Package-independent terms: once per goal, not once per pair.
            local ev = expectedValue(goal, picture, profile, guidance, config)
            local sw = sourceWeight(goal, role, guidance, profile)
            local kind = regionKind(goal, picture)
            local rank = allocationRank(goal)
            local c = commitments[goal.id]

            for _, pkg in ipairs(packages) do
                local locked = pkg.locked or guidance.assetLocks[pkg.id]
                -- Co-commander etiquette: only assign idle/unassigned force,
                -- and never a locked group (§5.1 / §6.2 lock beats idle).
                local touchable = (not locked) and (not role.idleOnly or pkg.idle)
                if touchable then
                    local ps = pSuccess(pkg, goal, picture, profile)
                    local cost = authorityCost(goal, pkg, kind, gov, config)
                    local travel = travelPenalty(pkg, goal, picture, config)
                    -- commitment bonus: sticky if this pkg already serves goal.
                    local bonus = 0
                    if c and c.packageId == pkg.id then
                        local age = picture.frame - (c.sinceFrame or picture.frame)
                        bonus = math.max(0, 1 - age / config.COMMITMENT_DECAY_FRAMES)
                    end
                    n = n + 1
                    cGoal[n], cPkg[n] = goal, pkg
                    cRank[n], cMass[n] = rank, pkg.strength or 0
                    cScore[n] = ev * ps * sw - cost - travel + bonus
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
        if cRank[i] == 1 and cMass[i] ~= cMass[j] then return cMass[i] > cMass[j] end
        if cScore[i] == cScore[j] then return cTie[i] < cTie[j] end
        return cScore[i] > cScore[j]
    end)

    local usedPkg, usedGoal, assignments = {}, {}, {}
    local floor = math.max(config.PSUCCESS_FLOOR, profile.pSuccessFloor or 0)
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
                if existing and existing.packageId ~= pid and cRank[idx] ~= 1 then
                    barOK = cScore[idx] > (existing.score or 0) * config.REASSIGN_BAR
                end
                if barOK then
                    usedPkg[pid], usedGoal[gid] = true, true
                    assignments[#assignments + 1] = {
                        goal = goal, pkg = pkg, score = cScore[idx],
                        ps = cPs[idx], cost = cCost[idx],
                    }
                    commitments[gid] = {
                        packageId = pid, sinceFrame = picture.frame, score = cScore[idx],
                    }
                end
            end
        end
    end
    return assignments, usedPkg
end

--=============================================================================
-- 7. Emit — turn assignments into a directive list the actuator executes,
-- rate-clamped (§8 E6) and paired with an intent report (interaction §6.3).
--=============================================================================
local function emit(assignments, packages, usedPkg, ctx)
    local gov, config = ctx.gov, ctx.config
    local directives, intent = {}, {}
    local perGroupCount = {}
    local spent = 0

    -- Assignments arrive highest-score-first, so budget is spent on the best
    -- goals; DEFEND postures are the always-affordable emergency floor and are
    -- exempt from the budget (plan §8 E2 — DEFEND stays affordable when broke).
    for _, a in ipairs(assignments) do
        local pid = a.pkg.id
        perGroupCount[pid] = (perGroupCount[pid] or 0) + 1
        if perGroupCount[pid] <= config.DIRECTIVE_RATE_CLAMP then     -- §8 E6
            local isPosture = a.goal.kind == 'DEFEND'
            local afford = isPosture or (spent + a.cost) <= gov.budget
            if afford then
                if not isPosture then spent = spent + a.cost end
                directives[#directives + 1] = {
                    type      = isPosture and 'posture' or 'directive',
                    echelon   = a.goal.echelon,
                    directive = a.goal.directive,
                    groupId   = pid,
                    region    = a.goal.region,
                    goalId    = a.goal.id,
                    predictedCost = a.cost,
                    -- Committed force size (the assigned package's aggregate
                    -- strength) → the directive's requestedStrength demand cap
                    -- in the actuator, so one directive can't drain the whole
                    -- idle pool (plan §3.2 demand model).
                    strength  = a.pkg.strength,
                }
                intent[#intent + 1] = {
                    goal = a.goal.id, group = pid, region = a.goal.region,
                    spend = isPosture and 0 or a.cost, kind = a.goal.kind,
                }
            end
        end
    end

    -- Uncommitted surplus → RESERVE (§3.1): packages no goal claimed hold at
    -- the weighted centroid of owned regions. In the skeleton that "hold" is a
    -- no-op (zero-cost, thrash-free) surfaced as an intent line for legibility;
    -- placing them on a real rally point waits on region geometry (AI1).
    local reserved = {}
    for _, pkg in ipairs(packages) do
        if not usedPkg[pkg.id] then
            reserved[#reserved + 1] = pkg.id
            intent[#intent + 1] = { goal = 'reserve', group = pkg.id, spend = 0,
                                    kind = 'RESERVE' }
        end
    end

    return {
        directives = directives, intent = intent, reserved = reserved,
        posturesOnly = gov.posturesOnly, reserve = gov.reserve,
        budget = gov.budget, spent = spent,
    }
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

    decayCommitments(ctx.commitments, picture.frame, ctx.slate, config)

    local packages = buildPackages(picture, ctx.role)
    local gov = governor(picture, config, ctx.role)
    ctx.gov = gov

    local assignments, usedPkg = assign(ctx.slate, packages, ctx)
    return emit(assignments, packages, usedPkg, ctx)
end

--=============================================================================
-- Proposal/demand evaluation (PLAN-metalstorm-interaction.md §6.2 "AI
-- proposal evaluation: expected value of terms vs alternatives ... weighted
-- by the trust ledger and, for demands, by credibility"). PURE — takes the
-- Picture + profile/role, returns a plain decision list; the caller
-- (main.lua) applies it via Actuators:respondProposal (engine ask I1). No
-- Spring/GG/AI access here, same discipline as Planner.plan.
--=============================================================================
local TRUST_VALUE_WEIGHT       = 5    -- authority-equivalent value per trust point
local CEASEFIRE_BASE_VALUE     = 30   -- ceasefires save future order-cost/losses
local DEMAND_CREDIBILITY_FLOOR = 0.55 -- comply when we'd likely lose the fight anyway

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

    if p.kind == 'ceasefire' or p.kind == 'safe_passage' then
        local value = CEASEFIRE_BASE_VALUE + trust * TRUST_VALUE_WEIGHT
                     - (profile.aggression or 1.0) * 20   -- aggressive profiles discount standing down
        return (value >= 0) and 'accept' or 'reject'
    end

    if p.kind == 'tribute' then
        local t = p.terms or {}
        if (t.payer or 'from') == 'from' then return 'accept' end   -- they pay us — pure upside
        -- We'd be the payer: only worth it with healthy trust (buying real
        -- peace) relative to the amount asked.
        local worth = (trust * TRUST_VALUE_WEIGHT) - (t.amount or 0)
        return (worth >= 0) and 'accept' or 'reject'
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

--- Evaluate every pending (offered/countered) proposal addressed to our own
-- team. Returns { {id=, decision='accept'|'reject'}, ... } — main.lua feeds
-- each straight into Actuators:respondProposal(id, decision).
function Planner.evaluateProposals(picture, profile, role)
    local teamId = role and role.teamId
    local out = {}
    for _, p in ipairs((picture.parley or {}).proposals or {}) do
        if p.toTeam == teamId and (p.state == 'offered' or p.state == 'countered') then
            out[#out + 1] = { id = p.id, decision = evaluateOne(p, picture, profile) }
        end
    end
    return out
end

return Planner
