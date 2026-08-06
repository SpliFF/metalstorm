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
--
-- Also owns the directive/standing-order CREATE charge sites
-- (AllowDirectiveCreate/AllowStandingOrderCreate, an engine callin added
-- alongside AllowDirectiveAssign — see rts/System/EventClient.h). These
-- have no veto-ordering concern (there is no other gadget that vetoes a
-- directive/standing-order create today) so the layer choice is purely
-- "lives next to AllowCommand", not load-bearing the way it is above.

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
    if not Classify.isChargeable(fromSynced, fromLua) then
        -- DIRECTIVE / STANDING-ORDER DECOMPOSITION (objectives §5.1, endtoend
        -- D24). Not chargeable — the directive was charged once at create —
        -- but it IS attributable. The engine's two decomposition sites
        -- (OrgGroups.cpp IssueDirectiveCommand, StandingOrders.cpp
        -- IssueCommandFor) issue on behalf of the directive's author, i.e.
        -- fromLua with a REAL playerNum; every other fromLua command in the
        -- engine (the whole Spring.GiveOrderToUnit family, LuaSyncedCtrl.cpp)
        -- passes -1. So `fromLua and playerID >= 0` is exactly and only "a
        -- directive is moving this unit on its author's behalf", and §5's
        -- "free/fromLua commands that are not directive decompositions still
        -- don't reassign credit" holds unchanged.
        --
        -- This is the ONLY point at which a condition/area-scoped directive
        -- (groupID 0 — everything the composer offers a player who has not
        -- hand-built an org group) can attach its author to a unit: it has no
        -- roster at create time, so ChargeDirective's stampCommander cannot
        -- reach it. Without this a player could command their whole army for a
        -- whole war and finish with score_<player>_objectives = 0.
        --
        -- Deliberately NOT gated on cost > 0 the way the charged branch below
        -- is: the cost was already paid at create, and a flat 'standing' fee
        -- can round to a charge this callin never sees.
        if fromLua and playerID and playerID >= 0 then
            Spring.SetUnitRulesParam(unitID, 'last_commander', playerID)
        end
        return true
    end

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

-- ============================================================
-- Directive/standing-order CREATE charging (PLAN-metalstorm-authority.md
-- §3.2/A2, PLAN-macro-directives.md §1 "Charge point"). Distinct from
-- AllowCommand above: these fire once, at creation, before the C++
-- DirectiveManager/StandingOrderManager stores the object — not per
-- decomposed squad command (those are fromLua and free, unaffected by
-- this gadget).
--
-- AI3 (PLAN-metalstorm-ai.md §1/§5, decision 2026-07-26): the interim "AI
-- creates free by design" free-pass is GONE. AI slots are now real virtual
-- players with their own playerID + authority pool, so when the AI directive
-- path (AI2's TickAI routing) fires this callin it passes the AI's REAL
-- playerID and the charge debits authority_player_<aiID> — the AI's own pool,
-- exactly like a human. A co-commander AI additionally flags itself
-- own-pool-only (GG.Authority.SetOwnPoolOnly) so it can never fall back to the
-- shared team pool (§5 invariant, enforced in debitPools).
--
-- A playerID of -1 remains coerced to nil ONLY for a genuinely unattributed
-- directive (a gadget-internal create with no issuing player / a session with
-- no clientPlayerNum entry yet) — that residual case charges team-pool-only,
-- same nil-safe convention as AllowCommand. It is NOT an AI path anymore.
-- ============================================================

--- isAI is surfaced only through GetPlayerInfo's player-options table
--- (getPlayerOpts=true, 11th return): opts.isAI == "1" for a virtual AI player.
local function isAIPlayer(playerID)
    if not playerID then return false end
    local opts = select(11, Spring.GetPlayerInfo(playerID, true))
    return type(opts) == 'table' and opts.isAI == '1'
end

function gadget:AllowDirectiveCreate(team, playerID, groupID, directiveType, requestedStrength)
    if not GG.Authority then return true end
    local rawPlayer = playerID
    if playerID and playerID < 0 then playerID = nil end
    local allowed, cost = GG.Authority.ChargeDirective(
        playerID, team, groupID, directiveType, requestedStrength)

    -- Interaction §5.1/§6.3 hooks, only on a directive that actually landed:
    if allowed and GG.AIGuidance then
        if isAIPlayer(rawPlayer) then
            -- The AI's own directive → intent report (ai-command-panel.js), so
            -- its spend is socially visible (§5.1). group 0 = area-scoped.
            GG.AIGuidance.RecordIntent(team, directiveType, groupID or 0, cost or 0)
        elseif groupID and groupID ~= 0 then
            -- A HUMAN directing a real group → 3-min touch lock so the
            -- co-commander leaves that group alone while the human steers it.
            GG.AIGuidance.TouchGroup(team, groupID)
        end
    end
    return allowed
end

function gadget:AllowStandingOrderCreate(team, playerID, orderType)
    if not GG.Authority then return true end
    if playerID and playerID < 0 then playerID = nil end
    return GG.Authority.ChargeStandingOrder(playerID, team, orderType)
end
