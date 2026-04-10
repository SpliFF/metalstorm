--------------------------------------------------------------------------------
--  file:    widgets.lua
--  game:    Paper Tanks
--  brief:   Minimal widget-manager base for spring-web. Unlike Spring's full
--           widget manager, the actual loading, sorting, and call-in dispatch
--           happens in TypeScript on the client side (client/src/core/
--           lua-widget-host.ts). This file exists so map-shipped widgets can
--           find a `widgetHandler` stub and a shared `WG` table in the game
--           VFS layer, and so that future Paper Tanks game widgets have an
--           entry point to hook.
--
--  The client host pre-fetches this file via /api/vfs/game/papertanks/LuaUI/
--  and executes it in every widget's Lua state before the widget's own
--  source runs, so the globals defined here are visible to both map-level
--  and game-level widget code.
--------------------------------------------------------------------------------

LUAUI_DIRNAME = 'LuaUI/'
LUAUI_VERSION = 'spring-web LuaUI v0.1 (papertanks)'

-- Shared Widget Globals table. Widgets publish/consume state via WG entries
-- (e.g. `WG.game_SetLosFogBrightnessMinimum = ...`). A single table instance
-- is injected by the JS host so writes from one widget are visible to the
-- others within the same host.
WG = WG or {}

-- widgetHandler is a thin stub of Spring's real handler. Most fields are
-- no-ops; widgets that introspect it (e.g. to RemoveWidget themselves or
-- register custom actions) will get silent defaults rather than crashing.
widgetHandler = widgetHandler or {
    widgets = {},
    knownWidgets = {},
    orderList = {},
    configData = {},
    WG = WG,
    globals = {},
    mouseOwner = nil,
    xViewSize = 1,
    yViewSize = 1,

    RemoveWidget     = function(self, w) end,
    RaiseWidget      = function(self, w) end,
    LowerWidget      = function(self, w) end,
    UpdateCallIn     = function(self, name) end,
    RemoveCallIn     = function(self, name) end,
    RegisterGlobal   = function(self, name, value) _G[name] = value end,
    DeregisterGlobal = function(self, name) _G[name] = nil end,
    GetViewSizes     = function(self) return self.xViewSize, self.yViewSize end,
    InTweakMode      = function(self) return false end,
}
