-- game_start_units.lua — deterministic start-army staging for Paper Tanks.
--
-- WHY THIS EXISTS (PLAN-replay.md T2-c / T3-d): Paper Tanks ships no side
-- data and no start-unit gadget, so a `--headless-run` of it produces a game
-- with literally zero units. The determinism CI fixture built on that game
-- folded an empty unit list into its state hash for all 9000 frames — it
-- regression-tested the synced RNG stream and nothing else, and could not
-- have caught a movement, collision, damage or command-ordering divergence.
-- This gadget gives that fixture (and any other headless Paper Tanks run) a
-- real army to be deterministic ABOUT.
--
-- OFF BY DEFAULT. Staging only happens when the modoption `startunits` names
-- a layout, so every existing Paper Tanks invocation — the balance batch,
-- hand-driven spring-test sessions, browser smoke runs — behaves exactly as
-- it did before. Set it from a headless manifest's `modOptions` block or with
-- `--modoption startunits=skirmish`.
--
-- DETERMINISM RULES this file obeys, because a replay/verify gate is its
-- customer:
--   * no RNG, no wall clock, no `pairs()` over a hash table in a way that
--     reaches Spring.CreateUnit — team ids are sorted, rosters are ordered
--     arrays, grid offsets are computed from an index;
--   * every position is a pure function of (map size, team slot, unit index);
--   * the whole thing runs in ONE GameStart call, so the units exist before
--     the first SimFrame and no ordering question arises about which frame
--     they landed on.
--
-- The staged units are also NOT journaled and must not be: a gadget's
-- CreateUnit/GiveOrderToUnit are *consequences* of the start state, not
-- external inputs (PLAN-replay §7.1 "what is deliberately NOT recorded"), so
-- a re-execution reproduces them from the same modoptions. That is exactly
-- why the layout has to be deterministic rather than merely reproducible.

function gadget:GetInfo()
    return {
        name    = "Start Units",
        desc    = "Stages a fixed skirmish army per team when modoption startunits is set",
        author  = "spring-web",
        date    = "2026",
        license = "GPL v2",
        layer   = 0,
        enabled = true,
    }
end

if not gadgetHandler:IsSyncedCode() then
    return false
end

--------------------------------------------------------------------------------
-- Layouts
--------------------------------------------------------------------------------

-- One roster entry = { def, count }. Order is load-bearing: it fixes the
-- creation order, hence the unit-id order, hence the state-hash fold order.
local LAYOUTS = {
    -- "skirmish" — the CI determinism/replay fixture's layout. 12 units a
    -- side: enough armour to produce sustained mutual damage and real deaths
    -- inside a 5-game-minute run, few enough that an uncapped run still
    -- finishes in wall-seconds.
    skirmish = {
        radius  = 500,   -- block centre distance from the map centre
        -- Grid pitch must clear the LARGEST footprint in the roster, not the
        -- typical one: pt_hq is 6x6 (96 elmos). At a tighter pitch the blocks
        -- interpenetrate at spawn and the sim resolves the overlap by crushing
        -- units on frame 0 — which is legitimate simulation, but it makes the
        -- fixture's starting army depend on a collision-resolution detail
        -- instead of on the layout. (Measured: pitch 72 lost 2 of 24 units.)
        spacing = 112,
        columns = 4,
        -- Order is load-bearing twice over: it fixes the creation order (hence
        -- unit-id order, hence the state-hash fold order), and it decides who
        -- stands where. pt_hq is last so the immobile building ends up in the
        -- rear row rather than in front of its own army.
        roster = {
            { def = 'pt_heavytank', count = 3 },
            { def = 'pt_lighttank', count = 5 },
            { def = 'pt_scout',     count = 2 },
            { def = 'pt_artillery', count = 1 },
            { def = 'pt_hq',        count = 1 },
        },
    },
}

-- Fixed slot directions, in order. Slot 1 and 2 are opposed on the X axis so
-- the two-team case (the fixture) is a head-on engagement; 3..8 fill in the
-- diagonals for larger rosters. Unit-circle values written out literally
-- rather than computed with math.cos so the layout cannot drift with a libm.
local SLOT_DIRS = {
    { -1.0,  0.0 }, {  1.0,  0.0 },
    {  0.0, -1.0 }, {  0.0,  1.0 },
    { -0.7071, -0.7071 }, {  0.7071,  0.7071 },
    { -0.7071,  0.7071 }, {  0.7071, -0.7071 },
}

-- Facing that points a block's units back toward the map centre. Indexed the
-- same way as SLOT_DIRS. 0=south(+z) 1=east(+x) 2=north(-z) 3=west(-x).
local SLOT_FACING = { 1, 3, 0, 2, 1, 3, 1, 3 }

