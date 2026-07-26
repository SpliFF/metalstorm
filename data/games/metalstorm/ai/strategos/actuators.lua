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
        respond        = has('respondProposal'),  -- interaction I1
        propose        = has('propose'),          -- interaction I1
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
    return false   -- needs the AI-side authority stake path (I1-adjacent)
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

--- Respond to / originate a parley proposal (interaction §6.2, engine ask I1).
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
        -- Demand cap: pull roughly the assigned package's worth of idle squads,
        -- no more (the evaluator stops once assignedStrength ≥ requestedStrength).
        -- 0 = "take what idles" (uncapped) — we always cap so one directive
        -- can't drain the whole idle pool.
        requestedStrength = math.max(1, math.floor(d.strength or 0)),
        -- No within-filter by default: draw idle unassigned squads from
        -- anywhere and advance them to the region. (Region-local tightening —
        -- within = {x=cx,z=cz,radius=radius} for pure hold directives — is a
        -- later refinement once org-group rosters reach the AI, AI2 squad views.)
    }
end

--=============================================================================
-- apply — consume the planner's plan.  One entry point main.lua calls.
--=============================================================================
function Actuators:apply(plan, picture)
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
                if spec then self:issueDirective(0, spec) end   -- 0 = area scope
            elseif d.type == 'build' then
                self:initiateBuild(d.factoryId, d.defName)
            end
            -- Announce intent per directive (plan §5.1): "Taking N Basin ...".
            self:_announce(d)
        end
    end

    -- Intent report (interaction §6.3): publish the assignment table so the
    -- co-commander is legible + vetoable. Transport is the guidance blob (I1);
    -- until then we keep it locally and narrate a one-line summary.
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
        { directive = d.directive or 'DEFEND', region = d.region, strength = d.strength },
        picture, priority)
    if spec then self:issueDirective(0, spec) end
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

    -- TODO(onboarding §3 / integration I1): when the suggested_for hint verb
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
function Actuators:_announce(d)
    if d.type ~= 'directive' then return end
    local where = d.region and (" " .. tostring(d.region)) or ""
    self:chat(string.format("[strategos] %s%s with %s (~%s auth)",
        tostring(d.directive), where, tostring(d.groupId), tostring(d.predictedCost)))
end

function Actuators:_publishIntent(intent)
    -- TODO(I1): write a compact intent blob into game_ai_guidance.lua via an
    -- AI-side SendLuaRulesMsg-equivalent so ai-command-panel.js renders "what
    -- my AI is doing" + veto buttons (interaction §6.3). For now: no-op sink.
end

function Actuators:noteError(frame, err)
    self:chat(string.format("[strategos] tick %d error: %s", frame or -1, tostring(err)))
end

return Actuators
