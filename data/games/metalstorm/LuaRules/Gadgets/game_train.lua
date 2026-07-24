-- game_train.lua — Metalstorm land-train coupling and consist management.
--
-- DIVERGENCE FROM STANDARD SPRING: Trains are NOT a Recoil/Spring concept.
-- This is a deliberate custom Metalstorm game system built entirely from
-- Recoil-native Lua primitives with zero new C++ engine code. See
-- PLAN-metalstorm-train.md for design rationale.
--
-- T1 SCOPE: Coupling foundation only (no movement yet).
-- - Consist data model: ordered unit list, leader id, per-gap coupling length
-- - Couple/Decouple custom commands with composition rules
-- - Leader election (engine in current direction of travel)
-- - Rebuild consist state on couple/decouple/UnitDestroyed

function gadget:GetInfo()
    return {
        name    = "Trains",
        desc    = "Land train coupling, consist management, and kinematics",
        author  = "metalstorm",
        date    = "2026",
        license = "GPL v2",
        layer   = -50,  -- runs before most gadgets
        enabled = true,
    }
end

if not gadgetHandler:IsSyncedCode() then
    return false
end

--------------------------------------------------------------------------------
-- Constants
--------------------------------------------------------------------------------

-- Custom command IDs (negative to not collide with Spring built-ins)
local CMD_COUPLE   = 35001
local CMD_DECOUPLE = 35002

-- Train role types from customParams.train_role
local ROLE_ENGINE = "engine"
local ROLE_GUN    = "gun"
local ROLE_TROOP  = "troop"
local ROLE_CARGO  = "cargo"

-- Composition rules
local MAX_CARS_PER_ENGINE = 3  -- max 3 cars per engine

-- Default gap between couplers when coupled (meters)
local DEFAULT_COUPLING_GAP = 1.0

--------------------------------------------------------------------------------
-- State
--------------------------------------------------------------------------------

-- Main consist storage: consistsByUnit[unitID] = consistID
local consistsByUnit = {}

-- Consists: consists[consistID] = consist data
local consists = {}
local nextConsistID = 1

-- Unit def caching for train units
local trainDefs = {}  -- defID -> {role, linkF, linkR, halfLength}

--------------------------------------------------------------------------------
-- Consist data structure
--------------------------------------------------------------------------------
--[[
    consist = {
        id = number,
        units = {unitID, ...},        -- ordered list front to back
        leader = unitID,               -- current leader (engine driving)
        engineCount = number,          -- number of engines in consist
        carCount = number,             -- number of non-engine cars
        couplingLengths = {number...}, -- gap i = distance between units[i] and units[i+1]
        aggregateHP = number,          -- sum of current HP of all units
        aggregateMaxHP = number,       -- sum of max HP of all units
    }
]]

--------------------------------------------------------------------------------
-- Helper functions
--------------------------------------------------------------------------------

local function GetTrainDef(unitDefID)
    if trainDefs[unitDefID] then
        return trainDefs[unitDefID]
    end

    local def = UnitDefs[unitDefID]
    if not def then return nil end

    local cp = def.customParams
    if not cp or not cp.couple_links or not cp.train_role then
        return nil  -- not a train unit
    end

    -- Parse couple_links to find link pieces
    local linkF, linkR
    for link in string.gmatch(cp.couple_links, "[^,]+") do
        link = link:match("^%s*(.-)%s*$")  -- trim
        if link == "link_f" then
            linkF = true
        elseif link == "link_r" then
            linkR = true
        end
    end

    -- Calculate half-length from piece positions (placeholder for now)
    -- TODO: Get actual piece z-offsets once piece API is available
    -- For now, use approximations based on unit footprints
    local halfLength
    if cp.train_role == ROLE_ENGINE then
        halfLength = 11.2  -- from plan: engine link_f/link_r at z ±11.2
    else
        halfLength = 8.7   -- from plan: carriages at z ±8.7
    end

    trainDefs[unitDefID] = {
        role = cp.train_role,
        linkF = linkF,
        linkR = linkR,
        halfLength = halfLength
    }

    return trainDefs[unitDefID]
