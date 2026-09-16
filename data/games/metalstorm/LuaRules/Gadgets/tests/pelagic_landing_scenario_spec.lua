-- pelagic_landing_scenario_spec.lua — the amphibious pair's invariants.
--
--   scenarios/pelagic_landing.lua        "Hollow Dell — The Landing"
--   scenarios/pelagic_counterlanding.lua "Raven Watch — The Counter-Landing"
--
-- Like crossing_standoff_scenario_spec.lua this is deliberately NOT a
-- transcription of the content. What is asserted is the set of properties
-- that, when they broke, produced a war that could not be PLAYED — the
-- 2026-09-10 battle-flow review's findings 1 and 2 written down as checks,
-- plus the one this map adds: an army whose movement class cannot reach the
-- prize.
--
-- Run from the GAME root:
--   cd data/games/metalstorm && busted LuaRules/Gadgets/tests/pelagic_landing_scenario_spec.lua
--
-- The terrain half runs only where the map is: data/maps is gitignored, so the
-- sea-geometry tests resolve ../../../data/maps or $SPRINGRTS_MAPS_DIR and go
-- `pending` when neither is there. Do NOT let them quietly become no-ops —
-- they are the only place the "a landing ship told to stop on dry land is
-- refused by CreateUnit with nil and no log line" failure is caught before a
-- live run.

local LANDING = 'scenarios/pelagic_landing.lua'
local COUNTER = 'scenarios/pelagic_counterlanding.lua'
local MAP     = 'pelagic_expanse'

-- SHIP minwaterdepth, gamedata/moveinfo.tdf. Restated here (not read) because
-- moveinfo.tdf is a TDF, not Lua; game_transports.lua takes the same number
-- off the carrier's own def at runtime.
local SHIP_MIN_DEPTH = 12
local SEA_ARRIVE_RADIUS = 450          -- game_transports.lua's sea default

