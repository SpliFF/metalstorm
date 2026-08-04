-- tests/perf_bench.lua — PLAN-metalstorm-ai.md §10 task 7 ("AI perf pass").
--
-- Standalone (non-busted) profiling harness for the strategic-tick pipeline
-- at the §6 target scale: 50 regions, 500 squads. Mocks `_G.AI` the same way
-- tests/picture_spec.lua does (a flat rulesParams map + list-returning
-- callins) so it drives the REAL picture.lua/slate.lua/planner.lua, not a
-- stand-in — only the input SCALE is synthetic, not the code path.
--
-- Run:  lua tests/perf_bench.lua [ticks]      (default 300 ticks)
--
-- Reports, per pipeline stage (Picture.refresh / Slate.build / Planner.plan),
-- across all measured ticks: min/median/mean/p95/max in milliseconds, plus a
-- Lua VM memory delta (collectgarbage("count")) sampled every tick to catch
-- steady-state growth (a slow leak reads as the delta trending up over the
-- run, not settling near zero).
--
-- This is a MEASUREMENT tool, not a test — it always exits 0 (nothing here
-- asserts pass/fail; task 7 is "measure, then optimise only what the profile
-- indicts").

package.path = './?.lua;' .. package.path

local Config  = require('config')
local Picture = require('picture')
local Slate   = require('slate')
local Planner = require('planner')
local Roles   = require('roles')
local profile = require('profiles.default')

local N_REGIONS  = 50
local N_SQUADS   = 500     -- own force
local N_ENEMY    = 300     -- visible enemy squads (a comparable-scale opponent)
local N_OBJ      = 24      -- concurrent active objectives on the board
local GRID       = 8       -- ceil(sqrt(50)) — region layout grid
local CELL       = 1024    -- elmos per region cell (matches regions.json scale)

--=============================================================================
-- Synthetic 50-region graph, grid-adjacent, square polygons (real
-- point-in-polygon shape, not a stand-in).
--=============================================================================
local function buildRegions()
    local regions = {}
    local keys = {}
    for i = 0, N_REGIONS - 1 do
        local gx, gz = i % GRID, math.floor(i / GRID)
        local key = 'r' .. i
        keys[i] = key
        local x0, z0 = gx * CELL, gz * CELL
        regions[#regions + 1] = {
            key = key,
            name = key,
            -- Deliberately a DIFFERENT phase than addRegionOwnership's `i % 5`
            -- ownership assignment below — using the same modulus correlated
            -- "every region we own is the cheapest tier" and starved every
            -- DEFEND goal (value < Config.DEFEND_VALUE_MIN) out of the slate.
            value = 0.5 + ((i + 2) % 5) * 0.5,
            tags = {},
            neighbors = {},   -- filled below
            polygon = {
                { x = x0, z = z0 }, { x = x0 + CELL, z = z0 },
                { x = x0 + CELL, z = z0 + CELL }, { x = x0, z = z0 + CELL },
            },
        }
    end
    -- 4-connect the grid (mirrors a real region graph's adjacency density).
    for i = 0, N_REGIONS - 1 do
        local gx, gz = i % GRID, math.floor(i / GRID)
        local nbrs = {}
        local function add(nx, nz)
            local ni = nz * GRID + nx
            if nx >= 0 and nx < GRID and ni < N_REGIONS and keys[ni] then
                nbrs[#nbrs + 1] = keys[ni]
            end
        end
        add(gx - 1, gz); add(gx + 1, gz); add(gx, gz - 1); add(gx, gz + 1)
        regions[i + 1].neighbors = nbrs
    end
    return regions, keys
end

--- Center point of region i (for placing squads inside its polygon).
local function regionCenter(i)
    local gx, gz = i % GRID, math.floor(i / GRID)
    return gx * CELL + CELL / 2, gz * CELL + CELL / 2
end

--=============================================================================
-- Power table: a handful of unit classes (matches picture.lua's classOf
-- def -> class lookup shape).
--=============================================================================
local CLASSES = { 'soldier', 'mech', 'tank', 'artillery', 'fighter' }
local function buildPower()
    local defs = {}
    for d = 1, 20 do
        defs[d] = { class = CLASSES[(d % #CLASSES) + 1], dps = 10 + d, hp = 100 + d * 5 }
    end
    return { defs = defs }
end

--=============================================================================
-- Own/enemy unit lists scattered across the 50 regions.
--=============================================================================
local function buildUnits(n, regionKeys)
    local list = {}
    for i = 1, n do
        local ri = (i * 7919) % N_REGIONS   -- deterministic scatter, not clustered
        local cx, cz = regionCenter(ri)
        list[i] = {
            id = i, x = cx + (i % 64) - 32, z = cz + (i % 37) - 18,
            health = 50 + (i % 150), defId = (i % 20) + 1,
        }
    end
    return list
end

--=============================================================================
-- Objective board via rulesParams (readBoard's real read path — BOARD_FIELDS).
--=============================================================================
local function addObjectives(rp, regionKeys)
    rp['game:objective_count'] = N_OBJ
    for id = 1, N_OBJ do
        local p = 'objective_' .. id .. '_'
        rp['game:' .. p .. 'type']   = ({'control', 'kill', 'escort', 'extract'})[(id % 4) + 1]
        rp['game:' .. p .. 'scope']  = (id % 3 == 0) and 'strategic' or 'tactical'
        rp['game:' .. p .. 'state']  = 'active'
        rp['game:' .. p .. 'reward'] = 20 + id * 5
        rp['game:' .. p .. 'team']   = -1
        rp['game:' .. p .. 'progress'] = 0
        rp['game:' .. p .. 'region']  = regionKeys[id % N_REGIONS]
        rp['game:' .. p .. 'source']  = (id % 6 == 0) and 'bounty' or 'systemic'
    end
end

--- Region owner/contested rulesParams (readRegions' overlay) — a mixed
-- board: some ours, some enemy, most neutral (drives DEFEND/EXPAND/SCOUT
-- goal generation across the full slate, not just RESERVE).
local function addRegionOwnership(rp, n)
    for i = 0, n - 1 do
        local key = 'r' .. i
        local owner = -1
        if i % 5 == 0 then owner = 0        -- ours
        elseif i % 5 == 1 then owner = 1 end -- enemy
        rp['game:region_' .. key .. '_team'] = owner
        rp['game:region_' .. key .. '_contested'] = (i % 11 == 0)
    end
end

--=============================================================================
-- Mock `_G.AI` (same shape as tests/picture_spec.lua's makeAI).
--=============================================================================
local function makeAI(rulesParams, mapData, defExport, ownUnits, enemyUnits, playerId)
    return {
        getRulesParam = function(scope, key) return rulesParams[scope .. ':' .. key] end,
        getMapData    = function(name) return mapData[name] end,
        getDefExport  = function(name) return defExport[name] end,
        getOwnUnits   = function() return ownUnits end,
        getVisibleEnemies = function() return enemyUnits end,
        getPlayerId   = function() return playerId end,
    }
end

--=============================================================================
-- Stats helpers.
--=============================================================================
local function stats(samples)
    local sorted = {}
    for i, v in ipairs(samples) do sorted[i] = v end
    table.sort(sorted)
    local n = #sorted
    local function pct(p)
        local idx = math.max(1, math.min(n, math.ceil(p * n)))
        return sorted[idx]
    end
    local sum = 0
    for _, v in ipairs(sorted) do sum = sum + v end
    return {
        min = sorted[1], max = sorted[n], median = pct(0.5), p95 = pct(0.95),
        mean = sum / n, n = n,
    }
end

local function fmtRow(label, s)
    return string.format('%-16s min=%.4f  median=%.4f  mean=%.4f  p95=%.4f  max=%.4f  (n=%d)',
        label, s.min, s.median, s.mean, s.p95, s.max, s.n)
end

--=============================================================================
-- Run.
--=============================================================================
local ticks = tonumber(arg and arg[1]) or 300

local regionsData, regionKeys = buildRegions()
local power = buildPower()
local ownUnits = buildUnits(N_SQUADS, regionKeys)
local enemyUnits = buildUnits(N_ENEMY, regionKeys)

local rulesParams = {}
addObjectives(rulesParams, regionKeys)
addRegionOwnership(rulesParams, N_REGIONS)
rulesParams['team:authority_pool'] = 800
rulesParams['team:authority_player_0'] = 400
rulesParams['team:team_active_humans'] = 0

_G.AI = makeAI(rulesParams, { ['regions.json'] = { regions = regionsData } },
    { ['power.json'] = power }, ownUnits, enemyUnits, 0)

local role = Roles.resolve('full_side', Config)
role.teamId = 0

local commitments = {}
local memory = { intel = {} }
local rng = Config.makeRNG(Config.SEED)

local pictureMs, slateMs, plannerMs, totalMs = {}, {}, {}, {}
local memDeltas = {}

-- Warm-up ticks (not measured): loads the static region cache + power table
-- (a one-time cost the live run already found and fixed — see picture.lua's
-- staticRegions comment) so the measured loop is steady-state, matching what
-- §6's "strategic-tick cost target" actually budgets.
for i = 1, 3 do
    local frame = i * Config.STRATEGIC_TICK_FRAMES
    local picture = Picture.refresh({ frame = frame, memory = memory, role = role, config = Config })
    local slate = Slate.build(picture, profile, role)
    Planner.plan({ picture = picture, slate = slate, profile = profile, role = role,
                    commitments = commitments, rng = rng, config = Config })
end

collectgarbage('collect')

for i = 1, ticks do
    local frame = (i + 3) * Config.STRATEGIC_TICK_FRAMES

    local memBefore = collectgarbage('count')

    local t0 = os.clock()
    local picture = Picture.refresh({ frame = frame, memory = memory, role = role, config = Config })
    local t1 = os.clock()
    local slate = Slate.build(picture, profile, role)
    local t2 = os.clock()
    local plan = Planner.plan({ picture = picture, slate = slate, profile = profile, role = role,
                                 commitments = commitments, rng = rng, config = Config })
    local t3 = os.clock()

    local memAfter = collectgarbage('count')

    pictureMs[i] = (t1 - t0) * 1000
    slateMs[i]   = (t2 - t1) * 1000
    plannerMs[i] = (t3 - t2) * 1000
    totalMs[i]   = (t3 - t0) * 1000
    memDeltas[i] = memAfter - memBefore

    if i == 1 then
        local nLedger = 0
        for _ in pairs(picture.ledger or {}) do nLedger = nLedger + 1 end
        io.stderr:write(string.format(
            '[perf_bench] tick 1 sizes: goals=%d directives=%d ledger(packages)=%d intel=%d board=%d\n',
            #slate, #(plan.directives or {}), nLedger, (function() local c=0 for _ in pairs(picture.intel or {}) do c=c+1 end return c end)(),
            (function() local c=0 for _ in pairs(picture.board or {}) do c=c+1 end return c end)()))
    end
end

print(string.format('--- perf_bench: %d ticks, %d regions, %d own squads, %d enemy squads, %d objectives ---',
    ticks, N_REGIONS, N_SQUADS, N_ENEMY, N_OBJ))
print(fmtRow('Picture.refresh', stats(pictureMs)))
print(fmtRow('Slate.build', stats(slateMs)))
print(fmtRow('Planner.plan', stats(plannerMs)))
print(fmtRow('TOTAL', stats(totalMs)))

local memStats = stats(memDeltas)
print(string.format('%-16s min=%.3f  median=%.3f  mean=%.3f  p95=%.3f  max=%.3f  KB/tick',
    'mem delta', memStats.min, memStats.median, memStats.mean, memStats.p95, memStats.max))
print(string.format('final GC-counted heap: %.1f KB (after collectgarbage("collect"))',
    (function() collectgarbage('collect'); return collectgarbage('count') end)()))

local budgetMs = 2.0
local over = stats(totalMs).median > budgetMs
print(string.format('--- §6 budget (%.1f ms, LOD 0): median %s ---',
    budgetMs, over and 'OVER BUDGET' or 'within budget'))
