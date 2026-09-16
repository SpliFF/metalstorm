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
-- Default pSuccess floor ("don't trickle: mass or skip"). A profile's own
-- `pSuccessFloor` REPLACES this (planner.lua floorFor) — it used to be
-- max()ed with it, which made every shipped profile's floor (0.0–0.15) inert.
Config.PSUCCESS_FLOOR      = 0.6
-- Travel: value is discounted 1/(1 + PER_HOP × hops) — a goal two hops away is
-- worth ~77 % of the same goal next door. Unreachable = not a candidate at all.
Config.TRAVEL_PENALTY_PER_HOP = 0.15
-- Frames an army needs per region-graph hop (scorched_crossing: scenariogen
-- measured 3411 frames for the slowest staged class over a ~2.2-hop approach;
-- 1792-elmo regions). Used ONLY to refuse an expiring objective the package
-- cannot reach in time — a coarse feasibility bar, not a travel model.
Config.HOP_TRAVEL_FRAMES   = 1200

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
-- Threat map / posture / withdrawal (threat.lua, slate.lua, planner.lua)
--=============================================================================
-- Neighbour spill fraction for the threat map (see threat.lua header).
Config.THREAT_SPILL = 0.5
-- Posture floor: the fraction of a package standing in the anchor region
-- (threat.lua anchorRegion — the departure zone, else our sole owned region)
-- that is split off as a garrison and may only DEFEND that region. A profile's
-- `garrisonFraction` overrides it.
Config.GARRISON_FRACTION = 0.25
-- Withdrawal: own/enemy strength ratio below which a side with a known
-- departure zone falls back to it (profile `withdrawRatio` overrides), and the
-- least confidence-weighted enemy strength that may trigger it at all.
Config.WITHDRAW_RATIO     = 0.5
Config.WITHDRAW_MIN_ENEMY = 3
-- Objective expiry urgency: value × (1 + URGENCY_BOOST × (1 − remaining /
-- HORIZON)) once an objective is inside the horizon. Protect objectives
-- (expiry-as-success) are exempt — their value is steady until the bell.
Config.EXPIRY_HORIZON_FRAMES = 3600
Config.EXPIRY_URGENCY_BOOST  = 0.5
-- Arrival cover: a DEFEND goal on an arrival's drop region this many frames
-- before its eta (picture.transports.arrivals — see README "engine asks").
Config.ARRIVAL_COVER_FRAMES = 1800
-- Denial: an enemy-only objective (their protect town) is worth this fraction
-- of its reward to us as an ATTACK target (profile `deny` overrides).
Config.DENY_FRACTION = 0.3

-- Passability by tag (graph.lua passableFor). GROUND blocks every land force;
-- ARMOUR additionally blocks the ridges/fords only infantry crosses — the
-- reading of mapinfo's "split for VEH/HEAVY, connected for INFANTRY"
-- (meridian_basin) that the region tags can express. Tunables, not law.
Config.GROUND_BLOCKED_TAGS = { water = true, deep = true, naval = true, lake = true }
Config.ARMOUR_BLOCKED_TAGS = { infantry_only = true, ford = true, armour_blocked = true }
-- Power-table classes that make a package "armour" for passability once they
-- carry more than ARMOUR_SHARE of its strength.
Config.ARMOUR_CLASSES = { tank = true, mech = true, artillery = true, heavy = true,
                          vehicle = true, armour = true, armor = true }
Config.ARMOUR_SHARE = 0.5

--=============================================================================
-- Authority-cost formula MIRROR (PLAN-metalstorm-authority.md §3.1/§3.3).
-- The AI pays authority like a player; the planner subtracts predicted cost
-- from each candidate's score. This must stay in lockstep with
-- LuaRules/Configs/authority_cost.lua + LuaRules/Gadgets/authority/formula.lua
-- (the synced source of truth). tests/mirror_spec.lua LOADS THOSE FILES and
-- fails the moment this copy drifts.
--
-- WHAT IS ACTUALLY CHARGED (game_authority.lua ChargeDirective, read
-- 2026-09-10 — the previous mirror predicted a formula the charge site never
-- applied: force-scaled, region-modified, echelon-discounted):
--   area-scoped directive (groupID 0 — what actuators.lua issues today, for
--     directives AND postures):  ceil(base_k × 1 × 1.0 × order_class.standing × scale)
--   group-scoped directive:      ceil(base_k × Σ authority_cost_base × 1.0 × order_class.directive × scale)
--   costScale ≤ 0 → 0 (formula.lua's free-orders path).
-- regionMod is PINNED to 1.0 at the directive charge site ("a directive has no
-- single position"); the friendly/neutral/enemy table is kept for the day the
-- charge grows a real one, and is NOT applied.
--=============================================================================
Config.authorityCost = {
    version = 1,
    base_k  = 1.0,
    -- order_class — verbatim copy of authority_cost.lua (mirror_spec checks).
    order_class = {
        directive  = 1.0,
        standing   = 1.2,
        micro      = 2.0,
        group_op   = 0.5,
        build      = 3.0,
        posture    = 0.25,
        bounty     = 1.0,
        proposal   = 0.5,
    },
    -- Documented bounds only (regions/cost.lua); not an input to the charge.
    regionMod = { friendly = 0.5, neutral = 1.0, enemy = 2.0 },
    -- Directive scope the actuator issues. 'area' = condition-scoped
    -- (issueDirective(0, spec)); 'group' once org-group rosters reach the AI.
    directiveScope = 'area',
}

--- The synced formula, verbatim (authority/formula.lua M.cost).
function Config.formulaCost(baseK, baseCost, regionMod, orderClassMod, costScale)
    if costScale <= 0 then return 0 end
    return math.ceil(baseK * baseCost * regionMod * orderClassMod * costScale)
end

--- Predict the authority cost of a directive over a force package.
-- `pkg.baseSum` is Σ member authority_cost_base (the Picture supplies it when
-- the power table carries scale; else `strength` stands in — a head count,
-- which for s1 squads IS the base). `regionKind` is accepted for API
-- stability and deliberately unused (see the header). `scope` defaults to the
-- actuator's ('area').
function Config.predictDirectiveCost(pkg, regionKind, echelon, costScale, scope)   -- luacheck: ignore regionKind echelon
    local ac = Config.authorityCost
    scope = scope or ac.directiveScope
    local scale = costScale or 1.0
    if scope == 'group' then
        local base = (pkg and (pkg.baseSum or pkg.strength)) or 0
        return Config.formulaCost(ac.base_k, base, 1.0, ac.order_class.directive, scale)
    end
    return Config.formulaCost(ac.base_k, 1, 1.0, ac.order_class.standing, scale)
end

--- Predict a posture change cost. Today a DEFEND posture is expressed as an
-- area-scoped Defend directive (actuators.lua _applyPosture), so it costs the
-- same flat standing fee — "nearly free" relative to a pool, but NOT zero, and
-- the intent report now says so.
function Config.predictPostureCost(pkg, regionKind, costScale)
    return Config.predictDirectiveCost(pkg, regionKind, 'army', costScale)
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