-- Set dressing that cannot shoot (§7.6's content rule). Same list as the
-- Standoff's spec — units/buildings_civilian.lua sets canattack=false for all
-- of these, and ms_militia is deliberately NOT on it.
local UNARMED_NEUTRAL_DEFS = {
    ms_habitat = true, ms_depot = true, ms_transit_hub = true,
    ms_civilians = true, ms_meeting_hall = true,
}

-- ---------------------------------------------------------------------------
-- The unit defs, executed out of units/ (same producer rule as
-- scenario_references_spec.lua: units/_builder.lua mints the scale tiers, so
-- a transcribed list would be a second source of truth that drifts).
-- ---------------------------------------------------------------------------
local UNIT_DEFS = (function()
    local saved = _G.VFS
    _G.VFS = { Include = function(p) return dofile(p) end, DirList = function() return {} end }
    local defs = {}
    local p = io.popen('ls units/*.lua 2>/dev/null')
    if p then
        for f in p:lines() do
            local ok, t = pcall(dofile, f)
            if ok and type(t) == 'table' then for k, v in pairs(t) do defs[k] = v end end
        end
        p:close()
    end
    _G.VFS = saved
    return defs
end)()

-- ---------------------------------------------------------------------------
-- The map's own heightmap, when this checkout has it
-- ---------------------------------------------------------------------------
local Terrain = (function()
    local function isDir(path)
        local p = io.popen('test -d "' .. path .. '" && echo yes 2>/dev/null')
        if not p then return false end
        local r = p:read('*l'); p:close(); return r == 'yes'
    end
    local root = os.getenv('SPRINGRTS_MAPS_DIR')
    if not (root and root ~= '' and isDir(root)) then
        root = isDir('../../../data/maps') and '../../../data/maps' or nil
    end
    if root == nil then return nil end

    local dir = root .. '/' .. MAP
    local info = io.open(dir .. '/mapinfo.lua', 'r')
    if not info then return nil end
    local text = info:read('*a'); info:close()
    local lo = tonumber(text:match('minheight%s*=%s*(%-?[%d%.]+)'))
    local hi = tonumber(text:match('maxheight%s*=%s*(%-?[%d%.]+)'))
    if not lo or not hi then return nil end

    local f = io.open(dir .. '/heightmap.bin', 'rb')
    if not f then return nil end
    local blob = f:read('*a'); f:close()

    -- uint16 LE, (mapx+1) x (mapy+1) samples, 8 elmos apart.
    local samples = #blob // 2
    local side = math.floor(math.sqrt(samples) + 0.5)
    if side * side ~= samples then return nil end
    local mapx = side - 1
    local step = 16384 // mapx          -- this map is 16384 elmos square

    return {
        declared = text:match('reachability%s*=%s*"(%a+)"'),
        at = function(x, z)
            local i = math.min(math.max(math.floor(x / step + 0.5), 0), mapx)
            local j = math.min(math.max(math.floor(z / step + 0.5), 0), mapx)
            local raw = string.unpack('<I2', blob, (j * side + i) * 2 + 1)
            return lo + (raw / 65535.0) * (hi - lo)
        end,
    }
end)()

local function dist(ax, az, bx, bz)
    local dx, dz = ax - bx, az - bz
    return math.sqrt(dx * dx + dz * dz)
end

-- ---------------------------------------------------------------------------

for _, path in ipairs({ LANDING, COUNTER }) do
describe(path, function()
    local scn
    before_each(function() scn = dofile(path) end)

    it('is a pure table literal the lobby\'s bare lua_State can parse', function()
        assert.is_table(scn)
        assert.equals(1, scn.version)
        assert.is_string(scn.name)
        assert.is_false(scn.tutorial == true)
        assert.is_false(scn.retired == true)
    end)

    it('targets pelagic_expanse and none of the known-unplayable maps', function()
        assert.equals(MAP, scn.world.map)
        assert.not_equals('meridian_basin', scn.world.map)
        assert.not_equals('skerry_reach', scn.world.map)
    end)

    it('declares exactly one victory objective, scoped to no team', function()
        -- Zero makes the war unendable and ScenarioDiscovery::DefaultForMap
        -- skips the scenario outright; two make the ending ambiguous. A
        -- victory objective scoped to a team the launch did not supply throws
        -- "Bad teamID" out of the Objectives callin, gadgetHandler removes the
        -- gadget, and NOTHING is evaluated for the rest of the match.
        local victories = 0
        for _, o in ipairs(scn.objectives) do
            if o.victory then
                victories = victories + 1
                assert.is_nil(o.forTeam)
                assert.equals('raven_watch', o.region)
            end
            if o.scope == 'strategic' then assert.is_nil(o.forTeam) end
        end
        assert.equals(1, victories)
    end)

    it('cannot be won before the two forces can meet, and does not lapse', function()
        local victory
        for _, o in ipairs(scn.objectives) do if o.victory then victory = o end end
        -- The beachhead is ~2100 elmos from Raven Watch and the far staging
        -- line ~3500; the slowest staged class (INFANTRY, 1.4 elmo/frame)
        -- needs ~2500 frames for that. 5400 puts the earliest decision past it
        -- for BOTH sides rather than merely past one.
        assert.is_true(victory.notBefore >= 5400)
        assert.is_true(victory.holdFrames >= 5400)
        assert.is_nil(victory.expiresAtFrame)
    end)

    it('stages nothing whose movement class cannot reach the prize', function()
        -- THE MAP-SPECIFIC ONE, and the reason it is a test rather than a
        -- comment. pelagic_expanse is a DECLARED-SPLIT archipelago. Measured
        -- with tools/mapgen/regions_from_map.py's own MOVE_CLASSES over this
        -- map's heightmap, the ash_ridge / quarry_bluff / south_shelf /
        -- raven_watch / east_crossing / hollow_dell theatre is ONE component
        -- for INFANTRY (45 deg, 12-elmo ford) and ONE for VEH (32 deg, 20) —
        -- and is NOT connected for HEAVY (24 deg, 30): raven_watch,
        -- east_crossing, hollow_dell and the ash_ridge causeway are not
        -- HEAVY-passable at all.
        --
        -- So a HEAVY def staged here is an army ordered at a prize it can
        -- never reach — Meridian's failure with a different seed, and the one
        -- the 2026-09-10 review's finding 13 says game_start.lua still has.
        local heavy = {}
        for _, u in ipairs(scn.units) do
            local def = UNIT_DEFS[u.def]
            if def and def.movementclass == 'HEAVY' then
                heavy[#heavy + 1] = u.def .. '@team' .. tostring(u.team)
            end
        end
        for _, a in ipairs(scn.arrivals or {}) do
            for _, c in ipairs(a.cargo or {}) do
                local def = UNIT_DEFS[c.def]
                if def and def.movementclass == 'HEAVY' then
                    heavy[#heavy + 1] = c.def .. '@arrival ' .. tostring(a.id)
                end
            end
        end
        assert.same({}, heavy)
    end)

    it('stages an army for every declared side, on consecutive teams from 0', function()
        -- endtoend D19: a side the scenario stages nothing for is a room slot
        -- that starts with no units, and the room seats an opponent onto it.
        local staged = {}
        for _, u in ipairs(scn.units) do
            if type(u.team) == 'number' then staged[u.team] = true end
        end
        for i, side in ipairs(scn.sides) do
            assert.equals(i - 1, side.team)
            assert.is_true(staged[side.team],
                'side ' .. side.faction .. ' (team ' .. side.team .. ') stages no units')
        end
    end)

    it('flags exactly the side that arrived by transport', function()
        -- §7.1. `expeditionary` gates ms_stranded_<team> and the
        -- war_side_stranded guard, which exist only for a force that can be
        -- trapped ashore. A HOME defender carrying it fires the guard on
        -- people standing in their own kitchen, forever — and a `departure`
        -- without the flag is a withdrawal zone for an army that never left.
        local flagged = 0
        for _, s in ipairs(scn.sides) do
            if s.expeditionary then
                flagged = flagged + 1
                assert.is_table(s.departure, 'expeditionary side has no departure zone')
            else
                assert.is_nil(s.departure)
            end
        end
        assert.equals(1, flagged)
    end)

    it('keeps each departure zone clear of that side\'s own parked carrier', function()
        -- A departure circle drawn over your own staged transport deletes it
        -- on the first §3.4 poll after frame 60 — seconds into the match, for
        -- no reason a player could ever see. Reads as a crash.
        for _, s in ipairs(scn.sides) do
            local d = s.departure
            if d then
                for _, u in ipairs(scn.units) do
                    local def = UNIT_DEFS[u.def]
                    if u.team == s.team and def and tonumber(def.transportcapacity) then
                        assert.is_true(dist(u.x, u.z, d.x, d.z) > d.radius + 400,
                            u.def .. ' at ' .. u.x .. ',' .. u.z ..
                            ' is inside team ' .. s.team .. '\'s own departure zone')
                    end
                end
            end
        end
    end)

    it('gives every mobile unit an opening order, or a reason to stay', function()
        -- D20 finding 1 verbatim. The frame-60 `war_units_unordered` guard
        -- fires only when a team has ZERO ordered units, so a partly-ordered
        -- army reads clean to it — hence the check lives here.
        local IMMOBILE = { ms_radar_s1 = true, ms_radar_s2 = true,
                           ms_staticdefense_s2 = true, ms_habitat = true,
                           ms_depot = true, ms_transit_hub = true,
                           ms_meeting_hall = true }
        local STAY_HOME = {
            ms_engineers_s1 = true,     -- not part of the push
            -- Staged-as-arrived carriers stay PARKED: there is deliberately no
            -- auto-withdraw macro (§3.4), so the player loads them and takes
            -- them out. An opening order would fly the side's way home into
            -- the fight on frame 0.
            fable_airship = true, ms_landing_ship = true,
            -- The garrison sections hold the door. A garrison that walks off
            -- to the prize is not a garrison.
            ms_soldiers_s1 = 'garrison-may-hold',
        }
        local ordered, unordered = 0, {}
        for _, u in ipairs(scn.units) do
            if type(u.team) == 'number' and not IMMOBILE[u.def] and not STAY_HOME[u.def] then
                if u.orders and #u.orders > 0 then ordered = ordered + 1
                else unordered[#unordered + 1] = u.def .. '@team' .. u.team end
            end
        end
        assert.is_true(ordered > 0)
        assert.same({}, unordered)
        -- ...and both sides have SOMETHING moving, which is what the guard
        -- actually watches for.
        local movingPerTeam = {}
        for _, u in ipairs(scn.units) do
            if type(u.team) == 'number' and u.orders and #u.orders > 0 then
                movingPerTeam[u.team] = (movingPerTeam[u.team] or 0) + 1
            end
        end
        for _, s in ipairs(scn.sides) do
            assert.is_true((movingPerTeam[s.team] or 0) > 0,
                'team ' .. s.team .. ' has no unit under orders')
        end
    end)

    it('sends every ordered unit to the SAME point, not to its own edge of it', function()
        -- Two forces ordered to their own near edge of the prize "arrive" in
        -- the same region and out of weapon range of each other — the way a
        -- war gets decided with no shot fired.
        local targets = {}
        for _, u in ipairs(scn.units) do
            for _, o in ipairs(u.orders or {}) do
                targets[o.params[1] .. ',' .. o.params[3]] = true
            end
        end
        for _, a in ipairs(scn.arrivals or {}) do
            if a.order then targets[a.order.x .. ',' .. a.order.z] = true end
        end
        local n = 0; for _ in pairs(targets) do n = n + 1 end
        assert.equals(1, n)
    end)

    it('puts nothing that shoots on a team the lobby cannot seat', function()
        -- §7.6: `team = 'neutral'` resolves to Gaia, whose index the engine
        -- derives from the ROOM roster, and Gaia is its own ally team with no
        -- allies — hostile, not neutral. Armed set dressing shoots both
        -- players and has, measured, decided a war.
        for _, u in ipairs(scn.units) do
            if u.team == 'neutral' then
                assert.is_true(UNARMED_NEUTRAL_DEFS[u.def] == true,
                    'neutral cluster stages ' .. u.def .. ', which is not on the unarmed list')
            end
        end
        assert.is_nil(scn.ai)
    end)

    it('opens with the prize and every tactical region uncontrolled', function()
        -- A control objective on a region its own side already owns completes
        -- on the first tick: a reward for having been dealt it.
        local owned = {}
        for _, r in ipairs(scn.world.regions) do owned[r.key] = r.team end
        for _, o in ipairs(scn.objectives) do
            if o.type == 'control' then
                assert.is_nil(owned[o.region],
                    'control objective on ' .. o.region .. ', which starts owned')
            end
        end
    end)

    it('backs every protect objective with civilians the sweep can find', function()
        -- `_populateTargetsFrom`'s role filter reads the GG.Civilians registry
        -- and a role lives ONLY there, never on a unitdef — so a protect
        -- objective is satisfiable only by entries in the `civilians` block.
        -- One that finds nobody is SKIPPED, so a war silently loses it.
        local ambient = {}
        for _, c in ipairs(scn.civilians.units) do
            if c.role == 'ambient' then ambient[#ambient + 1] = c end
        end
        assert.is_true(#ambient > 0)
        for _, o in ipairs(scn.objectives) do
            if o.type == 'protect' then
                local a = o._populateTargetsFrom
                assert.is_table(a)
                assert.equals('ambient', a.role)
                local found = 0
                for _, c in ipairs(ambient) do
                    if dist(c.x, c.z, a.x, a.z) <= a.r then found = found + 1 end
                end
                assert.is_true(found >= (o.params.quorum or 1),
                    'protect marker at ' .. a.x .. ',' .. a.z .. ' finds ' .. found ..
                    ' ambient civilian(s) in radius ' .. a.r)
            end
        end
    end)

    it('backs every kill objective with a unit it actually stages', function()
        -- `_populateUnitsFrom` with into='targetUnitID' resolves the NEAREST
        -- match to the marker centre; a marker that finds nobody skips the
        -- objective. Nothing spawns these targets at runtime, so they have to
        -- be in `units` — on the named team, inside the radius.
        for _, o in ipairs(scn.objectives) do
            if o.type == 'kill' then
                local m = o._populateUnitsFrom
                assert.is_table(m)
                assert.equals('targetUnitID', m.into)
                assert.is_table(m.defs)
                local found = 0
                for _, u in ipairs(scn.units) do
                    for _, d in ipairs(m.defs) do
                        if u.def == d and u.team == m.team and dist(u.x, u.z, m.x, m.z) <= m.r then
                            found = found + 1
                        end
                    end
                end
                assert.equals(1, found,
                    'kill marker at ' .. m.x .. ',' .. m.z .. ' resolves ' .. found ..
                    ' staged candidate(s) — want exactly 1')
            end
        end
    end)

    it('gives every arrival an order and a distinct id', function()
        -- §3.3: a wave that unloads into silence is a wave that never fights,
        -- and a duplicate id is rejected by validateArrival — the second wave
        -- simply never happens.
        local seen = {}
        for _, a in ipairs(scn.arrivals) do
            assert.is_string(a.id)
            assert.is_nil(seen[a.id], 'duplicate arrival id ' .. tostring(a.id))
            seen[a.id] = true
            assert.is_table(a.order, 'arrival ' .. a.id .. ' has no order')
            assert.is_number(a.eta)
        end
        -- Both sides get reinforced. A one-sided arrival schedule is a demo of
        -- the transport path, not a war fought over it.
        local perTeam = {}
        for _, a in ipairs(scn.arrivals) do perTeam[a.team] = (perTeam[a.team] or 0) + 1 end
        for _, s in ipairs(scn.sides) do
            assert.is_true((perTeam[s.team] or 0) > 0, 'team ' .. s.team .. ' gets no arrivals')
        end
        -- At least one wave crosses water on each side's own sea lane.
        local sea = 0
        for _, a in ipairs(scn.arrivals) do if a.kind == 'sea' then sea = sea + 1 end end
        assert.is_true(sea >= 2)
    end)

    describe('sea geometry, on the map\'s own heightmap', function()
        it('is measured, not assumed', function()
            if Terrain == nil then
                pending('data/maps/' .. MAP .. ' is absent — set SPRINGRTS_MAPS_DIR')
                return
            end
            -- The map declares what the verifier measures. If this flips back
            -- to "connected", tools/mapgen/verify_scenario_maps.py starts
            -- failing on both of these wars and the reason will not be in
            -- either file.
            assert.equals('split', Terrain.declared)

            local problems = {}
            local function check(what, cond, msg)
                if not cond then problems[#problems + 1] = what .. ': ' .. msg end
            end

            for _, a in ipairs(scn.arrivals) do
                local he = Terrain.at(a.entry.x, a.entry.z)
                local hd = Terrain.at(a.dropZone.x, a.dropZone.z)
                if a.kind == 'sea' then
                    -- terrainProblem()'s exact rules: a landing ship created on
                    -- dry ground is refused by CreateUnit with nil and no log
                    -- line; one whose drop zone is inland never "arrives" and
                    -- re-issues UNLOAD_UNITS every 300 frames for the rest of
                    -- the war.
                    check(a.id, he < 0 and -he >= SHIP_MIN_DEPTH,
                          string.format('sea entry is %.1f — needs %d elmos of water', he, SHIP_MIN_DEPTH))
                    check(a.id, hd < 0 and -hd >= SHIP_MIN_DEPTH,
                          string.format('sea dropZone is %.1f — needs %d elmos of water', hd, SHIP_MIN_DEPTH))
                    -- ...and the review's finding 2: a ship necessarily stops
                    -- OFFSHORE, so there has to be dry ground inside the
                    -- unload radius or UNLOAD_UNITS finds nowhere to put
                    -- anybody, forever.
                    local radius = a.dropRadius or SEA_ARRIVE_RADIUS
                    local beach
                    for r = 25, radius, 25 do
                        for deg = 0, 355, 5 do
                            local rad = math.rad(deg)
                            local px = a.dropZone.x + r * math.cos(rad)
                            local pz = a.dropZone.z + r * math.sin(rad)
                            if Terrain.at(px, pz) > 1 then beach = r; break end
                        end
                        if beach then break end
                    end
                    check(a.id, beach ~= nil,
                          'no dry ground within the ' .. radius .. '-elmo unload radius')
                elseif a.kind == 'air' then
                    -- An air drop zone has to suit the CARGO, not the carrier:
                    -- infantry set down in open water drowns.
                    check(a.id, hd >= 0,
                          string.format('air dropZone is over water (%.1f)', hd))
                end
            end

            -- Every staged carrier has to be able to float where it is parked.
            for _, u in ipairs(scn.units) do
                local def = UNIT_DEFS[u.def]
                if def and def.movementclass == 'SHIP' then
                    local h = Terrain.at(u.x, u.z)
                    check(u.def, h < 0 and -h >= SHIP_MIN_DEPTH,
                          string.format('parked at %d,%d where the ground is %.1f', u.x, u.z, h))
                end
            end

            -- And every withdrawal zone has to be water a ship can enter, or
            -- the side can never actually leave.
            for _, s in ipairs(scn.sides) do
                if s.departure then
                    local h = Terrain.at(s.departure.x, s.departure.z)
                    check('team ' .. s.team .. ' departure',
                          h < 0 and -h >= SHIP_MIN_DEPTH,
                          string.format('sits over ground at %.1f', h))
                end
            end

            assert.same({}, problems)
        end)
    end)
end)
end

describe('the pair', function()
    it('is a mirror: same map, same prize, same clock, roles flipped', function()
        local a, b = dofile(LANDING), dofile(COUNTER)
        assert.equals(a.world.map, b.world.map)
        local function victory(s)
            for _, o in ipairs(s.objectives) do if o.victory then return o end end
        end
        local va, vb = victory(a), victory(b)
        assert.equals(va.region, vb.region)
        assert.equals(va.notBefore, vb.notBefore)
        assert.equals(va.holdFrames, vb.holdFrames)
        assert.not_equals(a.name, b.name)

        local function expeditionary(s)
            for _, side in ipairs(s.sides) do if side.expeditionary then return side.faction end end
        end
        -- The whole reason there are two files: the side that has to come
        -- ashore is the other one.
        assert.not_equals(expeditionary(a), expeditionary(b))
    end)
end)