end

local function IsEngine(unitID)
    local unitDefID = Spring.GetUnitDefID(unitID)
    if not unitDefID then return false end
    local def = GetTrainDef(unitDefID)
    return def and def.role == ROLE_ENGINE
end

local function CreateConsist(unitID)
    local consist = {
        id = nextConsistID,
        units = {unitID},
        leader = IsEngine(unitID) and unitID or nil,
        engineCount = IsEngine(unitID) and 1 or 0,
        carCount = IsEngine(unitID) and 0 or 1,
        couplingLengths = {},
        aggregateHP = 0,
        aggregateMaxHP = 0
    }
    nextConsistID = nextConsistID + 1

    consists[consist.id] = consist
    consistsByUnit[unitID] = consist.id

    UpdateConsistHP(consist)
    UpdateConsistParams(consist)

    return consist
end

local function UpdateConsistHP(consist)
    local totalHP = 0
    local totalMaxHP = 0

    for _, unitID in ipairs(consist.units) do
        local hp, maxHP = Spring.GetUnitHealth(unitID)
        if hp then  -- unit still alive
            totalHP = totalHP + hp
            totalMaxHP = totalMaxHP + maxHP
        end
    end

    consist.aggregateHP = totalHP
    consist.aggregateMaxHP = totalMaxHP
end

local function ElectLeader(consist)
    -- Find first live engine (from front or back depending on direction)
    -- For T1, just pick first live engine from front
    consist.leader = nil

    for _, unitID in ipairs(consist.units) do
        if IsEngine(unitID) and Spring.GetUnitIsDead(unitID) == false then
            consist.leader = unitID
            return
        end
    end
end

local function CalculateCouplingLength(unitA, unitB)
    -- Calculate distance between two adjacent units in consist
    -- halfLength(A) + gap + halfLength(B)

    local defA = GetTrainDef(Spring.GetUnitDefID(unitA))
    local defB = GetTrainDef(Spring.GetUnitDefID(unitB))

    if not defA or not defB then
        return nil
    end

    return defA.halfLength + DEFAULT_COUPLING_GAP + defB.halfLength
end

local function RebuildCouplingLengths(consist)
    consist.couplingLengths = {}

    for i = 1, #consist.units - 1 do
        local length = CalculateCouplingLength(consist.units[i], consist.units[i+1])
        if length then
            consist.couplingLengths[i] = length
        end
    end
end

