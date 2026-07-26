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
        mapData     = type(AI) == 'table' and type(AI.getMapData)    == 'function', -- AI4
        defExport   = type(AI) == 'table' and type(AI.getDefExport)  == 'function', -- AI4
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
    local regions = {}
    local AI = _G.AI
    -- Static graph geometry from regions.json via the AI4 file API — the SAME
    -- file the client mirror (ui/lib/regions.js) fetches, so both agree by
    -- construction. Adjacency IS strategic distance (plan §2) — no terrain,
    -- no pathfinding. `polygon` is retained for the regionOf lookup grid the
    -- task-3 Picture builder will construct.
    if c.mapData then
        local ok, data = pcall(AI.getMapData, 'regions.json')
        if ok and type(data) == 'table' and type(data.regions) == 'table' then
            for _, r in ipairs(data.regions) do
                if r.key then
                    regions[r.key] = {
                        name      = r.name,
                        value     = r.value or 0,
                        tags      = r.tags or {},
                        neighbors = r.neighbors or {},
                        polygon   = r.polygon,
                        owner     = nil,     -- overlaid from rulesParams below
                        contested = false,
                    }
                end
            end
        end
    end
    -- Overlay live owner/contested from region_* rulesParams (AI1). Absent
    -- params leave the static defaults — an honest "unknown" ownership for a
    -- region the AI can't currently see the control state of.
    if c.rulesParam then
        for key, region in pairs(regions) do
            local owner = AI.getRulesParam('game', 'region_' .. key .. '_team')
            if owner ~= nil then region.owner = owner end
            local contested = AI.getRulesParam('game', 'region_' .. key .. '_contested')
            if contested ~= nil then
                region.contested = (contested == 1 or contested == true)
            end
        end
    end
    return regions
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

