-- Paper Tanks synced Lua root. This file is loaded by CLuaRules at
-- sim init; everything synced game logic needs starts here.
--
-- For now this is a smoke test that just confirms the Lua state boots
-- and Spring.Echo is reachable. Once the plumbing is proven, it will
-- `VFS.Include("LuaGadgets/gadgets.lua")` to bring up the canonical
-- Spring gadget handler and auto-load gadgets from LuaRules/Gadgets/.

Spring.Echo("[LuaRules] main.lua loaded")
