-- Metalstorm — native spring-web game (see PLAN-metalstorm.md).
-- Authored directly in data/games/; NEVER processed by gameconverter.
return {
    name        = 'Metalstorm',
    shortName   = 'metalstorm',
    game        = 'Metalstorm',
    shortGame   = 'metalstorm',
    description = 'Team-based large-scale strategy. Objectives over micro; '
               .. 'authority over APM. The team owns the army.',
    version     = '0.1',
    modtype     = 1,
    depend      = {},

    -- Native conventions (PLAN-metalstorm.md §9):
    legacyCoordSystem = false,   -- RH / glTF-native. Explicit, not defaulted.
    lighting          = 'gameplay',
    -- Metalstorm has no metal/energy economy — authority replaces both
    -- (PLAN-metalstorm-economy.md §1). Declared here so the client can drop
    -- the legacy resource HUD from the game's own data instead of testing
    -- the game id; the lobby relays it in /api/games (PLAN-endtoend.md D9).
    resourceEconomy   = false,
    -- No modelMaterialPort: engine-default unit material until a
    -- Metalstorm material is designed.
}
