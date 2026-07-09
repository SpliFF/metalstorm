-- squad.lua — sim-side of the squad system (PLAN-metalstorm-squads.md §10).
--
-- Deliberately TINY. The squad illusion is entirely client-side: one sim unit
-- is rendered as many members (client/squads/*.js). The sim's only jobs are
-- (1) NOT modelling members, and (2) enforcing the invariants the client model
-- depends on. Member counts/positions/deaths/wrecks never touch the sim.

function gadget:GetInfo()
    return {
        name    = "Squads",
        desc    = "Enforces squad invariants (no heal/reclaim); carries squad metadata",
        author  = "metalstorm",
        date    = "2026",
        license = "GPL v2",
        layer   = -60,
        enabled = true,
    }
end

if not gadgetHandler:IsSyncedCode() then
    return false
end

-- Spring command IDs (negative cmdIDs are build orders, allowed).
local CMD_REPAIR    = CMD.REPAIR
local CMD_RECLAIM   = CMD.RECLAIM
local CMD_RESURRECT = CMD.RESURRECT
local CMD_CAPTURE   = CMD.CAPTURE

-- DIVERGENCE FROM STANDARD SPRING (called out per CLAUDE.md): Metalstorm has
-- NO healing, reclaim, resurrect, or reinforcement-into-an-existing-squad.
-- These would raise squad strength, which would force the client to re-add a
-- dead member — and to do that faithfully the sim would have to track
-- client-side wreck locations + member identities, i.e. exactly the per-member
-- state the squad model refuses to hold. Squad strength is therefore monotonic
-- non-increasing; new strength only ever arrives as a NEW squad (factory
-- output). See PLAN-metalstorm-squads.md §4/§4a.
--
-- REPAIR IS NUANCED: build-assist (engineers accelerating a unit still under
-- construction) is issued as REPAIR against a unit with buildProgress < 1 and
-- is REQUIRED (engineers exist for the hour-scale builds, metalstorm §8).
-- REPAIR on a COMPLETE unit (buildProgress == 1) is healing → forbidden.
-- So REPAIR is gated by build progress, not blanket-vetoed.
local FORBIDDEN = {
    [CMD_RECLAIM]   = true,
    [CMD_RESURRECT] = true,
    [CMD_CAPTURE]   = true,   -- capture would transfer strength into a squad too
}

function gadget:AllowCommand(unitID, unitDefID, unitTeam, cmdID, cmdParams, cmdOptions)
    if FORBIDDEN[cmdID] then
        return false          -- silently refuse; UI should not offer these
    end
    if cmdID == CMD_REPAIR then
        -- Allow build-assist (target still under construction); veto healing.
        local targetID = cmdParams and cmdParams[1]
        if targetID then
            local bp = select(5, Spring.GetUnitHealth(targetID))  -- buildProgress
            if bp and bp < 1.0 then
                return true   -- build-assist on an incomplete unit — allowed
            end
            return false      -- repair of a complete unit — healing, forbidden
        end
        -- Area-repair / no explicit target: default to veto (no healing).
        return false
    end
    return true
end

-- Belt-and-braces: ensure no unit auto-repairs/heals itself or allies even if a
-- def or another gadget tries. (Self-heal/auto-heal modrules are off, but a
-- captured/odd def could carry healing weapons — neutralise here later.)
function gadget:UnitCreated(unitID, unitDefID, unitTeam)
    -- TODO if any def ships repair/heal capability: strip it here, or assert at
    -- def-load that no Metalstorm unit defines one. For now defs carry none.
end

-- Squad metadata (squad_size / formation_*) already rides each unit def's
-- customParams (built by units/_builder.lua) and flows to the client via
-- DefCache untouched — no per-unit sim work needed here. This gadget adds NO
-- per-frame cost; it is a pure policy gate.