local function UpdateConsistParams(consist)
    -- Expose consist structure to client via unit rules params
    for i, unitID in ipairs(consist.units) do
        Spring.SetUnitRulesParam(unitID, "train_consist_id", consist.id)
        Spring.SetUnitRulesParam(unitID, "train_consist_position", i)
        Spring.SetUnitRulesParam(unitID, "train_consist_size", #consist.units)
        Spring.SetUnitRulesParam(unitID, "train_is_leader", unitID == consist.leader and 1 or 0)
        Spring.SetUnitRulesParam(unitID, "train_aggregate_hp", consist.aggregateHP)
        Spring.SetUnitRulesParam(unitID, "train_aggregate_max_hp", consist.aggregateMaxHP)
    end
end

local function CanCouple(unitA, unitB)
    -- Check if two units can couple

    local defA = GetTrainDef(Spring.GetUnitDefID(unitA))
    local defB = GetTrainDef(Spring.GetUnitDefID(unitB))

    if not defA or not defB then
        return false, "Not train units"
    end

    -- Check composition rules
    local consistA = consistsByUnit[unitA] and consists[consistsByUnit[unitA]]
    local consistB = consistsByUnit[unitB] and consists[consistsByUnit[unitB]]

    -- If coupling two consists, check combined size
    local totalEngines = 0
    local totalCars = 0

    if consistA then
        totalEngines = totalEngines + consistA.engineCount
        totalCars = totalCars + consistA.carCount
    else
        if IsEngine(unitA) then
            totalEngines = totalEngines + 1
        else
            totalCars = totalCars + 1
        end
    end

    if consistB then
        totalEngines = totalEngines + consistB.engineCount
        totalCars = totalCars + consistB.carCount
    else
        if IsEngine(unitB) then
            totalEngines = totalEngines + 1
        else
            totalCars = totalCars + 1
        end
    end

    -- Check max cars per engine rule
    if totalEngines == 0 then
        return false, "No engine in consist"
    end

    if totalCars > MAX_CARS_PER_ENGINE * totalEngines then
        return false, string.format("Too many cars (%d) for %d engine(s) (max %d per engine)",
            totalCars, totalEngines, MAX_CARS_PER_ENGINE)
    end

    -- Check distance (must be within coupling range)
    local x1, _, z1 = Spring.GetUnitPosition(unitA)
    local x2, _, z2 = Spring.GetUnitPosition(unitB)
    local dist = math.sqrt((x2-x1)^2 + (z2-z1)^2)

    local maxCoupleDistance = (defA.halfLength + defB.halfLength + DEFAULT_COUPLING_GAP) * 1.5
    if dist > maxCoupleDistance then
        return false, "Units too far apart"
    end

    return true
end

local function CoupleUnits(unitA, unitB)
    -- Couple two units or consists together

    local canCouple, reason = CanCouple(unitA, unitB)
    if not canCouple then
        Spring.Echo("Cannot couple: " .. (reason or "unknown"))
        return false
    end

    local consistA = consistsByUnit[unitA] and consists[consistsByUnit[unitA]]
    local consistB = consistsByUnit[unitB] and consists[consistsByUnit[unitB]]

    -- Create consists if units are standalone
    if not consistA then
        consistA = CreateConsist(unitA)
    end
    if not consistB then
        consistB = CreateConsist(unitB)
    end

    -- Merge consistB into consistA
    if consistA.id ~= consistB.id then
        -- Determine coupling order based on positions
        -- For T1, just append B to A
        for _, unitID in ipairs(consistB.units) do
            table.insert(consistA.units, unitID)
            consistsByUnit[unitID] = consistA.id
        end

        consistA.engineCount = consistA.engineCount + consistB.engineCount
        consistA.carCount = consistA.carCount + consistB.carCount

        -- Remove old consist
        consists[consistB.id] = nil

        -- Rebuild coupling lengths and elect leader
        RebuildCouplingLengths(consistA)
        ElectLeader(consistA)
        UpdateConsistHP(consistA)
        UpdateConsistParams(consistA)

        Spring.Echo(string.format("Coupled: consist now has %d units (%d engines, %d cars)",
            #consistA.units, consistA.engineCount, consistA.carCount))
    end

    return true
end

local function DecoupleAt(unitID)
    -- Decouple consist at specified unit, creating two consists

    local consistID = consistsByUnit[unitID]
    if not consistID then
        Spring.Echo("Unit not in a consist")
        return false
    end

    local consist = consists[consistID]
    if #consist.units <= 1 then
        Spring.Echo("Cannot decouple single unit")
        return false
    end

    -- Find position of unit in consist
    local splitIndex
    for i, uid in ipairs(consist.units) do
        if uid == unitID then
            splitIndex = i
            break
        end
    end

    if not splitIndex or splitIndex == 1 then
        Spring.Echo("Cannot decouple at front unit")
        return false
    end

    -- Split the consist
    local newConsist = {
        id = nextConsistID,
        units = {},
        leader = nil,
        engineCount = 0,
        carCount = 0,
        couplingLengths = {},
        aggregateHP = 0,
        aggregateMaxHP = 0
    }
    nextConsistID = nextConsistID + 1

    -- Move units from splitIndex onwards to new consist
    for i = splitIndex, #consist.units do
        local uid = consist.units[i]
        table.insert(newConsist.units, uid)
        consistsByUnit[uid] = newConsist.id

        if IsEngine(uid) then
            newConsist.engineCount = newConsist.engineCount + 1
        else
            newConsist.carCount = newConsist.carCount + 1
        end
    end

    -- Remove from old consist
    for i = #consist.units, splitIndex, -1 do
        local uid = consist.units[i]
        table.remove(consist.units)

        if IsEngine(uid) then
            consist.engineCount = consist.engineCount - 1
        else
            consist.carCount = consist.carCount - 1
        end
    end

    consists[newConsist.id] = newConsist

    -- Rebuild both consists
    RebuildCouplingLengths(consist)
    RebuildCouplingLengths(newConsist)
    ElectLeader(consist)
    ElectLeader(newConsist)
    UpdateConsistHP(consist)
    UpdateConsistHP(newConsist)
    UpdateConsistParams(consist)
    UpdateConsistParams(newConsist)

    Spring.Echo(string.format("Decoupled: split into consists of %d and %d units",
        #consist.units, #newConsist.units))

    return true
end

--------------------------------------------------------------------------------
-- Command handling
--------------------------------------------------------------------------------

function gadget:Initialize()
    -- Register custom commands
    gadgetHandler:RegisterCMDID(CMD_COUPLE)
    gadgetHandler:RegisterCMDID(CMD_DECOUPLE)

    -- Add commands to existing units
    for _, unitID in ipairs(Spring.GetAllUnits()) do
        gadget:UnitCreated(unitID, Spring.GetUnitDefID(unitID))
    end
end

function gadget:UnitCreated(unitID, unitDefID)
    local def = GetTrainDef(unitDefID)
    if not def then return end

    -- Add custom commands
    local cmdDescCouple = {
        id      = CMD_COUPLE,
        type    = CMDTYPE.ICON_UNIT,
        name    = "Couple",
        tooltip = "Couple to another train unit",
        action  = "couple",
        cursor  = "Repair",
    }

    local cmdDescDecouple = {
        id      = CMD_DECOUPLE,
        type    = CMDTYPE.ICON,
        name    = "Decouple",
        tooltip = "Decouple from consist",
        action  = "decouple",
        cursor  = "Reclaim",
    }

    Spring.InsertUnitCmdDesc(unitID, cmdDescCouple)
    Spring.InsertUnitCmdDesc(unitID, cmdDescDecouple)
end

function gadget:UnitDestroyed(unitID, unitDefID)
    local consistID = consistsByUnit[unitID]
    if not consistID then return end

    local consist = consists[consistID]
    if not consist then return end

    -- Unit stays in consist as dead segment (per spec)
    -- Just update HP and re-elect leader if needed
    if unitID == consist.leader then
        ElectLeader(consist)
    end

    UpdateConsistHP(consist)
    UpdateConsistParams(consist)

    Spring.Echo(string.format("Train unit destroyed, consist still has %d units", #consist.units))
end

function gadget:AllowCommand(unitID, unitDefID, unitTeam, cmdID, cmdParams, cmdOptions)
    if cmdID == CMD_COUPLE then
        if #cmdParams < 1 then return false end
        local targetID = cmdParams[1]

        -- Check if target is valid train unit
        local targetDefID = Spring.GetUnitDefID(targetID)
        if not targetDefID or not GetTrainDef(targetDefID) then
            return false
        end

        return true

    elseif cmdID == CMD_DECOUPLE then
        return consistsByUnit[unitID] ~= nil
    end

    return true
end

function gadget:CommandFallback(unitID, unitDefID, unitTeam, cmdID, cmdParams, cmdOptions)
    if cmdID == CMD_COUPLE then
        local targetID = cmdParams[1]
        local success = CoupleUnits(unitID, targetID)
        return true, success  -- command handled, remove from queue if successful

    elseif cmdID == CMD_DECOUPLE then
        local success = DecoupleAt(unitID)
        return true, success
    end

    return false
end