-- garrison/brain.lua — the decision core.  PURE: Picture + profile + state → orders.
--
-- No engine access, no side effects beyond `state` (the AI's cross-tick
-- memory, passed in). That is what lets the whole brain be spec'd against
-- hand-built Pictures and evaluated by tools/ai-eval without an engine.
--
-- An ORDER is the smallest thing the garrison decides:
--   { kind, region?, anchor?, directive, priority, force?, reason, goalId? }
--     kind       HOLD | DEFEND | DEFEND_FRONT | SCREEN | WITHDRAW | OBJECTIVE
--     directive  a lib/directives Type value (always area-shaped — the floor)
--     force      true ⇒ the always-affordable DEFEND floor (bypasses budget)
--
-- Doctrine (profile-tuned, see profiles/):
--   1. WITHDRAW  enemy inside a home region outmasses us by withdrawRatio →
--                fall back through the departure zone (unless neverWithdraw);
--                sticky for withdrawHoldFrames so a mauled garrison doesn't
--                bounce back into the fight next tick.
--   2. DEFEND_FRONT contested home ground, or enemy inside it → hold the line.
--   3. DEFEND    enemy next door → brace (priority just below the front).
--   4. OBJECTIVE a cheap, active, eligible objective in/next to home →
--                take it (protect/infra: Defend; control/kill: Assault).
--   5. SCREEN    a neighbour whose intel is stale, when idle force exists →
--                look (one per tick, rate-limited).
--   6. HOLD      quiet home ground → a low-priority Defend, re-stated only
--                when the previous one is half-expired (2 authority each —
--                the garrison does not pay every tick to stand still).

local Regions    = require('lib.regions')
local Directives = require('lib.directives')

local Brain = {}

Brain.DEFAULTS = {
    withdrawRatio       = 1.6,    -- enemy/own strength that triggers a withdrawal
    neverWithdraw       = false,
    withdrawHoldFrames  = 1800,   -- ~1 min sticky
    screenMinIdle       = 2,      -- idle units at home before we scout
    screenEveryFrames   = 900,    -- ≥ 30 s between screens of the same region
    objectiveMinReward  = 50,
    objectiveMaxCost    = 4,      -- "cheap": at most this much authority (preview)
    holdRestateFraction = 0.5,    -- re-state HOLD when this much of its ttl has passed
    reserveFraction     = 0.25,   -- keep back for emergencies
    teamFallback        = false,  -- may the garrison spend the team pool?
    lodFloor            = 0,
    lodCeil             = 3,
}

--- Merge profile over defaults (profile keys win).
function Brain.settings(profile)
    local s = {}
    for k, v in pairs(Brain.DEFAULTS) do s[k] = v end
    for k, v in pairs(profile or {}) do s[k] = v end
    return s
end

--- Fresh cross-tick memory.
function Brain.newState()
    return { home = nil, withdrawnAt = {}, lastHold = {}, lastScreen = {}, ticks = 0 }
end

--- Home regions: scenario `ai_slate_home` first, else everything we own, else
-- wherever our force stands. Re-derived until non-empty, then pinned — a
-- garrison does not follow its ground around.
function Brain.resolveHome(picture, state)
    if state.home and next(state.home) then return state.home end
    local home = {}
    local script = picture.script
    if script and script.home and picture.regions[script.home] then
        home[script.home] = true
    else
        home = Regions.ownedBy(picture.regions, picture.teamId)
        if next(home) == nil then
            for key in pairs(picture.ledger or {}) do
                if picture.regions[key] then home[key] = true end
            end
        end
    end
    if next(home) then state.home = home end
    return home
end

--- Where "through the departure zone" is: the published zone (P7) if any,
-- else the nearest map edge to the home centroid (the transports gadget's
-- own default when a side declares none).
function Brain.departureAnchor(picture, homeKey)
    if picture.departure then
        return { x = picture.departure.x, z = picture.departure.z,
                 radius = picture.departure.radius or 700 }
    end
    local r = picture.regions[homeKey]
    local cx, cz = Regions.anchor(r)
    if not cx then return nil end
    local ex, ez = Regions.nearestEdgePoint(cx, cz, picture.mapWidth, picture.mapHeight)
    return { x = ex, z = ez, radius = 700 }
end

--- Spendable authority this tick (pool minus reserve, own pool ± team).
function Brain.budget(picture, s)
    local econ = picture.economy or {}
    local pool = (econ.ownPool or 0) + (s.teamFallback and (econ.teamPool or 0) or 0)
    return math.max(0, pool - math.ceil(pool * s.reserveFraction)), pool
end

local function intelStale(picture, key)
    local m = picture.intel[key]
    return m == nil or (m.confidence or 0) < 0.5
end

