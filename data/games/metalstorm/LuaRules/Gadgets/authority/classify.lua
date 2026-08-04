-- authority/classify.lua — command → charge classification (PLAN-metalstorm-authority.md
-- §3.2/§3.3).
--
-- Pure decision, no Spring/GG API: given a raw AllowCommand cmdID and the
-- fromSynced/fromLua origin flags, decide (a) whether the command is on the
-- always-free list, (b) whether its origin is chargeable at all, and (c)
-- which order_class key (LuaRules/Configs/authority_cost.lua) it costs
-- against. Kept out of the gadget so it's testable with busted and NO
-- Spring/GG mocking, same convention as regions/cost.lua.
--
-- cmdIDs are hardcoded numbers, not read off the global CMD table: CMD only
-- exists inside the Spring Lua environment, and this module must load under
-- plain busted too. Values match rts/Lua/LuaConstCMD.cpp.

local M = {}

-- Free-command list (§3.2): a broke player may always halt units (safety
-- valve, anti-frustration) — STOP and cancelling self-destruct are never
-- charged, regardless of pools or origin.
M.FREE_CMDS = {
    [0]  = true,   -- CMD.STOP
    [65] = true,   -- CMD.SELFD
}

-- Posture/state-toggle commands (§3.3, orderMod 0.25 in the shared spec):
-- behaviour settings aren't spam.
M.POSTURE_CMDS = {
    [45]  = true,  -- CMD.FIRE_STATE
    [50]  = true,  -- CMD.MOVE_STATE
    [85]  = true,  -- CMD.ONOFF
    [95]  = true,  -- CMD.CLOAK
    [115] = true,  -- CMD.REPEAT
    [120] = true,  -- CMD.TRAJECTORY
    [135] = true,  -- CMD.AUTOREPAIRLEVEL
    [145] = true,  -- CMD.IDLEMODE
}

--- Order-class key into authority_cost.lua's `order_class` table. Negative
--- cmdID is the Spring convention for a build order (squad.lua already
--- relies on this). Anything not posture/build classifies as 'micro' — the
--- baseline direct-order class.
function M.orderClass(cmdID)
    if cmdID < 0 then return 'build' end
    if M.POSTURE_CMDS[cmdID] then return 'posture' end
    return 'micro'
end

--- Is this command's origin chargeable at all (§3.2 charging-rules table)?
--- fromLua: directive decomposition / gadget-issued — the directive itself
--- was charged at creation (§3.3); charging the decomposed commands too
--- would double-bill. fromSynced: engine-internal re-issue, never player
--- intent.
function M.isChargeable(fromSynced, fromLua)
    return not fromSynced and not fromLua
end

return M
