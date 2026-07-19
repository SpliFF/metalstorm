-- game_regions.lua — map region control (PLAN-metalstorm.md §4, §10.2). STUB.
--
-- v0 model: a fixed region GRID (until maps author named district graphs).
-- Region control feeds: order costs (orders are cheaper in friendly regions),
-- systemic control objectives, and the strategic-map overlay
-- (shaders/region-overlay.frag.glsl + PLAN-macro-map.md heatmaps).
--
-- Control is published to rulesParams (region_<x>_<z>_team) for client reads.

function gadget:GetInfo()
    return {
        name    = "Region Control",
        desc    = "Region grid, team control, order-cost modifiers",
        author  = "metalstorm",
        date    = "2026",
        license = "GPL v2",
        layer   = -90,
        enabled = true,
    }
end

if not gadgetHandler:IsSyncedCode() then
    return false
end

GG.Regions = GG.Regions or {}

local REGION_SIZE = 2048           -- elmos; ~16 regions on an 8k map axis
local EVAL_PERIOD = 150            -- frames (5 s)

-- Cost modifiers (PLAN-metalstorm.md §4): friendly cheap, enemy expensive.
local MOD_FRIENDLY = 0.5
local MOD_NEUTRAL  = 1.0
local MOD_ENEMY    = 2.0

local control = {}                 -- "x:z" → controlling teamID or nil

local function keyAt(x, z)
    return math.floor(x / REGION_SIZE) .. ':' .. math.floor(z / REGION_SIZE)
end

function GG.Regions.ControllingTeam(key)
    return control[key]
end

--- Order-cost modifier for the region a unit stands in.
function GG.Regions.CostModifierAt(unitID)
    local x, _, z = Spring.GetUnitPosition(unitID)
    if not x then return MOD_NEUTRAL end
    local team = control[keyAt(x, z)]
    if team == nil then return MOD_NEUTRAL end
    local unitTeam = Spring.GetUnitTeam(unitID)
    if not unitTeam then return MOD_NEUTRAL end
    if Spring.AreTeamsAllied(team, unitTeam) then return MOD_FRIENDLY end
    return MOD_ENEMY
end

--- The grid key for a world position — the same addressing scheme every
--- other GG.Regions entry point uses. Exported so callers that need to
--- preset/query ownership from a position (scenario loader, GM tools) don't
--- have to reimplement the grid math.
function GG.Regions.KeyAt(x, z)
    return keyAt(x, z)
end

--- Explicit ownership override (scenario preset at GameStart, GM tools).
--- teamID = nil clears to uncontrolled; the periodic evaluator (GameFrame)
--- may still flip a key on its next EVAL_PERIOD tick once units are present
--- — this only seeds the starting state, it doesn't freeze it.
function GG.Regions.SetControllingTeam(key, teamID)
    control[key] = teamID
    Spring.SetGameRulesParam('region_' .. key .. '_team', teamID or -1)
end

function gadget:GameFrame(frame)
    if frame % EVAL_PERIOD ~= 0 then return end
    -- STUB control evaluation: region goes to the team with the most
    -- aggregate unit strength inside it (civilians excluded). TODO: presence
    -- duration / structures should weigh more than passing armies; hysteresis
    -- so fronts don't flicker.
    local strength = {}            -- key → team → hp
    for _, unitID in ipairs(Spring.GetAllUnits()) do
        local team = Spring.GetUnitTeam(unitID)
        if team and team ~= Spring.GetGaiaTeamID() then
            local x, _, z = Spring.GetUnitPosition(unitID)
            local hp = Spring.GetUnitHealth(unitID)
            if x and hp then
                local k = keyAt(x, z)
                strength[k] = strength[k] or {}
                strength[k][team] = (strength[k][team] or 0) + hp
            end
        end
    end
    for k, byTeam in pairs(strength) do
        local best, bestHp = nil, 0
        for team, hp in pairs(byTeam) do
            if hp > bestHp then best, bestHp = team, hp end
        end
        if best ~= control[k] then
            control[k] = best
            Spring.SetGameRulesParam('region_' .. k .. '_team', best or -1)
            -- TODO notify game_objectives (contested → control objective).
        end
    end
end
