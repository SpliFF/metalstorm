-- game_transports.lua — the battle lifecycle: arrivals in, withdrawal out.
--
-- PLAN-metalstorm-transports.md §3.3 (arrivals), §3.4 (withdrawal), §3.5
-- (record, don't rule), §3.6 (stranding / HVT), §3.7 (made loud) — AS AMENDED
-- by §7 (2026-08-19), which promoted this file from flavour to load-bearing.
--
-- WHY THIS FILE EXISTS. The 2026-08-19 ruling removes RTS production from
-- battle maps (PLAN.md goal header, PLAN-metalstorm.md §8). Arrivals are now
-- the ONLY way force enters a battle and departures the only way value leaves
-- it, so §3.3 and §3.4 are the battle's entire in/out economy. There is
-- deliberately NO in-battle "call reinforcements" verb (§7.2): an arrival
-- schedule is fixed when the scenario materialises at staging end, because a
-- request verb is production wearing a hat — it would rebuild exactly the
-- mid-battle replacement loop the ruling removes, and make a battle's outcome
-- a function of world wallet size rather than of what you chose to bring. The
-- world layer's one live control is DIVERSION, which is a world-layer action
-- that changes a scenario before it is materialised, not a battle verb.
--
-- LOAD ORDER CONTRACT: layer -80 — after game_scenario (-90), so GG.Scenario
-- .data exists when this gadget's GameStart runs; before the objectives
-- consumers (game_objectives -50), so `ms_committed_<team>` and the arrival
-- schedule are readable by anything that generates transport objectives
-- (PLAN-metalstorm-objectives §10.5's transport rule).
--
-- NO UNIT SCRIPTS, deliberately (§2's cross-plan constraint). An arrival bulk-
-- creates a transport plus its cargo in one Lua call, which is exactly the
-- suspect class PLAN-bulk-spawn-crash §2 correlates with the release-server
-- crash — but only for LUS-scripted units. Metalstorm ships no scripts/ dir
-- and PLAN-perf M9 measured the script-less bulk path safe at 600 units, so
-- attach here is the train gadget's scriptless path (Spring.UnitAttach onto a
-- piece looked up from the def's `transport_links`), never the airship def
-- header's QueryTransport/AttachUnit unit-script contract.
--
-- WHAT THIS FILE DOES NOT DO
--   * It does not rule on the war's terminal condition (§3.5). Wars §7's
--     machinery had just stabilised after the D18/D19/D20 sequence; this
--     gadget RECORDS which ending happened (`ms_outcome_<team>`) and the world
--     layer prices it (§7.5's payout table). A withdrawing side stops
--     contesting, so the opponent completes its hold through the existing path.
--   * It does not compute transit time (§7.4). The battle side receives only a
--     resolved `eta` frame per arrival; edge weights are world-layer tuning.
--   * It does not model interception in transit (§7.6 defers to v2).
--   * It does not settle escrow. `ms_withdrawn_*` / `ms_outcome_*` /
--     `ms_committed_*` are the keys GG.Authority.Stake/SettleEscrow and the
--     world ledger read (§7.3); they live in rulesParams so SG6's economy-grid
--     prefix-filtered dump carries them with zero extra plumbing.
--
-- SCENARIO SCHEMA THIS ADDS (the world↔battle seam — §3.1)
--
--     sides = {
--       { faction = 'union', team = 4,
--         expeditionary = true,          -- §7.1: this side ARRIVED here
--         departure = { x = 8192, z = 15800, radius = 700 } },  -- optional
--       { faction = 'compact', team = 0 },      -- home defender: not expeditionary
--     },
--
--     arrivals = {
--       { id       = 'union_wave_1',
--         team     = 4,                    -- team id, or a faction key in `sides`
--         kind     = 'air',                -- 'train' | 'air' | 'sea'
--         def      = 'fable_airship',      -- optional; DEFAULT_DEF_BY_KIND otherwise
--         eta      = 5400,                 -- sim frame the transport ENTERS the map
--         entry    = { x = 8192, z = 15800 },
--         dropZone = { x = 8192, z = 11000 },
--         cargo    = { { def = 'ms_soldiers_s1', count = 2 } },
--         dropRadius = 450,                -- OPTIONAL; default 200, sea 450
--         order    = { cmd = 'FIGHT', x = 8192, z = 8192 },   -- OPTIONAL, see below
--       },
--     }
--
-- TERRAIN vs KIND (2026-09-10 review): an arrival is refused at load when its
-- geometry cannot suit its carrier — a `sea` wave needs water at least
-- `minWaterDepth` deep at BOTH its entry and its drop zone (it stops
-- offshore; the cargo is unloaded within `dropRadius`, so put the drop zone
-- within that of a beach); a `train` wave needs dry ground at both; an `air`
-- wave needs a drop zone that suits its CARGO (dry ground unless every cargo
-- def is naval). See terrainProblem() for the exact rules.
--
-- `order` is optional AND its absence is a choice: endtoend D20 finding 1 is
-- that units with no orders never move, which is why the field exists at all
-- and why an arrival without one is WARNed at validation rather than silently
-- accepted.
--
-- PROGRAMMATIC SEAM, mirroring GG.Train.Couple beside CMD_COUPLE:
-- `GG.Transports.ScheduleArrival(spec)`. The scenario path is just a loop over
-- `arrivals` calling it. This is the hook the world layer / GM tools call
-- later. It is NOT reachable from a player order — see §7.2 above.

function gadget:GetInfo()
    return {
        name    = "Transports",
        desc    = "Battle lifecycle — reinforcement arrivals, withdrawal, stranding, outcome",
        author  = "metalstorm",
        date    = "2026",
        license = "GPL v2",
        layer   = -80,             -- after scenario (-90), before objectives (-50)
        enabled = true,
    }
end

if not gadgetHandler:IsSyncedCode() then
    return false
end

local Tick = VFS.Include("LuaRules/Gadgets/tick.lua")

-- ============================================================
-- Constants
-- ============================================================

local PUBLIC_LOS = { public = true }

-- Same low-speed gate the train's T5 unload uses (game_train.lua's
-- MAX_UNLOAD_SPEED): a transport still moving is not "arrived".
local MAX_UNLOAD_SPEED = 0.5          -- elmo/frame

local ARRIVE_RADIUS = 200             -- elmos: "the transport reached its dropZone"
-- A SEA arrival stops OFFSHORE: the SHIP move class needs 12 elmos of water
-- (gamedata/moveinfo.tdf minwaterdepth), so a landing ship's drop zone is
-- necessarily a few hundred elmos out from the beach its cargo has to be
-- unloaded onto, and a 200-elmo unload radius would find no dry ground for
-- a single squad — the wave then re-issues UNLOAD_UNITS every retry period
-- for the rest of the war. An arrival may override with `dropRadius`.
local SEA_ARRIVE_RADIUS = 450
local DEFAULT_DEPARTURE_RADIUS = 700  -- elmos, when a side declares no radius
local UNLOAD_RETRY_FRAMES = 300       -- re-issue unload if cargo is still aboard

-- THE BEACHING FALLBACK (2026-09-17). Widening the unload radius to
-- SEA_ARRIVE_RADIUS was necessary and NOT sufficient: measured on a live run of
-- scenarios/pelagic_landing.lua, a landing ship sails its lane, reaches its
-- drop zone, is issued CMD_UNLOAD_UNITS, and the engine DOES decompose it into
-- a concrete CMD_UNLOAD_UNIT at a dry square — and then nothing happens, for
-- the rest of the war. CTransportCAI wants the hull close enough to the drop
-- square to set a passenger down, and a SHIP cannot get closer than the
-- shoreline; so the ship oscillates at 0.2 elmo/frame between the drop zone
-- and the beach, holding its cargo, forever. Three sea waves in one match, all
-- three stuck, 12000 frames in: the reinforcements never arrive and nothing in
-- the log says why.
--
-- So after this many retries the GADGET puts the cargo ashore itself, with the
-- same Spring.UnitDetach + Spring.SetUnitPosition pair game_train.lua uses for
-- its own scriptless drop. It is a fallback, not the primary path: the engine
-- gets its chances first, and an air or train wave (both of which do unload
-- correctly — the same live run's airship emptied itself on the first try)
-- never reaches this code.
local BEACH_AFTER_RETRIES = 3

-- How far from the stalled hull to look for somewhere to put people down, and
-- how finely. Bounded by the arrival's own `dropRadius`.
local BEACH_SCAN_STEP = 40
local BEACH_SPREAD = 48               -- elmos between beached passengers

-- Departures and guards do not run before this frame. Two reasons, one gate:
-- the frame-60 guards read the STAGED board (game_scenario stages at GameStart
-- and resolves deferred objectives at frame 30), and a scenario that parks its
-- transports near the map edge must not have them evaporate into their own
-- default departure zone on frame 1.
local CHECK_FRAME = 60

-- Departure/arrival polling cadence. D15: accrue against elapsed frames, never
-- `frame % p` — a skipped tick never arrives late, it never arrives at all.
-- Observation policy (tick.due, not tick.count): "is this transport in its
-- departure zone" is a fact about now, and re-running it k times after a skip
-- would invent k samples out of one.
local POLL_PERIOD = 15

local DEFAULT_DEF_BY_KIND = {
    air   = 'fable_airship',
    sea   = 'ms_landing_ship',
    train = 'fable_train_troop',
}

-- §7.5's withdrawal threshold. Below it a side that got SOMETHING out is
-- `routed`, not `withdrew` — the point is to make "when to cut losses" a
-- judgement with a wrong answer instead of a label the world layer cannot see.
local WITHDRAW_FRACTION = 0.5

-- ============================================================
-- State
-- ============================================================

local scheduled = {}        -- id -> arrival spec (validated, team resolved)
local pending = {}          -- array of scheduled ids not yet spawned, eta-sorted
local inFlight = {}         -- transportID -> { arrivalID, cargo = {unitID...}, unloadedAt }
local departureZones = {}   -- team -> { x, z, radius } (== objectives' extractArea, §7.10)
local expeditionary = {}    -- team -> true (§7.1)
local committed = {}        -- team -> committed force, in cargo units
local withdrawnUnits = {}   -- team -> count
local withdrawnTransports = {}
local withdrawnStrength = {}  -- team -> Σ hp/maxHp of the units that got out
local transportsAlive = {}  -- team -> count of live is_transport units
local stranded = {}         -- team -> true
local outcomes = {}         -- team -> 'held'|'withdrew'|'routed'|'annihilated'
local invalidArrivals = 0
local nextAutoID = 1
local checked = false
local outcomesPublished = false
local pollGate = Tick.new(POLL_PERIOD)

-- name -> true, built once at GameStart exactly like game_scenario's
-- buildKnownDefNames (UnitDefs is ID-indexed only in this engine's bindings).
local knownDefs = nil
local defByName = nil

-- ============================================================
-- Helpers
-- ============================================================

local function commaList(t)
    return table.concat(t, ', ')
end

local function buildDefTables()
    knownDefs, defByName = {}, {}
    for _, def in pairs(UnitDefs or {}) do
        knownDefs[def.name] = true
        defByName[def.name] = def
    end
end

--- Is this def a carrier? §3.6's single key: `is_transport = '1'` on the def.
--- One customparam, not a per-consumer def list, so UI, AI and gadgets all key
--- off the same thing. Falls back to `canload` (the engine's own gate) so a def
--- that gains transport capability without the tag is still counted rather than
--- silently invisible to stranding.
local function defIsTransport(def)
    if not def then return false end
    local cp = def.customParams or def.customparams
    if cp and (cp.is_transport == '1' or cp.is_transport == true) then return true end
    return (def.isTransport == true) or (def.transportCapacity or 0) > 0
end

local function unitIsTransport(unitID)
    local defID = Spring.GetUnitDefID(unitID)
    return defID ~= nil and defIsTransport(UnitDefs[defID])
end

--- §7.7's SLOT COST — but computed the way the ENGINE computes it, which is
--- the whole reason this function exists rather than a constant 1.
---
--- CUnit::AttachUnit accrues `transportCapacityUsed += unit->xsize /
--- SPRING_FOOTPRINT_SCALE` and CanTransport refuses once that reaches the
--- carrier's `transportCapacity` (Sim/Units/Unit.cpp:2586,2684). So a slot is
--- one footprint unit, and a def's cost is its `footprintX`.
---
--- §7.7 asked for cost to rise with scale, and it does: units/_builder.lua
--- gives a class `baseFootprint + (s - 1)`, so an s1 squad costs 2 slots and
--- an s4 formation costs 5. The plan's own numbering (s1 = 1 … s4 = 4) was a
--- DIFFERENT scale for the same monotone idea, and the difference was not
--- academic — measured on a headless `crossing_standoff`, a wave this file
--- had validated as "2 slots of 2" put ONE of its two squads aboard, because
--- the engine charged 4. A gadget-private slot model that disagrees with the
--- engine does not validate anything; it approves waves the engine silently
--- truncates, which is the exact failure §3.3 wrote "validated against the
--- manifest at LOAD time, not trusted" to prevent. The engine's arithmetic
--- wins, and §7.7's intent (heavy is what you struggle to extract) survives
--- intact under it.
---
--- A squad is still ONE cargo item regardless of member count — that was
--- settled in PLAN-archive/PLAN-metalstorm-squad-transport.md and is
--- unchanged; what changes is only how many SLOTS the one item costs.
---
--- Defs with no footprint fall back to `ms_scale`, then to 1.
local function slotCost(def)
    if not def then return 1 end
    local fp = tonumber(def.xsize)
    if fp and fp > 0 then return math.max(1, math.floor(fp / 2)) end
    fp = tonumber(def.footprintX or def.footprintx)
    if fp and fp > 0 then return math.floor(fp) end
    local cp = def.customParams or def.customparams or {}
    local scale = tonumber(cp.ms_scale)
    if scale and scale >= 1 then return math.floor(scale) end
    return 1
end

local function slotCapacity(def)
    if not def then return 0 end
    return math.max(0, math.floor(tonumber(def.transportCapacity or 0) or 0))
end

local function dist2(x1, z1, x2, z2)
    local dx, dz = x1 - x2, z1 - z2
    return dx * dx + dz * dz
end

local function pointOnMap(p)
    if type(p) ~= 'table' then return false end
    local x, z = tonumber(p.x), tonumber(p.z)
    if not x or not z then return false end
    local w = (Game and Game.mapSizeX) or 0
    local h = (Game and Game.mapSizeZ) or 0
    if w <= 0 or h <= 0 then return true end   -- unknown map extent: don't invent a failure
    return x >= 0 and x <= w and z >= 0 and z <= h
end

--- Ground height at a point, or nil when the engine cannot answer (a mock
--- with no heightmap, a pre-map state). nil disables the terrain checks
--- rather than inventing a verdict.
local function groundAt(p)
    if not Spring.GetGroundHeight then return nil end
    local x, z = tonumber(p.x), tonumber(p.z)
    if not x or not z then return nil end
    return Spring.GetGroundHeight(x, z)
end

--- A def that can only exist afloat: the SHIP/SUB classes publish a positive
--- `minWaterDepth`; everything that walks or drives publishes 0 (and air
--- publishes nothing that matters — it lands anywhere).
local function defNeedsWater(def)
    return def ~= nil and (tonumber(def.minWaterDepth) or 0) > 0
end

--- THE TERRAIN-VS-KIND CHECK. An arrival's entry point and drop zone have to
--- suit the carrier's own movement class, or the wave never happens and says
--- nothing: a landing ship created on dry ground is refused by CreateUnit
--- (nil, no log line), a landing ship whose drop zone is inland never
--- "arrives" and re-issues its unload forever, an airship told to set an
--- infantry squad down in open water drowns it. None of those is an error the
--- engine reports, which is exactly the class §3.3's "validated at LOAD time,
--- not trusted" was written for. Returns nil when fine, else a reason.
---
---   sea   — entry AND drop zone under water, and at least as deep as the
---           carrier's `minWaterDepth` (SHIP = 12 elmos in moveinfo.tdf).
---   train — entry and drop zone on land: a land train drives the whole way.
---           There is no rail network in the map data (roads.lua carries
---           highway/road/track classes only), so "a rail platform at the
---           entry" cannot be checked; it is documented as the author's job.
---   air   — the drop zone must suit the CARGO: dry ground unless every cargo
---           def is itself a floater (a landing ship can be lifted onto water
---           by nothing this game ships, but the rule is stated once).
---
--- When `Spring.TestMoveOrder` is available (the live engine) the carrier is
--- additionally asked whether it could stand at its entry point at all —
--- the engine's own passability answer, which also covers steepness and
--- depth curves this file does not model.
local function terrainProblem(kind, carrier, entry, dropZone, cargoDefs)
    local he, hd = groundAt(entry), groundAt(dropZone)
    if he == nil or hd == nil then return nil end
    if kind == 'sea' then
        local depth = math.max(0, tonumber(carrier.minWaterDepth) or 0)
        if he >= 0 then return 'sea entry point is on dry ground (height ' .. math.floor(he) .. ')' end
        if -he < depth then
            return string.format('sea entry point is too shallow for %s (%d of %d elmos)',
                                 carrier.name, math.floor(-he), depth)
        end
        if hd >= 0 then return 'sea dropZone is on dry ground (height ' .. math.floor(hd) .. ') — a ship stops offshore' end
        if -hd < depth then
            return string.format('sea dropZone is too shallow for %s (%d of %d elmos)',
                                 carrier.name, math.floor(-hd), depth)
        end
    elseif kind == 'train' then
        if he < 0 then return 'train entry point is under water' end
        if hd < 0 then return 'train dropZone is under water' end
    else
        local allFloat = #cargoDefs > 0
        for _, d in ipairs(cargoDefs) do
            if not defNeedsWater(d) then allFloat = false end
        end
        if #cargoDefs > 0 and not allFloat and hd < 0 then
            return 'air dropZone is over water (height ' .. math.floor(hd) .. ') but the cargo is not naval'
        end
        if allFloat and hd >= 0 then
            return 'air dropZone is on dry ground but every cargo def needs water'
        end
    end
    -- The engine's own passability answer for the entry square, which also
    -- covers steepness and depth curves this file does not model.
    --
    -- NOT FOR AIR (2026-09-17, found on the first live run of
    -- scenarios/pelagic_landing.lua). `Spring.TestMoveOrder` asks whether the
    -- def's GROUND MoveDef could stand somewhere. An aircraft has no
    -- movementclass at all — fable_airship is `canfly = true`, category
    -- 'AIR MOBILE', no movedef — so the engine answers false for every square
    -- on the map that is not incidentally walkable, and an air wave entering
    -- over open sea (which is where aircraft enter from, on an archipelago)
    -- was refused at load with a reason that reads like a content bug. An
    -- air arrival's geometry constraint is the DROP ZONE suiting its cargo,
    -- which is checked above; its entry point has none.
    if kind ~= 'air' and Spring.TestMoveOrder and carrier.id then
        local ex, ez = tonumber(entry.x), tonumber(entry.z)
        local ok = Spring.TestMoveOrder(carrier.id, ex, he, ez, 0, 0, 0, true, false, true)
        if ok == false then
            return string.format('%s cannot stand at the entry point (%d, %d) — the engine refuses the square',
                                 carrier.name, ex, ez)
        end
    end
    return nil
end

--- §3.3's "team, or side key, resolved like war_sides". A numeric team passes
--- through; a string is looked up as a faction key in the scenario's `sides`
--- (the first side carrying it wins, which is how a multi-team faction reads).
local function resolveTeam(scn, team)
    if type(team) == 'number' then return team end
    if type(team) ~= 'string' then return nil end
    for _, s in ipairs((scn and scn.sides) or {}) do
        if s.faction == team and type(s.team) == 'number' then return s.team end
    end
    return nil
end

local function liveOccupiedTeams()
    -- Same filter game_scenario's §7.4/§7.5 checks use: the engine materialises
    -- every team index up to the highest the launch named, so a room seating
    -- its two sides on 0 and 4 also gets 1-3 — real, live, and nobody's.
    -- GetTeamInfo's leader is -1 for those and >= 0 for a team with a player
    -- or an AI.
    local gaia = Spring.GetGaiaTeamID and Spring.GetGaiaTeamID() or nil
    local live = {}
    for _, teamID in ipairs(Spring.GetTeamList() or {}) do
        local _, leader = Spring.GetTeamInfo(teamID)
        if teamID ~= gaia and leader ~= nil and leader >= 0 then live[teamID] = true end
    end
    return live
end

--- Nearest point on the map edge to (x, z). The default departure zone when a
--- side declares none: you leave the way you came. Deliberately NOT the side's
--- staging centroid — a transport parked with its staged army would then be
--- standing in its own departure zone and would depart on the first poll.
local function nearestEdgePoint(x, z)
    local w = (Game and Game.mapSizeX) or 0
    local h = (Game and Game.mapSizeZ) or 0
    if w <= 0 or h <= 0 then return { x = x, z = z, radius = DEFAULT_DEPARTURE_RADIUS } end
    local best, bx, bz = x, 0, z            -- west
    if w - x < best then best, bx, bz = w - x, w, z end
    if z < best then best, bx, bz = z, x, 0 end
    if h - z < best then best, bx, bz = h - z, x, h end
    return { x = bx, z = bz, radius = DEFAULT_DEPARTURE_RADIUS }
end

-- ============================================================
-- Arrival validation (§3.3 / §3.7's war_arrival_invalid)
-- ============================================================

--- Validate one arrival spec against the staged board. Returns a normalised
--- copy, or nil + reason. §3.3: cargo defs are validated against the shipped
--- def names exactly like staged units, and capacity is validated against the
--- manifest arithmetic at LOAD time rather than trusted — a half-staged arrival
--- is worse than a dropped one, so a bad arrival is counted, named, and
--- dropped whole.
local function validateArrival(scn, spec)
    if type(spec) ~= 'table' then return nil, 'not a table' end

    local team = resolveTeam(scn, spec.team)
    if team == nil then
        return nil, 'unresolvable team ' .. tostring(spec.team)
    end

    local kind = spec.kind or 'air'
    local defName = spec.def or DEFAULT_DEF_BY_KIND[kind]
    if not defName then
        return nil, 'unknown kind "' .. tostring(kind) .. '" and no explicit def'
    end
    if not knownDefs[defName] then
        return nil, 'unknown transport def "' .. tostring(defName) .. '"'
    end
    local carrier = defByName[defName]
    if not defIsTransport(carrier) then
        return nil, 'def "' .. defName .. '" is not a transport (no is_transport, no capacity)'
    end

    local eta = tonumber(spec.eta)
    if not eta or eta < 0 then
        return nil, 'missing or negative eta'
    end

    if not pointOnMap(spec.entry) then
        return nil, 'entry point is not on the map'
    end
    if not pointOnMap(spec.dropZone) then
        return nil, 'dropZone is not on the map'
    end

    local cargo, slots, cargoDefs = {}, 0, {}
    for _, c in ipairs(spec.cargo or {}) do
        if not knownDefs[c.def] then
            return nil, 'unknown cargo def "' .. tostring(c.def) .. '"'
        end
        local count = math.max(1, math.floor(tonumber(c.count) or 1))
        slots = slots + slotCost(defByName[c.def]) * count
        cargo[#cargo + 1] = { def = c.def, count = count }
        cargoDefs[#cargoDefs + 1] = defByName[c.def]
    end

    local terrainErr = terrainProblem(kind, carrier, spec.entry, spec.dropZone, cargoDefs)
    if terrainErr then return nil, terrainErr end

    local dropRadius = tonumber(spec.dropRadius)
    if spec.dropRadius ~= nil and (not dropRadius or dropRadius <= 0) then
        return nil, 'dropRadius must be a positive number'
    end
    dropRadius = dropRadius or (kind == 'sea' and SEA_ARRIVE_RADIUS or ARRIVE_RADIUS)

    local capacity = slotCapacity(carrier)
    if slots > capacity then
        return nil, string.format(
            'cargo needs %d slot(s) (footprint cost, the engine\'s own arithmetic — §7.7) but %s carries %d',
            slots, defName, capacity)
    end

    local id = spec.id
    if type(id) ~= 'string' or id == '' then
        id = string.format('arrival_%d', nextAutoID)
        nextAutoID = nextAutoID + 1
    end
    if scheduled[id] then
        return nil, 'duplicate arrival id "' .. id .. '"'
    end

    return {
        id = id, team = team, kind = kind, def = defName,
        eta = math.floor(eta),
        entry = { x = spec.entry.x, z = spec.entry.z },
        dropZone = { x = spec.dropZone.x, z = spec.dropZone.z },
        cargo = cargo, slots = slots,
        dropRadius = dropRadius,
        order = spec.order,
        cargoUnits = 0,           -- filled at spawn
    }
end

--- The while-you-were-away digest's transport line (game_warlog.lua). Every
--- emit is guarded: the digest is an observer, and a battle must not lose its
--- lifecycle because a log line could not be composed.
local function logEvent(subject, detail, team)
    if GG.WarLog and GG.WarLog.Emit then
        GG.WarLog.Emit('transport', subject, detail, team)
    end
end

-- ============================================================
-- Arrival execution (§3.3)
-- ============================================================

local function createAt(defName, x, z, facing, team)
    local y = Spring.GetGroundHeight(x, z)
    return Spring.CreateUnit(defName, x, y, z, facing or 'south', team)
end

--- The def's modelled attach pieces, in `transport_links` order. Scriptless:
--- the piece numbers come from the live model, so a def that names no links
--- (or names ones the model does not have) falls through to the engine's
--- default attach rather than failing the arrival.
local function attachPieces(transportID, def)
    local cp = (def and (def.customParams or def.customparams)) or {}
    local links = cp.transport_links
    if type(links) ~= 'string' or links == '' then return {} end
    local map = Spring.GetUnitPieceMap and Spring.GetUnitPieceMap(transportID) or nil
    if type(map) ~= 'table' then return {} end
    local out = {}
    for name in links:gmatch('[^,%s]+') do
        local piece = map[name]
        if piece then out[#out + 1] = piece end
    end
    return out
end

local function spawnArrival(a)
    local transportID = createAt(a.def, a.entry.x, a.entry.z, 'south', a.team)
    if transportID == nil then
        -- The engine refuses a unit whose ground is already occupied and says
        -- so ONLY by returning nil — no error, no log line (the same trap
        -- game_scenario's stageUnits documents). Say it here, or an arrival
        -- silently never happens.
        Spring.Echo('[game_transports] WARNING: arrival "' .. a.id ..
                    '" could not spawn its ' .. a.def .. ' at (' ..
                    tostring(a.entry.x) .. ', ' .. tostring(a.entry.z) ..
                    ') — the entry point is blocked. Wave dropped.')
        -- The wave never entered, so it was never committed: leave it in the
        -- §7.5 denominator and a side that extracts everything it actually
        -- had still reads `routed`. Take the cargo back out and republish.
        local n = 0
        for _, c in ipairs(a.cargo) do n = n + c.count end
        if n > 0 and committed[a.team] then
            committed[a.team] = math.max(0, committed[a.team] - n)
            Spring.SetTeamRulesParam(a.team, 'ms_committed_' .. a.team,
                                     committed[a.team], PUBLIC_LOS)
        end
        logEvent(a.id, 'blocked', a.team)
        return nil
    end

    local pieces = attachPieces(transportID, defByName[a.def])
    local cargoIDs = {}
    for _, c in ipairs(a.cargo) do
        for _ = 1, c.count do
            -- Spawned ON the entry point, then attached in the same tick:
            -- nothing pathfinds, so the offset only has to be legal ground.
            local cid = createAt(c.def, a.entry.x, a.entry.z, 'south', a.team)
            if cid ~= nil then
                cargoIDs[#cargoIDs + 1] = cid
                local piece = pieces[#cargoIDs] or -1
                Spring.UnitAttach(transportID, cid, piece)
            end
        end
    end

    Spring.GiveOrderToUnit(transportID, CMD.MOVE,
        { a.dropZone.x, Spring.GetGroundHeight(a.dropZone.x, a.dropZone.z), a.dropZone.z }, 0)

    a.cargoUnits = #cargoIDs
    inFlight[transportID] = { arrivalID = a.id, cargo = cargoIDs,
                              unloadOrderedAt = nil, reachedDrop = false }

    -- §3.7's "made loud", applied to the one step that can fail silently.
    -- Spring.UnitAttach refuses a passenger the def cannot carry (footprint vs
    -- transportsize, mass, a link piece the model does not have) and says so
    -- only by not attaching it — no error, no return value. An arrival whose
    -- cargo never got aboard still flies its route and still "unloads", so
    -- without this line the wave lands empty and the squads it was carrying
    -- stand on the entry point for the rest of the war.
    local aboard = Spring.GetUnitIsTransporting(transportID) or {}
    if #aboard ~= #cargoIDs then
        Spring.Echo(string.format(
            '[game_transports] WARNING: arrival "%s" got %d of %d cargo unit(s) ' ..
            'aboard its %s — the engine refused the rest (footprint vs ' ..
            'transportsize, mass, or a missing transport_links piece). They will ' ..
            'be ordered from the entry point instead of the drop zone.',
            a.id, #aboard, #cargoIDs, a.def))
    end
    Spring.Echo(string.format(
        '[game_transports] arrival "%s": %s + %d cargo unit(s) for team %d entering at (%d, %d)',
        a.id, a.def, #cargoIDs, a.team, a.entry.x, a.entry.z))
    logEvent(a.id, 'entered', a.team)
    return transportID
end

--- Nearest dry, passable square to (x, z) within `radius`, or nil.
--- `Spring.TestMoveOrder` is consulted for the passenger's own def when the
--- engine offers it, so an infantry squad is not beached on a cliff that only
--- looks like land in the heightmap.
local function findBeach(x, z, radius, passengerDefID)
    for r = BEACH_SCAN_STEP, radius, BEACH_SCAN_STEP do
        local steps = math.max(8, math.floor(2 * math.pi * r / BEACH_SCAN_STEP))
        for i = 0, steps - 1 do
            local a = (i / steps) * 2 * math.pi
            local px, pz = x + r * math.cos(a), z + r * math.sin(a)
            if px > 0 and pz > 0 and px < Game.mapSizeX and pz < Game.mapSizeZ then
                local h = Spring.GetGroundHeight(px, pz)
                if h and h > 1 then
                    local ok = true
                    if Spring.TestMoveOrder and passengerDefID then
                        ok = Spring.TestMoveOrder(passengerDefID, px, h, pz,
                                                  0, 0, 0, true, false, true) ~= false
                    end
                    if ok then return px, pz, h end
                end
            end
        end
    end
    return nil
end

--- Put a stalled sea wave's cargo on the beach. See BEACH_AFTER_RETRIES.
--- Returns the number of passengers actually set down.
local function beachCargo(transportID, aboard, radius)
    local tx, _, tz = Spring.GetUnitPosition(transportID)
    if tx == nil then return 0 end
    local placed = 0
    for i, cid in ipairs(aboard) do
        if Spring.ValidUnitID(cid) and Spring.GetUnitHealth(cid) then
            local bx, bz = findBeach(tx, tz, radius, Spring.GetUnitDefID(cid))
            if bx then
                -- Fan the squad out rather than stacking it on one square: a
                -- unit spawned inside another unit's footprint is refused or
                -- trapped, and a beachhead that lands in a single pile is a
                -- beachhead one artillery shell deletes.
                --
                -- The fan is PULLED BACK until it is still on land. A beach is
                -- a line, not a disc: the first draft of this spread put a
                -- passenger 48 elmos seaward of the only dry square it had
                -- found and drowned it, which is the bug this whole fallback
                -- exists to stop happening by other means.
                local a = (i / math.max(1, #aboard)) * 2 * math.pi
                local sx, sz = bx, bz
                local spread = BEACH_SPREAD
                while spread >= 8 do
                    local px = bx + spread * math.cos(a)
                    local pz = bz + spread * math.sin(a)
                    local ph = Spring.GetGroundHeight(px, pz)
                    if ph and ph > 1 then sx, sz = px, pz; break end
                    spread = spread / 2
                end
                Spring.UnitDetach(cid)
                Spring.SetUnitPosition(cid, sx, sz)
                placed = placed + 1
            end
        else
            -- Died in transit; detach anyway so the wave can finish.
            pcall(Spring.UnitDetach, cid)
        end
    end
    return placed
end

--- The transport reached its dropZone: unload, then apply the arrival's
--- `order` to the cargo. Both halves are D20's finding — a unit nobody ordered
--- never moves, so an arrival that unloads and stops is theatre.
local function serviceInFlight(frame)
    for transportID, f in pairs(inFlight) do
        local a = scheduled[f.arrivalID]
        local x, _, z = Spring.GetUnitPosition(transportID)
        if x == nil or a == nil then
            inFlight[transportID] = nil                 -- died or was cancelled in transit
        else
            local aboard = Spring.GetUnitIsTransporting(transportID) or {}
            local radius = a.dropRadius or ARRIVE_RADIUS
            local atDrop = dist2(x, z, a.dropZone.x, a.dropZone.z) <= radius * radius
            if atDrop then f.reachedDrop = true end

            -- "Empty" is NOT the same question as "arrived", and conflating
            -- them is how a wave deletes itself. An arrival whose attach was
            -- refused (see the WARNING at spawn) is empty from its first frame,
            -- and clearing it here would hand the carrier to §3.4's departure
            -- poll while it is still sitting on its own entry point — which,
            -- for a side whose entry is near its departure zone, withdraws the
            -- transport empty, seconds after it arrived, for no reason a player
            -- could ever see. So a wave stops being a wave only once it has
            -- REACHED THE DROP ZONE.
            if f.reachedDrop and #aboard == 0 then
                -- Unloaded. Apply the declared order to everything that arrived
                -- and stop tracking; the transport is now an ordinary §3.4
                -- withdrawal asset and target (Capture 5: it STAYS on the field).
                if a.order then
                    local cmd = CMD[a.order.cmd or 'FIGHT'] or CMD.FIGHT
                    local ox = tonumber(a.order.x) or a.dropZone.x
                    local oz = tonumber(a.order.z) or a.dropZone.z
                    local oy = Spring.GetGroundHeight(ox, oz)
                    for _, cid in ipairs(f.cargo) do
                        -- Guarded: a passenger can die between the wave
                        -- spawning and the wave landing (a carrier shot down
                        -- takes its cargo with it, and an unloaded squad can
                        -- be killed on the drop zone). GiveOrderToUnit on a
                        -- dead id is a hard Lua error, which removes THIS
                        -- gadget for the rest of the war — the whole battle
                        -- lifecycle lost to one unlucky death.
                        if Spring.ValidUnitID(cid) and Spring.GetUnitHealth(cid) then
                            Spring.GiveOrderToUnit(cid, cmd, { ox, oy, oz }, 0)
                        end
                    end
                end
                inFlight[transportID] = nil
                logEvent(a.id, 'landed', a.team)
            elseif atDrop and #aboard > 0 then
                local vx, _, vz = Spring.GetUnitVelocity(transportID)
                local speed = math.sqrt((vx or 0) ^ 2 + (vz or 0) ^ 2)
                if speed <= MAX_UNLOAD_SPEED
                   and (f.unloadOrderedAt == nil
                        or frame - f.unloadOrderedAt >= UNLOAD_RETRY_FRAMES) then
                    f.unloadOrderedAt = frame
                    f.unloadTries = (f.unloadTries or 0) + 1
                    if a.kind == 'sea' and f.unloadTries > BEACH_AFTER_RETRIES then
                        -- The engine has had BEACH_AFTER_RETRIES goes at it and
                        -- the hull is still full. Put them ashore ourselves.
                        local placed = beachCargo(transportID, aboard, radius)
                        Spring.Echo(string.format(
                            '[game_transports] arrival "%s": the engine would not unload it ' ..
                            'after %d attempts — beached %d of %d passenger(s) by hand',
                            a.id, f.unloadTries - 1, placed, #aboard))
                        if placed == 0 then
                            logEvent(a.id, 'stranded', a.team)
                        end
                    else
                        Spring.GiveOrderToUnit(transportID, CMD.UNLOAD_UNITS,
                            { a.dropZone.x, Spring.GetGroundHeight(a.dropZone.x, a.dropZone.z),
                              a.dropZone.z, radius }, 0)
                    end
                end
            end
        end
    end
end

--- §3.3's last clause: an arrival whose eta lands after the war ends is
--- cancelled, not spawned. game_gameover publishes GG.WarState.
local function warIsOver()
    return GG.WarState ~= nil and GG.WarState ~= 'active'
end

local function serviceArrivals(frame)
    if #pending == 0 then return end
    local keep = {}
    for _, id in ipairs(pending) do
        local a = scheduled[id]
        if a and frame >= a.eta then
            if warIsOver() then
                Spring.Echo('[game_transports] arrival "' .. id ..
                            '" cancelled — the war ended before its eta')
                scheduled[id] = nil
            else
                spawnArrival(a)
            end
        elseif a then
            keep[#keep + 1] = id
        end
    end
    pending = keep
end

-- ============================================================
-- Withdrawal (§3.4)
-- ============================================================

--- A transport inside its side's departure zone LEAVES: it and everything it
--- carries are removed from the sim with no wreck and no death FX, and the
--- departure is recorded.
---
--- Deliberately in rulesParams: SG6's economy-grid dump (PLAN-economy-grid §3,
--- a prefix-filtered rulesParams snapshot) then carries withdrawal data with
--- zero extra plumbing, and the world layer's settlement reads the same keys.
---
--- There is NO auto-withdraw macro order. "Withdrawal is a mechanic, not a
--- menu" cuts both ways: load your units, protect the transport, drive it off
--- the field. A convenience order is a UX question for later (§6).
local function depart(transportID, teamID)
    local aboard = Spring.GetUnitIsTransporting(transportID) or {}
    -- Counted BEFORE the loop: destroying a passenger drops it out of the
    -- transporter's manifest, and reading `#aboard` afterwards is then a count
    -- of what is left rather than of what left — which silently zeroes the
    -- world layer's settlement input.
    local carried = #aboard
    -- VALUE, not just a head count. A squad is one sim unit whatever its
    -- member count, and its strength is its health (squad.lua: monotonic
    -- non-increasing), so a side that carries out four squads at 10% is not
    -- extracting four squads' worth of materiel. The world layer's settlement
    -- (§7.3) reads this alongside `_units`; the head count stays the §7.5
    -- threshold input because that is what "committed" is counted in.
    local strength = 0
    for _, cid in ipairs(aboard) do
        local hp, maxHp = Spring.GetUnitHealth(cid)
        if hp and maxHp and maxHp > 0 then strength = strength + hp / maxHp end
    end

    -- LEDGER FIRST, THEN THE DESTRUCTION, and the order is load-bearing.
    -- DestroyUnit runs UnitDestroyed synchronously in every other gadget, and
    -- one of those observers is objectives/escort.lua's transport form, which
    -- asks exactly this counter "did that carrier LEAVE, or was it killed?".
    -- Incrementing afterwards answers "killed" for the one frame in which the
    -- question is asked, which fails the escort the side just won.
    withdrawnUnits[teamID] = (withdrawnUnits[teamID] or 0) + carried
    withdrawnTransports[teamID] = (withdrawnTransports[teamID] or 0) + 1
    withdrawnStrength[teamID] = (withdrawnStrength[teamID] or 0) + strength
    Spring.SetTeamRulesParam(teamID, 'ms_withdrawn_' .. teamID .. '_units',
                             withdrawnUnits[teamID], PUBLIC_LOS)
    Spring.SetTeamRulesParam(teamID, 'ms_withdrawn_' .. teamID .. '_transports',
                             withdrawnTransports[teamID], PUBLIC_LOS)
    Spring.SetTeamRulesParam(teamID, 'ms_withdrawn_' .. teamID .. '_strength',
                             withdrawnStrength[teamID], PUBLIC_LOS)
    logEvent(UnitDefs[Spring.GetUnitDefID(transportID)].name .. ' +' .. carried,
             'withdrew', teamID)

    for _, cid in ipairs(aboard) do
        Spring.DestroyUnit(cid, false, true)     -- no wreck, no death FX
    end
    Spring.DestroyUnit(transportID, false, true)
    Spring.Echo(string.format(
        '[game_transports] team %d withdrew a transport with %d unit(s) ' ..
        '(%d unit(s) / %d transport(s) out so far, of %d committed)',
        teamID, carried, withdrawnUnits[teamID], withdrawnTransports[teamID],
        committed[teamID] or 0))
end

--- A DEPARTURE IS A DELIBERATE ACT, not a fly-through, and the speed gate is
--- what makes that true. §3.4's own wording is "a loaded transport ORDERED
--- INTO its departure zone departs" — a carrier crossing the zone on its way
--- somewhere else was never meant to leave.
---
--- This is not hypothetical tidiness. On a headless `crossing_standoff` with
--- two strategos brains, the AI's region-scoped directives swept each side's
--- parked carrier up with the rest of the force standing in its landing zone
--- and flew it across the map; the route crossed the exit, and the side lost
--- its only way home, empty, about two minutes into the war, for a reason no
--- player could ever have seen. Requiring the carrier to have COME TO REST in
--- the zone (the same MAX_UNLOAD_SPEED gate an arrival's unload uses — a
--- transport still moving is not "arrived") costs an intentional withdrawal
--- nothing: you fly there, you stop, you are gone on the next poll.
local function transportHasSettled(unitID)
    local vx, _, vz = Spring.GetUnitVelocity(unitID)
    local speed = math.sqrt((vx or 0) ^ 2 + (vz or 0) ^ 2)
    return speed <= MAX_UNLOAD_SPEED
end

local function serviceDepartures()
    for teamID, zone in pairs(departureZones) do
        -- Engine-side cylinder test rather than a full team scan: this runs
        -- every POLL_PERIOD frames for every side with a departure zone, and
        -- the zone is a few hundred elmos on a 16k map.
        local near = Spring.GetUnitsInCylinder(zone.x, zone.z, zone.radius, teamID) or {}
        for _, unitID in ipairs(near) do
            if unitIsTransport(unitID) and inFlight[unitID] == nil
               and transportHasSettled(unitID) then
                depart(unitID, teamID)
            end
        end
    end
end

-- ============================================================
-- Stranding (§3.6, as amended by §7.1)
-- ============================================================

--- §7.1 is the whole of this section's subtlety: STRANDING IS AN EXPEDITIONARY
--- PROPERTY ONLY. "You leave by transport or not at all" (Capture 5) is a rule
--- about expeditions, not about people standing in their own town. A faction
--- defending a POI it holds is HOME — its force is garrison, drawn from world
--- holdings at that POI, and it arrives by already being there. Without this
--- split the HVT premise makes every defender's own home a trap, and §3.7's
--- guard fires on every shipped scenario (none stages a transport) and on
--- every defender forever.
---
--- A side is expeditionary iff its `sides` entry says `expeditionary = true`.
local function recountTransports()
    for teamID in pairs(expeditionary) do
        local n = 0
        for _, unitID in ipairs(Spring.GetTeamUnits(teamID) or {}) do
            if unitIsTransport(unitID) then n = n + 1 end
        end
        transportsAlive[teamID] = n
    end
end

local function hasFutureArrival(teamID)
    for _, id in ipairs(pending) do
        local a = scheduled[id]
        if a and a.team == teamID then return true end
    end
    return false
end

--- A side with nothing left on the field is not stranded, it is gone: the
--- distinction matters because a side that deliberately loads its whole army
--- out and departs would otherwise trip the signal on its own success. So
--- stranding requires an army that is still HERE and can no longer leave.
local function hasForceOnField(teamID)
    for _, unitID in ipairs(Spring.GetTeamUnits(teamID) or {}) do
        if not unitIsTransport(unitID) then return true end
    end
    return false
end

local function publishStranded(teamID)
    local strandedNow = expeditionary[teamID]
        and (transportsAlive[teamID] or 0) == 0
        and hasForceOnField(teamID)
        and not hasFutureArrival(teamID)
    if strandedNow and not stranded[teamID] then
        stranded[teamID] = true
        Spring.SetGameRulesParam('ms_stranded_' .. teamID, 1, PUBLIC_LOS)
        Spring.Echo('[game_transports] team ' .. string.format('%d', teamID) ..
                    ' is STRANDED — its last transport is gone and no arrival ' ..
                    'is scheduled, so nothing it still has on the field can leave.')
        logEvent(string.format('team %d', teamID), 'stranded', teamID)
    elseif not strandedNow and stranded[teamID] then
        -- An arrival can un-strand a side (§3.3's reinforcement lane), so the
        -- signal is not a latch.
        stranded[teamID] = nil
        Spring.SetGameRulesParam('ms_stranded_' .. teamID, 0, PUBLIC_LOS)
    end
end

-- ============================================================
-- Outcome (§3.5, vocabulary per §7.5)
-- ============================================================

--- RECORD, DON'T RULE. This gadget adds no terminal condition; it publishes
--- which ending happened and the world layer prices it (§7.5's payout table).
---
---   held         side still has units on the field at terminal
---   withdrew     no live units, and >= WITHDRAW_FRACTION of the committed
---                force departed by transport
---   routed       no live units, >= 1 departure, but under the threshold
---   annihilated  no live units and no recorded departure
---
--- `routed` exists because §3.5 as written labelled "withdrew one squad, then
--- died" and "withdrew the whole army" identically, which made the most
--- interesting decision in the battle — when to cut losses — invisible to the
--- world layer.
---
--- A side with live units AND departures reads `held`: the world layer has
--- `ms_withdrawn_<team>_units` and `ms_committed_<team>` alongside, and prices
--- the partial extraction from those.
local function outcomeFor(teamID)
    local live = Spring.GetTeamUnits(teamID) or {}
    if #live > 0 then return 'held' end
    local out = withdrawnUnits[teamID] or 0
    if out == 0 then return 'annihilated' end
    local total = committed[teamID] or 0
    if total > 0 and out >= total * WITHDRAW_FRACTION then return 'withdrew' end
    if total == 0 then return 'withdrew' end   -- nothing was committed; it all left
    return 'routed'
end

local function publishOutcomes()
    if outcomesPublished then return end
    outcomesPublished = true
    for teamID in pairs(liveOccupiedTeams()) do
        local o = outcomeFor(teamID)
        outcomes[teamID] = o
        Spring.SetTeamRulesParam(teamID, 'ms_outcome_' .. teamID, o, PUBLIC_LOS)
        Spring.Echo(string.format('[game_transports] team %d outcome: %s (%d of %d committed got out)',
                                  teamID, o, withdrawnUnits[teamID] or 0, committed[teamID] or 0))
    end
end

-- ============================================================
-- Made loud (§3.7)
-- ============================================================

--- `war_side_stranded` — per-side, not whole-board. The D20 method note is the
--- reason: a guard that only fires on the TOTAL form of a defect reads 0 on
--- the real board (`war_units_unordered` missed 9-of-13 unordered units).
---
--- §7.1 keys it off `expeditionary`. As originally written this guard fired on
--- every shipped scenario — none stages a transport — and on every defender
--- forever, which is a guard that cries wolf and therefore is not a guard.
local function checkSidesCanLeave()
    local live = liveOccupiedTeams()
    local trapped = {}
    for teamID in pairs(expeditionary) do
        if live[teamID] then
            local n = 0
            for _, unitID in ipairs(Spring.GetTeamUnits(teamID) or {}) do
                if unitIsTransport(unitID) then n = n + 1 end
            end
            if n == 0 and not hasFutureArrival(teamID) then
                trapped[#trapped + 1] = string.format('%d', teamID)
            end
        end
    end
    table.sort(trapped)
    Spring.SetGameRulesParam('war_side_stranded', #trapped, PUBLIC_LOS)
    if #trapped == 0 then return end
    Spring.Echo('[game_transports] WARNING: expeditionary team(s) ' ..
                commaList(trapped) .. ' have NO transport on the field and no ' ..
                'scheduled arrival — this side arrived by transport and now ' ..
                'cannot leave, so a withdrawal is impossible for it from the ' ..
                'first frame. Either stage a transport in its force ' ..
                '(PLAN-metalstorm-transports.md §3.2), declare an arrival ' ..
                '(§3.3), or drop `expeditionary` if the side is a home ' ..
                'defender (§7.1).')
end

-- ============================================================
-- Staging
-- ============================================================

--- §7.1's per-side fields, plus §3.4's departure zone. A side with no
--- `departure` gets the nearest map edge to its staged centroid — you leave
--- the way you came — which is documented rather than silent because a
--- departure zone in the wrong place deletes an army.
local function stageSides(scn)
    local centroids = {}
    for _, u in ipairs((scn and scn.units) or {}) do
        if type(u.team) == 'number' then
            local c = centroids[u.team] or { n = 0, sx = 0, sz = 0 }
            local n = math.max(1, math.floor(tonumber(u.count) or 1))
            c.n, c.sx, c.sz = c.n + n, c.sx + (u.x or 0) * n, c.sz + (u.z or 0) * n
            centroids[u.team] = c
        end
    end

    for _, s in ipairs((scn and scn.sides) or {}) do
        local teamID = resolveTeam(scn, s.team)
        if teamID ~= nil then
            if s.expeditionary == true then
                expeditionary[teamID] = true
            end
            local d = s.departure
            if type(d) == 'table' and tonumber(d.x) and tonumber(d.z) then
                departureZones[teamID] = {
                    x = tonumber(d.x), z = tonumber(d.z),
                    radius = tonumber(d.radius) or DEFAULT_DEPARTURE_RADIUS,
                }
            else
                local c = centroids[teamID]
                if c and c.n > 0 then
                    departureZones[teamID] = nearestEdgePoint(c.sx / c.n, c.sz / c.n)
                end
            end
        end
    end

    -- Top-level `departures[]` for a scenario that declares no `sides` block
    -- (the smoke fixtures do not). Same normalisation, authored form wins.
    for _, d in ipairs((scn and scn.departures) or {}) do
        local teamID = resolveTeam(scn, d.team)
        if teamID ~= nil and tonumber(d.x) and tonumber(d.z) then
            departureZones[teamID] = {
                x = tonumber(d.x), z = tonumber(d.z),
                radius = tonumber(d.radius) or DEFAULT_DEPARTURE_RADIUS,
            }
        end
    end
end

--- The denominator of §7.5's withdrawal test: every mobile non-transport unit
--- the side brings to this battle, staged plus scheduled-to-arrive. Buildings
--- are excluded (speed 0) — you do not extract a bunker — and the carriers
--- themselves are excluded because they are the vehicle, not the force
--- (`ms_withdrawn_<team>_transports` counts those separately).
local function computeCommitted(scn)
    for _, u in ipairs((scn and scn.units) or {}) do
        local def = defByName[u.def]
        if type(u.team) == 'number' and def and (def.speed or 0) > 0
           and not defIsTransport(def) then
            local n = math.max(1, math.floor(tonumber(u.count) or 1))
            committed[u.team] = (committed[u.team] or 0) + n
        end
    end
    for _, id in ipairs(pending) do
        local a = scheduled[id]
        for _, c in ipairs(a.cargo) do
            committed[a.team] = (committed[a.team] or 0) + c.count
        end
    end
    for teamID, n in pairs(committed) do
        Spring.SetTeamRulesParam(teamID, 'ms_committed_' .. teamID, n, PUBLIC_LOS)
    end
end

-- ============================================================
-- Public API (§3.3's programmatic seam)
-- ============================================================

GG.Transports = GG.Transports or {}

--- Schedule one arrival. The scenario path is a loop over `arrivals` calling
--- this; the world layer / GM tools call it directly. Returns the arrival id,
--- or nil + reason.
---
--- NOT A PLAYER VERB (§7.2). Nothing in the order flow reaches this, and
--- nothing should: an in-battle reinforcement request is production wearing a
--- hat.
function GG.Transports.ScheduleArrival(spec)
    if knownDefs == nil then buildDefTables() end
    local scn = GG.Scenario and GG.Scenario.data
    local a, err = validateArrival(scn, spec)
    if not a then
        invalidArrivals = invalidArrivals + 1
        Spring.SetGameRulesParam('war_arrival_invalid', invalidArrivals, PUBLIC_LOS)
        Spring.Echo('[game_transports] WARNING: arrival "' ..
                    tostring(spec and spec.id or '?') .. '" dropped — ' .. err ..
                    ' (see PLAN-metalstorm-transports.md §3.3)')
        return nil, err
    end
    if a.order == nil then
        -- D20 finding 1: units with no orders never move. An arrival that
        -- unloads into silence is a wave that never fights.
        Spring.Echo('[game_transports] WARNING: arrival "' .. a.id ..
                    '" declares no `order` — its cargo will sit at the drop ' ..
                    'zone until a player or AI moves it (§3.3).')
    end
    scheduled[a.id] = a
    pending[#pending + 1] = a.id
    table.sort(pending, function(l, r) return scheduled[l].eta < scheduled[r].eta end)
    return a.id
end

--- The slot cost of one cargo item of `defName` — the engine's arithmetic,
--- exposed so a scenario author, a test or the world layer can ask the same
--- question the load-time validator asks instead of re-deriving it.
function GG.Transports.SlotCost(defName)
    if knownDefs == nil then buildDefTables() end
    return slotCost(defByName[defName])
end

function GG.Transports.IsTransport(defID)
    return defIsTransport(UnitDefs[defID])
end

--- The committed force denominator §7.5's threshold is measured against.
function GG.Transports.Committed(teamID) return committed[teamID] or 0 end

function GG.Transports.Withdrawn(teamID)
    return withdrawnUnits[teamID] or 0, withdrawnTransports[teamID] or 0,
           withdrawnStrength[teamID] or 0
end

--- THE EXIT ZONE, under its unified name (§7.10 / objectives §10.3).
---
--- §3.4 calls this a side's "departure zone"; `objectives/extract.lua` calls
--- the same circle `extractArea`, and `objectives/escort.lua` used to call it
--- `destArea`. One idea, three names, drifting apart. `extractArea` wins — the
--- full reasoning lives in escort.lua's header, and this accessor is the seam
--- that makes the two halves literally the same rectangle of ground rather
--- than two hand-copied coordinate pairs that can silently diverge.
---
--- Returns `{ x, z, r }` in the objectives' area shape (note `r`, not
--- `radius`), or nil for a side with no zone.
function GG.Transports.ExtractArea(teamID)
    local z = departureZones[teamID]
    if not z then return nil end
    return { x = z.x, z = z.z, r = z.radius }
end

--- Every live carrier this team owns. The objectives generator's transport
--- rule escorts these out (§10.5); a nil/empty answer is the honest one for a
--- side that has none, not an error.
function GG.Transports.LiveTransports(teamID)
    local out = {}
    for _, unitID in ipairs(Spring.GetTeamUnits(teamID) or {}) do
        if unitIsTransport(unitID) then out[#out + 1] = unitID end
    end
    return out
end

--- Arrivals that are on the map RIGHT NOW and have not finished unloading —
--- the "defend an arrival point" half of §10.5's rule. Each entry is
--- `{ transportID, arrivalID, team, dropZone = { x, z } }`.
---
--- Deliberately only the in-flight ones, not the whole schedule: an objective
--- to defend a wave that has not entered the map yet would point at empty
--- ground for minutes, and §7.2 keeps the schedule out of players' hands
--- anyway.
function GG.Transports.InFlightArrivals()
    local out = {}
    for transportID, f in pairs(inFlight) do
        local a = scheduled[f.arrivalID]
        if a then
            out[#out + 1] = {
                transportID = transportID, arrivalID = a.id, team = a.team,
                dropZone = { x = a.dropZone.x, z = a.dropZone.z },
            }
        end
    end
    table.sort(out, function(l, r) return l.transportID < r.transportID end)
    return out
end

function GG.Transports.IsExpeditionary(teamID) return expeditionary[teamID] == true end

function GG.Transports.IsStranded(teamID) return stranded[teamID] == true end

--- Published at GameOver; nil before then (there is no outcome until there is
--- an ending).
function GG.Transports.Outcome(teamID) return outcomes[teamID] end

-- ============================================================
-- The `world_commit` modoption (the world↔battle escrow seam)
-- ============================================================
-- The lobby's staging sweep hands a materialised war the world's committed
-- force as ONE gadget-visible string (WorldEscrow's
-- EncodeWorldCommitModOption, the same modoptions channel `war_sides` rides):
--
--     world_commit = "<sideKey>:<transports>:<squads>:<stagingId>"
--
-- The world knows no map coordinate — §7.8's projection is the scenario's
-- job — so geometry is derived HERE: the wave drops at the committing side's
-- start position and enters from the nearest map edge (you arrive the way
-- you would leave, §3.4's default in reverse). Every wave goes through the
-- same ScheduleArrival an authored arrival takes, so validation, the §7.7
-- slot arithmetic and the §7.5 committed census treat world force and
-- authored force identically — and the committing side is marked
-- expeditionary (§7.1) whatever the reused scenario says about it.

local WORLD_COMMIT_CARGO_DEF   = 'ms_soldiers_s1'  -- the world counts squads
local WORLD_COMMIT_ETA_FIRST   = 90                -- frames: inbound at start
local WORLD_COMMIT_ETA_SPACING = 90                -- frames between the wave's transports

local function scheduleWorldCommit(scn)
    local opts = (Spring.GetModOptions and Spring.GetModOptions()) or {}
    local raw = opts.world_commit
    if type(raw) ~= 'string' or raw == '' then return end
    local side, nTransports, nSquads =
        string.match(raw, '^([^:]+):(%d+):(%d+):%d+$')
    if side == nil then
        Spring.Echo('[game_transports] WARNING: world_commit "' .. raw ..
                    '" is not <side>:<transports>:<squads>:<stagingId> — ' ..
                    'no world arrivals scheduled')
        return
    end
    nTransports, nSquads = tonumber(nTransports), tonumber(nSquads)
    if nTransports < 1 then return end
    local teamID = resolveTeam(scn, side)
    if teamID == nil then
        Spring.Echo('[game_transports] WARNING: world_commit side "' ..
                    tostring(side) ..
                    '" fields no team in this scenario — no world arrivals')
        return
    end
    -- §7.1: force that ARRIVED here is expeditionary. The escrowed side can
    -- be stranded, and its withdrawal is what the world settles against.
    expeditionary[teamID] = true

    local sx, sz
    if Spring.GetTeamStartPosition then
        local x, _, z = Spring.GetTeamStartPosition(teamID)
        sx, sz = x, z
    end
    if not sx or sx <= 0 then
        sx = (Game and Game.mapSizeX or 0) / 2
        sz = (Game and Game.mapSizeZ or 0) / 2
    end
    local entry = nearestEdgePoint(sx, sz)

    -- Seats per carrier, by the SAME arithmetic the validator charges (§7.7):
    -- never author a wave the validator would then drop.
    local carrier = defByName[DEFAULT_DEF_BY_KIND.air]
    local squadDef = knownDefs[WORLD_COMMIT_CARGO_DEF]
                     and defByName[WORLD_COMMIT_CARGO_DEF] or nil
    local seats = 0
    if carrier and squadDef then
        local cost = slotCost(squadDef)
        if cost > 0 then seats = math.floor(slotCapacity(carrier) / cost) end
    end

    local remaining = nSquads
    for i = 1, nTransports do
        local aboard = 0
        if seats > 0 and remaining > 0 then
            -- Spread the squads over the wave: nobody flies empty while
            -- cargo waits, nobody overloads past the slot arithmetic.
            aboard = math.min(seats, math.ceil(remaining / (nTransports - i + 1)))
            remaining = remaining - aboard
        end
        local cargo = {}
        if aboard > 0 then
            cargo[1] = { def = WORLD_COMMIT_CARGO_DEF, count = aboard }
        end
        GG.Transports.ScheduleArrival({
            id       = string.format('world_commit_%d', i),
            team     = teamID,
            kind     = 'air',
            eta      = WORLD_COMMIT_ETA_FIRST + (i - 1) * WORLD_COMMIT_ETA_SPACING,
            entry    = { x = entry.x, z = entry.z },
            dropZone = { x = sx, z = sz },
            cargo    = cargo,
            -- D20 finding 1: cargo nobody orders never moves. The world's
            -- force arrives fighting, toward the middle of the map.
            order    = { cmd = 'FIGHT',
                         x = (Game and Game.mapSizeX or 0) / 2,
                         z = (Game and Game.mapSizeZ or 0) / 2 },
        })
    end
    if remaining > 0 then
        -- Loud, not silent (§3.7's discipline): escrowed squads with no seat
        -- did not enter the battle, and the settlement will look wrong until
        -- somebody reads this line.
        Spring.Echo('[game_transports] WARNING: world_commit squads exceed ' ..
                    'the wave\'s capacity — ' .. remaining ..
                    ' squad(s) had no seat and were not scheduled')
    end
end

-- ============================================================
-- Callins
-- ============================================================

function gadget:GameStart()
    buildDefTables()
    local scn = GG.Scenario and GG.Scenario.data
    stageSides(scn)
    for _, spec in ipairs((scn and scn.arrivals) or {}) do
        GG.Transports.ScheduleArrival(spec)
    end
    -- The world's committed force, after the authored schedule: the escrow
    -- seam's arrivals ride the same validated path, and computeCommitted
    -- below folds them into the §7.5 denominator with everything else.
    scheduleWorldCommit(scn)
    -- Published unconditionally so a scenario with no bad arrivals reads 0
    -- rather than "absent", which a client cannot tell from "not checked".
    Spring.SetGameRulesParam('war_arrival_invalid', invalidArrivals, PUBLIC_LOS)
    computeCommitted(scn)
    recountTransports()
end

function gadget:UnitDestroyed(unitID, unitDefID, teamID)
    inFlight[unitID] = nil
    if expeditionary[teamID] and defIsTransport(UnitDefs[unitDefID]) then
        transportsAlive[teamID] = math.max(0, (transportsAlive[teamID] or 1) - 1)
        publishStranded(teamID)
    end
end

function gadget:UnitCreated(unitID, unitDefID, teamID)
    if expeditionary[teamID] and defIsTransport(UnitDefs[unitDefID]) then
        transportsAlive[teamID] = (transportsAlive[teamID] or 0) + 1
        publishStranded(teamID)
    end
end

function gadget:UnitGiven(unitID, unitDefID, newTeam, oldTeam)
    recountTransports()
    for teamID in pairs(expeditionary) do publishStranded(teamID) end
end

function gadget:GameFrame(frame)
    serviceArrivals(frame)

    if not checked and frame >= CHECK_FRAME then
        checked = true
        checkSidesCanLeave()
        for teamID in pairs(expeditionary) do publishStranded(teamID) end
    end

    if frame < CHECK_FRAME then return end
    if not Tick.due(pollGate, frame) then return end
    serviceInFlight(frame)
    serviceDepartures()
end

function gadget:GameOver()
    publishOutcomes()
end

-- SNAPSHOT (PLAN-persistence task 1d-b). The ledger and the arrival schedule
-- are AUTHORED state — a restore that dropped them would resurrect a wave the
-- war already flew and would zero a side's withdrawal ledger, which is the
-- world layer's settlement input. `committed`/`expeditionary`/`departureZones`
-- are re-derivable from the scenario, but re-deriving them would need
-- GG.Scenario to have been restored first (a load-order assumption this file
-- should not make), so they travel too. `transportsAlive` is deliberately NOT
-- saved: it is a census of live units, which the restored board answers
-- better than any snapshot, and Initialize recounts it.
function gadget:Save(state)
    state.scheduled = scheduled
    state.pending = pending
    state.inFlight = inFlight
    state.departureZones = departureZones
    state.expeditionary = expeditionary
    state.committed = committed
    state.withdrawnUnits = withdrawnUnits
    state.withdrawnTransports = withdrawnTransports
    state.withdrawnStrength = withdrawnStrength
    state.stranded = stranded
    state.outcomes = outcomes
    state.invalidArrivals = invalidArrivals
    state.nextAutoID = nextAutoID
    state.checked = checked
    state.outcomesPublished = outcomesPublished
    state.pollGate = Tick.save(pollGate)
end

function gadget:Load(state)
    -- Defaults spelled out, not inherited from the live values: a rollback to
    -- before an arrival must UNSPAWN nothing but must also not keep this
    -- process's idea of what already flew.
    scheduled = state.scheduled or {}
    pending = state.pending or {}
    inFlight = state.inFlight or {}
    departureZones = state.departureZones or {}
    expeditionary = state.expeditionary or {}
    committed = state.committed or {}
    withdrawnUnits = state.withdrawnUnits or {}
    withdrawnTransports = state.withdrawnTransports or {}
    withdrawnStrength = state.withdrawnStrength or {}
    stranded = state.stranded or {}
    outcomes = state.outcomes or {}
    invalidArrivals = state.invalidArrivals or 0
    nextAutoID = state.nextAutoID or 1
    checked = state.checked or false
    outcomesPublished = state.outcomesPublished or false
    Tick.load(pollGate, state.pollGate)
    if knownDefs == nil then buildDefTables() end
    recountTransports()
end
