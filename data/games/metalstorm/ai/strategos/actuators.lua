-- actuators.lua — the ENTIRE write surface (PLAN-metalstorm-ai.md §4).
--
-- THE DESIGN LAW (plan §1/§4): the AI's command floor is the macro directive.
-- It may issue army/platoon directives, postures, build initiations, group
-- creates, and bounty stakes — it may NEVER issue a per-squad CMD_*. This is
-- enforced STRUCTURALLY: this module simply has no moveSquad/attackTarget
-- function, and the AI-VM command surface it calls (AI.createGroup /
-- AI.issueDirective / AI.setPosture) is directive-shaped only — there is no
-- squad-targeting verb to reach for. The planner cannot micro because no verb
-- for it exists at any layer.
--
-- ONE COMMAND PATH (AI2, decided 2026-07-26): these verbs push commands the
-- engine drains on the sim thread and applies through the SAME managers +
-- charge callins a human player's wire message hits (OrgGroupManager /
-- DirectiveManager, AllowDirectiveCreate). The AI issues exactly what humans
-- issue — same evaluator, same decomposition, same authority accounting. The
-- pre-AI2 standing-order fallback is GONE (plan §10 task 5): there is only the
-- real path now.

-- The intent tag (`ai.intent`, PLAN-ai-synced-write.md §2.5) rides the SAME
-- query-string codec the guidance gadget decodes with. `wire.lua` is a copy in
-- this folder, not a reach into LuaRules/ — the AI4 sandbox forbids that; see
-- that file's header for the drift guard.
local Wire = require('wire')

local Actuators = {}
Actuators.__index = Actuators

-- Mirrors the engine enums (rts/Server/OrgGroups.h) 1:1 — the numeric wire the
-- AI command verbs marshal. DirectiveType 0..7 alias the classic standing-order
-- types; 8..14 are the platoon-level macro directives (macro-orders §2).
local DirectiveType = {
    DefendArea = 0, PatrolRoute = 1, RallyPoint = 2, Fallback = 3,
    Reinforce = 4, Screen = 5, SupplyRoute = 6, BuildBase = 7,
    MoveFormation = 8, Assault = 9, Defend = 10, Overwatch = 11,
    Withdraw = 12, Escort = 13, DefendFront = 14,
}
local OrderShape = { Point = 0, Circle = 1, Polygon = 2, Polyline = 3 }
local Echelon    = { Squad = 0, Platoon = 1, Army = 2 }

