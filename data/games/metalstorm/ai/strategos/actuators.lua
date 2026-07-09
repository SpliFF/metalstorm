-- actuators.lua — the ENTIRE write surface (PLAN-metalstorm-ai.md §4).
--
-- THE DESIGN LAW (plan §1/§4): the AI's command floor is the macro directive.
-- It may issue army/platoon directives, postures, build initiations, group
-- creates, and bounty stakes — it may NEVER issue a per-squad CMD_*. This is
-- enforced STRUCTURALLY: this module simply has no moveSquad/attackTarget
-- function. The planner cannot micro because there is no verb for it.
--
-- Two backends, feature-detected:
--   * AI2 verbs (AI.createGroup / AI.issueDirective / AI.setPosture / …):
--     the real path once PLAN-macro-orders §5 lands. Preferred when present.
--   * Standing-order FALLBACK (pre-AI2): maps each directive onto the landed
--     StandingOrderManager machinery (DefendArea / Fallback / rally) so the
--     planner boots against real games today. The fallback issues AREA /
--     STANDING behaviour orders only — never target-picking micro — and is
--     deleted the moment AI2 verbs exist (plan §10 task 5).

local Actuators = {}
Actuators.__index = Actuators

-- Standard Spring command ids used by the standing-order fallback. These are
-- AREA / STANDING orders (behaviour), deliberately NOT single-target micro.
local CMD = {
    STOP      = 0,
    MOVE      = 10,     -- used only for rally staging (RESERVE), area target
    PATROL    = 15,
    FIGHT     = 16,     -- area fight = "advance and engage", not target-pick
    GUARD     = 25,
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
    return self
end

function Actuators._detect()
    local AI = _G.AI
    local has = function(fn) return type(AI) == 'table' and type(AI[fn]) == 'function' end
    return {
        issueCommand   = has('issueCommand'),    -- today's surface
        createGroup    = has('createGroup'),      -- AI2
        issueDirective = has('issueDirective'),   -- AI2
        setPosture     = has('setPosture'),       -- AI2
        initiateBuild  = has('initiateBuild'),    -- AI2
        chat           = has('chat') or has('sendChat'),
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
function Actuators:createGroup(squadIds, echelon)
    if self.caps.createGroup then
        return _G.AI.createGroup(squadIds, echelon)
    end
    -- Fallback: no engine group object — synthesise a local handle so the
    -- planner's group ids stay stable. Real grouping waits on AI2.
    return { synthetic = true, squads = squadIds, echelon = echelon }
end

--- Issue an army/platoon macro directive to a group (ONLY macro directives).
function Actuators:issueDirective(groupId, directive, region)
    if self.caps.issueDirective then
        return _G.AI.issueDirective(groupId, directive, region)
    end
    return self:_standingOrderFallback(groupId, directive, region)
end

--- Set an engagement/casualty/ROE posture on a group (nearly free, §authority).
function Actuators:setPosture(groupId, posture)
    if self.caps.setPosture then
        return _G.AI.setPosture(groupId, posture)
    end
    -- Fallback: a posture maps to a standing behaviour flag; stubbed until the
    -- StandingOrderManager posture verbs are reachable from the AI VM.
    return false
end

--- Initiate a build at a factory (charged; strategic commitment §8).
function Actuators:initiateBuild(factoryId, defName)
    if self.caps.initiateBuild then
        return _G.AI.initiateBuild(factoryId, defName)
    end
    return false   -- no build verb yet (AI2)
end

--- Stake a bounty on an objective (full-side delegation tool §4/§5).
function Actuators:stakeBounty(objectiveDef, amount)
    if self.caps.stakeBounty then
        return _G.AI.stakeBounty(objectiveDef, amount)
    end
    return false   -- needs the AI-side authority stake path (I1-adjacent)
end

--- Narrate via chat (plan §5.1 — spend is socially visible). Best-effort.
function Actuators:chat(msg)
    local AI = _G.AI
    if type(AI) == 'table' then
        if type(AI.chat) == 'function' then return AI.chat(msg) end
        if type(AI.sendChat) == 'function' then return AI.sendChat(msg) end
    end
    -- No chat verb: swallow (never error — narration is non-essential).
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
-- apply — consume the planner's plan.  One entry point main.lua calls.
--=============================================================================
function Actuators:apply(plan, picture)
    for _, d in ipairs(plan.directives or {}) do
        if d.type == 'posture' then
            self:setPosture(d.groupId, d.directive)
        elseif d.type == 'directive' then
            self:issueDirective(d.groupId, d.directive, d.region)
        elseif d.type == 'build' then
            self:initiateBuild(d.factoryId, d.defName)
        end
        -- Announce intent per directive (plan §5.1): "Taking N Basin ...".
        self:_announce(d)
    end

    -- Intent report (interaction §6.3): publish the assignment table so the
    -- co-commander is legible + vetoable. Transport is the guidance blob (I1);
    -- until then we keep it locally and narrate a one-line summary.
    self.lastIntent = plan.intent
    self:_publishIntent(plan.intent)
end

--=============================================================================
-- Standing-order fallback (pre-AI2).  The ONLY place raw issueCommand is used,
-- and it issues AREA / STANDING orders, never per-target micro. Deleted when
-- AI2 lands. Heavily stubbed: needs package→unit membership + region geometry
-- (AI1) to place the area orders, which aren't reachable from the VM yet.
--=============================================================================
function Actuators:_standingOrderFallback(groupId, directive, region)
    if not self.caps.issueCommand then return false end
    -- TODO(AI1): resolve `groupId` → member unit ids and `region` → a centroid
    -- {x,z}. Then translate the directive to a STANDING order over the set:
    --   DEFEND / DEFEND_FRONT  → area FIGHT/GUARD anchored on the region centroid
    --   TAKE_AND_HOLD / ASSAULT→ area FIGHT toward the region centroid
    --   SCREEN / recon         → PATROL along the frontier edge
    --   WITHDRAW / RALLY       → area MOVE to the reserve rally point
    -- All AREA orders (behaviour), never single-target attack — the strategic
    -- floor holds even in the fallback. Example shape (disabled until geometry):
    --
    --   local cmd = self:_directiveToStandingCmd(directive)
    --   for _, unitId in ipairs(self:_membersOf(groupId)) do
    --       _G.AI.issueCommand(unitId, cmd, centroid.x, 0, centroid.z)
    --   end
    return { fallback = true, directive = directive, region = region }
end

-- Directive → standing AREA command id (behaviour, not micro).
function Actuators:_directiveToStandingCmd(directive)
    if directive == 'SCREEN'  then return CMD.PATROL end
    if directive == 'RALLY'   then return CMD.MOVE   end
    if directive == 'WITHDRAW'then return CMD.MOVE   end
    if directive == 'DEFEND' or directive == 'DEFEND_FRONT' then return CMD.GUARD end
    return CMD.FIGHT   -- assault / take-and-hold advance as an area order
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
