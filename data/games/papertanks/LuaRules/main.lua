-- Paper Tanks synced Lua root. This file is loaded by CLuaRules at
-- sim init; everything synced game logic needs starts here.
--
-- We delegate to Spring's canonical gadget handler (the 2146-line
-- gadgets.lua bundled under cont/base/springcontent/LuaGadgets/).
-- That file walks LuaRules/Gadgets/ and loads every `.lua` it finds
-- as a gadget, wiring their callins (Initialize, GameStart,
-- GameFrame, UnitCreated, ...) to the engine event dispatcher.

Spring.Echo("[LuaRules] main.lua loaded, bootstrapping gadgetHandler...")
VFS.Include("LuaGadgets/gadgets.lua")
Spring.Echo("[LuaRules] gadgetHandler bootstrapped")
