-- game_civilians.lua — civilian population (PLAN-metalstorm.md §7). STUB.
--
-- SYNCED Gaia-driven environment, NOT an unsynced AI plugin. Civilians are
-- real synced sim units the (also-synced) objective system reasons about
-- deterministically (a civilian dying fails a protect/escort/extract
-- objective; civilians weigh on region presence). An unsynced server-side AI
-- is limited to player-visible data + player actions — the wrong tool.
--
-- LuaRules (not LuaGaia) because LuaGaia/main.lua bootstraps from the MAP VFS
-- layer (CLuaGaia::CanLoadHandler → SPRING_VFS_MAP_BASE), so a *game* feature
-- can't rely on it; LuaRules is game-scoped, always loads, and may command any
-- team incl. Gaia — the faithful Spring pattern for neutral units.
--
-- STRUCTURE: this gadget is intentionally THIN. The gadget handler scans
-- LuaRules/Gadgets/*.lua NON-recursively (gadgets.lua:162 — no 4th DirList
-- arg), so a gadget must be one file, but a SUBFOLDER is invisible to the
-- scanner. As civilian logic grows it lives in the library folder
-- `LuaRules/Gadgets/civilians/` — same convention BAR uses for its AI
-- (luarules/gadgets/AILoader.lua + the library folder luarules/gadgets/ai/).
-- This file just wires the engine callins to those modules.

function gadget:GetInfo()
    return {
        name    = "Civilians",
        desc    = "Synced civilian population on the Gaia team (ambient + objective payloads)",
        author  = "metalstorm",
        date    = "2026",
        license = "GPL v2",
        layer   = -40,             -- after objectives/regions register
        enabled = true,
    }
end

if not gadgetHandler:IsSyncedCode() then
    return false
end

-- Library modules (plain Lua, not gadgets). VFS.Include resolves from the
-- VFS root; each returns a table of functions taking the shared `civ` context.
local spawn    = VFS.Include("LuaRules/Gadgets/civilians/spawn.lua")
local routines = VFS.Include("LuaRules/Gadgets/civilians/routines.lua")
local convoy   = VFS.Include("LuaRules/Gadgets/civilians/convoy.lua")
local estate   = VFS.Include("LuaRules/Gadgets/civilians/estate.lua")
local Tick     = VFS.Include("LuaRules/Gadgets/tick.lua")

-- D15: skip-safe cadences (see tick.lua). Observation policy for both — these
-- tick the ambient population forward from where it is now, and firing them
-- once per skipped period would burst-spawn a backlog of civilians.
local routinesGate = Tick.new(150)
local convoyGate   = Tick.new(300)

-- Shared context handed to every module (gaia team id, registries, config).
local civ = {
    gaiaTeam   = Spring.GetGaiaTeamID(),
    population = {},   -- unitID → { role = 'ambient'|'convoy'|'payload', ... }
}

-- Public surface other gadgets use (game_objectives.lua registers payloads).
GG.Civilians = GG.Civilians or {}
function GG.Civilians.Spawn(defName, x, z, facing)
    return spawn.one(civ, defName, x, z, facing)
end
function GG.Civilians.Register(unitID, role)
    civ.population[unitID] = { role = role or 'ambient' }
end

--- Is this unit part of the civilian population? The registry (not a unitdef
--- customParam) is the source of truth: role/site/home data lives here, and
--- ambient/convoy/payload civilians are only distinguishable via it. Objective
--- population queries (game_scenario.lua) identify targets through this.
function GG.Civilians.IsCivilian(unitID)
    return civ.population[unitID] ~= nil
end

--- The civilian's role ('ambient'|'convoy'|'payload'), or nil if not a
--- registered civilian. Objective target/payload area-queries filter on it.
function GG.Civilians.GetRole(unitID)
    local info = civ.population[unitID]
    return info and info.role or nil
end

-- PLAN-metalstorm-interaction.md §3/§10 task 5: the real implementation of
-- game_objectives.lua's civilianDistrictsUnderThreat() world facade.
function GG.Civilians.ThreatenedDistricts()
    return estate.threatenedDistricts(civ)
end

--- Standing parley venues — the civilian meeting halls
--- (PLAN-metalstorm-model-integration §M2, worldbuilding §4). Read-only: the
--- returned table is the live registry array, so callers must not mutate it.
function GG.Civilians.ParleyVenues()
    return estate.venues(civ)
end

--- The venue nearest a point, for siting a parley with the estate.
function GG.Civilians.NearestVenue(x, z)
    return estate.nearestVenue(civ, x, z)
end

function gadget:GameStart()
    spawn.seed(civ)          -- read map-authored placement, seed population
    estate.register(civ)     -- wire into the parley board (game_parley loads first, layer -45)
end

function gadget:GameFrame(frame)
    -- Low cadence on purpose — civilians are ambience, not sim pressure.
    if Tick.due(routinesGate, frame) then routines.tick(civ, frame) end
    if Tick.due(convoyGate, frame)   then convoy.tick(civ, frame)   end
end

--- Civilian BUILDINGS join the estate here (§M2). Runs on every unit created
--- in the game, so estate.registerBuilding early-outs on the def customparam
--- before it allocates anything.
function gadget:UnitCreated(unitID, unitDefID)
    estate.registerBuilding(civ, unitID, unitDefID)
end

function gadget:UnitDestroyed(unitID)
    civ.population[unitID] = nil
    estate.forgetBuilding(civ, unitID)
end
