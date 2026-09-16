-- ai.config.lua — discovery manifest for the Metalstorm Garrison AI.
--
-- Read by rts/Server/AI/AIDiscovery.cpp (ConfigReader::Load probes
-- `ai.config.lua` then `ai.config.json`). The folder name (`garrison`) becomes
-- the lowercase plugin `id` the lobby's "Add AI" / `--ai garrison:<team>` use;
-- `name` is the dropdown label; `entry` the single buffer the VM loads.
--
-- A simple, predictable DEFENDER built on ai/lib: it holds its home regions,
-- answers contact with DefendArea / Screen directives, takes cheap objectives
-- in or next to its ground, and withdraws through its departure zone when
-- outmatched. It never micros — its actuator has no unit verb (structural).
-- Ideal as a scenario NPC, a practice opponent, or the caretaker for an empty
-- side that should hold rather than play.

return {
    name        = "Metalstorm Garrison",
    entry       = "main.lua",
    description = "Simple defender/NPC: holds home regions, reacts to contact with "
               .. "DefendArea/Screen directives, takes cheap nearby objectives, "
               .. "withdraws through its departure zone when outmatched. Directive-only.",
    version     = "0.1.0",
    author      = "metalstorm",
    -- Selectable personalities (profiles/<id>.lua). Not read by AIDiscovery
    -- today (the lobby dropdown is hard-coded to strategos — see
    -- docs/ai-players.md proposal P8); declared so it is one edit away.
    profiles    = { "sentinel", "skittish", "stalwart" },
    -- The per-unit verb is never used; when engine ask P1 lands this is the
    -- flag that keeps it unregistered in this AI's VM.
    unitCommands = false,
}
