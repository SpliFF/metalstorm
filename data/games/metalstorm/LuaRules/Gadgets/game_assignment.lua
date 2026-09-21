-- game_assignment.lua — command scope as RESPONSIBILITY (PLAN-beta.md
-- "Command scope = responsibility", PLAN-beta-journey.md §(c)).
--
-- ============================================================
-- THIS IS NOT OWNERSHIP CODE
-- ============================================================
-- game_teams.lua's "no ownership code" rule still holds in full: the TEAM
-- owns every unit, nothing is ever transferred, and a player leaving moves
-- no unit and no command queue. What this gadget adds is a squad-leader
-- relation — a unit has a RESPONSIBLE player the way a squad has a leader:
-- you order the men, you do not own them. The single behavioural effect is
-- in AllowCommand, and it gates who may ISSUE an order, never who owns the
-- unit. If you find yourself reaching for Spring.TransferUnit here, stop.
--
-- Rank comes from the lobby as the per-player custom option `tier`, which
-- game_teams.lua republishes as the PUBLIC game rulesParam `rank_<pid>`
-- (likewise `mentor_<pid>`, `callsign_<pid>`). A launch with no custom
-- options — a dev direct-start, an old lobby — publishes none of them:
-- every player then reads as rank 1, no carve ever fires (it needs rank 0),
-- nothing is assigned, and AllowCommand is a straight `return true`. The
-- gadget is inert by construction, not by a feature flag.
--
-- LOAD ORDER CONTRACT: layer -38 — after squad.lua's own AllowCommand veto
-- (-60) and game_parley.lua's ROE veto (-45), before game_civilians (-40)'s
-- consumers and far before game_authority_charge.lua (+100). A refusal here
-- therefore lands BEFORE any authority is charged for the order.

function gadget:GetInfo()
    return {
        name    = "Assignment",
        desc    = "Responsible player per unit; rank precedence on who may issue orders",
        author  = "metalstorm",
        date    = "2026",
        license = "GPL v2",
        layer   = -38,
        enabled = true,
        -- Save/Load below: the assignment map and the order-by marks are
        -- mutable synced state (the `snapshot` key is for gadgets that have
        -- NEITHER call-in and are declaring why).
    }
end

if not gadgetHandler:IsSyncedCode() then
    return false
end

local Wire = VFS.Include("LuaRules/Gadgets/parley/wire.lua")

local ALLIED_LOS = { allied = true }   -- same visibility as every other team param

local DEFAULT_RANK      = 1    -- no `tier` option published -> Regular, gadget inert
local MIN_TEAM_SQUADS   = 6    -- §(c): carve only from a team that can spare them
local CARVE_SQUADS      = 2    -- §(c): "2 unassigned squads"
local WIRE_MIN_RANK     = 2    -- §(c): assign.set/release is a Veteran+ verb

-- Per-game state (fresh Lua locals, reset every game — same as game_teams.lua)
local responsible = {}   -- unitID -> playerID responsible for it
local orderBy     = {}   -- unitID -> playerID of the last higher-rank issuer
local countFor    = {}   -- playerID -> number of units they are responsible for
local rev         = 0    -- bumped on every change; published as assign_rev

GG.Assignment = GG.Assignment or {}

