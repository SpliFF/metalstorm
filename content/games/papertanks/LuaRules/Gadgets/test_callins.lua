-- test_callins.lua — synced gadget that exercises the engine→Lua
-- event dispatch path end-to-end.
--
-- Hooks the core callins that every real gadget will rely on, and
-- logs the first call to each plus a periodic heartbeat. If this
-- gadget's messages stop appearing mid-game, something in the
-- ScriptEventDispatcher → LuaScriptContext → gadgetHandler chain is
-- broken. The gadget is enabled by default for Paper Tanks and
-- should be safe to leave in the repo as a liveness indicator — one
-- log line per second is negligible.

function gadget:GetInfo()
    return {
        name    = "Test Callins",
        desc    = "Diagnostic gadget — logs engine callins to verify event dispatch",
        author  = "spring-web",
        date    = "2026",
        license = "GPL v2",
        layer   = 0,
        enabled = true,
    }
end

-- Only the synced half runs in the server. gadgetHandler:IsSyncedCode()
-- returns true for gadgets loaded in LuaRules (our case) and false in
-- LuaUI. Bailing out for the unsynced path keeps this file useful if
-- we ever re-use it as a cross-context test.
if not gadgetHandler:IsSyncedCode() then
    return false
end

local callinsSeen = {}

local function logOnce(name, ...)
    if callinsSeen[name] then return end
    callinsSeen[name] = true
    Spring.Echo(string.format("[test_callins] first %s", name), ...)
end

function gadget:Initialize()
    Spring.Echo("[test_callins] Initialize fired")
end

function gadget:GameStart()
    Spring.Echo("[test_callins] GameStart fired")

    -- Quick sanity: try to spawn a GreyRock feature (which has a
    -- .meta.lua preprocessed alongside its .glb) and log its radius.
    -- If the meta loader is wired correctly, radius should be ~113.
    -- If the fallback fires, radius will be 1.
    if Spring.CreateFeature and Spring.GetFeatureRadius then
        local fid = Spring.CreateFeature("GreyRock1", 3584, 0, 3584, 0, Spring.GetGaiaTeamID())
        if fid then
            local r = Spring.GetFeatureRadius(fid)
            Spring.Echo(string.format(
                "[test_callins] spawned GreyRock1 feature id=%d radius=%.2f", fid, r))
        end
    end
end

function gadget:GameFrame(frame)
    -- Per-frame is too noisy; log the first frame and then every
    -- 30 frames (once per game second at the default 30Hz tick).
    logOnce("GameFrame", frame)
    if frame > 0 and frame % 30 == 0 then
        Spring.Echo(string.format("[test_callins] GameFrame heartbeat t=%ds", frame / 30))
    end
end

function gadget:UnitCreated(unitID, unitDefID, teamID, builderID)
    logOnce("UnitCreated", unitID, unitDefID, teamID)
end

function gadget:UnitFinished(unitID, unitDefID, teamID)
    logOnce("UnitFinished", unitID, unitDefID, teamID)
end

function gadget:UnitDamaged(unitID, unitDefID, teamID, damage)
    logOnce("UnitDamaged", unitID, unitDefID, teamID, damage)
end

function gadget:UnitDestroyed(unitID, unitDefID, teamID, attackerID)
    logOnce("UnitDestroyed", unitID, unitDefID, teamID, attackerID)
end

function gadget:Shutdown()
    Spring.Echo("[test_callins] Shutdown fired")
end
