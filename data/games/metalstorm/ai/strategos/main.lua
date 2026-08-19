-- main.lua — Metalstorm Strategos runtime entry.
--
-- PLAN-metalstorm-ai.md §3/§6/§10; PLAN-ai.md (the server AI runtime).
--
-- ROLE OF THIS FILE: the orchestrator. It owns nothing clever — it holds
-- the AI's cross-tick memory, schedules the strategic tick, and wires the
-- pipeline:
--
--     picture.refresh()  →  slate.build()  →  planner.plan()  →  actuators.apply()
--       (read mirrors)      (goals, pure)     (allocate, pure)    (the only writer)
--
-- Everything that decides anything lives in the pure modules (slate,
-- planner); everything that reads the world lives in picture; everything
-- that writes lives in actuators. main.lua just turns the crank.
--
-- STATELESSNESS (plan §7): the AI holds NO authoritative state. Kill the
-- VM mid-game and it rebuilds its Picture from rulesParams mirrors next
-- tick. The only VM-held state is decay memory (intel) + soft commitments,
-- both of which rebuild honestly from fresh input — acceptable amnesia.
--
-- RUNTIME SURFACE: the VM exposes a global `AI` table (AIScriptContext.cpp):
--   reads:  AI.getOwnUnits() · AI.getVisibleEnemies() · AI.getFrame() ·
--           AI.getMapSize() · AI.getTeamId() · AI.getRulesParam (AI1) ·
--           AI.getMapData / AI.getDefExport (AI4)
--   writes: AI.createGroup · AI.issueDirective · AI.setPosture (AI2 — the
--           directive-shaped write surface; routed through the SAME engine
--           managers + charge callins as a human player's commands) ·
--           AI.sendMessage (I1/SG1 — an opaque string delivered to
--           gadget:RecvLuaMsg with this AI's playerID, the one write into
--           synced game Lua; the actuator uses it for the `ai.intent` tag).
--   infra:  AI.log(msg) (server-log channel — a headless AI has no chat/HUD,
--           §5.1) · AI.nowMs() (monotonic clock for self-timing the §6 tick).
-- Still assumed-but-absent (each module feature-detects + degrades): squad
-- views, LOD, chat/stake/parley verbs — none of them blocked on an engine ask now
-- that I1 has landed, just not on the surface. See README "Engine asks".

--=============================================================================
-- Module loading.  See README "Engine ask AI0-loader".
-- The AI VM opens only base/table/string/math/utf8 and loads a single entry
-- buffer — there is no `require`/`VFS.Include` yet. We use `require` (the
-- idiomatic, busted-testable shape) and fail LOUD if the runtime hasn't
-- registered a plugin-scoped loader, so the boot log names the gap.
--=============================================================================
local function need(name)
    if type(require) ~= 'function' then
        error("[strategos] no module loader in AI VM — cannot require '" .. name
            .. "'. Runtime must register a plugin-scoped require (engine ask "
            .. "AI0-loader). Pure modules still test headless with busted.", 0)
    end
    return require(name)
end

local Config    = need('config')
local Picture   = need('picture')
local Slate     = need('slate')
local Planner   = need('planner')
local Actuators = need('actuators')
local Roles     = need('roles')
local Lod       = need('lod')

--=============================================================================
-- Instance state (persists across onUpdate calls — the VM is long-lived).
--=============================================================================
local self = {
    booted        = false,
    role          = nil,   -- resolved Roles entry (full_side | co_commander | npc)
    baseRole      = nil,   -- the profile's baseline role (before caretaker derivation)
    roleCache     = {},    -- id → resolved Roles entry (caretaker up/downgrade, §5.1)
    profile       = nil,   -- personality weights table (profiles/*.lua)
    playerId      = -1,    -- AI3 virtual playerID (own authority pool identity)
    rng           = nil,   -- seedable RNG (plan §6) — reproducible decisions
    actuators     = nil,   -- Actuators instance (the write surface)
    lastTickFrame = -1,    -- frame of the last strategic tick

    -- LOD (lod.lua): `lodState` holds the de-escalation dwell tracker, `lodTier`
    -- the tier the NEXT wake-up period is derived from. Re-derived every tick
    -- from the Picture; a fresh VM starts at the role's alert floor.
    lodState      = nil,
    lodTier       = 0,

    -- Decay memory (plan §2 "enemy estimate"): per-region strength +
    -- lastSeenFrame, decayed toward "unknown". Rebuilds from sightings.
    memory        = { intel = {} },

    -- Commitments (plan §3.3): goalId → { groupId, sinceFrame, score }.
    -- Hysteresis lives here; decays over ~2 min. Soft state, not truth.
    commitments   = {},
}

--=============================================================================
-- Role / profile resolution.
-- Difficulty = profile + LOD tier + optional handicap (plan §3.4/§6). The
-- current runtime passes no per-slot config into the VM, so we resolve from
-- (1) a rulesParam hint if AI1 has landed, else (2) the default profile.
-- Engine integration note in README ("profile passing").
--=============================================================================
--- Resolve our own team id. The current runtime knows the team
-- (AIScriptContext.teamId) but does not expose it to the VM yet; the plan
-- assumes AIStateView.getTeamId() (engine ask, PLAN-ai.md). Feature-detect;
-- fall back to 0 so scoring's "friendly vs enemy region" degrades safely
-- (everything reads neutral) rather than crashing.
local function resolveTeamId()
    local AI = _G.AI
    if type(AI) == 'table' and type(AI.getTeamId) == 'function' then
        return AI.getTeamId()
    end
    return 0
end

--- Our virtual playerID (AI3): the authority charge identity. -1 when the VM
-- was created without a virtual player (tests / pre-AI3 runtime).
local function resolvePlayerId()
    local AI = _G.AI
    if type(AI) == 'table' and type(AI.getPlayerId) == 'function' then
        return AI.getPlayerId()
    end
    return -1
end

--- Present-human count on our own team (game_teams.lua's co-commander
-- coordinator publishes team_active_humans, {allied=true}). nil = coordinator
-- absent / unknown → keep the profile's baseline role (don't guess).
local function teamHumans()
    local AI = _G.AI
    if type(AI) ~= 'table' or type(AI.getRulesParam) ~= 'function' then return nil end
    return tonumber(AI.getRulesParam('team', 'team_active_humans'))
end

--- Effective role for THIS tick (PLAN-metalstorm-ai.md §5/§5.1). An AI sharing
-- a team with humans is a co-commander by construction — delegation-first,
-- idle-only, own-pool-only, guidance-binding; when the last human leaves it
-- silently upgrades to the full-side slate (caretaker), and back the moment one
-- rejoins. NPCs never flip. This is DERIVED from live human presence rather than
-- hardcoded, which keeps the synced own-pool-only flag (game_teams drives
-- SetOwnPoolOnly off the same count) and the AI's goal slate consistent by
-- construction. When the coordinator hasn't published a count (headless
-- full-side runs, AI-only games), we keep the profile's baseline role.
local function effectiveRole(state)
    local base = state.baseRole
    if base.id == 'npc' then return base end       -- NPC never flips (§5)
    local humans = teamHumans()
    if humans == nil then return base end           -- unknown → baseline
    local wantId = (humans > 0) and 'co_commander' or 'full_side'
    if base.id == wantId then return base end
    local cached = state.roleCache[wantId]
    if not cached then
        cached = Roles.resolve(wantId, Config)
        cached.teamId = base.teamId
        cached.scriptedSlate = base.scriptedSlate
        state.roleCache[wantId] = cached
    end
    return cached
end

--- Which personality is this slot? The scenario (game_scenario.lua's `ai`
-- section) or a future lobby modoption publishes `ai_profile_<playerID>` /
-- `ai_profile` on the team; Picture.readProfileHint reads it over AI1. The
-- profile carries its own role binding, so choosing a profile chooses the
-- deployment role too (§5 "one brain, three configs").
--
-- The hint is untrusted text going into a require(), so it is checked against
-- Config.PROFILES; an unknown or missing name falls back to the default and
-- says so, rather than erroring out a whole faction over a scenario typo.
local function resolveProfile()
    local hint = Picture.readProfileHint(resolvePlayerId())
    local name = Config.DEFAULT_PROFILE
    local rejected = nil
    if hint then
        if Config.PROFILES[hint] then name = hint else rejected = hint end
    end
    local ok, profile = pcall(need, 'profiles.' .. name)
    if not ok or type(profile) ~= 'table' then
        profile = need('profiles.default')
    end
    return profile, rejected
end

--=============================================================================
-- Boot (first onUpdate — the runtime has no onInit callin yet, only onUpdate).
--=============================================================================
local function boot(frame)
    local profile, rejectedProfile = resolveProfile()
    self.profile      = profile
    self.baseRole     = Roles.resolve(self.profile.role, Config)
    self.baseRole.teamId = resolveTeamId()
    self.playerId     = resolvePlayerId()
    -- A profile may attach a scripted slate (NPC scenarios) — install it onto
    -- the role, which is where slate.build looks for it.
    if self.profile.scriptedSlate then
        self.baseRole.scriptedSlate = self.profile.scriptedSlate
    end
    self.roleCache = { [self.baseRole.id] = self.baseRole }
    self.role         = self.baseRole              -- effective role, re-derived each tick
    self.lodState     = Lod.newState(self.baseRole)
    self.lodTier      = self.lodState.tier
    self.rng          = Config.makeRNG(Config.SEED)   -- seed is fixed for repro
    self.actuators = Actuators.new({
        role    = self.role,
        profile = self.profile,
        -- own-pool-only charging etc. are role policy (plan §5)
    })
    self.booted = true
    -- Narrate boot so the game log shows which brain woke up (plan §5.1:
    -- the AI's spend is socially visible; boot is the first line).
    self.actuators:chat(string.format(
        "[strategos] online — role=%s profile=%s player=%d lod=%d..%d",
        self.role.id, self.profile.id, self.playerId,
        self.baseRole.lodFloor or 0, self.baseRole.lodCeil or 0))
    if rejectedProfile then
        -- Loud, not silent: a scenario naming a profile this plugin doesn't
        -- ship is an authoring bug, and a quietly-default AI hides it.
        self.actuators:chat(string.format(
            "[strategos] WARNING: unknown profile '%s' requested — using '%s'",
            tostring(rejectedProfile), self.profile.id))
    end
end

--=============================================================================
-- The strategic tick (plan §3): the whole brain, at 0.2 Hz.
-- LOD (plan §3 / PLAN-ai.md) stretches the period for dormant NPC factions.
--=============================================================================
local function strategicTick(frame)
    -- §6 compute-budget clock (≤ 2 ms). We bracket ONLY the pure pipeline
    -- (read mirrors → goals → allocate) — the "table arithmetic over regions"
    -- §6 budgets — with the AI's monotonic clock. The actuator's WRITE step and
    -- all narration (which on a headless run route to synchronous SLOG) are
    -- deliberately outside this window; they're I/O, not the §6 compute cost.
    local AI = _G.AI
    local clock = (type(AI) == 'table' and type(AI.nowMs) == 'function') and AI.nowMs or nil
    local t0 = clock and clock() or nil

    -- 0. ROLE — derive the effective role from live human presence (§5.1
    --    caretaker up/downgrade). Cheap (one rulesParam read); done before the
    --    Picture so guidance/economy read under the right policy. Narrate a flip
    --    so a handoff is legible in the log (plan §5.1).
    local role = effectiveRole(self)
    if role ~= self.role then
        self.actuators:chat(string.format(
            "[strategos] role -> %s (team humans=%s)", role.id,
            tostring(teamHumans())))
        self.role = role
        self.actuators.role = role
    end

    -- 1. READ — refresh the Picture from mirrors + decay memory (picture.lua).
    local picture = Picture.refresh({
        frame  = frame,
        memory = self.memory,
        role   = role,
        config = Config,
    })

    -- 2. GOALS — explicit (objective board) + implicit (standing needs). Pure.
    local slate = Slate.build(picture, self.profile, role)

    -- 3. ALLOCATE — score, assign under force floors, apply commitment
    --    hysteresis + the budget governor. Pure; returns a directive list.
    local plan = Planner.plan({
        picture     = picture,
        slate       = slate,
        profile     = self.profile,
        role        = role,
        commitments = self.commitments,   -- read + updated in place
        rng         = self.rng,
        config      = Config,
    })

    -- 3b. LOD — pick the tier the NEXT wake-up period derives from (lod.lua).
    --     Inside the measured window: it is a BFS over the region graph, i.e.
    --     exactly the "table arithmetic over regions" §6 budgets. Narrate tier
    --     changes so a faction going dormant (or waking) is legible in the log.
    local prevTier = self.lodTier
    self.lodTier = Lod.evaluate(self.lodState, picture, role, Config)

    -- Compute cost measured here, before the WRITE/narration I/O below.
    local computeMs = (t0 and clock) and (clock() - t0) or nil

    if self.lodTier ~= prevTier then
        self.actuators:chat(string.format(
            "[strategos] lod %d -> %d (next tick in %d frames)",
            prevTier, self.lodTier, Lod.periodFor(self.lodTier, role, Config)))
    end

    -- 4. WRITE — the actuator is the ONLY module that emits commands. It maps
    --    directives onto the real AI2 verbs (the standing-order fallback is
    --    gone) and announces intent (plan §5.1) + publishes the intent report
    --    (PLAN-metalstorm-interaction.md §6.3).
    -- The tick period is handed over so the directives issued here EXPIRE with
    -- this tick's plan instead of outliving it (D68): main.lua re-states the
    -- whole plan every tick, so an immortal directive is a duplicate that never
    -- stops commanding. `self.lodTier` is already the NEXT tier at this point,
    -- so this is the period the AI is about to sleep for.
    self.actuators:apply(plan, picture,
        { tickFrames = Lod.periodFor(self.lodTier, role, Config) })

    -- Tick summary — one legible line per strategic tick so a headless full-side
    -- run is observable (plan §5.1: the AI's reasoning must be inspectable). Not
    -- a decision input; pure narration. Counts what the pipeline produced this
    -- tick + the governor's economy so region/objective progress is traceable.
    local nGoals, nDir, nBoard, ownStrength = 0, 0, 0, 0
    local rOwned, rNeutral, rEnemy = 0, 0, 0
    for _ in pairs(slate) do nGoals = nGoals + 1 end
    nDir = #(plan.directives or {})
    for _, r in pairs(picture.regions or {}) do
        if r.owner == role.teamId then rOwned = rOwned + 1
        elseif r.owner == nil or r.owner == -1 then rNeutral = rNeutral + 1
        else rEnemy = rEnemy + 1 end
    end
    local objActive, objDone = 0, 0
    for _, o in pairs(picture.board or {}) do
        nBoard = nBoard + 1
        if o.state == 'active' then objActive = objActive + 1
        elseif o.state == 'complete' then objDone = objDone + 1 end
    end
    for _, b in pairs(picture.ledger or {}) do ownStrength = ownStrength + (b.strength or 0) end
    -- §6 budget verdict: compute (pipeline) ms vs the 2 ms LOD-0 target. Flag
    -- with a marker so an over-budget tick is greppable; this log line itself
    -- is I/O and runs AFTER the measured window, so it never inflates the number.
    local budgetTag = ''
    if computeMs then
        budgetTag = string.format(' computeMs=%.3f%s', computeMs,
            computeMs > 2.0 and ' OVER_BUDGET' or '')
    end
    local econ = picture.economy or {}
    -- The human's vetoes, named — the AI's own report that it consulted them.
    -- Absent from an ordinary tick, so the line stays the same width it was.
    local vetoTag = ''
    if plan.vetoed and #plan.vetoed > 0 then
        vetoTag = ' vetoed=' .. table.concat(plan.vetoed, ',')
    end
    self.actuators:chat(string.format(
        "[strategos] tick f=%d role=%s lod=%d%s goals=%d directives=%d "
        .. "regions(own/neu/enemy)=%d/%d/%d obj(active/done)=%d/%d ownStr=%d "
        .. "pool(own/team)=%d/%d budget=%d spent=%d%s%s",
        frame, role.id, self.lodTier,
        picture.script and (' script=' .. table.concat(picture.script.kinds or {}, '+')) or '',
        nGoals, nDir, rOwned, rNeutral, rEnemy, objActive, objDone,
        math.floor(ownStrength), math.floor(econ.ownPool or 0),
        math.floor(econ.teamPool or 0), math.floor(plan.budget or 0),
        math.floor(plan.spent or 0), budgetTag, vetoTag))

    -- 5. PARLEY — evaluate proposals addressed to us and respond
    -- (interaction §6.2). The decision is computed unconditionally (pure,
    -- testable now); only the actual respond CALL is missing a runtime verb
    -- (Actuators:respondProposal degrades to a no-op false, same as every other
    -- AI2-class verb in actuators.lua — see its comment: I1 has landed, so this
    -- is unimplemented, not blocked).
    for _, r in ipairs(Planner.evaluateProposals(picture, self.profile, role)) do
        self.actuators:respondProposal(r.id, r.decision)
    end
end

--=============================================================================
-- onUpdate — the one callin the current runtime dispatches (AIScriptContext
-- ProcessSnapshot → global onUpdate(frame)). We self-throttle to the
-- strategic cadence; the runtime's own tickInterval is a coarser gate.
--=============================================================================
function onUpdate(frame)
    if not self.booted then
        local ok, err = pcall(boot, frame)
        if not ok then
            -- Loud, once: a failed boot must be obvious in the log, not silent.
            AI_STRATEGOS_BOOT_ERROR = tostring(err)
            return
        end
    end

    -- LOD gate (plan §3 / PLAN-ai.md LOD table): a dormant NPC faction thinks
    -- once a minute instead of once every five seconds. The tier is re-derived
    -- at the end of every tick from that tick's Picture (lod.lua), clamped into
    -- the role's own LOD band — so a co-commander is pinned at LOD 0 and only an
    -- NPC ever actually goes quiet.
    local period = self.role
        and Lod.periodFor(self.lodTier, self.role, Config)
        or Config.STRATEGIC_TICK_FRAMES
    if self.lastTickFrame >= 0 and (frame - self.lastTickFrame) < period then
        return
    end
    self.lastTickFrame = frame

    local ok, err = pcall(strategicTick, frame)
    if not ok then
        -- A crashing tick must not wedge the AI: log and try again next tick.
        -- Statelessness (plan §7) means we lose nothing but this tick.
        if self.actuators then self.actuators:noteError(frame, err) end
    end
end

--=============================================================================
-- Aspirational event callins (PLAN-ai.md AIEventHandler). The current
-- runtime does not dispatch these yet, but defining them is harmless and
-- documents the intended surface. They only feed memory hints — never
-- decisions (decisions happen on the strategic tick from the Picture).
--=============================================================================
function onUnitCreated(unitID, unitDefID, teamID)   -- luacheck: ignore
    -- No-op: force composition is re-derived from the Picture each tick.
end

function onUnitDestroyed(unitID, attackerID)         -- luacheck: ignore
    -- No-op here; losses show up as reduced strength in the next Picture.
    -- (A future optimisation could invalidate a commitment early.)
end

function onRelease(reason)                            -- luacheck: ignore
    -- The VM is being torn down. Nothing to persist (statelessness, §7).
end
