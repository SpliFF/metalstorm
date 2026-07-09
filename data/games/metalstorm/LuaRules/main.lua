-- Metalstorm synced Lua root. Delegates to the engine's canonical gadget
-- handler (cont/base/springcontent/LuaGadgets/gadgets.lua), which walks
-- LuaRules/Gadgets/ and wires every gadget's callins.
Spring.Echo("[LuaRules] Metalstorm main.lua — bootstrapping gadgetHandler...")
VFS.Include("LuaGadgets/gadgets.lua")
Spring.Echo("[LuaRules] gadgetHandler ready")