-- ============================================================
-- Rank / mentor lookups
-- ============================================================
local function pkey(playerID)
    -- Integer-normalised: Spring hands playerIDs back as Lua-5.4 FLOATS, so
    -- an un-floored id reads 'rank_1.0' where game_teams.lua wrote 'rank_1'
    -- (the same AI3 bugfix game_authority.lua's pkey documents).
    return math.floor(playerID)
end

local function rankOf(playerID)
    local r = Spring.GetGameRulesParam('rank_' .. pkey(playerID))
    return tonumber(r) or DEFAULT_RANK
end

--- The playerID of `playerID`'s mentor, or nil. -1 means the AI mentor, which
--- is nobody's playerID and so can never pass the precedence check below.
local function mentorOf(playerID)
    local m = Spring.GetGameRulesParam('mentor_' .. pkey(playerID))
    m = tonumber(m)
    if not m or m < 0 then return nil end
    return math.floor(m)
end

local function unitTeamOf(unitID)
    if not Spring.ValidUnitID(unitID) then return nil end
    return Spring.GetUnitTeam(unitID)
end

local function playerTeam(playerID)
    local _, _, spectator, teamID = Spring.GetPlayerInfo(pkey(playerID), false)
    if spectator then return nil end
    return teamID and math.floor(teamID) or nil
end

-- ============================================================
-- Publication (team scope — an assignment is the team's own business)
-- ============================================================
local function bumpRev(teamID)
    rev = rev + 1
    if teamID then Spring.SetTeamRulesParam(teamID, 'assign_rev', rev, ALLIED_LOS) end
end

local function publish(unitID, teamID)
    if not teamID then return end
    -- Integer-normalised for the same Lua-5.4-float reason pkey() documents:
    -- Spring.GetTeamUnits hands unitIDs back as FLOATS, so an un-floored id
    -- concatenates as 'assign_965.0' and the client's /^assign_(\d+)$/ never
    -- matches — the whole HUD scope reads as "nothing assigned to me".
    local key = 'assign_' .. math.floor(unitID)
    Spring.SetTeamRulesParam(teamID, key, responsible[unitID], ALLIED_LOS)
    Spring.SetTeamRulesParam(teamID, key .. '_by', orderBy[unitID], ALLIED_LOS)
    bumpRev(teamID)
end

-- ============================================================
-- Public API
-- ============================================================

--- Make `playerID` responsible for `unitID`. Rejects a cross-team pairing —
--- responsibility is a relation inside one team's roster, never across it.
--- Returns true when the map changed.
function GG.Assignment.Set(unitID, playerID)
    local teamID = unitTeamOf(unitID)
    if not teamID then return false end
    local pid = pkey(playerID)
    if playerTeam(pid) ~= teamID then return false end
    if responsible[unitID] == pid then return true end

    local prev = responsible[unitID]
    if prev then countFor[prev] = math.max((countFor[prev] or 1) - 1, 0) end
    responsible[unitID] = pid
    orderBy[unitID] = nil
    countFor[pid] = (countFor[pid] or 0) + 1
    publish(unitID, teamID)
    return true
end

--- Drop `unitID`'s responsible player. `teamID` may be passed when the unit is
--- already gone (UnitDestroyed still knows the team; ValidUnitID does not).
function GG.Assignment.Release(unitID, teamID)
    local prev = responsible[unitID]
    if not prev then return false end
    countFor[prev] = math.max((countFor[prev] or 1) - 1, 0)
    responsible[unitID] = nil
    orderBy[unitID] = nil
    publish(unitID, teamID or unitTeamOf(unitID))
    return true
end

--- The playerID responsible for `unitID`, or nil.
function GG.Assignment.Of(unitID)
    return responsible[unitID]
end

--- How many units `playerID` is responsible for.
function GG.Assignment.CountFor(playerID)
    return countFor[pkey(playerID)] or 0
end

--- Where the team's lowest-participation tactical objective sits, read off
--- the params game_objectives.lua already publishes (so this gadget needs no
--- objective internals). Returns nil when there is no such objective or it
--- has no position hint — the carve then falls back to unitID order.
local function carveAnchor(teamID)
    if not GG.Objectives or not GG.Objectives.LowestParticipationTactical then return nil end
    local id = GG.Objectives.LowestParticipationTactical(teamID)
    if not id then return nil end
    local x = Spring.GetGameRulesParam('objective_' .. id .. '_x')
    local z = Spring.GetGameRulesParam('objective_' .. id .. '_z')
    if not x or not z then return nil end
    return tonumber(x), tonumber(z)
end

--- §(c) auto-carve: a Recruit (rank 0) joining a team that can spare them
--- gets CARVE_SQUADS unassigned squads — the ones nearest the team's
--- lowest-participation tactical objective, which is the same "point the
--- joiner at real team work" hint game_teams.lua's suggestObjective uses.
--- Returns how many were assigned (0 when the player is not a Recruit, is a
--- spectator, or the team has fewer than MIN_TEAM_SQUADS live squads).
function GG.Assignment.CarveForRecruit(playerID)
    local pid = pkey(playerID)
    if rankOf(pid) ~= 0 then return 0 end
    local teamID = playerTeam(pid)
    if not teamID then return 0 end

    -- One sim unit IS one squad (squad.lua: "the squad illusion is entirely
    -- client-side"), so the team's unit list is its squad list.
    local units = Spring.GetTeamUnits(teamID) or {}
    if #units < MIN_TEAM_SQUADS then return 0 end

    local free = {}
    for _, unitID in ipairs(units) do
        if not responsible[unitID] then free[#free + 1] = unitID end
    end
    table.sort(free)   -- deterministic base order; the anchor sort is stable over it

    local ax, az = carveAnchor(teamID)
    if ax then
        local dist = {}
        for _, unitID in ipairs(free) do
            local x, _, z = Spring.GetUnitPosition(unitID)
            -- No position (in a transport, mid-spawn) sorts last rather than
            -- erroring — it is still a valid squad, just not the nearest one.
            dist[unitID] = (x and z) and ((x - ax) ^ 2 + (z - az) ^ 2) or math.huge
        end
        table.sort(free, function(a, b)
            if dist[a] == dist[b] then return a < b end
            return dist[a] < dist[b]
        end)
    end

    local n = 0
    for _, unitID in ipairs(free) do
        if n >= CARVE_SQUADS then break end
        if GG.Assignment.Set(unitID, pid) then n = n + 1 end
    end
    return n
end

-- ============================================================
-- The one behavioural rule (§(c))
-- ============================================================
function gadget:AllowCommand(unitID, unitDefID, unitTeam, cmdID, cmdParams, cmdOptions, cmdTag, playerID, fromSynced, fromLua)
    -- A Lua-issued or engine-issued order has no human behind it to rank.
    if fromLua or playerID == nil then return true end
    local pid = pkey(playerID)
    local resp = responsible[unitID]

    if resp == pid then
        -- The responsible player is back in command of their own squad: the
        -- superior's mark is history, and the HUD should stop showing it.
        if orderBy[unitID] then
            orderBy[unitID] = nil
            publish(unitID, unitTeam)
        end
        return true
    end

    -- Recruit equipment cap: a rank-0 player holding any assignment commands
    -- ONLY those. (With none — the SOLO case — they command the whole capped
    -- roster, so this never fires.)
    if rankOf(pid) == 0 and (countFor[pid] or 0) > 0 then return false end

    if resp == nil then return true end

    local rp, rr = rankOf(pid), rankOf(resp)
    if rp > rr or mentorOf(resp) == pid then
        -- A superior's order is published, not hidden: the HUD shows
        -- "order from <callsign> (<tier>)" off this key.
        orderBy[unitID] = pid
        publish(unitID, unitTeam)
        return true
    end
    if rp < rr then return false end
    -- Equal rank, not the responsible player: a peer teammate. Passes, and
    -- leaves no mark — `_by` means "a superior stepped in", not "someone else
    -- touched this".
    return true
end

-- ============================================================
-- Wire verbs (§(c)) — same RecvLuaMsg codec as parley/guidance
-- ============================================================
local function mayAssign(issuerID, targetID)
    if rankOf(issuerID) >= WIRE_MIN_RANK then return true end
    return targetID ~= nil and mentorOf(targetID) == issuerID
end

--- Decoded `units=` list, coerced to numbers and filtered to live units on
--- `teamID`. Silently drops anything else — this is an untrusted client
--- payload, not a caller contract.
local function wireUnits(field, teamID)
    local out = {}
    for _, raw in ipairs(Wire.list(field)) do
        local unitID = tonumber(raw)
        if unitID and unitTeamOf(unitID) == teamID then out[#out + 1] = unitID end
    end
    return out
end

function gadget:RecvLuaMsg(msg, playerID)
    local cmd, fields = Wire.decode(msg)
    if cmd ~= 'assign.set' and cmd ~= 'assign.release' then return end
    local issuer = pkey(playerID)
    local teamID = playerTeam(issuer)
    if not teamID then return end

    if cmd == 'assign.set' then
        local target = tonumber(fields.player)
        if not target then return end
        target = math.floor(target)
        if not mayAssign(issuer, target) then return end
        for _, unitID in ipairs(wireUnits(fields.units, teamID)) do
            GG.Assignment.Set(unitID, target)
        end
    else
        for _, unitID in ipairs(wireUnits(fields.units, teamID)) do
            if mayAssign(issuer, responsible[unitID]) then
                GG.Assignment.Release(unitID, teamID)
            end
        end
    end
end

-- ============================================================
-- Lifecycle
-- ============================================================
function gadget:UnitDestroyed(unitID, unitDefID, unitTeam)
    GG.Assignment.Release(unitID, unitTeam)
end

--- A leaver's squads become unassigned — they go back to the team, which
--- owned them all along. Nothing moves.
function gadget:PlayerRemoved(playerID, reason)
    local pid = pkey(playerID)
    for unitID, resp in pairs(responsible) do
        if resp == pid then GG.Assignment.Release(unitID) end
    end
    countFor[pid] = nil
end

function gadget:Save(zip)
    zip.responsible = responsible
    zip.orderBy     = orderBy
    zip.countFor    = countFor
    zip.rev         = rev
end

function gadget:Load(zip)
    responsible = (zip and zip.responsible) or {}
    orderBy     = (zip and zip.orderBy) or {}
    countFor    = (zip and zip.countFor) or {}
    rev         = (zip and zip.rev) or 0
    for unitID in pairs(responsible) do publish(unitID, unitTeamOf(unitID)) end
end
