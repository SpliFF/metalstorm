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
-- T3 SCOPE: Damage-speed model (COMPLETE)
-- - Speed factor based on aggregate HP fraction with floor
-- - Dead cars stay in consist as dead segments, drop passengers/cargo, add small slow
-- - Dead engines add large slow, trigger leader re-election
-- - Zero live engines make consist immobile (but still fires)
-- T4 SCOPE: Firing arcs
-- - Symmetric cones (engine 270° fwd, AA 360°, cupolas 360°) via maxAngleDif/mainDir in defs
-- - Bowtie arcs (roof turrets, loaded squads) via AllowWeaponTarget callin
-- - Bowtie: 120° each side, reject fore/aft (keep |sideBearing| within 60° of ±X)
-- T5 SCOPE: Squad transport
-- - Troop car retuned to 4 squad-units (transportcapacity=4, transportsize=1)
-- - Cargo car holds 2 light vehicles (transportcapacity=2, transportsize=2)
-- - isFirePlatform=true on both → loaded units keep firing
-- - Loaded units use bowtie side-fire (AllowWeaponTargetCheck already implemented in T4)
-- - Load/unload gating: unload only at low/zero consist speed (< 0.5 elmo/frame)
-- COUPLER-DISTANCE FIX (2026-07-25): halfLength now derives from the real unit
-- footprint (zsize) instead of hardcoded placeholders, so CanCouple's range
-- matches physical car length. Also adds GG.Train.Couple(a, b) as a
-- programmatic seam alongside the CMD_COUPLE order flow. See
-- PLAN-metalstorm-train.md §2/§7.
-- LIVE-CALLIN FIX (2026-07-25, demo-verify fire 3 findings):
-- - The U-turn/prefer-reverse check used to live in gadget:AllowUnitCommand,
--   which is NOT a callin — neither this engine nor upstream Recoil ever
--   dispatches that name (Recoil's only order gate is AllowCommand, see
--   rts/Sim/Units/CommandAI/CommandAI.cpp -> eventHandler.AllowCommand). The
--   logic now lives in gadget:AllowCommand, the faithful Recoil callin, which
--   fires for every queued order including CMD.MOVE/FIGHT/PATROL.
-- - train_speed_factor now recomputes periodically in GameFrame (covers
--   non-lethal damage AND repair), not only on consist-membership changes.
-- - The leader's physical speed cap now uses
--   MoveCtrl.SetGroundMoveTypeData("maxSpeed") instead of
--   SetUnitCOBValue(COB.MAX_SPEED): the COB path needs a unit script the
--   scriptless fable_train units don't have, so it errored every frame
--   (null-script log spam) and never actually slowed the train.
-- - Failed CMD_COUPLE orders are removed from the queue instead of retrying
--   (and re-echoing) every ~15 frames forever.
-- - CheckForUTurn now compares against GetUnitDirection (real front vector);
--   the old (sin, cos) GetUnitHeading math is 180° inverted on this engine's
--   RH-native coordinate frame.
-- - The Lua-side no-pivot turn cap (per-frame SetUnitRotation snap) is
--   removed: it livelocked consist leaders at turninplacespeedlimit. The
--   unit def (turninplace=false, turnrate) already enforces train-like
--   turning natively.
-- REVERSE-DRIVE KINEMATICS (2026-07-26, following up the 2026-07-25 U-turn
-- fire — detection worked, motion didn't):
-- - Single-engine backing was previously a no-op: consist.reversing got set
--   and an Echo fired, but nothing drove the leader anywhere, so it still
--   turned in place toward the goal (CGroundMoveType has no native reverse —
--   Spring ground units always turn-and-drive-forward). StartReverseCrawl /
--   UpdateReverseCrawl now take the leader off its stock move type (the same
--   Spring.MoveCtrl Lua API already used for followers — no engine C++
--   change) and translate the WHOLE consist (leader + followers) rigidly
--   along the leader's fixed -facing axis each frame, at
--   REVERSE_SPEED_FACTOR × its normal max speed × the damage speed factor.
--   Rigid translation (not the breadcrumb/arc-length trail used for forward
--   following) is deliberate: the trail model samples the leader's PAST
--   positions to place followers behind it, which only works when the
--   follower is behind the leader in the direction of travel. Backing up
--   inverts that — the trailing car leads into the reverse direction — so
--   trailing would need to sample a breadcrumb that doesn't exist yet
--   (the future). A straight, non-turning crawl has no curvature to trail
--   through, so translating every unit by the same per-frame delta keeps
--   coupling spacing exact with far less complexity. Control reverts to the
--   leader's stock move type once its projected progress along the crawl
--   axis closes to within REVERSE_ARRIVAL_DIST of the goal (or a fresh order
--   supersedes it), same as the existing SwapLeader hand-back pattern.
--   Field notes: PLAN-metalstorm-train.md §2/§7 (unchanged in this file —
--   see .tasks/notes/metalstorm-train.md for the write-up).
-- - Two-engine leadership swap flipped consist.leader/params but left the
--   queued MOVE/FIGHT/PATROL order attached to the OLD leader, which
--   SwapLeader had just put under MoveCtrl (stock move type disabled) — the
--   order sat inert and the swapped consist never actually drove anywhere.
--   AllowCommand now re-issues the same order to the new leader via
--   Spring.GiveOrderToUnit immediately after a successful swap. Since
--   GiveOrderToUnit dispatches AllowCommand synchronously (same callin, same
--   call stack — this is a faithful Recoil order-gate reproduction, not a
--   queued/deferred effect), a consist.reissuingOrder guard prevents the
--   re-entrant call from evaluating the swap logic again — needed for
--   degenerate geometry (goal roughly equidistant from both ends) where the
--   new leader's own CheckForUTurn could otherwise also read true and
--   ping-pong the swap forever.

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

-- Elmos per map square (rts/Server/MapProcessor.cpp SQUARE_SIZE); zsize is
-- expressed in map squares, so this converts it to world-space elmos.
local SQUARE_SIZE = 8

-- Movement constants
local BREADCRUMB_BUFFER_SIZE = 512  -- ring buffer size for path history
local BREADCRUMB_SAMPLE_DIST = 2.0  -- minimum distance between breadcrumb samples
local REVERSE_SPEED_FACTOR = 0.3    -- speed multiplier when backing single-engine
local UTURN_ANGLE_THRESHOLD = 150   -- degrees - prefer reverse if turn > this
local REVERSE_ARRIVAL_DIST = 48     -- elmos - hand back to stock movement once this close

-- Damage-speed constants (T3)
local DAMAGE_SPEED_FLOOR = 0.2      -- minimum speed factor from damage
local SLOW_PER_DEAD_CAR = 0.05      -- speed penalty per dead car
local SLOW_PER_DEAD_ENGINE = 0.3    -- speed penalty per dead engine

-- T5: Transport constants
local MAX_UNLOAD_SPEED = 0.5        -- max speed (elmo/frame) to allow unload

-- Damage→speed recompute cadence. UnitDamaged alone can't drive this (repair
-- raises HP without any damage event), so consist HP/speed-factor state is
-- recomputed on a fixed cadence instead. 15 frames = 0.5 s at GAME_SPEED 30 —
-- fast enough that a shelled train visibly slows while still alive.
local HP_RECOMPUTE_INTERVAL = 15
local Tick = VFS.Include("LuaRules/Gadgets/tick.lua")
local hpRecomputeGate = Tick.new(HP_RECOMPUTE_INTERVAL)

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
        reversing = boolean,          -- true when the leader/follower roles
                                       -- have physically inverted (two-engine
                                       -- swap) — flips follower arc-length
                                       -- sign, NOT set for single-engine
                                       -- reverse-crawl (see reverseCrawl).
        reverseCrawl = nil or {       -- present while a single-engine consist
            goalX = number,           -- is backing straight toward a goal
            goalZ = number,           -- that's behind it (rigid translation,
            dirX = number,            -- not breadcrumb trailing — see the
            dirZ = number,            -- REVERSE-DRIVE KINEMATICS file note)
        },
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

