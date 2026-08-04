-- objectives/generator.lua — systemic objective generation (PLAN-metalstorm-objectives.md §3.2).
-- Plain library module (NOT a gadget — this subfolder is invisible to the
-- non-recursive gadget scanner, same convention as civilians/). Included by
-- game_objectives.lua, which owns the periodic call + supplies a `world`
-- facade over Spring/GG so this file stays busted-testable with a fake world
-- (§9 "systemic dedup ... liveness rule fires on a starved team").
--
-- Each rule is `{ key, cooldown, cap, scan }`: `scan(world, state)` returns a
-- list of `{ dedupKey, build }` candidate instances found this tick; `build`
-- returns either a plain GG.Objectives.Create def, or `{ linkedPair = true,
-- escort = def, kill = def }` for the paired escort+kill rule (E4). The
-- generator is idempotent per world-state key —
-- `state.systemicActive[dedupKey]` tracks the live objective id for that
-- key, so re-triggering while one is active is a no-op; game_objectives.lua
-- calls `generator.clearActive` when the objective it tagged with that key
-- resolves.
local generator = {}

-- Density (modoption objective_density) scales cap and cooldown per rule.
local DENSITY = {
    sparse = { capMul = 0.5, cooldownMul = 2.0 },
    normal = { capMul = 1.0, cooldownMul = 1.0 },
    dense  = { capMul = 2.0, cooldownMul = 0.5 },
}

function generator.newState()
    return {
        systemicActive = {},    -- dedupKey -> objective id (bookkeeping only)
        cooldownUntil = {},     -- dedupKey -> frame
        ruleCounts = {},        -- rule key -> count of currently-active objectives from that rule
        contestedSince = {},    -- regionKey -> tick first seen contested (control rule debounce)
        seenConvoys = {},       -- convoy id -> true (edge-trigger "convoy created")
        seenInfraHealth = {},   -- infra unitID -> last-seen health fraction (edge-trigger damage)
        starvedSince = {},      -- team -> tick first seen with zero completable objectives
    }
end

--- Called by game_objectives.lua whenever the objective tagged with
--- `dedupKey` (o.systemicKey) leaves the active state, so the rule can fire
--- again for the same world-state key.
function generator.clearActive(state, dedupKey)
    if not dedupKey then return end
    state.systemicActive[dedupKey] = nil
end

--- Called alongside clearActive to keep ruleCounts accurate (cap enforcement
--- counts CURRENTLY-active systemic objectives per rule, not lifetime total).
function generator.onResolved(state, ruleKey, dedupKey)
    generator.clearActive(state, dedupKey)
    if ruleKey and state.ruleCounts[ruleKey] then
        state.ruleCounts[ruleKey] = math.max(0, state.ruleCounts[ruleKey] - 1)
    end
end

local function densityFor(mo)
    return DENSITY[mo] or DENSITY.normal
end

local function fire(state, world, density, rule, dedupKey, build)
    if state.systemicActive[dedupKey] then return end   -- already live, no-op (idempotent)
    if world.frame < (state.cooldownUntil[dedupKey] or 0) then return end

    local cap = math.max(1, math.floor(rule.cap * density.capMul))
    local count = state.ruleCounts[rule.key] or 0
    if count >= cap then return end

    local def = build()
    def.systemicKey, def.systemicRule = dedupKey, rule.key

    local id
    if def.linkedPair then
        def.escort.systemicKey, def.escort.systemicRule = dedupKey, rule.key
        def.kill.systemicKey, def.kill.systemicRule = dedupKey, rule.key
        id = world.createLinkedPair(def.escort, def.kill)
    else
        id = world.create(def)
    end
    if not id then return end   -- Create validated params and rejected (E1) — do not book it

    state.systemicActive[dedupKey] = id
    state.ruleCounts[rule.key] = count + 1
    state.cooldownUntil[dedupKey] = world.frame + math.floor(rule.cooldown * density.cooldownMul)
end

-- ============================================================
-- Rule: contested region -> control objective, open race.
-- ============================================================
local CONTESTED_DEBOUNCE_TICKS = 2   -- "contested >= 2 eval ticks" (§3.2 table)
local CONTROL_HOLD_FRAMES = 900      -- 30s hold to complete (tunable)

local controlRule = {
    key = 'control', cooldown = 1800, cap = 6,
    scan = function(world, state)
        local out = {}
        local stillContested = {}
        for _, key in ipairs(world.contestedRegions()) do
            stillContested[key] = true
            state.contestedSince[key] = state.contestedSince[key] or world.tick
            if (world.tick - state.contestedSince[key]) >= (CONTESTED_DEBOUNCE_TICKS - 1) then
                out[#out + 1] = {
                    dedupKey = 'control:' .. key,
                    build = function()
                        return {
                            type = 'control', scope = 'strategic', source = 'systemic',
                            reward = 50 * (1 + (world.regionValue(key) or 0)),
                            params = { regionKey = key, holdFrames = CONTROL_HOLD_FRAMES },
                        }
                    end,
                }
            end
        end
        for key in pairs(state.contestedSince) do
            if not stillContested[key] then state.contestedSince[key] = nil end
        end
        return out
    end,
}

-- ============================================================
-- Rule: civilian district under enemy threat -> protect (owner team).
-- Depends on GG.Civilians population data (civilians/spawn.lua seeding is
-- still a stub as of this writing — this rule is correct and ready, but
-- produces nothing until civilians actually populate districts; tracked in
-- the civilians backlog, not this plan).
-- ============================================================
local DISTRICT_PROTECT_FRAMES = 1800   -- 60s window

