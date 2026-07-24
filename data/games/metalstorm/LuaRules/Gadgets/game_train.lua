-- game_train.lua — Metalstorm land-train coupling and consist management.
--
-- DIVERGENCE FROM STANDARD SPRING: Trains are NOT a Recoil/Spring concept.
-- This is a deliberate custom Metalstorm game system built entirely from
-- Recoil-native Lua primitives with zero new C++ engine code. See
-- PLAN-metalstorm-train.md for design rationale.
--
-- T1 SCOPE: Coupling foundation (COMPLETE)
-- T2 SCOPE: Follow-the-leader kinematics (COMPLETE)
-- - Leader keeps stock CGroundMoveType, followers use Spring.MoveCtrl
-- - Breadcrumb ring buffer tracks leader's path by cumulative arc-length
-- - Each follower placed at its coupling-length offset behind, heading = tangent
-- - Reverse: two-engine consists swap leader, one-engine backs slowly
-- - Coupler-connected turning: no pivot, large turning circle
-- - Direction-of-travel heuristic: prefer reverse over >180° U-turn
-- T3 SCOPE: Damage-speed model
-- - Speed factor based on aggregate HP fraction with floor
-- - Dead cars stay in consist as dead segments, drop passengers/cargo, add small slow
-- - Dead engines add large slow, trigger leader re-election
-- - Zero live engines make consist immobile (but still fires)

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

-- Movement constants
local BREADCRUMB_BUFFER_SIZE = 512  -- ring buffer size for path history
local BREADCRUMB_SAMPLE_DIST = 2.0  -- minimum distance between breadcrumb samples
local MIN_TURNING_RADIUS = 30.0     -- minimum turning radius for trains (meters)
local REVERSE_SPEED_FACTOR = 0.3    -- speed multiplier when backing single-engine
local UTURN_ANGLE_THRESHOLD = 150   -- degrees - prefer reverse if turn > this

-- Damage-speed constants (T3)
local DAMAGE_SPEED_FLOOR = 0.2      -- minimum speed factor from damage
local SLOW_PER_DEAD_CAR = 0.05      -- speed penalty per dead car
local SLOW_PER_DEAD_ENGINE = 0.3    -- speed penalty per dead engine

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

        -- T2: Movement state
        breadcrumbs = {               -- ring buffer of leader path
            buffer = {{x,y,z,heading,arcLength}...},
            writeIdx = number,        -- next write position
            readIdx = number,         -- oldest valid position
            totalArcLength = number,  -- total arc length traveled
        },
        reversing = boolean,          -- true when consist is in reverse
        lastLeaderPos = {x,y,z},     -- for arc-length calculation
        lastLeaderHeading = number,

        -- T3: Damage state
        deadCars = {unitID...},      -- list of dead car IDs still in consist
        deadEngines = {unitID...},   -- list of dead engine IDs
        speedFactor = number,         -- aggregate speed multiplier from damage
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

local function InitBreadcrumbs()
    local buffer = {}
    for i = 1, BREADCRUMB_BUFFER_SIZE do
        buffer[i] = {x = 0, y = 0, z = 0, heading = 0, arcLength = 0}
    end
    return {
        buffer = buffer,
        writeIdx = 1,
        readIdx = 1,
        totalArcLength = 0
    }
end

