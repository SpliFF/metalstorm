-- lib/directives.lua — directive builders.  PURE.
--
-- Produces the numeric spec table `AI.issueDirective(handle, spec)` marshals
-- (AIScriptContext::l_issueDirective): { type, priority, shape, params,
-- requestedStrength, expiresInFrames, within }. Everything here is AREA or
-- behaviour shaped — there is no builder that takes a unit id, because the
-- engine surface has no such directive and the design law forbids it.
--
-- Enums mirror rts/Server/OrgGroups.h 1:1 (the numeric wire).

local Regions = require('lib.regions')

local D = {}

D.Type = {
    DefendArea = 0, PatrolRoute = 1, RallyPoint = 2, Fallback = 3,
    Reinforce = 4, Screen = 5, SupplyRoute = 6, BuildBase = 7,
    MoveFormation = 8, Assault = 9, Defend = 10, Overwatch = 11,
    Withdraw = 12, Escort = 13, DefendFront = 14,
}
D.Shape   = { Point = 0, Circle = 1, Polygon = 2, Polyline = 3 }
D.Echelon = { Squad = 0, Platoon = 1, Army = 2 }

local NAME_OF = {}
for name, v in pairs(D.Type) do NAME_OF[v] = name end

--- Human name for a DirectiveType value (reports, narration).
function D.name(t) return NAME_OF[t] or ('type' .. tostring(t)) end

--- Default lifetime when a builder is given none. NEVER 0 (0 = immortal —
-- a plan re-stated every tick then accumulates one live directive per goal
-- per tick forever, endtoend D68). 450 = 3 × the 150-frame LOD-0 tick.
D.DEFAULT_TTL_FRAMES = 450

--- The E6 rate clamp's area key: the drain quantises an area directive's
-- anchor to 256-elmo cells, and a second directive in the same cell from the
-- same team in one batch is DROPPED (StateStreamer::ApplyAICommands). Callers
-- (lib/actuator.lua) use this to refuse locally rather than waste a push.
function D.clampKey(spec)
    local p = spec and spec.params
    if type(p) ~= 'table' or #p < 3 then return 'area' end
    local qx = math.floor(p[1] / 256 + 0.5)
    local qz = math.floor(p[3] / 256 + 0.5)
    return qx .. ':' .. qz
end

--- Core builder. opts:
--   type              DirectiveType value (required)
--   region            a region table (from lib/regions) → Circle at its anchor
--   anchor            { x, z, radius } → Circle (radius optional → Point)
--   priority          0..255 (default 128)
--   requestedStrength demand cap in ABSOLUTE HITPOINTS (0 = take what idles)
--   ttl               expiresInFrames (default D.DEFAULT_TTL_FRAMES)
--   within            true → draw only squads already inside the target circle
-- Returns the spec, or nil (+ reason) when there is no geometry to place it.
function D.build(opts)
    if type(opts) ~= 'table' or type(opts.type) ~= 'number' then
        return nil, 'no directive type'
    end
    local cx, cz, r
    if opts.region then
        cx, cz, r = Regions.anchor(opts.region)
        if not cx then return nil, 'region has no polygon' end
    elseif opts.anchor then
        cx, cz, r = opts.anchor.x, opts.anchor.z, opts.anchor.radius
        if cx == nil or cz == nil then return nil, 'anchor has no position' end
    else
        return nil, 'no region or anchor'
    end
    local spec = {
        type              = opts.type,
        priority          = math.max(0, math.min(255, math.floor(opts.priority or 128))),
        shape             = r and D.Shape.Circle or D.Shape.Point,
        params            = r and { cx, 0, cz, r } or { cx, 0, cz },
        requestedStrength = math.max(0, math.floor(opts.requestedStrength or 0)),
        expiresInFrames   = math.max(1, math.floor(opts.ttl or D.DEFAULT_TTL_FRAMES)),
    }
    if opts.within and r then
        spec.within = { x = cx, z = cz, radius = r }
    end
    return spec
end

local function make(t)
    return function(regionOrAnchor, opts)
        local o = {}
        for k, v in pairs(opts or {}) do o[k] = v end
        o.type = t
        if regionOrAnchor and regionOrAnchor.polygon then o.region = regionOrAnchor
        else o.anchor = regionOrAnchor end
        return D.build(o)
    end
end

-- Named builders: each takes (region | {x,z,radius}, opts).
D.defend      = make(D.Type.Defend)
D.defendArea  = make(D.Type.DefendArea)
D.defendFront = make(D.Type.DefendFront)
D.screen      = make(D.Type.Screen)
D.overwatch   = make(D.Type.Overwatch)
D.assault     = make(D.Type.Assault)
D.rally       = make(D.Type.RallyPoint)
D.withdraw    = make(D.Type.Withdraw)
D.fallback    = make(D.Type.Fallback)
D.escort      = make(D.Type.Escort)
D.reinforce   = make(D.Type.Reinforce)

--- Region key a spec's anchor falls in (for reports / eval), or nil.
function D.regionOf(spec, regions)
    local p = spec and spec.params
    if type(p) ~= 'table' or #p < 3 then return nil end
    return Regions.regionOf(p[1], p[3], regions)
end

--- Posture bundle helper: the engine stores the JSON string opaquely
-- (OrgGroupManager::SetPosture). Fields mirror PLAN-macro-orders' posture:
-- engagement ('hold'|'return_fire'|'free'), casualty ('none'|'moderate'|
-- 'heavy'), reinforce (bool), roe (string). Encoded by hand (the VM has no
-- JSON library) — strings are escaped minimally.
function D.postureJson(p)
    local parts = {}
    local keys = {}
    for k in pairs(p or {}) do keys[#keys + 1] = k end
    table.sort(keys)
    for _, k in ipairs(keys) do
        local v = p[k]
        local enc
        if type(v) == 'boolean' or type(v) == 'number' then enc = tostring(v)
        else enc = '"' .. tostring(v):gsub('[\\"]', '\\%0') .. '"' end
        parts[#parts + 1] = '"' .. k .. '":' .. enc
    end
    return '{' .. table.concat(parts, ',') .. '}'
end

return D
