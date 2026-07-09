-- civilians/estate.lua — the civilian estate as a parley party (PLAN-metalstorm-interaction.md). STUB.
-- Plain library module (NOT a gadget). Included by game_civilians.lua.
--
-- HOME NOTE: the interaction plan cites this bare as `civilians/estate.lua`;
-- its home is this existing civilians library folder
-- (LuaRules/Gadgets/civilians/), beside spawn/routines/convoy —
-- decision recorded in PLAN-metalstorm-structure.md.
--
-- The estate is a scripted responder to parley proposals addressed to
-- toTeam='civ' (safe passage through districts, tribute for convoy routes),
-- with simple accept/refuse rules over trust + district state. It registers
-- against GG.Parley when game_parley is enabled.
local estate = {}

--- Wire the estate into the parley board (called from game_civilians init
--- once GG.Parley exists).
function estate.register(civ)
    -- TODO: subscribe to proposals with toTeam='civ'; respond per rules.
end

--- Scripted response policy. STUB.
function estate.respond(civ, proposal)
    -- TODO: trust ledger + district-state rules → accept/refuse/counter.
end

return estate