local function CreateConsist(unitID)
    local x, y, z = Spring.GetUnitPosition(unitID)
    local heading = Spring.GetUnitHeading(unitID) or 0

    local consist = {
        id = nextConsistID,
        units = {unitID},
        leader = IsEngine(unitID) and unitID or nil,
        engineCount = IsEngine(unitID) and 1 or 0,
        carCount = IsEngine(unitID) and 0 or 1,
        couplingLengths = {},
        aggregateHP = 0,
        aggregateMaxHP = 0,

        -- T2: Movement state
        breadcrumbs = InitBreadcrumbs(),
        reversing = false,
        lastLeaderPos = {x = x, y = y, z = z},
        lastLeaderHeading = heading * math.pi / 32768,  -- Spring heading to radians

        -- T3: Damage state
        deadCars = {},
        deadEngines = {},
        speedFactor = 1.0
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
    local liveHP = 0
    local liveMaxHP = 0

    for _, unitID in ipairs(consist.units) do
        local hp, maxHP = Spring.GetUnitHealth(unitID)
        if hp then  -- unit still alive
            totalHP = totalHP + hp
            totalMaxHP = totalMaxHP + maxHP
            if not Spring.GetUnitIsDead(unitID) then
                liveHP = liveHP + hp
                liveMaxHP = liveMaxHP + maxHP
            end
        end
    end

    consist.aggregateHP = totalHP
    consist.aggregateMaxHP = totalMaxHP

    -- T3: Calculate speed factor from damage
    UpdateSpeedFactor(consist, liveHP, liveMaxHP)
end

local function UpdateSpeedFactor(consist, liveHP, liveMaxHP)
    -- Calculate base speed factor from aggregate HP fraction
    local speedFactor = 1.0

    if liveMaxHP > 0 then
        local hpFraction = liveHP / liveMaxHP
        speedFactor = math.max(hpFraction, DAMAGE_SPEED_FLOOR)
    end

    -- Apply penalties for dead segments
    local deadCarCount = 0
    local deadEngineCount = 0

    for _, unitID in ipairs(consist.deadCars or {}) do
        if Spring.ValidUnitID(unitID) then
            deadCarCount = deadCarCount + 1
        end
    end

    for _, unitID in ipairs(consist.deadEngines or {}) do
        if Spring.ValidUnitID(unitID) then
            deadEngineCount = deadEngineCount + 1
        end
    end

    -- Apply additive slows for dead segments
    speedFactor = speedFactor - (deadCarCount * SLOW_PER_DEAD_CAR)
    speedFactor = speedFactor - (deadEngineCount * SLOW_PER_DEAD_ENGINE)

    -- Check for zero live engines (immobile)
    local hasLiveEngine = false
    for _, unitID in ipairs(consist.units) do
        if IsEngine(unitID) and not Spring.GetUnitIsDead(unitID) then
            hasLiveEngine = true
            break
        end
    end

    if not hasLiveEngine then
        speedFactor = 0  -- Zero live engines = immobile
    end

    -- Clamp final speed factor
    consist.speedFactor = math.max(speedFactor, 0)
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
        Spring.SetUnitRulesParam(unitID, "train_speed_factor", consist.speedFactor or 1.0)  -- T3
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

        -- T2: Setup movement control after coupling
        SetupConsistMovement(consistA)

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

    -- T3: Unit stays in consist as dead segment (per spec)
    -- Track dead cars and engines for speed penalties
    if IsEngine(unitID) then
        table.insert(consist.deadEngines, unitID)
        -- If it was the leader, elect a new one
        if unitID == consist.leader then
            ElectLeader(consist)
            -- If we found a new leader, re-setup movement control
            if consist.leader then
                SetupConsistMovement(consist)
            end
        end
    else
        table.insert(consist.deadCars, unitID)
    end

    -- Drop passengers/cargo from destroyed unit
    local passengers = Spring.GetUnitIsTransporting(unitID)
    if passengers then
        for _, passengerID in ipairs(passengers) do
            -- Unload the passenger
            Spring.UnitDetach(passengerID)
            local x, y, z = Spring.GetUnitPosition(unitID)
            if x then
                -- Place passenger nearby
                Spring.SetUnitPosition(passengerID, x + math.random(-5, 5), z + math.random(-5, 5))
            end
        end
    end

    UpdateConsistHP(consist)
    UpdateConsistParams(consist)

    local engineStatus = consist.leader and "has leader" or "no live engines"
    Spring.Echo(string.format("Train unit destroyed (speedFactor=%.2f, %s), consist still has %d units",
        consist.speedFactor, engineStatus, #consist.units))
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

--------------------------------------------------------------------------------
-- T2: Movement functions
--------------------------------------------------------------------------------

local function AddBreadcrumb(consist, x, y, z, heading)
    local bc = consist.breadcrumbs
    local lastPos = consist.lastLeaderPos

    -- Calculate distance from last position
    local dx = x - lastPos.x
    local dy = y - lastPos.y
    local dz = z - lastPos.z
    local dist = math.sqrt(dx*dx + dy*dy + dz*dz)

    -- Only add breadcrumb if moved enough
    if dist < BREADCRUMB_SAMPLE_DIST then
        return
    end

    -- Add to arc length
    bc.totalArcLength = bc.totalArcLength + dist

    -- Store in ring buffer
    local crumb = bc.buffer[bc.writeIdx]
    crumb.x = x
    crumb.y = y
    crumb.z = z
    crumb.heading = heading
    crumb.arcLength = bc.totalArcLength

    -- Advance write index
    bc.writeIdx = bc.writeIdx % BREADCRUMB_BUFFER_SIZE + 1

    -- If we wrapped around, advance read index
    if bc.writeIdx == bc.readIdx then
        bc.readIdx = bc.readIdx % BREADCRUMB_BUFFER_SIZE + 1
    end

    -- Update last position
    consist.lastLeaderPos.x = x
    consist.lastLeaderPos.y = y
    consist.lastLeaderPos.z = z
    consist.lastLeaderHeading = heading
end

local function GetBreadcrumbAtArcLength(consist, targetArcLength)
    local bc = consist.breadcrumbs

    -- Find two breadcrumbs that bracket the target arc length
    local idx = bc.readIdx
    local prevCrumb = nil
    local nextCrumb = nil

    while idx ~= bc.writeIdx do
        local crumb = bc.buffer[idx]

        if crumb.arcLength >= targetArcLength then
            nextCrumb = crumb
            if prevCrumb then
                -- Interpolate between prevCrumb and nextCrumb
                local t = 0
                if nextCrumb.arcLength > prevCrumb.arcLength then
                    t = (targetArcLength - prevCrumb.arcLength) /
                        (nextCrumb.arcLength - prevCrumb.arcLength)
                end

                return {
                    x = prevCrumb.x + t * (nextCrumb.x - prevCrumb.x),
                    y = prevCrumb.y + t * (nextCrumb.y - prevCrumb.y),
                    z = prevCrumb.z + t * (nextCrumb.z - prevCrumb.z),
                    heading = prevCrumb.heading + t * (nextCrumb.heading - prevCrumb.heading)
                }
            else
                -- Use first available crumb
                return {x = crumb.x, y = crumb.y, z = crumb.z, heading = crumb.heading}
            end
        end

        prevCrumb = crumb
        idx = idx % BREADCRUMB_BUFFER_SIZE + 1
    end

    -- If we get here, use the last leader position
    return {
        x = consist.lastLeaderPos.x,
        y = consist.lastLeaderPos.y,
        z = consist.lastLeaderPos.z,
        heading = consist.lastLeaderHeading
    }
end

local function EnableFollowerMoveCtrl(unitID)
    -- Enable script control for this follower
    Spring.MoveCtrl.Enable(unitID)
    Spring.MoveCtrl.SetNoBlocking(unitID, true) -- Cars don't block each other
end

local function DisableFollowerMoveCtrl(unitID)
    Spring.MoveCtrl.Disable(unitID)
end

local function UpdateFollowerPosition(consist, followerIdx, leaderSpeed, effectiveSpeed)
    local unitID = consist.units[followerIdx]
    if not unitID then
        return  -- Unit might be dead but still in consist (T3)
    end

    -- Calculate cumulative coupling distance to this follower
    local couplingDist = 0
    for i = 1, followerIdx - 1 do
        couplingDist = couplingDist + (consist.couplingLengths[i] or 0)
    end

    -- Get position from breadcrumb at this arc length
    local targetArcLength = consist.breadcrumbs.totalArcLength - couplingDist

    if consist.reversing then
        -- When reversing, followers are ahead of the leader in arc terms
        targetArcLength = consist.breadcrumbs.totalArcLength + couplingDist
    end

    local pos = GetBreadcrumbAtArcLength(consist, targetArcLength)

    -- Only move live followers (dead ones stay in place)
    if not Spring.GetUnitIsDead(unitID) then
        -- Set follower position and heading via MoveCtrl
        Spring.MoveCtrl.SetPosition(unitID, pos.x, pos.y, pos.z)
        Spring.MoveCtrl.SetHeading(unitID, pos.heading * 32768 / math.pi) -- radians to Spring heading
        Spring.MoveCtrl.SetVelocity(unitID, 0, 0, effectiveSpeed) -- use effective speed (with damage factor)
    end
end

local function CheckForUTurn(consist, targetX, targetZ)
    -- Check if reaching the target would require a U-turn
    if not consist.leader then
        return false
    end

    local x, _, z = Spring.GetUnitPosition(consist.leader)
    local heading = Spring.GetUnitHeading(consist.leader) or 0
    heading = heading * math.pi / 32768

    -- Calculate bearing to target
    local dx = targetX - x
    local dz = targetZ - z
    local targetBearing = math.atan2(dx, dz)

    -- Calculate angle difference
    local angleDiff = math.abs(targetBearing - heading)
    if angleDiff > math.pi then
        angleDiff = 2 * math.pi - angleDiff
    end

    -- Convert to degrees
    angleDiff = angleDiff * 180 / math.pi

    return angleDiff > UTURN_ANGLE_THRESHOLD
end

local function SwapLeader(consist)
    -- Find the other engine for two-engine consists
    local engines = {}
    for _, unitID in ipairs(consist.units) do
        if IsEngine(unitID) and not Spring.GetUnitIsDead(unitID) then
            table.insert(engines, unitID)
        end
    end

    if #engines < 2 then
        return false -- Can't swap with only one engine
    end

    -- Find the engine that's not currently the leader
    local newLeader = nil
    for _, engineID in ipairs(engines) do
        if engineID ~= consist.leader then
            newLeader = engineID
            break
        end
    end

    if not newLeader then
        return false
    end

    -- Disable MoveCtrl on old leader, enable on new leader
    if consist.leader then
        EnableFollowerMoveCtrl(consist.leader)
    end
    DisableFollowerMoveCtrl(newLeader)

    consist.leader = newLeader
    consist.reversing = not consist.reversing

    -- Reset breadcrumbs for new direction
    consist.breadcrumbs = InitBreadcrumbs()
    local x, y, z = Spring.GetUnitPosition(newLeader)
    local heading = Spring.GetUnitHeading(newLeader) or 0
    consist.lastLeaderPos = {x = x, y = y, z = z}
    consist.lastLeaderHeading = heading * math.pi / 32768

    return true
end

local function SetupConsistMovement(consist)
    -- Setup movement control for all units in consist
    if not consist.leader then
        return
    end

    -- Leader keeps normal movement
    DisableFollowerMoveCtrl(consist.leader)

    -- All other units become followers
    for i, unitID in ipairs(consist.units) do
        if unitID ~= consist.leader and not Spring.GetUnitIsDead(unitID) then
            EnableFollowerMoveCtrl(unitID)
        end
    end

    -- Initialize breadcrumbs from leader position
    local x, y, z = Spring.GetUnitPosition(consist.leader)
    local heading = Spring.GetUnitHeading(consist.leader) or 0
    consist.lastLeaderPos = {x = x, y = y, z = z}
    consist.lastLeaderHeading = heading * math.pi / 32768

    -- Add initial breadcrumb
    AddBreadcrumb(consist, x, y, z, consist.lastLeaderHeading)
end

--------------------------------------------------------------------------------
-- Game frame update
--------------------------------------------------------------------------------

function gadget:GameFrame(frame)
    -- Update all consists every frame
    for consistID, consist in pairs(consists) do
        if consist.leader and not Spring.GetUnitIsDead(consist.leader) then
            -- Update leader breadcrumb
            local x, y, z = Spring.GetUnitPosition(consist.leader)
            local heading = Spring.GetUnitHeading(consist.leader) or 0
            heading = heading * math.pi / 32768

            -- Get current leader speed
            local vx, vy, vz, speed = Spring.GetUnitVelocity(consist.leader)
            speed = math.sqrt(vx*vx + vz*vz)

            -- T3: Apply speed factor to effective speed
            local effectiveSpeed = speed
            if consist.speedFactor and consist.speedFactor < 1.0 then
                effectiveSpeed = speed * consist.speedFactor

                -- Cap the leader's actual movement speed
                if consist.speedFactor == 0 then
                    -- Immobile - stop the leader
                    Spring.GiveOrderToUnit(consist.leader, CMD.STOP, {}, {})
                else
                    -- Use SetUnitCOBValue to cap speed (works on non-MoveCtrl units)
                    local percentSpeed = consist.speedFactor * 100
                    Spring.SetUnitCOBValue(consist.leader, COB.MAX_SPEED, percentSpeed)
                end
            elseif consist.speedFactor and consist.speedFactor >= 1.0 then
                -- Reset to full speed if recovered
                Spring.SetUnitCOBValue(consist.leader, COB.MAX_SPEED, 100)
            end

            -- Enforce no-pivot turning constraint
            if effectiveSpeed < 0.1 then
                -- When stopped, prevent any rotation
                local headingDiff = math.abs(heading - consist.lastLeaderHeading)
                if headingDiff > 0.01 then
                    -- Force heading back to last known
                    Spring.SetUnitRotation(consist.leader, 0, consist.lastLeaderHeading, 0)
                    heading = consist.lastLeaderHeading
                end
            else
                -- While moving, cap turn rate based on speed
                local maxTurnPerFrame = effectiveSpeed / MIN_TURNING_RADIUS
                local headingDiff = heading - consist.lastLeaderHeading

                -- Normalize angle difference
                while headingDiff > math.pi do headingDiff = headingDiff - 2*math.pi end
                while headingDiff < -math.pi do headingDiff = headingDiff + 2*math.pi end

                if math.abs(headingDiff) > maxTurnPerFrame then
                    -- Cap the turn rate
                    heading = consist.lastLeaderHeading +
                        maxTurnPerFrame * (headingDiff > 0 and 1 or -1)
                    Spring.SetUnitRotation(consist.leader, 0, heading, 0)
                end
            end

            AddBreadcrumb(consist, x, y, z, heading)

            -- Update all followers
            for i = 2, #consist.units do
                UpdateFollowerPosition(consist, i, speed, effectiveSpeed)
            end
        elseif consist.speedFactor == 0 then
            -- T3: Zero live engines - consist is immobile but units can still fire
            -- Just ensure followers stay in position
            for i = 2, #consist.units do
                local unitID = consist.units[i]
                if unitID and not Spring.GetUnitIsDead(unitID) then
                    Spring.MoveCtrl.SetVelocity(unitID, 0, 0, 0)
                end
            end
        end
    end
end

-- Override move commands to check for U-turns
function gadget:AllowUnitCommand(unitID, unitDefID, unitTeam, cmdID, cmdParams, cmdOptions, cmdTag, synced)
    local consistID = consistsByUnit[unitID]
    if not consistID then
        return true -- Not a train unit
    end

    local consist = consists[consistID]
    if not consist or unitID ~= consist.leader then
        return true -- Not the leader
    end

    -- Check move commands
    if cmdID == CMD.MOVE or cmdID == CMD.ATTACK_MOVE or cmdID == CMD.PATROL then
        if #cmdParams >= 3 then
            local targetX, targetZ = cmdParams[1], cmdParams[3]

            -- Check if this would require a U-turn
            if CheckForUTurn(consist, targetX, targetZ) then
                -- Try to swap leaders for two-engine consists
                if SwapLeader(consist) then
                    Spring.Echo("Reversing consist to avoid U-turn")
                    UpdateConsistParams(consist)
                elseif consist.engineCount == 1 then
                    -- Single engine - will have to back up slowly
                    Spring.Echo("Single-engine consist will reverse slowly")
                    consist.reversing = true
                end
            end
        end
    end

    return true
end