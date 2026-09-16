-- game_tutorial.lua — the Tutorial Director (PLAN-metalstorm-onboarding.md §2).
--
-- Sequences the coaching BEATS of a tutorial scenario. It is data-driven: the
-- scenario file declares `tutorial = true` and a top-level `beats` table, and
-- this gadget walks that table one beat at a time, publishing the current beat
-- as rulesParams for the in-battle coach widget (ui/widgets/tutorial-guide.js)
-- and advancing when the beat's `wait` condition is met. There is no code per
-- scenario: tutorial_01/02/03 differ only in their data.
--
-- NO-OP unless `GG.Scenario.data.tutorial == true` (checked at GameStart,
-- which runs after game_scenario.lua's — layer -90 < -30).
--
-- ── Beat schema (authored in scenarios/tutorial_NN.lua) ─────────────────────
--
--   { id    = 'move',                       -- unique, stable; the widget's ack key
--     title = 'Move a squad',               -- one line
--     text  = 'Right-click open ground…',   -- one short paragraph (<= ~240 chars)
--     show  = { region = 'grey_flat' }      -- optional "Show me" target: a region
--           | { x = 4480, z = 4480 }        --   key, a map point, or a HUD panel
--           | { panel = 'objectives' },     --   (the access point's tab / a widget)
--     wait  = <condition, below>,
--     objective = { … }                     -- optional: a REAL objective, created
--                                           --   when the beat starts, in the same
--                                           --   flat dialect scenarios use
--                                           --   (type/region/reward/holdFrames…).
--                                           --   Never `victory` — the scenario
--                                           --   file owns the terminal objective.
--     parley = { kind = 'intel', toTeam = 1, -- optional: a proposal the coach card
--                regionKeys = { 'raven_basin' } } -- offers to send on the player's behalf
--     timeoutFrames = 2700 }                -- optional: after this long the beat
--                                           --   publishes `tutorial_hint = 'stuck'`
--                                           --   (the widget promotes Skip). Never
--                                           --   auto-advances.
--
-- `wait` kinds — each names WHO decides the beat is done:
--
--   { kind = 'ack' }                          the player dismisses the card
--   { kind = 'client', check = 'selection' }  the widget verifies a CLIENT-side
--                                             fact (selection / drilldown / menu /
--                                             console) and acks — the sim cannot see
--                                             a selection, so it trusts the widget
--   { kind = 'presence', region = k, min = 1 }   >= min team units standing in k
--   { kind = 'region',   region = k }            the team controls k
--   { kind = 'objective' }                       this beat's own `objective` completes
--   { kind = 'charge',   min = 1 }               >= min authority charges since the
--                                                beat started (an order was paid for)
--   { kind = 'award',    min = 1 }               >= min authority awards since start
--   { kind = 'withdrawn', min = 1 }              >= min units left via a departure zone
--   { kind = 'units', def = 'ms_soldiers_s1', min = 3 }   team owns >= min live units
--                                                of that def (an arrival has landed)
--   { kind = 'parley' }                          the team sent a parley proposal
--   { kind = 'pact', pact = 'intel' }            a proposal involving the team (of
--                                                that kind, if given) was ACCEPTED
--                                                since the beat started
--   { kind = 'guidance', field = 'delegated' }   the team's AI-guidance store has a
--                                                non-empty `field` (stance / delegated
--                                                / region_paint / asset_locks / roe)
--   { kind = 'frames', frames = 300 }            time elapsed (narration pacing)
--
-- ── Published rulesParams (all PUBLIC; the widget's whole input) ─────────────
--
--   tutorial_active      1 while a tutorial scenario is loaded (0/absent otherwise)
--   tutorial_team        the learning team (the coach renders for that team only)
--   tutorial_state       'running' | 'done' | 'stopped'
--   tutorial_beat        1-based index of the current beat; tutorial_beat_count total
--   tutorial_beat_id / tutorial_title / tutorial_text
--   tutorial_wait        the wait kind; tutorial_check the client check name
--   tutorial_show_x/_z   resolved "Show me" point (region centroids resolved here so
--                        the widget needs no map knowledge); tutorial_show_panel
--   tutorial_objective   the beat's live objective id (the board shows it)
--   tutorial_parley_kind/_to/_regions   the beat's offered proposal, if any
--   tutorial_hint        'stuck' after timeoutFrames, else cleared
--   tutorial_rev         increments on every publish — the widget's change key
--
-- ── Wire (client → this gadget, gadget:RecvLuaMsg, parley/wire.lua codec) ───
--
--   cmd=tutorial.ack&beat=<id>     finish an 'ack' / 'client' beat
--   cmd=tutorial.skip&beat=<id>    skip the current beat (its objective is failed)
--   cmd=tutorial.restart           back to beat 1
--   cmd=tutorial.stop              hide the coach for the rest of this session
--
-- Only players on the learning team are honoured; every refusal is echoed.
--
-- PERIODIC WORK uses tick.lua's `due()` gate (never `frame % PERIOD` — D15).
-- No Save/Load: tutorial rooms are `ephemeral` (onboarding §6 E1) and never
-- hibernate; "tutorial done" is remembered client-side (localStorage).

function gadget:GetInfo()
    return {
        name    = "Tutorial Director",
        desc    = "Sequences a tutorial scenario's coaching beats over the real backbone",
        author  = "metalstorm",
        date    = "2026",
        license = "GPL v2",
        layer   = -30,             -- after scenario (-90), objectives (-50), civilians (-40)
        enabled = true,
    }
end

if not gadgetHandler:IsSyncedCode() then
    return false
end

local Tick = VFS.Include("LuaRules/Gadgets/tick.lua")
local Wire = VFS.Include("LuaRules/Gadgets/parley/wire.lua")

local POLL_PERIOD = 30          -- frames: sim-side wait conditions are sampled once a second
local PUBLIC = { public = true }
local LOG = '[game_tutorial] '

local WAIT_KINDS = {
    ack = true, client = true, presence = true, region = true, objective = true,
    charge = true, award = true, withdrawn = true, units = true, parley = true,
    guidance = true, frames = true, pact = true,
}

local CLIENT_CHECKS = { selection = true, drilldown = true, menu = true, console = true, none = true }

-- ============================================================
-- State
-- ============================================================
local active = false
local beats = {}
local team = nil
local idx = 0                   -- current beat (1-based); 0 = not started
local state = 'idle'            -- 'running' | 'done' | 'stopped'
local rev = 0
local beatStartFrame = 0
local beatObjectiveId = nil
local beatObjectiveDone = false
local hint = nil
local counters = { charge = 0, award = 0, parley = 0 }
local parleyCountAtStart = 0    -- proposals published before the current beat
local pollGate = Tick.new(POLL_PERIOD)

local function echo(msg) Spring.Echo(LOG .. msg) end

-- The engine returns NO value (not nil) for an absent param; the parentheses
-- adjust that to nil so tonumber()/comparisons never see an empty call.
local function rp(key) return (Spring.GetGameRulesParam(key)) end

local function playerTeam(playerID)
    if playerID == nil then return nil end
    local _, _, _, teamID = Spring.GetPlayerInfo(playerID, false)
    return teamID
end

-- ============================================================
-- Beat validation (a bad beat is dropped with a log line, never a crash —
-- the tutorial is the one place a new player must never see a Lua error)
-- ============================================================
local function validateBeats(list)
    local out, seen = {}, {}
    for i, b in ipairs(list or {}) do
        local ctx = 'beats[' .. i .. ']'
        local problems = {}
        if type(b) ~= 'table' then
            problems[#problems + 1] = 'not a table'
        else
            if type(b.id) ~= 'string' or b.id == '' then
                problems[#problems + 1] = 'needs a string "id"'
            elseif seen[b.id] then
                problems[#problems + 1] = 'duplicate id "' .. b.id .. '"'
            end
            if type(b.title) ~= 'string' then problems[#problems + 1] = 'needs a string "title"' end
            if type(b.text) ~= 'string' then problems[#problems + 1] = 'needs a string "text"' end
            local w = b.wait
            if type(w) ~= 'table' or not WAIT_KINDS[w.kind] then
                problems[#problems + 1] = 'unknown wait kind "' .. tostring(w and w.kind) .. '"'
            else
                if (w.kind == 'presence' or w.kind == 'region') and type(w.region) ~= 'string' then
                    problems[#problems + 1] = 'wait.' .. w.kind .. ' needs a string "region"'
                end
                if w.kind == 'units' and type(w.def) ~= 'string' then
                    problems[#problems + 1] = 'wait.units needs a string "def"'
                end
                if w.kind == 'frames' and type(w.frames) ~= 'number' then
                    problems[#problems + 1] = 'wait.frames needs a number "frames"'
                end
                if w.kind == 'client' and not CLIENT_CHECKS[w.check or 'none'] then
                    problems[#problems + 1] = 'unknown client check "' .. tostring(w.check) .. '"'
                end
                if w.kind == 'objective' and type(b.objective) ~= 'table' then
                    problems[#problems + 1] = 'wait.objective needs an "objective" on the beat'
                end
                if w.kind == 'guidance' and type(w.field) ~= 'string' then
                    problems[#problems + 1] = 'wait.guidance needs a string "field"'
                end
            end
            if b.parley ~= nil and (type(b.parley) ~= 'table' or type(b.parley.kind) ~= 'string'
                                    or type(b.parley.toTeam) ~= 'number') then
                problems[#problems + 1] = '"parley" needs a string "kind" and a number "toTeam"'
            end
            if b.objective ~= nil then
                if type(b.objective) ~= 'table' or type(b.objective.type) ~= 'string' then
                    problems[#problems + 1] = '"objective" must be a table with a string "type"'
                elseif b.objective.victory then
                    problems[#problems + 1] = 'a beat objective may not be the victory objective'
                end
            end
        end
        if #problems == 0 then
            seen[b.id] = true
            out[#out + 1] = b
        else
            echo('WARNING: ' .. ctx .. ' dropped — ' .. table.concat(problems, '; '))
        end
    end
    return out
end

-- ============================================================
-- Publication
-- ============================================================
local PUBLISHED = {
    'tutorial_beat', 'tutorial_beat_id', 'tutorial_title', 'tutorial_text', 'tutorial_wait',
    'tutorial_check', 'tutorial_show_x', 'tutorial_show_z', 'tutorial_show_panel',
    'tutorial_objective', 'tutorial_hint',
    'tutorial_parley_kind', 'tutorial_parley_to', 'tutorial_parley_regions',
}

local function set(key, value)
    if value == nil then
        Spring.SetGameRulesParam(key, nil)
    else
        Spring.SetGameRulesParam(key, value, PUBLIC)
    end
end

--- Resolve a beat's `show` target to a map point the widget can travel to.
local function resolveShow(show)
    if type(show) ~= 'table' then return nil, nil, nil end
    if show.panel then return nil, nil, tostring(show.panel) end
    if type(show.x) == 'number' and type(show.z) == 'number' then return show.x, show.z, nil end
    if type(show.region) == 'string' then
        if GG.Regions and GG.Regions.Area then
            local x, z = GG.Regions.Area(show.region)
            if x then return x, z, nil end
        end
        local x = rp('region_' .. show.region .. '_x')
        local z = rp('region_' .. show.region .. '_z')
        if x and z then return x, z, nil end
    end
    return nil, nil, nil
end

local function publish()
    rev = rev + 1
    set('tutorial_active', active and 1 or 0)
    set('tutorial_team', team)
    set('tutorial_state', state)
    set('tutorial_beat_count', #beats)
    local b = beats[idx]
    if b and state == 'running' then
        local sx, sz, panel = resolveShow(b.show)
        set('tutorial_beat', idx)
        set('tutorial_beat_id', b.id)
        set('tutorial_title', b.title)
        set('tutorial_text', b.text)
        set('tutorial_wait', b.wait.kind)
        set('tutorial_check', b.wait.kind == 'client' and (b.wait.check or 'none') or nil)
        set('tutorial_show_x', sx)
        set('tutorial_show_z', sz)
        set('tutorial_show_panel', panel)
        set('tutorial_objective', beatObjectiveId)
        set('tutorial_hint', hint)
        local pr = b.parley
        set('tutorial_parley_kind', pr and pr.kind or nil)
        set('tutorial_parley_to', pr and pr.toTeam or nil)
        set('tutorial_parley_regions', pr and pr.regionKeys and table.concat(pr.regionKeys, ',') or nil)
    else
        for _, k in ipairs(PUBLISHED) do set(k, nil) end
    end
    set('tutorial_rev', rev)
end

-- ============================================================
-- Beat objectives — the same flat dialect scenarios use (game_scenario.lua
-- foldParams), folded here so a beat reads like an objectives[] entry.
-- ============================================================
local DEFAULT_HOLD_FRAMES = 900

local function foldObjective(o)
    local params = {}
    for k, v in pairs(o.params or {}) do params[k] = v end
    if o.region and params.regionKey == nil then params.regionKey = o.region end
    if o.targetUnitID and params.targetUnitID == nil then params.targetUnitID = o.targetUnitID end
    if o.duration and params.duration == nil then params.duration = o.duration end
    if o.type == 'control' and params.holdFrames == nil then
        params.holdFrames = o.holdFrames or DEFAULT_HOLD_FRAMES
    end
    if o.notBefore and params.notBefore == nil then params.notBefore = o.notBefore end
    return {
        type = o.type, scope = o.scope or 'tactical',
        forTeam = (o.forTeam == nil) and team or o.forTeam,
        reward = o.reward or 0, bounty = o.bounty or 0,
        expiresAtFrame = o.expiresAtFrame,
        params = params,
        source = 'scripted',
    }
end

local function createBeatObjective(b)
    beatObjectiveId, beatObjectiveDone = nil, false
    if not b.objective then return end
    if not (GG.Objectives and GG.Objectives.Create) then
        echo('WARNING: GG.Objectives.Create missing — beat "' .. b.id .. '" has no objective')
        return
    end
    local id = GG.Objectives.Create(foldObjective(b.objective))
    if id then
        beatObjectiveId = id
        echo('beat "' .. b.id .. '" posted objective ' .. tostring(id) .. ' (' .. b.objective.type .. ')')
    else
        echo('WARNING: beat "' .. b.id .. '" objective was rejected — the beat can only be acked or skipped')
    end
end

local function failBeatObjective()
    if beatObjectiveId and not beatObjectiveDone and GG.Objectives and GG.Objectives.Fail then
        GG.Objectives.Fail(beatObjectiveId)
    end
    beatObjectiveId, beatObjectiveDone = nil, false
end

-- ============================================================
-- Sequencing
-- ============================================================
local function startBeat(i, frame)
    idx = i
    beatStartFrame = frame
    hint = nil
    counters.charge, counters.award, counters.parley = 0, 0, 0
    parleyCountAtStart = tonumber(rp('parley_count')) or 0
    -- A fresh gate so the first poll of a new beat lands one period in, not
    -- on whatever phase the previous beat left behind.
    pollGate = Tick.new(POLL_PERIOD)
    createBeatObjective(beats[i])
    echo('beat ' .. i .. '/' .. #beats .. ' "' .. beats[i].id .. '" — waiting on ' .. beats[i].wait.kind)
    publish()
end

local function finish()
    state = 'done'
    beatObjectiveId, beatObjectiveDone = nil, false
    echo('all ' .. #beats .. ' beats complete')
    publish()
end

local function advance(frame)
    if state ~= 'running' then return end
    if idx >= #beats then finish() return end
    startBeat(idx + 1, frame)
end

-- ============================================================
-- Wait-condition evaluation
-- ============================================================
local function teamUnits()
    return Spring.GetTeamUnits(team) or {}
end

local function unitsInRegion(key)
    if not (GG.Regions and GG.Regions.KeyAt) then return 0 end
    local n = 0
    for _, unitID in ipairs(teamUnits()) do
        local x, _, z = Spring.GetUnitPosition(unitID)
        if x and GG.Regions.KeyAt(x, z) == key then n = n + 1 end
    end
    return n
end

local function unitsOfDef(defName)
    local n = 0
    for _, unitID in ipairs(teamUnits()) do
        local defID = Spring.GetUnitDefID(unitID)
        local ud = defID and UnitDefs[defID]
        if ud and ud.name == defName then n = n + 1 end
    end
    return n
end

local function guidanceHas(field)
    if not (GG.AIGuidance and GG.AIGuidance.Get) then return false end
    local g = GG.AIGuidance.Get(team)
    local v = g and g[field]
    if v == nil then return false end
    if type(v) == 'table' then return next(v) ~= nil end
    return v ~= '' and v ~= false
end

--- An accepted pact involving the learning team, published since the beat
--- started (game_parley.lua's `parley_<id>_*` params), of `kind` if given.
local function pactAccepted(kind)
    local n = tonumber(rp('parley_count')) or 0
    for id = parleyCountAtStart + 1, n do
        local p = 'parley_' .. id .. '_'
        local state = rp(p .. 'state')
        if (state == 'active' or state == 'fulfilled')
            and (kind == nil or rp(p .. 'kind') == kind) then
            local from = tonumber(rp(p .. 'from'))
            local to = tonumber(rp(p .. 'to'))
            if from == team or to == team then return true end
        end
    end
    return false
end

--- True when the current beat's sim-side wait is satisfied. 'ack' and
--- 'client' beats are never satisfied here — only the wire finishes them.
local function waitSatisfied(b, frame)
    local w = b.wait
    local k = w.kind
    if k == 'presence' then
        return unitsInRegion(w.region) >= (w.min or 1)
    elseif k == 'region' then
        return GG.Regions and GG.Regions.ControllingTeam
            and GG.Regions.ControllingTeam(w.region) == team
    elseif k == 'objective' then
        return beatObjectiveDone
    elseif k == 'charge' then
        return counters.charge >= (w.min or 1)
    elseif k == 'award' then
        return counters.award >= (w.min or 1)
    elseif k == 'withdrawn' then
        return GG.Transports and GG.Transports.Withdrawn
            and (GG.Transports.Withdrawn(team) or 0) >= (w.min or 1)
    elseif k == 'units' then
        return unitsOfDef(w.def) >= (w.min or 1)
    elseif k == 'parley' then
        return counters.parley >= (w.min or 1)
    elseif k == 'pact' then
        return pactAccepted(w.pact)
    elseif k == 'guidance' then
        return guidanceHas(w.field)
    elseif k == 'frames' then
        return frame - beatStartFrame >= w.frames
    end
    return false
end

local function poll(frame)
    local b = beats[idx]
    if not b then return end
    -- A beat objective that failed or expired underneath us (a protect target
    -- died, a hold expired) is re-posted rather than left as a dead end.
    if beatObjectiveId and not beatObjectiveDone and GG.Objectives and GG.Objectives.Get then
        local o = GG.Objectives.Get(beatObjectiveId)
        if o and o.state ~= 'active' and o.state ~= 'complete' then
            echo('beat "' .. b.id .. '" objective ' .. beatObjectiveId .. ' ' .. tostring(o.state) .. ' — re-posting')
            createBeatObjective(b)
            publish()
        end
    end
    if waitSatisfied(b, frame) then
        echo('beat "' .. b.id .. '" complete')
        advance(frame)
        return
    end
    if b.timeoutFrames and hint == nil and frame - beatStartFrame >= b.timeoutFrames then
        hint = 'stuck'
        publish()
    end
end

-- ============================================================
-- Hooks into the backbone
-- ============================================================
local function onObjectiveComplete(o)
    if not active or state ~= 'running' then return end
    if beatObjectiveId and o.id == beatObjectiveId then
        beatObjectiveDone = true
        -- Objective completion is the one sim event worth reacting to at once
        -- rather than on the next poll: the award toast and the coach card
        -- should agree on the frame.
        local b = beats[idx]
        if b and b.wait.kind == 'objective' then
            echo('beat "' .. b.id .. '" complete')
            advance(Spring.GetGameFrame())
        end
    end
end

local function onCharge(_, teamID)
    if active and teamID == team then counters.charge = counters.charge + 1 end
end

local function onAward(_, teamID)
    if active and teamID == team then counters.award = counters.award + 1 end
end

local function onPropose(p)
    if active and p and p.fromTeam == team then counters.parley = counters.parley + 1 end
end

function gadget:Initialize()
    if GG.Objectives and GG.Objectives.OnComplete then GG.Objectives.OnComplete(onObjectiveComplete) end
    if GG.Authority and GG.Authority.OnCharge then GG.Authority.OnCharge(onCharge) end
    if GG.Authority and GG.Authority.OnAward then GG.Authority.OnAward(onAward) end
    if GG.Parley and GG.Parley.OnPropose then GG.Parley.OnPropose(onPropose) end
end

function gadget:GameStart()
    local scn = GG.Scenario and GG.Scenario.data
    if not (scn and scn.tutorial == true) then
        active = false
        return
    end
    beats = validateBeats(scn.beats)
    if #beats == 0 then
        echo('WARNING: scenario "' .. tostring(GG.Scenario.name) ..
             '" declares tutorial = true but no usable `beats` — the coach has nothing to say')
        active = false
        return
    end
    team = scn.tutorialTeam
    if team == nil then
        local side = scn.sides and scn.sides[1]
        team = (side and type(side.team) == 'number') and side.team or 0
    end
    active = true
    state = 'running'
    echo('active for team ' .. tostring(team) .. ' — ' .. #beats .. ' beat(s)')
    startBeat(1, Spring.GetGameFrame())
end

function gadget:GameFrame(frame)
    if not active or state ~= 'running' then return end
    if Tick.due(pollGate, frame) then poll(frame) end
end

function gadget:RecvLuaMsg(msg, playerID)
    if not active then return end
    local cmd, fields = Wire.decode(msg)
    if type(cmd) ~= 'string' or cmd:sub(1, 9) ~= 'tutorial.' then return end
    local pt = playerTeam(playerID)
    if pt ~= team then
        echo('refused ' .. cmd .. ' from player ' .. tostring(playerID) .. ' (team ' ..
             tostring(pt) .. ' is not the learning team ' .. tostring(team) .. ')')
        return
    end
    local frame = Spring.GetGameFrame()
    local b = beats[idx]
    if cmd == 'tutorial.ack' then
        if state ~= 'running' or not b then return end
        if fields.beat ~= b.id then
            echo('ignored ack for "' .. tostring(fields.beat) .. '" — current beat is "' .. b.id .. '"')
            return
        end
        if b.wait.kind ~= 'ack' and b.wait.kind ~= 'client' then
            echo('ignored ack — beat "' .. b.id .. '" waits on ' .. b.wait.kind .. ', not the player')
            return
        end
        echo('beat "' .. b.id .. '" acked')
        advance(frame)
    elseif cmd == 'tutorial.skip' then
        if state ~= 'running' or not b then return end
        if fields.beat ~= nil and fields.beat ~= b.id then
            echo('ignored skip for "' .. tostring(fields.beat) .. '" — current beat is "' .. b.id .. '"')
            return
        end
        echo('beat "' .. b.id .. '" skipped')
        failBeatObjective()
        advance(frame)
    elseif cmd == 'tutorial.restart' then
        failBeatObjective()
        state = 'running'
        echo('restarted')
        startBeat(1, frame)
    elseif cmd == 'tutorial.stop' then
        failBeatObjective()
        state = 'stopped'
        echo('stopped by player ' .. tostring(playerID))
        publish()
    end
end
