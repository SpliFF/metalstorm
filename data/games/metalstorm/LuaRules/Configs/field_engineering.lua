-- LuaRules/Configs/field_engineering.lua — what may be BUILT in a battle.
--
-- Battles get field engineering only (manual §1/§6; ruling 2026-08-19). This
-- file is the data behind the gate in game_authority.lua (policy in
-- authority/field_engineering.lua): a def may be created by a factory or a
-- builder in battle iff it passes here. Everything else — every factory's
-- roster, the factories themselves, the command nexus — is vetoed at the
-- build order (AllowCommand) and again at creation (AllowUnitCreation), so a
-- scenario that hands a player a Foundry hands them a building that cannot
-- produce, which is what the defs' own comments always promised.
--
-- KEYED BY THE TAG THE DEFS ALREADY CARRY. `customparams.building_family` is
-- authored on every building def ('military' = the factory tier,
-- buildings_military.lua; 'support' = the staging-post kit,
-- buildings_support.lua; 'site' = capturable Gaia industry; 'civilian'). The
-- field-engineering tier IS `support`, so no unit def changes hands here —
-- add a family or a def below, never a customparam elsewhere.
--
-- The `battle_production` modoption (modoptions.lua) is the playtest escape
-- hatch: on, this whole file is bypassed and the game publishes
-- `battle_production = 1` so a HUD can say so.

return {
    version = 1,

    -- Building families creatable in battle. A mobile unit is never creatable
    -- in battle regardless of family (force arrives by transport only).
    allowed_families = {
        support = true,
    },

    -- Per-def exceptions, by def name. An allow entry admits a def whatever
    -- its family (a scenario-specific fortification); a deny entry refuses one
    -- even inside an allowed family. Deny wins over allow.
    allowed_defs = {},
    denied_defs  = {},
}
