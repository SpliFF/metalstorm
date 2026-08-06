-- tests/feature_mock.lua — loads the REAL featuredefs from
-- data/games/metalstorm/features/ and puts them through the same transform
-- CFeatureDefHandler::CreateFeatureDef applies, so a spec can assert against
-- the FeatureDefs table a gadget actually sees at runtime.
--
-- Same deliberate exception as train_mock.lua / spring_mock.lua (see those
-- headers): the thing under test is the DEFS plus game_scenario.lua's
-- placement of them, and there is no pure module to exercise instead. Narrowly
-- scoped to the feature surface — extend narrowly, do not grow a framework.
--
-- WHY THE TRANSFORM IS PORTED HERE rather than the spec reading raw def files:
-- a gadget never sees `blocking` or `indestructible`. It sees the engine's
-- `FeatureDefs[id]` with `collidable`, `destructable`, `reclaimable`,
-- `xsize`/`zsize`, and the DEFAULTS filled in (reclaimable defaults from
-- destructable; reclaimTime from cost). Asserting on the raw file would let a
-- def pass the spec while behaving differently in game — which is exactly the
-- bug class §M3's acceptance ("wrecks block and are reclaimable") is about.
-- Every rule below cites the FeatureDefHandler.cpp line it mirrors.

local M = {}

-- rts/Sim/Misc/GlobalConstants.h:17
local SPRING_FOOTPRINT_SCALE = 2
-- rts/Sim/Features/FeatureDef.h
local DRAWTYPE_NONE, DRAWTYPE_MODEL = -1, 0
-- rts/Sim/Objects/SolidObject.h
local MINIMUM_MASS, MAXIMUM_MASS = 1e-5, 1e6

--- Def files this game ships, relative to the Gadgets/ cwd every spec in this
--- directory runs from. Listed explicitly rather than globbed: busted has no
--- portable directory scan, and a spec that silently covered nothing when the
--- glob broke would be worse than one that errors on a renamed file.
M.DEF_FILES = { 'wrecks', 'bridges', 'ancient' }

local function clamp(v, lo, hi)
    if v < lo then return lo end
    if v > hi then return hi end
    return v
end

--- Case-insensitive key read. The engine's LuaParser lowercases both the def
--- table's keys and the C++ side's lookup strings (`lowerKeys` /
--- `lowerCppKeys`, both default true — LuaParser.cpp:56-57), so `footprintX`
--- and `footprintx` are the same key in game. Mirror that here so the spec
--- cannot be fooled by a def file's capitalisation.
local function get(t, key, default)
    local v = t[key]
    if v == nil then v = t[key:lower()] end
    if v == nil then return default end
    return v
end

local function bool(t, key, default)
    local v = get(t, key, nil)
    if v == nil then return default end
    return v and true or false
end

--- Port of CFeatureDefHandler::CreateFeatureDef (FeatureDefHandler.cpp:88-157).
--- `name` is lowercased there (line 91), so it is lowercased here.
function M.toEngineDef(name, fd, id)
    local metal  = get(fd, 'metal',  0.0)
    local energy = get(fd, 'energy', 0.0)

    -- health: "damage" is the legacy TA spelling; clamped to >= 0.1 (:115-116)
    local health = math.max(0.1, get(fd, 'health', get(fd, 'damage', 0.0)))

    local destructable = not bool(fd, 'indestructible', false)          -- :104
    local reclaimable  = bool(fd, 'reclaimable', destructable)          -- :105
    local modelName    = get(fd, 'object', '')                          -- :122

    local def = {
        id           = id,
        name         = name:lower(),
        description  = get(fd, 'description', ''),

        collidable   = bool(fd, 'blocking', true),                      -- :101
        selectable   = not bool(fd, 'noselect', false),                 -- :102
        burnable     = bool(fd, 'flammable', false),                    -- :103
        destructable = destructable,
        reclaimable  = reclaimable,
        autoreclaim  = bool(fd, 'autoreclaimable', reclaimable),        -- :106
        floating     = bool(fd, 'floating', false),                     -- :109

        metal        = metal,                                           -- :111
        energy       = energy,                                          -- :112
        health       = health,
        -- default (metal + energy) * 6, floored at 1 (:118)
        reclaimTime  = math.max(1.0, get(fd, 'reclaimTime', (metal + energy) * 6.0)),
        smokeTime    = get(fd, 'smokeTime', 300),                       -- :120

        modelName    = modelName,
        drawType     = modelName ~= '' and DRAWTYPE_MODEL or DRAWTYPE_NONE,  -- :123-126
        upright      = bool(fd, 'upright', false),                      -- :139

        -- footprintX/Z are multiplied by SPRING_FOOTPRINT_SCALE and floored at
        -- one scaled cell (:141-142) — so xsize is ALWAYS even and never 0.
        xsize = math.max(SPRING_FOOTPRINT_SCALE,
                         get(fd, 'footprintX', 1) * SPRING_FOOTPRINT_SCALE),
        zsize = math.max(SPRING_FOOTPRINT_SCALE,
                         get(fd, 'footprintZ', 1) * SPRING_FOOTPRINT_SCALE),

        customParams = get(fd, 'customParams', {}),
    }

    -- mass default = metal*0.4 + health*0.1, clamped (:144-149)
    def.mass = clamp(get(fd, 'mass', metal * 0.4 + health * 0.1), MINIMUM_MASS, MAXIMUM_MASS)
    def.crushResistance = get(fd, 'crushResistance', def.mass)

    return def
end

--- Load every shipped featuredef file and return the engine-shaped, ID-indexed
--- `FeatureDefs` global. IDs start at 1 (FeatureDefHandler.cpp:31-34 reserves
--- slot 0 as the "no def" sentinel), and the returned table has no [0], which
--- is what a gadget iterating `pairs(FeatureDefs)` sees.
---
--- Ordering note: the engine iterates `rootTable.GetKeys()`, i.e. an arbitrary
--- order, so nothing may depend on a particular ID. This mock sorts by name
--- within each file purely so IDs are stable run to run and a failure message
--- names the same def twice in a row.
function M.loadFeatureDefs(dir)
    dir = dir or '../../features/'
    local defs, id = {}, 0
    for _, file in ipairs(M.DEF_FILES) do
        local path = dir .. file .. '.lua'
        local chunk = assert(loadfile(path), 'cannot load featuredef file ' .. path ..
            ' (specs in this directory run from data/games/metalstorm/LuaRules/Gadgets)')
        local fromFile = chunk()
        assert(type(fromFile) == 'table', path .. ' did not return a table')

        local names = {}
        for name in pairs(fromFile) do names[#names + 1] = name end
        table.sort(names)
        for _, name in ipairs(names) do
            id = id + 1
            defs[id] = M.toEngineDef(name, fromFile[name], id)
        end
    end
    return defs
end

--- name -> engine def, for assertions that address a def by name.
function M.byName(featureDefs)
    local byName = {}
    for _, def in pairs(featureDefs) do byName[def.name] = def end
    return byName
end

return M