-- The planner speaks in directive SHAPE names (slate.lua's `directive` field);
-- map each to the engine DirectiveType it requests. All are AREA / behaviour
-- directives — never single-target micro; the strategic floor holds in the
-- mapping too (a name that would require target-picking simply isn't here).
local DIRECTIVE_FOR_NAME = {
    DEFEND        = DirectiveType.Defend,
    DEFEND_FRONT  = DirectiveType.DefendFront,
    SCREEN        = DirectiveType.Screen,
    TAKE_AND_HOLD = DirectiveType.Assault,   -- advance and hold an area
    ASSAULT       = DirectiveType.Assault,
    SECURE        = DirectiveType.Assault,
    ESCORT        = DirectiveType.Escort,
    BUILD         = DirectiveType.BuildBase,
    RALLY         = DirectiveType.RallyPoint,
    WITHDRAW      = DirectiveType.Withdraw,
    OVERWATCH     = DirectiveType.Overwatch,
}

--- Fallback directive lifetime, in frames, when the caller does not state the
-- strategic tick period. 15 s at 30 Hz = 3 x the LOD-0 tick, so a directive
-- always outlives the tick that issued it. NEVER 0: 0 means "no expiry", and a
-- planner that re-states its whole plan every tick with no expiry accumulates
-- one live directive per goal per tick forever (measured: 107 live directives on
-- one team by frame 6 000, every one of them commanding the same eight units —
-- endtoend D68).
local DEFAULT_DIRECTIVE_TTL_FRAMES = 450

--=============================================================================
-- Construction.  cfg = { role, profile }.
--=============================================================================
function Actuators.new(cfg)
    local self = setmetatable({}, Actuators)
    self.role    = cfg.role
    self.profile = cfg.profile
    self.caps    = Actuators._detect()
    self.lastIntent = nil
    self.lastSuggestFrame = nil  -- rate limiter for suggest-only mode (mentor)
    self.ttlFrames = nil         -- set per apply() from the live tick period
    return self
end

function Actuators._detect()
    local AI = _G.AI
    local has = function(fn) return type(AI) == 'table' and type(AI[fn]) == 'function' end
    return {
        createGroup    = has('createGroup'),      -- AI2
        issueDirective = has('issueDirective'),   -- AI2
        setPosture     = has('setPosture'),       -- AI2
        initiateBuild  = has('initiateBuild'),    -- AI2 (not yet on the surface)
        chat           = has('chat') or has('sendChat'),
        log            = has('log'),               -- server-log channel (headless)
        marker         = has('marker') or has('setMarker'),
        stakeBounty    = has('stakeBounty'),      -- authority stake from AI
        respond        = has('respondProposal'),  -- interaction §6.2 (not on the surface)
        propose        = has('propose'),          -- interaction §6.2 (not on the surface)
        sendMessage    = has('sendMessage'),      -- I1/SG1 (AI → synced RecvLuaMsg)
    }
end

--=============================================================================
-- PUBLIC SURFACE (plan §4). Note the conspicuous absence of any per-squad
-- command — that absence IS the strategic floor.
--=============================================================================

--- Create an org-group from squads at an echelon (PLAN-macro-orders §1).
-- Returns the engine group HANDLE (a negative token the AI can pass straight
-- to issueDirective/setPosture this same tick — the engine resolves it to the
-- real group id when it drains the batch). nil if the verb is unavailable.
function Actuators:createGroup(squadIds, echelon)
    if not self.caps.createGroup then return nil end
    return _G.AI.createGroup(squadIds, echelon or Echelon.Platoon)
end

--- Issue an area/platoon macro directive. `spec` is the numeric engine spec
-- ({type, priority, shape, params, requestedStrength, within}); `groupHandle`
-- is a createGroup handle, a real group id, or 0/nil for condition-area scope.
function Actuators:issueDirective(groupHandle, spec)
    if not self.caps.issueDirective then return false end
    return _G.AI.issueDirective(groupHandle or 0, spec)
end

--- Send an opaque message into synced game Lua (engine ask I1 / SG1). The
--- engine drains it on the sim thread and hands it to `gadget:RecvLuaMsg(msg,
--- playerID)` — the SAME entry point a human's wire message lands on, with this
--- AI's real playerID (AI3 made AI slots real players), so the gadget's
--- validated-writer checks work unchanged. Fire-and-forget: the engine returns
--- false when its 2 KB size clamp rejects the payload, and a throttled AI is
--- meant to degrade, not raise.
function Actuators:sendMessage(msg)
    if not self.caps.sendMessage then return false end
    return _G.AI.sendMessage(msg)
end

--- Set an engagement/casualty/ROE posture on a group (nearly free, §authority).
function Actuators:setPosture(groupHandle, postureJson)
    if not self.caps.setPosture then return false end
    return _G.AI.setPosture(groupHandle or 0, postureJson)
end

--- Initiate a build at a factory (charged; strategic commitment §8).
-- Build-initiation verb is a later AI2 slice (needs a factory/build protocol
-- on the AI surface); no-op until then rather than faking it.
function Actuators:initiateBuild(factoryId, defName)
    if self.caps.initiateBuild then
        return _G.AI.initiateBuild(factoryId, defName)
    end
    return false
end

--- Stake a bounty on an objective (full-side delegation tool §4/§5).
function Actuators:stakeBounty(objectiveDef, amount)
    if self.caps.stakeBounty then
        return _G.AI.stakeBounty(objectiveDef, amount)
    end
    return false   -- needs the AI-side authority stake verb (no engine ask blocks it)
end

--- Narrate via chat (plan §5.1 — spend is socially visible). Best-effort.
-- Falls back to the server-log channel (AI.log) when no in-game chat wire
-- exists yet — on a headless full-side run the log is the only place the AI's
-- spend/decisions/errors surface, so narration must not silently vanish.
function Actuators:chat(msg)
    local AI = _G.AI
    if type(AI) == 'table' then
        if type(AI.chat) == 'function' then return AI.chat(msg) end
        if type(AI.sendChat) == 'function' then return AI.sendChat(msg) end
        if type(AI.log) == 'function' then return AI.log(msg) end
    end
    -- No chat/log verb: swallow (never error — narration is non-essential).
    return false
end

--- Drop a map marker (plan §4 communication).
function Actuators:marker(pos, txt)
    local AI = _G.AI
    if type(AI) == 'table' then
        if type(AI.marker) == 'function' then return AI.marker(pos, txt) end
        if type(AI.setMarker) == 'function' then return AI.setMarker(pos, txt) end
    end
    return false
end

--- Respond to / originate a parley proposal (interaction §6.2). NOT gated on an
--- engine ask any more: I1 landed (`AI.sendMessage`, see :112), so parley could
--- be spoken over the same wire commands a human's panel sends — these two verbs
--- are simply unimplemented on the runtime surface, and building them on the
--- message funnel is PLAN-metalstorm-ai task 4(a) work, not this lane's.
function Actuators:respondProposal(id, decision) -- decision: accept|reject|counterTerms
    if self.caps.respond then return _G.AI.respondProposal(id, decision) end
    return false
end
function Actuators:propose(kind, toTeam, terms)
    if self.caps.propose then return _G.AI.propose(kind, toTeam, terms) end
    return false
end

--=============================================================================
-- Directive geometry — region graph → the engine shape the directive anchors
-- on. The AI's map IS the region graph (plan §2); a directive targets a region,
-- and we resolve that region's polygon (loaded by picture.lua from regions.json,
-- the SAME file the client mirror reads) to a Circle centred on its centroid.
-- No terrain analysis, no pathfinding — the centroid is the strategic anchor
-- the engine decomposition (IssueDirectiveCommand) advances squads toward.
--=============================================================================

--- Centroid + bounding radius of a region polygon ({ {x=,z=}, ... }).
-- Returns cx, cz, radius, or nil if there is no usable polygon.
local function regionAnchor(region)
    local poly = region and region.polygon
    if type(poly) ~= 'table' or #poly == 0 then return nil end
    local sx, sz, n = 0, 0, 0
    for _, p in ipairs(poly) do
        if p.x and p.z then sx = sx + p.x; sz = sz + p.z; n = n + 1 end
    end
    if n == 0 then return nil end
    local cx, cz = sx / n, sz / n
    local r = 0
    for _, p in ipairs(poly) do
        if p.x and p.z then
            local dx, dz = p.x - cx, p.z - cz
            local d = math.sqrt(dx * dx + dz * dz)
            if d > r then r = d end
        end
    end
    return cx, cz, r
end

--- Build the engine directive spec for one planner directive `d` against the
-- Picture (for region geometry). Returns the spec table, or nil if the target
-- region has no resolvable geometry (a blind AI can't place it — skip, honest,
-- rather than issuing a directive at (0,0)).
--- How long a directive this tick issues should live.
---
--- The plan is RE-STATED IN FULL every strategic tick (main.lua is stateless by
--- design, plan §7), so a directive's job is to carry this tick's intent until
--- the next tick replaces it — and then to die. Two ticks' worth: it survives
--- its own tick plus one late or skipped one (a contended machine really does
--- delay a tick), and no longer. The period is the LOD-adjusted one main.lua is
--- about to sleep for, not the LOD-0 base, or a dormant NPC's orders would
--- expire twenty seconds into a sixty-second nap and leave its army standing.
function Actuators:_directiveTtlFrames()
    local ttl = self.ttlFrames
    if type(ttl) ~= 'number' or ttl <= 0 then return DEFAULT_DIRECTIVE_TTL_FRAMES end
    return math.max(1, math.floor(ttl * 2))
end

function Actuators:_directiveSpec(d, picture, priority)
    local dtype = DIRECTIVE_FOR_NAME[d.directive]
    if not dtype then return nil end            -- unmapped name → skip loudly-ish

    local regions = (picture and picture.regions) or {}
    local cx, cz, radius = regionAnchor(regions[d.region])
    if not cx then return nil end               -- no geometry for this region

    return {
        type    = dtype,
        priority = priority,
        shape   = OrderShape.Circle,
        params  = { cx, 0, cz, radius },        -- [x,y,z,radius] (Circle)
        -- Demand cap: pull roughly the assigned package's worth of squads, no
        -- more (the evaluator stops once assignedStrength ≥ requestedStrength).
        -- 0 = "take what idles" (uncapped).
        --
        -- ⚠ THE CAP IS IN THE ENGINE'S SCALE, WHICH IS ABSOLUTE HITPOINTS
        -- (endtoend D68). `DirectiveManager::Evaluate` accrues
        -- `assignedStrength += u->health` from `CUnit::health` — real hitpoints —
        -- while the planner's `strength` sums the runtime's 0-1 health RATIOS,
        -- i.e. a head count (see picture.lua's force-read header). Capping on
        -- `strength` therefore asked for "3 hitpoints" for a 3-unit package, and
        -- the first unit assigned (~1 200 hp) slammed the cap shut: every
        -- directive recruited EXACTLY ONE unit however much force it announced,
        -- which is how the AI narrated "Taking Raven Basin — 3 force" with
        -- nothing in the basin and idle units left standing.
        -- `healthStrength` is that same package priced in hitpoints.
        --
        -- A package we cannot price at all (no def export) sends 0 —
        -- deliberately uncapped rather than fabricating a cap: a wrong cap
        -- under-commits silently, while an uncapped directive is still bounded
        -- by the priority ladder and the §8 E6 rate clamp.
        requestedStrength = math.max(0, math.floor(d.healthStrength or 0)),
        -- Every directive is MORTAL (D68). See _directiveTtlFrames.
        expiresInFrames = self:_directiveTtlFrames(),
        -- No within-filter by default: draw idle unassigned squads from
        -- anywhere and advance them to the region. (Region-local tightening —
        -- within = {x=cx,z=cz,radius=radius} for pure hold directives — is a
        -- later refinement once org-group rosters reach the AI, AI2 squad views.)
    }
end

--- Issue one directive AND tag it with the planner goal it serves.
---
--- PLAN-ai-synced-write.md §2.5: the goal id is what the veto loop keys on
--- (`planner.lua`'s `guidance.veto[goal.id]`), and the synced side's only view
--- of a directive is the authority charge, which knows nothing about goals. So
--- the AI states the correlation itself: an `ai.intent` message pushed
--- IMMEDIATELY BEFORE the directive it describes. Both are AICommands on one
--- queue, they drain in push order in the same TickAI batch on the sim thread,
--- and `GG.AIGuidance.RecordIntent` consumes the tag when the charge for that
--- directive fires in the same frame.
---
--- Two ordering properties this function exists to hold, both easy to lose by
--- inlining it back into the call sites:
---   1. The tag is sent ONLY when the directive really goes out. A skipped
---      directive (unmapped name, region with no geometry, verb unavailable)
---      that still tagged would leave a pending goal id for the NEXT directive
---      to steal — the gadget's frame-end sweep bounds the damage, it does not
---      prevent it.
---   2. The tag is sent BEFORE, never after. Push order is the entire
---      correlation mechanism; a tag arriving after its directive annotates
---      nothing (the charge already ran) and mis-annotates the next one.
--- An untagged directive is legitimate and lossless — the intent line simply
--- carries no goal id and the panel renders no Veto button for it.
function Actuators:_issueTagged(d, spec)
    if not self.caps.issueDirective then return false end
    if d.goalId ~= nil then
        self:sendMessage(Wire.encode('ai.intent', {
            goalId = d.goalId,
            dt     = spec.type,
            region = d.region,
        }))
    end
    return self:issueDirective(0, spec)          -- 0 = area scope
end

--=============================================================================
-- apply — consume the planner's plan.  One entry point main.lua calls.
--=============================================================================
--- `opts.tickFrames` is the period main.lua will sleep for after this tick
--- (LOD-adjusted). It sets how long the directives issued here live — see
--- _directiveTtlFrames. Absent, the actuator falls back to a fixed lifetime
--- rather than issuing an immortal directive.
function Actuators:apply(plan, picture, opts)
    self.ttlFrames = opts and opts.tickFrames or nil
    -- Mentor/suggest-only mode (PLAN-metalstorm-onboarding.md §3): the planner
    -- runs normally but output routes to SUGGESTIONS via chat + suggested_for
    -- hints, rather than spending authority on real orders. The profile carries
    -- the flag; the actuator enforces it here (structural gate).
    local suggestOnly = self.profile and self.profile.suggest_only

    for i, d in ipairs(plan.directives or {}) do
        if suggestOnly then
            -- Suggest mode: narrate what WOULD be done, never issue the real order.
            self:_suggestDirective(d, picture)
        else
            -- Normal mode: execute the directive through the real engine verbs.
            -- Priority descends with emit order (the planner emits highest-score
            -- first), so the evaluator's priority ladder honours the planner's
            -- ranking; the engine's own §8 E6 clamp is the structural backstop.
            local priority = math.max(1, 250 - (i - 1) * 10)
            if d.type == 'posture' then
                self:_applyPosture(d, picture)
            elseif d.type == 'directive' then
                local spec = self:_directiveSpec(d, picture, priority)
                if spec then self:_issueTagged(d, spec) end
            elseif d.type == 'build' then
                self:initiateBuild(d.factoryId, d.defName)
            end
            -- Announce intent per directive (plan §5.1): "Taking N Basin ...".
            self:_announce(d, picture)
        end
    end

    -- Intent report (interaction §6.3): publish the assignment table so the
    -- co-commander is legible + vetoable. The published transport is the synced
    -- charge path (see _publishIntent); the local copy is what the AI itself
    -- reasons over, plus the one-line narration.
    self.lastIntent = plan.intent
    self:_publishIntent(plan.intent)
end

--- A DEFEND posture goal maps to a hold-in-place directive on the target
-- region (the always-affordable emergency floor, plan §8 E2). Same area-scoped
-- path as a directive; posture-as-ROE on a real org group waits on AI2 squad
-- rosters, so the DEFEND floor is expressed as a Defend directive today.
function Actuators:_applyPosture(d, picture)
    local priority = 255                        -- defence outranks everything
    local spec = self:_directiveSpec(
        { directive = d.directive or 'DEFEND', region = d.region,
          strength = d.strength, healthStrength = d.healthStrength },
        picture, priority)
    -- Tagged like any other directive: a DEFEND posture is charged through the
    -- same path, so its intent line is vetoable too (its spend is 0, which is
    -- exactly the case a human most wants to be able to override).
    if spec then self:_issueTagged(d, spec) end
end

--=============================================================================
-- Suggest-only output (mentor mode, onboarding §3).
--=============================================================================
function Actuators:_suggestDirective(d, picture)
    -- Mentor/suggest-only mode emits ADVICE instead of orders: narrate what the
    -- AI would do if it were commanding the force, with the reasoning visible.
    -- The actual vehicles for suggestions are:
    --   1. Chat (private, player-channel) — "North Basin is contested and
    --      undefended — a control objective worth 120 authority."
    --   2. suggested_for hint (onboarding §3, integration plan) — lights up the
    --      objective card in the UI so the player can see WHERE.
    --   3. Map marker (visual ping) — reinforces the location.
    -- The profile may carry a suggest_period_sec rate limiter; tracked in self
    -- (self.lastSuggestFrame). Until the wire/gadget verbs exist, chat only.

    local period = (self.profile.suggest_period_sec or 45) * 30  -- sec → frames
    local now = picture.frame or 0
    if self.lastSuggestFrame and (now - self.lastSuggestFrame) < period then
        return  -- Rate-limited: don't flood a learner.
    end
    self.lastSuggestFrame = now

    local where = d.region and tostring(d.region) or "unknown region"
    local cost = d.predictedCost and tostring(math.floor(d.predictedCost)) or "?"
    local suggestion = string.format(
        "[mentor] Suggest: %s at %s (authority cost ~%s). This would advance our position.",
        tostring(d.directive), where, cost)
    self:chat(suggestion)

    -- TODO(onboarding §3): when the suggested_for hint verb
    -- exists (game_ai_guidance.lua writing a suggestion rulesParam that the
    -- native-UI objective card reads), emit it here:
    --   AI.setSuggestedObjective(goalId, groupId)  -- lights the card
    -- And when the map marker verb exists:
    --   local pos = picture.regions[d.region] and picture.regions[d.region].pos
    --   if pos then self:marker(pos, "Mentor: " .. d.directive) end
end

--=============================================================================
-- Narration + intent publishing (best-effort, non-essential).
--=============================================================================
-- Verb-ish phrasing per directive so the announcement reads like intent, not a
-- log dump ("Taking N Basin with 3rd Armoured, ~4 min", plan §5.1). Keyed by
-- the planner's directive SHAPE name.
local INTENT_VERB = {
    DEFEND = 'Holding', DEFEND_FRONT = 'Holding the front at', SCREEN = 'Scouting',
    TAKE_AND_HOLD = 'Taking', ASSAULT = 'Assaulting', SECURE = 'Securing',
    ESCORT = 'Escorting to', BUILD = 'Building at', RALLY = 'Staging at',
    WITHDRAW = 'Falling back from', OVERWATCH = 'Watching',
}

--- Announce intent on EVERY directive (plan §5.1 — the AI's spend is socially
-- visible). Names the region (from the region graph), the committed force, the
-- authority spend, and a coarse ETA from the assigned strength (a heuristic, not
-- a path estimate — honest flavour, marked "~"). Best-effort chat/log.
function Actuators:_announce(d, picture)
    if d.type ~= 'directive' and d.type ~= 'posture' then return end
    local regions = (picture and picture.regions) or {}
    local region = d.region and regions[d.region]
    local where = (region and region.name) or (d.region and tostring(d.region)) or "the field"
    local verb = INTENT_VERB[d.directive] or tostring(d.directive)
    -- Coarse ETA: bigger commitments muster/travel slower. A flavour heuristic
    -- (~2 min floor, +1 min per 6 strength), never presented as precise.
    local etaMin = 2 + math.floor((d.strength or 0) / 6)
    local cost = d.predictedCost and math.floor(d.predictedCost) or 0
    self:chat(string.format("[strategos] %s %s — %d force, ~%d min (~%d auth)",
        verb, where, math.max(1, math.floor(d.strength or 0)), etaMin, cost))
end

function Actuators:_publishIntent(intent)
    -- The intent report the panel reads (guidance_<team>_intent_*) is now
    -- published SYNCED-SIDE from the authority charge path: when the AI's
    -- directive is charged, game_authority_charge.lua calls
    -- GG.AIGuidance.RecordIntent, so ai-command-panel.js renders exactly the
    -- directives the AI actually paid for (spend socially visible, §5.1/§6.3).
    -- Driving the report from the charge is what keeps it AUTHORITATIVE: a line
    -- exists only for a directive that really was created and paid for, so an
    -- authority-vetoed directive leaves no phantom line. That is still true now
    -- that engine ask I1 has landed — the AI can write into synced Lua
    -- (`AI.sendMessage`, see `_issueTagged`), but it uses that only to ANNOTATE
    -- the charge-driven line with the goal id the veto loop keys on, never to
    -- publish a line of its own. This local hook keeps lastIntent for the tick
    -- summary only.
end

function Actuators:noteError(frame, err)
    self:chat(string.format("[strategos] tick %d error: %s", frame or -1, tostring(err)))
end

return Actuators