-- Forward declarations: CreateConsist seeds a new consist's derived state via
-- UpdateConsistHP (which itself calls UpdateSpeedFactor) and
-- UpdateConsistParams, and CoupleUnits/UnitDestroyed (re)apply movement
-- control via SetupConsistMovement — all defined later in the file (Lua's
-- `local function` isn't visible to code above it, so calling these without
-- a forward declaration is a nil-global call the first time any of those
-- code paths actually run). CheckForUTurn/SwapLeader/StartReverseCrawl/
-- FinishReverseCrawl are needed by gadget:AllowCommand, which is also
-- defined above them.
local UpdateConsistHP, UpdateSpeedFactor, UpdateConsistParams, SetupConsistMovement
local CheckForUTurn, SwapLeader, StartReverseCrawl, FinishReverseCrawl

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
        local trimmed = link:match("^%s*(.-)%s*$")  -- trim
        if trimmed == "link_f" then
            linkF = true
        elseif trimmed == "link_r" then
            linkR = true
        end
    end

    -- Half-length derived from the unit's actual footprint (zsize, in map
    -- squares) rather than the coupler model's piece z-offsets, which we
    -- don't have a runtime API to read. The footprint is what collision
    -- actually keeps units apart by, so coupling range has to match it or
    -- footprint-adjacent cars can never get within CanCouple range (see
    -- the 2026-07-25 demo-verify note in .tasks/notes/metalstorm-train.md —
    -- the old 11.2/8.7 placeholders were ~6x too small).
    local halfLength = def.zsize * SQUARE_SIZE / 2

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

