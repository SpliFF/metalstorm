-- lod.lua — dynamic level-of-detail for the strategic tick.  PURE.
-- PLAN-ai.md §"AI LOD (Level of Detail) System" + PLAN-metalstorm-ai.md §3/§5
-- ("LOD by player proximity ... dormant when far", the NPC-faction column).
--
-- WHAT THIS DOES: picks a tier 0..3 each strategic tick; main.lua multiplies
-- Config.STRATEGIC_TICK_FRAMES by Config.LOD_TICK_MULT[tier] to get the next
-- wake-up period. A dormant raider costs the server one cheap tick a minute
-- instead of one every five seconds, which is the entire point of LOD.
--
-- ===========================================================================
-- DELIBERATE DIVERGENCE FROM PLAN-ai.md's LOD TABLE — read this before
-- "fixing" it (CLAUDE.md: never deviate from the reference silently).
-- ===========================================================================
-- PLAN-ai.md keys each tier on PLAYER VIEWPORT distance ("player viewport
-- within 2000 units" ... "no player within 10000 units"). A game-shipped AI
-- plugin must not read that: where the enemy is looking is not player-visible
-- data, and PLAN-metalstorm-ai.md §2 is absolute about it ("Everything below is
-- player-visible data; no cheating channels"). Viewport-driven LOD is therefore
-- the AI RUNTIME's job — an engine-side gate on how often the VM is ticked at
-- all, surfaced to the plugin as `AIStateView.getLODLevel()` in PLAN-ai.md's own
-- design. That callin does not exist yet (picture.lua feature-detects it as
-- `caps.lod`).
--
-- So this module implements the half a plugin legitimately can: a CONTACT tier
-- derived from its own Picture. Contact is measured in REGION-GRAPH HOPS, not
-- elmos, because "adjacency IS strategic distance" (plan §2) — an NPC whose
-- ground is being fought over is at tier 0, one hop from a sighting is tier 1,
-- two hops tier 2, and anything further (or nothing seen at all) is dormant.
-- The hop bands stand in for the plan's 2000/5000/10000-elmo bands; the dwell
-- times and the immediate-escalation rule below are taken from the plan's
-- "LOD Transitions" section verbatim.
--
-- WHEN THE ENGINE ASK LANDS: `Lod.evaluate` prefers `picture.lod` the moment
-- `picture.caps.lod` flips true — the engine's viewport truth beats this proxy,
-- with no code change here or in main.lua.
--
-- HONEST COST OF DORMANCY: the proxy needs a Picture, and a Picture only exists
-- on a tick, so a dormant NPC learns about a new arrival at its NEXT wake-up
-- (up to LOD_TICK_MULT[3] × 5 s = 60 s late). That latency IS dormancy — an
-- engine-side viewport gate would have exactly the same property — and it is
-- why escalation below is instant while de-escalation waits.

local Graph = require('graph')

local Lod = {}

Lod.TIER_FULL    = 0
Lod.TIER_DORMANT = 3

--- Contact distance (hops) -> tier. Beyond the last band, dormant.
local TIER_FOR_HOPS = { [0] = 0, [1] = 1, [2] = 2 }

--- De-escalation dwell in frames, indexed by the tier being LEFT. Straight
-- from PLAN-ai.md "LOD Transitions": 5 s out of LOD-0 range before dropping to
-- 1, 10 s before 2, 30 s before dormancy ("hysteresis prevents thrashing").
-- Escalation the other way is immediate, also per the plan.
Lod.DWELL_FRAMES = { [0] = 150, [1] = 300, [2] = 900 }

--- Per-instance LOD state. Held by main.lua across ticks; rebuilt from scratch
-- after a VM restart, which is fine (plan §7 statelessness — worst case the AI
-- thinks at full rate for one dwell window).
function Lod.newState(role)
    return { tier = (role and role.lodFloor) or Lod.TIER_FULL,
             want = nil, wantSinceFrame = nil }
end

--- Minimum hop count from ground we hold/occupy to ground we can see enemies
-- on. nil = no contact anywhere (or no usable graph — see the blind branch in
-- tierForContact). Contested own ground short-circuits to 0: something is
-- fighting us right here, whether or not we have a sighting to prove it.
function Lod.contactHops(picture, role)
    local regions = (picture and picture.regions) or {}
    local teamId  = role and role.teamId

    -- Sources: regions we have force in, plus regions we own. The union matters
    -- — a raider whose whole force sits at home must still wake when its
    -- territory is threatened, and a force operating off its own ground must
    -- still count that ground as "near".
    local ours = {}
    for key, bucket in pairs((picture and picture.ledger) or {}) do
        if (bucket.strength or 0) > 0 and regions[key] then ours[key] = true end
    end
    if teamId ~= nil then
        for key, r in pairs(regions) do
            if r.owner == teamId then ours[key] = true end
        end
    end

    for key in pairs(ours) do
        local r = regions[key]
        if r and r.contested then return 0 end
    end

    local threat = {}
    for key, mem in pairs((picture and picture.intel) or {}) do
        if (mem.strength or 0) > 0 and regions[key] then threat[key] = true end
    end

    return Graph.minHops(regions, ours, threat)
end

--- The tier the contact proxy WANTS this tick (before clamping/hysteresis).
function Lod.tierForContact(picture, role)
    local regions = (picture and picture.regions) or {}
    if next(regions) == nil then
        -- Blind: no region graph loaded at all (AI4 unavailable, or a map that
        -- ships none). Hops are meaningless, so fall back to the only honest
        -- signal left — do we see anything? Seen enemies with no graph means
        -- "in contact, think fast"; nothing seen means dormant.
        for _, mem in pairs((picture and picture.intel) or {}) do
            if (mem.strength or 0) > 0 then return Lod.TIER_FULL end
        end
        return Lod.TIER_DORMANT
    end

    local hops = Lod.contactHops(picture, role)
    if hops == nil then return Lod.TIER_DORMANT end
    return TIER_FOR_HOPS[hops] or Lod.TIER_DORMANT
end

--- Resolve this tick's tier. Mutates `state` (the dwell tracker) and returns
-- the tier, clamped into the role's [lodFloor, lodCeil] band — which is what
-- pins a co-commander at LOD 0 and a full side at 0-1 (plan §5 table) while
-- letting an NPC range all the way to dormant.
function Lod.evaluate(state, picture, role, config)   -- luacheck: ignore config
    local floor = (role and role.lodFloor) or Lod.TIER_FULL
    local ceil  = (role and role.lodCeil)  or Lod.TIER_FULL
    local function clamp(t) return math.max(floor, math.min(ceil, t)) end

    -- Engine truth wins outright when it exists (PLAN-ai.md
    -- AIStateView.getLODLevel) — and it bypasses the dwell below, because the
    -- runtime owns the transition ladder in that world (the plan's 5/10/30 s
    -- hysteresis is specified ON the engine's tier). Damping it a second time
    -- here would just make the AI slower to obey its own runtime.
    if picture and picture.caps and picture.caps.lod then
        local tier = clamp(picture.lod or Lod.TIER_FULL)
        state.tier, state.want, state.wantSinceFrame = tier, nil, nil
        return tier
    end

    local want    = clamp(Lod.tierForContact(picture, role))
    local frame   = (picture and picture.frame) or 0
    local current = clamp(state.tier or floor)

    if want <= current then
        -- Escalation (or steady state) is immediate: a dormant faction that
        -- finds contact must not sit out a dwell window before reacting.
        state.tier, state.want, state.wantSinceFrame = want, nil, nil
        return want
    end

    -- De-escalation: one tier at a time, each gated on ITS OWN dwell window,
    -- so dropping full → dormant takes 5 s + 10 s + 30 s of continuous quiet.
    if state.want ~= want then
        state.want, state.wantSinceFrame = want, frame
    end
    if (frame - (state.wantSinceFrame or frame)) >= (Lod.DWELL_FRAMES[current] or 0) then
        state.tier = clamp(current + 1)
        state.want, state.wantSinceFrame = nil, nil
    else
        state.tier = current
    end
    return state.tier
end

--- Strategic-tick period (frames) for a tier. `role.tickFramesBase` is the
-- LOD-0 cadence (Config.STRATEGIC_TICK_FRAMES unless a role overrides it).
function Lod.periodFor(tier, role, config)
    local base = (role and role.tickFramesBase)
              or (config and config.STRATEGIC_TICK_FRAMES) or 150
    local mult = ((config and config.LOD_TICK_MULT) or {})[tier] or 1
    return math.max(1, math.floor(base * mult))
end

return Lod
