-- civilians/town.lua — the town registry: districts, statics, parley venues.
-- Plain library module (NOT a gadget). Included by game_civilians.lua.
--
-- HOME NOTE: beside spawn/routines/convoy/estate in the civilians library
-- folder, and in the civilians gadget rather than in a gadget of its own, for
-- the reason that folder exists at all (game_civilians.lua's header): the
-- gadget handler scans LuaRules/Gadgets/*.lua non-recursively, so a subfolder
-- is invisible to it and a library module cannot accidentally become a gadget.
-- A town IS a civilian concept — it is where the estate lives — so it belongs
-- to the gadget that owns the estate.
--
-- WHAT A TOWN IS HERE. `tools/mapgen/town_planner.py` plans a street-and-lot
-- settlement on the map's own heightmap, `town_stager.py` stands buildings in
-- its lots and `town_populace.py` puts people on its streets; the generated
-- scenario carries the buildings in `units`, the people in `civilians.units`
-- and the town itself in a `towns` block. This module is what turns that block
-- into something the rest of the game can address:
--
--   * a NAMED PLACE — `region_<key>_name` is renamed to the town and its
--     published centre moved onto it (game_regions.lua's SetName), so a typed
--     or spoken order can say "attack Umber Shelf" and mean the town rather
--     than a spot in the fields half a kilometre off;
--   * a DISTRICT — every civilian staged with `town = <key>` is registered with
--     that key as its `districtId`, which is what civilians/estate.lua's
--     threatenedDistricts has always grouped on and has never seen (its own
--     header records the mechanism as real and unfed);
--   * a PARLEY VENUE — the town's meeting hall, resolved to a live unitID, is
--     where a proposal addressed to the civilian estate about this district is
--     held. Destroy the hall and the estate has nowhere to negotiate about this
--     town; see estate.lua's `venueFor`.
--
-- A TOWN KEY IS A REGION KEY, and that is the whole trick. The generator gives
-- every town its region's key, so `GG.Regions.KeyAt(x, z)` already answers
-- "which town is this", a parley proposal's `terms.regionKey` already addresses
-- one, an objective already scopes to one, and the client's named-entity index
-- already indexes one. Nothing downstream had to learn a second namespace.
local town = {}

-- How far from the authored hall position to look for the unit that IS the
-- hall. The scenario emits the exact integral coordinates it staged the
-- building at, so this only has to cover the engine settling a footprint onto
-- the build grid — it is a tolerance, not a search.
local HALL_SEARCH_RADIUS = 96

-- Region control + geometry is the shared strategic board, published PUBLIC so
-- it streams to browser clients. Game rules params default to
-- RULESPARAMLOS_PRIVATE (synced-only); game_regions.lua and game_objectives.lua
-- publish PUBLIC for the same reason.
local PUBLIC = { public = true }

-- ============================================================
-- Registration (called from game_scenario.lua's stageTowns, before the
-- civilians gadget's own GameStart — the loader is layer -90 and civilians
-- -40, so `GG.Towns` must exist at gadget LOAD time, which it does: this
-- module is included from game_civilians.lua's file body.)
-- ============================================================

--- Record one town from a scenario's `towns` entry.
---
--- Deliberately tolerant about `hall`: a game whose content ships no def for
--- the planner's `unique` lot role produces a town with no hall, and that is a
--- town with no parley venue rather than an error. The distinction is
--- observable (`town_<key>_hall` is absent) instead of being a nil crash three
--- gadgets away.
function town.register(civ, entry)
    if type(entry) ~= 'table' or type(entry.key) ~= 'string' then return nil end
    civ.towns = civ.towns or {}
    civ.townOrder = civ.townOrder or {}

    if civ.towns[entry.key] == nil then
        civ.townOrder[#civ.townOrder + 1] = entry.key
    end
    civ.towns[entry.key] = {
        key       = entry.key,
        name      = entry.name or entry.key,
        region    = entry.region or entry.key,
        x         = entry.x,
        z         = entry.z,
        radius    = entry.radius,
        archetype = entry.archetype,
        defense   = entry.defense,
        hall      = entry.hall,     -- { def, x, z } from the scenario
        hallUnit  = nil,            -- resolved at GameStart, below
        population = {},            -- unitID -> true, ambient AND garrison
    }
    return civ.towns[entry.key]
end

--- Publish every registered town's statics, and rename its region after it.
---
--- The rename is the point rather than a flourish: `region_<key>_name` is the
--- path the client's named-entity index reads (named-entity-index.ts's
--- parseRegionsFromRulesParams) to build the command composer's Target picker,
--- so this is what makes a town addressable by NAME. Moving the published
--- centre matters just as much — a region is kilometres of ground and its
--- polygon centroid is usually empty field, so an "attack <town>" resolved to
--- the centroid sends the order to nowhere in particular.
---
--- The `town_<key>_*` params alongside are for consumers that want the town
--- AS a town (its hall, its defense tier, its population count) rather than as
--- a place: no client reads them today, and they are published PUBLIC anyway
--- because a private param is invisible to the one process that would.
function town.publish(civ)
    local keys = civ.townOrder or {}
    for _, key in ipairs(keys) do
        local t = civ.towns[key]
        if GG.Regions and GG.Regions.SetName then
            GG.Regions.SetName(t.region, t.name, t.x, t.z)
        end
        Spring.SetGameRulesParam('town_' .. key .. '_name', t.name, PUBLIC)
        Spring.SetGameRulesParam('town_' .. key .. '_region', t.region, PUBLIC)
        if t.x then Spring.SetGameRulesParam('town_' .. key .. '_x', t.x, PUBLIC) end
        if t.z then Spring.SetGameRulesParam('town_' .. key .. '_z', t.z, PUBLIC) end
        if t.defense then
            Spring.SetGameRulesParam('town_' .. key .. '_defense', t.defense, PUBLIC)
        end
    end
    Spring.SetGameRulesParam('town_count', #keys, PUBLIC)
end

-- ============================================================
-- Resolving the meeting hall to a live unit
-- ============================================================

--- Find the unit that IS this town's meeting hall, once the scenario's `units`
--- have been staged.
---
--- BY POSITION, NOT BY BOOKKEEPING, and that is deliberate. The alternative is
--- for game_scenario.lua's stageUnits to hand back the unitID of every
--- structure it created and for the towns block to index into that list — which
--- couples a town to the ORDER of an unrelated block and breaks silently the
--- first time a unit in it is refused (stageUnits' own `skipped` list exists
--- because the engine does refuse them, and says so only by returning nil).
--- Looking for the def at the coordinates the scenario itself emitted is
--- robust to all of that, and when it finds nothing the answer — this town has
--- no venue — is the truth rather than a stale id.
local function resolveHall(civ, t)
    if not t.hall or not t.hall.x then return nil end
    local best, bestDist
    local units = Spring.GetUnitsInCylinder(t.hall.x, t.hall.z,
                                            HALL_SEARCH_RADIUS) or {}
    for _, unitID in ipairs(units) do
        local udid = Spring.GetUnitDefID(unitID)
        local ud = udid and UnitDefs[udid]
        if ud and (t.hall.def == nil or ud.name == t.hall.def) then
            local ux, _, uz = Spring.GetUnitPosition(unitID)
            if ux then
                local dx, dz = ux - t.hall.x, uz - t.hall.z
                local d = dx * dx + dz * dz
                if not bestDist or d < bestDist then bestDist, best = d, unitID end
            end
        end
    end
    return best
end

--- Resolve every town's hall and report the ones that have none.
--- Called from game_civilians.lua's GameStart, which runs AFTER the scenario
--- loader's (layer -90 before -40) — so the buildings exist by now.
function town.bind(civ)
    for _, key in ipairs(civ.townOrder or {}) do
        local t = civ.towns[key]
        t.hallUnit = resolveHall(civ, t)
        if t.hall and not t.hallUnit then
            -- Loud, because the failure is otherwise invisible: a town with an
            -- authored hall and no live unit at it negotiates exactly like a
            -- town whose hall has been destroyed, and the two mean opposite
            -- things about whether the scenario staged correctly.
            Spring.Log("Civilians", LOG.WARNING, string.format(
                "town %s declares a %s hall at (%d,%d) but no such unit was " ..
                "staged there — this town has no parley venue",
                key, tostring(t.hall.def), t.hall.x or -1, t.hall.z or -1))
        end
        if t.hallUnit then
            Spring.SetGameRulesParam('town_' .. key .. '_hall', t.hallUnit, PUBLIC)
        end
    end
end

-- ============================================================
-- Population
-- ============================================================

--- Bind a spawned civilian to its town. Called from the spawn path.
function town.claim(civ, unitID, key)
    local t = civ.towns and civ.towns[key]
    if not t then return end
    t.population[unitID] = true
end

function town.release(civ, unitID)
    for _, t in pairs(civ.towns or {}) do
        t.population[unitID] = nil
    end
end

-- ============================================================
-- The public surface (GG.Towns), wired in game_civilians.lua
-- ============================================================

--- Every town key, in the order the scenario declared them. A fresh list —
--- safe to mutate — and never a `pairs` walk, matching GG.Regions.Keys().
function town.keys(civ)
    local out = {}
    for i, k in ipairs(civ.townOrder or {}) do out[i] = k end
    return out
end

function town.get(civ, key)
    return civ.towns and civ.towns[key] or nil
end

--- The town at a world position, or nil. Answered through GG.Regions rather
--- than by measuring against `radius`: a town's key IS its region's key, so the
--- region partition already owns this question and a second, disagreeing answer
--- (a circle) is exactly the sort of near-duplicate that drifts.
function town.at(civ, x, z)
    if not GG.Regions or not GG.Regions.KeyAt then return nil end
    return town.get(civ, GG.Regions.KeyAt(x, z))
end

--- The unitID of a town's parley venue, or nil if it has none / lost it.
--- Re-validated on every call rather than cached-and-invalidated: a destroyed
--- hall must stop being a venue the instant it dies, and UnitDestroyed on a
--- Gaia building is not somewhere this module wants a hook it can miss.
function town.venue(civ, key)
    local t = town.get(civ, key)
    if not t or not t.hallUnit then return nil end
    if not Spring.ValidUnitID(t.hallUnit) then
        t.hallUnit = nil
        Spring.SetGameRulesParam('town_' .. key .. '_hall', nil, PUBLIC)
        return nil
    end
    return t.hallUnit
end

--- Every registered civilian in a town, as a list of unitIDs.
--- Sorted, because it reaches decisions (estate.lua evacuates in this order)
--- and a `pairs` walk over a unitID-keyed table is not a stable order.
function town.residents(civ, key)
    local t = town.get(civ, key)
    if not t then return {} end
    local out = {}
    for unitID in pairs(t.population) do out[#out + 1] = unitID end
    table.sort(out)
    return out
end

return town