-- T5: Get consist's current speed
local function GetConsistSpeed(consist)
    if not consist.leader or Spring.GetUnitIsDead(consist.leader) then
        return 0
    end

    local vx, vy, vz = Spring.GetUnitVelocity(consist.leader)
    if not vx then return 0 end

    return math.sqrt(vx*vx + vz*vz)
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

function UpdateConsistHP(consist)
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

function UpdateSpeedFactor(consist, liveHP, liveMaxHP)
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

function UpdateConsistParams(consist)
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

-- Programmatic coupling seam for scenario/GM consist spawning. CMD_COUPLE
-- (the order-flow path via CommandFallback below) requires a player-issued
-- ICON_UNIT command and is awkward to drive from scenario setup code, so
-- expose the same CoupleUnits() logic directly.
GG.Train = GG.Train or {}
function GG.Train.Couple(unitA, unitB)
    return CoupleUnits(unitA, unitB)
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

    elseif cmdID == CMD.UNLOAD_UNITS or cmdID == CMD.UNLOAD_UNIT then
        -- T5: Gate unload by consist speed (only allow at low/zero speed)
        local consistID = consistsByUnit[unitID]
        if consistID then
            local consist = consists[consistID]
            if consist then
                local speed = GetConsistSpeed(consist)
                if speed > MAX_UNLOAD_SPEED then
                    -- Refuse unload while moving fast
                    return false
                end
            end
        end
        return true

    elseif cmdID == CMD.MOVE or cmdID == CMD.FIGHT or cmdID == CMD.PATROL then
        -- T2 prefer-reverse: a goal >UTURN_ANGLE_THRESHOLD degrees behind the
        -- leader swaps leadership (two-engine consists) or flags a slow
        -- reverse (single-engine) instead of pivoting the whole consist.
        -- This used to sit in gadget:AllowUnitCommand — a callin name no
        -- engine (ours or Recoil) ever dispatches, so the feature was dead
        -- code until the 2026-07-25 demo re-verify caught it. AllowCommand is
        -- the real Recoil order gate and fires for these commands too.
        -- (Attack-move is CMD.FIGHT; there is no CMD.ATTACK_MOVE constant.)
        local consistID = consistsByUnit[unitID]
        if consistID then
            local consist = consists[consistID]
            if consist and unitID == consist.leader and #cmdParams >= 3
                    and not consist.reissuingOrder then
                -- A fresh order supersedes any reverse-crawl already in
                -- progress — hand control back and re-decide from scratch
                -- against the new goal rather than crawling toward a target
                -- the player no longer wants.
                if consist.reverseCrawl then
                    FinishReverseCrawl(consist)
                end

                local targetX, targetZ = cmdParams[1], cmdParams[3]
                if CheckForUTurn(consist, targetX, targetZ) then
                    if SwapLeader(consist) then
                        Spring.Echo("Reversing consist to avoid U-turn")
                        UpdateConsistParams(consist)

                        -- SwapLeader only flips leadership/state; the queued
                        -- order stays attached to the OLD leader, which is
                        -- now a MoveCtrl'd follower (stock move type
                        -- disabled) — its queued command can't drive
                        -- anything. Re-issue the same order to the new
                        -- leader so the swapped consist actually moves.
                        -- reissuingOrder guards against GiveOrderToUnit's
                        -- synchronous re-entrant AllowCommand call re-running
                        -- this swap logic (see file header note).
                        consist.reissuingOrder = true
                        Spring.GiveOrderToUnit(consist.leader, cmdID, cmdParams, cmdOptions)
                        consist.reissuingOrder = false
                    elseif consist.engineCount == 1 then
                        -- Single engine - back up slowly toward the goal.
                        Spring.Echo("Single-engine consist will reverse slowly")
                        StartReverseCrawl(consist, targetX, targetZ)
                    end
                end
            end
        end
        return true
    end

    return true
