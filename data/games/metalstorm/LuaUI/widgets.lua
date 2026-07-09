-- Metalstorm ships NO Lua widgets. The in-game UI is native JavaScript
-- (PLAN-native-ui.md; game widgets under ui/). This file exists only so
-- map-shipped widgets find the standard globals and the client can skip the
-- Fengari boot when no game widgets are present (zero-Fengari goal,
-- PLAN-native-ui.md P2).
LUAUI_DIRNAME = 'LuaUI/'
LUAUI_VERSION = 'spring-web LuaUI (metalstorm — native JS UI, no Lua widgets)'
WG = WG or {}
widgetHandler = widgetHandler or {
    widgets = {}, knownWidgets = {}, orderList = {}, configData = {},
    WG = WG, globals = {}, mouseOwner = nil, xViewSize = 1, yViewSize = 1,
    RemoveWidget = function() end, RaiseWidget = function() end,
    LowerWidget = function() end, UpdateCallIn = function() end,
    RemoveCallIn = function() end,
    RegisterGlobal = function(self, name, value) _G[name] = value end,
    DeregisterGlobal = function(self, name) _G[name] = nil end,
    GetViewSizes = function(self) return self.xViewSize, self.yViewSize end,
    InTweakMode = function() return false end,
}