--- The decision. `ctx` = { budget = per-tick authority, ttl = frames a
-- directive issued now will live, costOf = fn(scope) → preview }.
function Brain.decide(picture, profile, state, ctx)
    local s = Brain.settings(profile)
    ctx = ctx or {}
    local frame = picture.frame or 0
    local ttl = ctx.ttl or Directives.DEFAULT_TTL_FRAMES
    local areaCost = ctx.costOf and ctx.costOf('area') or 2
    local budget = ctx.budget or math.huge
    local orders, notes = {}, {}
    state.ticks = (state.ticks or 0) + 1

    local home = Brain.resolveHome(picture, state)
    if next(home) == nil then
        notes[#notes + 1] = 'no home ground'
        return { orders = orders, notes = notes, home = home }
    end

    local regions, ledger, threat = picture.regions, picture.ledger or {}, picture.threat or {}
    local claimed = {}     -- region → true once an order targets it this tick
    local spent = 0

    local function emit(o)
        orders[#orders + 1] = o
        if o.region then claimed[o.region] = true end
        if not o.force then spent = spent + areaCost end
    end

    -- 1..3 + 6: per home region, by severity.
    local keys = {}
    for key in pairs(home) do keys[#keys + 1] = key end
    table.sort(keys)
    for _, key in ipairs(keys) do
        local r = regions[key]
        local t = threat[key] or { inside = 0, adjacent = 0 }
        local own = (ledger[key] and ledger[key].strength) or 0
        local withdrawnAt = state.withdrawnAt[key]
        local stillWithdrawn = withdrawnAt and (frame - withdrawnAt) < s.withdrawHoldFrames

        local outmatched = own > 0 and t.inside > own * s.withdrawRatio
        if not s.neverWithdraw and (outmatched or stillWithdrawn) then
            if outmatched then state.withdrawnAt[key] = frame end
            local anchor = Brain.departureAnchor(picture, key)
            if anchor then
                emit({ kind = 'WITHDRAW', region = key, anchor = anchor,
                       directive = Directives.Type.Withdraw, priority = 255,
                       reason = string.format('outmatched %.1f vs %.1f', t.inside, own) })
            end
        elseif r and (r.contested or t.inside > 0) then
            state.withdrawnAt[key] = nil
            emit({ kind = 'DEFEND_FRONT', region = key, directive = Directives.Type.DefendFront,
                   priority = 250, force = true, reason = r.contested and 'contested' or 'enemy inside' })
        elseif t.adjacent > 0 then
            state.withdrawnAt[key] = nil
            emit({ kind = 'DEFEND', region = key, directive = Directives.Type.Defend,
                   priority = 200, force = true, reason = 'enemy adjacent' })
        else
            state.withdrawnAt[key] = nil
            local last = state.lastHold[key]
            if last == nil or (frame - last) >= ttl * s.holdRestateFraction then
                state.lastHold[key] = frame
                emit({ kind = 'HOLD', region = key, directive = Directives.Type.Defend,
                       priority = 100, force = true, reason = 'hold' })
            end
        end
    end

    -- 4. cheap objectives in / next to home.
    local near = {}
    for key in pairs(home) do
        near[key] = true
        for _, n in ipairs(Regions.neighbors(regions, key)) do near[n] = true end
    end
    local ids = {}
    for id in pairs(picture.board or {}) do ids[#ids + 1] = id end
    table.sort(ids)
    for _, id in ipairs(ids) do
        local o = picture.board[id]
        local eligible = o.state == 'active'
            and (o.team == nil or o.team == -1 or o.team == picture.teamId)
            and o.region and near[o.region] and not claimed[o.region]
            and (o.reward or 0) >= s.objectiveMinReward
        if eligible and areaCost <= s.objectiveMaxCost and (spent + areaCost) <= budget then
            local dt = (o.type == 'protect' or o.type == 'infra') and Directives.Type.Defend
                    or Directives.Type.Assault
            emit({ kind = 'OBJECTIVE', region = o.region, directive = dt, priority = 180,
                   goalId = 'obj:' .. tostring(id), reason = tostring(o.type) .. ' objective' })
        end
    end

    -- 5. one screen per tick, when we have idle force and stale neighbours.
    local idle = 0
    for key in pairs(home) do idle = idle + ((ledger[key] and ledger[key].idle) or 0) end
    if idle >= s.screenMinIdle then
        local candidates = {}
        for key in pairs(home) do
            for _, n in ipairs(Regions.neighbors(regions, key)) do
                if not home[n] and not claimed[n] and intelStale(picture, n) then
                    local last = state.lastScreen[n]
                    if last == nil or (frame - last) >= s.screenEveryFrames then
                        candidates[#candidates + 1] = n
                    end
                end
            end
        end
        table.sort(candidates)
        if #candidates > 0 and (spent + areaCost) <= budget then
            state.lastScreen[candidates[1]] = frame
            emit({ kind = 'SCREEN', region = candidates[1], directive = Directives.Type.Screen,
                   priority = 120, reason = 'stale intel' })
        end
    end

    return { orders = orders, notes = notes, home = home, spentPreview = spent, idle = idle }
end

return Brain