end

function gadget:CommandFallback(unitID, unitDefID, unitTeam, cmdID, cmdParams, cmdOptions)
    if cmdID == CMD_COUPLE then
        -- Attempt once and always remove the order. Keeping a failed couple
        -- order queued (the old `return true, success`) made CommandFallback
        -- retry it every ~15 frames forever — nothing in the order drives the
        -- units closer together, so it could never start succeeding on its
        -- own and just spammed "Cannot couple: ..." echoes (2026-07-25 demo
        -- re-verify finding). The player re-issues after closing the gap.
        local targetID = cmdParams[1]
        CoupleUnits(unitID, targetID)
        return true, true

    elseif cmdID == CMD_DECOUPLE then
        -- Same one-shot semantics: DecoupleAt failures (not in a consist,
        -- front unit) are permanent for the queued order, so retrying is
        -- pure spam.
        DecoupleAt(unitID)
        return true, true
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
    -- Enable script control for this unit (a follower, or — during a
    -- single-engine reverse crawl — the leader itself).
    Spring.MoveCtrl.Enable(unitID)
    Spring.MoveCtrl.SetNoBlocking(unitID, true) -- Cars don't block each other
    -- CScriptMoveType defaults `extrapolate = true` (ScriptMoveType.h), which
    -- makes the engine's own per-frame Update() ADD whatever velocity is set
    -- via Spring.MoveCtrl.SetVelocity to owner->pos as a raw per-frame delta
    -- — on top of any explicit Spring.MoveCtrl.SetPosition call the same
    -- frame (ScriptMoveType.cpp:104-123, `owner->Move(velVec, true)`). Every
    -- caller here (UpdateFollowerPosition, UpdateReverseCrawl) already sets
    -- position explicitly every frame from first principles (breadcrumb trail
    -- / rigid translation) and only uses SetVelocity for the REPORTED value
    -- (GetUnitVelocity, for client dust/audio) — extrapolation is pure
    -- unwanted drift on top of that, not integration we want. Found live
    -- 2026-07-26 while verifying the reverse crawl (a ~31x per-frame
    -- overshoot on the leader, since its velocity there is comparatively
    -- large); it silently affects follower placement too — usually invisible
    -- there because followers overwrite position absolutely every frame, but
    -- real (velVec is always world +Z regardless of actual heading, so it's
    -- most visible off a straight north-south line, e.g. mid-turn).
    Spring.MoveCtrl.SetExtrapolate(unitID, false)
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

function CheckForUTurn(consist, targetX, targetZ)
    -- Check if reaching the target would require a U-turn.
    --
    -- Facing comes from GetUnitDirection (the unit's real front vector,
    -- always frame-consistent with GetUnitPosition), NOT from
    -- (sin, cos) of GetUnitHeading: this engine's RH-native coordinate flip
    -- changed the heading↔vector mapping (GetHeadingFromFacing in
    -- SpringMath.inl — FACING_NORTH→0 now, was FACING_SOUTH→0), so the
    -- classic Spring (sin h, cos h) formula points 180° from the unit's
    -- actual front for RH games like Metalstorm. Live-caught 2026-07-25: a
    -- dead-ahead goal read as a U-turn and vice versa.
    if not consist.leader then
        return false
    end

    local x, _, z = Spring.GetUnitPosition(consist.leader)
    local fx, _, fz = Spring.GetUnitDirection(consist.leader)
    if not x or not fx then
        return false
    end

    local dx = targetX - x
    local dz = targetZ - z
    local dLen = math.sqrt(dx*dx + dz*dz)
    local fLen = math.sqrt(fx*fx + fz*fz)
    if dLen < 1.0 or fLen < 1e-6 then
        return false  -- standing on the goal / degenerate facing
    end

    local cosAngle = (dx*fx + dz*fz) / (dLen * fLen)
    if cosAngle > 1.0 then cosAngle = 1.0 elseif cosAngle < -1.0 then cosAngle = -1.0 end
    local angleDiff = math.acos(cosAngle) * 180 / math.pi

    return angleDiff > UTURN_ANGLE_THRESHOLD
