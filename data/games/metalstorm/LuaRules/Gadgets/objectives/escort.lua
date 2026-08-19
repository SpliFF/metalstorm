-- objectives/escort.lua — escort objective type (PLAN-metalstorm-objectives.md
-- §4.3, AS AMENDED by §10.3, 2026-08-19: ESCORT IS NOW TRANSPORT-NATIVE).
--
-- Library module included by game_objectives.lua. Two forms of the same state
-- machine — "keep this moving thing alive until it reaches that circle":
--
--   TRANSPORT (the primary form, §10.3). The payload is a carrier — your own
--   or an ally's — going somewhere that matters to the battle's in/out
--   economy: OUTBOUND to a departure zone (getting value off the field), or
--   INBOUND from an arrival entry to its drop zone (getting a wave down
--   alive). Params: `transportUnitIDs` + `extractArea`.
--
--   CONVOY (the original form, kept). A map that publishes
--   `mapdata/civilians.lua` routes can still escort civilians. Params:
--   `payloadUnitIDs` + `destArea`.
--
-- WHY THE TRANSPORT FORM IS PRIMARY. The convoy form's blocker was never its
-- state machine, it was its subject: convoy routes are the rarest content in
-- the game — 1 of 13 shipped maps publishes them, and that map
-- (`meridian_basin`) is retired (PLAN-metalstorm-wars.md §7.6). So the type
-- was one map away from being dead code. Every battle has transports BY
-- DEFINITION (PLAN-metalstorm-transports.md §7.1: a battle opens when a
-- faction commits a transport to a POI), so the transport form needs no map
-- content at all and is available on all 13 maps. The convoy form stays as
-- optional map flavour; it is no longer the definition of the type, and
-- `world.newConvoys()` staying stubbed no longer costs anything (§10.3).
--
-- ============================================================================
-- ONE NAME FOR THE EXIT: `extractArea` (unification, transports §7.10 /
-- objectives §10.3).
--
-- Three files had grown three names for one idea — the circle on the map you
-- are trying to reach so that what you are carrying leaves the battle safely:
-- transports' §3.4 "departure zone", `extract.lua`'s `extractArea`, and this
-- file's `destArea`. They are the same concept and were drifting apart.
--
-- `extractArea` WINS. Reasons, so a later session can argue rather than guess:
--   * it already ships, with specs, in `extract.lua` — renaming it would churn
--     a working type for no gain, and it is the name the published
--     `objective_<id>_x/z/r` position hint has always been derived from;
--   * it names the FUNCTION (getting something out) rather than the VEHICLE (a
--     "departure" is what a transport does; a civilian convoy also extracts);
--   * `destArea` is too weak to unify on — every objective with a circle has a
--     destination, so the name says nothing about why this circle matters.
--
-- `destArea` therefore survives ONLY as the convoy form's spelling, accepted
-- for compatibility with the scenario content and generator rule that already
-- author it; both normalise to the same internal field. `GG.Transports
-- .ExtractArea(team)` is the gadget-side accessor and returns exactly the
-- zone §3.4 calls the departure zone — same comment lives there.
-- ============================================================================
local escort = {}

local PARTICIPATION_RADIUS = 600

local function centroid(ids, ctx)
    local sx, sz, n = 0, 0, 0
    for _, id in ipairs(ids) do
        local x, _, z = ctx.unitPos(id)
        if x then sx, sz, n = sx + x, sz + z, n + 1 end
    end
    if n == 0 then return nil end
    return sx / n, sz / n
end

local function dist2(x1, z1, x2, z2)
    local dx, dz = x1 - x2, z1 - z2
    return dx * dx + dz * dz
end

--- The one accessor the rest of this file uses. Either spelling is accepted;
--- the transport form's is preferred when both are present (a params table
--- carrying both is authored confusion, and the transport reading is the one
--- that changes the battle's ledger).
local function payloadOf(params)
    return params.transportUnitIDs or params.payloadUnitIDs
end

local function areaOf(params)
    return params.extractArea or params.destArea
end

local function isTransportForm(params)
    return params.transportUnitIDs ~= nil
end

local function validArea(a)
    return type(a) == 'table' and type(a.x) == 'number' and type(a.z) == 'number'
       and type(a.r) == 'number' and a.r > 0
end

function escort.validateParams(params)
    if type(params) ~= 'table' then return false, 'params required' end
    local payload = payloadOf(params)
    if type(payload) ~= 'table' or #payload == 0 then
        return false, 'transportUnitIDs (or payloadUnitIDs) required'
    end
    if not validArea(areaOf(params)) then
        return false, 'extractArea (or destArea) {x,z,r} required'
    end
    local dir = params.direction
    if dir ~= nil and dir ~= 'outbound' and dir ~= 'inbound' then
        return false, "direction must be 'outbound' or 'inbound'"
    end
    return true
end

