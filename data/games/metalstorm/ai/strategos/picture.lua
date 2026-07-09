-- picture.lua — the Picture builder (PLAN-metalstorm-ai.md §2).
--
-- Everything the AI knows, refreshed each strategic tick from PLAYER-VISIBLE
-- data only (no cheating channels). The Picture is one plain table so the
-- planner takes it as a single input and tests are reproducible (§6/§10).
--
-- READ SEAM: the plan's Picture needs rulesParams mirrors (regions,
-- objectives, pools, guidance) that require engine ask AI1
-- (AI.getRulesParam), plus squad views + LOD (AI2 / PLAN-ai.md) that the
-- current runtime doesn't expose. This module is the single place those
-- gaps live: it feature-detects and degrades to empty/stub data so the
-- pipeline runs end-to-end today against whatever the runtime provides.
--
-- The Picture SHAPE is real and final; only the population is stubbed.

local Picture = {}

--=============================================================================
-- Capability detection — what does this AI VM actually expose?  Recomputed
-- cheaply; the answers flip the moment an engine ask lands (no code change).
--=============================================================================
local function caps()
    local AI = _G.AI
    return {
        present     = type(AI) == 'table',
        rulesParam  = type(AI) == 'table' and type(AI.getRulesParam) == 'function', -- AI1
        ownSquads   = type(AI) == 'table' and type(AI.getOwnSquads)  == 'function', -- AI2
        enemySquads = type(AI) == 'table' and type(AI.getVisibleEnemySquads) == 'function',
        lod         = type(AI) == 'table' and type(AI.getLODLevel)   == 'function',
        ownUnits    = type(AI) == 'table' and type(AI.getOwnUnits)   == 'function', -- exists today
        enemyUnits  = type(AI) == 'table' and type(AI.getVisibleEnemies) == 'function',
    }
end

--=============================================================================
-- rulesParams mirror reads (all gated on AI1). Each returns a plain table;
-- absent surface → empty, and the planner treats empty as "unknown", which
-- is honest (a blind AI does nothing rash).
--=============================================================================

--- Region graph: regions[key] = { owner, contested, value, tags, neighbors }.
-- Geometry (value/tags/neighbors) comes from the static regions.json export
-- (regions plan §5 / ask R1); owner/contested come from region_* rulesParams.
-- STUB until AI1: returns {}.
local function readRegions(c)
    if not c.rulesParam then return {} end
    -- TODO(AI1): iterate the region index (from the cached regions.json the
    -- runtime should hand the VM alongside the snapshot) and overlay
    --   owner     = AI.getRulesParam('game', 'region_'..key..'_team')
    --   contested = AI.getRulesParam('game', 'region_'..key..'_contested')
    -- Adjacency IS strategic distance (plan §2) — no terrain, no pathfinding.
    return {}
end

--- Objective board: board[id] = { type, scope, state, reward, team, progress,
-- pos }. Objectives are public (objectives plan §6-E3) → all readable.
-- STUB until AI1.
local function readBoard(c)
    if not c.rulesParam then return {} end
    -- TODO(AI1): count = AI.getRulesParam('game','objective_count'); for i=1..count
    -- read objective_<i>_{type,scope,state,reward,team,progress,x,z,region}.
    return {}
end

--- Economy: own player pool + team pool (authority plan §1 — both public).
-- STUB until AI1: zeros (governor then behaves as "broke" → turtles, safe).
local function readEconomy(c, role)
    if not c.rulesParam then
        return { ownPool = 0, teamPool = 0, costScale = 1.0, reserveHonoured = true }
    end
    -- TODO(AI1):
    --   ownPool  = AI.getRulesParam('game','authority_player_'..playerID)
    --   teamPool = AI.getRulesParam('team','authority_pool')
    --   costScale= AI.getRulesParam('game','... modoption mirror ...') or 1.0
    -- Co-commander role NEVER draws the team fallback (plan §5) — that policy
    -- lives in the actuator's charge call, but the planner reads the flag here.
    return { ownPool = 0, teamPool = 0, costScale = 1.0,
             teamFallback = role and role.teamAuthorityFallback or false }
end

--- Guidance store (PLAN-metalstorm-interaction.md §6.2) — team-private,
-- BINDING on the planner. Only meaningful for co-commander/caretaker roles.
-- STUB until AI1 + I2 (private rulesParam visibility).
local function readGuidance(c, role)
    local empty = {
        stance = nil, regionPaint = {}, assetLocks = {},
        delegated = {}, funding = nil, roe = nil, veto = {},
    }
    if not (role and role.readsGuidance) or not c.rulesParam then return empty end
    -- TODO(AI1/I2): read guidance_* team-private params written by
    -- game_ai_guidance.lua. Every field is BINDING (interaction §6.2), not a
    -- suggestion: forbidden regions excluded, locks beat idle, delegated ×5.
    return empty
end

