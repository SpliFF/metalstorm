-- LuaRules/Configs/authority_cost.lua — THE shared order-cost spec. STUB.
--
-- Single source of truth for the authority cost formula
-- (PLAN-metalstorm-authority.md): constants + order-class table, consumed by
--   * game_authority.lua        (synced charging via AllowCommand/directives)
--   * ai/strategos/planner.lua  (budget governor — the AI can't call
--                                AllowCommand, it mirrors this spec; ai §3.2)
--   * ui/lib/authority-cost.js  (client cost prediction / refusal UX) via a
--                               build-exported authority_cost.json (engine
--                               ask A3 — versioned, def-hash cached per
--                               PLAN-metalstorm-wire.md)
--
-- BUMP `version` ON EVERY FORMULA-AFFECTING CHANGE — the client mirror and
-- the JSON export key their caches on it.
--
-- PLAN-metalstorm-economy.md adds the long-horizon constants here (soft
-- ceiling, overflow decay) — see the "economy" section below.

return {
    version = 1,

    -- Base: authority_cost_base customparam = k · scale (decision recorded in
    -- PLAN-metalstorm-wars.md Appendix — scale, NOT current strength).
    base_k = 1.0,

    -- Order-class modifiers (anti-CPS: macro directives amortise, micro
    -- orders don't). Keys are order classes, not raw cmdIDs.
    order_class = {
        directive  = 1.0,    -- macro directive create (charged once)
        standing   = 1.2,    -- standing-order create
        micro      = 2.0,    -- direct per-unit command
        group_op   = 0.5,    -- createGroup/disbandGroup flat fee (wars appendix)
        build      = 3.0,    -- initiateBuild
        posture    = 0.25,   -- posture/formation change
        bounty     = 1.0,    -- stakeBounty passes the staked amount through
        proposal   = 0.5,    -- parley proposal fee (interaction)
    },

    -- Region modifier bounds (actual per-cell value from GG.Regions —
    -- regions/cost.lua MOD_FRIENDLY/MOD_NEUTRAL/MOD_ENEMY; kept here purely
    -- as documentation for the client formula mirror, not a runtime input):
    region_mod_min = 0.5,    -- friendly territory (owner allied to the orderer)
    region_mod_max = 2.0,    -- enemy territory (owner present, not allied)

    -- economy (PLAN-metalstorm-economy.md §3 — pinned 2026-07-20, unpinned by taskherd):
    economy = {
        -- Lever 1: soft ceiling with overflow decay (§3.1, default-on)
        soft_ceiling_C_base   = 6000,  -- per-player pool soft cap (team ceiling = C_base × teamPlayerCount). 6000 satisfies game_authority's own E1 load-time assert (C_base ≥ 2×maxOrderCost=6000: a team must be able to save for a scale-4 build without the ceiling capping them); the prior 2000 placeholder violated that rule. Retune with balance data.
        overflow_decay_pct    = 2,     -- decay % per minute above ceiling
        overflow_decay_period = 900,   -- frames between decay ticks (30 s at GAME_SPEED 30 = 1800 s/60 min × 2% = 0.6%/tick)

        -- Lever 2: reward normalisation (§3.2, default-off until validated)
        reward_normalisation_enabled = false,  -- toggle for systemic objective reward scaling by 1/velocity
        reward_scale_min = 0.5,                -- clamp min (prevents over-deflation)
        reward_scale_max = 2.0,                -- clamp max (prevents oscillation)
    },
}