--- Create-time: at least one payload unit must be alive; quorum defaults to
--- "all surviving, min 1" (§4.3). Captures the start centroid for progress.
---
--- The transport form also captures the team's CURRENT withdrawal count. That
--- baseline is the whole of `departedSinceInit` below — see check().
function escort.init(o, ctx)
    local payload = payloadOf(o.params)
    local aliveCount = 0
    for _, id in ipairs(payload) do
        if ctx.unitAlive(id) then aliveCount = aliveCount + 1 end
    end
    if aliveCount == 0 then return false, 'payload already dead' end

    local sx, sz = centroid(payload, ctx)
    o.data = {
        quorum = o.params.quorum or 1,
        startX = sx, startZ = sz,
        transport = isTransportForm(o.params),
        direction = o.params.direction or 'outbound',
        withdrawnAtInit = nil,
    }
    if o.data.transport and o.forTeam and ctx.withdrawnTransports then
        o.data.withdrawnAtInit = ctx.withdrawnTransports(o.forTeam)
    end
    return true
end

local function countAliveAndArrived(o, ctx)
    local area = areaOf(o.params)
    local alive, arrived = 0, 0
    for _, id in ipairs(payloadOf(o.params)) do
        if ctx.unitAlive(id) then
            alive = alive + 1
            local x, _, z = ctx.unitPos(id)
            if x and dist2(x, z, area.x, area.z) <= area.r * area.r then
                arrived = arrived + 1
            end
        end
    end
    return alive, arrived
end

--- Did one of this side's transports actually LEAVE since this objective was
--- created?
---
--- This is the transport form's subtlety and the reason it is not just the
--- convoy form with a different noun. An outbound escort SUCCEEDS by its
--- payload ceasing to exist: game_transports.lua's departure removes the
--- carrier and its cargo from the sim (`Spring.DestroyUnit(id, false, true)`)
--- the moment it enters the departure zone. Those two subsystems poll on
--- different cadences (transports every 15 frames, objectives every eval
--- tick), so "transport inside the circle" is a window this objective can
--- miss entirely — and if it misses it, `unitAlive` goes false for the last
--- payload and the escort you just WON reads `failed`.
---
--- So the ledger, not the position, is the authority: `ms_withdrawn_<team>
--- _transports` only ever increments through §3.4's departure path, so any
--- increase since init is a departure that happened while this objective was
--- live. The position test stays as the fast path (it completes on the tick
--- the carrier reaches the zone, before it is removed) and for the inbound
--- direction, where nothing is destroyed and there is no ledger to read.
local function departedSinceInit(o, ctx)
    if not o.data.transport or o.data.direction ~= 'outbound' then return false end
    if o.data.withdrawnAtInit == nil or not ctx.withdrawnTransports then return false end
    return ctx.withdrawnTransports(o.forTeam) > o.data.withdrawnAtInit
end

function escort.check(o, ctx)
    local alive, arrived = countAliveAndArrived(o, ctx)
    if arrived >= o.data.quorum then return 'complete', o.forTeam end
    if departedSinceInit(o, ctx) then return 'complete', o.forTeam end
    if alive == 0 then return 'failed' end
    return nil
end

function escort.onUnitDestroyed(o, unitID, attackerTeam, ctx)
    local isPayload = false
    for _, id in ipairs(payloadOf(o.params)) do
        if id == unitID then isPayload = true break end
    end
    if not isPayload then return nil end
    return escort.check(o, ctx)   -- immediate re-evaluation (payload loss → fail)
end

--- Route-covered fraction: distance travelled from the start centroid
--- toward the extract area, relative to the initial distance.
function escort.progress(o, ctx)
    if departedSinceInit(o, ctx) then return 1 end
    local cx, cz = centroid(payloadOf(o.params), ctx)
    if not cx then return o.progress or 0 end
    local area = areaOf(o.params)
    local totalDist = math.sqrt(dist2(o.data.startX, o.data.startZ, area.x, area.z))
    if totalDist <= 0 then return 1 end
    local remaining = math.sqrt(dist2(cx, cz, area.x, area.z))
    return math.max(0, math.min(1, 1 - remaining / totalDist))
end

function escort.participants(o, ctx)
    local cx, cz = centroid(payloadOf(o.params), ctx)
    if not cx then
        -- A departed outbound transport has no position left to scan around,
        -- and its escorts are standing where it vanished — the extract area.
        local area = areaOf(o.params)
        return ctx.unitsInArea(area.x, area.z, PARTICIPATION_RADIUS)
    end
    return ctx.unitsInArea(cx, cz, PARTICIPATION_RADIUS)
end

--- The units this objective is defined in terms of — see kill.lua's
--- unitRefs for why the type module answers this (task 4's DefsReconciled).
function escort.unitRefs(o)
    return payloadOf(o.params)
end

function escort.describe(o)
    if o.data and o.data.transport then
        if o.data.direction == 'inbound' then
            return 'Escort the inbound transport to its drop zone'
        end
        return 'Escort the transport out'
    end
    if isTransportForm(o.params) then return 'Escort the transport out' end
    return 'Escort convoy to destination'
end

return escort