--- Parley board + trust ledger (interaction §1/§2). Read-only here; the
-- planner scores proposals, the actuator responds. STUB until AI1.
local function readParley(c)
    if not c.rulesParam then return { proposals = {}, trust = {} } end
    -- TODO(AI1): parley_<id>_* + trust_<a>_<b> params.
    return { proposals = {}, trust = {} }
end

--=============================================================================
-- Force reads (own + enemy). Today the runtime returns raw UNITS; the plan
-- speaks in SQUADS + org-groups (AI2). We bucket whatever we get into
-- regions and note the fidelity. Strength = current health (regions plan §2).
--=============================================================================

--- Own force ledger: ledger[regionKey] = { strength, groups, byClass }.
-- Buckets units/squads into regions via the region point-lookup.
local function buildLedger(c, regions)
    local ledger = {}
    local AI = _G.AI
    local list
    if c.ownSquads then
        list = AI.getOwnSquads()            -- preferred (AI2)
    elseif c.ownUnits then
        list = AI.getOwnUnits()             -- today's surface (raw units)
    else
        return ledger
    end
    for _, u in ipairs(list or {}) do
        -- TODO: regionOf(u.x, u.z) needs the region lookup grid (regions §1.2)
        -- rebuilt from regions.json client-side. Until the graph is readable,
        -- bucket everything under a single synthetic key so downstream code
        -- has a valid, if coarse, ledger.
        local key = Picture.regionOf(u.x, u.z, regions) or '_all'
        local bucket = ledger[key]
        if not bucket then
            bucket = { strength = 0, groups = {}, byClass = {} }
            ledger[key] = bucket
        end
        bucket.strength = bucket.strength + (u.health or 0)
        -- byClass/byScale needs the def→class map (def export); stubbed.
    end
    return ledger
end

--- Enemy intel with decaying memory (plan §2). Fresh sightings overwrite;
-- unseen regions decay toward "unknown" and are forgotten below a floor.
local function updateIntel(c, regions, memory, frame, config)
    local intel = memory.intel
    local AI = _G.AI

    -- 1. Decay every remembered region toward unknown.
    for key, mem in pairs(intel) do
        local age = frame - (mem.lastSeenFrame or frame)
        local conf = 1 - (age / config.INTEL_DECAY_FRAMES)
        if conf <= config.INTEL_FORGET_BELOW then
            intel[key] = nil                 -- honest amnesia
        else
            mem.confidence = conf
        end
    end

    -- 2. Fold in fresh sightings (raw enemies today; enemy squads under AI2).
    local list
    if c.enemySquads then
        list = AI.getVisibleEnemySquads()
    elseif c.enemyUnits then
        list = AI.getVisibleEnemies()
    end
    for _, e in ipairs(list or {}) do
        local key = Picture.regionOf(e.x, e.z, regions) or '_all'
        local mem = intel[key] or { strength = 0 }
        mem.strength      = (mem.strength or 0) + (e.health or 0)
        mem.lastSeenFrame = frame
        mem.confidence    = 1.0
        intel[key] = mem
    end
    -- TODO: radar blips (position only, no type) as low-confidence entries.
    return intel
end

--=============================================================================
-- Static tables loaded once and cached.
--=============================================================================
local powerTable = nil
--- Expected-DPS honesty numbers per def (combat-resolution §2.3 / C7 export).
-- The AI's strength math uses the same public numbers players see. STUB: the
-- def export isn't readable from the VM yet — returns {}.
local function loadPowerTable(c)
    if powerTable then return powerTable end
    powerTable = {}
    -- TODO: ingest the def→JSON expected-DPS export (combat-resolution ask C7)
    -- keyed by defID → { dps, hp, class, scale, counters = {...} }.
    return powerTable
end

--=============================================================================
-- Region point-lookup (shared helper). Real impl needs the lookup grid built
-- from regions.json (regions §1.2). STUB: no graph → nil (callers fall back
-- to the '_all' synthetic bucket).
--=============================================================================
function Picture.regionOf(x, z, regions)
    if not regions or next(regions) == nil then return nil end
    -- TODO: O(1) lookup-grid cell → region, boundary point-in-polygon confirm.
    return nil
end

--=============================================================================
-- The one entry point.
--=============================================================================
function Picture.refresh(ctx)
    local c       = caps()
    local frame   = ctx.frame
    local role    = ctx.role
    local memory  = ctx.memory
    local config  = ctx.config

    local regions = readRegions(c)
    local picture = {
        frame     = frame,
        caps      = c,                                  -- for diagnostics/tests
        config    = config,                             -- the tunables used here
        lod       = c.lod and _G.AI.getLODLevel() or 0, -- plan §3

        regions   = regions,
        board     = readBoard(c),
        economy   = readEconomy(c, role),
        guidance  = readGuidance(c, role),
        parley    = readParley(c),
        power     = loadPowerTable(c),

        ledger    = buildLedger(c, regions),
        intel     = updateIntel(c, regions, memory, frame, config),
    }
    return picture
end

return Picture