local districtRule = {
    key = 'district', cooldown = 1800, cap = 4,
    scan = function(world, state)
        local out = {}
        for _, threat in ipairs(world.civilianDistrictsUnderThreat()) do
            out[#out + 1] = {
                dedupKey = 'district:' .. threat.districtId,
                build = function()
                    return {
                        type = 'protect', scope = 'tactical', source = 'systemic',
                        forTeam = threat.districtTeam,
                        reward = 40,
                        expiresAtFrame = world.frame + DISTRICT_PROTECT_FRAMES,
                        params = { targetUnitIDs = threat.unitIDs },
                    }
                end,
            }
        end
        return out
    end,
}

-- ============================================================
-- Rule: convoy scheduled -> escort (benefactor team) + kill race (others),
-- created as a linked pair (E4). Same civilians-stub caveat as districtRule.
-- ============================================================
local escortRule = {
    key = 'escort', cooldown = 900, cap = 4,
    scan = function(world, state)
        local out = {}
        for _, convoy in ipairs(world.newConvoys()) do
            if not state.seenConvoys[convoy.id] then
                state.seenConvoys[convoy.id] = true
                out[#out + 1] = {
                    dedupKey = 'convoy:' .. convoy.id,
                    build = function()
                        return {
                            linkedPair = true,
                            escort = {
                                type = 'escort', scope = 'tactical', source = 'systemic',
                                forTeam = convoy.benefactorTeam, reward = 60,
                                params = { payloadUnitIDs = convoy.unitIDs, destArea = convoy.destArea },
                            },
                            kill = {
                                type = 'kill', scope = 'tactical', source = 'systemic',
                                reward = 60,
                                params = { targetUnitID = convoy.unitIDs[1] },
                            },
                        }
                    end,
                }
            end
        end
        return out
    end,
}

-- ============================================================
-- Rule: infra building damaged and undefended by an objective -> infra
-- (owner, timed). Detected by edge-triggering on a health drop between
-- ticks (periodic-scan cadence, no dedicated UnitDamaged callin needed).
-- ============================================================
local INFRA_HOLD_FRAMES = 1800

local infraRule = {
    key = 'infra', cooldown = 1800, cap = 4,
    scan = function(world, state)
        local out = {}
        local stillTracked = {}
        for _, b in ipairs(world.infraBuildings()) do
            stillTracked[b.unitID] = true
            local prevFrac = state.seenInfraHealth[b.unitID]
            state.seenInfraHealth[b.unitID] = b.healthFrac
            if prevFrac and b.healthFrac < prevFrac and b.healthFrac < 1.0 then
                out[#out + 1] = {
                    dedupKey = 'infra:' .. b.unitID,
                    build = function()
                        return {
                            type = 'infra', scope = 'tactical', source = 'systemic',
                            forTeam = b.ownerTeam, reward = 30,
                            expiresAtFrame = world.frame + INFRA_HOLD_FRAMES,
                            params = { buildingUnitIDs = { b.unitID } },
                        }
                    end,
                }
            end
        end
        for id in pairs(state.seenInfraHealth) do
            if not stillTracked[id] then state.seenInfraHealth[id] = nil end
        end
        return out
    end,
}

-- ============================================================
-- Liveness guarantee: a team with zero completable active objectives for 2
-- ticks gets a forced control objective on the nearest neutral/contested
-- region — the economy's dead-game backstop.
-- ============================================================
local LIVENESS_STARVED_TICKS = 2

local livenessRule = {
    key = 'liveness', cooldown = 900, cap = 8,
    scan = function(world, state)
        local out = {}
        local stillStarved = {}
        for _, team in ipairs(world.teams()) do
            if world.completableObjectiveCount(team) > 0 then
                state.starvedSince[team] = nil
            else
                stillStarved[team] = true
                state.starvedSince[team] = state.starvedSince[team] or world.tick
                if (world.tick - state.starvedSince[team]) >= (LIVENESS_STARVED_TICKS - 1) then
                    local key = world.nearestNeutralOrContestedRegion(team)
                    if key then
                        out[#out + 1] = {
                            dedupKey = 'liveness:' .. team,
                            build = function()
                                return {
                                    type = 'control', scope = 'strategic', source = 'systemic',
                                    forTeam = team, reward = 75,
                                    params = { regionKey = key, holdFrames = CONTROL_HOLD_FRAMES },
                                }
                            end,
                        }
                    end
                end
            end
        end
        for team in pairs(state.starvedSince) do
            if not stillStarved[team] then state.starvedSince[team] = nil end
        end
        return out
    end,
}

generator.rules = { controlRule, districtRule, escortRule, infraRule, livenessRule }

--- Periodic scan; posts objectives through `world.create` /
--- `world.createLinkedPair`. `world.tick` is a monotonic eval-tick counter
--- (not the frame number), so debounce windows ("contested >= 2 eval
--- ticks") count ticks, not frames.
function generator.tick(world, state)
    local mo = world.modOptions and world.modOptions() or {}
    local density = densityFor(mo.objective_density)

    for _, rule in ipairs(generator.rules) do
        for _, candidate in ipairs(rule.scan(world, state)) do
            fire(state, world, density, rule, candidate.dedupKey, candidate.build)
        end
    end
end

return generator
