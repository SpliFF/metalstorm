-- game_authority.lua — the authority economy (PLAN-metalstorm.md §4). STUB.
--
-- One resource: authority. Earned by completing objectives
-- (game_objectives.lua calls GG.Authority.Award), spent by issuing orders.
-- Spring's metal/energy plumbing is unused.
--
-- TEAM OWNERSHIP MODEL (PLAN-metalstorm.md §2): units belong to the TEAM;
-- any team player commands any team unit. Order costs charge the issuing
-- PLAYER's pool (self-organising command allocation), falling back to the
-- team pool.
--
-- Dynamic cost model (stub): cost = base(unit strength & scale)
--   × region modifier (cheap in friendly-controlled regions — game_regions)
--   × order-type modifier (macro directives amortise; micro spam doesn't)
--   × modoption authority_cost_scale.

function gadget:GetInfo()
    return {
        name    = "Authority Economy",
        desc    = "Single-resource economy: earn via objectives, spend on orders",
        author  = "metalstorm",
        date    = "2026",
        license = "GPL v2",
        layer   = -100,            -- before objectives/regions
        enabled = true,
    }
end

if not gadgetHandler:IsSyncedCode() then
    return false
end

local STARTING_PLAYER_AUTHORITY = 100
local STARTING_TEAM_AUTHORITY   = 500

local costScale = 1.0

GG.Authority = GG.Authority or {}

-- Pools live in rulesParams so every context (client UI included) can read
-- them: team pool on team rulesParams, player pools keyed by playerID.
local function setTeamPool(teamID, v)
    Spring.SetTeamRulesParam(teamID, 'authority_pool', v)
end
local function getTeamPool(teamID)
    return Spring.GetTeamRulesParam(teamID, 'authority_pool') or 0
end
local function setPlayerPool(playerID, v)
    Spring.SetGameRulesParam('authority_player_' .. playerID, v)
end
local function getPlayerPool(playerID)
    return Spring.GetGameRulesParam('authority_player_' .. playerID) or 0
end

--- Award authority. target = { player = id } | { team = id }.
function GG.Authority.Award(target, amount, reason)
    if target.player then
        setPlayerPool(target.player, getPlayerPool(target.player) + amount)
    elseif target.team then
        setTeamPool(target.team, getTeamPool(target.team) + amount)
    end
    -- TODO: emit an event for the UI feed (objectives panel / toasts).
end

--- Order cost (stub formula — PLAN-metalstorm.md §10.1 tuning).
function GG.Authority.OrderCost(unitID, cmdID)
    local udid = Spring.GetUnitDefID(unitID)
    local ud = udid and UnitDefs[udid]
    local base = 1
    if ud and ud.customParams and ud.customParams.authority_cost_base then
        base = tonumber(ud.customParams.authority_cost_base) or 1
    end
    local region = (GG.Regions and GG.Regions.CostModifierAt)
        and GG.Regions.CostModifierAt(unitID) or 1.0
    -- TODO order-type modifier (macro directive vs micro order) once the
    -- directive API exists (PLAN-macro-orders.md §5/§6).
    return base * region * costScale
end

--- The spend gate. Direct player commands route through AllowCommand.
-- STUB: charges the team pool (per-player attribution needs the
-- order→player identity, an engine ask tracked in PLAN-metalstorm.md §10.5).
function gadget:AllowCommand(unitID, unitDefID, unitTeam, cmdID, cmdParams, cmdOptions)
    if costScale <= 0 then return true end
    local cost = GG.Authority.OrderCost(unitID, cmdID)
    local pool = getTeamPool(unitTeam)
    if pool < cost then
        return false                       -- out of authority: order refused
    end
    setTeamPool(unitTeam, pool - cost)
    return true
end

function gadget:GameStart()
    costScale = tonumber(Spring.GetModOptions().authority_cost_scale) or 1.0
    local gaia = Spring.GetGaiaTeamID()
    for _, teamID in ipairs(Spring.GetTeamList()) do
        if teamID ~= gaia then
            setTeamPool(teamID, STARTING_TEAM_AUTHORITY)
        end
    end
    for _, playerID in ipairs(Spring.GetPlayerList()) do
        setPlayerPool(playerID, STARTING_PLAYER_AUTHORITY)
    end
end

-- Drop-in players (PLAN-metalstorm.md §2, §10.6): grant a starter pool.
function gadget:PlayerAdded(playerID)
    if getPlayerPool(playerID) == 0 then
        setPlayerPool(playerID, STARTING_PLAYER_AUTHORITY)
    end
end

-- Departing players: pool returns to the team (units already belong to it).
function gadget:PlayerRemoved(playerID, reason)
    local _, _, _, teamID = Spring.GetPlayerInfo(playerID)
    if teamID then
        setTeamPool(teamID, getTeamPool(teamID) + getPlayerPool(playerID))
    end
    setPlayerPool(playerID, 0)
end
