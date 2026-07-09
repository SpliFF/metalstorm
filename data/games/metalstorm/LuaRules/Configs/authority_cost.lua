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

    -- Region modifier bounds (actual per-cell value from GG.Regions):
    region_mod_min = 0.5,    -- deep friendly territory
    region_mod_max = 3.0,    -- deep enemy territory

    -- economy (PLAN-metalstorm-economy.md §3 — defaults UNPINNED, "~" in
    -- plan; review §C requires pinning before hand-off):
    economy = {
        soft_ceiling_C_base   = nil,  -- TODO pin (per-player pool soft cap)
        overflow_decay_pct    = nil,  -- TODO pin (decay % above ceiling)
        overflow_decay_period = nil,  -- TODO pin (frames between decay ticks)
    },
}
