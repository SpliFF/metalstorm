-- game_authority_charge.lua — the AllowCommand charging gate
-- (PLAN-metalstorm-authority.md §3.2, DECISIONS.md D1/D6).
--
-- WHY A SEPARATE GADGET AT LAYER +100 (not folded into game_authority.lua's
-- -100): AllowCommand chains through every registered gadget in layer
-- order and any gadget may veto (e.g. squad.lua at -60 refuses
-- heal/reclaim/resurrect/capture). If authority charged FIRST (at -100)
-- and a later gadget vetoed, the player would have paid for a refused
-- order — a real bug in the original single-gadget stub.
--
-- Layer-order proof (cont/base/springcontent/LuaGadgets/gadgets.lua):
-- gadgetHandler:AllowCommand iterates `r_ipairs(self.AllowCommandList)`;
-- AllowCommandList is built by insert-sort with "lists are in reverse layer
-- order, lowest at back" (gadgets.lua comment) — i.e. index #1 = highest
-- layer, index #N = lowest layer. r_ipairs walks from #N down to #1, so
-- iteration runs LOWEST layer first, HIGHEST layer last. Charging at +100
-- therefore always runs after every other gadget's AllowCommand veto
-- (squad.lua -60, and anything else registered below +100) — exactly the
-- ordering §3.2 requires, with no engine change needed.
--
-- game_authority.lua (-100) owns pools/API/Initialize so GG.Authority
-- exists before every other gadget's Initialize; this gadget owns nothing
-- but the charging decision itself.

function gadget:GetInfo()
    return {
        name    = "Authority Charging",
        desc    = "AllowCommand charging gate — runs after every other gadget's veto",
        author  = "metalstorm",
        date    = "2026",
        license = "GPL v2",
        layer   = 100,
        enabled = true,
    }
end

if not gadgetHandler:IsSyncedCode() then
    return false
end

local Classify = VFS.Include("LuaRules/Gadgets/authority/classify.lua")

-- Engine ask A1 (PLAN-metalstorm-authority.md §3.2/§7): CONFIRMED, no
-- engine change needed — verified rts/Lua/LuaHandleSynced.cpp:634
-- (CSyncedLuaHandle::AllowCommand) pushes playerNum, fromSynced, fromLua as
-- three extra Lua args after LuaUtils::PushUnitAndCommand's 7
-- (unitID, unitDefID, unitTeam, cmdID, cmdParams, cmdOptions, cmdTag). The
-- @function AllowCommand doc comment omits playerNum from its param list
-- (a doc gap, not a signature gap) — the real call signature is:
--   AllowCommand(unitID, unitDefID, unitTeam, cmdID, cmdParams, cmdOptions,
--                cmdTag, playerID, fromSynced, fromLua)
function gadget:AllowCommand(unitID, unitDefID, unitTeam, cmdID, cmdParams, cmdOptions,
                              cmdTag, playerID, fromSynced, fromLua)
    if not GG.Authority then return true end          -- defensive: not yet Initialized
    if Classify.FREE_CMDS[cmdID] then return true end
    if not Classify.isChargeable(fromSynced, fromLua) then return true end

    local cost = GG.Authority.OrderCost(unitID, cmdID)
    local allowed = GG.Authority.ChargeOrder(unitID, unitTeam, playerID, cost, cmdID)
    if allowed and cost > 0 and playerID then
        -- Attribution hook for objectives (PLAN-metalstorm-objectives.md §5):
        -- last_commander stamps who most recently paid to move this unit,
        -- so a completion-time participation scan can credit the right
        -- player. Only stamped on an actually-charged issuance — free/
        -- fromLua commands (incl. directive decomposition) leave the
        -- previous stamp untouched by design (§5 "last_commander notes").
        Spring.SetUnitRulesParam(unitID, 'last_commander', playerID)
    end
    return allowed
end
