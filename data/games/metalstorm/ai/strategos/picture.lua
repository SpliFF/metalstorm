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
        radarBlips  = type(AI) == 'table' and type(AI.getRadarBlips) == 'function', -- position-only contacts
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
-- Empty (no graph loaded, or AI4/AI1 unavailable) is honest "unknown", not
-- an error — regionOf() and every caller already degrade safely on {}.
-- Static region geometry cache. The graph GEOMETRY (polygons, neighbors,
-- value, tags) never changes during a game — only owner/contested do (via
-- region_* rulesParams). The live run flagged the original per-tick reload as
-- the dominant strategic-tick cost: AI.getMapData re-read + JSON-parsed
-- regions.json AND rebuilt the point-lookup grid every 5 s (~7 ms, over the
-- §6 2 ms budget). So load the geometry ONCE, and each tick overlay only the
-- live owner/contested onto the SAME table (stable identity → the regionOf
-- lookup grid, which keys off that identity, also builds once, not per tick).
-- Module-level like powerTable; freshPicture() in the specs reloads the module
-- and resets it, so tests stay isolated.
local staticRegions = nil

local function readRegions(c)
    local AI = _G.AI
    -- Build the static geometry table once, on the first tick that has the AI4
    -- file API. Same regions.json the client mirror (ui/lib/regions.js) fetches
    -- → both agree by construction. Adjacency IS strategic distance (plan §2).
    if staticRegions == nil and c.mapData then
        local ok, data = pcall(AI.getMapData, 'regions.json')
        if ok and type(data) == 'table' and type(data.regions) == 'table' then
            staticRegions = {}
            for _, r in ipairs(data.regions) do
                if r.key then
                    staticRegions[r.key] = {
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
    -- No geometry loaded (AI4 unavailable, or the read failed) → honest empty
    -- "unknown" graph; regionOf() and every caller already degrade safely on {}.
    if staticRegions == nil then return {} end

    -- Overlay live owner/contested from region_* rulesParams (AI1) onto the
    -- cached geometry, IN PLACE. Reset to the static default first so a region
    -- whose param went unknown doesn't keep a stale owner (in practice
    -- game_regions.lua always publishes region_<key>_team as -1..N, never nil,
    -- but resetting is the honest default). Absent rulesParam surface leaves
    -- everything "unknown".
    for _, region in pairs(staticRegions) do
        region.owner = nil
        region.contested = false
    end
    if c.rulesParam then
        for key, region in pairs(staticRegions) do
            local owner = AI.getRulesParam('game', 'region_' .. key .. '_team')
            if owner ~= nil then region.owner = owner end
            local contested = AI.getRulesParam('game', 'region_' .. key .. '_contested')
            if contested ~= nil then
                region.contested = (contested == 1 or contested == true)
            end
        end
    end
    return staticRegions
end

-- Mirrors game_objectives.lua's PUBLISHED_FIELDS (the same list
-- ui/lib/objectives.js's pull() polls) — the public objective contract. The
-- one deliberate omission is `completed_by`: it is only set on a RESOLVED
-- objective, and nothing in the slate reasons about a finished race.
--
-- `victory` was missing here until endtoend Q-E1/D47: game_objectives.lua
-- publishes it PUBLIC precisely so everyone can see which objective ends the
-- war, and the AI was the one reader that never looked. Without it the
-- terminal objective is just a 300-authority control among 110s, so the
-- planner priced the war itself as ~2.7 tactical objectives and skipped it
-- whenever the prize was defended.
local BOARD_FIELDS = {
    'type', 'scope', 'state', 'reward', 'team', 'team2', 'progress',
    'phase', 'stage', 'expire', 'region', 'x', 'z', 'r', 'suggested', 'source',
    'victory',
}

