-- Metalstorm synced Lua root. Delegates to the engine's canonical gadget
-- handler (cont/base/springcontent/LuaGadgets/gadgets.lua), which walks
-- LuaRules/Gadgets/ and wires every gadget's callins.

-- Conservative gadget allow-list (user directive 2026-07-22): Metalstorm
-- deviates heavily from traditional RTS play, so it does NOT inherit the
-- springcontent-base / VFS-leaked BAR gadget set — many are ZK/BAR-shaped and
-- crash in this server-authority engine (the base game_end.lua killed the
-- whole synced init at frame -1). Load ONLY Metalstorm's own gadgets; add
-- base gadgets back here explicitly, one at a time, as the game needs them
-- (candidates in cont/base/springcontent/LuaGadgets/Gadgets/: unit_script,
-- unit_dead, player_disconnect, game_spawn, game_end — none pulled in yet).
GADGET_ALLOWLIST = {
	['game_ai_guidance.lua']      = true,
	['game_authority.lua']        = true,
	['game_authority_charge.lua'] = true,
	['game_civilians.lua']        = true,
	['game_objectives.lua']       = true,
	['game_parley.lua']           = true,
	['game_regions.lua']          = true,
	['game_scenario.lua']         = true,
	['game_start.lua']            = true,
	['game_teams.lua']            = true,
	['game_train.lua']            = true,
	['game_tutorial.lua']         = true,
	['squad.lua']                 = true,
}

Spring.Echo("[LuaRules] Metalstorm main.lua — bootstrapping gadgetHandler (native-only allow-list)...")
VFS.Include("LuaGadgets/gadgets.lua")
Spring.Echo("[LuaRules] gadgetHandler ready")
