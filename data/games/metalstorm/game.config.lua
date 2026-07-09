-- Hand-authored (native game — no gameconverter). Same contract as the
-- generated wrappers: describes the game itself; setup options live in
-- lobby.config.lua. VFS.Include provided by ConfigReader.
local config = VFS.Include('modinfo.lua') or {}
config.configVersion = "1"
return config