--- Objective board: board[id] = { type, scope, state, reward, team, progress,
-- pos }. Objectives are public (objectives plan §6-E3) → all readable.
-- `objective_count` is a HIGH-WATER MARK, not a live count (game_objectives.lua
-- §1 "Publishing v2"): ids 1..count may be missing (resolved-and-retention-
-- expired, or an id burned by a rejected Create). Mirrors ui/lib/objectives.js's
-- `pull()` poll-per-field pattern exactly, since AI.getRulesParam is the same
-- per-key getter shape — `type` is the field publish() sets first and
-- clearPublished() clears among the rest, so a dead/gap id reads back with no
-- `type` and is skipped, same liveness check as objectives.js's `list()`.
--
-- `source` ('scripted'|'systemic'|'bounty') is now PUBLISHED by
-- game_objectives.lua (task 4) — a staked bounty is publicly known (a commander
-- visibly stakes authority on it), so surfacing the flag is fog-honest, exactly
-- like the pre-existing `suggested` hint. This closes the gap the picture-task-3
-- notes flagged: slate.lua's `o.source == 'bounty'` branch (planner §3.2
-- co-commander ×3 weighting) now fires from real data, not only test fixtures.
-- The raw stake AMOUNT still folds into the published `reward` via
-- `o.reward + EscrowTotal(o.id)` (a bigger reward the AI already values higher);
-- only the categorical bounty FLAG is what the ×3 needs, and that is what ships.
local function readBoard(c)
    local board = {}
    if not c.rulesParam then return board end
    local AI = _G.AI
    local count = tonumber(AI.getRulesParam('game', 'objective_count')) or 0
    for id = 1, count do
        local p = 'objective_' .. id .. '_'
        local o = {}
        for _, field in ipairs(BOARD_FIELDS) do
            o[field] = AI.getRulesParam('game', p .. field)
        end
        if o.type ~= nil then
            -- Position hint is exactly one of `region` (resolve via the
            -- region graph) or `x`/`z`/`r` world coordinates — never both
            -- (game_objectives.lua's positionHint()).
            local pos = nil
            if o.x ~= nil then pos = { x = o.x, z = o.z, r = o.r } end
            board[id] = {
                type = o.type, scope = o.scope, state = o.state,
                reward = o.reward or 0, team = o.team, team2 = o.team2,
                progress = o.progress or 0, phase = o.phase, stage = o.stage,
                expire = o.expire, region = o.region, pos = pos,
                suggested = o.suggested,
                -- `source` ∈ 'scripted'|'systemic'|'bounty' (game_objectives.lua
                -- now publishes it — a staked bounty is publicly known, so this
                -- is fog-honest). slate.lua keys the co-commander ×3 bounty
                -- weighting off source == 'bounty'.
                source = o.source,
                -- Terminal objective (wars §7.1): completing it ENDS THE WAR.
                -- Carried raw (published as 1, absent otherwise) — slate.lua
                -- normalises it the same way it normalises `suggested`.
                victory = o.victory,
            }
        end
    end
    return board
end

--- Economy: own player pool + team pool (authority plan §1 — both
-- team-scoped, allied-visibility rulesParams, NOT public/game-scoped: see
-- game_authority.lua's ALLIED_LOS note).
local function readEconomy(c, role)
    if not c.rulesParam or not (role and role.teamId) then
        return { ownPool = 0, teamPool = 0, costScale = 1.0, reserveHonoured = true,
                 humans = 0 }
    end
    local AI = _G.AI
    -- AI.getRulesParam('team', key) reads OUR OWN team's params only (2-arg,
    -- AI1 — the snapshot carries no other team's rulesParams, fog-honest).
    -- authority_pool is the team-wide savings pool (game_authority.lua
    -- Spring.SetTeamRulesParam(teamID, 'authority_pool', v, ALLIED_LOS)).
    local teamPool = tonumber(AI.getRulesParam('team', 'authority_pool')) or 0

    -- Own player pool (AI3, now LANDED): each AI slot is a real virtual player
    -- with its own `authority_player_<playerID>` pool (integer-normalised key —
    -- game_authority.lua's pkey()), published {allied=true} so this AI reads it
    -- over the 'team' scope. AI.getPlayerId() (AI3) returns the AI's virtual
    -- playerID; -1 means unattributed (single-buffer / test AI) → no own pool.
    local ownPool = 0
    local pid = (type(AI.getPlayerId) == 'function') and AI.getPlayerId() or -1
    if pid and pid >= 0 then
        ownPool = tonumber(AI.getRulesParam('team',
            'authority_player_' .. math.floor(pid))) or 0
    end

    -- Human presence on our team (game_teams.lua's co-commander coordinator
    -- publishes team_active_humans, {allied=true}). Drives the co-commander /
    -- caretaker role switch (§5.1): humans present → etiquette; none → the
    -- full-side slate. Absent param (no coordinator) → nil, treated as "unknown"
    -- by main.lua, which then keeps the profile's baseline role.
    local humans = tonumber(AI.getRulesParam('team', 'team_active_humans'))

    return {
        ownPool = ownPool,
        teamPool = teamPool,
        -- authority_cost_scale (the Initialize()-time modoption) is mirrored
        -- as a PUBLIC game rulesParam by game_authority.lua (publishCostScale) so
        -- the AI predicts directive costs with the same scale the charge
        -- callins actually apply. Absent mirror (older gadget) → 1.0.
        costScale = tonumber(AI.getRulesParam('game', 'authority_cost_scale'))
                    or 1.0,
        teamFallback = role.teamAuthorityFallback or false,
        humans = humans,   -- nil = coordinator absent / unknown
    }
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
-- rulesParam names below match game_ai_guidance.lua's publish() exactly.
-- Degrades to `empty` (the planner already treats an all-empty guidance as
-- "no override", never an error) whenever the role doesn't read guidance or
-- AI.getRulesParam isn't available.
local function readGuidance(c, role)
    local empty = {
        stance = nil, regionPaint = {}, assetLocks = {},
        delegated = {}, funding = nil, roe = nil, veto = {},
    }
    if not (role and role.readsGuidance) or not c.rulesParam then return empty end

    local AI = _G.AI
    local teamID = role.teamId
    local prefix = 'guidance_' .. teamID .. '_'
    -- AI.getRulesParam('team', key) is 2-arg (AI1): 'team' scope is
    -- implicitly OUR OWN team (the snapshot only ever carries this AI's own
    -- teamParams — fog-honest, no cross-team read). The key itself already
    -- embeds teamID as literal text (game_ai_guidance.lua's publish()
    -- convention), which is why `prefix` still needs teamID even though the
    -- scope alone would resolve to the right team.
    local function get(key) return AI.getRulesParam('team', prefix .. key) end

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

--=============================================================================
-- Scenario-authored AI slot configuration (PLAN-metalstorm-ai.md §5 NPC column
-- + §10 task 6 "per-slot profile"). game_scenario.lua's `ai` section publishes
-- these as team rulesParams ({allied=true}); this is the read side.
--
-- Why rulesParams and not a file: the AI4 file API reads STATIC map/def data
-- that is identical for every AI on the map. Per-slot configuration is neither
-- static across slots nor map data — it is per-team game state, which is
-- exactly what the rulesParams mirror (AI1) is for, and it costs nothing new.
--=============================================================================

--- Which profile should this VM wear? Per-player key first (two AIs can share
-- one team — a co-commander pair), then the team-wide key. Returns nil when
-- the scenario/lobby published nothing, leaving Config.DEFAULT_PROFILE.
--
-- The value is UNTRUSTED text that ends up in a `require('profiles.'..name)`,
-- so main.lua validates it against Config.PROFILES before loading; the
-- plugin-scoped loader's own sandbox (no `..`, no separators) is the backstop.
function Picture.readProfileHint(playerId)
    local AI = _G.AI
    if type(AI) ~= 'table' or type(AI.getRulesParam) ~= 'function' then return nil end
    if playerId and playerId >= 0 then
        local v = AI.getRulesParam('team', 'ai_profile_' .. math.floor(playerId))
        if type(v) == 'string' and v ~= '' then return v end
    end
    local v = AI.getRulesParam('team', 'ai_profile')
    if type(v) == 'string' and v ~= '' then return v end
    return nil
end

--- The NPC scripted-slate parameters (scripted.lua's builders consume this).
-- nil when the scenario published no `ai_slate_kinds` — the honest "this AI
-- has no script", which scripted.lua turns into a fall-through to the implicit
-- slate rather than a silently empty goal list.
local function readScript(c)
    if not c.rulesParam then return nil end
    local AI = _G.AI
    local kinds = AI.getRulesParam('team', 'ai_slate_kinds')
    if type(kinds) ~= 'string' or kinds == '' then return nil end
    return {
        kinds   = splitList(kinds),
        home    = AI.getRulesParam('team', 'ai_slate_home'),
        targets = splitList(AI.getRulesParam('team', 'ai_slate_targets')),
        route   = splitList(AI.getRulesParam('team', 'ai_slate_route')),
        reach   = tonumber(AI.getRulesParam('team', 'ai_slate_reach')),
    }
end

--- Parley board + trust ledger (interaction §1/§2). Read-only here; the
-- planner scores proposals (ai/strategos/planner.lua Planner.evaluateProposals),
-- the actuator responds (Actuators:respondProposal — an unimplemented runtime
-- verb, not an engine ask; see actuators.lua:173).
--
-- rulesParam names match game_parley.lua's publish() exactly
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
-- regions and note the fidelity.
--
-- ⚠ WHAT `strength` ACTUALLY IS (endtoend D68, corrected 2026-08-18). The
-- runtime's `unit.health` is a **0-1 ratio**, not absolute hitpoints
-- (`AIStateSnapshot.cpp:45` — `health / maxHealth`), so a bucket's `strength`
-- is a sum of fractions: effectively a HEAD COUNT discounted by damage, and
-- that is the scale every consumer here is calibrated against (pSuccess
-- weighs it against the same-scaled enemy read; `baseSum` prices it; the
-- narration prints it as "N force"). The header used to claim "current health"
-- and the actuator believed it, which is how a 3-unit package asked the engine
-- for 3 hitpoints' worth of force — see `Actuators:_directiveSpec`.
--
-- So each bucket carries BOTH numbers, deliberately:
--   * `strength` — Σ health ratio (effective units). The AI's own scale.
--   * `health`   — Σ ratio x def hp (absolute hitpoints, from power.json).
--     The ENGINE's scale, and the only one that may cross into a directive's
--     `requestedStrength` (`OrgGroups.cpp` accrues `assignedStrength` from
--     `CUnit::health`, absolute).
--=============================================================================

--- def→class lookup: powerTable[defId].class, or nil for defs with no
-- ms_class customParam (statics/civilians — see units/_builder.lua). A
-- missing class buckets under the `_unclassed` byClass key rather than being
-- dropped, so ledger.strength still accounts for every unit's health.
local function classOf(power, defId)
    local entry = power and power[defId]
    return entry and entry.class or nil
end

--- Nominal hitpoints for a def the power table cannot price. Only reachable
-- when the def export is unavailable (the AI4 STUB path) or a def is missing
-- from power.json; a def that IS priced always uses its own `hp`. Warned once
-- rather than silently substituted, because the number it feeds is a
-- directive's demand cap and a wrong one under-commits force (D68).
local NOMINAL_UNIT_HP = 1000
local warnedNominalHp = false

--- Absolute hitpoints for one unit read: the runtime's 0-1 ratio times the
-- def's `hp` from the power table (the same public number players see).
local function absoluteHealth(power, defId, ratio)
    local entry = power and power[defId]
    local hp = entry and tonumber(entry.hp)
    if not hp or hp <= 0 then
        hp = NOMINAL_UNIT_HP
        if not warnedNominalHp then
            warnedNominalHp = true
            local AI = _G.AI
            if type(AI) == 'table' and type(AI.log) == 'function' then
                AI.log(string.format(
                    "[strategos] AI-STANDIN: no power.json hp for def %s (and possibly "
                    .. "others) - pricing force at a nominal %d hp per unit; directive "
                    .. "demand caps are approximate (endtoend D68)",
                    tostring(defId), NOMINAL_UNIT_HP))
            end
        end
    end
    return ratio * hp
end

--- Own force ledger: ledger[regionKey] = { strength, health, groups, byClass }.
-- Buckets units/squads into regions via the region point-lookup grid
-- (regionOf, regions §1.2) and classes via the power-table def→class map
-- (AI4). Unresolved points land under 'wilds' (regionOf's own catch-all,
-- mirroring ui/lib/regions.js); a totally blind AI (no graph loaded) falls
-- back further to the synthetic '_all' bucket.
local function buildLedger(c, regions, power)
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
        local key = Picture.regionOf(u.x, u.z, regions) or '_all'
        local bucket = ledger[key]
        if not bucket then
            bucket = { strength = 0, health = 0, groups = {}, byClass = {} }
            ledger[key] = bucket
        end
        local health = u.health or 0
        bucket.strength = bucket.strength + health
        bucket.health = bucket.health + absoluteHealth(power, u.defId, health)
        local class = classOf(power, u.defId) or '_unclassed'
        bucket.byClass[class] = (bucket.byClass[class] or 0) + health
    end
    return ledger
end

--- Enemy intel with decaying memory (plan §2). Fresh sightings overwrite;
-- unseen regions decay toward "unknown" and are forgotten below a floor.
local function updateIntel(c, regions, memory, frame, config, power)
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

    -- 2. Retract last tick's blip contribution before re-folding. Blips are a
    -- per-tick OBSERVATION (the contact is either on radar now or it isn't),
    -- not accumulating memory — without this, a contact parked on radar for
    -- ten ticks would read as ten contacts.
    for _, mem in pairs(intel) do
        if mem.blipStrength then
            mem.strength = math.max(0, (mem.strength or 0) - mem.blipStrength)
            if mem.byClass then mem.byClass._blip = nil end
            mem.blipStrength = nil
        end
    end

    -- 3. Fold in fresh sightings (raw enemies today; enemy squads under AI2).
    local list
    if c.enemySquads then
        list = AI.getVisibleEnemySquads()
    elseif c.enemyUnits then
        list = AI.getVisibleEnemies()
    end
    local resighted = {}
    for _, e in ipairs(list or {}) do
        local key = Picture.regionOf(e.x, e.z, regions) or '_all'
        local mem = intel[key] or { strength = 0, byClass = {} }
        -- A full-detail resight REPLACES the remembered strength (the header
        -- contract: "fresh sightings overwrite") — reset once per region per
        -- tick, then accumulate this tick's sightings. Without the reset a
        -- region kept in view compounds its remembered strength every tick.
        if not resighted[key] then
            mem.strength, mem.byClass = 0, {}
            resighted[key] = true
        end
        local health = e.health or 0
        mem.strength      = (mem.strength or 0) + health
        local class = classOf(power, e.defId) or '_unclassed'
        mem.byClass[class] = (mem.byClass[class] or 0) + health
        mem.lastSeenFrame = frame
        mem.confidence    = 1.0
        intel[key] = mem
    end

    -- 4. Radar blips (position-only, no unit type) fold in as LOW-confidence
    -- entries. A blip contributes BLIP_STRENGTH of unknown-class threat; a
    -- blip-only region's confidence is held at (at most) BLIP_CONFIDENCE by
    -- re-dating lastSeenFrame so the age-based decay in step 1 reproduces it —
    -- decay above the blip floor continues, but persistent blips stop a
    -- region from being forgotten while something is still on radar.
    if c.radarBlips then
        for _, b in ipairs(AI.getRadarBlips() or {}) do
            local key = Picture.regionOf(b.x, b.z, regions) or '_all'
            local mem = intel[key] or { strength = 0, byClass = {} }
            mem.byClass = mem.byClass or {}
            mem.strength     = (mem.strength or 0) + config.BLIP_STRENGTH
            mem.blipStrength = (mem.blipStrength or 0) + config.BLIP_STRENGTH
            mem.byClass._blip = (mem.byClass._blip or 0) + config.BLIP_STRENGTH
            if mem.lastSeenFrame ~= frame then
                -- Not freshly LOS-seen this tick: hold confidence at the
                -- blip floor (never lower an as-yet-higher decayed memory).
                local conf = math.max(mem.confidence or 0, config.BLIP_CONFIDENCE)
                mem.confidence = conf
                mem.lastSeenFrame = frame
                    - math.floor((1 - conf) * config.INTEL_DECAY_FRAMES)
            end
            intel[key] = mem
        end
    end

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
-- Region point-lookup (shared helper). Mirrors ui/lib/regions.js's
-- `graphKeyAt` EXACTLY (same cell size, same bbox-then-point-in-polygon
-- confirm, same 'wilds' fallback) — client-side order-cost prediction and
-- this Picture must agree on which region a point falls in, or the AI's
-- authority-cost math (config.lua predictDirectiveCost) would silently
-- diverge from what the sim actually charges (regions plan §5).
--=============================================================================
local DEFAULT_LOOKUP_CELL = 256

--- Ray-casting point-in-polygon test — identical algorithm to
-- ui/lib/regions.js's `pointInPolygon` (same edge-crossing formula, same
-- z/x roles), just Lua's 1-based indexing in place of JS's 0-based.
local function pointInPolygon(x, z, polygon)
    local inside = false
    local n = #polygon
    local j = n
    for i = 1, n do
        local pi, pj = polygon[i], polygon[j]
        if ((pi.z > z) ~= (pj.z > z)) and
           (x < (pj.x - pi.x) * (z - pi.z) / (pj.z - pi.z) + pi.x) then
            inside = not inside
        end
        j = i
    end
    return inside
end

--- Cell ("cx:cz") → list of region keys whose bbox overlaps it. Mirrors
-- ui/lib/regions.js's `buildLookupGrid` (bbox-per-region, register into
-- every overlapped cell; no bounds clamping needed here since authored
-- polygons are already validated in-bounds — MapProcessor.cpp rejects
-- out-of-bounds vertices at export time).
local function buildLookupGrid(regions, cellSize)
    local cells = {}
    for key, r in pairs(regions) do
        local polygon = r.polygon
        if polygon and #polygon > 0 then
            local minX, maxX = math.huge, -math.huge
            local minZ, maxZ = math.huge, -math.huge
            for _, pt in ipairs(polygon) do
                if pt.x < minX then minX = pt.x end
                if pt.x > maxX then maxX = pt.x end
                if pt.z < minZ then minZ = pt.z end
                if pt.z > maxZ then maxZ = pt.z end
            end
            local cx0, cx1 = math.floor(minX / cellSize), math.floor(maxX / cellSize)
            local cz0, cz1 = math.floor(minZ / cellSize), math.floor(maxZ / cellSize)
            for cz = cz0, cz1 do
                for cx = cx0, cx1 do
                    local cellKey = cx .. ':' .. cz
                    local list = cells[cellKey]
                    if not list then list = {}; cells[cellKey] = list end
                    list[#list + 1] = key
                end
            end
        end
    end
    return { cellSize = cellSize, cells = cells }
end

-- Cached by object identity of the `regions` table it was built from. Since
-- readRegions() now caches the static geometry and returns the SAME table
-- every tick (only owner/contested change, overlaid in place — the grid keys
-- off polygons, which don't), this cache hits across ticks too: the lookup
-- grid is built ONCE for the whole game, not per tick. Within a tick it still
-- amortises the per-unit cost (buildLedger/updateIntel call regionOf once per
-- own/enemy unit against the same table). A fresh regions table (e.g. a test
-- fixture, or a future dynamic graph) naturally misses and rebuilds.
local cachedGridFor, cachedGrid = nil, nil

--- Region at world position → key. O(1) cell lookup (bbox filter) + a
-- point-in-polygon confirm on every bbox candidate (a cell's overlap list is
-- a filter, not a verdict — same reasoning as the client). `nil` regions (no
-- graph loaded at all, a blind AI) → nil, matching the existing '_all'
-- synthetic-bucket convention callers already use; a loaded graph with no
-- polygon covering the point → 'wilds', the reserved catch-all key
-- (regions/partition.lua validateGraph — an authored region may never claim
-- it) — the SAME resolution ui/lib/regions.js's graph provider returns.
function Picture.regionOf(x, z, regions)
    if not regions or next(regions) == nil then return nil end

    if cachedGridFor ~= regions then
        cachedGrid = buildLookupGrid(regions, DEFAULT_LOOKUP_CELL)
        cachedGridFor = regions
    end

    local cx = math.floor(x / cachedGrid.cellSize)
    local cz = math.floor(z / cachedGrid.cellSize)
    local candidates = cachedGrid.cells[cx .. ':' .. cz]
    if candidates then
        for _, key in ipairs(candidates) do
            local r = regions[key]
            if r and r.polygon and pointInPolygon(x, z, r.polygon) then
                return key
            end
        end
    end
    return 'wilds'
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
    local power   = loadPowerTable(c)   -- computed first: ledger/intel byClass keys off it
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
        -- Scenario-authored NPC slate parameters (§5); nil for un-scripted AIs.
        script    = readScript(c),
        power     = power,

        ledger    = buildLedger(c, regions, power),
        intel     = updateIntel(c, regions, memory, frame, config, power),
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
