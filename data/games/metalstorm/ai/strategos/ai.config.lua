-- ai.config.lua — discovery manifest for the Metalstorm Strategic AI.
--
-- Read by rts/Server/AI/AIDiscovery.cpp (ConfigReader::Load probes
-- `ai.config.lua` then `ai.config.json`). The folder name (`strategos`)
-- becomes the lowercase plugin `id`; `name` is what the lobby "Add AI"
-- dropdown shows. `entry` is the single Lua buffer the runtime loads
-- (AIRuntimePool::AddAI → AIScriptContext::Init).
--
-- Plan: PLAN-metalstorm-ai.md (the design) + PLAN-ai.md (the runtime).
-- One brain, three deployment roles (full side / co-commander / NPC),
-- selected at instantiation via profile — see roles.lua / profiles/.
--
-- !! BOOT CAVEAT (see README.md "Engine asks"): the AI VM currently
-- opens only base/table/string/math/utf8 and loads ONE entry buffer —
-- there is no `require`/`VFS.Include`, so main.lua's multi-file layout
-- needs a runtime module loader (engine ask AI0-loader). The pure
-- modules (slate/planner/config/roles/profiles) are already testable
-- headless with busted; the runtime wiring waits on that loader.

return {
    name        = "Metalstorm Strategos",
    entry       = "main.lua",
    description = "Strategic army-level AI: goal slate + force allocation over "
               .. "the region graph. Commands via macro directives only, never "
               .. "per-squad orders. Pays authority like a human player.",
    version     = "0.1.0-skeleton",
    author      = "metalstorm",
}
