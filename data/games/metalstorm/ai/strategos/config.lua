-- config.lua — shared constants + the authority-cost formula mirror + a
-- seedable RNG. Pure data and pure functions: no engine access, so it is
-- required by both the runtime modules and the headless busted specs.
--
-- Numbers below are the v0 tunables lifted straight from the plans; the
-- *orderings* (macro < micro; DEFEND always affordable; reserve respected)
-- are design law, the exact magnitudes are playtest levers.

local Config = {}

--=============================================================================
-- Cadence (PLAN-metalstorm-ai.md §3, PLAN-ai.md LOD table)
--=============================================================================
Config.STRATEGIC_TICK_FRAMES = 150     -- 5 s @ 30 Hz — aligned with region eval
Config.DIRECTIVE_RATE_CLAMP  = 1       -- ≤ 1 directive / group / tick (§8 E6)

-- LOD tick multipliers applied to STRATEGIC_TICK_FRAMES (plan §3 / PLAN-ai.md).
-- Role.tickFrames is derived from these; dormant NPCs think at 30 s+.
Config.LOD_TICK_MULT = { [0] = 1, [1] = 1, [2] = 4, [3] = 12 }

--=============================================================================
-- Intel decay (plan §2 — "remembers what a player would remember, forgets
-- honestly"). Linear confidence decay to zero over ~3 min of no sighting.
--=============================================================================
Config.INTEL_DECAY_FRAMES = 5400       -- ~3 min @ 30 Hz
Config.INTEL_FORGET_BELOW = 0.05       -- drop the entry once confidence < this

-- Radar blips (position-only contacts, AI.getRadarBlips). A blip is a real
-- contact of unknown type/strength, so it enters intel as a LOW-confidence
-- entry: BLIP_CONFIDENCE caps what a blip-only region can reach (kept below
-- the 0.5 intelStale threshold so blips alone still leave a region worth
-- scouting), and each blip contributes BLIP_STRENGTH to the region's threat
-- (a conservative half of one healthy unit — the honest prior for "something
-- is there, type unknown"). Both are tunables, not code.
Config.BLIP_CONFIDENCE = 0.35
Config.BLIP_STRENGTH   = 0.5

--=============================================================================
-- Planner governance (plan §3.2/§3.3)
--=============================================================================
Config.RESERVE_FRACTION    = 0.25      -- keep 25 % of pool for emergency DEFEND
Config.COMMITMENT_DECAY_FRAMES = 3600  -- ~2 min — fresh orders are sticky
Config.REASSIGN_BAR        = 1.4       -- newScore must beat current × this
Config.PSUCCESS_FLOOR      = 0.6       -- don't trickle: mass or skip
Config.TRAVEL_PENALTY_PER_HOP = 0.15   -- region-graph hops, not elmos

-- Region value threshold for auto-DEFEND implicit goals (plan §3.1).
Config.DEFEND_VALUE_MIN    = 1.0

-- Terminal objective (endtoend Q-E1 / D47). Its published reward is an
-- authority payout, not a statement of what winning is worth, so the planner
-- does not price it — it ALLOCATES it first (planner.allocationRank) and only
-- asks whether the attack is viable. This is that viability bar: it replaces
-- PSUCCESS_FLOOR for a prize an enemy holds, and itself decays to 0 as the
-- holder's hold clock fills, because the alternative to a bad attack on the
-- last objective is not "no fight", it is a certain loss.
Config.VICTORY_PSUCCESS_FLOOR = 0.35

-- Strategic-value scale (plan §3.2 "region value × strategic weights"): the
-- unit bridge that puts a region's small value (0.5–2) on the same authority
-- scale as an objective's reward (hundreds), so score = value·pSuccess − cost
-- is meaningful and the ×1.4 reassign bar operates on comparable magnitudes.
-- Objective goals are already in authority units and are NOT rescaled.
Config.STRATEGIC_VALUE_SCALE = 200

--=============================================================================
-- Authority-cost formula MIRROR (PLAN-metalstorm-authority.md §3.1/§3.3).
-- The AI pays authority like a player; the planner subtracts predicted cost
-- from each candidate's score. This must stay in lockstep with
-- LuaRules/Configs/authority_cost.lua (the synced source of truth) — the
-- shared JSON export (authority ask A3) will let both read one file. Until
-- then this is a hand-maintained copy; `version` guards drift.
--=============================================================================
Config.authorityCost = {
    version = 1,
    regionMod = { friendly = 0.5, neutral = 1.0, enemy = 2.0 },
    orderMod = {
        micro          = 1.0,        -- baseline (never issued by this AI)
        posture        = 0.25,       -- cheap — behaviour settings aren't spam
        build          = 2.0,        -- strategic commitment
        directivePlatoon = 0.5,      -- amortised: half of hand-issuing
        directiveArmy    = 0.35,     -- deeper amortisation at higher echelon
    },
}

--- Predict the authority cost of a directive over a force package.
-- Mirror of the synced formula: ceil(Σ base × regionMod × orderMod × scale).
-- `pkg.baseSum` is Σ member authority_cost_base (from the def export);
-- `regionKind` ∈ {'friendly','neutral','enemy'}; `echelon` ∈ {'platoon','army'}.
function Config.predictDirectiveCost(pkg, regionKind, echelon, costScale)
    local ac = Config.authorityCost
    local rMod = ac.regionMod[regionKind or 'neutral'] or 1.0
    local oMod = (echelon == 'army') and ac.orderMod.directiveArmy
                                     or ac.orderMod.directivePlatoon
    local base = (pkg and pkg.baseSum) or 0
    local scale = costScale or 1.0
    return math.ceil(base * rMod * oMod * scale)
end

--- Predict a posture change cost (nearly free — the always-affordable action).
function Config.predictPostureCost(pkg, regionKind, costScale)
    local ac = Config.authorityCost
    local rMod = ac.regionMod[regionKind or 'neutral'] or 1.0
    local base = (pkg and pkg.baseSum) or 0
    return math.ceil(base * rMod * ac.orderMod.posture * (costScale or 1.0))
end

--=============================================================================
-- Seedable RNG (plan §6/§10 — "identical Picture ⇒ identical directives").
-- A tiny LCG so tests are reproducible without depending on the VM's
-- math.random state. Signature mimics math.random.
--=============================================================================
function Config.makeRNG(seed)
    local state = (seed or 1) % 2147483647
    if state <= 0 then state = state + 2147483646 end
    local rng = {}
    function rng.raw()
        state = (state * 16807) % 2147483647
        return state
    end
    -- rng.random()      → float in [0,1)
    -- rng.random(n)     → int in [1,n]
    -- rng.random(a,b)   → int in [a,b]
    function rng.random(a, b)
        local r = (rng.raw() - 1) / 2147483646
        if not a then return r end
        if not b then return 1 + math.floor(r * a) end
        return a + math.floor(r * (b - a + 1))
    end
    return rng
end

--=============================================================================
-- Defaults
--=============================================================================
Config.DEFAULT_PROFILE = 'default'
Config.SEED = 1337                     -- fixed → reproducible; vary per test

-- Profiles a scenario/lobby may select for a slot (plan §3.4/§10 task 6). This
-- is an ALLOW-LIST, not documentation: the selected name arrives as untrusted
-- rulesParam text and is concatenated into `require('profiles.'..name)`, so
-- main.lua refuses anything not listed here. (The plugin loader's own sandbox —
-- no `..`, no path separators — is the second line of defence, not the first.)
-- Add a profile file AND its name here to ship a new personality.
Config.PROFILES = {
    default    = true,
    aggressive = true,
    caretaker  = true,
    mentor     = true,
    npc_raider = true,
}

return Config