--------------------------------------------------------------------------------

local CMD_MOVE = CMD.MOVE

local spGetTeamList     = Spring.GetTeamList
local spGetTeamInfo     = Spring.GetTeamInfo
local spGetGroundHeight = Spring.GetGroundHeight
local spCreateUnit      = Spring.CreateUnit
local spGiveOrderToUnit = Spring.GiveOrderToUnit

-- Teams that actually have somebody in them. Seating players/AIs on teams 0
-- and 4 also MATERIALISES teams 1-3 as live-but-unoccupied, and staging an
-- army for one of those hands a free army to nobody. Leader == -1 is the
-- discriminator (an empty unit list is not — every team starts empty here).
local function participatingTeams()
    local out = {}
    for _, teamID in ipairs(spGetTeamList() or {}) do
        if teamID ~= Spring.GetGaiaTeamID() then
            local _, leader = spGetTeamInfo(teamID, false)
            if leader ~= nil and leader >= 0 then
                out[#out + 1] = teamID
            end
        end
    end
    table.sort(out)
    return out
end

-- Flattens `roster` into one ordered def list, so the whole army is laid out
-- on a SINGLE grid. Placing each roster entry on its own grid centred at the
-- same point is the obvious-looking mistake: every block then occupies the
-- same slots and the army spawns inside itself.
local function rosterDefs(roster)
    local defs = {}
    for _, entry in ipairs(roster) do
        for _ = 1, entry.count do defs[#defs + 1] = entry.def end
    end
    return defs
end

-- Offset for the i-th (0-based) slot of a `columns`-wide, `rows`-deep grid
-- centred on (0,0). Pure function of the index.
local function slotOffset(i, columns, rows, spacing)
    local col = i % columns
    local row = math.floor(i / columns)
    return (col - (columns - 1) * 0.5) * spacing,
           (row - (rows - 1) * 0.5) * spacing
end

local function stageTeam(layout, teamID, slot, centreX, centreZ)
    local dir = SLOT_DIRS[((slot - 1) % #SLOT_DIRS) + 1]
    local facing = SLOT_FACING[((slot - 1) % #SLOT_FACING) + 1]
    local baseX = centreX + dir[1] * layout.radius
    local baseZ = centreZ + dir[2] * layout.radius

    local defs = rosterDefs(layout.roster)
    local rows = math.ceil(#defs / layout.columns)
    local centreY = spGetGroundHeight(centreX, centreZ)

    local staged, mobile = 0, 0
    for i = 0, #defs - 1 do
        local ox, oz = slotOffset(i, layout.columns, rows, layout.spacing)
        local x, z = baseX + ox, baseZ + oz
        local def = defs[i + 1]
        local unitID = spCreateUnit(def, x, spGetGroundHeight(x, z), z, facing, teamID)
        if unitID then
            staged = staged + 1
            -- Walk the mobile half into the middle. Without this nothing
            -- moves: basic_ai only issues orders once it has a VISIBLE enemy,
            -- and the blocks start further apart than Paper Tanks' 500-elmo
            -- sight range, so two armies would sit and stare past each other
            -- for the whole run. The order is a gadget consequence, reproduced
            -- by re-execution, never journaled (PLAN-replay §7.1).
            if def ~= 'pt_hq' then
                spGiveOrderToUnit(unitID, CMD_MOVE,
                    { centreX + ox, centreY, centreZ + oz }, 0)
                mobile = mobile + 1
            end
        end
    end
    return staged, mobile
end

function gadget:GameStart()
    local opts = Spring.GetModOptions() or {}
    local name = opts.startunits
    if name == nil or name == '' or name == '0' then return end

    local layout = LAYOUTS[tostring(name)]
    if not layout then
        local known = {}
        for k in pairs(LAYOUTS) do known[#known + 1] = k end
        table.sort(known)
        Spring.Echo('[start_units] unknown layout "' .. tostring(name) ..
                    '" (known: ' .. table.concat(known, ', ') ..
                    ') — no units staged')
        return
    end

    local centreX = (Game and Game.mapSizeX or 17408) * 0.5
    local centreZ = (Game and Game.mapSizeZ or 17408) * 0.5

    local teams = participatingTeams()
    local total = 0
    for slot, teamID in ipairs(teams) do
        local staged, mobile = stageTeam(layout, teamID, slot, centreX, centreZ)
        total = total + staged
        Spring.Echo(string.format(
            '[start_units] layout=%s team%d slot%d staged=%d (mobile=%d)',
            tostring(name), teamID, slot, staged, mobile))
    end
    Spring.Echo(string.format('[start_units] layout=%s total=%d units across %d team(s)',
                              tostring(name), total, #teams))
end