end

function SwapLeader(consist)
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

function SetupConsistMovement(consist)
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

function StartReverseCrawl(consist, targetX, targetZ)
    -- Single-engine consists can't swap ends, and Spring ground units have
    -- no native reverse gear (CGroundMoveType always turns to face its
    -- goal) — so the only way to back the leader up without turning is to
    -- take it off its stock move type, same as a follower.
    local leader = consist.leader
    if not leader then return end

    -- Same helper the followers use (Enable + SetNoBlocking + disabling
    -- CScriptMoveType's extrapolation — see its comment).
    EnableFollowerMoveCtrl(leader)

    -- Fix the crawl direction to -facing at the moment the order lands. No
    -- turning happens during the crawl, so this stays constant for its
    -- duration (see the rigid-translation rationale in the file header).
    local fx, _, fz = Spring.GetUnitDirection(leader)
    fx, fz = fx or 0, fz or -1
    local flen = math.sqrt(fx * fx + fz * fz)
    if flen < 1e-6 then fx, fz, flen = 0, -1, 1 end

    consist.reverseCrawl = {
        goalX = targetX,
        goalZ = targetZ,
        dirX = -fx / flen,
        dirZ = -fz / flen,
    }
end

function FinishReverseCrawl(consist)
    consist.reverseCrawl = nil

    local leader = consist.leader
    if leader and not Spring.GetUnitIsDead(leader) then
        -- Hand back to the stock move type; it already has the original
        -- queued goal and will complete or fine-tune the approach itself.
        Spring.MoveCtrl.Disable(leader)
    end

    -- Reseed breadcrumbs from the arrival position/heading so forward
    -- following resumes cleanly (same pattern SetupConsistMovement uses
    -- after initial coupling).
    if consist.leader then
        SetupConsistMovement(consist)
    end
end

local function UpdateReverseCrawl(consist)
    local leader = consist.leader
    if not leader or Spring.GetUnitIsDead(leader) then
        consist.reverseCrawl = nil
        return
    end

    local rc = consist.reverseCrawl
    local lx, ly, lz = Spring.GetUnitPosition(leader)
    if not lx then
        consist.reverseCrawl = nil
        return
    end

    local dx, dz = rc.goalX - lx, rc.goalZ - lz
    local distRemaining = math.sqrt(dx * dx + dz * dz)

    -- Progress projected onto the fixed crawl axis. Using the projection
    -- (not raw distance) to decide arrival means a goal that's slightly off
    -- the exact reverse axis still ends the crawl once the leader draws
    -- level with it, instead of overshooting and crawling away forever.
    local axisProgress = dx * rc.dirX + dz * rc.dirZ
    if axisProgress <= REVERSE_ARRIVAL_DIST or distRemaining <= REVERSE_ARRIVAL_DIST then
        FinishReverseCrawl(consist)
        return
    end

    local defID = Spring.GetUnitDefID(leader)
    local def = defID and UnitDefs[defID]
    local baseSpeed = (def and def.speed) or 0  -- elmos/sec, same convention as the damage speed-cap code below
    local factor = consist.speedFactor or 1.0
    local step = baseSpeed * REVERSE_SPEED_FACTOR * factor / (Game.gameSpeed or 30)  -- elmos/frame
    if step > axisProgress then step = axisProgress end

    local ddx = rc.dirX * step
    local ddz = rc.dirZ * step

    -- Translate every live unit in the consist (leader included) by the
    -- same delta. A straight, non-turning crawl has no curvature to trail
    -- through, so this keeps each car's existing coupling offset exact
    -- without re-deriving it from the breadcrumb trail (which can't be used
    -- here — see the file header note).
    for _, unitID in ipairs(consist.units) do
        if not Spring.GetUnitIsDead(unitID) then
            local ux, uy, uz = Spring.GetUnitPosition(unitID)
            if ux then
                Spring.MoveCtrl.SetPosition(unitID, ux + ddx, uy, uz + ddz)
                -- Reported value only (GetUnitVelocity, client FX) — extrapolation
                -- off this same velocity is disabled by EnableFollowerMoveCtrl, so
                -- this doesn't double-apply. elmos/frame, matching ddx/ddz (NOT the
                -- elmos/sec convention MoveCtrl.SetGroundMoveTypeData("maxSpeed") uses).
                Spring.MoveCtrl.SetVelocity(unitID, ddx, 0, ddz)
            end
        end
    end
