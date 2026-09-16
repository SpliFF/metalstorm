-- threat.lua — threat / opportunity map over the region graph.  PURE.
--
-- One pass over the Picture that every scoring question then reads instead of
-- re-deriving: "how much enemy is AT or NEXT TO this region", "how much of our
-- own force is there", "is this our front", "which ground is our last". The
-- slate uses it to raise DEFEND / ATTACK / WITHDRAW goals and the planner uses
-- it for pSuccess and the posture floor, so both halves of the brain argue
-- from the same estimate — before this module the slate looked only at
-- NEIGHBOURING intel (a region with the enemy standing IN it and none next
-- door drew no DEFEND) while the planner looked only at the region itself (an
-- assault next to a large enemy stack was priced as a walk-over).
--
-- Fog discipline (plan §2): every number here comes from `picture.intel`
-- (decayed, confidence-weighted memory of what we actually saw, radar blips
-- included) and `picture.ledger` (our own force). Nothing reads the enemy's
-- true state. An enemy estimate is `strength × confidence`, so a three-minute-
-- old sighting is worth what a player would give it — not much, not nothing.
--
-- Threat.build(picture, role, config) -> {
--   regions = { [key] = {
--       enemy      = confidence-weighted enemy strength IN the region,
--       enemyNear  = enemy + SPILL × Σ enemy in adjacent regions,
--       own        = our ledger strength IN the region,
--       ownNear    = own + SPILL × Σ own in adjacent regions,
--       owned      = we own it, held = we have force in it,
--       front      = owned and enemyNear > 0,
--       pressure   = enemyNear / (own + 1)  — >1 means outweighed on the spot,
--       hops       = hops from our nearest held/owned ground (nil = unreachable),
--   } },
--   totals  = { own, enemy, ownedRegions, heldRegions, frontRegions },
--   anchor  = the region the posture floor protects (see anchorRegion),
--   losing  = own / enemy < ratio, with enough enemy seen to mean it,
-- }

local Graph = require('graph')

local Threat = {}

--- Neighbour spill: how much of an adjacent region's force counts toward a
-- region's local balance. Adjacency is one strategic hop (plan §2), so a stack
-- next door is half-present — it can intervene, it is not yet engaged.
Threat.SPILL = 0.5

--- The region whose loss would end us: the posture floor (planner) never
-- strips it of force. Precedence:
--   1. the withdrawal zone's region when the Picture carries one
--      (`picture.transports.departure.region` — your way home);
--   2. else the ONLY region we own, when we own exactly one;
--   3. else nil — with several regions held there is no single "last" one and
--      the floor does not apply.
function Threat.anchorRegion(picture, role)
    local regions = picture.regions or {}
    local teamId = role and role.teamId
    local t = picture.transports
    if t and t.departure and t.departure.region and regions[t.departure.region] then
        return t.departure.region
    end
    local owned, sole = 0, nil
    for key, r in pairs(regions) do
        if r.owner ~= nil and r.owner == teamId then
            owned = owned + 1
            sole = key
        end
    end
    if owned == 1 then return sole end
    return nil
end

