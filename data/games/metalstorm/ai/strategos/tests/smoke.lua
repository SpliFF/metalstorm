-- tests/smoke.lua — end-to-end wiring smoke test (headless).
--
-- Stubs the AI VM's CURRENT global surface (getOwnUnits/getVisibleEnemies/
-- issueCommand/getFrame/getMapSize — no getRulesParam, no getTeamId, no chat)
-- and drives main.onUpdate through a couple of strategic ticks. Proves the
-- whole pipeline wires and degrades cleanly on the real (minimal) surface —
-- the boot + tick path the pure spec can't cover.
package.path = './?.lua;' .. package.path

_G.AI = {
    getFrame          = function() return 0 end,
    getMapSize        = function() return 8192, 8192 end,
    getOwnUnits       = function()
        return { { id = 1, x = 100, y = 0, z = 100, health = 500, hasCommands = false } }
    end,
    getVisibleEnemies = function()
        return { { id = 2, x = 4000, z = 4000, health = 300 } }
    end,
    issueCommand      = function() end,
    -- deliberately absent: getRulesParam (AI1), getTeamId, chat,
    -- createGroup/issueDirective/setPosture (AI2) — everything must degrade.
}

dofile('main.lua')
assert(type(onUpdate) == 'function', 'onUpdate global not defined')

onUpdate(150)   -- boots + first strategic tick
onUpdate(300)   -- second tick
onUpdate(305)   -- within the tick period → throttled (no tick), must not error

if _G.AI_STRATEGOS_BOOT_ERROR then
    print('BOOT ERROR: ' .. tostring(_G.AI_STRATEGOS_BOOT_ERROR))
    os.exit(1)
end
print('smoke OK: booted and ticked on the minimal surface without error')