end

--------------------------------------------------------------------------------
-- Game frame update
--------------------------------------------------------------------------------

function gadget:GameFrame(frame)
    -- T3: Periodic damage→speed recompute. Membership-change events alone
    -- (couple/decouple/UnitDestroyed) left train_speed_factor stale while a
    -- car was damaged-but-alive — a 72%-shelled engine kept factor 1.0 until
    -- something actually died (2026-07-25 demo re-verify finding). A fixed
    -- cadence also picks up HP *recovery* from repairs, which fires no
    -- damage event at all.
    -- D15: skip-safe cadence (see tick.lua). Observation policy — the recompute
    -- reads current HP and is idempotent, so a stall costs one refresh.
    if Tick.due(hpRecomputeGate, frame) then
        for _, consist in pairs(consists) do
            UpdateConsistHP(consist)
            UpdateConsistParams(consist)
        end
    end

    -- Update all consists every frame
    for consistID, consist in pairs(consists) do
        if consist.reverseCrawl then
            -- Single-engine reverse crawl in progress: rigid translation
            -- replaces the normal breadcrumb/follower update entirely for
            -- this consist until it hands control back (see file header).
            UpdateReverseCrawl(consist)
        elseif consist.leader and not Spring.GetUnitIsDead(consist.leader) then
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
                if consist.speedFactor == 0 then
                    -- Immobile - stop the leader
                    Spring.GiveOrderToUnit(consist.leader, CMD.STOP, {}, {})
                end
            end

            -- Cap the leader's real move-type speed when the factor (or the
            -- leader) changes. This used to call SetUnitCOBValue(COB.MAX_SPEED)
            -- every frame, but that path needs a COB unit script and the
            -- fable_train units are scriptless — the null script errored
            -- ("[US::SetUnitVal] invoked for null-scripted unit" log spam) and
            -- the cap silently never applied, so damaged trains never
            -- physically slowed. MoveCtrl.SetGroundMoveTypeData("maxSpeed") is
            -- the Recoil-native Lua control for scriptless ground movers. The
            -- value is in elmos/sec, same unit as UnitDefs[id].speed — the
            -- engine divides by GAME_SPEED itself (AMoveType::SetMemberValue).
            local factor = consist.speedFactor or 1.0
            if consist.appliedSpeedFactor ~= factor
                    or consist.appliedSpeedLeader ~= consist.leader then
                local defID = Spring.GetUnitDefID(consist.leader)
                local def = defID and UnitDefs[defID]
                if def and def.speed and def.speed > 0 then
                    Spring.MoveCtrl.SetGroundMoveTypeData(consist.leader, "maxSpeed",
                        def.speed * factor)
                end
                consist.appliedSpeedFactor = factor
                consist.appliedSpeedLeader = consist.leader
            end

            -- No-pivot / turning-circle constraints are the unit def's job,
            -- not Lua's: fable_train sets turninplace=false + turnrate 50,
            -- which CGroundMoveType enforces as a ~500-elmo turning circle —
            -- far wider than the old MIN_TURNING_RADIUS=30 Lua cap here. The
            -- removed per-frame SetUnitRotation heading-snap also fought the
            -- move type: it compared against lastLeaderHeading (only updated
            -- per 2-elmo breadcrumb, so always slightly stale) and rotated
            -- the unit back every frame, which kept the move type permanently
            -- in its turn-limited state — consist leaders never exceeded
            -- turninplacespeedlimit (0.5 elmo/frame) no matter their health
            -- (live-caught 2026-07-25 while verifying the damage-speed cap).

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