function Threat.build(picture, role, config)
    local regions = picture.regions or {}
    local intel   = picture.intel or {}
    local ledger  = picture.ledger or {}
    local teamId  = role and role.teamId
    local spill   = (config and config.THREAT_SPILL) or Threat.SPILL

    local map = {}
    local totals = { own = 0, enemy = 0, ownedRegions = 0, heldRegions = 0, frontRegions = 0 }

    -- Pass 1: local numbers.
    for key, r in pairs(regions) do
        local mem = intel[key]
        local enemy = mem and (mem.strength or 0) * (mem.confidence or 1) or 0
        if enemy < 0 then enemy = 0 end
        local bucket = ledger[key]
        local own = bucket and (bucket.strength or 0) or 0
        local owned = (r.owner ~= nil and r.owner == teamId) or false
        map[key] = {
            enemy = enemy, own = own, owned = owned, held = own > 0,
            enemyNear = enemy, ownNear = own, front = false, pressure = 0,
        }
        totals.own = totals.own + own
        totals.enemy = totals.enemy + enemy
        if owned then totals.ownedRegions = totals.ownedRegions + 1 end
        if own > 0 then totals.heldRegions = totals.heldRegions + 1 end
    end
    -- Force standing outside the graph ('_all' / 'wilds' buckets) still counts
    -- toward the totals — it is real, it just has no region to threaten from.
    for key, bucket in pairs(ledger) do
        if not regions[key] then totals.own = totals.own + (bucket.strength or 0) end
    end
    for key, mem in pairs(intel) do
        if not regions[key] then
            totals.enemy = totals.enemy + (mem.strength or 0) * (mem.confidence or 1)
        end
    end

    -- Pass 2: neighbour spill + derived flags.
    for key, r in pairs(regions) do
        local t = map[key]
        for _, nkey in ipairs(r.neighbors or {}) do
            local n = map[nkey]
            if n then
                t.enemyNear = t.enemyNear + spill * n.enemy
                t.ownNear   = t.ownNear + spill * n.own
            end
        end
        t.front    = t.owned and t.enemyNear > 0
        t.pressure = t.enemyNear / (t.own + 1)
        if t.front then totals.frontRegions = totals.frontRegions + 1 end
    end

    -- Pass 3: hops from our ground (held or owned) — how far a region is from
    -- anything we can answer with. Unreachable regions stay nil.
    local ours = {}
    for key, t in pairs(map) do
        if t.held or t.owned then ours[key] = true end
    end
    if next(ours) ~= nil then
        local dist = Graph.hops(regions, ours)
        for key, t in pairs(map) do t.hops = dist[key] end
    end

    local ratio = nil
    if totals.enemy > 0 then ratio = totals.own / totals.enemy end

    return {
        regions = map,
        totals  = totals,
        ratio   = ratio,           -- nil = no enemy seen anywhere
        anchor  = Threat.anchorRegion(picture, role),
    }
end

--- Is the war going badly enough to leave? `withdrawRatio` is a profile knob
-- (own/enemy AT OR below it = losing — `<=`, not `<`: a profile's
-- withdrawRatio names the point at which it leaves, e.g. the default 0.5
-- reads as "outmatched two to one", and a side sitting at EXACTLY that ratio
-- is exactly the outmatched case the knob describes, not a fight it still
-- holds by a hair. Before this a textbook 2-for-1 overrun (3 own vs 6 enemy,
-- ratio == 0.5 == the default profile's own withdrawRatio) fell just short of
-- the strict `<` and the goal never fired — the AI kept assaulting out while
-- its home ground was lost under it). Requires a REAL enemy estimate: at
-- least config.WITHDRAW_MIN_ENEMY of confidence-weighted strength seen, so a
-- single decayed blip never sends an army home. Also refuses while we are
-- banking the terminal objective ourselves (`holdingPrize`): the hold clock
-- is the war and leaving would hand it over.
function Threat.losing(threat, withdrawRatio, config, holdingPrize)
    if holdingPrize then return false end
    if not threat or threat.ratio == nil then return false end
    local minEnemy = (config and config.WITHDRAW_MIN_ENEMY) or 1
    if threat.totals.enemy < minEnemy then return false end
    return threat.ratio <= (withdrawRatio or 0)
end

--- Local balance for an attack on `key` by a package of `ownStrength`:
-- Lanchester-square proxy own² / (own² + enemyNear²), where enemyNear counts
-- the neighbours' spill. Same shape planner.lua's pSuccess always had, on the
-- better estimate. Returns nil when nothing is known about the region (the
-- caller applies its no-intel prior).
function Threat.pSuccessAt(threat, key, ownStrength)
    local t = threat and key and threat.regions[key]
    if not t or t.enemyNear <= 0 then return nil end
    local e = t.enemyNear
    local denom = ownStrength * ownStrength + e * e
    if denom <= 0 then return 0.5 end
    return (ownStrength * ownStrength) / denom
end

return Threat