--- Economy: own player pool + team pool (authority plan §1 — both
-- team-scoped, allied-visibility rulesParams, NOT public/game-scoped: see
-- game_authority.lua's ALLIED_LOS note).
-- STUB until AI1: zeros (governor then behaves as "broke" → turtles, safe).
local function readEconomy(c, role)
    if not c.rulesParam then
        return { ownPool = 0, teamPool = 0, costScale = 1.0, reserveHonoured = true }
    end
    -- TODO(AI1):
    --   ownPool  = AI.getRulesParam('team', teamID, 'authority_player_'..playerID)
    --   teamPool = AI.getRulesParam('team', teamID, 'authority_pool')
    --   costScale= AI.getRulesParam('game','... modoption mirror ...') or 1.0
    -- Co-commander role NEVER draws the team fallback (plan §5) — that policy
    -- lives in the actuator's charge call, but the planner reads the flag here.
    return { ownPool = 0, teamPool = 0, costScale = 1.0,
             teamFallback = role and role.teamAuthorityFallback or false }
end

--- Comma-list rulesParam value -> array of raw string entries (empty array
--- for nil/''). Mirrors game_ai_guidance.lua's/game_parley.lua's flattened
--- comma-list publishing convention (see those files' publish() headers).
local function splitList(v)
    local out = {}
    if not v or v == '' then return out end
    for item in tostring(v):gmatch('[^,]+') do out[#out + 1] = item end
    return out
end

--- Guidance store (PLAN-metalstorm-interaction.md §6.2) — team-private
-- (engine ask I2: verified sim-side LOS is correct — see
-- game_ai_guidance.lua's header — the streaming wire is the pre-existing,
-- separately-tracked gap, not a blocker for reading via AI.getRulesParam
-- once AI1 lands), BINDING on the planner. Only meaningful for
-- co-commander/caretaker roles (role.readsGuidance).
--
-- STUB until AI1 (AI.getRulesParam): the read SHAPE and rulesParam names
-- below are real (they match game_ai_guidance.lua's publish() exactly) —
-- only the actual AI.getRulesParam plumbing is missing. Degrades to `empty`
-- (the planner already treats an all-empty guidance as "no override", never
-- an error) until that capability exists.
local function readGuidance(c, role)
    local empty = {
        stance = nil, regionPaint = {}, assetLocks = {},
        delegated = {}, funding = nil, roe = nil, veto = {},
    }
    if not (role and role.readsGuidance) or not c.rulesParam then return empty end

    local AI = _G.AI
    local teamID = role.teamId
    local prefix = 'guidance_' .. teamID .. '_'
    local function get(key) return AI.getRulesParam('team', teamID, prefix .. key) end

    local regionPaint = {}
    for _, key in ipairs(splitList(get('paint_keys'))) do
        regionPaint[key] = get('paint_' .. key)
    end
    local assetLocks = {}
    for _, key in ipairs(splitList(get('lock_keys'))) do assetLocks[key] = true end
    local delegated = {}
    for _, key in ipairs(splitList(get('delegated_keys'))) do delegated[tonumber(key) or key] = true end
    local veto = {}
    for _, key in ipairs(splitList(get('veto_keys'))) do veto[tonumber(key) or key] = true end

    local rateCap = tonumber(get('funding_rateCap'))
    return {
        stance = get('stance'),
        regionPaint = regionPaint,
        assetLocks = assetLocks,
        delegated = delegated,
        funding = (rateCap and rateCap >= 0) and { rateCap = rateCap } or nil,
        roe = get('roe'),
        veto = veto,
    }
end

--- Parley board + trust ledger (interaction §1/§2). Read-only here; the
-- planner scores proposals (ai/strategos/planner.lua Planner.evaluateProposals),
-- the actuator responds (Actuators:respondProposal, engine ask I1).
--
-- STUB until AI1: rulesParam names match game_parley.lua's publish() exactly
-- (parley_count high-water + parley_<id>_* fields, GAME-scoped/public — a
-- negotiation record is visible to both parties and spectators, unlike
-- guidance). trust is necessarily PARTIAL: there is no "list every team"
-- capability to probe every pair proactively, so it only ever contains
-- entries for teams that have appeared on our own proposal board (same
-- "honest amnesia" shape as the intel decay memory) — callers that need a
-- specific counterparty's trust with no live proposal on record simply see
-- no entry (treat missing as neutral, matching GG.Parley.Trust's own
-- default), never a synthesized guess.
local function readParley(c, role)
    if not c.rulesParam then return { proposals = {}, trust = {} } end

    local AI = _G.AI
    local function get(key) return AI.getRulesParam('game', key) end
    local count = tonumber(get('parley_count')) or 0

    local proposals = {}
    local counterparties = {}   -- other teamID -> true, seen on our own board
    local teamID = role and role.teamId
    for id = 1, count do
        local p = 'parley_' .. id .. '_'
        local state = get(p .. 'state')
        if state then
            local fromTeam, toTeam = tonumber(get(p .. 'from')), tonumber(get(p .. 'to'))
            proposals[#proposals + 1] = {
                id = id, kind = get(p .. 'kind'), fromTeam = fromTeam, toTeam = toTeam,
                state = state, deadline = tonumber(get(p .. 'deadline')),
            }
            if teamID and (fromTeam == teamID or toTeam == teamID) then
                local other = (fromTeam == teamID) and toTeam or fromTeam
                if other then counterparties[other] = true end
            end
        end
    end

    -- trust_<lo>_<hi> is itself a top-level rulesParam key (no 'parley_'
    -- prefix — set directly by game_parley.lua's Trust module via
    -- parley/trust.lua's canonical ordering), not nested under parley_<id>_*.
    local trust = {}
    for other in pairs(counterparties) do
        local lo, hi = math.min(teamID, other), math.max(teamID, other)
        trust[other] = tonumber(get('trust_' .. lo .. '_' .. hi)) or 0
    end
    return { proposals = proposals, trust = trust }
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
    -- AI4: the expected-DPS export (power.json) carries the SAME numbers the
    -- client sees (combat-resolution §2.3 / ask C7) — dps/hp/class/scale per
    -- def. Read once via the sandboxed def-export API and re-key by numeric
    -- defID so strength math can look up `power[unit.defId]` directly. JSON
    -- object keys arrive as strings; tonumber() restores the integer key.
    local AI = _G.AI
    if c.defExport then
        local ok, data = pcall(AI.getDefExport, 'power.json')
        if ok and type(data) == 'table' and type(data.defs) == 'table' then
            for sid, entry in pairs(data.defs) do
                powerTable[tonumber(sid) or sid] = entry
            end
        end
    end
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
        parley    = readParley(c, role),
        power     = loadPowerTable(c),

        ledger    = buildLedger(c, regions),
        intel     = updateIntel(c, regions, memory, frame, config),
    }
    -- Guidance funding rate cap (interaction §6.2) clamps the governor's
    -- spend/min — planner.lua's governor() already reads
    -- picture.economy.fundingRateCap; guidance is the source of truth for it.
    if picture.guidance.funding then
        picture.economy.fundingRateCap = picture.guidance.funding.rateCap
    end

    -- Diagnostic surface (a headless AI has no HUD): the runtime log and the
    -- AI4 boundary test read these globals to confirm the static file reads
    -- returned data — same pattern as main.lua's AI_STRATEGOS_BOOT_ERROR.
    local nRegions = 0
    for _ in pairs(regions) do nRegions = nRegions + 1 end
    local nPower = 0
    for _ in pairs(picture.power) do nPower = nPower + 1 end
    _G.AI_STRATEGOS_STATIC_REGIONS = nRegions
    _G.AI_STRATEGOS_STATIC_POWER   = nPower

    return picture
end

return Picture