--------------------------------------------------------------------------------
-- T4: Firing arc constraints
--------------------------------------------------------------------------------

-- Helper to check if a target bearing falls within the bowtie arc
-- (120° each side, no fore/aft = keep only |sideBearing| within 60° of ±X)
local function IsInBowtieArc(unitID, targetX, targetY, targetZ)
    -- Get unit position and heading
    local ux, uy, uz = Spring.GetUnitPosition(unitID)
    if not ux then return false end

    local heading = Spring.GetUnitHeading(unitID)
    if not heading then return false end

    -- Convert Spring heading (0 = south, increases clockwise) to radians
    heading = heading * math.pi / 32768

    -- Calculate bearing to target in world space
    local dx = targetX - ux
    local dz = targetZ - uz
    local worldBearing = math.atan2(dx, dz)

    -- Calculate relative bearing in unit's local frame
    -- heading points along -Z in unit space, so unit's +X is heading + π/2
    local relativeBearing = worldBearing - heading

    -- Normalize to [-π, π]
    while relativeBearing > math.pi do relativeBearing = relativeBearing - 2*math.pi end
    while relativeBearing < -math.pi do relativeBearing = relativeBearing + 2*math.pi end

    -- Bowtie: reject fore/aft (±30° around forward/back), keep sides
    -- Forward is 0°, back is ±180°, sides are ±90°
    -- We want |sideBearing| within 60° of ±90°, which means:
    -- Accept if bearing in [30°, 150°] or [-150°, -30°]
    local bearingDeg = relativeBearing * 180 / math.pi

    -- Fore/aft rejection zones: [-30°, 30°] and [150°, 180°] ∪ [-180°, -150°]
    if (bearingDeg >= -30 and bearingDeg <= 30) then
        return false  -- Forward dead zone
    end
    if (bearingDeg >= 150 or bearingDeg <= -150) then
        return false  -- Rear dead zone
    end

    return true  -- In side arcs
end

function gadget:AllowWeaponTarget(unitID, targetID, weaponNum, weaponDefID, defaultPriority)
    -- Check if this is a roof turret on a gun car
    local unitDefID = Spring.GetUnitDefID(unitID)
    if not unitDefID then return true end

    local def = UnitDefs[unitDefID]
    if not def or not def.customParams then return true end

    local cp = def.customParams
    local roofTurrets = cp.roof_turrets

    if roofTurrets then
        -- Check if this weapon is in the roof turret list
        local isRoofTurret = false
        for turretNum in string.gmatch(roofTurrets, "[^,]+") do
            local trimmed = tonumber(turretNum:match("^%s*(.-)%s*$"))  -- trim and convert
            if trimmed == weaponNum then
                isRoofTurret = true
                break
            end
        end

        if isRoofTurret then
            -- Apply bowtie arc constraint
            local tx, ty, tz = Spring.GetUnitPosition(targetID)
            if not tx then return true end  -- No position, let engine decide

            if not IsInBowtieArc(unitID, tx, ty, tz) then
                return false  -- Target in fore/aft dead zone
            end
        end
    end

    return true
end

function gadget:AllowWeaponTargetCheck(unitID, targetID, weaponNum, weaponDefID)
    -- This is for loaded squads firing from fire platforms
    -- Check if the unit is loaded in a transport with fire_platform_bowtie
    local transportID = Spring.GetUnitTransporter(unitID)
    if not transportID then return true end

    local transportDefID = Spring.GetUnitDefID(transportID)
    if not transportDefID then return true end

    local transportDef = UnitDefs[transportDefID]
    if not transportDef or not transportDef.customParams then return true end

    local cp = transportDef.customParams
    if cp.fire_platform_bowtie == 'true' then
        -- Apply bowtie arc constraint using the TRANSPORT's position/heading
        local tx, ty, tz = Spring.GetUnitPosition(targetID)
        if not tx then return true end

        if not IsInBowtieArc(transportID, tx, ty, tz) then
            return false  -- Target in fore/aft dead zone
        end
    end

    return true
end